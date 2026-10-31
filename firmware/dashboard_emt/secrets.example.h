// Copia este archivo como "secrets.h" en esta misma carpeta y pon tu WiFi.
// secrets.h está en .gitignore: no se sube nunca al repositorio.
#pragma once

#define WIFI_SSID     "TU_NOMBRE_DE_WIFI"
#define WIFI_PASSWORD "TU_PASSWORD_DE_WIFI"

// Solo si usas el servidor en Cloudflare (opción B): la misma clave que
// guardaste con "npx wrangler secret put API_TOKEN". Con la Raspberry en
// casa (opción A) déjala vacía.
#define API_KEY ""
