require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

// Emotion worker URL (Python Flask service)
const EMOTION_WORKER_URL = 'http://localhost:5050/predict';
let emotionWorkerAvailable = false;

// Check if emotion worker is running
function checkEmotionWorker() {
  return new Promise((resolve) => {
    http.get('http://localhost:5050/health', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        emotionWorkerAvailable = true;
        resolve(true);
      });
    }).on('error', () => {
      emotionWorkerAvailable = false;
      resolve(false);
    });
  });
}

// Send audio to emotion worker and get prediction
function analyzeEmotion(pcmBuffer) {
  return new Promise((resolve) => {
    const url = new URL(EMOTION_WORKER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + '?sample_rate=16000',
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': pcmBuffer.length,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ emotion: 'unknown', score: 0, error: 'parse error' });
        }
      });
    });

    req.on('error', () => {
      resolve({ emotion: 'unknown', score: 0, error: 'worker unavailable' });
    });

    req.write(pcmBuffer);
    req.end();
  });
}

const app = express();
const HTTP_PORT = 3000;
const WS_PORT = 8080;

// ============================================================
// Deepgram setup
// ============================================================
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
if (!DEEPGRAM_API_KEY || DEEPGRAM_API_KEY === 'YOUR_KEY_HERE') {
  console.error('');
  console.error('⚠️  DEEPGRAM_API_KEY not set!');
  console.error('   1. Sign up at https://deepgram.com');
  console.error('   2. Get your API key from the dashboard');
  console.error('   3. Put it in server/.env: DEEPGRAM_API_KEY=your_key_here');
  console.error('');
  console.error('Server will still record audio, but transcription will be disabled.');
  console.error('');
}

const deepgram = DEEPGRAM_API_KEY && DEEPGRAM_API_KEY !== 'YOUR_KEY_HERE'
  ? createClient(DEEPGRAM_API_KEY)
  : null;

// Ensure recordings directory exists
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

// HTTP health check
app.get('/', (req, res) => res.send('Soliloquy server running'));

// List recordings
app.get('/recordings', (req, res) => {
  const files = fs.readdirSync(recordingsDir)
    .filter(f => f.endsWith('.raw') || f.endsWith('.wav') || f.endsWith('.json') || f.endsWith('.txt'))
    .sort()
    .reverse();
  res.json(files);
});

// ============================================================
// Speaker identification heuristic
// ============================================================
function identifySpeakers(utterances) {
  // The wearer's voice is closest to the mic → loudest.
  // We approximate loudness by utterance count and earliest appearance.
  // Speaker who speaks first is most likely the wearer.
  const speakerFirstAppearance = {};
  const speakerWordCount = {};

  for (const utt of utterances) {
    const spk = utt.speaker;
    if (!(spk in speakerFirstAppearance)) {
      speakerFirstAppearance[spk] = utt.start;
    }
    speakerWordCount[spk] = (speakerWordCount[spk] || 0) + utt.text.split(' ').length;
  }

  // The speaker who both appears first AND speaks most is likely "me"
  let meSpeaker = null;
  let maxScore = -1;
  for (const spk in speakerWordCount) {
    // Score: word count (weight=2) + early appearance bonus
    const earlyBonus = speakerFirstAppearance[spk] < 5.0 ? 50 : 0;
    const score = speakerWordCount[spk] * 2 + earlyBonus;
    if (score > maxScore) {
      maxScore = score;
      meSpeaker = spk;
    }
  }

  const speakers = {};
  for (const spk in speakerWordCount) {
    speakers[`Speaker ${spk}`] = {
      label: spk === meSpeaker ? 'me' : 'other',
      word_count: speakerWordCount[spk],
    };
  }
  return speakers;
}

// ============================================================
// WebSocket server for ESP32 audio streaming
// ============================================================
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const timestamp = Date.now();
  const rawPath = path.join(recordingsDir, `${timestamp}.raw`);
  const stream = fs.createWriteStream(rawPath);
  let bytesReceived = 0;

  // Transcription state
  const utterances = [];
  let dgConnection = null;
  let realtimeLines = [];

  // Audio buffer for emotion analysis (keep recent audio with timestamps)
  const audioChunks = [];  // [{timestamp_ms, data}]
  let streamStartTime = Date.now();

  console.log(`[${new Date().toISOString()}] 🎧 Glasses connected from ${req.socket.remoteAddress}`);

  // --------------------------------------------------------
  // Start Deepgram live transcription
  // --------------------------------------------------------
  if (deepgram) {
    try {
      dgConnection = deepgram.listen.live({
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        punctuate: true,
        diarize: true,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
      });

      dgConnection.on(LiveTranscriptionEvents.Open, () => {
        console.log('  📡 Deepgram connection opened');
      });

      dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const alt = data.channel?.alternatives?.[0];
        if (!alt || !alt.transcript || alt.transcript.trim() === '') return;

        const transcript = alt.transcript;

        // Extract speaker from words
        const words = alt.words || [];
        const speaker = words.length > 0 ? words[0].speaker : '?';


        const utt = {
          speaker: String(speaker),
          text: transcript,
          start: words.length > 0 ? words[0].start : 0,
          end: words.length > 0 ? words[words.length - 1].end : 0,
          voice_emotion: 'pending',
          voice_emotion_score: 0,
          voice_emotion_latency_ms: 0,
        };
        utterances.push(utt);

        // Extract audio segment for this utterance and analyze emotion
        if (emotionWorkerAvailable && utt.start > 0) {
          const startByte = Math.floor(utt.start * 16000 * 2);  // 16kHz, 16-bit
          const endByte = Math.floor(utt.end * 16000 * 2);

          // Reconstruct audio from buffered chunks
          const totalBuf = Buffer.concat(audioChunks.map(c => c.data));
          if (endByte <= totalBuf.length) {
            const segment = totalBuf.slice(startByte, endByte);
            if (segment.length > 640) {  // At least 20ms
              analyzeEmotion(segment).then(emotionResult => {
                utt.voice_emotion = emotionResult.emotion || 'unknown';
                utt.voice_emotion_score = emotionResult.score || 0;
                utt.voice_emotion_latency_ms = emotionResult.inference_ms || 0;

                // Print with emotion
                const emoji = {
                  angry: '😡', happy: '😊', sad: '😢', fearful: '😰',
                  disgusted: '🤢', surprised: '😲', neutral: '😐', other: '🤔'
                }[utt.voice_emotion] || '❓';
                console.log(`  ${emoji} voice_emotion: ${utt.voice_emotion} (${utt.voice_emotion_score.toFixed(2)}) [${utt.voice_emotion_latency_ms}ms]`);
              });
            }
          }
        }

        // Real-time console output
        const label = `Speaker ${speaker}`;
        const line = `  [${label}] ${transcript}`;
        console.log(line);
        realtimeLines.push(line);
      });

      dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('  Deepgram error:', err.message || err);
      });

      dgConnection.on(LiveTranscriptionEvents.Close, () => {
        console.log('  📡 Deepgram connection closed');
      });
    } catch (err) {
      console.error('  Failed to start Deepgram:', err.message);
      dgConnection = null;
    }
  }

  // --------------------------------------------------------
  // Handle incoming audio from ESP32
  // --------------------------------------------------------
  ws.on('message', (data) => {
    // Save raw audio
    stream.write(data);
    bytesReceived += data.length;

    // Buffer audio for emotion analysis
    audioChunks.push({ timestamp_ms: Date.now() - streamStartTime, data: Buffer.from(data) });

    // Forward to Deepgram
    if (dgConnection && dgConnection.getReadyState() === 1) {
      dgConnection.send(data);
    }

    // Log progress every ~1MB
    if (bytesReceived % (1024 * 1024) < data.length) {
      const mb = (bytesReceived / (1024 * 1024)).toFixed(1);
      console.log(`  📦 Recording ${timestamp}: ${mb} MB received`);
    }
  });

  // --------------------------------------------------------
  // Handle disconnect
  // --------------------------------------------------------
  ws.on('close', () => {
    stream.end();
    const duration = ((bytesReceived / 2) / 16000).toFixed(1);
    console.log(`[${new Date().toISOString()}] 💾 Recording saved: ${rawPath}`);
    console.log(`  Size: ${(bytesReceived / 1024).toFixed(0)} KB, ~${duration}s of audio`);

    // Close Deepgram connection
    if (dgConnection) {
      try { dgConnection.finish(); } catch (e) { /* ignore */ }
    }

    // Convert raw PCM to WAV
    try {
      const wavPath = rawPath.replace('.raw', '.wav');
      execSync(`ffmpeg -f s16le -ar 16000 -ac 1 -i "${rawPath}" "${wavPath}" -y`, {
        stdio: 'pipe'
      });
      console.log(`  🔊 Converted to WAV: ${wavPath}`);
    } catch (err) {
      console.error(`  FFmpeg conversion failed: ${err.message}`);
    }

    // Save transcript
    if (utterances.length > 0) {
      const speakers = identifySpeakers(utterances);

      // Structured JSON
      const transcriptData = {
        timestamp: new Date(timestamp).toISOString(),
        duration_seconds: parseFloat(duration),
        speakers,
        utterances: utterances.map(u => ({
          ...u,
          speaker_label: speakers[`Speaker ${u.speaker}`]?.label || 'unknown',
        })),
      };

      const jsonPath = rawPath.replace('.raw', '.transcript.json');
      fs.writeFileSync(jsonPath, JSON.stringify(transcriptData, null, 2));
      console.log(`  📝 Transcript JSON: ${jsonPath}`);

      // Human-readable text
      const txtLines = utterances.map(u => {
        const label = speakers[`Speaker ${u.speaker}`]?.label || 'unknown';
        const emotion = u.voice_emotion !== 'pending' ? `${u.voice_emotion} ${u.voice_emotion_score.toFixed(2)}` : 'no-emotion';
        return `[Speaker ${u.speaker} / ${label}] (${emotion}) ${u.text}`;
      });
      const txtPath = rawPath.replace('.raw', '.transcript.txt');
      fs.writeFileSync(txtPath, txtLines.join('\n') + '\n');
      console.log(`  📄 Transcript TXT: ${txtPath}`);

      // Summary
      console.log(`  📊 ${utterances.length} utterances, ${Object.keys(speakers).length} speakers detected`);
    } else {
      console.log('  ⚠️  No utterances transcribed (check Deepgram API key)');
    }

    console.log('');
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
  });
});

// ============================================================
// Start server
// ============================================================
app.listen(HTTP_PORT, async () => {
  // Check emotion worker
  await checkEmotionWorker();

  // Re-check emotion worker every 10 seconds if not available
  if (!emotionWorkerAvailable) {
    const recheck = setInterval(async () => {
      const available = await checkEmotionWorker();
      if (available) {
        console.log('  ✅ Emotion worker now available!');
        clearInterval(recheck);
      }
    }, 10000);
  }

  console.log('');
  console.log('=== Soliloquy Server ===');
  console.log(`  HTTP health check: http://localhost:${HTTP_PORT}`);
  console.log(`  WebSocket audio:   ws://localhost:${WS_PORT}`);
  console.log(`  Recordings dir:    ${recordingsDir}`);
  console.log(`  Deepgram:          ${deepgram ? '✅ enabled' : '❌ disabled (no API key)'}`);
  console.log(`  Emotion worker:    ${emotionWorkerAvailable ? '✅ connected (localhost:5050)' : '⏳ waiting (will auto-detect)'}`);
  console.log('');
  console.log('Waiting for glasses to connect...');
  console.log('');
});
