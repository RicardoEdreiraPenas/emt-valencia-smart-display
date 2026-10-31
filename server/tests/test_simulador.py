"""El servidor sirve el gemelo digital."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app  # noqa: E402

c = app.app.test_client()


def test_simulador_se_sirve():
    r = c.get("/simulador/")
    assert r.status_code == 200 and b"sim.js" in r.data
    assert c.get("/simulador/sim.js").status_code == 200
    assert c.get("/simulador/sim.css").status_code == 200
    assert c.get("/simulador").status_code in (301, 302, 308)


def test_simulador_sin_traversal():
    assert c.get("/simulador/../app.py").status_code == 404
    assert c.get("/simulador/%2e%2e/app.py").status_code == 404


def test_simulador_cumple_la_csp():
    """Sin scripts ni estilos en línea: la CSP del servidor los bloquearía."""
    html = c.get("/simulador/").get_data(as_text=True)
    assert "<script>" not in html and "<style>" not in html and "style=" not in html
