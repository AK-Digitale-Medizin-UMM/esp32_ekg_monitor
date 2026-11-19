/*
 * EKG-Sender für ESP32
 * Liest das Analogsignal (z. B. AD8232) mit fester Abtastrate, sammelt
 * SAMPLES_PER_PACKET Werte und schickt sie per HTTP POST an den Server.
 *
 * Verkabelung (Beispiel AD8232 direkt am ESP32):
 *   OUTPUT -> GPIO 34 (ADC1, nur Eingang)   LO+ -> GPIO 32   LO- -> GPIO 33
 *   3.3V   -> 3.3V                          GND -> GND
 * Falls Matteos Modul am Arduino hängt: statt analogRead() die Werte über
 * Serial2 vom Arduino einlesen – der Rest bleibt gleich.
 *
 * ACHTUNG Sicherheit: Während der Messung nur mit Akku/Powerbank betreiben,
 * nicht am Netzteil oder an einem Laptop, der am Stromnetz hängt.
 */
#include <WiFi.h>
#include <HTTPClient.h>

// ---- Konfiguration -------------------------------------------------------
const char* WIFI_SSID = "DEIN_WLAN";
const char* WIFI_PASS = "DEIN_PASSWORT";
const char* SERVER_URL = "http://192.168.0.10:8000/api/v1/ingest";  // IP des Laptops
const char* DEVICE_ID = "esp32-01";

const int   PIN_ECG = 34;
const int   PIN_LO_PLUS = 32;
const int   PIN_LO_MINUS = 33;
const int   FS_HZ = 250;               // Abtastrate
const int   SAMPLES_PER_PACKET = 25;   // -> 10 Pakete pro Sekunde
// --------------------------------------------------------------------------

const uint32_t PERIOD_US = 1000000UL / FS_HZ;
uint16_t buf[2][SAMPLES_PER_PACKET];   // Doppelpuffer
uint32_t t0[2];
volatile int fillIdx = 0, fillPos = 0;
int readyIdx = -1;
bool leadOff = false;
uint32_t seq = 0, nextSampleUs = 0;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("WLAN");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\nverbunden, IP %s\n", WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_LO_PLUS, INPUT);
  pinMode(PIN_LO_MINUS, INPUT);
  analogReadResolution(12);
  connectWifi();
  nextSampleUs = micros();
}

void sampleIfDue() {
  uint32_t now = micros();
  if ((int32_t)(now - nextSampleUs) < 0) return;
  nextSampleUs += PERIOD_US;
  if (fillPos == 0) t0[fillIdx] = now;
  buf[fillIdx][fillPos++] = analogRead(PIN_ECG);
  leadOff = digitalRead(PIN_LO_PLUS) || digitalRead(PIN_LO_MINUS);
  if (fillPos >= SAMPLES_PER_PACKET) {
    readyIdx = fillIdx;
    fillIdx ^= 1;
    fillPos = 0;
  }
}

void sendPacket(int idx) {
  // JSON von Hand bauen – spart eine Bibliothek und RAM
  String json;
  json.reserve(64 + SAMPLES_PER_PACKET * 6);
  json += "{\"v\":1,\"device_id\":\""; json += DEVICE_ID;
  json += "\",\"seq\":"; json += seq++;
  json += ",\"fs\":"; json += FS_HZ;
  json += ",\"t0_us\":"; json += t0[idx];
  json += ",\"unit\":\"adc_raw\",\"adc_bits\":12,\"lead_off\":"; json += leadOff ? "true" : "false";
  json += ",\"samples\":[";
  for (int i = 0; i < SAMPLES_PER_PACKET; i++) {
    if (i) json += ',';
    json += buf[idx][i];
  }
  json += "]}";

  HTTPClient http;
  http.setReuse(true);
  http.setTimeout(500);
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);
  if (code != 202) Serial.printf("POST fehlgeschlagen: %d\n", code);
  http.end();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  sampleIfDue();
  if (readyIdx >= 0) {
    int idx = readyIdx;
    readyIdx = -1;
    sendPacket(idx);   // blockiert kurz – für saubere Abtastung später Sampling in einen Timer/Task verlagern
  }
}
