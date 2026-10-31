"""
Avisos de salida por voz (Fase 2).

El servidor vigila las paradas configuradas y, cuando toca salir de casa para
coger un bus, publica un aviso con su audio (WAV). El ESP32 lo consulta en
/api/aviso y lo reproduce por el MAX98357A.

  salir_en = llegada_del_bus - ahora - minutos_andando
  Aviso cuando salir_en está entre -AVISO_TARDE_S y AVISO_ANTES_S.
"""
import hashlib
import io
import math
import os
import struct
import threading
import time
import wave
from datetime import datetime
from zoneinfo import ZoneInfo

import config

TZ = ZoneInfo("Europe/Madrid")

# --- CONFIGURACIÓN -----------------------------------------------------------
# Paradas, horarios y silencio se editan en config.py
REGLAS = config.REGLAS
SILENCIO = config.SILENCIO
AVISO_ANTES_S = 60     # avisa hasta 1 min antes de la hora de salir
AVISO_TARDE_S = 30     # y hasta 30 s después (aún llegas corriendo)
AVISO_VIGENCIA_S = 90  # tiempo que /api/aviso devuelve el aviso
INTERVALO_S = 10       # cada cuánto se revisan las reglas

VOZ = os.environ.get("PIPER_VOZ", "es_ES-davefx-medium")
VOCES_DIR = os.environ.get("PIPER_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "voces"))
# -----------------------------------------------------------------------------

_lock = threading.Lock()
_avisos = []             # [{id, texto, ts, ...}]
_anunciados = {}         # (parada, linea) -> llega_a del bus ya anunciado
_cache_audio = {}        # id -> bytes WAV
_voz = None
_voz_error = None


# --- Lógica de avisos --------------------------------------------------------

def _minutos_del_dia(hhmm):
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def _en_franja(ahora_min, desde, hasta):
    a, b = _minutos_del_dia(desde), _minutos_del_dia(hasta)
    return a <= ahora_min < b if a <= b else (ahora_min >= a or ahora_min < b)


def reglas_activas(ahora):
    dt = datetime.fromtimestamp(ahora, TZ)
    m = dt.hour * 60 + dt.minute
    if _en_franja(m, *SILENCIO):
        return []
    return [r for r in REGLAS
            if dt.weekday() in r["dias"] and _en_franja(m, r["desde"], r["hasta"])]


def evaluar(regla, llegadas, ahora):
    """Devuelve los avisos nuevos para una regla (como mucho uno por línea)."""
    nuevos = []
    for bus in llegadas:
        if not bus.get("tiempo_real") or bus.get("llega_a") is None:
            continue   # solo avisamos con estimaciones reales, no con horas previstas
        if regla["lineas"] and bus["linea"] not in regla["lineas"]:
            continue

        salir_en = bus["llega_a"] - ahora - regla["andando_min"] * 60
        if not (-AVISO_TARDE_S <= salir_en <= AVISO_ANTES_S):
            continue

        clave = (regla["parada"], bus["linea"])
        previo = _anunciados.get(clave)
        if previo is not None and abs(previo - bus["llega_a"]) < 180:
            continue   # es el mismo bus (su estimación se mueve un poco)

        _anunciados[clave] = bus["llega_a"]
        minutos = max(0, round((bus["llega_a"] - ahora) / 60))
        destino = f" hacia {bus['destino']}" if bus.get("destino") else ""
        texto = (f"Sal ya. La {bus['linea']}{destino} llega en "
                 f"{minutos} {'minuto' if minutos == 1 else 'minutos'}.")
        aviso_id = hashlib.sha1(f"{clave}{bus['llega_a']}".encode()).hexdigest()[:10]
        nuevos.append({
            "id": aviso_id, "texto": texto, "ts": ahora,
            "parada": regla["parada"], "linea": bus["linea"], "minutos": minutos,
        })
        break      # un aviso por regla y ronda: el bus más próximo que encaja
    return nuevos


def revisar(obtener_llegadas, ahora=None):
    ahora = ahora or time.time()
    with _lock:
        # limpieza
        for k, v in list(_anunciados.items()):
            if v < ahora - 1800:
                del _anunciados[k]
        _avisos[:] = [a for a in _avisos if ahora - a["ts"] < AVISO_VIGENCIA_S]

    for regla in reglas_activas(ahora):
        try:
            llegadas = obtener_llegadas(regla["parada"])
        except Exception:
            continue
        with _lock:
            nuevos = evaluar(regla, llegadas, ahora)
            _avisos.extend(nuevos)
        for a in nuevos:
            # Genera el audio ya, para que el ESP32 no espere a la síntesis
            threading.Thread(target=audio_de, args=(a["id"],), daemon=True).start()


def aviso_actual(ahora=None):
    ahora = ahora or time.time()
    with _lock:
        vigentes = [a for a in _avisos if ahora - a["ts"] < AVISO_VIGENCIA_S]
        return dict(vigentes[-1]) if vigentes else None


def iniciar(obtener_llegadas):
    def bucle():
        while True:
            try:
                revisar(obtener_llegadas)
            except Exception as e:
                print("avisos:", e)
            time.sleep(INTERVALO_S)
    threading.Thread(target=bucle, daemon=True, name="avisos").start()


# --- Audio -------------------------------------------------------------------

def _cargar_voz():
    global _voz, _voz_error
    if _voz is not None or _voz_error is not None:
        return _voz
    try:
        from piper import PiperVoice
        _voz = PiperVoice.load(os.path.join(VOCES_DIR, f"{VOZ}.onnx"))
    except Exception as e:
        _voz_error = str(e)
        print(f"Piper no disponible ({e}); se usará un tono de aviso.")
    return _voz


def sintetizar(texto):
    """WAV PCM 16 bits mono. Con Piper si está, si no un tono de dos notas."""
    voz = _cargar_voz()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        if voz is not None:
            voz.synthesize_wav(texto, w)
        else:
            _tono(w)
    return buf.getvalue()


def _tono(w, rate=16000):
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    frames = bytearray()
    for freq, dur in ((880, 0.18), (0, 0.06), (1320, 0.28)):
        n = int(rate * dur)
        for i in range(n):
            env = min(1.0, i / 200, (n - i) / 400)   # sin chasquidos
            v = int(12000 * env * math.sin(2 * math.pi * freq * i / rate)) if freq else 0
            frames += struct.pack("<h", v)
    w.writeframes(bytes(frames))


def audio_de(aviso_id):
    with _lock:
        if aviso_id in _cache_audio:
            return _cache_audio[aviso_id]
        aviso = next((a for a in _avisos if a["id"] == aviso_id), None)
    if aviso is None:
        return None
    wav = sintetizar(aviso["texto"])
    with _lock:
        _cache_audio[aviso_id] = wav
        if len(_cache_audio) > 50:
            _cache_audio.pop(next(iter(_cache_audio)))
    return wav


def estado():
    return {
        "reglas_activas": [r["parada"] for r in reglas_activas(time.time())],
        "voz": VOZ if _voz is not None else None,
        "voz_error": _voz_error,
    }
