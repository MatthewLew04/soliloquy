const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const HTTP_PORT = 3000;
const WS_PORT = 8080;

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
    .filter(f => f.endsWith('.raw') || f.endsWith('.wav') || f.endsWith('.transcript.txt'))
    .sort()
    .reverse();
  res.json(files);
});

// WebSocket server for real-time audio streaming from ESP32
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const timestamp = Date.now();
  const rawPath = path.join(recordingsDir, `${timestamp}.raw`);
  const stream = fs.createWriteStream(rawPath);
  let bytesReceived = 0;

  console.log(`[${new Date().toISOString()}] Glasses connected from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    stream.write(data);
    bytesReceived += data.length;

    // Log progress every ~1MB
    if (bytesReceived % (1024 * 1024) < data.length) {
      const mb = (bytesReceived / (1024 * 1024)).toFixed(1);
      console.log(`  Recording ${timestamp}: ${mb} MB received`);
    }
  });

  ws.on('close', () => {
    stream.end();
    const duration = ((bytesReceived / 2) / 16000).toFixed(1); // 16-bit mono @ 16kHz
    console.log(`[${new Date().toISOString()}] Recording saved: ${rawPath}`);
    console.log(`  Size: ${(bytesReceived / 1024).toFixed(0)} KB, ~${duration}s of audio`);

    // Convert raw PCM to WAV for easy playback
    try {
      const wavPath = rawPath.replace('.raw', '.wav');
      execSync(`ffmpeg -f s16le -ar 16000 -ac 1 -i "${rawPath}" "${wavPath}" -y`, {
        stdio: 'pipe'
      });
      console.log(`  Converted to WAV: ${wavPath}`);

      // TODO: Transcription — uncomment when you have Whisper set up
      // transcribe(wavPath);

      // TODO: S3 upload — uncomment when AWS is configured
      // uploadToS3(wavPath);
    } catch (err) {
      console.error(`  FFmpeg conversion failed: ${err.message}`);
      console.log('  Raw file is still saved — you can manually convert later');
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`);
  });
});

// --- Transcription stub ---
// Uncomment and configure when ready:
//
// function transcribe(wavPath) {
//   // Option A: OpenAI Whisper API (requires OPENAI_API_KEY env var)
//   // Option B: Local whisper.cpp (install separately)
//   // Option C: Deepgram API (real-time, best for streaming)
//
//   // Example with whisper.cpp:
//   // const result = execSync(`whisper-cpp -m models/ggml-base.en.bin -f ${wavPath} -otxt`);
//   // const transcript = fs.readFileSync(wavPath.replace('.wav', '.txt'), 'utf8');
//   // const transcriptPath = wavPath.replace('.wav', '.transcript.txt');
//   // fs.writeFileSync(transcriptPath, transcript);
//   // console.log('Transcript:', transcript.substring(0, 200));
// }

// --- S3 upload stub ---
// Uncomment and configure when AWS credentials are set up:
//
// const AWS = require('aws-sdk');
// const s3 = new AWS.S3();
// const S3_BUCKET = 'soliloquy-transcripts';
//
// async function uploadToS3(filePath) {
//   const fileContent = fs.readFileSync(filePath);
//   const key = `audio/${path.basename(filePath)}`;
//   await s3.putObject({
//     Bucket: S3_BUCKET,
//     Key: key,
//     Body: fileContent,
//   }).promise();
//   console.log(`  Uploaded to S3: s3://${S3_BUCKET}/${key}`);
// }

app.listen(HTTP_PORT, () => {
  console.log('');
  console.log('=== Soliloquy Server ===');
  console.log(`  HTTP health check: http://localhost:${HTTP_PORT}`);
  console.log(`  WebSocket audio:   ws://localhost:${WS_PORT}`);
  console.log(`  Recordings dir:    ${recordingsDir}`);
  console.log('');
  console.log('Waiting for glasses to connect...');
  console.log('');
});
