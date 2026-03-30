#pragma once
/*
 * wifi_provision.h — WiFi Provisioning for Soliloquy Smart Glasses
 *
 * Stores WiFi + server credentials in NVS. If no saved network exists
 * (or connection fails), launches a captive-portal AP so the user can
 * configure from their phone.  Exponential backoff prevents router
 * throttling on repeated failures.
 *
 * Usage in .ino:
 *   #include "wifi_provision.h"
 *   // in setup():
 *   wifiProvisionBegin();          // blocks until STA connected
 *   const char* ip   = getServerIP();
 *   int          port = getServerPort();
 */

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>

// ── Defaults (used if NVS is empty) ─────────────────────────
#define WP_DEFAULT_SSID        ""
#define WP_DEFAULT_PASS        ""
#define WP_DEFAULT_SERVER_IP   ""
#define WP_DEFAULT_SERVER_PORT 8080

// ── AP-mode settings ────────────────────────────────────────
#define WP_AP_SSID             "Soliloquy-Setup"
#define WP_AP_PASS             ""            // open network
#define WP_AP_IP               IPAddress(192, 168, 4, 1)
#define WP_DNS_PORT            53

// ── STA connection tuning ───────────────────────────────────
#define WP_CONNECT_TIMEOUT_MS  15000        // per attempt
#define WP_MAX_STA_ATTEMPTS    3            // before falling back to AP
#define WP_BACKOFF_BASE_MS     2000         // doubles each retry

// ── Stored values (populated after wifiProvisionBegin) ──────
static char _wp_ssid[64];
static char _wp_pass[64];
static char _wp_server_ip[64];
static int  _wp_server_port;

static Preferences _wp_prefs;
static WebServer   _wp_web(80);
static DNSServer   _wp_dns;
static bool        _wp_configured = false;

// ── Accessors ───────────────────────────────────────────────
const char* getWifiSSID()    { return _wp_ssid; }
const char* getWifiPass()    { return _wp_pass; }
const char* getServerIP()    { return _wp_server_ip; }
int         getServerPort()  { return _wp_server_port; }

// ── NVS helpers ─────────────────────────────────────────────
static void _wp_loadPrefs() {
  _wp_prefs.begin("wifi", true);  // read-only
  String s = _wp_prefs.getString("ssid", WP_DEFAULT_SSID);
  String p = _wp_prefs.getString("pass", WP_DEFAULT_PASS);
  String ip = _wp_prefs.getString("srv_ip", WP_DEFAULT_SERVER_IP);
  _wp_server_port = _wp_prefs.getInt("srv_port", WP_DEFAULT_SERVER_PORT);
  _wp_prefs.end();

  strlcpy(_wp_ssid, s.c_str(), sizeof(_wp_ssid));
  strlcpy(_wp_pass, p.c_str(), sizeof(_wp_pass));
  strlcpy(_wp_server_ip, ip.c_str(), sizeof(_wp_server_ip));
}

static void _wp_savePrefs() {
  _wp_prefs.begin("wifi", false);  // read-write
  _wp_prefs.putString("ssid", _wp_ssid);
  _wp_prefs.putString("pass", _wp_pass);
  _wp_prefs.putString("srv_ip", _wp_server_ip);
  _wp_prefs.putInt("srv_port", _wp_server_port);
  _wp_prefs.end();
  Serial.println("[WP] Credentials saved to NVS");
}

// ── Captive-portal HTML ─────────────────────────────────────
static const char _wp_html[] PROGMEM = R"rawhtml(
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Soliloquy WiFi Setup</title>
<style>
  body{font-family:sans-serif;max-width:400px;margin:40px auto;padding:0 16px;background:#111;color:#eee}
  h2{text-align:center;color:#6cf}
  input,select{width:100%;padding:10px;margin:6px 0 14px;border:1px solid #444;border-radius:6px;
    background:#222;color:#eee;box-sizing:border-box;font-size:15px}
  button{width:100%;padding:12px;background:#08f;color:#fff;border:none;border-radius:6px;
    font-size:16px;cursor:pointer}
  button:hover{background:#06c}
  .scan{font-size:13px;color:#888;margin-bottom:10px}
</style></head><body>
<h2>Soliloquy Setup</h2>
<div class="scan" id="scaninfo">Scanning networks...</div>
<form method="POST" action="/save">
  <label>WiFi Network</label>
  <select name="ssid" id="ssid"><option>scanning...</option></select>
  <label>WiFi Password</label>
  <input type="password" name="pass" placeholder="WiFi password">
  <label>Server IP</label>
  <input type="text" name="srv_ip" placeholder="e.g. 10.0.0.28">
  <label>Server Port</label>
  <input type="number" name="srv_port" value="8080">
  <button type="submit">Save &amp; Connect</button>
</form>
<script>
fetch('/scan').then(r=>r.json()).then(nets=>{
  var sel=document.getElementById('ssid');
  sel.innerHTML='';
  nets.forEach(n=>{
    var o=document.createElement('option');
    o.value=n.ssid; o.textContent=n.ssid+' ('+n.rssi+'dBm)';
    sel.appendChild(o);
  });
  document.getElementById('scaninfo').textContent=nets.length+' networks found';
}).catch(()=>{
  document.getElementById('scaninfo').textContent='Scan failed — type SSID manually';
  var sel=document.getElementById('ssid');
  sel.outerHTML='<input type="text" name="ssid" placeholder="Network name">';
});
</script>
</body></html>
)rawhtml";

// ── Web handlers ────────────────────────────────────────────
static void _wp_handleRoot() {
  _wp_web.send(200, "text/html", _wp_html);
}

static void _wp_handleScan() {
  int n = WiFi.scanNetworks();
  String json = "[";
  for (int i = 0; i < n; i++) {
    if (i) json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\",\"rssi\":" + String(WiFi.RSSI(i)) + "}";
  }
  json += "]";
  WiFi.scanDelete();
  _wp_web.send(200, "application/json", json);
}

static void _wp_handleSave() {
  String ssid = _wp_web.arg("ssid");
  String pass = _wp_web.arg("pass");
  String sip  = _wp_web.arg("srv_ip");
  String sport = _wp_web.arg("srv_port");

  if (ssid.length() == 0) {
    _wp_web.send(400, "text/html", "<h3>SSID required</h3><a href='/'>Back</a>");
    return;
  }

  strlcpy(_wp_ssid, ssid.c_str(), sizeof(_wp_ssid));
  strlcpy(_wp_pass, pass.c_str(), sizeof(_wp_pass));
  if (sip.length() > 0) strlcpy(_wp_server_ip, sip.c_str(), sizeof(_wp_server_ip));
  if (sport.length() > 0) _wp_server_port = sport.toInt();

  _wp_savePrefs();

  _wp_web.send(200, "text/html",
    "<h3 style='color:#6cf;text-align:center'>Saved! Connecting...</h3>"
    "<p style='text-align:center'>The glasses will restart. "
    "If connection fails, the setup portal will reappear.</p>");

  delay(1500);
  _wp_configured = true;
}

static void _wp_handleNotFound() {
  // Captive portal: redirect everything to root
  _wp_web.sendHeader("Location", "http://192.168.4.1/", true);
  _wp_web.send(302, "text/plain", "");
}

// ── AP mode (captive portal) ────────────────────────────────
static void _wp_startAP() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(WP_AP_IP, WP_AP_IP, IPAddress(255, 255, 255, 0));
  WiFi.softAP(WP_AP_SSID, WP_AP_PASS);

  _wp_dns.start(WP_DNS_PORT, "*", WP_AP_IP);

  _wp_web.on("/", _wp_handleRoot);
  _wp_web.on("/scan", _wp_handleScan);
  _wp_web.on("/save", HTTP_POST, _wp_handleSave);
  _wp_web.onNotFound(_wp_handleNotFound);
  _wp_web.begin();

  Serial.println("[WP] AP mode started");
  Serial.printf("[WP] Connect to WiFi '%s' and open http://192.168.4.1\n", WP_AP_SSID);
}

static void _wp_runAP() {
  _wp_configured = false;
  _wp_startAP();

  while (!_wp_configured) {
    _wp_dns.processNextRequest();
    _wp_web.handleClient();
    delay(2);
  }

  _wp_web.stop();
  _wp_dns.stop();
  WiFi.softAPdisconnect(true);
  delay(200);
}

// ── STA connection with exponential backoff ─────────────────
static bool _wp_connectSTA() {
  if (strlen(_wp_ssid) == 0) return false;

  WiFi.mode(WIFI_STA);
  unsigned long backoff = WP_BACKOFF_BASE_MS;

  for (int attempt = 1; attempt <= WP_MAX_STA_ATTEMPTS; attempt++) {
    Serial.printf("[WP] Connecting to '%s' (attempt %d/%d)...\n",
                  _wp_ssid, attempt, WP_MAX_STA_ATTEMPTS);

    WiFi.disconnect(true);
    delay(100);
    WiFi.begin(_wp_ssid, _wp_pass);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED &&
           (millis() - start) < WP_CONNECT_TIMEOUT_MS) {
      delay(250);
      Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[WP] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
      return true;
    }

    Serial.printf("[WP] Failed (status=%d). Backing off %lums...\n",
                  WiFi.status(), backoff);
    WiFi.disconnect(true);
    delay(backoff);
    backoff *= 2;  // exponential backoff
  }

  return false;
}

// ── Public API ──────────────────────────────────────────────

/*
 * Call from setup(). Blocks until WiFi is connected in STA mode.
 * If stored credentials fail (or none exist), starts AP captive portal.
 */
void wifiProvisionBegin() {
  _wp_loadPrefs();

  if (_wp_connectSTA()) return;

  // No valid credentials or connection failed — start captive portal
  Serial.println("[WP] Starting provisioning portal...");
  _wp_runAP();

  // User submitted new creds — try connecting
  if (!_wp_connectSTA()) {
    Serial.println("[WP] Still can't connect — restarting...");
    ESP.restart();
  }
}

/*
 * Call to clear saved credentials and restart into AP mode.
 * Useful for a "factory reset" button.
 */
void wifiProvisionReset() {
  _wp_prefs.begin("wifi", false);
  _wp_prefs.clear();
  _wp_prefs.end();
  Serial.println("[WP] Credentials cleared — restarting...");
  delay(500);
  ESP.restart();
}
