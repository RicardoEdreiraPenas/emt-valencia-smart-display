# Opción B: el servidor en Cloudflare Workers (sin placa)

Con esta opción no hace falta la Raspberry ni la Radxa: el servidor corre en la red de Cloudflare, gratis, y el ESP32 se conecta a él por HTTPS. La API es la misma que la de [`server/app.py`](../server/app.py), así que la pantalla, la web del móvil y el gemelo digital funcionan igual con las dos opciones.

```
ESP32 ──HTTPS + clave──▶ Cloudflare Worker ──▶ EMT (SAE)
móvil ──HTTPS + cookie─▶   (cloud/)        ──▶ Open-Meteo
                                            ──▶ Workers AI (voz del aviso)
```

## Qué cambia respecto a la opción A

| | A · Placa en casa | B · Cloudflare |
|---|---|---|
| Código | `server/` (Python) | `cloud/` (JavaScript, el mismo comportamiento) |
| Configuración | `server/config.py` | `[vars]` de `cloud/wrangler.toml` |
| Acceso | Tu red local | Internet, protegido con clave |
| Avisos de salida | Un bucle los revisa cada 10 s | Se calculan cuando el ESP32 pregunta (cada 10 s) |
| Voz | Piper (`es_ES-davefx-medium`) | Workers AI, `@cf/deepgram/aura-2-es` |
| Si la voz falla | Tono de dos notas | El mismo tono |
| Estado (caché, avisos) | Memoria del proceso | Cache API de Cloudflare (sin bases de datos) |

## Lo que necesitas

- Una cuenta de Cloudflare (la gratuita basta).
- Node.js 20 o superior en tu ordenador.
- Este repositorio clonado.

## 1. Configurar

Edita `cloud/wrangler.toml`:

```toml
[vars]
PARADAS = "708,1676,2080,1619,697"   # las de la pantalla, en orden
CLIMA = "39.4697,-0.3774"            # latitud,longitud para el tiempo
SILENCIO = "23:00-07:00"             # nunca suena en esta franja ("" = sin silencio)
VOZ = "aquila"                       # o alvaro, carina, celeste, diana, estrella, javier, nestor, selena, sirio
REGLAS = '''
[
  {"parada": 708, "andando_min": 5, "lineas": null,
   "dias": [0, 1, 2, 3, 4], "desde": "07:30", "hasta": "09:00"}
]
'''
```

Los campos son los mismos que en `server/config.py`: `dias` va de 0 (lunes) a 6 (domingo) y `lineas` es `null` (todas) o una lista como `["19", "93"]`. Solo se consultan las paradas de `PARADAS` y las de `REGLAS`; cualquier otra devuelve 404 sin tocar la EMT.

## 2. Publicar

```bash
cd cloud
npx wrangler login       # abre el navegador; solo la primera vez
npm run desplegar        # compila la web, junta el gemelo digital y publica
```

Al terminar, wrangler muestra la dirección: `https://emt-smart-display.<tu-subdominio>.workers.dev`.

## 3. Poner la clave

La API está en internet, así que pide una clave. Genérala y guárdala como secreto del Worker (no va en ningún archivo del repositorio):

```bash
openssl rand -hex 20 | tee ~/emt-clave.txt | npx wrangler secret put API_TOKEN
chmod 600 ~/emt-clave.txt
```

Guarda `~/emt-clave.txt`: la necesitas para el ESP32 y para entrar desde el navegador. Para cambiarla, repite el comando; la anterior deja de valer al momento.

> Sin `API_TOKEN` la API queda abierta a cualquiera que conozca la dirección. Funciona, pero no lo dejes así.

## 4. Probar

```bash
U=https://emt-smart-display.<tu-subdominio>.workers.dev
K=$(cat ~/emt-clave.txt)
curl -s $U/api/salud                          # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" $U/api/config   # 401: sin clave no entra
curl -s -H "X-Clave: $K" $U/api/config        # tus paradas
curl -s -H "X-Clave: $K" $U/api/parada/708    # llegadas reales
```

En el navegador abre la dirección del Worker: te lleva a `/entrar`. Escribe la clave (marca "Abrir el gemelo digital" si quieres ver el aparato simulado). El navegador guarda una cookie segura y ya no la vuelve a pedir. El gemelo, abierto desde ahí, se pone solo en modo **Tu servidor** y usa tus paradas y tus avisos reales. Para salir: `/salir`.

## 5. El ESP32

En `firmware/dashboard_emt/config.h`:

```cpp
#define SERVER_ROOT "https://emt-smart-display.<tu-subdominio>.workers.dev"
#define PARADAS 708, 1676, 2080, 1619, 697
```

y en `secrets.h` (no se sube nunca al repositorio):

```cpp
#define API_KEY "la-clave-de-emt-clave.txt"
```

El firmware detecta el `https://` y:

- comprueba el certificado de Cloudflare con las raíces de [`certificados.h`](../firmware/dashboard_emt/certificados.h) (Let's Encrypt, Google Trust Services y SSL.com, que son las que usa Cloudflare para `workers.dev`);
- manda la clave en la cabecera `X-Clave`;
- pregunta por los avisos cada 10 s en vez de cada 4 s, porque cada conexión cifrada cuesta más al ESP32;
- si la clave está mal, la pantalla dice *Clave incorrecta (API_KEY)*.

Si el ESP32 no conecta y sospechas del certificado, puedes probar con `#define TLS_SIN_VERIFICAR` en `config.h`. Es solo para diagnosticar: así no comprueba con quién habla.

## Costes y límites del plan gratuito

| Recurso | Uso de una pantalla | Límite gratuito |
|---|---|---|
| Peticiones al Worker | ≈ 13.000 al día (llegadas cada 20 s + aviso cada 10 s) | 100.000 al día |
| Consultas a la EMT | Como mucho 1 cada 15 s por parada, las compartan los clientes que sean | — |
| Voz (Workers AI) | Unos 50 caracteres por aviso | 10.000 neuronas al día, de sobra |
| Cache API | Estado y audios | Sin coste |

Con dos o tres pantallas y el móvil sigues lejos del límite.

## Seguridad

- **Clave**: la comprueba el Worker comparando resúmenes SHA-256 en tiempo constante. La cookie del navegador no es la clave sino un derivado de ella (`HttpOnly`, `Secure`, `SameSite=Strict`, un año). Cada intento fallido en `/entrar` tarda 0,4 s más.
- **Sin datos personales a la vista**: sin clave, `/api/salud` solo responde `{"ok":true}`; la portada redirige a `/entrar`.
- **Cabeceras**: las mismas que la opción A (CSP sin código en línea, `X-Frame-Options`, `nosniff`, `no-referrer`) más HSTS.
- **La EMT**: solo paradas configuradas, caché compartida de 15 s y un `User-Agent` que identifica el proyecto.
- **Errores**: el detalle se queda en el registro del Worker (`npx wrangler tail`); al cliente solo le llega *EMT no disponible*.

Más en [SEGURIDAD.md](SEGURIDAD.md).

## Ver qué pasa

```bash
cd cloud && npx wrangler tail     # registro en directo del Worker
```

## Volver a la opción A

Cambia `SERVER_ROOT` del ESP32 a la IP de la placa y deja `API_KEY` vacía. Para borrar el Worker: `npx wrangler delete`.
