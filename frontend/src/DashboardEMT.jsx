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

// WAV de silencio (44 bytes de cabecera + 2 muestras): sirve para "desbloquear"
// el audio en iPhone/iPad, que solo deja sonar tras un toque del usuario.
const SILENCIO_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA';
const AVISO_CADA_MS = 5000;
const AVISO_BANNER_MS = 60000;

export default function DashboardEMT() {
  const [paradas, setParadas] = useState([]);
  const [paradaIdx, setParadaIdx] = useState(0);
  const [datos, setDatos] = useState({ llegadas: [], avisos: [], clima: '-- C', prob_lluvia: '--%' });
  const [hora, setHora] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const paradaRef = useRef(paradaIdx);
  const [sonido, setSonido] = useState(false);
  const [aviso, setAviso] = useState(null);       // { id, texto, hasta }
  const audioRef = useRef(null);
  const sonidoRef = useRef(false);
  const ultimoAvisoRef = useRef('');

  // Avisos de salida: igual que el ESP32, se pregunta al servidor cada pocos
  // segundos; un aviso nuevo muestra la barra verde y, con el sonido activado,
  // reproduce el audio que genera el servidor (voz o tono).
  useEffect(() => {
    let activo = true;
    const revisar = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/aviso`);
        if (!activo || r.status !== 200) return;
        const a = await r.json();
        if (!a?.id || a.id === ultimoAvisoRef.current) return;
        ultimoAvisoRef.current = a.id;
        setAviso({ id: a.id, texto: a.texto, hasta: Date.now() + AVISO_BANNER_MS });
        const ruta = String(a.audio || '');
        if (sonidoRef.current && audioRef.current && /^\/api\/audio\/[0-9a-f]{10}\.wav$/.test(ruta)) {
          audioRef.current.src = `${API_BASE}${ruta}`;
          audioRef.current.play().catch(() => {});
        }
      } catch {
        // sin conexión: se vuelve a intentar en el siguiente ciclo
      }
    };
    revisar();
    const t = setInterval(revisar, AVISO_CADA_MS);
    return () => { activo = false; clearInterval(t); };
  }, []);

  // La barra del aviso se quita sola al minuto
  useEffect(() => {
    if (!aviso) return undefined;
    const t = setTimeout(() => setAviso(null), Math.max(0, aviso.hasta - Date.now()));
    return () => clearTimeout(t);
  }, [aviso]);

  const alternarSonido = (e) => {
    e.stopPropagation();                         // no cambiar de parada
    if (!audioRef.current) audioRef.current = new Audio();
    const nuevo = !sonidoRef.current;
    sonidoRef.current = nuevo;
    setSonido(nuevo);
    if (nuevo) {                                 // desbloqueo dentro del toque
      audioRef.current.src = SILENCIO_WAV;
      audioRef.current.play().catch(() => {});
    }
  };

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
      <div className="flex justify-between items-center gap-3 p-5 text-xl font-bold tracking-wide whitespace-nowrap">
        <span className="flex items-center gap-2">
          EMT {paradas[paradaIdx]}
          {datos.obsoleto && (
            <span className="w-2 h-2 rounded-full bg-[#ff9f0a]" title="Último dato disponible" />
          )}
        </span>
        <div className="flex space-x-3">
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

      <div className="px-5 -mt-2 mb-2 flex justify-end">
        <button
          type="button"
          onClick={alternarSonido}
          aria-pressed={sonido}
          className={`rounded-full px-4 py-1.5 text-base font-semibold whitespace-nowrap ${sonido ? 'bg-[#30d158] text-black' : 'bg-[#1c1c1e] text-[#8e8e93]'}`}
          title={sonido ? 'Avisos con sonido activados' : 'Toca para oír los avisos de salida'}
        >
          {sonido ? '🔔 Avisos con sonido' : '🔕 Activar sonido de avisos'}
        </button>
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

      {aviso && (
        <div className="mx-5 mb-4 rounded-2xl bg-[#30d158] text-black p-4 text-xl font-bold text-center" role="alert">
          SAL YA · {String(aviso.texto || '').replace(/^Sal ya\.\s*/i, '')}
        </div>
      )}

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
