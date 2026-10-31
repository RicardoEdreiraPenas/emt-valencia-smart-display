"""Tests del parser del SAE con respuestas reales de la EMT (31/10/2026, 01:40)."""
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
AHORA = datetime(2026, 10, 31, 1, 40, tzinfo=ZoneInfo("Europe/Madrid")).timestamp()


def leer(nombre):
    return (FIX / nombre).read_bytes()


def test_minutos_y_hora_en_campo_minutos():
    llegadas, avisos = app.parsear_sae(leer("sae_708.xml"), AHORA)
    assert avisos == []
    assert len(llegadas) == 2
    primero, segundo = llegadas
    assert primero["linea"] == "19" and primero["destino"] == "La Malva-rosa"
    assert primero["minutos"] == 37 and primero["tiempo_real"] is True
    assert primero["texto"] == "37"
    # El 2º bus trae "02:57:45" dentro de <minutos>
    assert segundo["minutos"] is None and segundo["hora"] == "02:57"
    assert segundo["tiempo_real"] is False and segundo["texto"] == "02:57"
    assert segundo["llega_a"] > primero["llega_a"]


def test_una_llegada():
    llegadas, _ = app.parsear_sae(leer("sae_1676.xml"), AHORA)
    assert [(b["linea"], b["minutos"], b["destino"]) for b in llegadas] == [("7", 26, "Mercat Central")]


def test_sin_servicio():
    llegadas, avisos = app.parsear_sae(leer("sae_sin_servicio.xml"), AHORA)
    assert llegadas == [] and avisos == ["SENSE ESTIMACIONS"]


def test_proximo():
    xml = ("<estimacion><solo_parada><bus><linea>93</linea><destino>X</destino>"
           "<minutos>Próximo</minutos><horaLlegada/><error/></bus></solo_parada></estimacion>")
    (b,), _ = app.parsear_sae(xml.encode(), AHORA)
    assert b["llegando"] is True and b["minutos"] == 0 and b["texto"] == "0"


def test_hora_pasada_medianoche():
    noche = datetime(2026, 10, 31, 23, 50, tzinfo=ZoneInfo("Europe/Madrid")).timestamp()
    xml = ("<estimacion><solo_parada><bus><linea>N4</linea><destino>X</destino>"
           "<minutos/><horaLlegada>00:10</horaLlegada><error/></bus></solo_parada></estimacion>")
    (b,), _ = app.parsear_sae(xml.encode(), noche)
    assert 0 < b["llega_a"] - noche <= 25 * 60


def test_proxim_en_valenciano_y_parada_grande():
    """Respuesta real de la parada 2277 (Xàtiva) a las 07:38: 'Pròxim', no 'Próximo'."""
    llegadas, avisos = app.parsear_sae(leer("sae_2277_proxim.xml"), AHORA)
    assert avisos == [] and len(llegadas) == 28
    primero = llegadas[0]
    assert (primero["linea"], primero["llegando"], primero["texto"]) == ("C1", True, "0")
    assert primero["destino"] == "Cntr.Històric"
    assert any(b["destino"] == "Sant Marcel.li" for b in llegadas)
    ultimo = llegadas[-1]
    assert ultimo["linea"] == "31" and ultimo["hora"] == "08:40" and not ultimo["tiempo_real"]
    # Ordenadas por llegada
    assert [b["llega_a"] for b in llegadas] == sorted(b["llega_a"] for b in llegadas)


def test_linea_desviada():
    """Respuesta real de la parada 2260 a las 07:47: la 81 venía como 'LÍNIA DESVIADA'."""
    llegadas, avisos = app.parsear_sae(leer("sae_2260_desviada.xml"), AHORA)
    assert avisos == [] and len(llegadas) == 2
    c1, l81 = llegadas                       # la desviada, sin hora, va al final
    assert c1["linea"] == "C1" and c1["minutos"] == 43
    assert l81["linea"] == "81" and l81["desviada"] is True and l81["texto"] == "Desviada"
    assert l81["tiempo_real"] is False and l81["llega_a"] is None


def test_linea_desviada_visible_entre_las_3_primeras():
    """Hallado con el gemelo digital: con 3+ buses, la desviada quedaba fuera de pantalla."""
    buses = "".join(
        f"<bus><linea>{l}</linea><destino>X</destino><minutos>{m}</minutos><horaLlegada/><error/></bus>"
        for l, m in [("7", "2 min."), ("27", "5 min."), ("81", "LÍNIA DESVIADA"), ("7", "15 min."), ("27", "22 min.")])
    llegadas, _ = app.parsear_sae(f"<estimacion><solo_parada>{buses}</solo_parada></estimacion>".encode(), AHORA)
    assert [b["linea"] for b in llegadas] == ["7", "27", "81", "7", "27"]
    assert llegadas[2]["desviada"] is True
