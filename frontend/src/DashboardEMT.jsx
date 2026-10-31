import React, { useState, useEffect, useRef } from 'react';

// Vacío = mismo servidor que sirve la web (Flask en la Radxa). Sin CORS ni contenido mixto.
const API_BASE = '';

// Icono del tiempo que manda el servidor (código WMO de Open-Meteo ya traducido)
const ICONOS_CLIMA = {
  despejado: ['☀️', '🌙', 'Despejado'],
  parcial: ['⛅', '☁️', 'Intervalos nubosos'],
  nublado: ['☁️', '☁️', 'Nublado'],
  niebla: ['🌫️', '🌫️', 'Niebla'],
  lluvia: ['🌧️', '🌧️', 'Lluvia'],
  nieve: ['🌨️', '🌨️', 'Nieve'],
  tormenta: ['⛈️', '⛈️', 'Tormenta'],
};

export default function DashboardEMT() {
  const [paradas, setParadas] = useState([]);
  const [paradaIdx, setParadaIdx] = useState(0);
  const [datos, setDatos] = useState({ llegadas: [], avisos: [], clima: '-- C', prob_lluvia: '--%' });
  const [hora, setHora] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const paradaRef = useRef(paradaIdx);

  // Reloj
  useEffect(() => {
    const tick = () =>
      setHora(new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  // Paradas configuradas en el servidor (server/config.py)
  useEffect(() => {
    fetch(`${API_BASE}/api/config`)
      .then((r) => r.json())
      .then((c) => setParadas(c.paradas || []))
      .catch(() => setError('Sin conexión con el servidor'));
  }, []);

  // Datos: "Actualizando..." solo al cambiar de parada, no en cada refresco
  useEffect(() => {
    if (paradas.length === 0) return undefined;
    paradaRef.current = paradaIdx;
    let activo = true;
    setCargando(true);

    const fetchDatos = async () => {
      const idx = paradaIdx;
      try {
        const res = await fetch(`${API_BASE}/api/parada/${paradas[idx]}`);
        const data = await res.json();
        if (!activo || paradaRef.current !== idx) return;   // respuesta de otra parada
        if (data.success) {
          setDatos(data);
          setError(null);
        } else {
          setError(data.error || 'EMT no disponible');
        }
      } catch (e) {
        if (activo) setError('Sin conexión con el servidor');
      } finally {
        if (activo) setCargando(false);
      }
    };

    fetchDatos();
    const interval = setInterval(fetchDatos, 20000);
    return () => { activo = false; clearInterval(interval); };
  }, [paradaIdx, paradas]);

  const handleTouch = (e) => {
    if (paradas.length === 0) return;
    const x = e.clientX ?? e.changedTouches?.[0]?.clientX;
    if (x == null) return;
    if (x > window.innerWidth / 2) {
      setParadaIdx((prev) => (prev + 1) % paradas.length);
    } else {
      setParadaIdx((prev) => (prev - 1 + paradas.length) % paradas.length);
    }
  };

  const sinServicio = datos.avisos?.includes('SENSE ESTIMACIONS');

  return (
    <div
      className="bg-black text-white h-screen w-screen flex flex-col font-sans select-none overflow-hidden cursor-pointer"
      onClick={handleTouch}
    >
      <div className="flex justify-between items-center p-5 text-xl font-bold tracking-wide">
        <span className="flex items-center gap-2">
          EMT {paradas[paradaIdx]}
          {datos.obsoleto && (
            <span className="w-2 h-2 rounded-full bg-[#ff9f0a]" title="Último dato disponible" />
          )}
        </span>
        <div className="flex space-x-4">
          {ICONOS_CLIMA[datos.icono_clima] && (
            <span role="img" aria-label={ICONOS_CLIMA[datos.icono_clima][2]} title={ICONOS_CLIMA[datos.icono_clima][2]}>
              {ICONOS_CLIMA[datos.icono_clima][datos.noche ? 1 : 0]}
            </span>
          )}
          <span className="text-[#0a84ff]">{datos.clima}</span>
          <span className="text-[#5ac8fa]" title="Probabilidad de lluvia hoy">☔ {datos.prob_lluvia}</span>
        </div>
        <span>{hora}</span>
      </div>

      <div className="flex-1 px-5 pt-2">
        {cargando ? (
          <div className="text-[#0a84ff] text-xl font-bold mt-4">Actualizando...</div>
        ) : error && datos.llegadas.length === 0 ? (
          <div className="bg-[#1c1c1e] rounded-2xl p-6 text-[#ff453a] text-xl font-bold mt-4">{error}</div>
        ) : datos.llegadas.length === 0 ? (
          <div className="bg-[#1c1c1e] rounded-2xl p-6 text-[#8e8e93] text-xl font-bold mt-4">
            {sinServicio ? 'Sin servicio ahora' : 'Sin autobuses cercanos'}
          </div>
        ) : (
          datos.llegadas.slice(0, 4).map((bus, i) => (
            <div key={`${bus.linea}-${i}`} className="bg-[#1c1c1e] rounded-2xl p-4 flex items-center mb-4 shadow-lg">
              <div className="bg-[#ff453a] text-white rounded-lg px-4 py-2 text-2xl font-bold min-w-[4rem] text-center">
                {bus.linea}
              </div>
              <div className="ml-4 text-[#8e8e93] text-lg font-semibold truncate">{bus.destino}</div>
              <div className="ml-auto pl-3 text-3xl font-bold whitespace-nowrap">
                {bus.llegando ? (
                  <span className="text-[#30d158]">Llegando</span>
                ) : bus.desviada ? (
                  <span className="text-[#ff9f0a] text-2xl">Desviada</span>
                ) : bus.tiempo_real ? (
                  <span>
                    {bus.minutos} <span className="text-[#8e8e93] text-xl">min</span>
                  </span>
                ) : (
                  <span className="text-[#8e8e93]">{bus.hora}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex justify-center pb-6 space-x-3">
        {paradas.map((_, idx) => (
          <div
            key={idx}
            className={`w-2.5 h-2.5 rounded-full ${idx === paradaIdx ? 'bg-white' : 'bg-[#8e8e93]'}`}
          />
        ))}
      </div>
    </div>
  );
}
