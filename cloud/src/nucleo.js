/**
 * Lógica del servidor sin dependencias del entorno: la misma que server/app.py
 * y server/avisos.py, línea a línea. Los tests de paridad (test/paridad.test.mjs)
 * comprueban que, con los mismos XML de la EMT, salen los mismos datos que en
 * la versión en Python.
 */

export const TZ = 'Europe/Madrid';
export const SAE_URL = 'https://www.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php';

// Avisos de salida (igual que avisos.py)
export const AVISO_ANTES_S = 60;     // avisa hasta 1 min antes de la hora de salir
export const AVISO_TARDE_S = 30;     // y hasta 30 s después
export const AVISO_VIGENCIA_S = 90;  // tiempo que /api/aviso devuelve el aviso

// --- Hora de Madrid ----------------------------------------------------------

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const DIAS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Partes de la fecha en Madrid. dia: 0 = lunes … 6 = domingo (como weekday() de Python). */
export function enMadrid(ahora) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ahora * 1000)).map((x) => [x.type, x.value]));
  return {
    anio: +p.year, mes: +p.month, diaMes: +p.day,
    hora: +p.hour, minuto: +p.minute, segundo: +p.second, dia: DIAS[p.weekday],
  };
}

// --- SAE (EMT) ---------------------------------------------------------------

export function esHora(texto) {
  if (!texto) return false;
  const partes = texto.trim().split(':');
  return (partes.length === 2 || partes.length === 3) && partes.every((p) => /^\d\d$/.test(p));
}

/** Diferencia (s) entre la hora de Madrid y UTC en el instante t. */
function desfaseEn(t) {
  const p = enMadrid(t);
  return Date.UTC(p.anio, p.mes - 1, p.diaMes, p.hora, p.minuto, p.segundo) / 1000 - Math.floor(t);
}

/**
 * Hora local de Madrid -> epoch, como datetime.replace(...).timestamp() de
 * Python (fold=0): en la hora repetida de octubre, la primera; en la hora que
 * no existe de marzo, el desfase de antes del cambio.
 */
function localAEpoch(local) {
  const antes = desfaseEn(local - 43200), despues = desfaseEn(local + 43200);
  if (desfaseEn(local - antes) === antes) return local - antes;
  if (desfaseEn(local - despues) === despues) return local - despues;
  return local - antes;
}

/** "HH:MM" de hoy en Madrid -> epoch; si ya pasó hace más de 1 h, es de mañana. */
export function horaAEpoch(hhmm, ahora) {
  const m = /^(\d+):(\d+)$/.exec(hhmm || '');
  if (!m) return null;
  const t = enMadrid(ahora);
  let ts = localAEpoch(Date.UTC(t.anio, t.mes - 1, t.diaMes, +m[1], +m[2], 0) / 1000);
  if (ts < ahora - 3600) ts += 86400;   // cruce de medianoche
  return Math.trunc(ts);
}

/** Corrige textos con doble codificación ("EstaciÃ³" -> "Estació"). */
export function arreglarCodificacion(texto) {
  if (!texto) return texto;
  const bytes = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c > 255) return texto;
    bytes[i] = c;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return texto;
  }
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function textoDe(crudo) {
  if (crudo == null) return null;
  let t = crudo.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, '\u0000amp;'));
  t = t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (e, n) => {
    if (n[0] === '#') return String.fromCodePoint(n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10));
    return ENTIDADES[n] ?? e;
  }).replace(/\u0000amp;/g, '&');
  t = t.trim();
  return t || null;
}

/** Hijos directos de un fragmento XML: [{etiqueta, contenido|null}] (null = <x/>). */
function hijos(xml) {
  const res = [];
  const re = /<([A-Za-z_][\w.-]*)(\s[^>]*?)?(\/>|>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const etiqueta = m[1];
    if (m[3] === '/>') { res.push({ etiqueta, contenido: null }); continue; }
    // busca el cierre que le corresponde (con anidamiento del mismo nombre)
    const inicio = re.lastIndex;
    const reTag = new RegExp(`<(/?)${etiqueta}(?:\\s[^>]*?)?(/?)>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>`, 'g');
    reTag.lastIndex = inicio;
    let nivel = 1, t;
    while (nivel > 0 && (t = reTag.exec(xml))) {
      if (t[0].startsWith('<![CDATA[')) continue;
      if (t[1]) nivel--; else if (!t[2]) nivel++;
    }
    if (nivel > 0) throw new Error(`XML mal formado: <${etiqueta}> sin cerrar`);
    res.push({ etiqueta, contenido: xml.slice(inicio, t.index) });
    re.lastIndex = reTag.lastIndex;
  }
  return res;
}

/**
 * XML <estimacion> del SAE -> { llegadas, avisos }, igual que parsear_sae() en app.py.
 */
export function parsearSae(xml, ahora = Date.now() / 1000) {
  const cuerpo = xml.replace(/^﻿?\s*<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const raiz = hijos(cuerpo)[0];
  if (!raiz) throw new Error('Respuesta vacía del SAE');
  if (raiz.etiqueta !== 'estimacion') throw new Error(`Respuesta inesperada del SAE: <${raiz.etiqueta}>`);

  const llegadas = [], avisos = [];
  const deRaiz = hijos(raiz.contenido || '');
  const contenedor = deRaiz.length ? hijos(deRaiz[0].contenido || '') : deRaiz;

  for (const bus of contenedor) {
    if (bus.etiqueta !== 'bus') continue;
    const campos = hijos(bus.contenido || '').map((c) => textoDe(c.contenido));

    if (campos.length < 5) {
      avisos.push(campos.length ? campos[campos.length - 1] : 'Respuesta vacía');
      continue;
    }
    const [linea, destino, minutosTxt, horaTxt, error] = campos;
    if (error) { avisos.push(error); continue; }

    let minutos = null, llegando = false, hora = null;
    const t = (minutosTxt || '').toLowerCase();
    const desviada = t.includes('desvia');   // "LÍNIA DESVIADA": sin estimación
    if (desviada) {
      // sin hora
    } else if (t.startsWith('pr')) {        // "Pròxim" / "Próximo"
      minutos = 0; llegando = true;
    } else if (t.includes('min')) {         // "37 min."
      const n = t.split(/\s+/)[0];
      if (!/^[+-]?\d+$/.test(n)) { avisos.push(`Minutos ilegibles: ${minutosTxt}`); continue; }
      minutos = parseInt(n, 10);
    } else if (esHora(minutosTxt)) {        // "02:57:45": hora prevista
      hora = minutosTxt.slice(0, 5);
    } else if (esHora(horaTxt)) {
      hora = horaTxt.slice(0, 5);
    } else {
      if (minutosTxt || horaTxt) avisos.push(`Formato desconocido: ${minutosTxt || horaTxt}`);
      continue;
    }

    let llegaA = null;
    if (minutos !== null) llegaA = Math.trunc(ahora + minutos * 60);
    else if (hora) llegaA = horaAEpoch(hora, ahora);

    llegadas.push({
      linea: linea || '?',
      destino: arreglarCodificacion(destino),
      minutos,
      llegando,
      hora,
      tiempo_real: minutos !== null,
      desviada,
      texto: llegando ? '0' : minutos !== null ? String(minutos) : desviada ? 'Desviada' : hora,
      llega_a: llegaA,
    });
  }

  // Orden estable por hora de llegada; sin hora, al final (como sorted() de Python)
  const ordenadas = llegadas
    .map((b, i) => [b, i])
    .sort((a, b) => (a[0].llega_a ?? Infinity) - (b[0].llega_a ?? Infinity) || a[1] - b[1])
    .map(([b]) => b);

  // Las desviadas no tienen hora: van en la 3.ª posición para que se vean
  const desviadas = ordenadas.filter((b) => b.desviada);
  if (!desviadas.length) return { llegadas: ordenadas, avisos };
  const normales = ordenadas.filter((b) => !b.desviada);
  return { llegadas: [...normales.slice(0, 2), ...desviadas, ...normales.slice(2)], avisos };
}

// --- Clima -------------------------------------------------------------------

export const redondear = (x) => Math.floor(Number(x) + 0.5);   // 16.5 -> 17

export function iconoWmo(codigo) {
  const c = Number.parseInt(codigo, 10);
  if (Number.isNaN(c)) return '';
  if (c === 0) return 'despejado';
  if (c === 1 || c === 2) return 'parcial';
  if (c === 3) return 'nublado';
  if (c === 45 || c === 48) return 'niebla';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'lluvia';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'nieve';
  if (c === 95 || c === 96 || c === 99) return 'tormenta';
  return '';
}

export const CLIMA_VACIO = { temp: '-- C', lluvia: '--%', icono: '', noche: false };

export function urlClima(lat, lon) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current_weather=true&daily=precipitation_probability_max&timezone=Europe%2FMadrid';
}

/** Respuesta de Open-Meteo -> {temp, lluvia, icono, noche} (como obtener_clima). */
export function climaDe(datos) {
  const actual = datos.current_weather;
  const prob = datos.daily.precipitation_probability_max[0];
  if (actual?.temperature == null || prob == null) throw new Error('Open-Meteo incompleto');
  return {
    temp: `${redondear(actual.temperature)} C`,
    lluvia: `${Math.trunc(prob)}%`,
    icono: iconoWmo(actual.weathercode),
    noche: actual.is_day === 0,
  };
}

// --- Avisos de salida ----------------------------------------------------------

const minutosDelDia = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function enFranja(ahoraMin, desde, hasta) {
  const a = minutosDelDia(desde), b = minutosDelDia(hasta);
  return a <= b ? a <= ahoraMin && ahoraMin < b : ahoraMin >= a || ahoraMin < b;
}

export function reglasActivas(ahora, reglas, silencio) {
  const t = enMadrid(ahora);
  const m = t.hora * 60 + t.minuto;
  if (silencio && enFranja(m, silencio[0], silencio[1])) return [];
  return reglas.filter((r) => r.dias.includes(t.dia) && enFranja(m, r.desde, r.hasta));
}

/** round() de Python: a la par en los empates (2.5 -> 2, 3.5 -> 4). */
export function redondeoPython(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

async function sha1Hex(texto) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** repr() de Python para la clave (parada, linea): mismo id de aviso que avisos.py. */
const reprStr = (s) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

/**
 * Busca el aviso que toca para una regla (como evaluar() en avisos.py).
 * anunciado(parada, linea) -> llega_a del bus ya anunciado o null.
 * Devuelve el aviso nuevo o null.
 */
export async function evaluar(regla, llegadas, ahora, anunciado) {
  for (const bus of llegadas) {
    if (!bus.tiempo_real || bus.llega_a == null) continue;     // solo estimaciones reales
    if (regla.lineas?.length && !regla.lineas.includes(bus.linea)) continue;

    const salirEn = bus.llega_a - ahora - regla.andando_min * 60;
    if (!(-AVISO_TARDE_S <= salirEn && salirEn <= AVISO_ANTES_S)) continue;

    const previo = await anunciado(regla.parada, bus.linea);
    if (previo != null && Math.abs(previo - bus.llega_a) < 180) continue;   // el mismo bus

    const minutos = Math.max(0, redondeoPython((bus.llega_a - ahora) / 60));
    const destino = bus.destino ? ` hacia ${bus.destino}` : '';
    const texto = `Sal ya. La ${bus.linea}${destino} llega en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`;
    const id = (await sha1Hex(`(${regla.parada}, ${reprStr(bus.linea)})${bus.llega_a}`)).slice(0, 10);
    return { id, texto, ts: ahora, parada: regla.parada, linea: bus.linea, minutos, llega_a: bus.llega_a };
  }
  return null;
}

// --- Audio ---------------------------------------------------------------------

function cabeceraWav(bytesDatos, rate) {
  const h = new DataView(new ArrayBuffer(44));
  const txt = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); h.setUint32(4, 36 + bytesDatos, true); txt(8, 'WAVE');
  txt(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  txt(36, 'data'); h.setUint32(40, bytesDatos, true);
  return new Uint8Array(h.buffer);
}

/** Tono de dos notas (880 Hz y 1320 Hz), WAV PCM 16 bits mono: el mismo que _tono(). */
export function tonoWav(rate = 16000) {
  const muestras = [];
  for (const [freq, dur] of [[880, 0.18], [0, 0.06], [1320, 0.28]]) {
    const n = Math.trunc(rate * dur);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 200, (n - i) / 400);
      muestras.push(freq ? Math.trunc(12000 * env * Math.sin((2 * Math.PI * freq * i) / rate)) : 0);
    }
  }
  const datos = new Uint8Array(muestras.length * 2);
  const v = new DataView(datos.buffer);
  muestras.forEach((s, i) => v.setInt16(i * 2, s, true));
  const out = new Uint8Array(44 + datos.length);
  out.set(cabeceraWav(datos.length, rate)); out.set(datos, 44);
  return out;
}

/**
 * Deja un WAV con los tamaños reales en la cabecera. Las voces en streaming
 * suelen poner 0xFFFFFFFF en "data", y el ESP32 lee exactamente lo que diga.
 * Devuelve null si no es un WAV PCM de 16 bits.
 */
export function arreglarWav(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const tag = (o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12, pcm = false;
  while (o + 8 <= u.length) {
    const id = tag(o);
    if (id === 'fmt ') pcm = v.getUint16(o + 8, true) === 1 && v.getUint16(o + 22, true) === 16;
    if (id === 'data') {
      if (!pcm) return null;
      const datos = (u.length - (o + 8)) & ~1;
      const out = u.slice(0, o + 8 + datos);
      const w = new DataView(out.buffer);
      w.setUint32(4, out.length - 8, true);
      w.setUint32(o + 4, datos, true);
      return out;
    }
    const tam = v.getUint32(o + 4, true);
    if (tam > u.length) return null;
    o += 8 + tam + (tam & 1);
  }
  return null;
}
