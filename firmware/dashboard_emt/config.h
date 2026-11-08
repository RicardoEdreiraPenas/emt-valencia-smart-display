// Configuración del dispositivo (sin datos secretos).
#pragma once

// Servidor. Elige una opción (ver README):
//   A) Raspberry / Radxa en casa con server/app.py:
#define SERVER_ROOT "http://192.168.1.50:5000"
//   B) Cloudflare Workers (cloud/), sin placa; pon también API_KEY en secrets.h:
// #define SERVER_ROOT "https://emt-smart-display.TU-SUBDOMINIO.workers.dev"
//
// Solo para pruebas: descomenta para no comprobar el certificado HTTPS.
// #define TLS_SIN_VERIFICAR

// Paradas a mostrar, en orden. Deben estar también en server/config.py (A)
// o en PARADAS de cloud/wrangler.toml (B)
#define PARADAS 708, 1676, 2080, 1619, 697

// Pines (ver docs de cableado en el README)
// Pantalla: CS 15, DC 2, RST 4, táctil CS 21 · Audio I2S: BCLK 26, LRC 25, DIN 22

// Luz de la pantalla y botón táctil TTP223 (ver docs/MONTAJE.md)
#define PIN_LUZ    17    // pin LED de la pantalla (TX2 en la placa); -1 si sigue a 3V3
#define PIN_BOTON  33    // salida I/O del TTP223 (D33); -1 si no lo montas

// Modo noche: la pantalla se apaga sola en esta franja (HHMM, hora de Madrid).
// Tocar la pantalla la enciende DESPIERTA_S segundos; el botón la enciende o
// apaga cuando quieras (hasta el siguiente cambio de día a noche o al revés).
#define NOCHE_DESDE 2300
#define NOCHE_HASTA 700
#define DESPIERTA_S 30
