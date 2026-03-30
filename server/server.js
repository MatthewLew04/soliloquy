require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const dgram = require('dgram');

// OpenClaw integration
const {
  containsClawWord, extractClawQuery, matchIntent,
  executeIntent, executeGeneralQuery, condensForGlasses,
  checkOpenClaw,
} = require('./openclaw_bridge');
let openclawAvailable = false;

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

// ============================================================
// Gemini conversation summarizer
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function geminiRequest(body, model = 'gemini-2.0-flash') {
  return new Promise((resolve) => {
    if (!GEMINI_API_KEY) return resolve(null);

    const jsonBody = JSON.stringify(body);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const parsed = new URL(url);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonBody) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            console.error(`  Gemini HTTP ${res.statusCode}:`, data.slice(0, 300));
            return resolve(null);
          }
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || null;
          resolve(text);
        } catch (e) {
          console.error('  Gemini parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('  Gemini API error:', err.message);
      resolve(null);
    });

    req.write(jsonBody);
    req.end();
  });
}

function summarizeConversation(transcriptText, emotions) {
  return new Promise((resolve) => {
    if (!GEMINI_API_KEY) return resolve(null);

    const emotionStr = Object.entries(emotions || {}).map(([e,c]) => `${e}: ${c}`).join(', ') || 'none detected';
    const prompt = `You are analyzing a real-time transcript captured by smart glasses worn during a conversation. Summarize this conversation concisely.

Transcript:
${transcriptText}

Detected emotions: ${emotionStr}

Provide a structured summary with:
1. **Context**: Where/what kind of conversation (1 sentence)
2. **Key Topics**: Bullet points of main subjects discussed
3. **Key Takeaways**: Important decisions, action items, or insights
4. **Mood**: Overall emotional tone based on both words and detected emotions

Keep the summary under 200 words. Be direct and specific.`;

    geminiRequest({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
    }).then(resolve);
  });
}

// ============================================================
// AI Agent — Gemini interjection engine
// ============================================================
const AGENT_COOLDOWN_MS = 8000;   // Min 8s between interjections
const AGENT_CONTEXT_WINDOW = 6;   // Last N utterances for context

// Wake word that activates the agent
const WAKE_WORDS = ['ask', 'ask,', 'ask.'];
function containsWakeWord(text) {
  const words = text.toLowerCase().trim().split(/\s+/);
  // Check if any word in the utterance IS "ask" (exact match, not substring)
  return words.some(w => w.replace(/[,.:!?]/g, '') === 'ask');
}
// Strip the wake word and everything before it to get the question
function extractQuestion(text) {
  return text.replace(/^.*?\bask\b[,.:!?\s]*/i, '').trim();
}

const AGENT_SYSTEM_PROMPT = `You are a visual identification AI in smart glasses. The user says "ask" to activate you.

CORE BEHAVIOR — always apply:
- IDENTIFY SPECIFICALLY: brand names, product names, restaurant names, model numbers — never generic descriptions
- BE CONCISE: 1-2 sentences max. State the identification + brief visual reasoning (logo, text, packaging, signage)
- NO HEDGING: make your best call. If uncertain, state your best guess and briefly note why
- NEVER ask follow-up questions — just answer
- NEVER say NO_RESPONSE

ADAPT TO CONTEXT:
- PRODUCT (bottle, box, package, food item): "[Brand] [Product Name]" + what visual cues confirm it (logo color, label text, container shape)
- MENU / RESTAURANT: identify the restaurant from signage, logo, or menu design. Use web search to find what's popular there, then recommend 2-3 specific dishes with one-line reasons
- SIGN / TEXT: read and relay the text concisely
- SCENE / LOCATION: identify the place, landmark, or setting specifically
- PERSON / OBJECT: describe what's notable — clothing brands, device models, etc.

WEB SEARCH: use automatically when identification would benefit from real-time info (restaurant reviews, product details, location info)

If the user says "more", provide expanded details: ingredients, reviews, history, price range, nutritional info, or whatever is relevant to the identified item.`;

// Pass 2: Condense a full answer into short TTS-friendly speech
function condensForTTS(fullAnswer) {
  return new Promise((resolve) => {
    geminiRequest({
      contents: [{ parts: [{ text: `Extract ONLY the key facts from this into 1-3 short spoken sentences. Keep ALL specific names, dish names, numbers, and recommendations. Remove filler and preamble. NEVER ask follow-up questions — just state the facts.

Full answer:
"${fullAnswer}"

Condensed version:` }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
    }, 'gemini-2.0-flash').then(text => {
      if (!text || text.trim().length === 0) {
        // Fallback: just truncate the original
        resolve(fullAnswer.split('.').slice(0, 2).join('.') + '.');
      } else {
        resolve(text.trim());
      }
    });
  });
}

// "more" follow-up: re-query with previous photo + "give me more details"
function agentMore(photoBase64, previousAnswer) {
  return new Promise((resolve) => {
    if (!GEMINI_API_KEY) return resolve(null);

    const parts = [];
    if (photoBase64) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: photoBase64 } });
    }
    parts.push({ text: `You previously identified this as: "${previousAnswer}"\n\nThe user wants MORE details. Provide expanded information: ingredients, reviews, history, price, nutrition, comparisons, or whatever is most relevant. Be thorough but structured.` });

    geminiRequest({
      system_instruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
      contents: [{ parts }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }, 'gemini-2.5-flash').then(async (fullText) => {
      console.log(`  📡 More (full): "${fullText}"`);
      if (!fullText || fullText.trim().length === 0) return resolve(null);
      if (fullText.trim().length < 150) return resolve(fullText.trim());
      const condensed = await condensForTTS(fullText.trim());
      console.log(`  📡 More (condensed): "${condensed}"`);
      resolve(condensed);
    });
  });
}

function agentDecide(recentUtterances, photoBase64 = null) {
  return new Promise((resolve) => {
    if (!GEMINI_API_KEY) return resolve(null);

    const lastUtt = recentUtterances[recentUtterances.length - 1];

    // FAST PATH: No photo → simple factual Q&A, use gemini-2.0-flash (no search)
    if (!photoBase64) {
      const parts = [{ text: `Question: "${lastUtt.text}"\n\nAnswer in as few words as possible.` }];
      geminiRequest({
        system_instruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
      }, 'gemini-2.0-flash').then(text => {
        console.log(`  📡 Fast path: "${text}"`);
        resolve(!text || text.trim().length === 0 ? null : text.trim());
      });
      return;
    }

    // FULL PIPELINE: Photo → gemini-2.5-flash + web search + condense
    const parts = [
      { inline_data: { mime_type: 'image/jpeg', data: photoBase64 } },
      { text: `A photo was just taken. Identify what you see. Question: "${lastUtt.text}"\n\nBe specific and concise (1-2 sentences).` }
    ];

    geminiRequest({
      system_instruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
      contents: [{ parts }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }, 'gemini-2.5-flash').then(async (fullText) => {
      console.log(`  📡 Pass 1 (full): "${fullText}"`);
      if (!fullText || fullText.trim().length === 0) return resolve(null);

      // If already short enough, skip Pass 2
      if (fullText.trim().length < 100) return resolve(fullText.trim());

      // Pass 2: Condense for TTS
      const condensed = await condensForTTS(fullText.trim());
      console.log(`  📡 Pass 2 (condensed): "${condensed}"`);
      resolve(condensed);
    });
  });
}

// ============================================================
// Deepgram TTS — text to raw PCM audio
// ============================================================

// Speed up PCM audio by 1.5x (drop every 3rd sample pair)
function speedUpAudio(pcmBuffer, factor = 1.5) {
  const bytesPerSample = 2; // 16-bit
  const totalSamples = pcmBuffer.length / bytesPerSample;
  const outSamples = Math.floor(totalSamples / factor);
  const out = Buffer.alloc(outSamples * bytesPerSample);
  
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.floor(i * factor);
    const srcOffset = srcIdx * bytesPerSample;
    const dstOffset = i * bytesPerSample;
    pcmBuffer.copy(out, dstOffset, srcOffset, srcOffset + bytesPerSample);
  }
  return out;
}

function textToSpeech(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const url = new URL('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000');

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(Buffer.concat(chunks));  // 1x speed, no processing
        } else {
          console.error(`  TTS error: ${res.statusCode}`, Buffer.concat(chunks).toString().slice(0, 200));
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('  TTS request error:', err.message);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

// Send PCM audio to ESP32 in chunks with 0x05 prefix
const MSG_PLAYBACK = 0x05;
const AUDIO_CHUNK_SIZE = 1024;  // bytes per WebSocket frame

function sendAudioToGlasses(ws, pcmBuffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  for (let offset = 0; offset < pcmBuffer.length; offset += AUDIO_CHUNK_SIZE) {
    const chunk = pcmBuffer.slice(offset, offset + AUDIO_CHUNK_SIZE);
    const frame = Buffer.alloc(1 + chunk.length);
    frame[0] = MSG_PLAYBACK;
    chunk.copy(frame, 1);
    try { ws.send(frame); } catch(e) { break; }
  }
  console.log(`  🔊 Sent ${(pcmBuffer.length / 1024).toFixed(1)} KB audio to glasses`);
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
  console.error('\u26a0\ufe0f  DEEPGRAM_API_KEY not set!');
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
    .filter(f => f.endsWith('.raw') || f.endsWith('.wav') || f.endsWith('.json') || f.endsWith('.txt') || f.endsWith('.jpg'))
    .sort()
    .reverse();
  res.json(files);
});

// List photos
app.get('/photos', (req, res) => {
  const files = fs.readdirSync(recordingsDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .reverse();
  res.json(files);
});

// Serve individual photo
app.get('/photos/:filename', (req, res) => {
  const filePath = path.join(recordingsDir, req.params.filename);
  if (!fs.existsSync(filePath) || !req.params.filename.endsWith('.jpg')) {
    return res.status(404).send('Not found');
  }
  res.sendFile(filePath);
});

// ============================================================
// Session tracking + SSE for real-time dashboard
// ============================================================
const sseClients = [];
let currentSession = null;
let activeWs = null;

const MSG_STATS = 0x04;

function sseNotify(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.write(msg); } catch(e) {} }
}

// SSE endpoint
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.push(res);
  if (currentSession) {
    res.write(`event: session\ndata: ${JSON.stringify(currentSession)}\n\n`);
  }
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// List past sessions
app.get('/api/sessions', (req, res) => {
  const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.transcript.json'));
  const sessions = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(recordingsDir, f)));
      const id = f.replace('.transcript.json', '');
      const photos = fs.readdirSync(recordingsDir).filter(p => p.startsWith(id) && p.endsWith('.jpg'));
      return { id, timestamp: data.timestamp, duration: data.duration_seconds, utterances: data.utterances?.length || 0, photos: photos.length };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.id - a.id);
  res.json(sessions);
});

// Get individual session
app.get('/api/session/:id', (req, res) => {
  const jsonPath = path.join(recordingsDir, `${req.params.id}.transcript.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Not found' });
  const data = JSON.parse(fs.readFileSync(jsonPath));
  const photos = fs.readdirSync(recordingsDir).filter(p => p.startsWith(req.params.id) && p.endsWith('.jpg'));
  res.json({ ...data, photos });
});

// ============================================================
// OpenClaw API endpoints
// ============================================================

// Vision skill: trigger capture, wait for JPEG, return it
app.get('/api/vision', (req, res) => {
  if (!activeWs) return res.status(503).json({ error: 'Glasses not connected' });
  const timeout = setTimeout(() => res.status(504).json({ error: 'Capture timeout' }), 10000);
  const handler = (photoBuffer) => {
    clearTimeout(timeout);
    res.set('Content-Type', 'image/jpeg');
    res.send(photoBuffer);
  };
  activeWs._oncePhoto = handler;
  activeWs.send('CAPTURE');
});

// Context endpoint: return latest session state
app.get('/api/context', (req, res) => {
  if (!currentSession) return res.json({ connected: false });
  res.json({
    connected: true,
    uptime_seconds: Math.floor((Date.now() - currentSession.startTime) / 1000),
    utterances: currentSession.utteranceCount,
    photos: currentSession.photoCount,
    words: currentSession.wordCount,
    latest_transcript: currentSession.latestLines.slice(-10),
    device_stats: currentSession.deviceStats || null,
    emotions: currentSession.emotions || {},
  });
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// End session (from dashboard button)
app.post('/api/end-session', (req, res) => {
  if (!activeWs) return res.json({ ok: false, reason: 'No active session' });
  console.log('  \ud83d\uded1 Session ended via dashboard');
  activeWs.close();
  res.json({ ok: true });
});

// ============================================================
// OpenClaw bridge endpoints
// ============================================================
app.use(express.json());

// Speak through glasses
app.post('/api/speak', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing text field' });
  if (!activeWs) return res.status(503).json({ error: 'Glasses not connected' });
  try {
    const pcmAudio = await textToSpeech(text);
    if (pcmAudio && pcmAudio.length > 0) {
      sendAudioToGlasses(activeWs, pcmAudio);
      res.json({ ok: true, audio_bytes: pcmAudio.length });
    } else {
      res.status(500).json({ error: 'TTS failed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Route a query through OpenClaw agent
app.post('/api/openclaw', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Missing message field' });
  if (!openclawAvailable) return res.status(503).json({ error: 'OpenClaw not available' });
  try {
    const intent = matchIntent(message);
    let result;
    if (intent) {
      result = await executeIntent(intent.intent, intent.params);
    } else {
      result = await executeGeneralQuery(message);
    }
    res.json({ ok: true, intent: intent?.intent?.id || 'general', response: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read soul.md
app.get('/api/soul', (req, res) => {
  const soulPath = path.join(__dirname, '..', 'soul.md');
  if (!fs.existsSync(soulPath)) return res.status(404).json({ error: 'soul.md not found' });
  res.type('text/markdown').send(fs.readFileSync(soulPath, 'utf-8'));
});

// ============================================================
// Speaker identification heuristic
// ============================================================
function identifySpeakers(utterances) {
  const speakerFirstAppearance = {};
  const speakerWordCount = {};

  for (const utt of utterances) {
    const spk = utt.speaker;
    if (!(spk in speakerFirstAppearance)) {
      speakerFirstAppearance[spk] = utt.start;
    }
    speakerWordCount[spk] = (speakerWordCount[spk] || 0) + utt.text.split(' ').length;
  }

  let meSpeaker = null;
  let maxScore = -1;
  for (const spk in speakerWordCount) {
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
const MSG_AUDIO = 0x01;
const MSG_PHOTO = 0x02;

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

  // Audio buffer for emotion analysis
  const audioChunks = [];
  let streamStartTime = Date.now();
  let photoCount = 0;
  let wordCount = 0;
  let uttId = 0;

  // Agent state
  let lastAgentResponseTime = 0;
  let lastPhotoBuffer = null;   // Most recent photo for vision queries
  let agentProcessing = false;  // Prevent overlapping agent calls
  let agentListening = false;   // True after wake word, waiting for question
  let agentListenTimeout = null;
  let agentSkipped = false;     // True when user says "skip" to abort response
  let lastAgentAnswer = null;   // Store last answer for "more" follow-ups
  let lastAgentPhotoB64 = null; // Store last photo used for "more" follow-ups

  // OpenClaw state
  let clawListening = false;        // True after "claw" wake, waiting for query
  let clawListenTimeout = null;
  let clawDictating = null;         // Pending two-step intent (reply/send): { intent, params }

  // Session tracking
  activeWs = ws;
  currentSession = {
    startTime: timestamp,
    utteranceCount: 0,
    wordCount: 0,
    photoCount: 0,
    audioMB: '0',
    latestLines: [],
    deviceStats: null,
    emotions: {},
  };
  sseNotify('session', currentSession);

  // Re-check emotion worker on every new connection
  checkEmotionWorker().then(avail => {
    if (avail) console.log('  \u2705 Emotion worker: connected');
    else console.log('  \u26a0\ufe0f Emotion worker: not available (emotions will be skipped)');
  });

  console.log(`[${new Date().toISOString()}] \ud83c\udfa7 Glasses connected from ${req.socket.remoteAddress}`);

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
        console.log('  \ud83d\udce1 Deepgram connection opened');
      });

      dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const alt = data.channel?.alternatives?.[0];
        if (!alt || !alt.transcript || alt.transcript.trim() === '') return;

        const transcript = alt.transcript;
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

        // Assign utterance ID for emotion matching
        uttId++;
        utt._id = uttId;

        // Extract audio segment for this utterance and analyze emotion
        if (!emotionWorkerAvailable) {
          // Skip silently
        } else if (utt.end <= 0) {
          console.log(`  \u23f3 Emotion skipped: no timing data`);
        } else {
          const startByte = Math.floor(utt.start * 16000 * 2);
          const endByte = Math.floor(utt.end * 16000 * 2);

          const totalBuf = Buffer.concat(audioChunks.map(c => c.data));
          if (endByte <= totalBuf.length) {
            const segment = totalBuf.slice(startByte, endByte);
            if (segment.length > 640) {
              analyzeEmotion(segment).then(emotionResult => {
                utt.voice_emotion = emotionResult.emotion || 'unknown';
                utt.voice_emotion_score = emotionResult.score || 0;
                utt.voice_emotion_latency_ms = emotionResult.inference_ms || 0;

                const emoji = {
                  angry: '\ud83d\ude21', happy: '\ud83d\ude0a', sad: '\ud83d\ude22', fearful: '\ud83d\ude30',
                  disgusted: '\ud83e\udd22', surprised: '\ud83d\ude32', neutral: '\ud83d\ude10', other: '\ud83e\udd14'
                }[utt.voice_emotion] || '\u2753';
                console.log(`  ${emoji} voice_emotion: ${utt.voice_emotion} (${utt.voice_emotion_score.toFixed(2)}) [${utt.voice_emotion_latency_ms}ms]`);

                // Push emotion to dashboard
                sseNotify('emotion', { id: utt._id, emotion: utt.voice_emotion, score: utt.voice_emotion_score, emoji });
                if (currentSession) {
                  currentSession.emotions[utt.voice_emotion] = (currentSession.emotions[utt.voice_emotion] || 0) + 1;
                }
              });
            }
          }
        }

        // Real-time console output
        const label = `Speaker ${speaker}`;
        const line = `  [${label}] ${transcript}`;
        console.log(line);
        realtimeLines.push(line);

        // Update session + push to dashboard
        wordCount += transcript.split(' ').length;
        if (currentSession) {
          currentSession.utteranceCount = utterances.length;
          currentSession.wordCount = wordCount;
          currentSession.latestLines.push(line);
          if (currentSession.latestLines.length > 50) currentSession.latestLines.shift();
        }
        sseNotify('transcript', { id: uttId, speaker: label, text: transcript });
        sseNotify('stats', currentSession);

        // Voice-triggered photo
        const lower = transcript.toLowerCase();
        if (lower.includes('picture') || lower.includes('photo') || lower.includes('take a pic')) {
          console.log('  \ud83d\udcf8 Voice trigger detected! Sending capture command...');
          try { ws.send('CAPTURE'); } catch (e) { /* ignore */ }
          // Enter listening mode for vision question
          agentListening = true;
          if (agentListenTimeout) clearTimeout(agentListenTimeout);
          agentListenTimeout = setTimeout(() => {
            if (agentListening) { agentListening = false; console.log('  \ud83e\udde0 Picture listen window expired'); }
          }, 15000);
          console.log('  \ud83e\udde0 Photo taken! Listening for question about it...');
        }

        // --------------------------------------------------------
        // AI Agent — skip command (abort pending response)
        const lowerTrimmed = transcript.toLowerCase().trim();
        if ((lowerTrimmed === 'skip' || lowerTrimmed === 'skip.' || lowerTrimmed === 'skip,') && agentProcessing) {
          agentSkipped = true;
          console.log('  ⏭️ Skip detected — will discard pending agent response');
        }

        // AI Agent — "more" command (expand previous answer)
        const now = Date.now();
        const hasRecentPhoto = lastPhotoBuffer && (now - (lastPhotoBuffer._timestamp || 0)) < 30000;

        if ((lowerTrimmed === 'more' || lowerTrimmed === 'more.' || lowerTrimmed === 'more,') && lastAgentAnswer && !agentProcessing) {
          console.log(`  🔍 More requested — expanding previous answer`);
          const agentStart = Date.now();
          agentProcessing = true;
          agentSkipped = false;
          agentMore(lastAgentPhotoB64, lastAgentAnswer).then(async (response) => {
            agentProcessing = false;
            if (agentSkipped) { agentSkipped = false; console.log('  ⏭️ More response skipped'); return; }
            const geminiMs = Date.now() - agentStart;
            if (!response) { console.log(`  🧠 More: NO_RESPONSE (${geminiMs}ms)`); return; }
            lastAgentResponseTime = Date.now();
            lastAgentAnswer = response;
            console.log(`  🤖 More (${geminiMs}ms): "${response}"`);
            sseNotify('agent', { text: response, timestamp: Date.now() });
            const ttsStart = Date.now();
            const pcmAudio = await textToSpeech(response);
            if (pcmAudio && pcmAudio.length > 0) {
              console.log(`  🔊 TTS (${Date.now() - ttsStart}ms): ${(pcmAudio.length / 1024).toFixed(1)} KB`);
              sendAudioToGlasses(ws, pcmAudio);
            }
          }).catch(err => { agentProcessing = false; console.error('  More error:', err.message); });
        }
        // AI Agent — wake word activation
        else if (containsWakeWord(transcript) && !agentProcessing) {
          // Strip wake word to get the question part
          let question = extractQuestion(transcript);
          
          if (question.length > 3 && question.split(' ').length >= 2) {
            // Question in same utterance: "Ask, what year did WW2 end?"
            agentListening = false;
            if (agentListenTimeout) clearTimeout(agentListenTimeout);
            
            console.log(`  🧠 Ask detected: "${question}"`);
            const agentStart = Date.now();
            const recentUtts = utterances.slice(-AGENT_CONTEXT_WINDOW);
            const photoB64 = hasRecentPhoto ? lastPhotoBuffer.toString('base64') : null;
            
            agentProcessing = true;
            agentSkipped = false;
            agentDecide(recentUtts, photoB64).then(async (response) => {
              agentProcessing = false;
              if (agentSkipped) { agentSkipped = false; console.log('  ⏭️ Agent response skipped'); return; }
              const geminiMs = Date.now() - agentStart;
              if (!response) { console.log(`  🧠 Agent: NO_RESPONSE (${geminiMs}ms)`); return; }
              lastAgentResponseTime = Date.now();
              lastAgentAnswer = response;           // Store for "more"
              lastAgentPhotoB64 = photoB64;          // Store photo for "more"
              console.log(`  🤖 Agent (${geminiMs}ms): "${response}"`);
              sseNotify('agent', { text: response, timestamp: Date.now() });
              const ttsStart = Date.now();
              const pcmAudio = await textToSpeech(response);
              if (pcmAudio && pcmAudio.length > 0) {
                console.log(`  🔊 TTS (${Date.now() - ttsStart}ms): ${(pcmAudio.length / 1024).toFixed(1)} KB`);
                sendAudioToGlasses(ws, pcmAudio);
              }
            }).catch(err => { agentProcessing = false; console.error('  Agent error:', err.message); });
          } else {
            // Just "ask" by itself — wait for next utterance
            agentListening = true;
            if (agentListenTimeout) clearTimeout(agentListenTimeout);
            agentListenTimeout = setTimeout(() => {
              if (agentListening) { agentListening = false; console.log('  🧠 Listen window expired'); }
            }, 15000);
            console.log('  🧠 "Ask" detected! Listening for question...');
          }
        }
        // Fallback: if listening from a previous "ask", this utterance is the question
        else if (agentListening && !agentProcessing && transcript.split(' ').length >= 2) {
          agentListening = false;
          if (agentListenTimeout) clearTimeout(agentListenTimeout);
          
          console.log(`  🧠 Got question: "${transcript}"`);
          const agentStart = Date.now();
          const recentUtts = utterances.slice(-AGENT_CONTEXT_WINDOW);
          const photoB64 = hasRecentPhoto ? lastPhotoBuffer.toString('base64') : null;
          
          agentProcessing = true;
          agentSkipped = false;
          agentDecide(recentUtts, photoB64).then(async (response) => {
            agentProcessing = false;
            if (agentSkipped) { agentSkipped = false; console.log('  ⏭️ Agent response skipped'); return; }
            const geminiMs = Date.now() - agentStart;
            if (!response) { console.log(`  🧠 Agent: NO_RESPONSE (${geminiMs}ms)`); return; }
            lastAgentResponseTime = Date.now();
            lastAgentAnswer = response;           // Store for "more"
            lastAgentPhotoB64 = photoB64;          // Store photo for "more"
            console.log(`  🤖 Agent (${geminiMs}ms): "${response}"`);
            sseNotify('agent', { text: response, timestamp: Date.now() });
            const ttsStart = Date.now();
            const pcmAudio = await textToSpeech(response);
            if (pcmAudio && pcmAudio.length > 0) {
              console.log(`  🔊 TTS (${Date.now() - ttsStart}ms): ${(pcmAudio.length / 1024).toFixed(1)} KB`);
              sendAudioToGlasses(ws, pcmAudio);
            }
          }).catch(err => { agentProcessing = false; console.error('  Agent error:', err.message); });
        }

        // --------------------------------------------------------
        // OpenClaw — two-step dictation (reply/send body capture)
        // --------------------------------------------------------
        else if (clawDictating && !agentProcessing && transcript.split(' ').length >= 2) {
          const pending = clawDictating;
          clawDictating = null;
          pending.params.body = transcript;
          console.log(`  🦞 Claw dictation body: "${transcript}"`);

          agentProcessing = true;
          agentSkipped = false;
          const clawStart = Date.now();
          executeIntent(pending.intent, pending.params).then(async (result) => {
            agentProcessing = false;
            if (agentSkipped) { agentSkipped = false; console.log('  ⏭️ Claw response skipped'); return; }
            const ttsText = condensForGlasses(result);
            console.log(`  🦞 Claw result (${Date.now() - clawStart}ms): "${ttsText}"`);
            sseNotify('agent', { text: `[OpenClaw] ${ttsText}`, timestamp: Date.now() });
            const pcmAudio = await textToSpeech(ttsText);
            if (pcmAudio && pcmAudio.length > 0) {
              sendAudioToGlasses(ws, pcmAudio);
            }
          }).catch(err => { agentProcessing = false; console.error('  Claw dictation error:', err.message); });
        }

        // --------------------------------------------------------
        // OpenClaw — "claw" wake word activation
        // --------------------------------------------------------
        else if (containsClawWord(transcript) && !agentProcessing && openclawAvailable) {
          const clawQuery = extractClawQuery(transcript);

          if (clawQuery.length > 3 && clawQuery.split(' ').length >= 2) {
            // Query in same utterance: "Claw, what's in my mail"
            clawListening = false;
            if (clawListenTimeout) clearTimeout(clawListenTimeout);

            console.log(`  🦞 Claw detected: "${clawQuery}"`);
            const matched = matchIntent(clawQuery);

            if (matched && matched.intent.needsFollowUp) {
              // Two-step: need the message body next
              clawDictating = matched;
              console.log(`  🦞 Waiting for dictation body (${matched.intent.id})...`);
              (async () => {
                const pcmAudio = await textToSpeech(`OK, what should I say to ${matched.params.contact}?`);
                if (pcmAudio && pcmAudio.length > 0) sendAudioToGlasses(ws, pcmAudio);
              })();
            } else {
              // Execute immediately
              agentProcessing = true;
              agentSkipped = false;
              const clawStart = Date.now();
              const intentToRun = matched ? matched.intent : null;
              const paramsToRun = matched ? matched.params : {};

              const execPromise = intentToRun
                ? executeIntent(intentToRun, paramsToRun)
                : executeGeneralQuery(clawQuery);

              execPromise.then(async (result) => {
                agentProcessing = false;
                if (agentSkipped) { agentSkipped = false; console.log('  ⏭️ Claw response skipped'); return; }
                const clawMs = Date.now() - clawStart;
                const ttsText = condensForGlasses(result);
                lastAgentAnswer = ttsText;
                console.log(`  🦞 Claw (${clawMs}ms): "${ttsText}"`);
                sseNotify('agent', { text: `[OpenClaw] ${ttsText}`, timestamp: Date.now() });
                const pcmAudio = await textToSpeech(ttsText);
                if (pcmAudio && pcmAudio.length > 0) {
                  sendAudioToGlasses(ws, pcmAudio);
                }
              }).catch(err => { agentProcessing = false; console.error('  Claw error:', err.message); });
            }
          } else {
            // Just "claw" by itself — wait for next utterance
            clawListening = true;
            if (clawListenTimeout) clearTimeout(clawListenTimeout);
            clawListenTimeout = setTimeout(() => {
              if (clawListening) { clawListening = false; console.log('  🦞 Claw listen window expired'); }
            }, 15000);
            console.log('  🦞 "Claw" detected! Listening for command...');
          }
        }

        // OpenClaw — fallback: if listening from a previous "claw", this is the query
        else if (clawListening && !agentProcessing && openclawAvailable && transcript.split(' ').length >= 2) {
          clawListening = false;
          if (clawListenTimeout) clearTimeout(clawListenTimeout);

          console.log(`  🦞 Got claw query: "${transcript}"`);
          const matched = matchIntent(transcript);

          if (matched && matched.intent.needsFollowUp) {
            clawDictating = matched;
            console.log(`  🦞 Waiting for dictation body (${matched.intent.id})...`);
            (async () => {
              const pcmAudio = await textToSpeech(`OK, what should I say to ${matched.params.contact}?`);
              if (pcmAudio && pcmAudio.length > 0) sendAudioToGlasses(ws, pcmAudio);
            })();
          } else {
            agentProcessing = true;
            agentSkipped = false;
            const clawStart = Date.now();
            const execPromise = matched
              ? executeIntent(matched.intent, matched.params)
              : executeGeneralQuery(transcript);

            execPromise.then(async (result) => {
              agentProcessing = false;
              if (agentSkipped) { agentSkipped = false; console.log('  ⏭️ Claw response skipped'); return; }
              const ttsText = condensForGlasses(result);
              lastAgentAnswer = ttsText;
              console.log(`  🦞 Claw (${Date.now() - clawStart}ms): "${ttsText}"`);
              sseNotify('agent', { text: `[OpenClaw] ${ttsText}`, timestamp: Date.now() });
              const pcmAudio = await textToSpeech(ttsText);
              if (pcmAudio && pcmAudio.length > 0) {
                sendAudioToGlasses(ws, pcmAudio);
              }
            }).catch(err => { agentProcessing = false; console.error('  Claw error:', err.message); });
          }
        }
      });

      dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('  Deepgram error:', err.message || err);
      });

      dgConnection.on(LiveTranscriptionEvents.Close, () => {
        console.log('  \ud83d\udce1 Deepgram connection closed');
      });
    } catch (err) {
      console.error('  Failed to start Deepgram:', err.message);
      dgConnection = null;
    }
  }

  // --------------------------------------------------------
  // Handle incoming data from ESP32
  // --------------------------------------------------------
  ws.on('message', (data) => {
    const buf = Buffer.from(data);
    if (buf.length < 2) return;

    const msgType = buf[0];
    const payload = buf.slice(1);

    if (msgType === MSG_PHOTO) {
      photoCount++;
      const photoFilename = `${timestamp}_photo_${photoCount}.jpg`;
      const photoPath = path.join(recordingsDir, photoFilename);
      
      // Rotate 90° clockwise (camera sensor is mounted sideways)
      let rotatedPayload = payload;
      try {
        rotatedPayload = execSync(
          'ffmpeg -f mjpeg -i pipe:0 -vf "transpose=2" -f mjpeg -q:v 1 pipe:1',
          { input: payload, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }
        );
      } catch (e) {
        console.log('  ⚠️ Photo rotation failed, saving original');
      }
      
      fs.writeFileSync(photoPath, rotatedPayload);
      console.log(`  📷 Photo saved: ${photoFilename} (${(rotatedPayload.length / 1024).toFixed(0)} KB)`);
      if (currentSession) currentSession.photoCount = photoCount;
      sseNotify('photo', { filename: photoFilename, size: rotatedPayload.length });
      sseNotify('stats', currentSession);
      if (ws._oncePhoto) { ws._oncePhoto(rotatedPayload); ws._oncePhoto = null; }
      // Store for agent vision queries
      lastPhotoBuffer = Buffer.from(rotatedPayload);
      lastPhotoBuffer._timestamp = Date.now();
      return;
    }

    if (msgType === MSG_STATS) {
      try {
        const stats = JSON.parse(payload.toString());
        if (currentSession) currentSession.deviceStats = stats;
        sseNotify('device', stats);
      } catch(e) {}
      return;
    }

    // Audio
    const audioData = (msgType === MSG_AUDIO) ? payload : buf;
    stream.write(audioData);
    bytesReceived += audioData.length;

    audioChunks.push({ timestamp_ms: Date.now() - streamStartTime, data: Buffer.from(audioData) });

    if (dgConnection && dgConnection.getReadyState() === 1) {
      dgConnection.send(audioData);
    }

    if (currentSession) {
      currentSession.audioMB = (bytesReceived / (1024 * 1024)).toFixed(1);
    }

    if (bytesReceived % (1024 * 1024) < audioData.length) {
      const mb = (bytesReceived / (1024 * 1024)).toFixed(1);
      console.log(`  \ud83d\udce6 Recording ${timestamp}: ${mb} MB received`);
      sseNotify('stats', currentSession);
    }
  });

  // --------------------------------------------------------
  // Handle disconnect
  // --------------------------------------------------------
  ws.on('close', () => {
    stream.end();
    const duration = ((bytesReceived / 2) / 16000).toFixed(1);
    console.log(`[${new Date().toISOString()}] \ud83d\udcbe Recording saved: ${rawPath}`);
    console.log(`  Size: ${(bytesReceived / 1024).toFixed(0)} KB, ~${duration}s of audio`);

    if (dgConnection) {
      try { dgConnection.finish(); } catch (e) { /* ignore */ }
    }

    // Convert raw PCM to WAV
    try {
      const wavPath = rawPath.replace('.raw', '.wav');
      execSync(`ffmpeg -f s16le -ar 16000 -ac 1 -i "${rawPath}" "${wavPath}" -y`, { stdio: 'pipe' });
      console.log(`  \ud83d\udd0a Converted to WAV: ${wavPath}`);
    } catch (err) {
      console.error(`  FFmpeg conversion failed: ${err.message}`);
    }

    // Save transcript
    if (utterances.length > 0) {
      const speakers = identifySpeakers(utterances);

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
      console.log(`  \ud83d\udcdd Transcript JSON: ${jsonPath}`);

      const txtLines = utterances.map(u => {
        const label = speakers[`Speaker ${u.speaker}`]?.label || 'unknown';
        const emotion = u.voice_emotion !== 'pending' ? `${u.voice_emotion} ${u.voice_emotion_score.toFixed(2)}` : 'no-emotion';
        return `[Speaker ${u.speaker} / ${label}] (${emotion}) ${u.text}`;
      });
      const txtPath = rawPath.replace('.raw', '.transcript.txt');
      fs.writeFileSync(txtPath, txtLines.join('\n') + '\n');
      console.log(`  \ud83d\udcc4 Transcript TXT: ${txtPath}`);

      console.log(`  \ud83d\udcca ${utterances.length} utterances, ${Object.keys(speakers).length} speakers detected`);

      // Generate Gemini summary
      const sessionEmotions = currentSession?.emotions || {};
      const transcriptForSummary = txtLines.join('\n');
      summarizeConversation(transcriptForSummary, sessionEmotions).then(summary => {
        if (summary) {
          console.log(`  \ud83e\udde0 Gemini summary generated`);
          // Save summary to separate file
          const summaryPath = rawPath.replace('.raw', '.summary.txt');
          fs.writeFileSync(summaryPath, summary);
          // Update transcript JSON with summary
          transcriptData.summary = summary;
          fs.writeFileSync(jsonPath, JSON.stringify(transcriptData, null, 2));
          // Push to dashboard
          sseNotify('summary', { summary, timestamp });
        }

        // soul.md for OpenClaw (after summary is available)
        const soulPath = path.join(__dirname, '..', 'soul.md');
        const date = new Date(timestamp);
        const dateStr = date.toISOString().slice(0, 16).replace('T', ' ');
        const speakerList = Object.entries(speakers).map(([k,v]) => `${k} (${v.label}, ${v.word_count} words)`).join(', ');
        const emotionSummary = Object.entries(sessionEmotions).map(([e,c]) => `${e}:${c}`).join(', ') || 'none';
        let soulEntry = `\n## ${dateStr}\n- Duration: ${duration}s, ${utterances.length} utterances, ${photoCount} photos\n- Speakers: ${speakerList}\n- Emotions: ${emotionSummary}\n`;
        if (summary) soulEntry += `- Summary: ${summary.split('\n').slice(0, 3).join(' ').substring(0, 300)}\n`;
        fs.appendFileSync(soulPath, soulEntry);
        console.log(`  \ud83e\udde0 soul.md updated`);
      });
    } else {
      console.log('  \u26a0\ufe0f  No utterances transcribed (check Deepgram API key)');
    }

    // Notify dashboard
    activeWs = null;
    const closedSession = currentSession;
    currentSession = null;
    sseNotify('disconnect', { emotions: closedSession?.emotions || {} });

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
  // UDP discovery — respond to ESP32 broadcast with our IP + port
  const discoveryPort = 5555;
  const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udpServer.on('message', (msg, rinfo) => {
    if (msg.toString().trim() === 'SOLILOQUY_DISCOVER') {
      // Get our IP on the same interface the request came from
      const nets = os.networkInterfaces();
      let myIP = '0.0.0.0';
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) { myIP = net.address; break; }
        }
        if (myIP !== '0.0.0.0') break;
      }
      const response = Buffer.from(`SOLILOQUY_SERVER ${myIP} ${WS_PORT}`);
      udpServer.send(response, rinfo.port, rinfo.address);
      console.log(`  📡 Discovery: replied to ${rinfo.address} → ${myIP}:${WS_PORT}`);
    }
  });
  udpServer.bind(discoveryPort, () => {
    udpServer.setBroadcast(true);
    console.log(`  📡 Discovery: listening for UDP broadcasts on port ${discoveryPort}`);
  });

  await checkEmotionWorker();
  openclawAvailable = await checkOpenClaw();

  if (!emotionWorkerAvailable) {
    const recheck = setInterval(async () => {
      const available = await checkEmotionWorker();
      if (available) {
        console.log('  \u2705 Emotion worker now available!');
        clearInterval(recheck);
      }
    }, 10000);
  }

  if (!openclawAvailable) {
    const recheckClaw = setInterval(async () => {
      openclawAvailable = await checkOpenClaw();
      if (openclawAvailable) {
        console.log('  \u2705 OpenClaw now available!');
        clearInterval(recheckClaw);
      }
    }, 15000);
  }

  console.log('');
  console.log('=== Soliloquy Server ===');
  console.log(`  HTTP dashboard:    http://localhost:${HTTP_PORT}/dashboard`);
  console.log(`  WebSocket audio:   ws://localhost:${WS_PORT}`);
  console.log(`  Recordings dir:    ${recordingsDir}`);
  console.log(`  Deepgram:          ${deepgram ? '\u2705 enabled' : '\u274c disabled (no API key)'}`);
  console.log(`  Emotion worker:    ${emotionWorkerAvailable ? '\u2705 connected (localhost:5050)' : '\u23f3 waiting (will auto-detect)'}`);
  console.log(`  OpenClaw:          ${openclawAvailable ? '\u2705 connected (say "claw" to activate)' : '\u23f3 waiting (will auto-detect)'}`);
  console.log(`  OpenClaw vision:   http://localhost:${HTTP_PORT}/api/vision`);
  console.log(`  OpenClaw context:  http://localhost:${HTTP_PORT}/api/context`);
  console.log(`  OpenClaw speak:    http://localhost:${HTTP_PORT}/api/speak`);
  console.log(`  OpenClaw query:    http://localhost:${HTTP_PORT}/api/openclaw`);
  console.log(`  AI Agent:          ${GEMINI_API_KEY ? '\u2705 enabled (Gemini + Deepgram TTS)' : '\u274c disabled (no Gemini key)'}`);
  console.log('');
  console.log('Waiting for glasses to connect...');
  console.log('');
});
