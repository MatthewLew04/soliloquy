# Soliloquy — AI Smart Glasses

## Project Overview
Real-time audio/video capture and transcription platform for Waveshare ESP32-S3-AUDIO smart glasses. Features live dashboard, voice emotion analysis, Gemini conversation summaries, and OpenClaw integration.

## Architecture
- **Firmware** (`firmware/camera_stream/`): Arduino C++ for ESP32-S3. Streams audio (I2S), captures photos (OV5640), reports device stats over WebSocket.
- **Server** (`server/`): Node.js + Express. Receives WebSocket data, transcribes via Deepgram, analyzes emotions via Python worker, generates Gemini summaries, serves real-time dashboard.
- **Dashboard** (`server/dashboard.html`): Single-page HTML app with SSE-powered live transcript, emotion badges, photo gallery, device health, and Gemini summaries.

## Key Commands
```bash
# Start server
cd server && node server.js

# Start emotion worker (separate terminal)
cd server && source emotion_venv/bin/activate && python emotion_worker.py

# Compile firmware (PartitionScheme=huge_app required for BLE provisioning)
arduino-cli compile --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi,FlashSize=16M,PartitionScheme=huge_app firmware/camera_stream/camera_stream.ino

# Flash firmware
arduino-cli upload --fqbn esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi,FlashSize=16M,PartitionScheme=huge_app -p /dev/cu.usbmodem2101 firmware/camera_stream/camera_stream.ino
```

## WiFi Provisioning (BLE)
WiFi credentials are configured via BLE, not hardcoded. On first boot (or when saved WiFi fails), the board advertises as **"Soliloquy"** via BLE.
1. Open **nRF Connect** (iOS/Android) → scan → connect to "Soliloquy"
2. Write SSID, password, and server IP (`IP:PORT` format) to the 3 characteristics
3. Credentials are saved to flash and persist across reboots

## WebSocket Protocol
Binary messages with prefix byte:
- `0x01` — Audio (16kHz 16-bit PCM mono)
- `0x02` — Photo (JPEG)
- `0x04` — Device stats (JSON: heap, psram, rssi, temp, uptime)

Text messages: `CAPTURE` command (server → ESP32)

## Environment Variables (server/.env)
- `DEEPGRAM_API_KEY` — Deepgram transcription
- `GEMINI_API_KEY` — Gemini conversation summaries

## API Endpoints
- `GET /dashboard` — Real-time dashboard
- `GET /events` — SSE stream (transcript, emotion, photo, stats, device, summary, disconnect)
- `GET /api/vision` — Trigger photo capture, returns JPEG
- `GET /api/context` — Current session state + emotions
- `GET /api/sessions` — List past sessions
- `POST /api/end-session` — End active session

## Hardware
- Board: Waveshare ESP32-S3-AUDIO
- Camera: OV5640 (DVP interface via TCA9555 GPIO expander)
- Mic: ES7210 quad-channel codec (I2S0: MCLK=12, BCK=13, WS=14, DIN=15)
- DAC: PCM5102A breakout (I2S1: BCK=5, DIN=6, LCK=7, SCK→GND for internal PLL)
- I2C: SDA=11, SCL=10
