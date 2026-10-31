# Seguridad

Revisión realizada el 31/10/2026.

Modelo de amenazas: proyecto doméstico en red local. Se considera atacante a
cualquiera conectado a tu WiFi (invitados, un dispositivo IoT comprometido) y a
webs maliciosas abiertas en un navegador de tu red. Lo que se protege: la
Radxa, tu IP frente a la EMT, la rutina de salidas de casa y las credenciales WiFi.

## Corregido (con test en `server/tests/test_seguridad.py`)

| # | Hallazgo | Riesgo | Corrección |
|---|---|---|---|
| 1 | CORS abierto: cualquier web visitada desde tu red podía leer la API | Medio | CORS eliminado; la web se sirve desde el mismo origen |
| 2 | Paradas arbitrarias: cada ID nuevo = petición a la EMT + entrada en caché sin límite | Medio | Solo las paradas de `config.py`; el resto devuelve 404 sin tocar la EMT |
| 3 | Clima sin espera tras fallo: cada petición reintentaba Open-Meteo | Bajo | Reintento como mucho cada 60 s |
| 4 | Errores devolvían el detalle de la excepción al cliente | Bajo | Mensaje genérico; detalle solo en el log |
| 5 | ID de audio sin validar | Bajo | Solo 10 caracteres hexadecimales |
| 6 | Sin cabeceras de seguridad en la web | Bajo | nosniff, CSP, frame-ancestors, no-referrer |
| 7 | ESP32: lector WAV confiaba en los tamaños recibidos (podía colgar la tarea de audio) | Medio | Límites de chunks, tamaño, formato y tiempo total |
| 8 | ESP32: texto y ruta del aviso sin validar | Bajo | Longitudes acotadas; solo rutas `/api/audio/` del propio servidor |
| 9 | Credenciales WiFi dentro del `.ino` (riesgo de subirlas a GitHub) | Medio | `secrets.h` (solo WiFi) en `.gitignore`; paradas y servidor en `config.h` |
| 10 | Dependencias sin versión | Bajo | `requirements.txt` con versiones fijas |
| 11 | Servicio sin aislamiento | Medio | `deploy/dashboard-emt.service`: usuario sin privilegios, sistema de archivos de solo lectura, sin capacidades |

## Verificado como seguro
- **Path traversal** en la web: `send_from_directory` lo bloquea.
- **Bomba XML** (billion laughs): la bloquea expat ≥ 2.4 (incluido en Python actual y Debian 12).
- **Inyección en la voz**: Piper se usa por su API de Python, no por shell; el texto de la EMT no puede ejecutar nada.
- **XSS en la web**: React escapa todo el texto; no se usa `dangerouslySetInnerHTML`.
- **Peticiones a la EMT y Open-Meteo**: HTTPS con verificación de certificado.
- **Modo debug de Flask**: desactivado.

## Riesgos aceptados (y cómo reducirlos)
- **HTTP sin cifrar entre ESP32 y Radxa.** Alguien en tu red podría suplantar el servidor y mostrar textos o audios falsos. Con los límites del punto 7 no puede romper el ESP32. Mitigación: WiFi con WPA2/WPA3 y red de invitados separada.
- **API sin autenticación en la LAN.** `/api/aviso` deja ver a qué hora sales de casa. Mitigación: cortafuegos en la Radxa que solo permita tu red (ver abajo) y no abrir nunca el puerto 5000 en el router; para fuera de casa, Tailscale.
- **Flash del ESP32 legible por USB** (incluye la contraseña WiFi). Solo con acceso físico. Mitigación opcional: flash encryption del ESP32.
- **Endpoint de la EMT no documentado.** No es un riesgo de seguridad, pero sí de servicio: la caché de 15 s y la lista de paradas mantienen la carga al mínimo.

## Opción B: servidor en Cloudflare Workers
El servidor está en internet, así que el modelo cambia: lo que en casa protegía la red, aquí lo protege una clave.
- **Clave obligatoria** (`API_TOKEN`, secreto del Worker, nunca en el repositorio). El ESP32 la manda en `X-Clave`; el navegador recibe una cookie derivada de ella (`HttpOnly`, `Secure`, `SameSite=Strict`), no la clave. Comparación en tiempo constante y 0,4 s de espera tras cada intento fallido en `/entrar`. Tests en `cloud/test/servidor.test.mjs`.
- **HTTPS verificado en el ESP32** con las raíces de Let's Encrypt, Google Trust Services y SSL.com (`firmware/dashboard_emt/certificados.h`). Así desaparece el riesgo de suplantación en la red local que tiene la opción A. `TLS_SIN_VERIFICAR` existe solo para diagnosticar.
- **Sin clave no se ve nada**: `/api/*` responde 401, `/api/salud` solo `{"ok":true}` y la portada lleva a `/entrar`. Los archivos de la web y del gemelo son públicos, pero no contienen datos.
- **Mismas defensas que en A**: paradas permitidas, caché compartida de 15 s, errores sin detalles, CSP sin código en línea, más HSTS.
- **Riesgo aceptado**: quien tenga la clave ve tus paradas y tus avisos (a qué hora sales de casa). Si se filtra, cámbiala con `npx wrangler secret put API_TOKEN`: la anterior deja de valer al momento y hay que actualizar `secrets.h` del ESP32.
- **Dependencia de Cloudflare**: si Cloudflare cae, la pantalla muestra *Sin conexion al servidor* hasta que vuelva. La opción A no depende de nadie más que de la EMT.

## Cortafuegos recomendado en la Radxa
```bash
sudo ufw default deny incoming
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 5000 proto tcp
sudo ufw allow in on tailscale0
sudo ufw enable
```
(Ajusta `192.168.1.0/24` a tu red.)
