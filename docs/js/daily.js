// Hexclaim Daily — pure + deterministic. Same local date => same board, same opening, same bot.
import { BOARD_BY_ID, boardSpec, geometry, newGame, applyMove, genMoves, makeRng, hashStr, hexDist, DIRS, counts, fairInvolution } from './engine.js';
import { chooseMove } from './ai.js';

export const DAILY_EPOCH = '2026-11-21'; // Daily #1
const DAILY_BOARDS = ['hive', 'atoll', 'spokes', 'twinlakes', 'hive', 'spokes'];

export function dailyKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function dailyNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  const [ey, em, ed] = DAILY_EPOCH.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86400000) + 1;
}

function dailySpec(key, rand) {
  const base = BOARD_BY_ID[DAILY_BOARDS[Math.floor(rand() * DAILY_BOARDS.length)]];
  const spec = boardSpec(base.id);
  const R = spec.radius;
  const holes = spec.holes.map((h) => h.slice());
  const f = fairInvolution(spec) || (([q, r]) => [-q, -r]);
  const isHole = (q, r) => holes.some((h) => h[0] === q && h[1] === r);
  const corners = DIRS.map((d) => [d[0] * R, d[1] * R]);
  const candidates = [];
  for (let q = -R; q <= R; q++) {
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      const dc = hexDist(0, 0, q, r);
      if (dc < 1 || dc > R - 1) continue;
      if (corners.some(([cq, cr]) => hexDist(q, r, cq, cr) < 2)) continue;
      const [mq, mr] = f([q, r]);
      if (isHole(q, r) || isHole(mq, mr)) continue;
      if (mq === q && mr === r) continue; // keep pits in pairs
      candidates.push([q, r]);
    }
  }
  const extra = 1 + Math.floor(rand() * 2); // 1-2 extra point-symmetric pairs of pits
  for (let i = 0; i < extra && candidates.length; i++) {
    const [q, r] = candidates.splice(Math.floor(rand() * candidates.length), 1)[0];
    const m = f([q, r]);
    if (isHole(q, r) || isHole(m[0], m[1])) continue;
    holes.push([q, r], m);
  }
  return { id: 'daily-' + base.id, name: base.name, radius: R, holes };
}

/** Seeded, slightly-random opening so every daily starts from a fresh mid-game-ish position. */
function playOpening(state, plies, rand) {
  const g = geometry(state.spec);
  let s = state;
  for (let i = 0; i < plies && !s.over; i++) {
    const moves = genMoves(g, s.cells, s.toMove);
    let best = null; let bv = -Infinity;
    for (const m of moves) {
      let v = rand() * 2.2 + (m.jump ? -1.4 : 0);
      for (const n of g.n1[m.to]) if (s.cells[n] > 0 && s.cells[n] !== s.toMove) v += 1;
      if (v > bv) { bv = v; best = m; }
    }
    s = applyMove(s, best).state;
  }
  return s;
}

const cache = new Map();
/** Build the daily challenge for a date key. Deterministic. */
export function makeDaily(key = dailyKey()) {
  if (cache.has(key)) return cache.get(key);
  let out = null;
  for (let attempt = 0; attempt < 40 && !out; attempt++) {
    const rand = makeRng(hashStr(`hexclaim-daily:${key}:${attempt}`));
    const spec = dailySpec(key, rand);
    const plies = 6 + 2 * Math.floor(rand() * 3);
    const start = playOpening(newGame({ spec, numPlayers: 2 }), plies, rand);
    if (start.over || start.toMove !== 1) continue;
    const probe = chooseMove(start, { level: 'daily', maxDepth: 2 }); // 2-ply balance check
    if (!probe || Math.abs(probe.score) > 3) continue; // keep it balanced
    const c = counts(start.cells, 2);
    const cand = { key, number: dailyNumber(key), spec, start: { ...start, ply: 0, lastMove: null }, startCounts: c, attempt };
    cand.par = computePar(cand);
    // the bot playing Coral's side should come out roughly even-to-ahead: a fair but beatable target
    if (cand.par.margin < -4 || cand.par.margin > 14) continue;
    out = cand;
  }
  if (!out) throw new Error('could not build daily ' + key);
  cache.set(key, out);
  return out;
}

/** Par: the margin the Daily bot gets when it plays Coral's side against itself. Deterministic. */
export function computePar(daily) {
  let s = daily.start;
  while (!s.over) s = applyMove(s, chooseMove(s, { level: 'daily' })).state;
  const c = s.result.counts;
  return { margin: c[1] - c[2], counts: c, plies: s.ply };
}

export function starsFor({ won, margin, par, wipeout }) {
  if (!won) return 0;
  if (wipeout || margin >= par + 10) return 3;
  if (margin >= par) return 2;
  return 1;
}

/** Emoji result for the clipboard. No URLs required; `url` is appended if provided. */
export function shareText({ number, counts: c, par, moves, stars, won, draw, url }) {
  const total = c[1] + c[2];
  const coral = total ? Math.round((c[1] / total) * 10) : 5;
  const bar = '🟧'.repeat(coral) + '🟦'.repeat(10 - coral);
  const margin = c[1] - c[2];
  const sgn = (n) => (n > 0 ? '+' + n : String(n));
  const verdict = won ? `Won ${sgn(margin)}` : draw ? 'Draw' : `Lost ${sgn(margin)}`;
  const st = '★'.repeat(stars) + '☆'.repeat(3 - stars);
  const lines = [
    `Hexclaim Daily #${number} ${st}`,
    `${bar} ${c[1]}–${c[2]}`,
    `${verdict} vs 🤖 Daily Bot · par ${sgn(par)} · ${moves} moves`,
  ];
  if (url) lines.push(url);
  return lines.join('\n');
}
