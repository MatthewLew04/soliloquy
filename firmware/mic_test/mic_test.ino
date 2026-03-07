/*
 * OpenGlass2 — Mic Smoke Test (Phase 1.2) — CORRECTED
 * 
 * Waveshare ESP32-S3-AUDIO-Board
 * ES7210 init ported directly from Waveshare official demo.
 * 
 * Compile with: esp32:esp32:esp32s3:CDCOnBoot=cdc
 * 
 * VERIFIED pin mapping (from Waveshare official Arduino demo):
 *   I2C SDA   = GPIO11  (ES7210 + ES8311 control)
 *   I2C SCL   = GPIO10
 *   I2S MCLK  = GPIO12  (master clock)
 *   I2S BCLK  = GPIO13  (bit clock / SCLK)
 *   I2S LRCLK = GPIO14  (word select / LCLK)
 *   I2S DSIN  = GPIO15  (data IN from ES7210 mics → ESP32)
 *   I2S DOUT  = GPIO16  (data OUT from ESP32 → ES8311 speaker)
 */

#include <Wire.h>
#include <driver/i2s.h>

// === I2C Pins ===
#define I2C_SDA_PIN     11
#define I2C_SCL_PIN     10

// === I2S Pins (CORRECTED from Waveshare demo) ===
#define I2S_MCLK_PIN    12
#define I2S_BCK_PIN     13
#define I2S_WS_PIN      14
#define I2S_DIN_PIN     15   // *** GPIO15, NOT GPIO42 ***
#define I2S_DOUT_PIN    16   // Speaker out (not used here)

// === Config ===
#define I2S_NUM         I2S_NUM_0
#define SAMPLE_RATE     16000
#define MCLK_MULTIPLE   256   // MCLK = SAMPLE_RATE * 256 = 4,096,000 Hz
#define ES7210_ADDR     0x40

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

// ES7210 gain values
#define MIC_GAIN_30DB  0x0C    // 30dB gain (from official enum)
#define MIC_BIAS_2V87  0x77    // 2.87V mic bias

bool es7210_write(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(ES7210_ADDR);
  Wire.write(reg);
  Wire.write(val);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    Serial.printf("  I2C WRITE FAIL: reg=0x%02X val=0x%02X err=%d\n", reg, val, err);
    return false;
  }
  delay(5);
  return true;
}

uint8_t es7210_read(uint8_t reg) {
  Wire.beginTransmission(ES7210_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)ES7210_ADDR, (uint8_t)1);
  if (Wire.available()) return Wire.read();
  return 0xFF;
}

bool initES7210() {
  // Check if ES7210 is present
  Wire.beginTransmission(ES7210_ADDR);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    Serial.printf("ES7210 NOT FOUND at 0x%02X (I2C error %d)\n", ES7210_ADDR, err);
    return false;
  }
  Serial.println("ES7210 found on I2C bus!");

  // ============================================================
  // Init sequence ported EXACTLY from Waveshare es7210_config_codec()
  // ============================================================

  // 1. Software reset
  es7210_write(ES7210_RESET_REG00, 0xFF);
  delay(20);
  es7210_write(ES7210_RESET_REG00, 0x32);
  delay(20);

  // 2. Set initialization time when device powers up
  es7210_write(ES7210_TIME_CONTROL0_REG09, 0x30);
  es7210_write(ES7210_TIME_CONTROL1_REG0A, 0x30);

  // 3. Configure HPF for ADC1-4
  es7210_write(ES7210_ADC12_HPF1_REG23, 0x2A);
  es7210_write(ES7210_ADC12_HPF2_REG22, 0x0A);
  es7210_write(ES7210_ADC34_HPF1_REG21, 0x2A);
  es7210_write(ES7210_ADC34_HPF2_REG20, 0x0A);

  // 4. Set I2S format: 16-bit, I2S standard
  //    SDP_INTERFACE1: i2s_format(0x00) | bit_width_16(0x60) = 0x60
  es7210_write(ES7210_SDP_INTERFACE1_REG11, 0x60);
  //    SDP_INTERFACE2: TDM disabled = 0x00
  es7210_write(ES7210_SDP_INTERFACE2_REG12, 0x00);

  // 5. Configure analog power and VMID voltage
  es7210_write(ES7210_ANALOG_REG40, 0xC3);

  // 6. Set MIC1-4 bias to 2.87V
  es7210_write(ES7210_MIC12_BIAS_REG41, MIC_BIAS_2V87);
  es7210_write(ES7210_MIC34_BIAS_REG42, MIC_BIAS_2V87);

  // 7. Set MIC1-4 gain to 30dB (gain | 0x10)
  es7210_write(ES7210_MIC1_GAIN_REG43, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC2_GAIN_REG44, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC3_GAIN_REG45, MIC_GAIN_30DB | 0x10);
  es7210_write(ES7210_MIC4_GAIN_REG46, MIC_GAIN_30DB | 0x10);

  // 8. Power on MIC1-4
  es7210_write(ES7210_MIC1_POWER_REG47, 0x08);
  es7210_write(ES7210_MIC2_POWER_REG48, 0x08);
  es7210_write(ES7210_MIC3_POWER_REG49, 0x08);
  es7210_write(ES7210_MIC4_POWER_REG4A, 0x08);

  // 9. Set sample rate coefficients for 16kHz @ MCLK=4,096,000
  //    From coeff table: {4096000, 16000, 0x00, 0x01, 0x01, 0x01, 0x20, 0x00, 0x01, 0x00}
  //    OSR = 0x20
  es7210_write(ES7210_OSR_REG07, 0x20);
  //    MAINCLK: adc_div(0x01) | doubler(0x01 << 6) | dll(0x01 << 7) = 0x01 | 0x40 | 0x80 = 0xC1
  es7210_write(ES7210_MAINCLK_REG02, 0xC1);
  //    LRCK dividers
  es7210_write(ES7210_LRCK_DIVH_REG04, 0x01);
  es7210_write(ES7210_LRCK_DIVL_REG05, 0x00);

  // 10. Power down DLL
  es7210_write(ES7210_POWER_DOWN_REG06, 0x04);

  // 11. Power on MIC1-4 bias & ADC1-4 & PGA1-4 power
  es7210_write(ES7210_MIC12_POWER_REG4B, 0x0F);
  es7210_write(ES7210_MIC34_POWER_REG4C, 0x0F);

  // 12. Enable device (final step!)
  es7210_write(ES7210_RESET_REG00, 0x71);
  es7210_write(ES7210_RESET_REG00, 0x41);

  // Readback verification
  uint8_t id = es7210_read(ES7210_RESET_REG00);
  uint8_t gain1 = es7210_read(ES7210_MIC1_GAIN_REG43);
  uint8_t analog = es7210_read(ES7210_ANALOG_REG40);
  uint8_t pwr4b = es7210_read(ES7210_MIC12_POWER_REG4B);
  Serial.println("ES7210 Readback:");
  Serial.printf("  Reset/Enable reg: 0x%02X (expect 0x41)\n", id);
  Serial.printf("  MIC1 Gain:        0x%02X (expect 0x1C)\n", gain1);
  Serial.printf("  Analog Power:     0x%02X (expect 0xC3)\n", analog);
  Serial.printf("  MIC12 Power:      0x%02X (expect 0x0F)\n", pwr4b);

  return true;
}

bool setupI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 1024,
    .use_apll = true,   // *** ENABLE APLL for accurate MCLK generation ***
  };

  i2s_pin_config_t pin_config = {
    .mck_io_num = I2S_MCLK_PIN,
    .bck_io_num = I2S_BCK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_DIN_PIN,         // GPIO15 — CORRECTED
  };

  esp_err_t err = i2s_driver_install(I2S_NUM, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("I2S install FAILED: 0x%x\n", err);
    return false;
  }

  err = i2s_set_pin(I2S_NUM, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("I2S set pin FAILED: 0x%x\n", err);
    return false;
  }

  Serial.println("I2S initialized OK");
  Serial.printf("  MCLK pin: %d, BCK: %d, WS: %d, DIN: %d\n",
    I2S_MCLK_PIN, I2S_BCK_PIN, I2S_WS_PIN, I2S_DIN_PIN);
  return true;
}

void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }
  delay(2000);

  Serial.println("");
  Serial.println("========================================");
  Serial.println("  OpenGlass2 Mic Test — CORRECTED");
  Serial.println("========================================");
  Serial.printf("I2C: SDA=%d, SCL=%d\n", I2C_SDA_PIN, I2C_SCL_PIN);
  Serial.printf("I2S: MCLK=%d, BCK=%d, WS=%d, DIN=%d\n",
    I2S_MCLK_PIN, I2S_BCK_PIN, I2S_WS_PIN, I2S_DIN_PIN);
  Serial.println("");

  // Init I2C
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Serial.println("I2C bus started");

  // Init I2S FIRST (to generate MCLK before ES7210 needs it)
  Serial.println("Initializing I2S...");
  if (!setupI2S()) {
    Serial.println("FATAL: I2S setup failed");
    while (true) { delay(1000); }
  }
  delay(100);  // Let MCLK stabilize

  // Init ES7210 ADC (needs MCLK running)
  Serial.println("Initializing ES7210...");
  if (!initES7210()) {
    Serial.println("!!! ES7210 init FAILED !!!");
  } else {
    Serial.println("ES7210 init complete!");
  }

  Serial.println("");
  Serial.println("=== READING AUDIO ===");
  Serial.println("Format: L:avg  R:avg  | raw samples");
  Serial.println("Silent: ~50-200, Speaking: ~1000+");
  Serial.println("If all -1/0xFFFF: I2S data pin wrong or ES7210 not outputting");
  Serial.println("");
  delay(500);
}

void loop() {
  int16_t samples[512];
  size_t bytes_read;

  i2s_read(I2S_NUM, samples, sizeof(samples), &bytes_read, portMAX_DELAY);

  int num_samples = bytes_read / 2;

  int32_t left_sum = 0, right_sum = 0;
  int left_count = 0, right_count = 0;
  int16_t left_raw[4] = {0}, right_raw[4] = {0};

  for (int i = 0; i < num_samples; i++) {
    if (i % 2 == 0) {
      left_sum += abs(samples[i]);
      if (left_count < 4) left_raw[left_count] = samples[i];
      left_count++;
    } else {
      right_sum += abs(samples[i]);
      if (right_count < 4) right_raw[right_count] = samples[i];
      right_count++;
    }
  }

  int left_avg = (left_count > 0) ? left_sum / left_count : 0;
  int right_avg = (right_count > 0) ? right_sum / right_count : 0;

  Serial.printf("L:%5d  R:%5d  | raw L[%6d %6d %6d %6d] R[%6d %6d %6d %6d]\n",
    left_avg, right_avg,
    left_raw[0], left_raw[1], left_raw[2], left_raw[3],
    right_raw[0], right_raw[1], right_raw[2], right_raw[3]);

  delay(200);
}
