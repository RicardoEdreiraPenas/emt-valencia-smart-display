<p align="center">
  <img src="docs/img/portada.png" alt="EMT València Smart Display: pantalla táctil con llegadas de autobús y versión móvil" width="100%">
</p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img src="../../actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/ESP32-Arduino%203.x-E7352C?logo=espressif&logoColor=white" alt="ESP32">
  <img src="https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/licencia-MIT-informational" alt="Licencia MIT">
</p>

# EMT València Smart Display

Pantalla táctil que muestra **en tiempo real** cuándo llegan los autobuses de la EMT de València a tus paradas, con el tiempo, la probabilidad de lluvia y la hora. Cuando toca salir de casa para no perder el bus, **lo dice en voz alta**.

El sistema tiene tres piezas: un **ESP32** con pantalla de 2,8" montado en una carcasa de bloques de construcción, un **servidor Python** en una placa ARM (Radxa ROCK 3C o Raspberry Pi) y una **web instalable** para el móvil.

**Lo más destacable**

- **La misma fuente que la app oficial.** Consulta directamente el SAE de la EMT (el sistema de seguimiento por GPS de los autobuses), sin librerías intermedias.
- **Distingue lo real de lo previsto.** Las estimaciones en tiempo real se muestran en blanco; las horas teóricas, en gris; "Próximo" se convierte en *Llegando*.
- **Aviso de salida por voz.** Calcula `llegada del bus − minutos andando` y avisa en el último minuto, con voz neuronal offline (Piper TTS).
- **Robusto.** Caché compartida de 15 s; si la EMT no responde, muestra el último dato bueno y lo marca.
- **Seguro por diseño.** Lista de paradas permitidas, sin CORS, servicio aislado con systemd y 22 tests automáticos (10 de seguridad). Ver [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

---

## Capturas

| Pantalla del dispositivo | Aviso de salida |
|:---:|:---:|
| <img src="docs/img/dispositivo.png" alt="Pantalla con las próximas llegadas" width="100%"> | <img src="docs/img/dispositivo-aviso.png" alt="Banner verde SAL YA" width="100%"> |
| Próximas llegadas de la parada. Se cambia de parada tocando a izquierda o derecha. | Banner verde y voz: *"Sal ya. La 93 hacia Pass. Marítim llega en 6 minutos."* |

| Web en el móvil | Sin servicio |
|:---:|:---:|
| <img src="docs/img/web-parada-1.png" alt="Web móvil con llegadas" width="300"> | <img src="docs/img/web-sin-servicio.png" alt="Web móvil sin servicio" width="300"> |

> Las capturas de la web son del servidor real con datos de demostración. La pantalla del dispositivo es una reproducción fiel del firmware (mismas coordenadas, colores y textos).

---

## Arquitectura

<p align="center"><img src="docs/img/arquitectura.png" alt="Diagrama de arquitectura" width="100%"></p>

El ESP32 y el móvil nunca hablan con la EMT: solo con el servidor de casa. Así hay **una sola consulta** a la EMT por parada cada 15 s, aunque haya varias pantallas, y cualquier cambio en la fuente de datos se arregla en un único sitio.

### Qué devuelve la EMT y cómo se interpreta

El SAE responde XML. El campo `minutos` significa cosas distintas según el caso, y la librería de referencia no los contemplaba todos. Estos formatos están verificados con respuestas reales, guardadas como casos de prueba en [`server/tests/fixtures`](server/tests/fixtures):

| `minutos` en el XML | Significado | En la pantalla |
|---|---|---|
| `37 min.` | Estimación en tiempo real | **37 min** (blanco) |
| `Próximo` | El bus está llegando | **Llegando** (verde) |
| `02:57:45` | Hora prevista, sin GPS (2.º bus de la línea, nocturnos…) | 02:57 (gris) |
| vacío + `<error>SENSE ESTIMACIONS</error>` | Sin servicio | *Sin servicio ahora* |

### Aviso de salida

<p align="center"><img src="docs/img/aviso-salida.png" alt="Línea de tiempo del aviso de salida" width="100%"></p>

El audio se genera en el servidor con [Piper](https://github.com/OHF-Voice/piper1-gpl) en cuanto nace el aviso, y el ESP32 lo reproduce por I2S **en el otro núcleo** (tarea FreeRTOS), para que dibujar la pantalla no corte el sonido. Sin voz instalada, suena un tono de dos notas.

---

## Hardware

| Componente | Notas |
|---|---|
| ESP32 DevKit V1 (WROOM, 30 pines) | No necesita PSRAM: el audio se lee en streaming |
| Pantalla TFT SPI ILI9341 2,4" o 2,8" con táctil XPT2046 | |
| Amplificador I2S MAX98357A + altavoz 3 W / 4 Ω | Opcional, para los avisos de voz |
| Radxa ROCK 3C, Raspberry Pi o cualquier Linux | Servidor siempre encendido |
| Cargador USB 5 V / 2 A | 2 A por los picos del altavoz |
| Cables Dupont y carcasa de bloques | |

### Cableado

<table>
<tr><td valign="top">

**Pantalla y táctil**

| TFT | ESP32 |
|---|---|
| VCC, LED | 3V3 |
| GND | GND |
| CS | GPIO 15 |
| RESET | GPIO 4 |
| DC | GPIO 2 |
| SDI / MOSI · T_DIN | GPIO 23 |
| SCK · T_CLK | GPIO 18 |
| SDO / MISO · T_DO | GPIO 19 |
| T_CS | GPIO 21 |

</td><td valign="top">

**Audio (MAX98357A)**

| Módulo | ESP32 |
|---|---|
| VIN | 5V / VIN |
| GND | GND |
| BCLK | GPIO 26 |
| LRC | GPIO 25 |
| DIN | GPIO 22 |
| SD, GAIN | sin conectar |

</td></tr>
</table>

---

## Puesta en marcha

### 1. Servidor

```bash
git clone https://github.com/RicardoEdreiraPenas/emt-valencia-smart-display.git
cd emt-valencia-smart-display/server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Opcional: voz para los avisos
pip install -r requirements-voz.txt
python3 -m piper.download_voices --data-dir voces es_ES-davefx-medium

python3 app.py
curl http://localhost:5000/api/parada/708
```

Para dejarlo como servicio que arranca solo y está aislado del sistema, sigue las instrucciones de [`deploy/dashboard-emt.service`](deploy/dashboard-emt.service).

### 2. Configuración

Todo lo personal está en [`server/config.py`](server/config.py):

```python
PARADAS = [708, 1676, 2080]          # las que muestra la pantalla
CLIMA = {"lat": 39.4697, "lon": -0.3774}

REGLAS = [                            # avisos de salida
    {"parada": 708, "andando_min": 5, "lineas": None,
     "dias": [0, 1, 2, 3, 4], "desde": "07:30", "hasta": "09:00"},
]
SILENCIO = ("23:00", "07:00")         # nunca suena en esta franja
```

El número de parada está en el poste de cada parada y en la app de la EMT.

### 3. Firmware (ESP32)

1. Instala el **core Arduino-ESP32 3.x** y las librerías `ArduinoJson` (v7), `Adafruit GFX Library`, `Adafruit ILI9341` y `XPT2046_Touchscreen`.
2. En `firmware/dashboard_emt/`:
   - copia `secrets.example.h` como `secrets.h` y pon tu WiFi (está en `.gitignore`);
   - en `config.h`, pon la IP del servidor y las mismas paradas que en `config.py`.
3. Sube el sketch. **Calibrar el táctil:** abre el Monitor Serie (115200), toca a izquierda y derecha y ajusta `TOUCH_X_MITAD` (y `TOUCH_INVERTIDO` si va al revés).

### 4. Web para el móvil

```bash
cd frontend
npm ci
npm run build      # genera server/web, que sirve el propio servidor
```

Abre `http://<ip-del-servidor>:5000` en el móvil y añádela a la pantalla de inicio. Para usarla fuera de casa, accede por VPN (por ejemplo Tailscale); **no abras el puerto en el router**.

---

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/parada/<id>` | Llegadas normalizadas, clima y estado del dato (`obsoleto`, `edad_dato_s`). 404 si la parada no está configurada |
| GET | `/api/config` | Paradas configuradas |
| GET | `/api/aviso` | Aviso de salida vigente, o 204 |
| GET | `/api/audio/<id>.wav` | Audio del aviso (PCM 16 bits mono) |
| GET | `/api/salud` | Estado del servicio |

<details>
<summary>Ejemplo de respuesta de <code>/api/parada/708</code></summary>

```json
{
  "success": true,
  "parada": 708,
  "clima": "17 C",
  "prob_lluvia": "20%",
  "llegadas": [
    {"linea": "19", "destino": "La Malva-rosa", "minutos": 37, "llegando": false,
     "hora": null, "tiempo_real": true, "texto": "37", "llega_a": 1793409591},
    {"linea": "19", "destino": "La Malva-rosa", "minutos": null, "llegando": false,
     "hora": "02:57", "tiempo_real": false, "texto": "02:57", "llega_a": 1793411820}
  ],
  "avisos": [],
  "servidor_ts": 1793407371,
  "edad_dato_s": 0,
  "obsoleto": false
}
```

`llega_a` es la hora prevista absoluta (epoch): permite cuentas atrás continuas sin volver a preguntar.
</details>

---

## Calidad

```bash
cd server && pip install pytest && python -m pytest -v tests
```

- **Parser del SAE:** respuestas reales de la EMT, "Próximo", horas previstas y cruce de medianoche.
- **Avisos:** franjas, silencio nocturno, no repetir el mismo bus, filtro de líneas y WAV válido.
- **Seguridad:** paradas no permitidas, CORS, cabeceras, errores sin detalles internos, IDs de audio, rutas de API y bomba XML.

La [CI](.github/workflows/ci.yml) ejecuta los tests, compila la web y **compila el firmware para ESP32** en cada cambio.

## Estructura

```
├── server/              Servidor Python (Flask + waitress)
│   ├── app.py           API, parser del SAE, caché y web estática
│   ├── avisos.py        Motor de avisos de salida y voz
│   ├── config.py        Tus paradas y avisos
│   └── tests/           22 tests + respuestas reales de la EMT
├── firmware/
│   └── dashboard_emt/   Sketch del ESP32 (pantalla, táctil, audio I2S)
├── frontend/            Web React + Tailwind (Vite)
├── deploy/              Servicio systemd endurecido
└── docs/                Seguridad e imágenes
```

## Hoja de ruta

- [ ] Cuenta atrás continua en la pantalla a partir de `llega_a`.
- [ ] Registro histórico de estimaciones frente a llegadas reales para corregir el sesgo del SAE por línea, parada y hora.
- [ ] Posición de los autobuses (geoportal del Ajuntament) para mostrar "a 3 paradas".
- [ ] Foto del montaje final.

## Créditos y aviso legal

- Datos de llegadas: **EMT València**. El endpoint del SAE no está documentado públicamente; este proyecto es **no oficial**, para uso personal, y limita las consultas con caché. El formato del endpoint se documentó primero en [ElEd0/EMTValencia-API](https://github.com/ElEd0/EMTValencia-API).
- Datos meteorológicos: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
- Voz: [Piper TTS](https://github.com/OHF-Voice/piper1-gpl).

Proyecto de [Ricardo Edreira Penas](https://github.com/RicardoEdreiraPenas) · Licencia [MIT](LICENSE).
