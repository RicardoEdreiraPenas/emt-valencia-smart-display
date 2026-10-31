#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>          // v7
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <time.h>
#include <XPT2046_Touchscreen.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <ESP_I2S.h>              // incluida en el core Arduino-ESP32 3.x

// --- CONFIGURACIÓN ---
// config.h  -> paradas y dirección del servidor (se puede publicar)
// secrets.h -> WiFi (copia secrets.example.h; está en .gitignore)
#include "config.h"
#include "secrets.h"
#include "certificados.h"         // raíces CA para HTTPS (opción B, Cloudflare)

// Clave del servidor en Cloudflare (opción B). En secrets.h; vacía en casa.
#ifndef API_KEY
#define API_KEY ""
#endif
const String serverRoot = SERVER_ROOT;
const String serverBase = serverRoot + "/api/parada/";

// --- AUDIO (MAX98357A) ---
#define I2S_BCLK 26
#define I2S_LRC  25
#define I2S_DOUT 22
float volumen = 0.6;              // 0.0 - 1.0 (volumen por software)

I2SClass i2s;
QueueHandle_t colaAudio;
String ultimoAvisoId = "";
String avisoTexto = "";
unsigned long avisoHasta = 0;
unsigned long lastAvisoCheck = 0;
unsigned long avisoDelay = 4000;           // consulta /api/aviso cada 4 s (10 s por HTTPS)
const unsigned long avisoBanner = 60000;   // banner verde durante 1 min

int paradas[] = {PARADAS};
int paradaActual = 0;
const int totalParadas = sizeof(paradas) / sizeof(paradas[0]);

#define TFT_CS   15
#define TFT_DC   2
#define TFT_RST  4
#define TOUCH_CS 21

// Mitad de la pantalla en coordenadas en bruto del táctil.
// Si al tocar la derecha retrocede, cambia TOUCH_INVERTIDO a true.
// Abre el Monitor Serie para ver las coordenadas reales al tocar.
const int  TOUCH_X_MITAD   = 2000;
const bool TOUCH_INVERTIDO = false;

Adafruit_ILI9341 tft = Adafruit_ILI9341(TFT_CS, TFT_DC, TFT_RST);
XPT2046_Touchscreen ts(TOUCH_CS);

// --- COLORES INTERFAZ ---
#define COLOR_BG         tft.color565(0, 0, 0)
#define COLOR_CARD       tft.color565(28, 28, 30)
#define COLOR_TEXT_DIM   tft.color565(142, 142, 147)
#define COLOR_ACCENT     tft.color565(10, 132, 255)
#define COLOR_RED        tft.color565(255, 69, 58)
#define COLOR_GREEN      tft.color565(48, 209, 88)
#define COLOR_ORANGE     tft.color565(255, 159, 10)
#define COLOR_BLUE_RAIN  tft.color565(90, 200, 250)
#define COLOR_SUN        tft.color565(255, 214, 10)
#define COLOR_CLOUD      tft.color565(199, 199, 204)
#define COLOR_CLOUD_DARK tft.color565(142, 142, 147)
#define COLOR_MOON       tft.color565(229, 229, 234)

// --- TEMPORIZADORES ---
unsigned long lastBusUpdate = 0;
unsigned long lastTimeUpdate = 0;
unsigned long lastTouchTime = 0;
unsigned long lastWifiTry = 0;
bool wifiPerdido = false;          // ya se avisó en pantalla de que no hay WiFi
void drawSinWifi(bool cabeceraEntera = false);
const unsigned long busDelay = 20000;      // el servidor cachea 15 s
const unsigned long timeDelay = 10000;
const unsigned long touchCooldown = 500;
const unsigned long wifiRetryDelay = 10000;

const char* ntpServer = "pool.ntp.org";
const char* tz_info = "CET-1CEST,M3.5.0,M10.5.0/3";

// ---------------------------------------------------------------------------

void mensajeCentral(const char* texto, uint16_t color) {
  tft.fillScreen(COLOR_BG);
  tft.setFont(&FreeSansBold9pt7b);
  tft.setTextColor(color);
  tft.setCursor(10, 110);
  tft.print(texto);
}

bool conectarWifi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < timeoutMs) {
    delay(250);
  }
  return WiFi.status() == WL_CONNECTED;
}

// ===========================================================================
// RED: http en casa (opción A) o https con clave (opción B, Cloudflare)
// ===========================================================================

// Prepara una petición al servidor. "tls" tiene que vivir mientras se use "http".
bool abrir(HTTPClient& http, WiFiClientSecure& tls, const String& url) {
  if (url.startsWith("https://")) {
#ifdef TLS_SIN_VERIFICAR
    tls.setInsecure();              // solo para pruebas: no comprueba el certificado
#else
    tls.setCACert(RAICES_CA);
#endif
    if (!http.begin(tls, url)) return false;
  } else if (!http.begin(url)) {
    return false;
  }
  if (strlen(API_KEY) > 0) http.addHeader("X-Clave", API_KEY);
  return true;
}

// ===========================================================================
// AUDIO: tarea en el núcleo 0, para que dibujar la pantalla no corte el sonido
// ===========================================================================

// Lee exactamente n bytes del stream (o falla por timeout)
bool leerExacto(WiFiClient* s, uint8_t* buf, size_t n) {
  return s->readBytes(buf, n) == n;
}

uint32_t le32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
uint16_t le16(const uint8_t* p) { return p[0] | (p[1] << 8); }

bool reproducirWav(const char* url) {
  HTTPClient http;
  WiFiClientSecure tls;
  http.setTimeout(8000);
  if (!abrir(http, tls, String(url))) return false;
  if (http.GET() != 200) { http.end(); return false; }

  WiFiClient* s = http.getStreamPtr();
  s->setTimeout(3);   // segundos
  uint8_t h[16];

  // Cabecera RIFF/WAVE
  if (!leerExacto(s, h, 12) || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) {
    http.end(); return false;
  }

  // Límites defensivos: no nos fiamos de los tamaños que llegan por la red
  const uint32_t MAX_CHUNK_EXTRA = 4096;          // chunks de metadatos
  const uint32_t MAX_AUDIO = 2 * 1024 * 1024;     // ~45 s a 22 kHz
  const unsigned long LIMITE_MS = 60000;          // tope total de reproducción
  unsigned long inicio = millis();

  uint32_t rate = 0, datos = 0;
  uint16_t canales = 1, bits = 0;
  // Recorre los chunks hasta "data" (como mucho 8)
  for (int chunks = 0; ; chunks++) {
    if (chunks >= 8 || !leerExacto(s, h, 8)) { http.end(); return false; }
    uint32_t tam = le32(h + 4);
    if (!memcmp(h, "fmt ", 4)) {
      if (tam < 16 || tam > 64 || !leerExacto(s, h, 16)) { http.end(); return false; }
      canales = le16(h + 2);
      rate = le32(h + 4);
      bits = le16(h + 14);
      for (uint32_t i = 16; i < tam; i++) s->read();       // resto del chunk
    } else if (!memcmp(h, "data", 4)) {
      datos = min(tam, MAX_AUDIO);
      break;
    } else {
      if (tam > MAX_CHUNK_EXTRA) { http.end(); return false; }
      for (uint32_t i = 0; i < tam; i++) s->read();        // chunk que no usamos
    }
  }
  if (bits != 16 || canales < 1 || canales > 2 || rate < 8000 || rate > 48000) {
    http.end(); return false;
  }

  i2s.setPins(I2S_BCLK, I2S_LRC, I2S_DOUT);
  if (!i2s.begin(I2S_MODE_STD, rate, I2S_DATA_BIT_WIDTH_16BIT,
                 canales == 1 ? I2S_SLOT_MODE_MONO : I2S_SLOT_MODE_STEREO)) {
    http.end(); return false;
  }

  int16_t buf[512];
  while (datos > 0 && millis() - inicio < LIMITE_MS) {
    size_t pedir = min((uint32_t)sizeof(buf), datos);
    size_t n = s->readBytes((uint8_t*)buf, pedir);
    if (n == 0) break;                                       // timeout de red
    for (size_t i = 0; i < n / 2; i++) buf[i] = (int16_t)(buf[i] * volumen);
    i2s.write((uint8_t*)buf, n & ~1);
    datos -= n;
  }

  memset(buf, 0, sizeof(buf));                               // vacía el DMA sin chasquido
  for (int i = 0; i < 4; i++) i2s.write((uint8_t*)buf, sizeof(buf));
  i2s.end();
  http.end();
  return true;
}

void tareaAudio(void*) {
  char url[160];
  for (;;) {
    if (xQueueReceive(colaAudio, url, portMAX_DELAY) == pdTRUE) {
      Serial.printf("Audio: %s -> %s\n", url, reproducirWav(url) ? "ok" : "error");
    }
  }
}

bool avisoActivo() { return avisoHasta != 0 && millis() < avisoHasta; }

// El aviso ocupa el hueco de la 3.ª tarjeta, abajo: la cabecera (parada,
// tiempo, hora) y las dos primeras llegadas siguen a la vista.
const int BANNER_Y = 165;

void drawBanner() {
  tft.fillRoundRect(10, BANNER_Y, 300, 52, 12, COLOR_GREEN);
  tft.setFont(&FreeSansBold9pt7b);
  tft.setTextColor(ILI9341_BLACK);
  int16_t bx, by; uint16_t bw, bh;
  tft.getTextBounds(avisoTexto, 0, 0, &bx, &by, &bw, &bh);
  tft.setCursor(160 - bw / 2 - bx, BANNER_Y + 32);
  tft.print(avisoTexto);
}

// Al terminar el aviso: se borra el hueco (la tarjeta la repinta fetchBusData)
void borrarBanner() {
  tft.fillRect(0, BANNER_Y - 2, 320, 56, COLOR_BG);
}

void checkAviso() {
  HTTPClient http;
  WiFiClientSecure tls;
  http.setTimeout(5000);
  if (!abrir(http, tls, serverRoot + "/api/aviso")) return;
  int code = http.GET();
  if (code != 200) { http.end(); return; }   // 204 = no hay aviso
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  String id = doc["id"] | "";
  if (id.length() == 0 || id.length() > 16 || id == ultimoAvisoId) return;
  ultimoAvisoId = id;

  String linea = doc["linea"] | "";
  if (linea.length() > 4) linea = linea.substring(0, 4);
  int minutos = constrain((int)(doc["minutos"] | 0), 0, 99);
  avisoTexto = "SAL YA  " + linea + " en " + String(minutos) + " min";

  // Solo rutas de audio del propio servidor
  String ruta = doc["audio"] | "";
  if (!ruta.startsWith("/api/audio/") || ruta.length() > 40) return;
  avisoHasta = millis() + avisoBanner;
  drawBanner();

  String url = serverRoot + ruta;
  char buf[160];
  url.toCharArray(buf, sizeof(buf));
  xQueueSend(colaAudio, buf, 0);
}

void setup() {
  Serial.begin(115200);

  colaAudio = xQueueCreate(3, 160);
  // 12 KB de pila: la conexión HTTPS (opción B) necesita más que la de casa
  xTaskCreatePinnedToCore(tareaAudio, "audio", 12288, NULL, 2, NULL, 0);
  // Por HTTPS cada consulta cuesta más (cifrado): el aviso se pide cada 10 s,
  // de sobra para una ventana de aviso de 90 s
  if (serverRoot.startsWith("https://")) avisoDelay = 10000;

  tft.begin();
  tft.setRotation(1);
  ts.begin();
  ts.setRotation(1);

  mensajeCentral("Conectando WiFi...", ILI9341_WHITE);

  while (!conectarWifi(15000)) {
    mensajeCentral("Sin WiFi. Reintentando...", COLOR_RED);
    delay(5000);
  }
  WiFi.setAutoReconnect(true);

  configTzTime(tz_info, ntpServer);
  fetchBusData();
  lastBusUpdate = millis();
}

void loop() {
  bool wifiOk = WiFi.status() == WL_CONNECTED;

  // WiFi caído: se avisa en pantalla, porque los minutos que se ven dejan de
  // actualizarse y ya no son fiables. Al volver, se piden datos frescos.
  if (!wifiOk && !wifiPerdido) {
    wifiPerdido = true;
    Serial.println("WiFi perdido");
    drawSinWifi();
  }
  if (wifiOk && wifiPerdido) {
    wifiPerdido = false;
    Serial.println("WiFi recuperado");
    fetchBusData();
    lastBusUpdate = millis();
  }

  // Reintento de conexión sin bloquear el resto
  if (!wifiOk && millis() - lastWifiTry > wifiRetryDelay) {
    lastWifiTry = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  if (ts.touched() && (millis() - lastTouchTime > touchCooldown)) {
    TS_Point p = ts.getPoint();
    Serial.printf("Toque: x=%d y=%d z=%d\n", p.x, p.y, p.z);

    bool derecha = (p.x > TOUCH_X_MITAD) != TOUCH_INVERTIDO;
    if (derecha) {
      paradaActual = (paradaActual + 1) % totalParadas;
    } else {
      paradaActual = (paradaActual - 1 + totalParadas) % totalParadas;
    }

    drawLoading();
    fetchBusData();
    lastTouchTime = millis();
    lastBusUpdate = millis();
  }

  if (millis() - lastBusUpdate > busDelay) {
    if (WiFi.status() == WL_CONNECTED) fetchBusData();
    lastBusUpdate = millis();
  }

  if (millis() - lastTimeUpdate > timeDelay) {
    drawClock();
    lastTimeUpdate = millis();
  }

  if (WiFi.status() == WL_CONNECTED && millis() - lastAvisoCheck > avisoDelay) {
    checkAviso();
    lastAvisoCheck = millis();
  }

  // Fin del aviso: vuelve la 3.ª tarjeta
  if (avisoHasta != 0 && millis() >= avisoHasta) {
    avisoHasta = 0;
    borrarBanner();
    if (WiFi.status() == WL_CONNECTED) fetchBusData();
    lastBusUpdate = millis();
  }
}

// La fuente GFX solo tiene ASCII: quitamos tildes y ñ (UTF-8 de 2 bytes)
String sinAcentos(const String& in) {
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    uint8_t c = in[i];
    if (c == 0xC3 && i + 1 < in.length()) {
      uint8_t d = in[++i];
      const char* mapa = "AAAAAAACEEEEIIII" "DNOOOOO*OUUUUYTs"   // 0x80-0x9F
                         "aaaaaaaceeeeiiii" "dnooooo/ouuuuyty";  // 0xA0-0xBF
      if (d >= 0x80 && d <= 0xBF) out += mapa[d - 0x80];
    } else if (c < 0x80) {
      out += (char)c;
    }
  }
  return out;
}

// --- Iconos del tiempo: 20x20 px en torno a (110, 17), solo con primitivas GFX
void iconoSol(int x, int y, int r) {
  tft.fillCircle(x, y, r, COLOR_SUN);
  int a = r + 2, b = r + 4, d = (int)lround(a * 0.7), e = (int)lround(b * 0.7);
  const int8_t ejes[4][2] = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};
  const int8_t diag[4][2] = {{1, 1}, {-1, 1}, {-1, -1}, {1, -1}};
  for (int i = 0; i < 4; i++) {
    tft.drawLine(x + ejes[i][0] * a, y + ejes[i][1] * a, x + ejes[i][0] * b, y + ejes[i][1] * b, COLOR_SUN);
    tft.drawLine(x + diag[i][0] * d, y + diag[i][1] * d, x + diag[i][0] * e, y + diag[i][1] * e, COLOR_SUN);
  }
}

void iconoLuna(int x, int y, int r) {
  tft.fillCircle(x, y, r, COLOR_MOON);
  tft.fillCircle(x + 3, y - 3, r - 1, COLOR_BG);
}

void iconoNube(int x, int y, uint16_t c) {
  tft.fillCircle(x - 4, y, 4, c);
  tft.fillCircle(x + 1, y - 3, 5, c);
  tft.fillCircle(x + 6, y + 1, 3, c);
  tft.fillRoundRect(x - 8, y, 17, 5, 2, c);
}

void drawIconoClima(const char* icono, bool noche) {
  const int X = 110, Y = 17;
  tft.fillRect(96, 0, 30, 35, COLOR_BG);   // los rayos del sol llegan a x = 97
  if (!strcmp(icono, "despejado")) {
    if (noche) iconoLuna(X, Y, 6); else iconoSol(X, Y, 5);
  } else if (!strcmp(icono, "parcial")) {
    if (noche) iconoLuna(X - 5, Y - 5, 5); else iconoSol(X - 5, Y - 5, 4);
    iconoNube(X + 2, Y + 3, COLOR_CLOUD);
  } else if (!strcmp(icono, "nublado")) {
    iconoNube(X - 3, Y - 2, COLOR_CLOUD_DARK);
    iconoNube(X + 2, Y + 3, COLOR_CLOUD);
  } else if (!strcmp(icono, "niebla")) {
    tft.fillRect(X - 9, Y - 5, 18, 2, COLOR_CLOUD);
    tft.fillRect(X - 6, Y, 18, 2, COLOR_CLOUD);
    tft.fillRect(X - 9, Y + 5, 18, 2, COLOR_CLOUD);
  } else if (!strcmp(icono, "lluvia")) {
    iconoNube(X, Y - 3, COLOR_CLOUD);
    for (int dx = -6; dx <= 4; dx += 5) {
      tft.drawLine(X + dx, Y + 5, X + dx - 2, Y + 9, COLOR_BLUE_RAIN);
      tft.drawLine(X + dx + 1, Y + 5, X + dx - 1, Y + 9, COLOR_BLUE_RAIN);
    }
  } else if (!strcmp(icono, "nieve")) {
    iconoNube(X, Y - 3, COLOR_CLOUD);
    tft.fillCircle(X - 6, Y + 7, 1, ILI9341_WHITE);
    tft.fillCircle(X, Y + 9, 1, ILI9341_WHITE);
    tft.fillCircle(X + 6, Y + 7, 1, ILI9341_WHITE);
  } else if (!strcmp(icono, "tormenta")) {
    iconoNube(X, Y - 4, COLOR_CLOUD_DARK);
    tft.fillTriangle(X + 1, Y + 1, X - 4, Y + 7, X, Y + 6, COLOR_SUN);
    tft.fillTriangle(X, Y + 5, X + 4, Y + 5, X - 2, Y + 12, COLOR_SUN);
  }
}

void drawSinWifi(bool cabeceraEntera) {
  tft.setFont(&FreeSansBold9pt7b);
  if (cabeceraEntera) {            // repinta la cabecera entera
    tft.fillRect(0, 0, 320, 35, COLOR_BG);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(10, 24);
    tft.print("EMT " + String(paradas[paradaActual]));
    drawClock();
  }
  tft.fillRect(96, 0, 154, 35, COLOR_BG);   // tapa también el icono del tiempo
  tft.setTextColor(COLOR_RED);
  tft.setCursor(130, 24);
  tft.print("Sin WiFi");
}

void drawLoading() {
  tft.fillRect(0, 0, 250, 35, COLOR_BG);
  tft.setFont(&FreeSansBold9pt7b);
  tft.setTextColor(COLOR_ACCENT);
  tft.setCursor(10, 24);
  tft.print("Actualizando...");
}

void drawPagination() {
  int dotRadius = 4;
  int spacing = 16;
  int startX = 160 - ((totalParadas - 1) * spacing) / 2;

  tft.fillRect(0, 225, 320, 15, COLOR_BG);
  for (int i = 0; i < totalParadas; i++) {
    uint16_t color = (i == paradaActual) ? ILI9341_WHITE : COLOR_TEXT_DIM;
    tft.fillCircle(startX + (i * spacing), 232, dotRadius, color);
  }
}

void drawClock() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 100)) return;

  char buf[10];
  strftime(buf, sizeof(buf), "%H:%M", &timeinfo);

  tft.fillRect(250, 0, 70, 35, COLOR_BG);
  tft.setFont(&FreeSansBold9pt7b);
  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(255, 24);
  tft.print(buf);
}

void drawHeader(JsonDocument& doc) {
  tft.fillRect(0, 0, 250, 35, COLOR_BG);
  tft.setFont(&FreeSansBold9pt7b);

  tft.setTextColor(ILI9341_WHITE);
  tft.setCursor(10, 24);
  tft.print("EMT " + String(doc["parada"].as<int>()));

  tft.setTextColor(COLOR_ACCENT);
  tft.setCursor(130, 24);
  tft.print(doc["clima"].as<String>());

  tft.setTextColor(COLOR_BLUE_RAIN);
  tft.setCursor(195, 24);
  tft.print(doc["prob_lluvia"].as<String>());

  drawIconoClima(doc["icono_clima"] | "", doc["noche"] | false);

  // Punto naranja si el servidor está sirviendo el último dato bueno
  if (doc["obsoleto"] | false) {
    tft.fillCircle(244, 18, 3, COLOR_ORANGE);
  }
}

void drawBody(JsonDocument& doc) {
  tft.fillRect(0, 36, 320, 188, COLOR_BG);   // solo el cuerpo: sin parpadeo
  tft.setFont(&FreeSansBold9pt7b);

  JsonArray llegadas = doc["llegadas"].as<JsonArray>();

  if (llegadas.size() == 0) {
    tft.fillRoundRect(10, 50, 300, 60, 12, COLOR_CARD);
    tft.setTextColor(COLOR_TEXT_DIM);
    tft.setCursor(25, 85);
    JsonArray avisos = doc["avisos"].as<JsonArray>();
    if (avisos.size() > 0 && String(avisos[0].as<const char*>()) == "SENSE ESTIMACIONS") {
      tft.print("Sin servicio ahora");
    } else {
      tft.print("Sin autobuses cercanos");
    }
    if (avisoActivo()) drawBanner();
    return;
  }

  int yPos = 45;
  int count = 0;
  const int maxTarjetas = avisoActivo() ? 2 : 3;   // con aviso, la 3.ª es el banner
  for (JsonObject bus : llegadas) {
    if (count >= maxTarjetas) break;

    String linea   = bus["linea"].as<String>();
    String destino = sinAcentos(bus["destino"] | "");
    String texto   = bus["texto"] | "?";
    bool llegando  = bus["llegando"] | false;
    bool real      = bus["tiempo_real"] | false;

    if (destino.length() > 12) destino = destino.substring(0, 11) + ".";

    tft.fillRoundRect(10, yPos, 300, 52, 12, COLOR_CARD);
    tft.fillRoundRect(20, yPos + 10, 45, 32, 6, COLOR_RED);

    // Línea centrada en la placa roja
    int16_t bx, by; uint16_t bw, bh;
    tft.getTextBounds(linea, 0, 0, &bx, &by, &bw, &bh);
    tft.setTextColor(ILI9341_WHITE);
    tft.setCursor(20 + (45 - bw) / 2 - bx, yPos + 32);
    tft.print(linea);

    tft.setTextColor(COLOR_TEXT_DIM);
    tft.setCursor(75, yPos + 32);
    tft.print(destino);

    if (llegando) {
      tft.setTextColor(COLOR_GREEN);
      tft.setCursor(220, yPos + 32);
      tft.print("Llega");
    } else if (bus["desviada"] | false) {
      tft.setTextColor(COLOR_ORANGE);
      tft.setCursor(215, yPos + 32);
      tft.print("Desviada");
    } else if (real) {
      tft.setTextColor(ILI9341_WHITE);
      tft.setCursor(225, yPos + 32);
      tft.print(texto);
      tft.setTextColor(COLOR_TEXT_DIM);
      tft.print(" min");
    } else {
      // Hora prevista, sin estimación en tiempo real: en gris
      tft.setTextColor(COLOR_TEXT_DIM);
      tft.setCursor(240, yPos + 32);
      tft.print(texto);
    }

    yPos += 60;
    count++;
  }
  if (avisoActivo()) drawBanner();
}

void fetchBusData() {
  HTTPClient http;
  WiFiClientSecure tls;
  http.setTimeout(8000);
  String url = serverBase + String(paradas[paradaActual]);
  abrir(http, tls, url);
  int code = http.GET();

  if (code == 200) {
    String payload = http.getString();
    http.end();
    JsonDocument doc;
    DeserializationError error = deserializeJson(doc, payload);
    if (error) {
      Serial.printf("JSON inválido: %s\n", error.c_str());
      return;   // se mantiene en pantalla lo anterior
    }
    drawHeader(doc);
    drawClock();
    drawBody(doc);
    drawPagination();
    return;
  }

  http.end();
  Serial.printf("HTTP %d en %s\n", code, url.c_str());
  tft.fillRect(0, 36, 320, 188, COLOR_BG);
  tft.setFont(&FreeSansBold9pt7b);
  tft.setTextColor(COLOR_RED);
  tft.setCursor(10, 110);
  tft.print(code == 502 ? "EMT no disponible"
            : code == 401 ? "Clave incorrecta (API_KEY)"
            : "Sin conexion al servidor");
  if (avisoActivo()) drawBanner();
  drawPagination();
}
