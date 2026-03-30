/*
 * Soliloquy — Unified Audio + Camera Streamer
 *
 * Board: Waveshare ESP32-S3-AUDIO-Board
 * Compile: esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi,FlashSize=16M
 *
 * Camera uses the SHARED I2C bus (GPIO 11/10) with SCCB pins set to -1.
 * TCA9555 EXIO5=LOW enables camera power. EXIO6=HIGH routes GPIO19/20 to camera.
 * Camera data pins do NOT conflict with I2S (GPIO 15 is not used by camera).
 *
 * Protocol: WebSocket binary prefix byte: 0x01=audio, 0x02=photo
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <Wire.h>
#include <driver/i2s.h>
#include "esp_camera.h"
#include "wifi_provision.h"

WebSocketsClient webSocket;
bool wsConnected = false;

// === I2C Pins (shared: ES7210 + TCA9555 + camera SCCB) ===
#define I2C_SDA_PIN     11
#define I2C_SCL_PIN     10

// === I2S Pins (audio input — ES7210 mic) ===
#define I2S_MCLK_PIN    12
#define I2S_BCK_PIN     13
#define I2S_WS_PIN      14
#define I2S_DIN_PIN     15

// === I2S Pins (audio output — PCM5102A DAC) ===
#define DAC_BCK_PIN     5
#define DAC_DIN_PIN     6
#define DAC_LCK_PIN     7
#define DAC_I2S_NUM     I2S_NUM_1

// === Camera DVP Pins (from official Waveshare Camera_Driver.h) ===
#define CAM_PIN_XCLK    43
#define CAM_PIN_PCLK    44
#define CAM_PIN_VSYNC   21
#define CAM_PIN_HREF     1
#define CAM_PIN_Y2       2    // D0
#define CAM_PIN_Y3      17    // D1
#define CAM_PIN_Y4      18    // D2
#define CAM_PIN_Y5      39    // D3
#define CAM_PIN_Y6      45    // D4
#define CAM_PIN_Y7      46    // D5
#define CAM_PIN_Y8      47    // D6
#define CAM_PIN_Y9      48    // D7

// === TCA9555 GPIO Expander ===
#define TCA9555_ADDR    0x20
#define TCA9555_OUTPUT0 0x02
#define TCA9555_CONFIG0 0x06
// Official Waveshare demo:
//   EXIO5 LOW  = Camera_EN()   (power on)
//   EXIO5 HIGH = Camera_DIS()  (power off)
//   EXIO6 HIGH = Camera_Set_GPIOA() (route Tx/Rx pins for camera)
//   EXIO6 LOW  = Camera_Set_GPIOB() (route USB DN/DP pins for camera)

// === Other ===
#define BUTTON_PIN       0
#define DEBOUNCE_MS    500
#define I2S_NUM         I2S_NUM_0
#define SAMPLE_RATE     16000
#define ES7210_ADDR     0x40
#define MSG_AUDIO       0x01
#define MSG_PHOTO       0x02
#define MSG_STATS       0x04
#define MSG_PLAYBACK    0x05

volatile bool captureRequested = false;
unsigned long lastButtonPress = 0;
unsigned long lastStatsSent = 0;
bool audioRunning = false;
bool cameraReady = false;
bool dacRunning = false;

// ============================================================
// ES7210 Registers
// ============================================================
#define ES7210_RESET_REG00           0x00
#define ES7210_MAINCLK_REG02         0x02
#define ES7210_LRCK_DIVH_REG04       0x04
#define ES7210_LRCK_DIVL_REG05       0x05
#define ES7210_POWER_DOWN_REG06      0x06
#define ES7210_OSR_REG07             0x07
#define ES7210_TIME_CONTROL0_REG09   0x09
#define ES7210_TIME_CONTROL1_REG0A   0x0A
#define ES7210_SDP_INTERFACE1_REG11  0x11
#define ES7210_SDP_INTERFACE2_REG12  0x12
#define ES7210_ADC34_HPF2_REG20      0x20
#define ES7210_ADC34_HPF1_REG21      0x21
#define ES7210_ADC12_HPF2_REG22      0x22
#define ES7210_ADC12_HPF1_REG23      0x23
#define ES7210_ANALOG_REG40          0x40
#define ES7210_MIC12_BIAS_REG41      0x41
#define ES7210_MIC34_BIAS_REG42      0x42
#define ES7210_MIC1_GAIN_REG43       0x43
#define ES7210_MIC2_GAIN_REG44       0x44
#define ES7210_MIC3_GAIN_REG45       0x45
#define ES7210_MIC4_GAIN_REG46       0x46
#define ES7210_MIC1_POWER_REG47      0x47
#define ES7210_MIC2_POWER_REG48      0x48
#define ES7210_MIC3_POWER_REG49      0x49
#define ES7210_MIC4_POWER_REG4A      0x4A
#define ES7210_MIC12_POWER_REG4B     0x4B
#define ES7210_MIC34_POWER_REG4C     0x4C
#define MIC_GAIN_30DB  0x0C
#define MIC_BIAS_2V87  0x77

// ============================================================
// TCA9555 helpers
// ============================================================
void tca9555_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(TCA9555_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
  delay(5);
}
uint8_t tca9555_read(uint8_t reg) {
  Wire.beginTransmission(TCA9555_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)TCA9555_ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xFF;
}

// Match official Waveshare Camera_Driver.cpp exactly
void enableCamera() {
  Wire.beginTransmission(TCA9555_ADDR);
  if (Wire.endTransmission() != 0) {
    Serial.println("TCA9555 not found");
    return;
  }

  uint8_t config0 = tca9555_read(TCA9555_CONFIG0);
  uint8_t output0 = tca9555_read(TCA9555_OUTPUT0);
  Serial.printf("TCA9555 Before: Config0=0x%02X Output0=0x%02X\n", config0, output0);

  // EXIO5,6 as outputs
  config0 &= ~((1 << 5) | (1 << 6));
  tca9555_write(TCA9555_CONFIG0, config0);

  // Camera_Set_GPIOA: EXIO6 = HIGH (route Tx/Rx pins to camera)
  output0 |= (1 << 6);
  tca9555_write(TCA9555_OUTPUT0, output0);
  delay(50);

  // Camera_EN: EXIO5 = LOW (power on)
  output0 &= ~(1 << 5);
  tca9555_write(TCA9555_OUTPUT0, output0);
  delay(50);

  Serial.printf("TCA9555 After:  Output0=0x%02X (EXIO5=LOW/pwr, EXIO6=HIGH/route)\n", output0);
}

// ============================================================
// ES7210 init
// ============================================================
void es7210_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ES7210_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
  delay(5);
}

bool initES7210() {
  Wire.beginTransmission(ES7210_ADDR);
  if (Wire.endTransmission() != 0) return false;

  es7210_write(ES7210_RESET_REG00, 0xFF); delay(20);
  es7210_write(ES7210_RESET_REG00, 0x32); delay(20);
  es7210_write(ES7210_TIME_CONTROL0_REG09, 0x30);
  es7210_write(ES7210_TIME_CONTROL1_REG0A, 0x30);
  es7210_write(ES7210_ADC12_HPF1_REG23, 0x2A);
  es7210_write(ES7210_ADC12_HPF2_REG22, 0x0A);
  es7210_write(ES7210_ADC34_HPF1_REG21, 0x2A);
  es7210_write(ES7210_ADC34_HPF2_REG20, 0x0A);
  es7210_write(ES7210_SDP_INTERFACE1_REG11, 0x60);
  es7210_write(ES7210_SDP_INTERFACE2_REG12, 0x00);
  es7210_write(ES7210_ANALOG_REG40, 0xC3);
  es7210_write(ES7210_MIC12_BIAS_REG41, MIC_BIAS_2V87);
  es7210_write(ES7210_MIC34_BIAS_REG42, MIC_BIAS_2V87);
  es7210_write(ES7210_MIC1_GAIN_REG43, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC2_GAIN_REG44, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC3_GAIN_REG45, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC4_GAIN_REG46, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC1_POWER_REG47, 0x08);
  es7210_write(ES7210_MIC2_POWER_REG48, 0x08);
  es7210_write(ES7210_MIC3_POWER_REG49, 0x08);
  es7210_write(ES7210_MIC4_POWER_REG4A, 0x08);
  es7210_write(ES7210_OSR_REG07, 0x20);
  es7210_write(ES7210_MAINCLK_REG02, 0xC1);
  es7210_write(ES7210_LRCK_DIVH_REG04, 0x01);
  es7210_write(ES7210_LRCK_DIVL_REG05, 0x00);
  es7210_write(ES7210_POWER_DOWN_REG06, 0x04);
  es7210_write(ES7210_MIC12_POWER_REG4B, 0x0F);
  es7210_write(ES7210_MIC34_POWER_REG4C, 0x0F);
  es7210_write(ES7210_RESET_REG00, 0x71);
  es7210_write(ES7210_RESET_REG00, 0x41);
  Serial.println("ES7210 ready");
  return true;
}

// ============================================================
// I2S Audio
// ============================================================
bool startAudio() {
  i2s_config_t config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = true,
  };
  i2s_pin_config_t pins = {
    .mck_io_num = I2S_MCLK_PIN,
    .bck_io_num = I2S_BCK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_DIN_PIN,
  };
  if (i2s_driver_install(I2S_NUM, &config, 0, NULL) != ESP_OK) return false;
  if (i2s_set_pin(I2S_NUM, &pins) != ESP_OK) return false;
  delay(50);
  initES7210();
  audioRunning = true;
  Serial.println("🎤 Audio started");
  return true;
}

void stopAudio() {
  if (!audioRunning) return;
  i2s_driver_uninstall(I2S_NUM);
  audioRunning = false;
  Serial.println("🎤 Audio paused");
}

// ============================================================
// DAC Output (I2S1 TX — PCM5102A)
// ============================================================
bool startDAC() {
  if (dacRunning) return true;

  i2s_config_t config = {};
  config.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = 256;
  config.use_apll = false;
  config.tx_desc_auto_clear = true;

  esp_err_t err = i2s_driver_install(DAC_I2S_NUM, &config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("❌ DAC install failed: 0x%x\n", err);
    return false;
  }

  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;  // PCM5102A uses internal PLL
  pins.bck_io_num = DAC_BCK_PIN;
  pins.ws_io_num = DAC_LCK_PIN;
  pins.data_out_num = DAC_DIN_PIN;
  pins.data_in_num = I2S_PIN_NO_CHANGE;

  err = i2s_set_pin(DAC_I2S_NUM, &pins);
  if (err != ESP_OK) {
    Serial.printf("❌ DAC pin config failed: 0x%x\n", err);
    return false;
  }

  i2s_zero_dma_buffer(DAC_I2S_NUM);
  dacRunning = true;
  Serial.println("🔊 DAC started (BCK=5, DIN=6, LCK=7)");
  return true;
}

// ============================================================
// Camera init — called once at startup, stays running
// With fb_count=2 + GRAB_LATEST, DVP stream is always managed
// ============================================================
bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_1;
  config.pin_d0 = CAM_PIN_Y2;
  config.pin_d1 = CAM_PIN_Y3;
  config.pin_d2 = CAM_PIN_Y4;
  config.pin_d3 = CAM_PIN_Y5;
  config.pin_d4 = CAM_PIN_Y6;
  config.pin_d5 = CAM_PIN_Y7;
  config.pin_d6 = CAM_PIN_Y8;
  config.pin_d7 = CAM_PIN_Y9;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_pclk = CAM_PIN_PCLK;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_sccb_sda = -1;
  config.pin_sccb_scl = -1;
  config.sccb_i2c_port = 0;
  config.pin_pwdn = -1;
  config.pin_reset = -1;
  config.xclk_freq_hz = 10000000;       // 10 MHz — slower clock = less DVP pressure
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_LATEST; // Always get newest frame (needs fb_count >= 2)
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;              // Good quality, ~50% smaller than quality 6
  config.fb_count = 2;                   // 2 buffers: DVP always has one to write to
  config.frame_size = FRAMESIZE_UXGA;    // 1600x1200

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    // Fallback to VGA
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    err = esp_camera_init(&config);
    if (err != ESP_OK) {
      Serial.printf("📷 Camera init failed: 0x%x\n", err);
      return false;
    }
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_hmirror(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, 1);
    s->set_sharpness(s, 2);
    s->set_denoise(s, 1);
  }
  Serial.println("📷 Camera initialized (UXGA, GRAB_LATEST)");
  return true;
}

// ============================================================
// Capture photo — instant grab from always-running camera
// GRAB_LATEST ensures we get the most recent frame immediately
// ============================================================
bool captureAndSendPhoto(uint8_t prefix = MSG_PHOTO) {
  if (!cameraReady) {
    Serial.println("📷 Camera not available");
    return false;
  }

  if (prefix == MSG_PHOTO) Serial.println("📷 Capturing...");
  unsigned long t0 = millis();

  // Grab latest frame — instant with GRAB_LATEST + fb_count=2
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("📷 Capture failed!");
    return false;
  }

  Serial.printf("📷 Got %d bytes JPEG (%dx%d)\n", fb->len, fb->width, fb->height);

  if (wsConnected && fb->len > 0) {
    size_t msgLen = 1 + fb->len;
    uint8_t* msg = (uint8_t*)ps_malloc(msgLen);
    if (msg) {
      msg[0] = prefix;
      memcpy(msg + 1, fb->buf, fb->len);
      webSocket.sendBIN(msg, msgLen);
      free(msg);
      Serial.printf("📷 Sent %d bytes\n", fb->len);
    }
  }

  esp_camera_fb_return(fb);

  if (prefix == MSG_PHOTO) Serial.printf("📷 Done in %lums\n", millis() - t0);
  return true;
}

// ============================================================
// Button & WebSocket
// ============================================================
void IRAM_ATTR onButtonPress() {
  unsigned long now = millis();
  if (now - lastButtonPress > DEBOUNCE_MS) {
    captureRequested = true;
    lastButtonPress = now;
  }
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("✅ WebSocket connected");
      wsConnected = true; break;
    case WStype_DISCONNECTED:
      Serial.println("❌ WebSocket disconnected");
      wsConnected = false; break;
    case WStype_TEXT:
      // Server sends "CAPTURE" when it hears "picture" / "photo"
      if (strstr((char*)payload, "CAPTURE") != NULL) {
        Serial.println("📡 Voice trigger: CAPTURE");
        captureRequested = true;
      }
      break;
    case WStype_BIN:
      // Server sends audio playback data with 0x05 prefix
      if (length > 1 && payload[0] == MSG_PLAYBACK && dacRunning) {
        size_t audioLen = length - 1;
        uint8_t* audioData = payload + 1;
        // Write PCM data to DAC (stereo: duplicate mono to both channels)
        // Input is mono 16-bit PCM, output needs stereo for I2S
        int16_t* monoSamples = (int16_t*)audioData;
        int monoCount = audioLen / 2;
        // Use PSRAM for stereo buffer if available
        int16_t* stereoBuf = (int16_t*)ps_malloc(monoCount * 4);
        if (stereoBuf) {
          for (int i = 0; i < monoCount; i++) {
            stereoBuf[i * 2]     = monoSamples[i];  // Left
            stereoBuf[i * 2 + 1] = monoSamples[i];  // Right
          }
          size_t bytes_written;
          i2s_write(DAC_I2S_NUM, stereoBuf, monoCount * 4, &bytes_written, portMAX_DELAY);
          free(stereoBuf);
        }
      }
      break;
    default: break;
  }
}

// ============================================================
// Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  delay(3000);

  Serial.println("\n==============================");
  Serial.println("  Soliloquy — Audio + Camera");
  Serial.println("==============================");
  Serial.printf("PSRAM: %s (%d bytes)\n", psramFound() ? "YES" : "NO", ESP.getFreePsram());


  // 2. I2C bus (shared: ES7210 + TCA9555 + camera SCCB)
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  // 3. Enable camera power via TCA9555, then init camera (stays running)
  enableCamera();
  cameraReady = initCamera();  // Camera stays initialized — captures are instant

  // 5. Start audio (mic input)
  startAudio();

  // 6. Start DAC (audio output to PCM5102A headphones)
  startDAC();

  // 7. Button
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButtonPress, FALLING);

  // 6. WiFi (provisioning: NVS credentials or captive-portal AP)
  wifiProvisionBegin();

  // 7. WebSocket
  Serial.printf("Connecting to server: ws://%s:%d\n", getServerIP(), getServerPort());
  webSocket.begin(getServerIP(), getServerPort(), "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);

  Serial.printf("🎤 Streaming... %s\n\n",
    cameraReady ? "say 'picture' or press BOOT to capture." : "(camera unavailable)");
}

// ============================================================
// Device stats reporting
// ============================================================
void sendDeviceStats() {
  if (!wsConnected) return;
  char json[256];
  float temp = temperatureRead();  // ESP32 internal temp sensor
  int rssi = WiFi.RSSI();
  snprintf(json, sizeof(json),
    "{\"heap\":\"%dK\",\"psram\":\"%dK\",\"rssi\":\"%d\",\"temp\":\"%.0fC\",\"uptime\":\"%lus\"}",
    ESP.getFreeHeap() / 1024,
    ESP.getFreePsram() / 1024,
    rssi,
    temp,
    millis() / 1000
  );
  size_t len = strlen(json);
  uint8_t* msg = (uint8_t*)malloc(1 + len);
  if (msg) {
    msg[0] = MSG_STATS;
    memcpy(msg + 1, json, len);
    webSocket.sendBIN(msg, 1 + len);
    free(msg);
  }
}

// ============================================================
// Loop
// ============================================================
static int16_t stereo_buf[1024];
static int16_t mono_buf[512];
static uint8_t send_buf[1025];
static unsigned long lastCameraWarmup = 0;

void loop() {
  webSocket.loop();

  if (captureRequested) {
    captureRequested = false;
    captureAndSendPhoto();
  }

  // Send device stats every 5 seconds
  if (millis() - lastStatsSent > 5000) {
    lastStatsSent = millis();
    sendDeviceStats();
  }

  if (!audioRunning) return;

  size_t bytes_read;
  i2s_read(I2S_NUM, stereo_buf, sizeof(stereo_buf), &bytes_read, portMAX_DELAY);

  int mono_count = 0;
  for (int i = 0; i < (int)(bytes_read / 2); i += 2)
    mono_buf[mono_count++] = stereo_buf[i];

  if (wsConnected && mono_count > 0) {
    size_t pcm_bytes = mono_count * 2;
    send_buf[0] = MSG_AUDIO;
    memcpy(send_buf + 1, mono_buf, pcm_bytes);
    webSocket.sendBIN(send_buf, pcm_bytes + 1);
  }
}
