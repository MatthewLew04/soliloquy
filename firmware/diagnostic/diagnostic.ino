/*
 * OpenGlass2 — Board Diagnostic
 * 
 * Simple sketch to:
 * 1. Verify serial communication works
 * 2. Scan I2C bus for all connected devices
 * 3. Identify ES7210, ES8311, TCA9555, PCF85063 addresses
 * 
 * This helps debug why the mic test isn't producing output.
 */

#include <Wire.h>

// Try the documented I2C pins first
// The Waveshare board may use different I2C pins
#define I2C_SDA_PIN  1
#define I2C_SCL_PIN  2

void setup() {
  Serial.begin(115200);
  
  // Wait for serial connection (important for USB CDC)
  while (!Serial) {
    delay(10);
  }
  delay(1000);
  
  Serial.println("");
  Serial.println("========================================");
  Serial.println("  OpenGlass2 Board Diagnostic");
  Serial.println("  Waveshare ESP32-S3-AUDIO-Board");
  Serial.println("========================================");
  Serial.println("");
  
  // Print chip info
  Serial.printf("Chip model: %s\n", ESP.getChipModel());
  Serial.printf("Chip revision: %d\n", ESP.getChipRevision());
  Serial.printf("CPU freq: %d MHz\n", ESP.getCpuFreqMHz());
  Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
  Serial.printf("PSRAM size: %d bytes\n", ESP.getPsramSize());
  Serial.printf("Flash size: %d bytes\n", ESP.getFlashChipSize());
  Serial.println("");
  
  // Scan I2C on pins 1, 2
  Serial.printf("=== I2C Scan on SDA=%d, SCL=%d ===\n", I2C_SDA_PIN, I2C_SCL_PIN);
  scanI2C(I2C_SDA_PIN, I2C_SCL_PIN);
  
  // Also try common alternative I2C pins
  int altPins[][2] = {{8, 9}, {17, 18}, {41, 42}, {47, 48}, {38, 39}};
  for (int i = 0; i < 5; i++) {
    Serial.printf("\n=== I2C Scan on SDA=%d, SCL=%d ===\n", altPins[i][0], altPins[i][1]);
    scanI2C(altPins[i][0], altPins[i][1]);
  }
  
  Serial.println("");
  Serial.println("========================================");
  Serial.println("  Diagnostic complete!");
  Serial.println("========================================");
}

void scanI2C(int sda, int scl) {
  Wire.begin(sda, scl);
  int deviceCount = 0;
  
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    uint8_t error = Wire.endTransmission();
    
    if (error == 0) {
      Serial.printf("  Found device at 0x%02X", addr);
      
      // Identify known devices
      if (addr == 0x40) Serial.print(" (ES7210 ADC)");
      if (addr == 0x18) Serial.print(" (ES8311 codec)");
      if (addr == 0x20 || addr == 0x21) Serial.printf(" (TCA9555 GPIO expander)");
      if (addr == 0x51) Serial.print(" (PCF85063 RTC)");
      
      Serial.println("");
      deviceCount++;
    }
  }
  
  if (deviceCount == 0) {
    Serial.println("  No I2C devices found on these pins.");
  } else {
    Serial.printf("  Total: %d device(s)\n", deviceCount);
  }
  
  Wire.end();
}

void loop() {
  // Blink onboard LED to show we're alive
  delay(5000);
  Serial.printf("Still running... Free heap: %d\n", ESP.getFreeHeap());
}
