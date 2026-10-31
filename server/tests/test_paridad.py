"""El JSON de paridad con el Worker (cloud/test/paridad.json) está al día."""
import paridad


def test_paridad_al_dia():
    esperado = paridad.SALIDA.read_text(encoding="utf-8")
    assert paridad.generar() == esperado, (
        "La lógica en Python ha cambiado: regenera con `python tests/paridad.py` "
        "y ajusta cloud/src/nucleo.js hasta que pasen los tests de cloud/")
