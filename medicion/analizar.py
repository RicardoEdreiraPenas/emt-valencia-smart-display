"""Mide la precisión de las estimaciones de la EMT con los datos de registrar.py.

La EMT no da un identificador de vehículo: solo línea, destino y minutos. Por eso
el script reconstruye cada autobús siguiéndolo entre consultas (30 s), y toma como
paso real por la parada el momento en que desaparece de la lista después de haber
estado a 2 minutos o menos. Después compara cada estimación con ese paso real.

    desvío = paso real − hora prevista   (en minutos)
    desvío > 0: el autobús llegó más tarde de lo anunciado
    desvío < 0: llegó antes (es el caso en que se escapa el autobús)

Las respuestas se interpretan con parsear_sae() de server/app.py, el mismo código
que usa la pantalla.

Uso:
    git worktree add ../emt-medicion medicion
    pip install -r server/requirements.txt -r medicion/requirements.txt
    python medicion/analizar.py ../emt-medicion/datos
"""
import gzip
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "server"))
from app import parsear_sae  # noqa: E402

RESULTADOS = RAIZ / "medicion" / "resultados"
IMG = RAIZ / "docs" / "img"

MAX_HUECO_S = 120         # si entre dos consultas pasa más, no se puede fechar el paso
ULTIMO_MAX_MIN = 2        # minutos máximos en la última aparición para contar como llegada
HORIZONTES = [(0, 2), (2, 5), (5, 10), (10, 15), (15, 20), (20, 30)]


def leer(carpeta):
    """Devuelve {parada: [(t, llegadas)]} con las respuestas válidas, ordenadas por t."""
    por_parada = defaultdict(list)
    fallos = 0
    for fichero in sorted(Path(carpeta).glob("*.jsonl.gz")):
        with gzip.open(fichero, "rt", encoding="utf-8") as f:
            for linea in f:
                fila = json.loads(linea)
                if fila.get("estado") != 200:
                    fallos += 1
                    continue
                try:
                    llegadas, _ = parsear_sae(fila["xml"], ahora=fila["t"])
                except Exception:
                    fallos += 1
                    continue
                por_parada[fila["parada"]].append((fila["t"], llegadas))
    for lista in por_parada.values():
        lista.sort(key=lambda x: x[0])
    return por_parada, fallos


def tolerancia(t, eta):
    """Cuánto puede cambiar la estimación de un mismo autobús entre consultas (s)."""
    return 150 + 0.25 * max(0, eta - t)


def emparejar(pistas, buses, t):
    """Empareja en orden las pistas activas con los autobuses de esta consulta.

    Los autobuses de una misma línea y destino no se adelantan entre sí, así que es un
    alineamiento en orden: cada pista se empareja con un autobús o queda sin pareja
    (pasó por la parada o la EMT dejó de mostrarlo), y cada autobús sin pareja es nuevo
    (la EMT puede empezar a mostrar uno por delante o por detrás). Se maximiza el número
    de parejas dentro de la tolerancia y, a igualdad, se minimiza la diferencia total.

    Devuelve (pistas_sin_pareja, parejas, autobuses_nuevos).
    """
    n, m = len(pistas), len(buses)
    # mejor[i][j] = (parejas, -diferencia) alineando pistas[i:] con buses[j:]
    mejor = [[(0, 0.0)] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            opciones = [mejor[i + 1][j], mejor[i][j + 1]]
            dif = abs(buses[j]["llega_a"] - pistas[i]["eta"])
            if dif <= tolerancia(t, pistas[i]["eta"]):
                sig = mejor[i + 1][j + 1]
                opciones.append((sig[0] + 1, sig[1] - dif))
            mejor[i][j] = max(opciones)
    sueltas, pares, usados = [], [], set()
    i = j = 0
    while i < n and j < m:
        dif = abs(buses[j]["llega_a"] - pistas[i]["eta"])
        sig = mejor[i + 1][j + 1]
        if dif <= tolerancia(t, pistas[i]["eta"]) and mejor[i][j] == (sig[0] + 1, sig[1] - dif):
            pares.append((pistas[i], buses[j]))
            usados.add(j)
            i, j = i + 1, j + 1
        elif mejor[i][j] == mejor[i + 1][j]:
            sueltas.append(pistas[i])
            i += 1
        else:
            j += 1
    sueltas += pistas[i:]
    return sueltas, pares, [b for k, b in enumerate(buses) if k not in usados]


def reconstruir(serie):
    """De una serie [(t, llegadas)] de una parada saca los pasos reales con sus estimaciones."""
    activas = defaultdict(list)    # (linea, destino) -> pistas
    pasos, perdidas = [], Counter()
    anterior_t = None

    def cerrar(pista, t_ausente, t_previo):
        ultima = pista["obs"][-1]
        if ultima["minutos"] > ULTIMO_MAX_MIN:
            perdidas["desaparece lejos de la parada"] += 1
        elif t_ausente - t_previo > MAX_HUECO_S:
            perdidas["hueco entre consultas"] += 1
        else:
            pista["paso"] = (ultima["t"] + t_ausente) / 2
            pasos.append(pista)

    for t, llegadas in serie:
        grupos = defaultdict(list)
        for b in llegadas:
            if b["tiempo_real"]:
                grupos[(b["linea"], b["destino"])].append(b)
        for clave in set(activas) | set(grupos):
            buses = sorted(grupos.get(clave, []), key=lambda b: b["llega_a"])
            pistas = activas[clave]
            terminadas, pares, nuevas = emparejar(pistas, buses, t)
            for p in terminadas:
                cerrar(p, t, anterior_t)
            siguen = []
            for p, b in pares:
                p["eta"] = b["llega_a"]
                p["obs"].append({"t": t, "minutos": b["minutos"], "llega_a": b["llega_a"],
                                 "orden": buses.index(b) + 1})
                siguen.append(p)
            for b in nuevas:
                siguen.append({"linea": clave[0], "destino": clave[1], "eta": b["llega_a"],
                               "obs": [{"t": t, "minutos": b["minutos"], "llega_a": b["llega_a"],
                                        "orden": buses.index(b) + 1}]})
            activas[clave] = sorted(siguen, key=lambda p: p["eta"])
        anterior_t = t
    # Las pistas que siguen abiertas al terminar no tienen paso conocido
    perdidas["sin pasar al terminar"] += sum(len(v) for v in activas.values())
    return pasos, perdidas


def main():
    carpeta = sys.argv[1] if len(sys.argv) > 1 else "datos"
    por_parada, fallos = leer(carpeta)
    if not por_parada:
        sys.exit(f"No hay datos en {carpeta}/*.jsonl.gz")

    import pandas as pd   # solo para el análisis

    filas, resumen_paradas = [], []
    for parada, serie in sorted(por_parada.items()):
        pasos, perdidas = reconstruir(serie)
        resumen_paradas.append({"parada": parada, "consultas": len(serie),
                                "pasos": len(pasos), **perdidas})
        for p in pasos:
            for o in p["obs"]:
                filas.append({"parada": parada, "linea": p["linea"], "destino": p["destino"],
                              "t": o["t"], "minutos": o["minutos"], "orden": o["orden"],
                              "horizonte_min": (p["paso"] - o["t"]) / 60,
                              "desvio_min": (p["paso"] - o["llega_a"]) / 60,
                              "paso": p["paso"]})
    df = pd.DataFrame(filas)
    if df.empty:
        sys.exit("No se ha podido reconstruir ningún paso.")
    df["dia"] = pd.to_datetime(df.t, unit="s", utc=True).dt.tz_convert("Europe/Madrid").dt.date

    RESULTADOS.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(resumen_paradas).to_csv(RESULTADOS / "paradas.csv", index=False)
    df.to_csv(RESULTADOS / "estimaciones.csv.gz", index=False)

    etiquetas = [f"{a}-{b}" for a, b in HORIZONTES]
    df["horizonte"] = pd.cut(df.horizonte_min, [a for a, _ in HORIZONTES] + [HORIZONTES[-1][1]],
                             labels=etiquetas, right=False)
    tabla = (df.dropna(subset=["horizonte"]).groupby("horizonte", observed=True).desvio_min
             .agg(estimaciones="size",
                  mediana="median",
                  error_medio=lambda s: s.abs().mean(),
                  pct_1min=lambda s: 100 * (s.abs() <= 1).mean(),
                  pct_antes=lambda s: 100 * (s <= -1).mean(),
                  p10=lambda s: s.quantile(0.10),
                  p90=lambda s: s.quantile(0.90))
             .round(2).reset_index())
    tabla.to_csv(RESULTADOS / "horizontes.csv", index=False)

    lineas = (df[df.horizonte_min.between(5, 10)].groupby("linea").desvio_min
              .agg(estimaciones="size", mediana="median",
                   error_medio=lambda s: s.abs().mean(),
                   pct_antes=lambda s: 100 * (s <= -1).mean())
              .round(2).reset_index().sort_values("estimaciones", ascending=False))
    lineas.to_csv(RESULTADOS / "lineas_5_10min.csv", index=False)

    orden = (df[df.horizonte_min.between(5, 10)].groupby("orden").desvio_min
             .agg(estimaciones="size", mediana="median",
                  error_medio=lambda s: s.abs().mean(),
                  pct_antes=lambda s: 100 * (s <= -1).mean())
             .round(2).reset_index())
    orden.to_csv(RESULTADOS / "orden_5_10min.csv", index=False)

    pasos = df.drop_duplicates(["parada", "linea", "destino", "paso"])
    print(f"Días: {sorted(set(map(str, df.dia)))}")
    print(f"Respuestas descartadas: {fallos}")
    print(pd.DataFrame(resumen_paradas).to_string(index=False))
    print(f"\nPasos reconstruidos: {len(pasos)} · estimaciones comparadas: {len(df)}")
    print("\nDesvío (paso real − previsto, min) por minutos que faltaban de verdad:")
    print(tabla.to_string(index=False))
    print("\nPrimer o segundo autobús de la línea en la pantalla, estimaciones a 5-10 min:")
    print(orden.to_string(index=False))
    print("\nLíneas, estimaciones a 5-10 min:")
    print(lineas.to_string(index=False))

    graficos(tabla)


def graficos(tabla):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    AZUL, ROJO, GRIS = "#2a78d6", "#e34948", "#a8a7a2"
    TINTA, TINTA_2, REJILLA = "#0b0b0b", "#52514e", "#e6e5e0"
    IMG.mkdir(parents=True, exist_ok=True)
    x = list(range(len(tabla)))

    fig, ax = plt.subplots(figsize=(8, 4.2), dpi=150)
    ax.fill_between(x, tabla.p10, tabla.p90, color=AZUL, alpha=0.15, linewidth=0,
                    label="80 % de los casos (P10-P90)")
    ax.plot(x, tabla.mediana, color=AZUL, linewidth=2, marker="o", markersize=7,
            markeredgecolor="white", markeredgewidth=2, label="mediana")
    ax.axhline(0, color=GRIS, linewidth=1)
    ax.set_xticks(x, [f"{h} min" for h in tabla.horizonte])
    ax.set_title("Cuánto se desvía la estimación de la EMT según lo lejos que esté el autobús",
                 loc="left", fontsize=12, color=TINTA, pad=12)
    ax.set_ylabel("Paso real − previsto (min)", color=TINTA_2)
    ax.set_xlabel("Minutos que faltaban de verdad", color=TINTA_2)
    ax.annotate("llega más tarde de lo anunciado", (0, 1), xycoords="axes fraction",
                xytext=(6, -14), textcoords="offset points", color=TINTA_2, fontsize=8)
    ax.annotate("llega antes: se puede escapar", (0, 0), xycoords="axes fraction",
                xytext=(6, 6), textcoords="offset points", color=TINTA_2, fontsize=8)
    estilo(ax, REJILLA, GRIS, TINTA_2)
    ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2,
              labelcolor=TINTA_2, fontsize=9)
    fig.tight_layout()
    fig.savefig(IMG / "precision-desvio.png", facecolor="white")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(8, 3.8), dpi=150)
    ancho = 0.38
    ax.bar([i - ancho / 2 - 0.01 for i in x], tabla.pct_1min, ancho, color=AZUL,
           label="acierta con ±1 min")
    ax.bar([i + ancho / 2 + 0.01 for i in x], tabla.pct_antes, ancho, color=ROJO,
           label="llega 1 min o más antes de lo anunciado")
    ax.set_xticks(x, [f"{h} min" for h in tabla.horizonte])
    ax.set_ylim(0, 100)
    ax.set_title("Aciertos y autobuses que se adelantan, por distancia",
                 loc="left", fontsize=12, color=TINTA, pad=12)
    ax.set_ylabel("% de estimaciones", color=TINTA_2)
    ax.set_xlabel("Minutos que faltaban de verdad", color=TINTA_2)
    estilo(ax, REJILLA, GRIS, TINTA_2)
    ax.legend(frameon=False, labelcolor=TINTA_2, fontsize=9)
    fig.tight_layout()
    fig.savefig(IMG / "precision-aciertos.png", facecolor="white")
    plt.close(fig)


def estilo(ax, rejilla, gris, tinta_2):
    ax.grid(axis="y", color=rejilla, linewidth=0.8)
    ax.set_axisbelow(True)
    for lado in ("top", "right", "left"):
        ax.spines[lado].set_visible(False)
    ax.spines["bottom"].set_color(gris)
    ax.tick_params(colors=tinta_2, length=0)


if __name__ == "__main__":
    main()
