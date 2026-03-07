# OpenGlass 2 (Soliloquy) — Build Guide

**Goal:** Super cheap open-source AI smart glasses for OpenClaw enthusiasts.
**Thesis:** People want to take advantage of what they already say. 24/7 audio → transcripts → soul.md → OpenClaw context.

**Build priority (ONE THING WELL, then expand):**
1. 🎤 Mic → WiFi → Phone → Server → Transcripts (the core product)
2. 📷 Camera → capture on button press → upload to server
3. 🎧 Audio playback → server response → earbuds
4. 🦞 OpenClaw integration → soul.md updates from daily transcripts

---

## PHASE 0: PRE-ASSEMBLY (Do now while waiting for Waveshare board)

### 0.1 — Set up your server (S3 + transcription)

You need somewhere to receive and store audio. Do this NOW — no hardware needed.

```bash
# On your laptop/dev machine
mkdir soliloquy-server && cd soliloquy-server
npm init -y
npm install express multer aws-sdk @google-cloud/speech ws
```

**Minimal server architecture:**
```
ESP32 (glasses)
    ↓ WiFi (WebSocket or HTTP POST)
Phone hotspot OR local WiFi
    ↓
Your server (laptop / EC2 / any VPS)
    ├── Receives raw audio chunks (PCM 16kHz 16-bit mono)
    ├── Saves to S3 bucket as .wav files
    ├── Sends to Whisper/Deepgram/Google STT for transcription
    ├── Saves transcripts as .txt / .json
    └── (Later) Updates soul.md on OpenClaw
```

**server.js — minimal audio receiver:**
```javascript
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// HTTP health check
app.get('/', (req, res) => res.send('Soliloquy server running'));

// WebSocket server for real-time audio streaming
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('Glasses connected');
  const timestamp = Date.now();
  const audioPath = path.join(__dirname, 'recordings', `${timestamp}.raw`);
  const stream = fs.createWriteStream(audioPath);

  ws.on('message', (data) => {
    // data = raw PCM audio bytes from ESP32
    stream.write(data);
  });

  ws.on('close', () => {
    stream.end();
    console.log(`Saved recording: ${audioPath}`);
    // TODO: Send to Whisper API for transcription
    // TODO: Save transcript to S3
    // TODO: Update soul.md
  });
});

app.listen(PORT, () => console.log(`HTTP on :${PORT}, WebSocket on :8080`));
```

```bash
mkdir recordings
node server.js
```

### 0.2 — Set up AWS S3 bucket (for transcript storage)

```bash
aws s3 mb s3://soliloquy-transcripts
```

Or use any storage — this can be a local folder for now. Don't over-engineer storage before you have audio flowing.

### 0.3 — Swap battery connectors (do this now, practice soldering)

Your EEMB batteries have **JST PH 2.0** plugs. The Waveshare board needs **MX1.25**.

1. Take an MX1.25 2-pin pigtail from your 60-pair kit
2. Cut the JST PH 2.0 connector off the battery (leave ~2cm of wire)
3. Strip both ends ~3mm
4. Solder red-to-red, black-to-black
5. Heat shrink each joint separately, then heat shrink over both together
6. **VERIFY POLARITY WITH MULTIMETER** before connecting to any board

Do this for 2-3 batteries now. Good soldering practice.

### 0.4 — Dry-fit the glasses

1. Take one pair of glasses + one neoprene strap
2. Lay the 300mm FFC cable along the temple arm — does 12" reach from the back of your head to the front of the frame? Mark where the camera would sit
3. Test folding the glasses with the cable routed — where does it crease? That's where you need the service loop
4. Figure out how the neoprene pouch will hold the boards + battery. The Waveshare audio board is roughly credit-card sized. The PCM5102A is half that. Battery is about the size of a large thumb drive

---

## PHASE 1: AUDIO STREAMING (The core product — do this FIRST)

**Parts needed:** Waveshare ESP32-S3-AUDIO-Board, battery (with MX1.25), WiFi access

The Waveshare board has **dual onboard MEMS microphones** connected to an ES7210 ADC. Your Phase 1 goal is: mic → ESP32 → WiFi → your server → saved audio files.

### 1.1 — Flash the Waveshare board

**Install ESP-IDF (Espressif's official framework):**
```bash
# On your dev machine (Mac/Linux/WSL)
mkdir -p ~/esp
cd ~/esp
git clone -b v5.4.1 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32s3
source export.sh
```

**Or use Arduino IDE** (simpler but less control):
1. Install Arduino IDE 2.x
2. Add ESP32 board URL: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
3. Install ESP32 boards package (v3.0.2+)
4. Select board: "ESP32S3 Dev Module"
5. Settings: USB CDC On Boot → Enabled, PSRAM → OPI PSRAM, Flash Size → 16MB

### 1.2 — Test the onboard mics (hello world)

**Arduino sketch — mic test (record to Serial):**
```cpp
#include <driver/i2s.h>

// ES7210 ADC is connected to I2S0 on the Waveshare board
// Check Waveshare wiki for exact pin assignments
#define I2S_NUM         I2S_NUM_0
#define I2S_SAMPLE_RATE 16000
#define I2S_BITS        16

// Pin definitions - CHECK WAVESHARE WIKI FOR YOUR BOARD REV
#define I2S_BCK_PIN     9
#define I2S_WS_PIN      10
#define I2S_DIN_PIN     11

void setup() {
  Serial.begin(115200);

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = false,
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_DIN_PIN,
  };

  i2s_driver_install(I2S_NUM, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_NUM, &pin_config);

  Serial.println("Mic test - speak into the board");
}

void loop() {
  int16_t samples[512];
  size_t bytes_read;

  i2s_read(I2S_NUM, samples, sizeof(samples), &bytes_read, portMAX_DELAY);

  // Print RMS level to see if mic is picking up audio
  int32_t sum = 0;
  int count = bytes_read / 2;
  for (int i = 0; i < count; i++) {
    sum += abs(samples[i]);
  }
  int avg = sum / count;
  Serial.println(avg); // Should spike when you speak

  delay(100);
}
```

Flash this, open Serial Monitor at 115200 baud. Speak near the board. You should see numbers spike. If they stay flat, check the Waveshare wiki for correct I2S pin assignments — they may differ from the example above.

### 1.3 — Stream audio over WiFi (WebSocket)

**This is the core product loop.** ESP32 captures audio from onboard mics and streams it over WiFi to your server in real-time.

```cpp
#include <WiFi.h>
#include <WebSocketsClient.h> // Install: ArduinoWebSockets by Links2004
#include <driver/i2s.h>

const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* SERVER_IP = "192.168.1.XXX"; // Your server's local IP
const int SERVER_PORT = 8080;

WebSocketsClient webSocket;

// I2S config for onboard mics - VERIFY PINS WITH WAVESHARE WIKI
#define I2S_BCK   9
#define I2S_WS    10
#define I2S_DIN   11
#define SAMPLE_RATE 16000

void setupI2S() {
  i2s_config_t config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = false,
  };

  i2s_pin_config_t pins = {
    .bck_io_num = I2S_BCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_DIN,
  };

  i2s_driver_install(I2S_NUM_0, &config, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
}

void setup() {
  Serial.begin(115200);

  // Connect WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());

  // Connect WebSocket
  webSocket.begin(SERVER_IP, SERVER_PORT, "/");
  webSocket.onEvent([](WStype_t type, uint8_t* payload, size_t length) {
    if (type == WStype_CONNECTED) Serial.println("WS connected");
    if (type == WStype_DISCONNECTED) Serial.println("WS disconnected");
  });

  setupI2S();
  Serial.println("Streaming audio...");
}

void loop() {
  webSocket.loop();

  // Read audio from mics
  uint8_t buffer[2048];
  size_t bytes_read;
  i2s_read(I2S_NUM_0, buffer, sizeof(buffer), &bytes_read, portMAX_DELAY);

  // Stream raw PCM to server
  if (webSocket.isConnected() && bytes_read > 0) {
    webSocket.sendBIN(buffer, bytes_read);
  }
}
```

**Test this:**
1. Flash to the Waveshare board
2. Start your server (`node server.js`)
3. Power the board (USB-C or battery)
4. Check server logs — you should see "Glasses connected"
5. Speak near the board
6. Check the `recordings/` folder — you should see a `.raw` file growing
7. Play it back: `ffplay -f s16le -ar 16000 -ac 1 recordings/XXXXX.raw`

**If you hear your voice, Phase 1 is DONE.** You have a working mic → WiFi → server pipeline.

### 1.4 — Add transcription

Once audio is flowing, pipe it through Whisper:

```javascript
// Add to server.js after saving the .raw file
const { execSync } = require('child_process');

function transcribe(rawPath) {
  // Convert raw PCM to WAV
  const wavPath = rawPath.replace('.raw', '.wav');
  execSync(`ffmpeg -f s16le -ar 16000 -ac 1 -i ${rawPath} ${wavPath}`);

  // Option A: OpenAI Whisper API
  // Option B: Local whisper.cpp
  // Option C: Deepgram API (real-time, best for streaming)

  // Example with whisper.cpp (install separately):
  const result = execSync(`whisper-cpp -m models/ggml-base.en.bin -f ${wavPath} -otxt`);
  const transcript = fs.readFileSync(wavPath.replace('.wav', '.txt'), 'utf8');

  console.log('Transcript:', transcript);

  // Save transcript
  const transcriptPath = rawPath.replace('.raw', '.transcript.txt');
  fs.writeFileSync(transcriptPath, transcript);

  // TODO: Upload to S3
  // TODO: Update soul.md on OpenClaw

  return transcript;
}
```

---

## PHASE 2: CAMERA (On-demand photos)

**Parts needed:** OV5640 + 300mm FFC cable (connected to Waveshare board DVP connector)

### 2.1 — Connect OV5640 to the board

1. Open the DVP connector latch on the Waveshare board (flip up the black tab gently)
2. Insert the FFC cable — contacts facing the correct side (check the connector orientation)
3. Close the latch
4. Connect the other end to the OV5640 module the same way
5. The camera should now be connected via a 30cm ribbon cable

### 2.2 — Test camera capture

```cpp
#include "esp_camera.h"
#include <WiFi.h>

// OV5640 DVP pins for Waveshare ESP32-S3-AUDIO-Board
// CHECK WAVESHARE WIKI - these pins are board-specific
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  40
#define SIOD_GPIO_NUM  17
#define SIOC_GPIO_NUM  18

#define Y9_GPIO_NUM    39
#define Y8_GPIO_NUM    41
#define Y7_GPIO_NUM    42
#define Y6_GPIO_NUM    12
#define Y5_GPIO_NUM    3
#define Y4_GPIO_NUM    14
#define Y3_GPIO_NUM    47
#define Y2_GPIO_NUM    13
#define VSYNC_GPIO_NUM 21
#define HREF_GPIO_NUM  38
#define PCLK_GPIO_NUM  11

// NOTE: These pin numbers are EXAMPLES. You MUST check the
// Waveshare ESP32-S3-AUDIO-Board wiki/schematic for actual DVP pins.

void setupCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA; // Start small, increase later
  config.jpeg_quality = 12;
  config.fb_count = 2;
  config.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return;
  }
  Serial.println("Camera initialized");
}

void captureAndUpload() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Capture failed");
    return;
  }

  Serial.printf("Captured %d bytes JPEG\n", fb->len);

  // Upload via HTTP POST to your server
  // (Add WiFi + HTTPClient code here)

  esp_camera_fb_return(fb);
}
```

### 2.3 — Add button trigger

Wire a tactile button between a free GPIO pin and GND. In firmware:

```cpp
#define BUTTON_PIN 4 // Pick a free GPIO

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
}

void loop() {
  if (digitalRead(BUTTON_PIN) == LOW) {
    captureAndUpload();
    delay(500); // Debounce
  }
}
```

---

## PHASE 3: AUDIO PLAYBACK (Responses through earbuds)

**Parts needed:** PCM5102A DAC board + Skullcandy Jib earbuds

### 3.1 — Wire PCM5102A to ESP32

Solder 5 wires from the PCM5102A board to the Waveshare board's GPIO headers:

| PCM5102A Pin | Connect to | Notes |
|---|---|---|
| VCC | 3.3V | Power |
| GND | GND | Ground |
| BCK | Free GPIO (e.g. 5) | Bit clock |
| LCK (LRCK) | Free GPIO (e.g. 6) | Left/Right clock |
| DIN | Free GPIO (e.g. 7) | Audio data |

**⚠️ Check which GPIOs are free** — the DVP camera and onboard codec already use many pins. Consult the Waveshare schematic.

### 3.2 — Test audio playback

```cpp
#include <driver/i2s.h>

#define I2S_OUT_NUM     I2S_NUM_1  // Use I2S1 (I2S0 is for onboard codec)
#define I2S_OUT_BCK     5
#define I2S_OUT_WS      6
#define I2S_OUT_DOUT    7
#define OUT_SAMPLE_RATE 44100

void setupI2SOutput() {
  i2s_config_t config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = OUT_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = false,
  };

  i2s_pin_config_t pins = {
    .bck_io_num = I2S_OUT_BCK,
    .ws_io_num = I2S_OUT_WS,
    .data_out_num = I2S_OUT_DOUT,
    .data_in_num = I2S_PIN_NO_CHANGE,
  };

  i2s_driver_install(I2S_OUT_NUM, &config, 0, NULL);
  i2s_set_pin(I2S_OUT_NUM, &pins);
}

// Generate a test tone
void playTestTone() {
  int16_t samples[512];
  for (int i = 0; i < 256; i++) {
    int16_t val = (int16_t)(10000 * sin(2 * PI * 440 * i / OUT_SAMPLE_RATE));
    samples[i * 2] = val;     // Left
    samples[i * 2 + 1] = val; // Right
  }

  size_t bytes_written;
  i2s_write(I2S_OUT_NUM, samples, sizeof(samples), &bytes_written, portMAX_DELAY);
}
```

Plug Skullcandy Jibs into the PCM5102A's 3.5mm jack. If you hear a 440Hz tone, Phase 3 works.

---

## PHASE 4: PHYSICAL BUILD (Mount everything on glasses)

### 4.1 — Mount the camera

1. Hot-glue the OV5640 module to the **top-center of the glasses bridge** (between the lenses) or the **front of one temple arm** near the hinge
2. Lens faces forward. The FPC connector exits downward/backward
3. Use a tiny dab of hot glue — you'll want to adjust position

### 4.2 — Route the FPC cable

1. Run the ribbon cable along the **outside of the temple arm** (the side facing away from your head)
2. Secure with **electrical tape** first (easy to reposition), upgrade to **VHB tape** once the route is final
3. At the **hinge**: create a 1.5-2cm service loop so the glasses can fold without creasing the cable
4. Cable continues down the temple arm to the **neoprene strap**

### 4.3 — Build the neoprene pouch

1. Cut a slit in the neoprene strap near one end (where it'll sit behind your head)
2. Insert: Waveshare board + PCM5102A + battery
3. The FPC cable enters the pouch and connects to the Waveshare board's DVP connector
4. The 3.5mm jack from the PCM5102A should be accessible (poking out of the pouch or on a short pigtail)
5. USB-C port on the Waveshare board should be accessible for charging
6. Earbuds plug into the PCM5102A jack and route down to your ears

### 4.4 — Wire the button + haptic motor

1. Solder a tactile button with two 28AWG wires (10-15cm)
2. Mount button on the **temple arm** with hot glue — easy thumb reach
3. Wire vibration motor similarly — mount near the temple for haptic feedback
4. Route wires along temple arm to pouch (under electrical tape)

---

## PHASE 5: OPENCLAW INTEGRATION

### 5.1 — soul.md auto-updater

Once transcripts are flowing, write a cron job or hook that:

1. Takes the day's transcripts
2. Summarizes them (LLM call — key topics, decisions, things mentioned)
3. Appends/updates `soul.md` on your OpenClaw instance

```javascript
// pseudo-code for the soul.md update loop
async function updateSoulMd(dailyTranscripts) {
  const summary = await llm.summarize(dailyTranscripts);

  // Format for soul.md
  const entry = `\n## ${new Date().toISOString().split('T')[0]}\n${summary}\n`;

  // Append to soul.md via OpenClaw API or direct file write
  await openclaw.appendToSoul(entry);
}
```

### 5.2 — OpenClaw gateway integration

Your server can expose an OpenClaw-compatible endpoint so the glasses become a "skill":

```javascript
// OpenClaw skill endpoint
app.post('/v1/glasses/capture', async (req, res) => {
  // Trigger photo capture via MQTT/WebSocket to glasses
  // Return the image + transcript context
});
```

---

## 📋 SCORECARD (from your conference notes)

**The game:** Build super cheap smart glasses that accomplish a different feature set than Meta smart glasses, targeting OpenClaw enthusiasts.

**Success metrics (objective):**

| Metric | Target | How to measure |
|--------|--------|----------------|
| Audio streaming uptime | >4 hrs continuous on 1100mAh | Time from full charge to dead |
| Audio-to-transcript latency | <10 seconds | Timestamp delta |
| Transcript accuracy | >85% WER on casual speech | Compare 100 sentences |
| Photo capture-to-server | <3 seconds | Timestamp delta |
| BOM cost per unit | <$50 (excl. tools) | Sum of per-unit parts |
| GitHub stars | 1000+ in first month | GitHub |
| Waitlist signups | 500+ | soliloquytech.dev form |

**User test protocol:**
1. Give someone the glasses
2. Have them wear it for 2 hours doing normal tasks (walking, talking, studying)
3. At the end, show them their transcript + soul.md summary
4. Ask: "Did it capture what mattered? What did it miss?"
5. **Log what you didn't anticipate** → next version

---

## 🔧 CRITICAL FIRST STEP (when Waveshare board arrives)

**Day 1 with the board — the 30-minute smoke test:**

1. Plug in USB-C (no battery yet)
2. Open Arduino IDE, select ESP32S3 Dev Module
3. Flash the mic test sketch from Phase 1.2
4. Open Serial Monitor — speak — see numbers spike
5. If yes → you're golden, proceed to Phase 1.3 (WiFi streaming)
6. If no → check Waveshare wiki for correct I2S pin assignments, re-flash

**Don't touch the glasses, camera, or anything physical until audio streaming to your server works on a desk.** ONE THING WELL.
