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
