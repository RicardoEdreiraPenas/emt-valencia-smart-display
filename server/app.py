"""
Proxy EMT València para el Dashboard (ESP32 + web).

Fase 1: consulta directa al SAE de la EMT (el mismo sistema que usan la app
oficial, la web y los paneles de parada), sin la librería emtvlcapi.

Endpoint: GET /api/parada/<id>
"""
import math
import os
import time
import threading
import xml.etree.ElementTree as ET
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from flask import Flask, Response, abort, jsonify, redirect, send_from_directory

import avisos
import config

# --- CONFIGURACIÓN ---
# Solo se consultan estas paradas (y las de los avisos). Cualquier otra -> 404
# sin tocar la EMT: evita que alguien en tu red use la Radxa para martillear
# la EMT (y que te bloqueen la IP) o para llenar la memoria con la caché.
PARADAS_PERMITIDAS = set(config.PARADAS)
HOST = os.environ.get("EMT_HOST", "0.0.0.0")   # "127.0.0.1" si solo la usa un proxy local
PORT = int(os.environ.get("EMT_PORT", "5000"))
SAE_URL = "https://www.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php"
SAE_TIMEOUT = 4            # segundos por petición a la EMT
SAE_CACHE_TTL = 15         # segundos: todos los clientes comparten una consulta
WEATHER_CACHE_TTL = 600    # 10 minutos
MAX_STALE = 300            # tras 5 min sin datos frescos, se declara caído
TZ = ZoneInfo("Europe/Madrid")

WEATHER_URL = (
    f"https://api.open-meteo.com/v1/forecast?latitude={config.CLIMA['lat']}"
    f"&longitude={config.CLIMA['lon']}"
    "&current_weather=true&daily=precipitation_probability_max"
    "&timezone=Europe%2FMadrid"
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) DashboardEMT/1.0",
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer": "https://www.emtvalencia.es",
}

app = Flask(__name__)
# Sin CORS: la web la sirve este mismo servidor, así que ninguna web de
# terceros abierta en tu navegador puede leer la API.


@app.after_request
def cabeceras_seguridad(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "frame-ancestors 'none'"
    )
    return resp


def paradas_permitidas():
    return PARADAS_PERMITIDAS | {r["parada"] for r in avisos.REGLAS}

session = requests.Session()
session.headers.update(HEADERS)

_lock = threading.Lock()
_cache_paradas = {}   # stop_id -> {"ts": epoch, "llegadas": [...]}
_cache_clima = {"ts": 0, "data": {"temp": "-- C", "lluvia": "--%", "icono": "", "noche": False}}


# --- SAE (EMT) ---------------------------------------------------------------

def _texto(nodo):
    return nodo.text.strip() if nodo is not None and nodo.text else None


def parsear_sae(xml_text, ahora=None):
    """
    Convierte el XML <estimacion> del SAE en una lista normalizada.

    Cada <bus> trae, por posición: linea, destino, minutos, horaLlegada, error.
    'minutos' llega como "5 min." o "Próximo"; los nocturnos traen horaLlegada.
    """
    ahora = ahora or time.time()
    root = ET.fromstring(xml_text)
    if root.tag != "estimacion":
        raise ValueError(f"Respuesta inesperada del SAE: <{root.tag}>")

    llegadas, avisos = [], []
    contenedor = root[0] if len(root) else root

    for bus in contenedor:
        if bus.tag != "bus":
            continue
        campos = [_texto(c) for c in bus]

        if len(campos) < 5:
            # Formato corto: la EMT devuelve un mensaje (sin servicio, etc.)
            mensaje = campos[-1] if campos else "Respuesta vacía"
            avisos.append(mensaje)
            continue

        linea, destino, minutos_txt, hora_txt, error = campos[:5]
        if error:
            avisos.append(error)
            continue

        minutos, llegando, hora = None, False, None

        # La EMT usa 'minutos' para tres cosas distintas:
        #   "37 min."   -> estimación en tiempo real
        #   "Próximo"   -> llegando
        #   "02:57:45"  -> hora prevista (2º bus de la línea, nocturnos...)
        #   "LÍNIA DESVIADA" -> línea desviada (obras, actos): sin estimación
        # y a veces la hora viene en 'horaLlegada'.
        t = (minutos_txt or "").lower()
        desviada = "desvia" in t          # "LÍNIA DESVIADA": sin estimación
        if desviada:
            pass
        elif t.startswith("pr"):
            minutos, llegando = 0, True
        elif "min" in t:
            try:
                minutos = int(t.split()[0])
            except ValueError:
                avisos.append(f"Minutos ilegibles: {minutos_txt}")
                continue
        elif _es_hora(minutos_txt):
            hora = minutos_txt[:5]
        elif _es_hora(hora_txt):
            hora = hora_txt[:5]
        else:
            if minutos_txt or hora_txt:
                avisos.append(f"Formato desconocido: {minutos_txt or hora_txt}")
            continue

        # Hora absoluta prevista (base para la cuenta atrás de la fase 2)
        if minutos is not None:
            llega_a = int(ahora + minutos * 60)
        elif hora:
            llega_a = _hora_a_epoch(hora, ahora)
        else:
            llega_a = None

        llegadas.append({
            "linea": linea or "?",
            "destino": _arreglar_codificacion(destino),
            "minutos": minutos,          # int, o None si solo hay hora
            "llegando": llegando,
            "hora": hora,                # "02:57" cuando la EMT da hora, si no None
            "tiempo_real": minutos is not None,
            "desviada": desviada,
            "texto": "0" if llegando else (str(minutos) if minutos is not None
                                           else "Desviada" if desviada else hora),
            "llega_a": llega_a,          # epoch en segundos
        })

    llegadas.sort(key=lambda b: b["llega_a"] or float("inf"))
    # Las líneas desviadas no tienen hora: al final quedarían fuera de las 3
    # tarjetas de la pantalla. Van en la 3.ª posición para que siempre se vean.
    desviadas = [b for b in llegadas if b["desviada"]]
    if desviadas:
        normales = [b for b in llegadas if not b["desviada"]]
        llegadas = normales[:2] + desviadas + normales[2:]
    return llegadas, avisos


def _es_hora(texto):
    """'02:57' o '02:57:45'."""
    if not texto:
        return False
    partes = texto.strip().split(":")
    return len(partes) in (2, 3) and all(p.isdigit() and len(p) == 2 for p in partes)


def _hora_a_epoch(hhmm, ahora):
    try:
        h, m = map(int, hhmm.split(":"))
    except (ValueError, AttributeError):
        return None
    hoy = datetime.fromtimestamp(ahora, TZ)
    objetivo = hoy.replace(hour=h, minute=m, second=0, microsecond=0)
    ts = objetivo.timestamp()
    if ts < ahora - 3600:      # ya pasó: es de mañana (cruce de medianoche)
        ts += 86400
    return int(ts)


def _arreglar_codificacion(texto):
    if not texto:
        return texto
    try:
        return texto.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return texto


def consultar_sae(stop_id):
    r = session.get(
        SAE_URL,
        params={"sec": "getSAE", "parada": str(stop_id), "adaptados": "false"},
        timeout=SAE_TIMEOUT,
    )
    r.raise_for_status()
    return parsear_sae(r.content)   # bytes: ET respeta el encoding del XML


def obtener_llegadas(stop_id):
    """Caché compartida + último dato bueno si la EMT falla."""
    ahora = time.time()
    with _lock:
        cache = _cache_paradas.get(stop_id)
        if cache and ahora - cache["ts"] < SAE_CACHE_TTL:
            return cache["llegadas"], cache["avisos"], cache["ts"], None

    try:
        llegadas, mensajes = consultar_sae(stop_id)
        with _lock:
            _cache_paradas[stop_id] = {"ts": ahora, "llegadas": llegadas, "avisos": mensajes}
        return llegadas, mensajes, ahora, None
    except Exception as e:
        if cache and ahora - cache["ts"] < MAX_STALE:
            return cache["llegadas"], cache["avisos"], cache["ts"], str(e)
        raise


# --- CLIMA -------------------------------------------------------------------

def _redondear(x):
    """Redondeo 'de toda la vida': 16.5 -> 17 (round() de Python daría 16)."""
    return math.floor(float(x) + 0.5)


def icono_wmo(codigo):
    """Código WMO de Open-Meteo -> icono que dibuja la pantalla."""
    try:
        c = int(codigo)
    except (TypeError, ValueError):
        return ""
    if c == 0:
        return "despejado"
    if c in (1, 2):
        return "parcial"
    if c == 3:
        return "nublado"
    if c in (45, 48):
        return "niebla"
    if 51 <= c <= 67 or 80 <= c <= 82:
        return "lluvia"
    if 71 <= c <= 77 or c in (85, 86):
        return "nieve"
    if c in (95, 96, 99):
        return "tormenta"
    return ""


def obtener_clima():
    ahora = time.time()
    if ahora - _cache_clima["ts"] < WEATHER_CACHE_TTL:
        return _cache_clima["data"]
    # Se marca la hora antes de pedir: si Open-Meteo falla, no se reintenta en
    # cada petición, sino al cabo de 1 minuto.
    _cache_clima["ts"] = ahora - WEATHER_CACHE_TTL + 60
    try:
        datos = session.get(WEATHER_URL, timeout=5).json()
        actual = datos["current_weather"]
        data = {
            "temp": f"{_redondear(actual['temperature'])} C",
            "lluvia": f"{int(datos['daily']['precipitation_probability_max'][0])}%",
            "icono": icono_wmo(actual.get("weathercode")),
            "noche": actual.get("is_day") == 0,
        }
        _cache_clima.update(ts=ahora, data=data)
    except Exception:
        pass   # se mantiene el último valor bueno
    return _cache_clima["data"]


# --- API ---------------------------------------------------------------------

@app.route("/api/parada/<int:stop_id>", methods=["GET"])
def get_tiempos_parada(stop_id):
    if stop_id not in paradas_permitidas():
        abort(404)
    clima = obtener_clima()
    try:
        llegadas, mensajes, ts_dato, error = obtener_llegadas(stop_id)
    except Exception as e:
        app.logger.warning("EMT parada %s: %s", stop_id, e)   # el detalle, solo en el log
        return jsonify({
            "success": False,
            "parada": stop_id,
            "error": "EMT no disponible",
            "clima": clima["temp"],
            "prob_lluvia": clima["lluvia"],
            "icono_clima": clima.get("icono", ""),
            "noche": clima.get("noche", False),
            "llegadas": [],
        }), 502

    ahora = time.time()
    return jsonify({
        "success": True,
        "parada": stop_id,
        "clima": clima["temp"],
        "prob_lluvia": clima["lluvia"],
        "icono_clima": clima.get("icono", ""),   # despejado, parcial, nublado, niebla, lluvia, nieve, tormenta
        "noche": clima.get("noche", False),
        "llegadas": llegadas,
        "avisos": mensajes,
        "servidor_ts": int(ahora),          # para sincronizar la cuenta atrás
        "edad_dato_s": int(ahora - ts_dato),
        "obsoleto": error is not None,      # True = último dato bueno, EMT fallando
    })


@app.route("/api/config")
def get_config():
    """Paradas configuradas (la web las lee de aquí)."""
    return jsonify({"paradas": config.PARADAS})


@app.route("/api/aviso")
def get_aviso():
    """Aviso de salida vigente (para el ESP32). 204 si no hay ninguno."""
    aviso = avisos.aviso_actual()
    if not aviso:
        return "", 204
    aviso["audio"] = f"/api/audio/{aviso['id']}.wav"
    return jsonify(aviso)


@app.route("/api/audio/<aviso_id>.wav")
def get_audio(aviso_id):
    if not (len(aviso_id) == 10 and all(c in "0123456789abcdef" for c in aviso_id)):
        abort(404)
    wav = avisos.audio_de(aviso_id)
    if wav is None:
        return "", 404
    return Response(wav, mimetype="audio/wav",
                    headers={"Content-Length": str(len(wav)), "Cache-Control": "max-age=3600"})


WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
SIM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "simulador")


@app.route("/simulador")
def simulador_raiz():
    return redirect("/simulador/")


@app.route("/simulador/")
@app.route("/simulador/<path:ruta>")
def simulador(ruta="index.html"):
    """Gemelo digital: el aparato simulado en el navegador, con los datos de este servidor."""
    return send_from_directory(SIM_DIR, ruta)


@app.route("/")
@app.route("/<path:ruta>")
def web(ruta="index.html"):
    """Sirve la versión web (build de React copiado a ./web)."""
    if ruta.startswith("api/") or ruta == "api":
        abort(404)   # una ruta de API desconocida nunca devuelve la web
    if not os.path.isdir(WEB_DIR):
        return "Compila la web: cd frontend && npm ci && npm run build", 404
    if not os.path.exists(os.path.join(WEB_DIR, ruta)):
        ruta = "index.html"
    return send_from_directory(WEB_DIR, ruta)


@app.route("/api/salud")
def salud():
    return jsonify({"ok": True, "paradas_en_cache": list(_cache_paradas.keys()),
                    "avisos": avisos.estado()})


def _llegadas_para_avisos(stop_id):
    return obtener_llegadas(stop_id)[0]


if __name__ == "__main__":
    avisos.iniciar(_llegadas_para_avisos)
    try:
        from waitress import serve
        serve(app, host=HOST, port=PORT, threads=4, channel_timeout=30)
    except ImportError:
        app.run(host=HOST, port=PORT, debug=False)
