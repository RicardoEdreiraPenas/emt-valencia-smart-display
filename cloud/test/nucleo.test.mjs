import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearSae, arreglarCodificacion, redondeoPython, arreglarWav, tonoWav, horaAEpoch } from '../src/nucleo.js';

test('XML: CDATA, entidades y mensajes de la EMT', () => {
  const xml = `<?xml version="1.0"?><estimacion><solo_parada>
    <bus><linea>C1</linea><destino>Pl. Am&amp;rica &#233;</destino><minutos>Pr&#242;xim</minutos><horaLlegada/><error/></bus>
    <bus><linea>7</linea><destino><![CDATA[A & B <x>]]></destino><minutos>3 min.</minutos><horaLlegada /><error /></bus>
    <bus><error>SENSE ESTIMACIONS</error></bus>
  </solo_parada></estimacion>`;
  const { llegadas, avisos } = parsearSae(xml, 1000);
  assert.equal(llegadas[0].destino, 'Pl. Am&rica é');
  assert.equal(llegadas[0].llegando, true);
  assert.equal(llegadas[1].destino, 'A & B <x>');
  assert.deepEqual(avisos, ['SENSE ESTIMACIONS']);
});

test('XML mal formado o inesperado: error', () => {
  assert.throws(() => parsearSae('<html><body>Error</body></html>'), /inesperada/);
  assert.throws(() => parsearSae('<estimacion><solo_parada><bus>'), /mal formado/);
  assert.throws(() => parsearSae(''), /vacía/);
});

test('minutos ilegibles y formatos desconocidos van a avisos', () => {
  const b = (m) => `<bus><linea>1</linea><destino>x</destino><minutos>${m}</minutos><horaLlegada/><error/></bus>`;
  const { llegadas, avisos } = parsearSae(`<estimacion><p>${b('xx min.')}${b('raro')}${b('')}</p></estimacion>`, 0);
  assert.deepEqual(llegadas, []);
  assert.deepEqual(avisos, ['Minutos ilegibles: xx min.', 'Formato desconocido: raro']);
});

test('doble codificación', () => {
  assert.equal(arreglarCodificacion('EstaciÃ³ del Nord'), 'Estació del Nord');
  assert.equal(arreglarCodificacion('Estació'), 'Estació');
  assert.equal(arreglarCodificacion('Ŝ'), 'Ŝ');
});

test('redondeo como Python', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, -0.5, 2.4, 2.6].map(redondeoPython), [0, 2, 2, 4, -0, 2, 3]);
});

test('hora prevista que cruza la medianoche', () => {
  const t = Date.UTC(2026, 10, 2, 22, 50) / 1000;   // 23:50 en Madrid
  assert.equal(horaAEpoch('00:10', t), t + 20 * 60);
  assert.equal(horaAEpoch('23:30', t), t - 20 * 60);
  assert.equal(horaAEpoch('xx', t), null);
});

test('WAV: rechaza lo que no es PCM 16 bits y recorta bytes impares', () => {
  assert.equal(arreglarWav(new Uint8Array(10)), null);
  const t = tonoWav();
  const impar = new Uint8Array(t.length + 1); impar.set(t);
  assert.equal(arreglarWav(impar).length, t.length);
  const ulaw = t.slice(); new DataView(ulaw.buffer).setUint16(20, 7, true);
  assert.equal(arreglarWav(ulaw), null);
});
