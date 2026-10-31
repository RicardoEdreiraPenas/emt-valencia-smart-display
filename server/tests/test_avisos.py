"""Tests de los avisos de salida."""
import io
import sys
import wave
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app      # noqa: E402
import avisos   # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
LUNES_0800 = datetime(2026, 11, 2, 8, 0, tzinfo=TZ).timestamp()
REGLA = {"parada": 708, "andando_min": 4, "lineas": None,
         "dias": [0, 1, 2, 3, 4], "desde": "07:30", "hasta": "09:00"}


@pytest.fixture(autouse=True)
def limpio(monkeypatch):
    monkeypatch.setattr(avisos, "REGLAS", [REGLA])
    avisos._avisos.clear()
    avisos._anunciados.clear()
    avisos._cache_audio.clear()
    monkeypatch.setattr(avisos, "_voz", None)
    monkeypatch.setattr(avisos, "_voz_error", "sin voz en tests")


def bus(linea, minutos, ahora, real=True, destino="Alboraia"):
    return {"linea": linea, "destino": destino, "tiempo_real": real,
            "minutos": minutos if real else None, "llega_a": int(ahora + minutos * 60)}


def test_franjas_y_silencio():
    assert avisos.reglas_activas(LUNES_0800) == [REGLA]
    sabado = datetime(2026, 11, 7, 8, 0, tzinfo=TZ).timestamp()
    assert avisos.reglas_activas(sabado) == []
    avisos.REGLAS[:] = [dict(REGLA, desde="22:00", hasta="23:59")]
    noche = datetime(2026, 11, 2, 23, 30, tzinfo=TZ).timestamp()
    assert avisos.reglas_activas(noche) == []          # silencio 23:00-07:00


def test_avisa_cuando_toca_salir():
    # Andando 4 min: un bus a 4,5 min => hay que salir en 30 s
    avisos.revisar(lambda p: [bus("70", 4.5, LUNES_0800)], LUNES_0800)
    a = avisos.aviso_actual(LUNES_0800)
    assert a and a["linea"] == "70"
    assert a["texto"] == "Sal ya. La 70 hacia Alboraia llega en 4 minutos."


def test_no_avisa_si_falta_mucho_o_ya_no_llegas():
    avisos.revisar(lambda p: [bus("70", 12, LUNES_0800), bus("93", 2, LUNES_0800)], LUNES_0800)
    assert avisos.aviso_actual(LUNES_0800) is None


def test_no_repite_el_mismo_bus():
    avisos.revisar(lambda p: [bus("70", 4.5, LUNES_0800)], LUNES_0800)
    t2 = LUNES_0800 + 10
    # La estimación se mueve 40 s: sigue siendo el mismo bus
    avisos.revisar(lambda p: [bus("70", 4.5 - 10 / 60 + 0.66, t2)], t2)
    assert len(avisos._avisos) == 1


def test_ignora_horas_previstas():
    avisos.revisar(lambda p: [bus("70", 4.5, LUNES_0800, real=False)], LUNES_0800)
    assert avisos.aviso_actual(LUNES_0800) is None


def test_filtro_de_lineas():
    avisos.REGLAS[:] = [dict(REGLA, lineas=["93"])]
    avisos.revisar(lambda p: [bus("70", 4.5, LUNES_0800), bus("93", 5, LUNES_0800)], LUNES_0800)
    assert avisos.aviso_actual(LUNES_0800)["linea"] == "93"


def test_endpoints_y_wav(monkeypatch):
    c = app.app.test_client()
    assert c.get("/api/aviso").status_code == 204
    import time
    ahora = time.time()
    avisos._avisos.append({"id": "abc1230def", "texto": "Sal ya.", "ts": ahora,
                           "parada": 708, "linea": "70", "minutos": 4})
    r = c.get("/api/aviso")
    assert r.status_code == 200 and r.json["audio"] == "/api/audio/abc1230def.wav"
    r = c.get(r.json["audio"])
    assert r.status_code == 200 and r.mimetype == "audio/wav"
    with wave.open(io.BytesIO(r.data)) as w:
        assert (w.getnchannels(), w.getsampwidth()) == (1, 2) and w.getnframes() > 0
