"""Tests de seguridad del servidor."""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402
import config  # noqa: E402

PARADA = config.PARADAS[0]

c = app.app.test_client()


def _sae_vacio():
    r = mock.Mock(content=b"<estimacion><solo_parada/></estimacion>")
    r.raise_for_status = lambda: None
    return r


def test_paradas_no_permitidas_no_tocan_la_emt():
    app._cache_paradas.clear()
    with mock.patch.object(app.session, "get", return_value=_sae_vacio()) as get:
        for i in range(5000, 5200):
            assert c.get(f"/api/parada/{i}").status_code == 404
        assert get.call_count == 0
    assert app._cache_paradas == {}


def test_parada_permitida_funciona():
    with mock.patch.object(app.session, "get", return_value=_sae_vacio()), \
         mock.patch.object(app, "obtener_clima", return_value={"temp": "1 C", "lluvia": "0%"}):
        assert c.get(f"/api/parada/{PARADA}").status_code == 200


def test_sin_cors_para_webs_ajenas():
    r = c.get("/api/salud", headers={"Origin": "https://web-maliciosa.com"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_cabeceras_de_seguridad():
    r = c.get("/api/salud")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]


def test_error_no_filtra_detalles():
    app._cache_paradas.clear()
    with mock.patch.object(app.session, "get", side_effect=Exception("https://interno/secreto")), \
         mock.patch.object(app, "obtener_clima", return_value={"temp": "1 C", "lluvia": "0%"}):
        r = c.get(f"/api/parada/{PARADA}")
    assert r.status_code == 502 and "secreto" not in r.get_data(as_text=True)


def test_clima_no_reintenta_en_bucle():
    app._cache_clima["ts"] = 0
    with mock.patch.object(app.session, "get", side_effect=Exception("caído")) as get:
        for _ in range(50):
            app.obtener_clima()
    assert get.call_count == 1


def test_audio_id_invalido():
    for malo in ["../../etc/passwd", "x" * 500, "ABCDEFGHIJ"]:
        assert c.get(f"/api/audio/{malo}.wav").status_code == 404


def test_bomba_xml_bloqueada():
    bomba = (b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa">'
             + b"".join(f'<!ENTITY {chr(98+i)} "{("&" + chr(97+i) + ";") * 10}">'.encode() for i in range(7))
             + b']><estimacion>&h;</estimacion>')
    try:
        app.parsear_sae(bomba)
        assert False, "la bomba XML no debería procesarse"
    except Exception as e:
        assert "amplification" in str(e) or "entit" in str(e).lower()


def test_config_expone_solo_paradas():
    r = c.get("/api/config")
    assert r.status_code == 200 and r.json == {"paradas": config.PARADAS}


def test_api_desconocida_no_devuelve_la_web(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<h1>web</h1>")
    monkeypatch.setattr(app, "WEB_DIR", str(tmp_path))
    assert c.get("/").status_code == 200
    assert c.get("/cualquier/ruta").status_code == 200          # rutas de la SPA
    assert c.get("/api/no-existe").status_code == 404
    assert c.get("/api/audio/../../etc/passwd.wav").status_code == 404
