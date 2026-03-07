/*
 * OpenGlass2 — WiFi Audio Streaming (Phase 1.3)
 *
 * Streams raw PCM audio from onboard MEMS mics over WiFi
 * to the Soliloquy server via WebSocket.
 *
 * Board: Waveshare ESP32-S3-AUDIO-Board
 * Compile with: esp32:esp32:esp32s3:CDCOnBoot=cdc
 *
 * VERIFIED pin mapping (from Waveshare official Arduino demo):
 *   I2C SDA   = GPIO11  (ES7210 + ES8311 control)
 *   I2C SCL   = GPIO10
 *   I2S MCLK  = GPIO12  (master clock)
 *   I2S BCLK  = GPIO13  (bit clock)
 *   I2S LRCLK = GPIO14  (word select)
 *   I2S DSIN  = GPIO15  (data IN from ES7210 mics → ESP32)
 *
 * Required library: WebSockets by Links2004
 *   Install via: arduino-cli lib install "WebSockets"
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <Wire.h>
#include <driver/i2s.h>

// ============================================================
// ⚠️  CONFIGURE THESE BEFORE FLASHING
// ============================================================
const char* WIFI_SSID   = "103";
const char* WIFI_PASS   = "YOUR_PASSWORD";     // ← PUT YOUR WIFI PASSWORD HERE
const char* SERVER_IP   = "10.0.0.28";
const int   SERVER_PORT = 8080;
// ============================================================

WebSocketsClient webSocket;
bool wsConnected = false;

// === I2C Pins ===
#define I2C_SDA_PIN     11
#define I2C_SCL_PIN     10

// === I2S Pins (VERIFIED from Waveshare official demo) ===
#define I2S_MCLK_PIN    12
#define I2S_BCK_PIN     13
#define I2S_WS_PIN      14
#define I2S_DIN_PIN     15   // GPIO15 — CORRECTED (was wrongly GPIO42)

// === Config ===
#define I2S_NUM         I2S_NUM_0
#define SAMPLE_RATE     16000
#define ES7210_ADDR     0x40

// === Status LED ===
#define LED_PIN 2

// ============================================================
// ES7210 Register Addresses (from Waveshare official library)
// ============================================================
#define ES7210_RESET_REG00           0x00
#define ES7210_CLOCK_OFF_REG01       0x01
#define ES7210_MAINCLK_REG02         0x02
#define ES7210_MASTER_CLK_REG03      0x03
#define ES7210_LRCK_DIVH_REG04       0x04
#define ES7210_LRCK_DIVL_REG05       0x05
#define ES7210_POWER_DOWN_REG06      0x06
#define ES7210_OSR_REG07             0x07
#define ES7210_MODE_CONFIG_REG08     0x08
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

void es7210_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ES7210_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
  delay(5);
}

void initES7210() {
  Wire.beginTransmission(ES7210_ADDR);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    Serial.printf("ES7210 NOT FOUND (err=%d)\n", err);
    return;
  }
  Serial.println("ES7210 found — initializing...");

  // Init sequence from Waveshare es7210_config_codec()
  es7210_write(ES7210_RESET_REG00, 0xFF);
  delay(20);
  es7210_write(ES7210_RESET_REG00, 0x32);
  delay(20);
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
  // Clock coefficients for 16kHz @ MCLK=4,096,000
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
}

void setupI2S() {
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

  esp_err_t err = i2s_driver_install(I2S_NUM, &config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("I2S install failed: 0x%x\n", err);
  }
  err = i2s_set_pin(I2S_NUM, &pins);
  if (err != ESP_OK) {
    Serial.printf("I2S set pin failed: 0x%x\n", err);
  }
  Serial.println("I2S initialized");
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("✅ WebSocket connected to server");
      wsConnected = true;
      digitalWrite(LED_PIN, HIGH);
      break;
    case WStype_DISCONNECTED:
      Serial.println("❌ WebSocket disconnected — will reconnect");
      wsConnected = false;
      digitalWrite(LED_PIN, LOW);
      break;
    case WStype_TEXT:
      Serial.printf("Server says: %s\n", payload);
      break;
    case WStype_ERROR:
      Serial.println("WebSocket error");
      wsConnected = false;
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("");
  Serial.println("=== OpenGlass2 WiFi Audio Streamer ===");
  Serial.println("");

  // 1. Init I2C
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  // 2. Init I2S FIRST (generates MCLK for ES7210)
  setupI2S();
  delay(100);

  // 3. Init ES7210 ADC (needs MCLK running)
  initES7210();

  // 4. Connect to WiFi
  Serial.printf("Connecting to WiFi: %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    attempts++;
    if (attempts > 30) {
      Serial.println("\n⚠️  WiFi connection failed after 15 seconds!");
      Serial.println("Check SSID and password, then reset the board.");
      while (true) { delay(1000); }
    }
  }
  Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());

  // 5. Connect WebSocket to server
  Serial.printf("Connecting to server: ws://%s:%d\n", SERVER_IP, SERVER_PORT);
  webSocket.begin(SERVER_IP, SERVER_PORT, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(3000);

  Serial.println("Streaming audio... speak near the board.");
  Serial.println("");
}

// Static buffers to avoid stack overflow (default loop stack is only 8KB)
static int16_t stereo_buf[1024];  // 2KB — stereo samples from I2S
static int16_t mono_buf[512];     // 1KB — extracted left channel

void loop() {
  webSocket.loop();

  // Read stereo audio from I2S (L,R,L,R...)
  size_t bytes_read;
  i2s_read(I2S_NUM, stereo_buf, sizeof(stereo_buf), &bytes_read, portMAX_DELAY);

  // Extract left channel only for mono streaming (every other sample)
  int num_stereo_samples = bytes_read / 2;
  int mono_count = 0;
  for (int i = 0; i < num_stereo_samples; i += 2) {
    mono_buf[mono_count++] = stereo_buf[i];  // Left channel
  }

  // Stream raw mono PCM to server
  if (wsConnected && mono_count > 0) {
    webSocket.sendBIN((uint8_t*)mono_buf, mono_count * 2);
  }
}
