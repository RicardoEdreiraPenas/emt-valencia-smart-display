"""
Configuración del Dashboard EMT.

Edita este archivo con tus paradas y tus avisos. Los valores de abajo son
un ejemplo con paradas del centro de València.
"""

# Paradas que muestra la pantalla (en este orden). El servidor solo consulta
# estas y las de REGLAS: cualquier otra devuelve 404 sin tocar la EMT.
# El número de parada aparece en el poste de la parada y en la app de la EMT.
PARADAS = [708, 1676, 2080, 1619, 697]

# Ubicación para el tiempo (Open-Meteo)
CLIMA = {"lat": 39.4697, "lon": -0.3774}

# --- Avisos de salida por voz ------------------------------------------------
# Cuando falte poco para tener que salir de casa (llegada del bus menos los
# minutos andando), el ESP32 dice por ejemplo: "Sal ya. La 19 llega en 6 minutos."
#   dias: 0 = lunes ... 6 = domingo
#   lineas: None = todas, o una lista como ["19", "93"]
REGLAS = [
    {"parada": 708, "andando_min": 5, "lineas": None,
     "dias": [0, 1, 2, 3, 4], "desde": "07:30", "hasta": "09:00"},
]

# Franja en la que nunca suena nada
SILENCIO = ("23:00", "07:00")
