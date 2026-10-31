"""
Casos de paridad Python -> Cloudflare Worker.

Genera cloud/test/paridad.json con lo que devuelve el servidor en Python para
unas entradas fijas (los XML reales de la EMT de tests/fixtures, el tiempo de
Open-Meteo, reglas de aviso...). Los tests de cloud/ comprueban que el Worker
devuelve exactamente lo mismo, y test_paridad.py que el JSON está al día.

    python tests/paridad.py   # regenerar tras cambiar la lógica en Python
"""
import base64
import hashlib
import io
import json
import sys
import wave
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI.parent))
import app      # noqa: E402
import avisos   # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
SALIDA = AQUI.parents[1] / "cloud" / "test" / "paridad.json"


def ts(*a):
    return datetime(*a, tzinfo=TZ).timestamp()


INSTANTES = {
    "lunes_0800": ts(2026, 11, 2, 8, 0),
    "noche_2350": ts(2026, 11, 2, 23, 50, 30),
    "verano_1700": ts(2026, 7, 15, 17, 0, 12),
    "cambio_hora": ts(2026, 10, 25, 1, 30),
}

REGLAS = [
    {"parada": 708, "andando_min": 4, "lineas": None, "dias": [0, 1, 2, 3, 4], "desde": "07:30", "hasta": "09:00"},
    {"parada": 1676, "andando_min": 2, "lineas": ["7", "81"], "dias": [5, 6], "desde": "22:00", "hasta": "02:00"},
    {"parada": 2080, "andando_min": 0, "lineas": None, "dias": [0, 1, 2, 3, 4, 5, 6], "desde": "00:00", "hasta": "23:59"},
]
SILENCIO = ("23:00", "07:00")


def casos():
    sae = []
    for xml in sorted((AQUI / "fixtures").glob("sae_*.xml")):
        for nombre, ahora in INSTANTES.items():
            llegadas, mensajes = app.parsear_sae(xml.read_bytes(), ahora)
            sae.append({"fixture": xml.name, "ahora": ahora, "instante": nombre,
                        "llegadas": llegadas, "avisos": mensajes})

    clima_json = json.loads((AQUI / "fixtures" / "openmeteo_2026-10-31_1700.json").read_text())
    actual = clima_json["current_weather"]
    clima = {"fixture": "openmeteo_2026-10-31_1700.json", "esperado": {
        "temp": f"{app._redondear(actual['temperature'])} C",
        "lluvia": f"{int(clima_json['daily']['precipitation_probability_max'][0])}%",
        "icono": app.icono_wmo(actual.get("weathercode")),
        "noche": actual.get("is_day") == 0,
    }}

    franjas = []
    for h in range(0, 24 * 7, 1):
        for minuto in (0, 29, 59):
            ahora = ts(2026, 11, 2, 0, 0) + h * 3600 + minuto * 60
            activas = [r["parada"] for r in _reglas_activas(ahora)]
            franjas.append({"ahora": ahora, "activas": activas})

    # Secuencia de avisos con estado compartido (un aviso por bus)
    base = INSTANTES["lunes_0800"]
    regla = REGLAS[0]
    pasos = []
    secuencia = [
        (0, [("19", 9.5), ("93", 12)]),        # 19: salir en 5,5 min -> nada
        (240, [("19", 5.5), ("93", 8)]),       # salir en 90 s -> aún no
        (290, [("19", 4.6), ("93", 8)]),       # salir en 36 s -> aviso 19
        (300, [("19", 4.5), ("93", 8)]),       # mismo bus -> nada
        (330, [("19", 4.3), ("93", 4.9)]),     # 93 en ventana -> aviso 93
        (400, [("93", 3.6), ("70", 4.8)]),     # 70 en ventana -> aviso 70
        (900, [("19", 4.2, False)]),           # hora prevista -> nunca avisa
        (2400, [("19", 4.0)]),                 # otro bus de la 19 -> aviso
        (2402, [("19", 2.5)]),                 # 2,5 min: el destino puede llegar tarde (-90 s) -> nada
        (2700, [("19", 4.5, True, "")]),       # sin destino
    ]
    avisos._anunciados.clear()
    for dt, buses in secuencia:
        ahora = base + dt
        llegadas = []
        for b in buses:
            linea, minutos = b[0], b[1]
            real = b[2] if len(b) > 2 else True
            destino = b[3] if len(b) > 3 else "La Malva-rosa"
            llegadas.append({"linea": linea, "destino": destino, "tiempo_real": real,
                             "minutos": round(minutos) if real else None,
                             "llega_a": int(ahora + minutos * 60)})
        nuevos = avisos.evaluar(regla, llegadas, ahora)
        pasos.append({"ahora": ahora, "llegadas": llegadas, "nuevos": nuevos})
    avisos._anunciados.clear()

    # Filtro por líneas
    regla_lineas = dict(regla, lineas=["93"])
    llegadas = [{"linea": "19", "destino": "X", "tiempo_real": True, "minutos": 5, "llega_a": int(base + 270)},
                {"linea": "93", "destino": "Y", "tiempo_real": True, "minutos": 5, "llega_a": int(base + 280)}]
    por_lineas = {"regla": regla_lineas, "ahora": base, "llegadas": llegadas,
                  "nuevos": avisos.evaluar(regla_lineas, llegadas, base)}
    avisos._anunciados.clear()

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        avisos._tono(w)
    tono = buf.getvalue()

    return {
        "sae": sae,
        "clima": clima,
        "iconos": {str(c): app.icono_wmo(c) for c in list(range(0, 101)) + ["x", None]},
        "reglas": REGLAS, "silencio": list(SILENCIO), "franjas": franjas,
        "regla_avisos": regla, "avisos": pasos, "por_lineas": por_lineas,
        "tono": {"bytes": len(tono), "sha256": hashlib.sha256(tono).hexdigest(),
                 "inicio_b64": base64.b64encode(tono[:64]).decode()},
    }


def _reglas_activas(ahora):
    viejas = (avisos.REGLAS, avisos.SILENCIO)
    avisos.REGLAS, avisos.SILENCIO = REGLAS, SILENCIO
    try:
        return avisos.reglas_activas(ahora)
    finally:
        avisos.REGLAS, avisos.SILENCIO = viejas


def generar():
    return json.dumps(casos(), ensure_ascii=False, indent=1, sort_keys=True) + "\n"


if __name__ == "__main__":
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(generar(), encoding="utf-8")
    print(f"Escrito {SALIDA.relative_to(AQUI.parents[1])}")
