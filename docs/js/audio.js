// Tiny WebAudio synth — every sound is generated, no audio files.
let ctx = null, master = null, muted = false, noiseBuf = null;

function ensure() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
  } catch { ctx = null; }
  return ctx;
}

export function unlock() { ensure(); }
export function setMuted(m) { muted = !!m; if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.02); }
export function isMuted() { return muted; }

function tone({ f = 440, f2 = null, dur = 0.12, type = 'sine', vol = 0.3, at = 0, attack = 0.005, q = null }) {
  const c = ensure(); if (!c || muted) return;
  const t = c.currentTime + at;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o;
  if (q) { const bq = c.createBiquadFilter(); bq.type = 'lowpass'; bq.frequency.value = q; o.connect(bq); node = bq; }
  node.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise({ dur = 0.2, at = 0, vol = 0.2, from = 800, to = 3000, type = 'bandpass' }) {
  const c = ensure(); if (!c || muted || !noiseBuf) return;
  const t = c.currentTime + at;
  const s = c.createBufferSource(); s.buffer = noiseBuf;
  const f = c.createBiquadFilter(); f.type = type; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t); s.stop(t + dur + 0.05);
}

// pentatonic ladder for flip cascades
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const hz = (semi, base = 523.25) => base * Math.pow(2, semi / 12);

export const sfx = {
  click() { tone({ f: 900, dur: 0.05, type: 'triangle', vol: 0.12 }); },
  select() { tone({ f: 660, f2: 880, dur: 0.08, type: 'triangle', vol: 0.18 }); },
  deselect() { tone({ f: 600, f2: 420, dur: 0.07, type: 'triangle', vol: 0.12 }); },
  invalid() { tone({ f: 180, f2: 140, dur: 0.14, type: 'square', vol: 0.08, q: 900 }); },
  clone(player = 1) {
    const b = [0, 392, 349.23, 440, 329.63][player] || 392;
    tone({ f: b, f2: b * 1.5, dur: 0.12, type: 'sine', vol: 0.32 });
    tone({ f: b * 2, dur: 0.08, type: 'triangle', vol: 0.08, at: 0.02 });
  },
  jump(player = 1) {
    noise({ dur: 0.28, vol: 0.16, from: 500, to: 2600 });
    const b = [0, 392, 349.23, 440, 329.63][player] || 392;
    tone({ f: b * 0.75, f2: b * 1.5, dur: 0.3, type: 'sine', vol: 0.18 });
    tone({ f: b * 1.5, dur: 0.1, type: 'sine', vol: 0.25, at: 0.3 });
  },
  flip(k, at = 0) {
    const s = PENTA[Math.min(k, PENTA.length - 1)];
    tone({ f: hz(s), dur: 0.22, type: 'triangle', vol: 0.2, at });
    tone({ f: hz(s + 12), dur: 0.12, type: 'sine', vol: 0.06, at: at + 0.01 });
  },
  bigFlip(at = 0) { noise({ dur: 0.35, vol: 0.12, from: 2000, to: 400, type: 'lowpass', at }); tone({ f: 110, f2: 70, dur: 0.3, vol: 0.25, at }); },
  claim(at = 0) { for (let i = 0; i < 6; i++) tone({ f: hz(PENTA[i] + 12), dur: 0.18, type: 'sine', vol: 0.07, at: at + i * 0.06 }); },
  turn() { tone({ f: 740, dur: 0.07, type: 'sine', vol: 0.1 }); tone({ f: 988, dur: 0.09, type: 'sine', vol: 0.1, at: 0.08 }); },
  win() { [0, 4, 7, 12, 16].forEach((s, i) => tone({ f: hz(s, 392), dur: 0.35, type: 'triangle', vol: 0.22, at: i * 0.1 })); tone({ f: hz(19, 392), dur: 0.7, type: 'sine', vol: 0.2, at: 0.5 }); },
  lose() { [7, 3, 0, -5].forEach((s, i) => tone({ f: hz(s, 392), dur: 0.4, type: 'triangle', vol: 0.18, at: i * 0.16, q: 1600 })); },
  draw() { [0, 7, 0].forEach((s, i) => tone({ f: hz(s, 440), dur: 0.3, type: 'triangle', vol: 0.16, at: i * 0.14 })); },
  star(i) { tone({ f: hz(12 + i * 4, 523.25), dur: 0.25, type: 'sine', vol: 0.18, at: 0.15 * i }); },
};
