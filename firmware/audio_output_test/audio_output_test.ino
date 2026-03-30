/*
 * Soliloquy — Audio Output Test (PCM5102A DAC)
 *
 * Board: Waveshare ESP32-S3-AUDIO-Board
 * Compile: esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi,FlashSize=16M
 *
 * PCM5102A wiring:
 *   BCK → IO5   (bit clock)
 *   DIN → IO6   (audio data)
 *   LCK → IO7   (L/R word select)
 *   SCK → GND   (internal PLL, no MCLK needed)
 *   VIN → 3V3   (power)
 *   GND → GND   (ground)
 *
 * Two modes (toggle with BOOT button):
 *   Mode 1: Sine wave 440 Hz  — verifies DAC wiring
 *   Mode 2: Mic passthrough   — ES7210 mic → DAC headphones
 */

#include <Wire.h>
#include <driver/i2s.h>
#include <math.h>

// ============================================================
// Pin Definitions
// ============================================================

// PCM5102A DAC (I2S1 — output)
#define DAC_BCK_PIN     5
#define DAC_DIN_PIN     6
#define DAC_LCK_PIN     7
#define DAC_I2S_NUM     I2S_NUM_1

// ES7210 Mic (I2S0 — input, same as main firmware)
#define MIC_MCLK_PIN    12
#define MIC_BCK_PIN     13
#define MIC_WS_PIN      14
#define MIC_DIN_PIN     15
#define MIC_I2S_NUM     I2S_NUM_0

// I2C (shared bus)
#define I2C_SDA_PIN     11
#define I2C_SCL_PIN     10

// Button
#define BUTTON_PIN      0
#define DEBOUNCE_MS     500

// ES7210
#define ES7210_ADDR     0x40

// ============================================================
// Globals
// ============================================================
enum Mode { MODE_SINE, MODE_MIC };
volatile Mode currentMode = MODE_SINE;
volatile bool modeChangeRequested = false;
unsigned long lastButtonPress = 0;
bool micRunning = false;
bool dacRunning = false;

// Sine wave parameters
#define SINE_FREQ       440.0f
#define SAMPLE_RATE     16000
#define SINE_AMPLITUDE  24000   // ~73% of int16_t max — nice and loud
float sinePhase = 0.0f;
float sinePhaseInc = (2.0f * M_PI * SINE_FREQ) / SAMPLE_RATE;

// ============================================================
// ES7210 Init (reused from main firmware)
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
  if (Wire.endTransmission() != 0) {
    Serial.println("ES7210 not found on I2C!");
    return false;
  }

  es7210_write(0x00, 0xFF); delay(20);  // Reset
  es7210_write(0x00, 0x32); delay(20);
  es7210_write(0x09, 0x30);
  es7210_write(0x0A, 0x30);
  es7210_write(0x23, 0x2A);
  es7210_write(0x22, 0x0A);
  es7210_write(0x21, 0x2A);
  es7210_write(0x20, 0x0A);
  es7210_write(0x11, 0x60);
  es7210_write(0x12, 0x00);
  es7210_write(0x40, 0xC3);
  es7210_write(0x41, 0x77);
  es7210_write(0x42, 0x77);
  es7210_write(0x43, 0x1C);
  es7210_write(0x44, 0x1C);
  es7210_write(0x45, 0x1C);
  es7210_write(0x46, 0x1C);
  es7210_write(0x47, 0x08);
  es7210_write(0x48, 0x08);
  es7210_write(0x49, 0x08);
  es7210_write(0x4A, 0x08);
  es7210_write(0x07, 0x20);
  es7210_write(0x02, 0xC1);
  es7210_write(0x04, 0x01);
  es7210_write(0x05, 0x00);
  es7210_write(0x06, 0x04);
  es7210_write(0x4B, 0x0F);
  es7210_write(0x4C, 0x0F);
  es7210_write(0x00, 0x71);
  es7210_write(0x00, 0x41);

  Serial.println("  ✅ ES7210 initialized");
  return true;
}

// ============================================================
// DAC Output (I2S1 TX)
// ============================================================
bool startDAC() {
  if (dacRunning) {
    i2s_driver_uninstall(DAC_I2S_NUM);
    dacRunning = false;
    delay(50);
  }

  i2s_config_t config = {};
  config.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = 256;
  config.use_apll = false;    // Don't use APLL for I2S1
  config.tx_desc_auto_clear = true;  // Auto-clear TX descriptor on underflow

  esp_err_t err = i2s_driver_install(DAC_I2S_NUM, &config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("  ❌ DAC i2s_driver_install failed: 0x%x\n", err);
    return false;
  }
  Serial.println("  ✓ i2s_driver_install OK");

  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;   // No MCLK — PCM5102A uses internal PLL
  pins.bck_io_num = DAC_BCK_PIN;
  pins.ws_io_num = DAC_LCK_PIN;
  pins.data_out_num = DAC_DIN_PIN;
  pins.data_in_num = I2S_PIN_NO_CHANGE;

  err = i2s_set_pin(DAC_I2S_NUM, &pins);
  if (err != ESP_OK) {
    Serial.printf("  ❌ DAC i2s_set_pin failed: 0x%x\n", err);
    return false;
  }
  Serial.println("  ✓ i2s_set_pin OK");

  // Clear DMA buffers
  i2s_zero_dma_buffer(DAC_I2S_NUM);

  dacRunning = true;
  Serial.printf("  🔊 DAC running @ %d Hz on BCK=%d, DIN=%d, LCK=%d\n",
    SAMPLE_RATE, DAC_BCK_PIN, DAC_DIN_PIN, DAC_LCK_PIN);
  return true;
}

// ============================================================
// Mic Input (I2S0 RX)
// ============================================================
bool startMic() {
  if (micRunning) return true;

  i2s_config_t config = {};
  config.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = 256;
  config.use_apll = true;

  i2s_pin_config_t pins = {};
  pins.mck_io_num = MIC_MCLK_PIN;
  pins.bck_io_num = MIC_BCK_PIN;
  pins.ws_io_num = MIC_WS_PIN;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_DIN_PIN;

  esp_err_t err = i2s_driver_install(MIC_I2S_NUM, &config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("  ❌ Mic i2s_driver_install failed: 0x%x\n", err);
    return false;
  }

  err = i2s_set_pin(MIC_I2S_NUM, &pins);
  if (err != ESP_OK) {
    Serial.printf("  ❌ Mic i2s_set_pin failed: 0x%x\n", err);
    return false;
  }

  delay(50);
  initES7210();
  micRunning = true;
  Serial.println("  🎤 Mic running");
  return true;
}

void stopMic() {
  if (!micRunning) return;
  i2s_driver_uninstall(MIC_I2S_NUM);
  micRunning = false;
  Serial.println("  🎤 Mic stopped");
}

// ============================================================
// Button ISR
// ============================================================
void IRAM_ATTR onButtonPress() {
  unsigned long now = millis();
  if (now - lastButtonPress > DEBOUNCE_MS) {
    modeChangeRequested = true;
    lastButtonPress = now;
  }
}

// ============================================================
// Mode switching
// ============================================================
void switchToSine() {
  Serial.println("\n--- Switching to SINE WAVE mode ---");
  stopMic();
  startDAC();
  sinePhase = 0.0f;
  currentMode = MODE_SINE;
  Serial.println("🎵 Mode: SINE WAVE (440 Hz)");
  Serial.println("   Plug headphones into PCM5102A jack — you should hear a tone!");
}

void switchToMic() {
  Serial.println("\n--- Switching to MIC PASSTHROUGH mode ---");
  startDAC();
  startMic();
  currentMode = MODE_MIC;
  Serial.println("🎤 Mode: MIC PASSTHROUGH");
  Serial.println("   Speak near the board — hear yourself in headphones!");
}

// ============================================================
// Sine wave generation
// ============================================================
static int16_t sineBuf[512];  // 256 stereo sample pairs

void generateAndPlaySine() {
  for (int i = 0; i < 256; i++) {
    int16_t sample = (int16_t)(SINE_AMPLITUDE * sinf(sinePhase));
    sineBuf[i * 2]     = sample;  // Left
    sineBuf[i * 2 + 1] = sample;  // Right
    sinePhase += sinePhaseInc;
    if (sinePhase >= 2.0f * M_PI) sinePhase -= 2.0f * M_PI;
  }

  size_t bytes_written = 0;
  esp_err_t err = i2s_write(DAC_I2S_NUM, sineBuf, sizeof(sineBuf), &bytes_written, 1000 / portTICK_PERIOD_MS);

  // Print debug info once per second
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug > 1000) {
    lastDebug = millis();
    Serial.printf("  [sine] wrote %d bytes (err=0x%x)\n", bytes_written, err);
  }
}

// ============================================================
// Mic passthrough
// ============================================================
static int16_t micStereo[512];
static int16_t passthruBuf[512];

void micPassthrough() {
  size_t bytes_read = 0;
  i2s_read(MIC_I2S_NUM, micStereo, sizeof(micStereo), &bytes_read, 1000 / portTICK_PERIOD_MS);

  int samples = bytes_read / 2;
  int mono_count = samples / 2;

  for (int i = 0; i < mono_count; i++) {
    int16_t sample = micStereo[i * 2];  // Left channel
    passthruBuf[i * 2]     = sample;
    passthruBuf[i * 2 + 1] = sample;
  }

  size_t bytes_written = 0;
  i2s_write(DAC_I2S_NUM, passthruBuf, mono_count * 4, &bytes_written, 1000 / portTICK_PERIOD_MS);

  // Print debug info once per second
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug > 1000) {
    lastDebug = millis();
    // Show a sample value to verify mic is picking up audio
    int16_t peakVal = 0;
    for (int i = 0; i < mono_count; i++) {
      int16_t v = abs(micStereo[i * 2]);
      if (v > peakVal) peakVal = v;
    }
    Serial.printf("  [mic] read=%d wrote=%d peak=%d\n", bytes_read, bytes_written, peakVal);
  }
}

// ============================================================
// Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(3000);

  Serial.println("\n==========================================");
  Serial.println("  Soliloquy — Audio Output Test (PCM5102A)");
  Serial.println("==========================================");
  Serial.printf("PSRAM: %s (%d bytes)\n", psramFound() ? "YES" : "NO", ESP.getFreePsram());
  Serial.printf("Chip model: %s, cores: %d\n", ESP.getChipModel(), ESP.getChipCores());
  Serial.println();
  Serial.println("Wiring: BCK→IO5, DIN→IO6, LCK→IO7, SCK→GND");
  Serial.println("Press BOOT button to toggle SINE ↔ MIC modes");
  Serial.println();

  // I2C bus (needed for ES7210 mic codec)
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Serial.println("  ✓ I2C started");

  // Button
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButtonPress, FALLING);
  Serial.println("  ✓ Button ready");

  // Start in sine wave mode
  switchToSine();
}

// ============================================================
// Loop
// ============================================================
void loop() {
  if (modeChangeRequested) {
    modeChangeRequested = false;
    if (currentMode == MODE_SINE) {
      switchToMic();
    } else {
      switchToSine();
    }
  }

  if (currentMode == MODE_SINE) {
    generateAndPlaySine();
  } else {
    micPassthrough();
  }
}
