// El Worker completo con una EMT y un Open-Meteo falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crearServidor, leerConfig } from '../src/index.js';
import { Almacen } from '../src/almacen.js';

const fixtures = new URL('../../server/tests/fixtures/', import.meta.url);
const XML_708 = readFileSync(new URL('sae_708.xml', fixtures));
const METEO = readFileSync(new URL('openmeteo_2026-10-31_1700.json', fixtures), 'utf8');
const LUNES_0800 = Date.UTC(2026, 10, 2, 7, 0) / 1000;   // 08:00 en Madrid
const CLAVE = 'clave-de-prueba-0123456789';

const ENV = {
  API_TOKEN: CLAVE,
  PARADAS: '708,1676,2080',
  CLIMA: '39.47,-0.37',
  SILENCIO: '23:00-07:00',
  REGLAS: JSON.stringify([{ parada: 708, andando_min: 5, lineas: null, dias: [0, 1, 2, 3, 4], desde: '07:30', hasta: '09:00' }]),
};

function montar({ xml = () => XML_708, meteo = () => METEO, ahora = LUNES_0800, env = ENV } = {}) {
  const llamadas = { emt: 0, meteo: 0 };
  const reloj = { t: ahora };
  const fetchFn = async (url) => {
    if (url.includes('emtvalencia')) {
      llamadas.emt++;
      const cuerpo = xml(url);
      if (cuerpo instanceof Error) throw cuerpo;
      return new Response(cuerpo, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    llamadas.meteo++;
    const cuerpo = meteo();
    if (cuerpo instanceof Error) throw cuerpo;
    return new Response(cuerpo, { status: 200 });
  };
  const servidor = crearServidor({ fetchFn, almacen: new Almacen(null), reloj: () => reloj.t });
  const esperas = [];
  const ctx = { waitUntil: (p) => esperas.push(p) };
  const pedir = (ruta, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (init.clave !== false && !headers.has('X-Clave') && !headers.has('Cookie')) headers.set('X-Clave', CLAVE);
    return servidor.fetch(new Request(`https://emt.example.workers.dev${ruta}`, { ...init, headers }), init.env || env, ctx);
  };
  return { pedir, llamadas, reloj, esperas };
}

test('parada: mismo JSON que el servidor en Python y caché de 15 s', async () => {
  const { pedir, llamadas, reloj } = montar();
  const r = await pedir('/api/parada/708');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  const d = await r.json();
  assert.deepEqual(Object.keys(d).sort(), ['avisos', 'clima', 'edad_dato_s', 'icono_clima', 'llegadas', 'noche',
    'obsoleto', 'parada', 'prob_lluvia', 'servidor_ts', 'success'].sort());
  assert.equal(d.success, true);
  assert.equal(d.clima, '19 C');           // 18.5 -> 19
  assert.equal(d.prob_lluvia, '75%');
  assert.equal(d.icono_clima, 'parcial');
  assert.equal(d.noche, false);
  assert.equal(d.llegadas[0].linea, '19');
  assert.equal(d.obsoleto, false);

  reloj.t += 10;
  await pedir('/api/parada/708');
  assert.equal(llamadas.emt, 1);           // de la caché
  reloj.t += 6;
  await pedir('/api/parada/708');
  assert.equal(llamadas.emt, 2);
  assert.equal(llamadas.meteo, 1);         // el tiempo dura 10 min
});

test('solo las paradas configuradas (y las de los avisos): las demás, 404 sin tocar la EMT', async () => {
  const { pedir, llamadas } = montar();
  for (const ruta of ['/api/parada/9999', '/api/parada/1902', '/api/parada/abc', '/api/parada/708/x']) {
    assert.equal((await pedir(ruta)).status, 404, ruta);
  }
  assert.equal(llamadas.emt, 0);
});

test('EMT caída: último dato bueno 5 min (obsoleto) y luego 502 sin detalles', async () => {
  let caida = false;
  const { pedir, reloj } = montar({ xml: () => (caida ? new Error('ECONNRESET 10.0.0.1') : XML_708) });
  await pedir('/api/parada/708');
  caida = true;
  reloj.t += 100;
  let d = await (await pedir('/api/parada/708')).json();
  assert.equal(d.obsoleto, true);
  assert.equal(d.edad_dato_s, 100);
  reloj.t += 250;
  const r = await pedir('/api/parada/708');
  assert.equal(r.status, 502);
  d = await r.json();
  assert.equal(d.error, 'EMT no disponible');
  assert.ok(!JSON.stringify(d).includes('ECONNRESET'));
  assert.equal(d.clima, '19 C');
});

test('Open-Meteo caído: valores vacíos y reintento al cabo de 1 min, no en cada petición', async () => {
  const { pedir, llamadas, reloj } = montar({ meteo: () => new Error('caído') });
  const d = await (await pedir('/api/parada/708')).json();
  assert.equal(d.clima, '-- C');
  reloj.t += 30; await pedir('/api/parada/708');
  assert.equal(llamadas.meteo, 1);
  reloj.t += 31; await pedir('/api/parada/708');
  assert.equal(llamadas.meteo, 2);
});

test('clave: sin ella o mal, 401; con cookie de /entrar, dentro', async () => {
  const { pedir } = montar();
  assert.equal((await pedir('/api/config', { clave: false })).status, 401);
  assert.equal((await pedir('/api/config', { headers: { 'X-Clave': 'otra' } })).status, 401);
  assert.equal((await pedir('/api/parada/708', { clave: false })).status, 401);

  const mal = await pedir('/entrar', { method: 'POST', clave: false, body: new URLSearchParams({ clave: 'nop' }) });
  assert.equal(mal.status, 401);
  assert.equal(mal.headers.get('Set-Cookie'), null);

  const bien = await pedir('/entrar', { method: 'POST', clave: false, body: new URLSearchParams({ clave: CLAVE, ir: 'simulador' }) });
  assert.equal(bien.status, 303);
  assert.equal(bien.headers.get('Location'), '/simulador/');
  const cookie = bien.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.ok(!cookie.includes(CLAVE));      // la cookie no es la clave
  const valor = cookie.split(';')[0];
  const r = await pedir('/api/config', { headers: { Cookie: valor } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { paradas: [708, 1676, 2080] });
});

test('portada sin clave -> /entrar; salud sin clave no cuenta nada', async () => {
  const { pedir } = montar();
  const r = await pedir('/', { clave: false });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/entrar');
  assert.deepEqual(await (await pedir('/api/salud', { clave: false })).json(), { ok: true });
  const s = await (await pedir('/api/salud')).json();
  assert.deepEqual(s.avisos.reglas_activas, [708]);
});

test('sin API_TOKEN la API queda abierta (como la Raspberry en casa)', async () => {
  const env = { ...ENV, API_TOKEN: undefined };
  const { pedir } = montar({ env });
  assert.equal((await pedir('/api/config', { clave: false })).status, 200);
});

test('métodos y rutas desconocidas', async () => {
  const { pedir } = montar();
  assert.equal((await pedir('/api/config', { method: 'POST' })).status, 405);
  assert.equal((await pedir('/api/nada')).status, 404);
  assert.equal((await pedir('/api/audio/../../x.wav')).status, 404);
  assert.equal((await pedir('/api/audio/ABCDEF0123.wav')).status, 404);
  assert.equal((await pedir('/simulador/')).status, 404);   // sin ASSETS en los tests
});

function xmlCon(buses) {
  return `<?xml version='1.0' encoding='UTF-8'?><estimacion parada="708"><solo_parada>${buses.map(([l, m]) =>
    `<bus><linea>${l}</linea><destino><![CDATA[La Malva-rosa]]></destino><minutos>${m} min.</minutos><horaLlegada/><error/></bus><info/>`).join('')}</solo_parada></estimacion>`;
}

test('aviso de salida: uno por bus, con audio WAV (tono sin Workers AI)', async () => {
  let buses = [['19', 9]];
  const { pedir, reloj, esperas } = montar({ xml: () => xmlCon(buses) });
  assert.equal((await pedir('/api/aviso')).status, 204);

  reloj.t += 20; buses = [['19', 6]];      // salir en 60 s -> aviso
  let r = await pedir('/api/aviso');
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.equal(a.texto, 'Sal ya. La 19 hacia La Malva-rosa llega en 6 minutos.');
  assert.equal(a.audio, `/api/audio/${a.id}.wav`);
  assert.match(a.id, /^[0-9a-f]{10}$/);
  await Promise.all(esperas);

  reloj.t += 16; buses = [['19', 5]];      // el mismo bus: el mismo aviso
  assert.equal((await (await pedir('/api/aviso')).json()).id, a.id);

  const wav = await pedir(a.audio);
  assert.equal(wav.headers.get('Content-Type'), 'audio/wav');
  const b = new Uint8Array(await wav.arrayBuffer());
  assert.equal(new TextDecoder().decode(b.slice(0, 4)), 'RIFF');
  assert.equal(Number(wav.headers.get('Content-Length')), b.length);

  reloj.t += 90;                           // fin de la vigencia
  buses = [['19', 3]];
  assert.equal((await pedir('/api/aviso')).status, 204);
});

test('aviso: fuera de la franja o en silencio, nada', async () => {
  const sabado = Date.UTC(2026, 10, 7, 7, 0) / 1000;
  const { pedir } = montar({ xml: () => xmlCon([['19', 6]]), ahora: sabado });
  assert.equal((await pedir('/api/aviso')).status, 204);
});

test('voz de Workers AI: WAV en streaming con la cabecera corregida', async () => {
  const datos = 16000 * 2;   // 1 s de audio
  const wav = new Uint8Array(44 + datos);
  const v = new DataView(wav.buffer);
  const txt = (o, s) => [...s].forEach((c, i) => { wav[o + i] = c.charCodeAt(0); });
  txt(0, 'RIFF'); v.setUint32(4, 0xffffffff, true); txt(8, 'WAVE'); txt(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, 'data'); v.setUint32(40, 0xffffffff, true);
  let pedido;
  const env = { ...ENV, VOZ: 'javier', AI: { run: async (modelo, entrada) => { pedido = { modelo, entrada }; return new Response(wav).body; } } };

  const { pedir, reloj, esperas } = montar({ xml: () => xmlCon([['19', 6]]), env });
  reloj.t += 20;
  const a = await (await pedir('/api/aviso')).json();
  await Promise.all(esperas);
  assert.equal(pedido.modelo, '@cf/deepgram/aura-2-es');
  assert.equal(pedido.entrada.speaker, 'javier');
  assert.equal(pedido.entrada.encoding, 'linear16');
  const r = new Uint8Array(await (await pedir(a.audio)).arrayBuffer());
  const rv = new DataView(r.buffer);
  assert.equal(r.length, 44 + datos);
  assert.equal(rv.getUint32(40, true), datos);
  assert.equal(rv.getUint32(4, true), r.length - 8);
});

test('voz caída: el aviso suena con el tono', async () => {
  const env = { ...ENV, AI: { run: async () => { throw new Error('sin cuota'); } } };
  const { pedir, reloj } = montar({ xml: () => xmlCon([['19', 6]]), env });
  reloj.t += 20;
  const a = await (await pedir('/api/aviso')).json();
  const r = new Uint8Array(await (await pedir(a.audio)).arrayBuffer());
  assert.equal(r.length, 44 + 16000 * 0.52 * 2);
});

test('configuración: listas, JSON y valores por defecto', () => {
  const c = leerConfig({ PARADAS: '708, 1676,abc', REGLAS: [{ parada: 5, andando_min: 3, lineas: [] }], SILENCIO: '' });
  assert.deepEqual(c.paradas, [708, 1676]);
  assert.deepEqual([...c.permitidas], [708, 1676, 5]);
  assert.equal(c.reglas[0].lineas, null);
  assert.equal(c.silencio, null);
  assert.deepEqual(leerConfig({ PARADAS: '[1,2]' }).silencio, ['23:00', '07:00']);
});

test('EMT "temporalmente no disponible" (HTML sin buses): se sigue con el último dato bueno', async () => {
  const noDisp = readFileSync(new URL('sae_no_disponible.xml', fixtures));
  let malo = false;
  const { pedir, reloj } = montar({ xml: () => (malo ? noDisp : XML_708) });
  await pedir('/api/parada/708');
  malo = true;
  reloj.t += 20;
  const d = await (await pedir('/api/parada/708')).json();
  assert.equal(d.obsoleto, true);
  assert.equal(d.llegadas[0].linea, '19');
  reloj.t += 300;
  assert.equal((await pedir('/api/parada/708')).status, 502);
});

test('"sin servicio" no es un error', async () => {
  const sin = readFileSync(new URL('sae_sin_servicio.xml', fixtures));
  const { pedir } = montar({ xml: () => sin });
  const d = await (await pedir('/api/parada/2080')).json();
  assert.equal(d.success, true);
  assert.deepEqual(d.avisos, ['SENSE ESTIMACIONS']);
});
