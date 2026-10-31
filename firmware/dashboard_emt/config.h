// Configuración del dispositivo (sin datos secretos).
#pragma once

// Servidor (Radxa / Raspberry Pi) que corre server/app.py
#define SERVER_ROOT "http://192.168.1.50:5000"

// Paradas a mostrar, en orden. Deben estar también en server/config.py
#define PARADAS 708, 1676, 2080, 1619, 697

// Pines (ver docs de cableado en el README)
// Pantalla: CS 15, DC 2, RST 4, táctil CS 21 · Audio I2S: BCLK 26, LRC 25, DIN 22
