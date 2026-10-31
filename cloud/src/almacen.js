/**
 * Estado compartido del Worker sin bases de datos: la Cache API de Cloudflare.
 *
 * Cada petición del ESP32 entra por el centro de datos de Cloudflare más
 * cercano, y la Cache API es coherente dentro de ese centro: todas las
 * instancias del Worker que atienden a tu casa ven los mismos datos. Es
 * gratis y no hay que crear nada (ni KV ni Durable Objects).
 *
 * Además se guarda una copia en la memoria de la instancia, que ahorra la
 * consulta a la caché cuando la instancia está caliente.
 */

const BASE = 'https://estado.emt-display.internal/';

export class Almacen {
  constructor(cache = globalThis.caches?.default ?? null) {
    this.cache = cache;
    this.memoria = new Map();   // clave -> { hasta, valor }
  }

  async get(clave, ahora = Date.now()) {
    const m = this.memoria.get(clave);
    if (m && m.hasta > ahora) return m.valor;
    if (m) this.memoria.delete(clave);
    if (!this.cache) return null;
    const r = await this.cache.match(BASE + encodeURIComponent(clave));
    if (!r) return null;
    const hasta = Number(r.headers.get('X-Hasta')) || 0;
    if (hasta <= ahora) return null;
    const valor = r.headers.get('Content-Type') === 'audio/wav'
      ? new Uint8Array(await r.arrayBuffer())
      : await r.json();
    this.memoria.set(clave, { hasta, valor });
    return valor;
  }

  async put(clave, valor, ttlS, ahora = Date.now()) {
    const hasta = ahora + ttlS * 1000;
    this.memoria.set(clave, { hasta, valor });
    if (this.memoria.size > 200) this.memoria.delete(this.memoria.keys().next().value);
    if (!this.cache) return;
    const binario = valor instanceof Uint8Array;
    await this.cache.put(BASE + encodeURIComponent(clave), new Response(binario ? valor : JSON.stringify(valor), {
      headers: {
        'Content-Type': binario ? 'audio/wav' : 'application/json',
        'Cache-Control': `max-age=${Math.max(1, Math.ceil(ttlS))}`,
        'X-Hasta': String(hasta),
      },
    }));
  }
}
