// Tests del intermediario sin Cloudflare: node --test proxy-demo/test
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { consultarSae } from '../src/index.js';

const XML = '<?xml version="1.0"?><estimacion parada="708"><solo_parada><bus><linea>19</linea>'
  + '<destino>La Malva-rosa</destino><minutos>5 min.</minutos><horaLlegada/><error/></bus></solo_parada></estimacion>';

const pedir = (ruta, init = {}) => worker.fetch(new Request(`https://x.workers.dev${ruta}`, {
  headers: { Origin: 'https://ricardoedreirapenas.github.io' }, ...init,
}));

test('solo paradas de la demo', async () => {
  assert.equal((await pedir('/sae/4321')).status, 404);
  assert.equal((await pedir('/sae/abc')).status, 404);
  assert.equal((await pedir('/otra')).status, 404);
});

test('solo GET', async () => {
  assert.equal((await pedir('/sae/708', { method: 'POST' })).status, 405);
  assert.equal((await pedir('/sae/708', { method: 'OPTIONS' })).status, 204);
});

test('CORS solo para la demo', async () => {
  const ok = await pedir('/salud');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://ricardoedreirapenas.github.io');
  const otra = await worker.fetch(new Request('https://x.workers.dev/salud', { headers: { Origin: 'https://otra.web' } }));
  assert.notEqual(otra.headers.get('Access-Control-Allow-Origin'), 'https://otra.web');
});

test('caché de 20 s: varias visitas, una sola consulta a la EMT', async () => {
  let llamadas = 0;
  const falsoFetch = async () => { llamadas++; return new Response(XML, { status: 200 }); };
  const t0 = 1_000_000;
  await consultarSae(2080, t0, falsoFetch);
  for (let i = 1; i < 50; i++) await consultarSae(2080, t0 + i * 300, falsoFetch);
  assert.equal(llamadas, 1);
  await consultarSae(2080, t0 + 21_000, falsoFetch);
  assert.equal(llamadas, 2);
});

test('rechaza respuestas que no son del SAE', async () => {
  await assert.rejects(consultarSae(1676, 5_000_000, async () => new Response('<html>error</html>')));
});
