/*
 * Gemelo digital del EMT Smart Display.
 *
 * - Device: traducción línea a línea de firmware/dashboard_emt/dashboard_emt.ino
 *   (mismas coordenadas, colores, textos, temporizadores y validaciones).
 * - DemoBackend: servidor simulado que imita server/app.py (normalización del SAE,
 *   caché de 15 s, último dato bueno) y server/avisos.py (aviso de salida).
 * - ServerBackend: el servidor real, cuando esta página la sirve app.py.
 */
'use strict';
(() => {
  // ------------------------------------------------------------------ reloj
  const Clock = {
    speed: 1,
    base: Date.now(),
    realBase: performance.now(),
    now() { return this.base + (performance.now() - this.realBase) * this.speed; },
    setSpeed(s) { this.base = this.now(); this.realBase = performance.now(); this.speed = s; },
    jump(ms) { this.base += ms; },
  };
  const TZ = 'Europe/Madrid';
  const hhmm = (ms, secs = false) => new Date(ms).toLocaleTimeString('es-ES', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}),
  });

  // --------------------------------------------------------------- registro
  const logEl = document.getElementById('log');
  function log(msg, kind = '') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    const t = document.createElement('time');
    t.textContent = hhmm(Clock.now(), true);
    li.append(t, document.createTextNode(msg));
    logEl.prepend(li);
    while (logEl.children.length > 60) logEl.lastChild.remove();
  }

  // ================================================================= FIRMWARE
  const FW = {
    busDelay: 20000, timeDelay: 10000, touchCooldown: 500,
    wifiRetryDelay: 10000, avisoDelay: 4000, avisoBanner: 60000, httpTimeout: 6000,
  };
  // Colores del firmware (tft.color565)
  const C = {
    BG: '#000000', CARD: '#1c1c1e', DIM: '#8e8e93', ACCENT: '#0a84ff', RED: '#ff453a',
    GREEN: '#30d158', ORANGE: '#ff9f0a', RAIN: '#5ac8fa', WHITE: '#ffffff', BLACK: '#000000',
  };
  const FONT = 'bold 13.5px "Liberation Sans", "Helvetica Neue", Arial, Helvetica, sans-serif';

  // sinAcentos(): misma tabla que el firmware (UTF-8 de 2 bytes 0xC3xx)
  const MAPA = 'AAAAAAACEEEEIIII' + 'DNOOOOO*OUUUUYTs' + 'aaaaaaaceeeeiiii' + 'dnooooo/ouuuuyty';
  function sinAcentos(s) {
    let out = '';
    for (const ch of s || '') {
      const c = ch.codePointAt(0);
      if (c < 0x80) out += ch;
      else if (c >= 0xC0 && c <= 0xFF) out += MAPA[c - 0xC0];
      // el resto de caracteres multibyte se descartan, como en el ESP32
    }
    return out;
  }

  class Device {
    constructor(canvas, net) {
      this.cv = canvas;
      this.k = canvas.width / 320;
      this.g = canvas.getContext('2d');
      this.net = net; // { backend, wifiUp() }
      this.paradas = [];
      this.paradaActual = 0;
      this.state = 'off';
    }

    reset() {
      const now = Clock.now();
      this.state = 'boot';
      this.bootUntil = now + 1500;
      this.wifi = false;
      this.lastBusUpdate = now; this.lastTimeUpdate = now; this.lastTouchTime = 0;
      this.lastWifiTry = now; this.lastAvisoCheck = now;
      this.ultimoAvisoId = ''; this.avisoTexto = ''; this.avisoHasta = 0;
      this.busy = false; this.avisoBusy = false; this.wifiPerdido = false;
      this.mensajeCentral('Conectando WiFi...', C.WHITE);
      log('Arranque: conectando WiFi');
    }

    // ---- primitivas de dibujo (coordenadas de la TFT 320x240)
    rect(x, y, w, h, c) { const g = this.g; g.fillStyle = c; g.fillRect(x * this.k, y * this.k, w * this.k, h * this.k); }
    rrect(x, y, w, h, r, c) {
      const g = this.g, k = this.k; g.fillStyle = c; g.beginPath();
      g.roundRect(x * k, y * k, w * k, h * k, r * k); g.fill();
    }
    circle(x, y, r, c) { const g = this.g, k = this.k; g.fillStyle = c; g.beginPath(); g.arc(x * k, y * k, r * k, 0, 7); g.fill(); }
    text(x, y, s, c) {
      const g = this.g; g.save(); g.scale(this.k, this.k); g.font = FONT; g.fillStyle = c;
      g.textBaseline = 'alphabetic'; g.fillText(s, x, y); const w = g.measureText(s).width; g.restore(); return w;
    }
    width(s) { const g = this.g; g.save(); g.font = FONT; const w = g.measureText(s).width; g.restore(); return w; }

    mensajeCentral(t, c) { this.rect(0, 0, 320, 240, C.BG); this.text(10, 110, t, c); }
    avisoActivo() { return this.avisoHasta !== 0 && Clock.now() < this.avisoHasta; }

    drawBanner() { this.rect(0, 0, 320, 35, C.GREEN); this.text(10, 24, this.avisoTexto, C.BLACK); }
    drawSinWifi(cabeceraEntera = false) {
      if (this.avisoActivo()) return;
      if (cabeceraEntera) {
        this.rect(0, 0, 320, 35, C.BG);
        this.text(10, 24, 'EMT ' + this.paradas[this.paradaActual], C.WHITE);
        this.drawClock();
      }
      this.rect(120, 0, 130, 35, C.BG); this.text(130, 24, 'Sin WiFi', C.RED);
    }
    drawLoading() {
      if (this.avisoActivo()) return;
      this.rect(0, 0, 250, 35, C.BG); this.text(10, 24, 'Actualizando...', C.ACCENT);
    }
    drawPagination() {
      const n = this.paradas.length, startX = 160 - ((n - 1) * 16) / 2;
      this.rect(0, 225, 320, 15, C.BG);
      for (let i = 0; i < n; i++) this.circle(startX + i * 16, 232, 4, i === this.paradaActual ? C.WHITE : C.DIM);
    }
    drawClock() {
      if (this.avisoActivo() || this.state === 'boot') return;
      this.rect(250, 0, 70, 35, C.BG); this.text(255, 24, hhmm(Clock.now()), C.WHITE);
    }
    drawHeader(doc) {
      if (this.avisoActivo()) { this.drawBanner(); return; }
      this.rect(0, 0, 250, 35, C.BG);
      this.text(10, 24, 'EMT ' + parseInt(doc.parada, 10), C.WHITE);
      this.text(130, 24, String(doc.clima ?? ''), C.ACCENT);
      this.text(195, 24, String(doc.prob_lluvia ?? ''), C.RAIN);
      if (doc.obsoleto) this.circle(244, 18, 3, C.ORANGE);
    }
    drawBody(doc) {
      this.rect(0, 36, 320, 188, C.BG);
      const llegadas = Array.isArray(doc.llegadas) ? doc.llegadas : [];
      if (llegadas.length === 0) {
        this.rrect(10, 50, 300, 60, 12, C.CARD);
        const av = Array.isArray(doc.avisos) ? doc.avisos : [];
        this.text(25, 85, av.length > 0 && av[0] === 'SENSE ESTIMACIONS' ? 'Sin servicio ahora' : 'Sin autobuses cercanos', C.DIM);
        return;
      }
      let yPos = 45;
      for (const bus of llegadas.slice(0, 3)) {
        const linea = String(bus.linea ?? '');
        let destino = sinAcentos(bus.destino || '');
        const texto = bus.texto ?? '?';
        if (destino.length > 12) destino = destino.substring(0, 11) + '.';

        this.rrect(10, yPos, 300, 52, 12, C.CARD);
        this.rrect(20, yPos + 10, 45, 32, 6, C.RED);
        const bw = this.width(linea);
        this.text(20 + (45 - bw) / 2, yPos + 32, linea, C.WHITE);
        this.text(75, yPos + 32, destino, C.DIM);

        if (bus.llegando) this.text(220, yPos + 32, 'Llega', C.GREEN);
        else if (bus.desviada) this.text(215, yPos + 32, 'Desviada', C.ORANGE);
        else if (bus.tiempo_real) { const w = this.text(225, yPos + 32, texto, C.WHITE); this.text(225 + w, yPos + 32, ' min', C.DIM); }
        else this.text(240, yPos + 32, texto, C.DIM);
        yPos += 60;
      }
    }

    // ---- red
    async fetchBusData() {
      if (this.busy || !this.paradas.length) return;
      this.busy = true;
      const id = this.paradas[this.paradaActual];
      let r;
      try { r = await this.net.backend.parada(id, FW.httpTimeout); } catch { r = { code: -1 }; }
      this.busy = false;
      if (r.code === 200 && r.json) {
        const doc = r.json;
        this.drawHeader(doc); this.drawClock(); this.drawBody(doc); this.drawPagination();
        const n = (doc.llegadas || []).length;
        log(`GET /api/parada/${id} → 200 · ${n} llegada${n === 1 ? '' : 's'}${doc.obsoleto ? ' · dato antiguo' : ''}`);
        return;
      }
      log(`GET /api/parada/${id} → ${r.code === -1 ? 'sin conexión' : r.code}`, 'bad');
      this.rect(0, 36, 320, 188, C.BG);
      this.text(10, 110, r.code === 502 ? 'EMT no disponible' : 'Sin conexion al servidor', C.RED);
      this.drawPagination();
    }

    async checkAviso() {
      if (this.avisoBusy) return;
      this.avisoBusy = true;
      let r;
      try { r = await this.net.backend.aviso(3000); } catch { r = { code: -1 }; }
      this.avisoBusy = false;
      if (r.code !== 200 || !r.json) return;
      const doc = r.json;
      const id = String(doc.id || '');
      if (!id || id.length > 16 || id === this.ultimoAvisoId) return;
      this.ultimoAvisoId = id;
      const linea = String(doc.linea || '').substring(0, 4);
      const minutos = Math.max(0, Math.min(99, parseInt(doc.minutos || 0, 10)));
      this.avisoTexto = `SAL YA  ${linea} en ${minutos} min`;
      this.avisoHasta = Clock.now() + FW.avisoBanner;
      this.drawBanner();
      const ruta = String(doc.audio || '');
      log(`Aviso ${id}: "${doc.texto || this.avisoTexto}"`, 'good');
      if (!ruta.startsWith('/api/audio/') || ruta.length > 40) { log('Ruta de audio rechazada', 'bad'); return; }
      this.net.backend.reproducir(ruta, doc);
    }

    touch(x) {
      if (this.state !== 'run' || Clock.now() - this.lastTouchTime <= FW.touchCooldown) return;
      const n = this.paradas.length; if (!n) return;
      const derecha = x > 160;
      this.paradaActual = derecha ? (this.paradaActual + 1) % n : (this.paradaActual - 1 + n) % n;
      log(`Toque ${derecha ? 'derecha' : 'izquierda'} → parada ${this.paradas[this.paradaActual]}`);
      this.drawLoading();
      this.fetchBusData();
      this.lastTouchTime = this.lastBusUpdate = Clock.now();
    }

    // ---- loop()
    tick() {
      if (this.state === 'off') return;
      const now = Clock.now();
      const wifiUp = this.net.wifiUp();
      if (this.state === 'boot') {
        if (now < this.bootUntil) return;
        if (!wifiUp) {
          this.mensajeCentral('Sin WiFi. Reintentando...', C.RED);
          this.bootUntil = now + 5000 + 1500;
          return;
        }
        this.state = 'run'; this.wifi = true;
        log('WiFi conectado');
        this.fetchBusData(); this.lastBusUpdate = now;
        return;
      }
      // WiFi caído: aviso en pantalla y reintento cada 10 s sin bloquear
      if (this.wifi && !wifiUp) { this.wifi = false; log('WiFi perdido', 'bad'); }
      if (!this.wifi && !this.wifiPerdido) { this.wifiPerdido = true; this.drawSinWifi(); }
      if (!this.wifi && now - this.lastWifiTry > FW.wifiRetryDelay) {
        this.lastWifiTry = now;
        if (wifiUp) { this.wifi = true; log('WiFi reconectado', 'good'); } else log('Reintentando WiFi...');
      }
      if (this.wifi && this.wifiPerdido) { this.wifiPerdido = false; this.fetchBusData(); this.lastBusUpdate = now; }
      if (now - this.lastBusUpdate > FW.busDelay) {
        if (this.wifi) this.fetchBusData();
        this.lastBusUpdate = now;
      }
      if (now - this.lastTimeUpdate > FW.timeDelay) { this.drawClock(); this.lastTimeUpdate = now; }
      if (this.wifi && now - this.lastAvisoCheck > FW.avisoDelay) { this.checkAviso(); this.lastAvisoCheck = now; }
      if (this.avisoHasta !== 0 && now >= this.avisoHasta) {
        this.avisoHasta = 0;
        if (this.wifi) this.fetchBusData(); else this.drawSinWifi(true);
        this.lastBusUpdate = now;
      }
    }

    nextRefreshIn() { return Math.max(0, FW.busDelay - (Clock.now() - this.lastBusUpdate)); }
  }

  // ==================================================================== AUDIO
  const Sound = {
    on: false, volume: 0.6, speaking: false,
    pulse(on) { document.getElementById('speaker').classList.toggle('playing', on); },
    beep() {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        let t = ac.currentTime;
        for (const [f, d] of [[880, 0.18], [0, 0.06], [1320, 0.28]]) {
          if (f) {
            const o = ac.createOscillator(), g = ac.createGain();
            o.frequency.value = f; g.gain.setValueAtTime(0.25 * this.volume, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
            o.connect(g).connect(ac.destination); o.start(t); o.stop(t + d);
          }
          t += d;
        }
      } catch { /* sin audio */ }
    },
    say(texto) {
      if (!this.on) { log('Sonido desactivado: actívalo en el panel para oír el aviso'); return; }
      this.pulse(true);
      const fin = () => this.pulse(false);
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = 'es-ES'; u.volume = this.volume; u.rate = 1.02;
        const voz = speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('es'));
        if (voz) u.voice = voz;
        u.onend = fin; u.onerror = () => { fin(); this.beep(); };
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      } else { this.beep(); setTimeout(fin, 600); }
    },
    playUrl(url) {
      if (!this.on) { log('Sonido desactivado: actívalo en el panel para oír el aviso'); return; }
      const a = new Audio(url); a.volume = this.volume;
      this.pulse(true); a.onended = a.onerror = () => this.pulse(false);
      a.play().catch(() => this.pulse(false));
    },
  };

  // ============================================================ SERVIDOR REAL
  async function http(url, timeout) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      let json = null;
      if (r.status !== 204) { try { json = await r.json(); } catch { json = null; } }
      return { code: r.status, json };
    } catch { return { code: -1 }; } finally { clearTimeout(to); }
  }
  const ServerBackend = {
    name: 'Servidor real',
    parada: (id, t) => http(`/api/parada/${id}`, t),
    aviso: (t) => http('/api/aviso', t),
    reproducir: (ruta) => Sound.playUrl(ruta),
  };

  // ========================================================== SERVIDOR DEMO
  // Paradas reales del centro de València con sus líneas (datos de ejemplo).
  const RED_DEMO = {
    708: [['19', 'La Malva-rosa', 12, 3], ['93', 'Pass. Marítim', 15, 8], ['70', 'Alboraia', 20, 1]],
    1676: [['7', 'Mercat Central', 13, 5], ['27', 'Mercat Central', 18, 11], ['81', 'Est.del Nord', 22, 2]],
    2080: [['8', 'Pta.de la Mar', 16, 6], ['C1', 'Cntr.Històric', 10, 4], ['40', 'Universitats', 14, 9]],
  };
  const PARADAS_DEMO = Object.keys(RED_DEMO).map(Number);

  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

  const Demo = {
    name: 'Demo simulada',
    flags: { emtDown: false, serverDown: false, sinServicio: new Set(), desviada: new Set() },
    extra: [],               // autobuses añadidos por los escenarios: {parada, linea, destino, t}
    cache: {},               // parada -> {ts, llegadas, avisos}
    rule: { parada: 708, andando: 5, activo: true },
    avisos: [], anunciados: {}, lastRuleCheck: 0,
    clima: { temp: '17 C', lluvia: '20%' },

    // Lo que contestaría el SAE: lista de {linea, destino, minutos(texto)}
    sae(parada, now) {
      if (this.flags.sinServicio.has(parada)) return { buses: [], error: 'SENSE ESTIMACIONS' };
      const dia = new Date(now); dia.setHours(0, 0, 0, 0);
      const out = [];
      for (const [linea, destino, headway, fase] of RED_DEMO[parada]) {
        if (this.flags.desviada.has(`${parada}:${linea}`)) { out.push({ linea, destino, minutos: 'LÍNIA DESVIADA' }); continue; }
        const llegadas = [];
        const k0 = Math.floor((now - dia - fase * 60000) / (headway * 60000));
        for (let k = k0; k < k0 + 6; k++) {
          const ruido = (hash(`${linea}${k}`) - 0.5) * 120000;
          const t = dia.getTime() + fase * 60000 + k * headway * 60000 + ruido;
          if (t > now - 20000 && t < now + 75 * 60000) llegadas.push(t);
        }
        for (const e of this.extra) if (e.parada === parada && e.linea === linea && e.t > now - 20000) llegadas.push(e.t);
        llegadas.sort((a, b) => a - b).forEach((t, i) => out.push({ linea, destino, t, i }));
      }
      return {
        buses: out.map(b => {
          if (b.minutos) return b;
          const dt = b.t - now;
          let minutos;
          if (dt <= 50000) minutos = 'Pròxim';
          else if (b.i < 2 && dt <= 45 * 60000) minutos = `${Math.floor(dt / 60000)} min.`;
          else minutos = new Date(b.t).toLocaleTimeString('es-ES', { timeZone: TZ, hour12: false });
          return { linea: b.linea, destino: b.destino, minutos };
        }),
      };
    },

    // Normalización de server/app.py (parsear_sae)
    normalizar(sae, now) {
      if (sae.error) return { llegadas: [], avisos: [sae.error] };
      const ahora = now / 1000;
      const llegadas = sae.buses.map(b => {
        const t = b.minutos.toLowerCase();
        const desviada = t.includes('desvia');
        let minutos = null, llegando = false, hora = null;
        if (desviada) { /* sin estimación */ } else if (t.startsWith('pr')) { minutos = 0; llegando = true; } else if (t.includes('min')) minutos = parseInt(t, 10); else hora = b.minutos.substring(0, 5);
        let llega_a = null;
        if (minutos !== null) llega_a = Math.floor(ahora + minutos * 60);
        else if (hora) {
          const [h, m] = hora.split(':').map(Number);
          const d = new Date(now); d.setHours(h, m, 0, 0);
          llega_a = Math.floor(d.getTime() / 1000); if (llega_a < ahora - 3600) llega_a += 86400;
        }
        return {
          linea: b.linea, destino: b.destino, minutos, llegando, hora, tiempo_real: minutos !== null, desviada,
          texto: llegando ? '0' : minutos !== null ? String(minutos) : desviada ? 'Desviada' : hora, llega_a,
        };
      });
      llegadas.sort((a, b) => (a.llega_a ?? Infinity) - (b.llega_a ?? Infinity));
      // Igual que app.py: las desviadas en la 3.ª posición para que se vean
      const desv = llegadas.filter(b => b.desviada), norm = llegadas.filter(b => !b.desviada);
      return { llegadas: desv.length ? [...norm.slice(0, 2), ...desv, ...norm.slice(2)] : llegadas, avisos: [] };
    },

    // obtener_llegadas(): caché de 15 s y último dato bueno 5 min
    obtener(parada, now) {
      const c = this.cache[parada];
      if (c && now - c.ts < 15000) return { ...c, error: null };
      if (this.flags.emtDown) {
        if (c && now - c.ts < 300000) return { ...c, error: 'EMT caída' };
        throw new Error('EMT no disponible');
      }
      const d = this.normalizar(this.sae(parada, now), now);
      this.cache[parada] = { ts: now, ...d };
      return { ...this.cache[parada], error: null };
    },

    async parada(id) {
      await new Promise(r => setTimeout(r, 60 + Math.random() * 90)); // latencia LAN + EMT
      if (this.flags.serverDown) return { code: -1 };
      if (!RED_DEMO[id]) return { code: 404 };
      const now = Clock.now();
      try {
        const d = this.obtener(id, now);
        return { code: 200, json: {
          success: true, parada: id, clima: this.clima.temp, prob_lluvia: this.clima.lluvia,
          llegadas: d.llegadas, avisos: d.avisos, servidor_ts: Math.floor(now / 1000),
          edad_dato_s: Math.floor((now - d.ts) / 1000), obsoleto: d.error !== null,
        } };
      } catch {
        return { code: 502, json: { success: false, parada: id, error: 'EMT no disponible', clima: this.clima.temp, prob_lluvia: this.clima.lluvia, llegadas: [] } };
      }
    },

    // server/avisos.py: revisar() cada 10 s
    tick(now) {
      if (now - this.lastRuleCheck < 10000) return;
      this.lastRuleCheck = now;
      this.avisos = this.avisos.filter(a => now - a.ts < 90000);
      for (const k of Object.keys(this.anunciados)) if (this.anunciados[k] < now / 1000 - 1800) delete this.anunciados[k];
      if (!this.rule.activo || this.flags.serverDown) return;
      let llegadas;
      try { llegadas = this.obtener(this.rule.parada, now).llegadas; } catch { return; }
      const ahora = now / 1000;
      for (const bus of llegadas) {
        if (!bus.tiempo_real || bus.llega_a == null) continue;
        const salir_en = bus.llega_a - ahora - this.rule.andando * 60;
        if (salir_en < -30 || salir_en > 60) continue;
        const clave = `${this.rule.parada}:${bus.linea}`;
        const previo = this.anunciados[clave];
        if (previo != null && Math.abs(previo - bus.llega_a) < 180) continue;
        this.anunciados[clave] = bus.llega_a;
        const minutos = Math.max(0, Math.round((bus.llega_a - ahora) / 60));
        const id = Math.floor(hash(clave + bus.llega_a) * 0xffffffffff).toString(16).padStart(10, '0').slice(0, 10);
        this.avisos.push({ id, ts: now, parada: this.rule.parada, linea: bus.linea, minutos,
          texto: `Sal ya. La ${bus.linea} hacia ${bus.destino} llega en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.` });
        break;
      }
    },

    async aviso() {
      await new Promise(r => setTimeout(r, 40));
      if (this.flags.serverDown) return { code: -1 };
      const now = Clock.now();
      const v = this.avisos.filter(a => now - a.ts < 90000);
      if (!v.length) return { code: 204 };
      const a = { ...v[v.length - 1] };
      a.audio = `/api/audio/${a.id}.wav`;
      return { code: 200, json: a };
    },
    reproducir(_ruta, doc) { Sound.say(doc.texto || 'Sal ya'); },
  };

  // ==================================================================== UI
  const $ = (id) => document.getElementById(id);
  const net = { backend: Demo, wifiDown: false, wifiUp() { return !this.wifiDown; } };
  const device = new Device($('tft'), net);
  let realDisponible = false;

  function setParadas(list) {
    device.paradas = list; device.paradaActual = 0;
    const sel = $('ruleStop'); sel.textContent = '';
    for (const p of list) { const o = document.createElement('option'); o.value = p; o.textContent = `Parada ${p}`; sel.append(o); }
    if (list.includes(Demo.rule.parada)) sel.value = String(Demo.rule.parada); else Demo.rule.parada = list[0];
  }

  async function setMode(mode) {
    const real = mode === 'real' && realDisponible;
    net.backend = real ? ServerBackend : Demo;
    document.body.dataset.mode = real ? 'real' : 'demo';
    $('modeDemo').checked = !real; $('modeReal').checked = real;
    if (real) {
      Clock.setSpeed(1); syncSpeed();
      const r = await http('/api/config', 3000);
      setParadas(r.json?.paradas?.length ? r.json.paradas : PARADAS_DEMO);
    } else setParadas(PARADAS_DEMO);
    $('stSource').textContent = net.backend.name;
    log(`Fuente de datos: ${net.backend.name}`);
    device.reset();
  }

  function syncSpeed() {
    for (const el of document.querySelectorAll('input[name="speed"]')) el.checked = Number(el.value) === Clock.speed;
  }

  // Toque: coordenada x en la pantalla de 320 px
  $('tft').addEventListener('pointerdown', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 320;
    const ripple = $('ripple');
    ripple.style.left = `${e.clientX - r.left}px`; ripple.style.top = `${e.clientY - r.top}px`;
    ripple.classList.remove('on'); void ripple.offsetWidth; ripple.classList.add('on');
    device.touch(x);
  });
  $('tapL').addEventListener('click', () => device.touch(60));
  $('tapR').addEventListener('click', () => device.touch(260));

  for (const el of document.querySelectorAll('input[name="mode"]')) el.addEventListener('change', () => setMode(el.value));
  for (const el of document.querySelectorAll('input[name="speed"]')) {
    el.addEventListener('change', () => { Clock.setSpeed(Number(el.value)); log(`Velocidad del tiempo ×${el.value}`); });
  }
  $('jump').addEventListener('click', () => { Clock.jump(5 * 60000); log('Adelantado 5 minutos'); });

  // Escenarios
  const paradaVista = () => device.paradas[device.paradaActual];
  function toggleBtn(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  $('scArrive').addEventListener('click', () => {
    const p = paradaVista(); if (!RED_DEMO[p]) return;
    const [linea, destino] = RED_DEMO[p][0];
    Demo.extra.push({ parada: p, linea, destino, t: Clock.now() + 40000 });
    Demo.cache = {}; log(`Escenario: la ${linea} llega ya a la parada ${p}`);
    device.lastBusUpdate = 0;
  });
  $('scNoService').addEventListener('click', (e) => {
    const p = paradaVista(); const s = Demo.flags.sinServicio;
    s.has(p) ? s.delete(p) : s.add(p); Demo.cache = {};
    toggleBtn(e.currentTarget, s.has(p)); log(`Escenario: parada ${p} ${s.has(p) ? 'sin servicio' : 'con servicio'}`);
    device.lastBusUpdate = 0;
  });
  $('scDetour').addEventListener('click', (e) => {
    const p = paradaVista(); if (!RED_DEMO[p]) return;
    const key = `${p}:${RED_DEMO[p][0][0]}`; const s = Demo.flags.desviada;
    s.has(key) ? s.delete(key) : s.add(key); Demo.cache = {};
    toggleBtn(e.currentTarget, s.has(key)); log(`Escenario: línea ${RED_DEMO[p][0][0]} ${s.has(key) ? 'desviada' : 'normal'}`);
    device.lastBusUpdate = 0;
  });
  $('scEmt').addEventListener('click', (e) => {
    Demo.flags.emtDown = !Demo.flags.emtDown; toggleBtn(e.currentTarget, Demo.flags.emtDown);
    log(Demo.flags.emtDown ? 'Escenario: la EMT deja de responder' : 'Escenario: la EMT vuelve');
  });
  $('scServer').addEventListener('click', (e) => {
    Demo.flags.serverDown = !Demo.flags.serverDown; toggleBtn(e.currentTarget, Demo.flags.serverDown);
    log(Demo.flags.serverDown ? 'Escenario: servidor apagado' : 'Escenario: servidor encendido');
  });
  $('scWifi').addEventListener('click', (e) => {
    net.wifiDown = !net.wifiDown; toggleBtn(e.currentTarget, net.wifiDown);
    log(net.wifiDown ? 'Escenario: se cae el WiFi de casa' : 'Escenario: vuelve el WiFi');
  });
  $('scAviso').addEventListener('click', () => {
    const p = Demo.rule.parada; const [linea, destino] = RED_DEMO[p]?.[0] || [];
    if (!linea) return;
    Demo.extra.push({ parada: p, linea, destino, t: Clock.now() + (Demo.rule.andando * 60 + 50) * 1000 });
    Demo.cache = {}; Demo.lastRuleCheck = 0;
    log(`Escenario: la ${linea} se acerca a la parada ${p}; toca salir de casa`);
  });
  $('scReset').addEventListener('click', () => {
    Demo.flags.emtDown = Demo.flags.serverDown = false; Demo.flags.sinServicio.clear(); Demo.flags.desviada.clear();
    Demo.extra = []; Demo.cache = {}; net.wifiDown = false;
    for (const b of document.querySelectorAll('[aria-pressed]')) toggleBtn(b, false);
    log('Escenarios restablecidos'); device.lastBusUpdate = 0;
  });

  // Regla de aviso
  $('ruleStop').addEventListener('change', (e) => { Demo.rule.parada = Number(e.target.value); Demo.anunciados = {}; });
  $('ruleWalk').addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(30, parseInt(e.target.value || '0', 10))); e.target.value = v; Demo.rule.andando = v;
  });
  $('ruleOn').addEventListener('change', (e) => { Demo.rule.activo = e.target.checked; });

  // Sonido
  $('soundBtn').addEventListener('click', () => {
    Sound.on = !Sound.on; toggleBtn($('soundBtn'), Sound.on);
    $('soundBtn').textContent = Sound.on ? 'Sonido activado' : 'Activar sonido';
    if (Sound.on) Sound.say('Sonido activado');
  });
  $('vol').addEventListener('input', (e) => { Sound.volume = Number(e.target.value); $('volOut').textContent = Sound.volume.toFixed(1); });
  $('testVoice').addEventListener('click', () => {
    if (!Sound.on) { Sound.on = true; toggleBtn($('soundBtn'), true); $('soundBtn').textContent = 'Sonido activado'; }
    Sound.say('Sal ya. La 19 hacia La Malva-rosa llega en 6 minutos.');
  });

  // Bucle principal
  function frame() {
    if (net.backend === Demo) Demo.tick(Clock.now());
    device.tick();
    $('simClock').textContent = hhmm(Clock.now(), true);
    $('stWifi').textContent = device.state === 'boot' ? 'conectando' : device.wifi ? 'conectado' : 'sin conexión';
    $('stWifi').dataset.ok = device.wifi ? '1' : '0';
    $('stNext').textContent = device.state === 'run' ? `${Math.ceil(device.nextRefreshIn() / 1000)} s` : '—';
    $('stStop').textContent = device.paradas.length ? device.paradas[device.paradaActual] : '—';
    $('stAviso').textContent = device.avisoActivo() ? `banner ${Math.ceil((device.avisoHasta - Clock.now()) / 1000)} s` : 'ninguno';
  }
  setInterval(frame, 50);

  // Arranque: si esta página la sirve app.py, el modo real está disponible
  (async () => {
    const r = await http('/api/config', 1500);
    realDisponible = r.code === 200 && Array.isArray(r.json?.paradas);
    $('modeReal').disabled = !realDisponible;
    $('realNote').hidden = realDisponible;
    await setMode(realDisponible ? 'real' : 'demo');
  })();
})();
