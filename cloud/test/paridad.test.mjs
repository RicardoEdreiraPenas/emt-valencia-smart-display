// Paridad con el servidor en Python: mismas entradas -> mismos datos.
// El JSON lo genera server/tests/paridad.py (y test_paridad.py vigila que esté al día).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parsearSae, climaDe, iconoWmo, reglasActivas, evaluar, tonoWav,
} from '../src/nucleo.js';

const aqui = new URL('.', import.meta.url);
const fixtures = new URL('../../server/tests/fixtures/', import.meta.url);
const P = JSON.parse(readFileSync(new URL('paridad.json', aqui), 'utf8'));
const decodificar = (nombre) => new TextDecoder().decode(readFileSync(new URL(nombre, fixtures)));

for (const caso of P.sae) {
  test(`SAE ${caso.fixture} (${caso.instante})`, () => {
    const r = parsearSae(decodificar(caso.fixture), caso.ahora);
    assert.deepEqual(r.llegadas, caso.llegadas);
    assert.deepEqual(r.avisos, caso.avisos);
  });
}

test('tiempo de Open-Meteo', () => {
  const datos = JSON.parse(readFileSync(new URL(P.clima.fixture, fixtures), 'utf8'));
  assert.deepEqual(climaDe(datos), P.clima.esperado);
});

test('iconos del tiempo (códigos WMO 0-100)', () => {
  for (const [codigo, icono] of Object.entries(P.iconos)) {
    assert.equal(iconoWmo(codigo === 'None' ? null : codigo), icono, `código ${codigo}`);
  }
});

test('franjas de los avisos y silencio nocturno (una semana)', () => {
  for (const f of P.franjas) {
    assert.deepEqual(reglasActivas(f.ahora, P.reglas, P.silencio).map((r) => r.parada), f.activas, `ts ${f.ahora}`);
  }
});

test('secuencia de avisos de salida: mismos avisos, mismos ids, uno por bus', async () => {
  const anunciados = new Map();
  for (const paso of P.avisos) {
    const nuevo = await evaluar(P.regla_avisos, paso.llegadas, paso.ahora,
      async (p, l) => anunciados.get(`${p}/${l}`) ?? null);
    if (nuevo) anunciados.set(`${nuevo.parada}/${nuevo.linea}`, nuevo.llega_a);
    const sinLlegada = nuevo && (({ llega_a, ...resto }) => resto)(nuevo);
    assert.deepEqual(sinLlegada ? [sinLlegada] : [], paso.nuevos, `t=${paso.ahora}`);
  }
});

test('avisos filtrados por línea', async () => {
  const c = P.por_lineas;
  const nuevo = await evaluar(c.regla, c.llegadas, c.ahora, async () => null);
  const { llega_a, ...resto } = nuevo;
  assert.deepEqual([resto], c.nuevos);
});

test('tono de aviso idéntico byte a byte', () => {
  const wav = tonoWav();
  assert.equal(wav.length, P.tono.bytes);
  assert.equal(createHash('sha256').update(wav).digest('hex'), P.tono.sha256);
});
