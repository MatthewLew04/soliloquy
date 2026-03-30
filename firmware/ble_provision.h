/*
 * ble_provision.h — WiFi Provisioning for Soliloquy
 *
 * Uses Espressif's official WiFiProv library + their free phone app:
 *   iOS:     "ESP BLE Provisioning" on App Store
 *   Android: "ESP BLE Provisioning" on Play Store
 *
 * Boot flow:
 *   1. If already provisioned → auto-connects via saved NVS credentials
 *   2. If not provisioned → starts BLE as "Soliloquy_XXXX"
 *   3. Open ESP BLE Prov app → scan → select device → pick WiFi → done
 *   4. Credentials saved to NVS, persists across reboots
 *
 * Server IP is stored separately in NVS (Preferences) and can be
 * updated later if needed.
 *
 * Usage in your .ino:
 *   #include "../ble_provision.h"
 *   // In setup():
 *   connectWiFiOrProvision();
 *   // Then use: bleConfig.serverIP, bleConfig.serverPort
 */

#ifndef BLE_PROVISION_H
#define BLE_PROVISION_H

#include "WiFiProv.h"
#include <WiFi.h>
#include <Preferences.h>
#include "nvs_flash.h"

// ============================================================
// Config struct — server IP/port (WiFi creds handled by WiFiProv)
// ============================================================
struct BLEProvConfig {
  char serverIP[64]  = "10.0.0.28";
  int  serverPort    = 8080;
};

static BLEProvConfig bleConfig;
static Preferences   prefs;
static volatile bool wifiConnected   = false;
static volatile bool provFailed      = false;

// ============================================================
// Load server IP from NVS (WiFi creds managed by WiFiProv/NVS)
// ============================================================
static void loadServerConfig() {
  prefs.begin("server", true);
  String server = prefs.getString("ip", "10.0.0.28");
  int    port   = prefs.getInt("port", 8080);
  prefs.end();

  strncpy(bleConfig.serverIP, server.c_str(), sizeof(bleConfig.serverIP) - 1);
  bleConfig.serverPort = port;
}

// ============================================================
// Save server IP to NVS
// ============================================================
static void saveServerConfig() {
  prefs.begin("server", false);
  prefs.putString("ip", bleConfig.serverIP);
  prefs.putInt("port", bleConfig.serverPort);
  prefs.end();
}

// ============================================================
// Provisioning event handler (called from FreeRTOS task)
// ============================================================
void SysProvEvent(arduino_event_t *sys_event) {
  switch (sys_event->event_id) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.printf("\n✅ WiFi connected! IP: %s\n",
        IPAddress(sys_event->event_info.got_ip.ip_info.ip.addr).toString().c_str());
      wifiConnected = true;
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("📡 WiFi disconnected, reconnecting...");
      wifiConnected = false;
      break;

    case ARDUINO_EVENT_PROV_START:
      Serial.println("\n� Provisioning started!");
      Serial.println("   Open 'ESP BLE Provisioning' app on your phone");
      Serial.println("   Scan → select device → pick WiFi network → enter password");
      break;

    case ARDUINO_EVENT_PROV_CRED_RECV:
      Serial.printf("\n� Received WiFi credentials\n");
      Serial.printf("   SSID: %s\n", (const char *)sys_event->event_info.prov_cred_recv.ssid);
      Serial.println("   Password: ****");
      break;

    case ARDUINO_EVENT_PROV_CRED_FAIL:
      Serial.println("\n⚠️  Provisioning failed!");
      if (sys_event->event_info.prov_fail_reason == NETWORK_PROV_WIFI_STA_AUTH_ERROR) {
        Serial.println("   Wrong WiFi password");
      } else {
        Serial.println("   WiFi network not found");
      }
      provFailed = true;
      break;

    case ARDUINO_EVENT_PROV_CRED_SUCCESS:
      Serial.println("✅ Provisioning successful — credentials saved!");
      break;

    case ARDUINO_EVENT_PROV_END:
      Serial.println("🔵 Provisioning ended");
      break;

    default: break;
  }
}

// ============================================================
// Main entry point — call from setup()
//
// WiFiProv handles everything:
//   - If previously provisioned → auto-connects with saved creds
//   - If not → starts BLE provisioning and waits for phone app
//   - Credentials persist in NVS across reboots
// ============================================================
static void connectWiFiOrProvision() {
  // Load server config from NVS
  loadServerConfig();
  Serial.printf("📡 Server target: %s:%d\n", bleConfig.serverIP, bleConfig.serverPort);

  // Register event handler
  WiFi.onEvent(SysProvEvent);

  // Start WiFi (will use saved NVS credentials if available)
  WiFi.begin();

  // Proof of possession PIN — user enters this in the app
  const char *pop = "soliloquy";
  const char *service_name = "PROV_Soliloquy";

  // Start BLE provisioning
  // If already provisioned, this returns quickly and WiFi connects from NVS
  // If not provisioned, BLE advertises and waits for the phone app
  uint8_t uuid[16] = {0xb4, 0xdf, 0x5a, 0x1c, 0x3f, 0x6b, 0xf4, 0xbf,
                      0xea, 0x4a, 0x82, 0x03, 0x04, 0x90, 0x1a, 0x02};

  WiFiProv.beginProvision(
    NETWORK_PROV_SCHEME_BLE,
    NETWORK_PROV_SCHEME_HANDLER_FREE_BLE,
    NETWORK_PROV_SECURITY_1,
    pop,
    service_name,
    NULL,   // no SoftAP password
    uuid,
    false   // don't reset provisioned data
  );

  Serial.println("⏳ Waiting for WiFi connection...");

  // Wait until WiFi connects (either from saved creds or new provisioning)
  int dots = 0;
  while (!wifiConnected) {
    delay(500);
    Serial.print(".");
    dots++;
    if (dots % 60 == 0) Serial.println();

    // If provisioning failed, reboot to retry
    if (provFailed) {
      Serial.println("\n🔄 Rebooting to retry provisioning...");
      delay(1000);
      ESP.restart();
    }
  }

  Serial.println("");
}

// ============================================================
// Optional: Clear saved WiFi credentials (forces re-provisioning)
// ============================================================
static void clearSavedCredentials() {
  nvs_flash_erase();
  nvs_flash_init();
  Serial.println("🗑️  Saved WiFi credentials cleared — reboot to re-provision");
}

#endif // BLE_PROVISION_H
