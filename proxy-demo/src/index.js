/**
 * Intermediario de la demo pública (Cloudflare Worker).
 *
 * El navegador no puede pedir datos a la EMT desde otra web (CORS), así que
 * este Worker hace de puente para la demo de GitHub Pages:
 *
 *   GET /sae/<parada>  ->  XML del SAE de la EMT, tal cual
 *
 * Límites para no cargar a la EMT ni convertirse en un proxy abierto:
 *   - solo las paradas de la demo (centro de València)
 *   - caché de 20 s por parada: como mucho 5 consultas a la EMT cada 20 s,
 *     haya los visitantes que haya
 *   - solo GET, sin reenviar parámetros ni cabeceras del visitante
 *   - CORS solo para la demo y para pruebas en local
 */

const PARADAS = new Set([708, 1676, 2080, 1619, 697]);
const SAE = 'https://www.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php';
const CACHE_S = 20;
const ORIGENES = new Set([
  'https://ricardoedreirapenas.github.io',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
]);

// Caché en memoria del aislamiento (se suma a la caché de Cloudflare)
const memoria = new Map(); // parada -> { ts, xml }

function cors(origen) {
  return {
    'Access-Control-Allow-Origin': ORIGENES.has(origen) ? origen : 'https://ricardoedreirapenas.github.io',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function respuesta(cuerpo, estado, extra = {}) {
  return new Response(cuerpo, {
    status: estado,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export async function consultarSae(parada, ahora = Date.now(), fetchFn = fetch) {
  const enMemoria = memoria.get(parada);
  if (enMemoria && ahora - enMemoria.ts < CACHE_S * 1000) return { xml: enMemoria.xml, cache: 'memoria' };

  const url = `${SAE}?sec=getSAE&parada=${parada}&adaptados=false`;
  const r = await fetchFn(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EMTSmartDisplay-demo/1.0; +https://github.com/RicardoEdreiraPenas/emt-valencia-smart-display)',
      Referer: 'https://www.emtvalencia.es',
      Accept: 'text/xml,*/*',
    },
    cf: { cacheTtl: CACHE_S, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`EMT ${r.status}`);
  const xml = await r.text();
  if (!xml.includes('<estimacion')) throw new Error('Respuesta inesperada de la EMT');
  memoria.set(parada, { ts: ahora, xml });
  return { xml, cache: 'emt' };
}

export default {
  async fetch(request) {
    const origen = request.headers.get('Origin') || '';
    const cabeceras = cors(origen);

    if (request.method === 'OPTIONS') return respuesta(null, 204, cabeceras);
    if (request.method !== 'GET') return respuesta('Método no permitido', 405, cabeceras);

    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/salud') {
      return respuesta(JSON.stringify({ ok: true, paradas: [...PARADAS] }), 200,
        { ...cabeceras, 'Content-Type': 'application/json' });
    }

    const m = pathname.match(/^\/sae\/(\d{1,5})$/);
    const parada = m ? Number(m[1]) : NaN;
    if (!PARADAS.has(parada)) return respuesta('Parada no disponible en la demo', 404, cabeceras);

    try {
      const { xml, cache } = await consultarSae(parada);
      return respuesta(xml, 200, {
        ...cabeceras,
        'Content-Type': 'text/xml; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_S}`,
        'X-Demo-Cache': cache,
      });
    } catch {
      return respuesta('EMT no disponible', 502, cabeceras);
    }
  },
};
