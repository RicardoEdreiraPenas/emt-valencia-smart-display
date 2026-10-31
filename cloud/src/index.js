/**
 * Servidor del EMT Smart Display en Cloudflare Workers (opción B, sin placa).
 *
 * La misma API que server/app.py, así que el ESP32, la web y el gemelo
 * digital funcionan igual con una opción que con la otra:
 *
 *   GET /api/parada/<id>   llegadas + tiempo
 *   GET /api/config        paradas configuradas
 *   GET /api/aviso         aviso de salida vigente (204 si no hay)
 *   GET /api/audio/<id>.wav
 *   GET /api/salud
 *
 * Diferencias con la Raspberry:
 *   - Está en internet: la API pide una clave (secreto API_TOKEN). El ESP32
 *     la manda en la cabecera X-Clave; el navegador entra una vez en /entrar
 *     y se queda con una cookie.
 *   - No hay un bucle cada 10 s: los avisos se calculan cuando el ESP32
 *     pregunta por /api/aviso (lo hace cada 4 s).
 *   - La voz es Workers AI (Deepgram Aura 2, español) en vez de Piper. Si
 *     no está disponible, suena el mismo tono de dos notas.
 */
import { Almacen } from './almacen.js';
import {
  AVISO_VIGENCIA_S, CLIMA_VACIO, SAE_URL, climaDe, evaluar, parsearSae,
  reglasActivas, tonoWav, arreglarWav, urlClima,
} from './nucleo.js';

const SAE_TIMEOUT_MS = 4000;
const SAE_CACHE_S = 15;       // todos los clientes comparten una consulta
const MAX_STALE_S = 300;      // tras 5 min sin datos frescos, se declara caído
const CLIMA_CACHE_S = 600;
const CLIMA_REINTENTO_S = 60;
const COOKIE = 'emt_clave';
// Se identifica igual que el intermediario de la demo (formato estándar de los bots)
const UA = 'Mozilla/5.0 (compatible; EMTSmartDisplay/1.0; +https://github.com/RicardoEdreiraPenas/emt-valencia-smart-display)';
const MODELO_VOZ = '@cf/deepgram/aura-2-es';

// --- Configuración (wrangler.toml -> [vars]) ------------------------------------

function lista(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  const t = v.trim();
  return t.startsWith('[') ? JSON.parse(t) : t.split(',');
}

export function leerConfig(env) {
  const paradas = lista(env.PARADAS).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100000);
  const reglas = (typeof env.REGLAS === 'string' ? (env.REGLAS.trim() ? JSON.parse(env.REGLAS) : []) : env.REGLAS || [])
    .map((r) => ({
      parada: Number(r.parada),
      andando_min: Number(r.andando_min),
      lineas: r.lineas && r.lineas.length ? r.lineas.map(String) : null,
      dias: (r.dias || [0, 1, 2, 3, 4]).map(Number),
      desde: r.desde || '00:00',
      hasta: r.hasta || '23:59',
    }));
  // "23:00-07:00" (o ["23:00", "07:00"]); vacío = sin franja de silencio
  const s = env.SILENCIO ?? '23:00-07:00';
  const silencio = Array.isArray(s) ? s : String(s).trim() ? String(s).split('-').map((x) => x.trim()) : [];
  const [lat, lon] = lista(env.CLIMA || '39.4697,-0.3774').map(Number);
  return {
    paradas,
    reglas,
    silencio: silencio.length === 2 ? silencio : null,
    clima: { lat, lon },
    permitidas: new Set([...paradas, ...reglas.map((r) => r.parada)]),
  };
}

// --- Respuestas -------------------------------------------------------------------

const SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000',
};

function respuesta(cuerpo, estado = 200, cabeceras = {}) {
  return new Response(cuerpo, { status: estado, headers: { ...SEGURIDAD, 'Cache-Control': 'no-store', ...cabeceras } });
}
const json = (datos, estado = 200) => respuesta(JSON.stringify(datos), estado, { 'Content-Type': 'application/json' });
const noEncontrado = () => json({ error: 'No encontrado' }, 404);

// --- Clave de acceso ------------------------------------------------------------

async function sha256(texto) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante (sobre los hashes, que tienen la misma longitud). */
async function iguales(a, b) {
  const [x, y] = [await sha256(`c:${a}`), await sha256(`c:${b}`)];
  let dif = 0;
  for (let i = 0; i < x.length; i++) dif |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return dif === 0;
}

const valorCookie = (token) => sha256(`cookie:${token}`);

function leerCookie(request) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}

async function autorizado(request, env) {
  if (!env.API_TOKEN) return true;   // sin clave configurada: API abierta (ver README)
  const cabecera = request.headers.get('X-Clave');
  if (cabecera) return iguales(cabecera, env.API_TOKEN);
  const cookie = leerCookie(request);
  return cookie ? iguales(cookie, await valorCookie(env.API_TOKEN)) : false;
}

const PAGINA_ENTRAR = (error) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>EMT Smart Display</title>
<style>
:root{color-scheme:light dark;--bg:#eceff3;--fg:#15203a;--muted:#5a6478;--line:#d3d9e2;--acc:#d2232a}
@media (prefers-color-scheme:dark){:root{--bg:#0d121b;--fg:#e6ebf2;--muted:#98a2b4;--line:#263041;--acc:#ff5148}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{width:min(360px,100%);display:grid;gap:12px}
h1{margin:0;font-size:26px}p{margin:0;color:var(--muted)}
input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
button{font:inherit;font-weight:600;padding:10px 12px;border:0;border-radius:10px;background:var(--acc);color:#fff;cursor:pointer}
.err{color:var(--acc)}
</style></head><body>
<form method="post" action="/entrar">
<h1>EMT Smart Display</h1>
<p>Escribe la clave de tu servidor. Este navegador la recordará.</p>
${error ? '<p class="err">Clave incorrecta.</p>' : ''}
<input type="password" name="clave" autocomplete="current-password" required autofocus aria-label="Clave">
<label><input type="checkbox" name="ir" value="simulador"> Abrir el gemelo digital</label>
<button type="submit">Entrar</button>
</form></body></html>`;

async function entrar(request, env) {
  if (request.method === 'GET') return respuesta(PAGINA_ENTRAR(false), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (request.method !== 'POST') return respuesta('Método no permitido', 405);
  if (!env.API_TOKEN) return respuesta(null, 303, { Location: '/' });
  let form;
  try { form = await request.formData(); } catch { return respuesta('Formulario no válido', 400); }
  const clave = String(form.get('clave') || '');
  if (!clave || clave.length > 200 || !(await iguales(clave, env.API_TOKEN))) {
    await new Promise((r) => setTimeout(r, 400));   // frena los intentos a ciegas
    return respuesta(PAGINA_ENTRAR(true), 401, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const destino = form.get('ir') === 'simulador' ? '/simulador/' : '/';
  return respuesta(null, 303, {
    Location: destino,
    'Set-Cookie': `${COOKIE}=${await valorCookie(env.API_TOKEN)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
  });
}

// --- Servidor -------------------------------------------------------------------

export function crearServidor({ fetchFn = (...a) => fetch(...a), almacen = new Almacen(), reloj = () => Date.now() / 1000 } = {}) {
  async function consultarSae(parada) {
    const control = new AbortController();
    const to = setTimeout(() => control.abort(), SAE_TIMEOUT_MS);
    try {
      const r = await fetchFn(`${SAE_URL}?sec=getSAE&parada=${parada}&adaptados=false`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.emtvalencia.es', Accept: 'text/xml,*/*' },
        signal: control.signal,
      });
      if (!r.ok) throw new Error(`EMT ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      // Como ElementTree en Python: se respeta la codificación que declara el XML
      const cabeza = new TextDecoder('latin1').decode(bytes.slice(0, 100));
      const cod = (/encoding=["']([\w-]+)["']/i.exec(cabeza) || [])[1] || 'utf-8';
      let xml;
      try { xml = new TextDecoder(cod).decode(bytes); } catch { xml = new TextDecoder().decode(bytes); }
      const r2 = parsearSae(xml, reloj());
      // "Temporalment no disponible": la EMT contesta con un aviso en HTML y sin
      // autobuses. Es un fallo suyo, no "sin servicio": se trata como error para
      // seguir mostrando el último dato bueno.
      if (!r2.llegadas.length && r2.avisos.some((a) => a.includes('<'))) throw new Error('EMT: no disponible');
      return r2;
    } finally {
      clearTimeout(to);
    }
  }

  /** Caché compartida + último dato bueno si la EMT falla (como obtener_llegadas). */
  async function obtenerLlegadas(parada) {
    const ahora = reloj();
    const cache = await almacen.get(`sae/${parada}`);
    if (cache && ahora - cache.ts < SAE_CACHE_S) return { ...cache, error: null };
    try {
      const { llegadas, avisos } = await consultarSae(parada);
      const nuevo = { ts: ahora, llegadas, avisos };
      await almacen.put(`sae/${parada}`, nuevo, MAX_STALE_S);
      return { ...nuevo, error: null };
    } catch (e) {
      if (cache && ahora - cache.ts < MAX_STALE_S) return { ...cache, error: String(e) };
      throw e;
    }
  }

  async function obtenerClima(cfg) {
    const ahora = reloj();
    const cache = await almacen.get('clima');
    if (cache && ahora < cache.siguiente) return cache.data;
    // Si Open-Meteo falla, se reintenta al cabo de 1 minuto, no en cada petición
    const data = cache?.data || CLIMA_VACIO;
    await almacen.put('clima', { data, siguiente: ahora + CLIMA_REINTENTO_S }, 86400);
    try {
      const r = await fetchFn(urlClima(cfg.clima.lat, cfg.clima.lon), { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      const nuevo = climaDe(await r.json());
      await almacen.put('clima', { data: nuevo, siguiente: ahora + CLIMA_CACHE_S }, 86400);
      return nuevo;
    } catch {
      return data;   // se mantiene el último valor bueno
    }
  }

  async function sintetizar(env, texto) {
    if (env.AI) {
      try {
        const r = await env.AI.run(MODELO_VOZ, {
          text: texto, speaker: env.VOZ || 'aquila', encoding: 'linear16', container: 'wav', sample_rate: 16000,
        });
        const bytes = r instanceof Uint8Array ? r : new Uint8Array(await new Response(r?.audio ?? r).arrayBuffer());
        const wav = arreglarWav(bytes);
        if (wav && wav.length > 2000) return { wav, voz: true };
      } catch (e) {
        console.warn('Voz no disponible:', e?.message || e);
      }
    }
    return { wav: tonoWav(), voz: false };
  }

  async function audioDe(env, id) {
    const guardado = await almacen.get(`audio/${id}`);
    if (guardado) return guardado;
    const aviso = await almacen.get(`aviso/${id}`);
    if (!aviso) return null;
    const { wav } = await sintetizar(env, aviso.texto);
    await almacen.put(`audio/${id}`, wav, 3600);
    return wav;
  }

  /** Calcula los avisos que tocan ahora y devuelve el vigente (como revisar + aviso_actual). */
  async function avisoActual(env, cfg, ctx) {
    const ahora = reloj();
    for (const regla of reglasActivas(ahora, cfg.reglas, cfg.silencio)) {
      let llegadas;
      try { ({ llegadas } = await obtenerLlegadas(regla.parada)); } catch { continue; }
      const nuevo = await evaluar(regla, llegadas, ahora, (p, l) => almacen.get(`anunciado/${p}/${l}`));
      if (!nuevo) continue;
      await almacen.put(`anunciado/${nuevo.parada}/${nuevo.linea}`, nuevo.llega_a, 1800);
      const { llega_a: _, ...aviso } = nuevo;
      await almacen.put(`aviso/${aviso.id}`, aviso, 3600);
      await almacen.put('aviso/actual', aviso, AVISO_VIGENCIA_S);
      // El audio se genera ya, para que el ESP32 no espere a la síntesis
      ctx?.waitUntil?.(audioDe(env, aviso.id).catch(() => {}));
    }
    const actual = await almacen.get('aviso/actual');
    return actual && ahora - actual.ts < AVISO_VIGENCIA_S ? actual : null;
  }

  async function api(request, env, ctx, ruta) {
    const cfg = leerConfig(env);

    if (ruta === '/api/salud') {
      if (!(await autorizado(request, env))) return json({ ok: true });
      return json({
        ok: true,
        servidor: 'cloudflare',
        paradas: cfg.paradas,
        avisos: {
          reglas_activas: reglasActivas(reloj(), cfg.reglas, cfg.silencio).map((r) => r.parada),
          voz: env.AI ? (env.VOZ || 'aquila') : null,
        },
        clave: Boolean(env.API_TOKEN),
      });
    }

    if (!(await autorizado(request, env))) return json({ error: 'Falta la clave' }, 401);

    if (ruta === '/api/config') return json({ paradas: cfg.paradas });

    const p = /^\/api\/parada\/(\d{1,6})$/.exec(ruta);
    if (p) {
      const parada = Number(p[1]);
      if (!cfg.permitidas.has(parada)) return noEncontrado();
      const clima = await obtenerClima(cfg);
      const base = {
        parada, clima: clima.temp, prob_lluvia: clima.lluvia, icono_clima: clima.icono || '', noche: Boolean(clima.noche),
      };
      let datos;
      try {
        datos = await obtenerLlegadas(parada);
      } catch (e) {
        console.warn(`EMT parada ${parada}:`, e?.message || e);   // el detalle, solo en el registro
        return json({ success: false, ...base, error: 'EMT no disponible', llegadas: [] }, 502);
      }
      const ahora = reloj();
      return json({
        success: true,
        ...base,
        llegadas: datos.llegadas,
        avisos: datos.avisos,
        servidor_ts: Math.trunc(ahora),
        edad_dato_s: Math.trunc(ahora - datos.ts),
        obsoleto: datos.error !== null,
      });
    }

    if (ruta === '/api/aviso') {
      const aviso = await avisoActual(env, cfg, ctx);
      if (!aviso) return respuesta(null, 204);
      return json({ ...aviso, audio: `/api/audio/${aviso.id}.wav` });
    }

    const a = /^\/api\/audio\/([0-9a-f]{10})\.wav$/.exec(ruta);
    if (a) {
      const wav = await audioDe(env, a[1]);
      if (!wav) return noEncontrado();
      return respuesta(wav, 200, {
        'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Cache-Control': 'private, max-age=3600',
      });
    }

    return noEncontrado();
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const ruta = url.pathname;

      if (ruta === '/entrar') return entrar(request, env);
      if (ruta === '/salir') {
        return respuesta(null, 303, { Location: '/entrar', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return respuesta('Método no permitido', 405, { Allow: 'GET, HEAD' });

      if (ruta === '/api' || ruta.startsWith('/api/')) {
        try {
          return await api(request, env, ctx, ruta);
        } catch (e) {
          console.error(e);
          return json({ error: 'Error interno' }, 500);
        }
      }

      // Portada: sin clave, a la página de entrada
      if ((ruta === '/' || ruta === '/index.html') && !(await autorizado(request, env))) {
        return respuesta(null, 302, { Location: '/entrar' });
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return noEncontrado();
    },
  };
}

const servidor = crearServidor();
export default { fetch: (request, env, ctx) => servidor.fetch(request, env, ctx) };
