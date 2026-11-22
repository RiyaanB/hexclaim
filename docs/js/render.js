// Canvas board renderer + animation system. Knows nothing about game modes; app.js drives it.
import { geometry } from './engine.js';

export const PCOL = [
  null,
  { base: '#ff6b57', light: '#ffb3a5', dark: '#b83a29', glow: 'rgba(255,107,87,', name: 'Coral' },
  { base: '#27cbbb', light: '#9af5eb', dark: '#0f7b71', glow: 'rgba(39,203,187,', name: 'Teal' },
  { base: '#ffbf3c', light: '#ffe6a6', dark: '#b97c08', glow: 'rgba(255,191,60,', name: 'Amber' },
  { base: '#a283ff', light: '#dccfff', dark: '#5f3ed0', glow: 'rgba(162,131,255,', name: 'Violet' },
];
const SQ3 = Math.sqrt(3);
const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};

export class BoardView {
  constructor(canvas, { decorative = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.decorative = decorative;
    this.state = null; this.g = null;
    this.anims = []; this.particles = []; this.floaters = []; this.rings = [];
    this.shakeT = 0; this.shakeMag = 0;
    this.speed = 1;
    this.sel = -1; this.targets = null; this.hover = -1; this.cursor = -1; this.showCursor = false;
    this.preview = null; // { to, from, kind, flips:[i], player }
    this.hintSources = []; this.hintUntil = 0;
    this.lastMove = null;
    this.reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.sprites = new Map();
    this.running = false;
    this._frame = this._frame.bind(this);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  /* ---------- layout ---------- */
  resize() {
    const el = this.canvas;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    el.width = Math.round(w * this.dpr); el.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    this.layout();
    this.draw(performance.now());
  }
  setState(state, { keepAnims = false } = {}) {
    const specChanged = !this.state || this.state.spec !== state.spec;
    this.state = state;
    this.g = geometry(state.spec);
    if (!keepAnims) { this.anims = []; this.particles = []; this.floaters = []; this.rings = []; }
    if (specChanged) this.layout();
    this.start();
  }
  layout() {
    if (!this.g || !this.w) return;
    const R = this.g.R;
    const pad = this.decorative ? 0 : 6;
    const wUnits = 3 * R + 2, hUnits = SQ3 * (2 * R + 1);
    this.size = Math.max(4, Math.min((this.w - pad * 2) / wUnits, (this.h - pad * 2) / hUnits));
    if (this.decorative) this.size = Math.sqrt(Math.max(this.w / wUnits, this.h / hUnits) * Math.min(this.w / wUnits, this.h / hUnits)) * 1.05;
    this.cx = this.w / 2; this.cy = this.h / 2;
    this.pos = this.g.cells.map((c) => this.axial(c.q, c.r));
    this.sprites.clear();
    this.buildBackground();
  }
  axial(q, r) { return { x: this.cx + this.size * 1.5 * q, y: this.cy + this.size * SQ3 * (r + q / 2) }; }
  /** Cell center in CSS pixels relative to the canvas. */
  cellCenter(i) { const p = this.pos[i]; return { x: p.x, y: p.y }; }
  hitTest(x, y) {
    if (!this.g) return -1;
    const fx = (x - this.cx) / this.size, fy = (y - this.cy) / this.size;
    const q = (2 / 3) * fx, r = (-1 / 3) * fx + (SQ3 / 3) * fy;
    let rx = Math.round(q), rz = Math.round(r), ry = Math.round(-q - r);
    const dx = Math.abs(rx - q), dz = Math.abs(rz - r), dy = Math.abs(ry + q + r);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dz > dy) rz = -rx - ry;
    return this.g.at(rx, rz);
  }
  hexPath(ctx, x, y, s) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k; const px = x + s * Math.cos(a), py = y + s * Math.sin(a); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath();
  }

  buildBackground() {
    const { g, size: s } = this;
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    ctx.scale(this.dpr, this.dpr);
    // rim / shadow under every tile
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = s * 0.6; ctx.shadowOffsetY = s * 0.18;
    ctx.fillStyle = '#0a0e1a';
    for (const p of this.pos) { this.hexPath(ctx, p.x, p.y + s * 0.08, s * 1.0); ctx.fill(); }
    ctx.restore();
    // pits (holes)
    for (const h of g.holeCells) {
      const p = this.axial(h.q, h.r);
      this.hexPath(ctx, p.x, p.y, s * 0.9);
      const gr = ctx.createRadialGradient(p.x, p.y - s * 0.2, s * 0.1, p.x, p.y, s);
      gr.addColorStop(0, '#05070e'); gr.addColorStop(1, '#0b1020');
      ctx.fillStyle = gr; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1; ctx.stroke();
    }
    // tiles
    for (const p of this.pos) {
      this.hexPath(ctx, p.x, p.y, s * 0.93);
      const gr = ctx.createLinearGradient(p.x, p.y - s, p.x, p.y + s);
      gr.addColorStop(0, '#2b3765'); gr.addColorStop(0.55, '#212b52'); gr.addColorStop(1, '#19213f');
      ctx.fillStyle = gr; ctx.fill();
      ctx.lineWidth = Math.max(1, s * 0.05); ctx.strokeStyle = 'rgba(160,180,255,0.13)'; ctx.stroke();
      // inner bevel
      this.hexPath(ctx, p.x, p.y, s * 0.72);
      ctx.fillStyle = 'rgba(8,12,26,0.22)'; ctx.fill();
    }
    this.bg = c;
  }

  sprite(p, r) {
    const key = p + ':' + Math.round(r * this.dpr);
    let c = this.sprites.get(key);
    if (c) return c;
    const R = Math.ceil(r * this.dpr * 1.25);
    c = document.createElement('canvas'); c.width = c.height = R * 2;
    const x = c.getContext('2d'); const pr = r * this.dpr; const col = PCOL[p];
    x.translate(R, R);
    // body
    const gr = x.createRadialGradient(-pr * 0.35, -pr * 0.45, pr * 0.1, 0, 0, pr * 1.05);
    gr.addColorStop(0, col.light); gr.addColorStop(0.45, col.base); gr.addColorStop(1, col.dark);
    x.beginPath(); x.arc(0, 0, pr, 0, Math.PI * 2); x.fillStyle = gr; x.fill();
    x.lineWidth = Math.max(1, pr * 0.07); x.strokeStyle = 'rgba(0,0,0,0.35)'; x.stroke();
    // top gloss
    x.beginPath(); x.ellipse(-pr * 0.12, -pr * 0.46, pr * 0.55, pr * 0.28, -0.2, 0, Math.PI * 2);
    x.fillStyle = 'rgba(255,255,255,0.28)'; x.fill();
    // glyph (shape differs per player for colour-blind play)
    x.fillStyle = 'rgba(0,0,0,0.26)'; x.strokeStyle = 'rgba(0,0,0,0.3)'; x.lineWidth = pr * 0.14;
    const gs = pr * 0.34;
    x.beginPath();
    if (p === 1) { x.arc(0, pr * 0.06, gs * 0.85, 0, Math.PI * 2); x.stroke(); }
    else if (p === 2) { x.moveTo(0, -gs + pr * 0.06); x.lineTo(gs, pr * 0.06); x.lineTo(0, gs + pr * 0.06); x.lineTo(-gs, pr * 0.06); x.closePath(); x.fill(); }
    else if (p === 3) { x.moveTo(0, -gs); x.lineTo(gs * 1.05, gs * 0.8); x.lineTo(-gs * 1.05, gs * 0.8); x.closePath(); x.fill(); }
    else { x.rect(-gs * 0.8, -gs * 0.8 + pr * 0.06, gs * 1.6, gs * 1.6); x.fill(); }
    this.sprites.set(key, c);
    return c;
  }
  drawPiece(ctx, p, x, y, { sx = 1, sy = 1, alpha = 1, lift = 0, shadow = true } = {}) {
    const r = this.size * 0.6;
    if (shadow) {
      ctx.save(); ctx.globalAlpha = alpha * 0.35 * Math.max(0.3, 1 - lift / (this.size * 1.4));
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x, y + r * 0.32, r * Math.abs(sx) * 0.95, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    const spr = this.sprite(p, r);
    const S = spr.width / this.dpr;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.translate(x, y - lift); ctx.scale(sx, sy);
    ctx.drawImage(spr, -S / 2, -S / 2, S, S);
    ctx.restore();
  }

  /* ---------- animations ---------- */
  dur(ms) { return ms / this.speed; }
  /**
   * Animate a move result from engine.applyMove. Returns a Promise resolved when everything settled.
   * hooks: { onLand(), onFlip(k, i), onClaim() } for sounds.
   */
  animateMove(res, hooks = {}) {
    const now = performance.now();
    const { player: p, kind, flips, claimed } = res;
    const m = res.state.lastMove;
    const moveDur = this.dur(kind === 'jump' ? 380 : 240);
    this.anims.push({ type: kind, from: m.from, to: m.to, p, start: now, dur: moveDur, landed: false, onLand: hooks.onLand });
    // order flips clockwise around the landing hex for a cascade
    const c = this.pos[m.to];
    const ordered = flips.slice().sort((a, b) => Math.atan2(this.pos[a.i].y - c.y, this.pos[a.i].x - c.x) - Math.atan2(this.pos[b.i].y - c.y, this.pos[b.i].x - c.x));
    const step = this.dur(75), fd = this.dur(320);
    ordered.forEach((f, k) => {
      this.anims.push({ type: 'flip', i: f.i, fromP: f.from, p, start: now + moveDur + k * step, dur: fd, k, onStart: hooks.onFlip, started: false });
    });
    let end = now + moveDur + (ordered.length ? (ordered.length - 1) * step + fd : 0);
    if (ordered.length >= 4 && !this.reduceMotion) { this.shakeAt = now + moveDur; this.shakeMag = Math.min(10, 2 + ordered.length); }
    if (claimed && claimed.length) {
      const cs = end + this.dur(250);
      const base = this.pos[m.to];
      const dist = (i) => Math.hypot(this.pos[i].x - base.x, this.pos[i].y - base.y) / this.size;
      const cl = claimed.slice().sort((a, b) => dist(a) - dist(b));
      cl.forEach((i, k) => this.anims.push({ type: 'claim', i, p: res.state.result.claimer, start: cs + this.dur(Math.min(900, dist(i) * 45)), dur: this.dur(300), started: false, onStart: k === 0 ? hooks.onClaim : null }));
      end = cs + this.dur(Math.min(900, Math.max(...cl.map(dist)) * 45)) + this.dur(300);
    }
    if (flips.length) this.floaters.push({ x: c.x, y: c.y - this.size * 0.9, text: '+' + (flips.length + (kind === 'clone' ? 1 : 0)), p, start: now + moveDur, dur: this.dur(900) });
    this.lastMove = { from: m.from, to: m.to, kind, p };
    this.start();
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, end - now) + 30));
  }
  burst(x, y, p, n = 10, power = 1) {
    if (this.decorative && n > 6) n = 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = (0.6 + Math.random() * 1.4) * this.size * 0.09 * power;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - this.size * 0.03, life: 1, decay: 0.022 + Math.random() * 0.02, p, r: this.size * (0.06 + Math.random() * 0.07) });
    }
  }
  ring(x, y, p) { this.rings.push({ x, y, p, start: performance.now(), dur: this.dur(420) }); }

  /** Per-cell override computed from active animations. */
  overrides(now) {
    const o = new Map();
    for (const a of this.anims) {
      const t = (now - a.start) / a.dur;
      if (a.type === 'clone' || a.type === 'jump') {
        if (t < 1) o.set(a.to, { hidden: true });
        if (a.type === 'jump' && t < 0) o.set(a.from, { owner: a.p });
      } else if (a.type === 'flip') {
        if (t < 0) o.set(a.i, { owner: a.fromP });
        else if (t < 1) {
          const sx = Math.cos(Math.PI * t);
          o.set(a.i, { owner: t < 0.5 ? a.fromP : a.p, sx: Math.max(0.04, Math.abs(sx)), lift: Math.sin(Math.PI * t) * this.size * 0.35 });
        }
      } else if (a.type === 'claim') {
        if (t < 0) o.set(a.i, { owner: 0 });
        else if (t < 1) { const e = ease.back(t); o.set(a.i, { owner: a.p, sx: e, sy: e, alpha: Math.min(1, t * 2) }); }
      }
    }
    return o;
  }

  /* ---------- loop ---------- */
  start() { if (!this.running) { this.running = true; requestAnimationFrame(this._frame); } }
  stop() { this.running = false; }
  _frame(now) {
    if (!this.running) return;
    this.step(now);
    this.draw(now);
    requestAnimationFrame(this._frame);
  }
  step(now) {
    for (const a of this.anims) {
      const t = (now - a.start) / a.dur;
      if ((a.type === 'flip' || a.type === 'claim') && !a.started && t >= 0) {
        a.started = true;
        if (a.onStart) a.onStart(a.k || 0, a.i);
      }
      if ((a.type === 'flip') && !a.done && t >= 0.5) { a.done = true; const p = this.pos[a.i]; this.burst(p.x, p.y, a.p, 6, 0.8); this.ring(p.x, p.y, a.p); }
      if ((a.type === 'clone' || a.type === 'jump') && !a.landed && t >= 1) {
        a.landed = true; const p = this.pos[a.to];
        this.burst(p.x, p.y, a.p, a.type === 'jump' ? 14 : 9, a.type === 'jump' ? 1.3 : 1);
        this.ring(p.x, p.y, a.p);
        if (a.onLand) a.onLand();
      }
      if (a.type === 'claim' && !a.done && t >= 0.6) { a.done = true; const p = this.pos[a.i]; this.burst(p.x, p.y, a.p, 3, 0.6); }
    }
    this.anims = this.anims.filter((a) => now - a.start < a.dur + 16 || (a.type !== 'flip' && a.type !== 'claim' && !a.landed));
    for (const pt of this.particles) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += this.size * 0.004; pt.vx *= 0.96; pt.life -= pt.decay; }
    this.particles = this.particles.filter((p) => p.life > 0);
    this.floaters = this.floaters.filter((f) => now - f.start < f.dur);
    this.rings = this.rings.filter((r) => now - r.start < r.dur);
  }

  draw(now) {
    const { ctx, g, state } = this;
    if (!g || !state || !this.bg) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    let ox = 0, oy = 0;
    if (this.shakeAt && now >= this.shakeAt) {
      const t = (now - this.shakeAt) / 320;
      if (t < 1) { const m = this.shakeMag * (1 - t); ox = (Math.random() - 0.5) * m; oy = (Math.random() - 0.5) * m; }
      else this.shakeAt = 0;
    }
    ctx.save(); ctx.translate(ox, oy);
    ctx.drawImage(this.bg, 0, 0, this.w, this.h);
    const s = this.size;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const mover = state.toMove;

    // last move marker
    if (this.lastMove && !this.decorative) {
      const lm = this.lastMove; const col = PCOL[lm.p];
      const pt = this.pos[lm.to];
      this.hexPath(ctx, pt.x, pt.y, s * 0.9); ctx.lineWidth = Math.max(1.5, s * 0.07); ctx.strokeStyle = col.glow + '0.55)'; ctx.stroke();
      if (lm.kind === 'jump' && state.cells[lm.from] === 0) {
        const pf = this.pos[lm.from];
        ctx.setLineDash([s * 0.12, s * 0.12]); this.hexPath(ctx, pf.x, pf.y, s * 0.62); ctx.strokeStyle = col.glow + '0.45)'; ctx.lineWidth = Math.max(1, s * 0.05); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // move targets
    if (this.targets && mover) {
      const col = PCOL[mover];
      for (const i of this.targets.clones) {
        const p = this.pos[i];
        this.hexPath(ctx, p.x, p.y, s * 0.86); ctx.fillStyle = col.glow + (0.2 + 0.1 * pulse) + ')'; ctx.fill();
        ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.16, 0, Math.PI * 2); ctx.fillStyle = col.glow + '0.9)'; ctx.fill();
      }
      for (const i of this.targets.jumps) {
        const p = this.pos[i];
        ctx.setLineDash([s * 0.16, s * 0.11]); ctx.lineDashOffset = -now / 60;
        this.hexPath(ctx, p.x, p.y, s * 0.74); ctx.strokeStyle = col.glow + '0.85)'; ctx.lineWidth = Math.max(1.5, s * 0.07); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.14, 0, Math.PI * 2); ctx.lineWidth = Math.max(1.2, s * 0.05); ctx.stroke();
      }
    }
    // jump-source hints
    if (this.hintSources.length && now < this.hintUntil && mover) {
      for (const i of this.hintSources) { const p = this.pos[i]; ctx.beginPath(); ctx.arc(p.x, p.y, s * (0.72 + 0.08 * pulse), 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2; ctx.stroke(); }
    }
    // selection glow (under piece)
    if (this.sel >= 0 && mover) {
      const p = this.pos[this.sel]; const col = PCOL[mover];
      ctx.save(); ctx.shadowColor = col.base; ctx.shadowBlur = s * 0.6;
      this.hexPath(ctx, p.x, p.y, s * 0.92); ctx.fillStyle = col.glow + (0.25 + 0.2 * pulse) + ')'; ctx.fill(); ctx.restore();
    }

    // pieces
    const ov = this.overrides(now);
    const flipSet = this.preview ? new Set(this.preview.flips) : null;
    for (let i = 0; i < g.size; i++) {
      const o = ov.get(i);
      if (o && o.hidden) continue;
      const owner = o && o.owner !== undefined ? o.owner : state.cells[i];
      if (!owner) continue;
      const p = this.pos[i];
      let sx = o?.sx ?? 1, sy = o?.sy ?? 1, lift = o?.lift ?? 0;
      if (i === this.sel) { lift = s * (0.08 + 0.06 * pulse); sx = sy = 1.06; }
      if (flipSet && flipSet.has(i)) { sx = 1 + 0.06 * Math.sin(now / 70); }
      this.drawPiece(ctx, owner, p.x, p.y, { sx, sy, lift, alpha: o?.alpha ?? 1 });
      if (flipSet && flipSet.has(i)) {
        const col = PCOL[this.preview.player];
        ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.68, 0, Math.PI * 2); ctx.strokeStyle = col.glow + (0.6 + 0.4 * pulse) + ')'; ctx.lineWidth = Math.max(2, s * 0.1); ctx.stroke();
      }
    }
    // moving pieces (clone grows out of source / jump arcs over)
    for (const a of this.anims) {
      if (a.type !== 'clone' && a.type !== 'jump') continue;
      const t = Math.min(1, Math.max(0, (now - a.start) / a.dur));
      if (t >= 1) continue;
      const A = this.pos[a.from], B = this.pos[a.to];
      if (a.type === 'clone') {
        const e = ease.out(t);
        const sc = 0.35 + 0.65 * ease.back(t);
        this.drawPiece(ctx, a.p, A.x + (B.x - A.x) * e, A.y + (B.y - A.y) * e, { sx: sc, sy: sc });
      } else {
        const e = ease.inOut(t);
        const lift = Math.sin(Math.PI * e) * s * 1.1;
        const sc = 1 + 0.18 * Math.sin(Math.PI * e);
        this.drawPiece(ctx, a.p, A.x + (B.x - A.x) * e, A.y + (B.y - A.y) * e, { sx: sc, sy: sc, lift });
      }
    }
    // preview ghost
    if (this.preview && mover) {
      const pv = this.preview; const p = this.pos[pv.to];
      this.drawPiece(ctx, pv.player, p.x, p.y, { alpha: 0.5 + 0.15 * pulse, shadow: false });
      const gain = pv.flips.length + (pv.kind === 'clone' ? 1 : 0);
      const label = (gain > 0 ? '+' : '') + gain;
      this.label(ctx, p.x, p.y - s * 0.95, label, PCOL[pv.player], 0.95);
      if (pv.kind === 'jump') {
        const f = this.pos[pv.from];
        ctx.setLineDash([s * 0.1, s * 0.1]); ctx.beginPath(); ctx.moveTo(f.x, f.y);
        const mx = (f.x + p.x) / 2, my = (f.y + p.y) / 2 - s * 0.9; ctx.quadraticCurveTo(mx, my, p.x, p.y);
        ctx.strokeStyle = PCOL[pv.player].glow + '0.7)'; ctx.lineWidth = Math.max(1.5, s * 0.06); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // keyboard cursor
    if (this.showCursor && this.cursor >= 0) {
      const p = this.pos[this.cursor];
      this.hexPath(ctx, p.x, p.y, s * 0.97); ctx.strokeStyle = `rgba(255,236,170,${0.75 + 0.25 * pulse})`; ctx.lineWidth = Math.max(2, s * 0.1); ctx.stroke();
    }
    // rings
    for (const r of this.rings) {
      const t = Math.min(1, Math.max(0, (now - r.start) / r.dur));
      ctx.beginPath(); ctx.arc(r.x, r.y, s * (0.5 + 0.7 * ease.out(t)), 0, Math.PI * 2);
      ctx.strokeStyle = PCOL[r.p].glow + (0.7 * (1 - t)) + ')'; ctx.lineWidth = Math.max(1, s * 0.12 * (1 - t)); ctx.stroke();
    }
    // particles
    for (const pt of this.particles) {
      ctx.globalAlpha = Math.max(0, pt.life);
      ctx.fillStyle = pt.life > 0.6 ? PCOL[pt.p].light : PCOL[pt.p].base;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, Math.max(0.1, pt.r * (0.5 + pt.life * 0.5)), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // floaters
    for (const f of this.floaters) {
      const t = (now - f.start) / f.dur;
      if (t < 0) continue;
      this.label(ctx, f.x, f.y - ease.out(t) * s * 0.9, f.text, PCOL[f.p], 1 - Math.max(0, (t - 0.6) / 0.4), 1.15);
    }
    ctx.restore();
  }
  label(ctx, x, y, text, col, alpha = 1, scale = 1) {
    const fs = Math.max(12, this.size * 0.56 * scale);
    ctx.save(); ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = `900 ${fs}px ui-rounded, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = fs * 0.22; ctx.strokeStyle = 'rgba(8,10,20,0.9)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = col.light; ctx.fillText(text, x, y);
    ctx.restore();
  }
}

/** Static mini preview of a board (used on setup cards). */
export function drawMiniBoard(canvas, spec, cells) {
  const g = geometry(spec);
  const w = canvas.clientWidth || 100, h = canvas.clientHeight || 90;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const R = g.R; const s = Math.min(w / (3 * R + 2), h / (SQ3 * (2 * R + 1)));
  const at = (q, r) => ({ x: w / 2 + s * 1.5 * q, y: h / 2 + s * SQ3 * (r + q / 2) });
  const hex = (x, y, r) => { ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = Math.PI / 3 * k; ctx[k ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a)); } ctx.closePath(); };
  g.cells.forEach((c, i) => {
    const p = at(c.q, c.r); hex(p.x, p.y, s * 0.92);
    ctx.fillStyle = '#2a3563'; ctx.fill();
    const o = cells ? cells[i] : 0;
    if (o) { ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.6, 0, Math.PI * 2); ctx.fillStyle = PCOL[o].base; ctx.fill(); }
  });
}
