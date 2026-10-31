"""Iconos del tiempo a partir de Open-Meteo."""
import json
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402

FIX = Path(__file__).parent / "fixtures"


def test_codigos_wmo():
    casos = {0: "despejado", 1: "parcial", 2: "parcial", 3: "nublado", 45: "niebla", 48: "niebla",
             51: "lluvia", 61: "lluvia", 65: "lluvia", 80: "lluvia", 82: "lluvia",
             71: "nieve", 77: "nieve", 85: "nieve", 95: "tormenta", 99: "tormenta",
             4: "", None: "", "x": ""}
    for codigo, icono in casos.items():
        assert app.icono_wmo(codigo) == icono, codigo


def test_respuesta_real_de_open_meteo():
    """Respuesta real del 31/10/2026 a las 17:00: intervalos nubosos, de día, 18,5 C."""
    datos = json.loads((FIX / "openmeteo_2026-10-31_1700.json").read_text())
    r = mock.Mock(); r.json = lambda: datos
    app._cache_clima["ts"] = 0
    with mock.patch.object(app.session, "get", return_value=r):
        clima = app.obtener_clima()
    assert clima == {"temp": "19 C", "lluvia": "75%", "icono": "parcial", "noche": False}


def test_api_incluye_icono():
    app._cache_paradas.clear()
    xml = (FIX / "sae_708.xml").read_bytes()
    r = mock.Mock(content=xml); r.raise_for_status = lambda: None
    with mock.patch.object(app.session, "get", return_value=r), \
         mock.patch.object(app, "obtener_clima", return_value={"temp": "8 C", "lluvia": "0%", "icono": "despejado", "noche": True}):
        app.PARADAS_PERMITIDAS.add(708)
        j = app.app.test_client().get("/api/parada/708").json
    assert j["icono_clima"] == "despejado" and j["noche"] is True
