"""Registra las estimaciones de llegada de la EMT para medir su precisión.

Consulta el SAE de la EMT cada INTERVALO segundos en las paradas indicadas y guarda
cada respuesta, sin procesar, en una línea JSON:

    {"t": 1794301200.4, "parada": 708, "estado": 200, "xml": "<estimacion ...>"}

Se guardan las respuestas crudas para poder repetir el análisis con otro método
sin volver a medir. Si se arranca antes de DESDE, espera; al llegar a HASTA, termina.

Uso:
    python medicion/registrar.py --desde 07:00 --hasta 09:30 --salida medicion/datos
"""
import argparse
import gzip
import json
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

# La EMT no responde a las IP de GitHub Actions, así que se consulta a través del
# intermediario de la demo pública (proxy-demo/), que devuelve el XML tal cual.
# Tiene una caché de 20 s: cada respuesta puede tener hasta 20 s de antigüedad.
PROXY = "https://emt-demo-proxy.1ricardox.workers.dev"
ZONA = ZoneInfo("Europe/Madrid")
# Paradas de la demo pública (centro de València), las mismas que proxy-demo
PARADAS = [708, 1676, 2080, 1619, 697]
CABECERAS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) DashboardEMT-medicion/1.0"}


def hoy_a_las(hhmm):
    """Epoch de HH:MM de hoy en Madrid."""
    h, m = map(int, hhmm.split(":"))
    return datetime.now(ZONA).replace(hour=h, minute=m, second=0, microsecond=0).timestamp()


def consultar(sesion, parada, intentos=2):
    """Una consulta, con un reintento si la EMT tarda. t es el momento de la respuesta."""
    for intento in range(intentos):
        try:
            r = sesion.get(f"{PROXY}/sae/{parada}", timeout=15)
            return {"t": round(time.time(), 1), "parada": parada, "estado": r.status_code,
                    "xml": r.text, "cache": r.headers.get("X-Demo-Cache")}
        except requests.RequestException as e:
            error = str(e)
    return {"t": round(time.time(), 1), "parada": parada, "estado": None, "error": error}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--desde", default="07:00", help="hora de Madrid, HH:MM")
    ap.add_argument("--hasta", default="09:30", help="hora de Madrid, HH:MM")
    ap.add_argument("--intervalo", type=int, default=30, help="segundos entre rondas")
    ap.add_argument("--paradas", default=",".join(map(str, PARADAS)))
    ap.add_argument("--salida", default="medicion/datos")
    a = ap.parse_args()

    paradas = [int(p) for p in a.paradas.split(",")]
    desde, hasta = hoy_a_las(a.desde), hoy_a_las(a.hasta)
    if time.time() >= hasta:
        print(f"Ya son más de las {a.hasta}: nada que medir hoy.")
        return
    if time.time() < desde:
        espera = desde - time.time()
        print(f"Esperando {espera / 60:.0f} min hasta las {a.desde}…")
        time.sleep(espera)

    inicio = datetime.now(ZONA)
    destino = Path(a.salida) / f"{inicio:%Y-%m-%d_%H%M}.jsonl.gz"
    destino.parent.mkdir(parents=True, exist_ok=True)
    sesion = requests.Session()
    sesion.headers.update(CABECERAS)

    rondas = fallos = 0
    # Se escribe en un .gz que se cierra en cada ronda: si el trabajo se corta,
    # lo grabado hasta entonces sigue siendo legible.
    while time.time() < hasta:
        ronda = time.time()
        filas = [consultar(sesion, p) for p in paradas]
        fallos += sum(1 for f in filas if f.get("estado") != 200)
        with gzip.open(destino, "at", encoding="utf-8") as f:
            for fila in filas:
                f.write(json.dumps(fila, ensure_ascii=False) + "\n")
        rondas += 1
        if rondas % 20 == 0:
            print(f"{datetime.now(ZONA):%H:%M} · {rondas} rondas, {fallos} respuestas fallidas")
        time.sleep(max(0, a.intervalo - (time.time() - ronda)))

    print(f"Fin: {rondas} rondas en {len(paradas)} paradas, {fallos} fallidas -> {destino}")


if __name__ == "__main__":
    main()
