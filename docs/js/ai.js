// Hexclaim bots — pure search code (no DOM). Runs in a Web Worker in the browser, or in Node.
// Alpha-beta ("paranoid" for >2 players: everybody else minimises the bot's score) with
// iterative deepening, move ordering and a node-count/time box.
import { geometry, genMoves, doMove, resolveTurn, counts, makeRng } from './engine.js';

export const LEVELS = {
  // Tuned against a "casual player" model (greedy 1-ply, prefers clones): it beats Rookie ~85% of
  // the time and Adept ~35%, so the ladder has a middle rung instead of a pushover and a wall.
  rookie: { id: 'rookie', name: 'Rookie', depth: 1, timeMs: 150, noise: 2, blunder: 0.06, undo: true,
    blurb: 'Best first opponent. Grabs whatever looks shiny.' },
  adept: { id: 'adept', name: 'Adept', depth: 2, timeMs: 400, noise: 3, blunder: 0.08, undo: true,
    blurb: 'Looks one reply ahead, but still slips up. A fair fight.' },
  expert: { id: 'expert', name: 'Expert', depth: 4, timeMs: 700, noise: 0, blunder: 0, undo: false,
    blurb: 'Reads four moves deep. Bring a plan.' },
  grandmaster: { id: 'grandmaster', name: 'Grandmaster', depth: 16, timeMs: 1600, noise: 0, blunder: 0, undo: false,
    blurb: 'Deepens until the clock runs out. Good luck.' },
  // Fixed-depth, noise-free, time-independent: identical replies on every device (used by the Daily).
  // 1-ply (takes the biggest immediate gain). noise < 1 only breaks exact ties, and it is seeded by
  // ply, so every device still gets identical replies. Tuned so a casual player wins about half
  // the dailies and the stars separate good play from lucky play.
  daily: { id: 'daily', name: 'Daily', depth: 1, timeMs: Infinity, noise: 0.6, blunder: 0, undo: false, deterministic: true },
};
export const LEVEL_ORDER = ['rookie', 'adept', 'expert', 'grandmaster'];

const WIN = 100000;
const ABORT = { abort: true };

/** Score of a position from `root`'s point of view (higher is better). */
function evaluate(c, root, numPlayers) {
  if (numPlayers === 2) return c[root] - c[3 - root];
  let best = -1;
  for (let p = 1; p <= numPlayers; p++) if (p !== root && c[p] > best) best = c[p];
  return c[root] - best;
}
function terminalScore(c, root, numPlayers, claimer, depthLeft) {
  if (claimer) { c = c.slice(); c[claimer] += c[0]; c[0] = 0; }
  const d = evaluate(c, root, numPlayers);
  // prefer quicker wins / slower losses
  if (d > 0) return WIN + d + depthLeft;
  if (d < 0) return -WIN + d - depthLeft;
  return 0;
}

/**
 * Pick a move. `state` is an engine state (or its serialized form with cells as Array).
 * opts: { level, seed, timeMs, maxDepth, now } — returns { from, to, jump, score, depth, nodes }.
 */
export function chooseMove(state, opts = {}) {
  const L = LEVELS[opts.level] || LEVELS.adept;
  const g = geometry(state.spec);
  const cells = Int8Array.from(state.cells);
  const root = state.toMove;
  const N = state.numPlayers;
  const now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const timeMs = opts.timeMs ?? L.timeMs;
  const maxDepth = opts.maxDepth ?? L.depth;
  const deadline = Number.isFinite(timeMs) ? now() + timeMs : Infinity;
  const rand = makeRng((opts.seed ?? 1) ^ Math.imul(state.ply + 1, 2654435761));

  const rootMoves = genMoves(g, cells, root);
  if (!rootMoves.length) return null;
  if (rootMoves.length === 1) return { ...rootMoves[0], score: 0, depth: 0, nodes: 0 };

  let nodes = 0;
  const flipStack = [];

  const gain = (m, p) => {
    let n = m.jump ? 0 : 1;
    const a = g.n1[m.to];
    for (let j = 0; j < a.length; j++) { const o = cells[a[j]]; if (o > 0 && o !== p) n += 2; }
    if (m.jump) { // leaving a hole next to our own pieces is risky
      const b = g.n1[m.from];
      for (let j = 0; j < b.length; j++) if (cells[b[j]] === p) n -= 0.5;
    }
    return n;
  };
  const order = (moves, p) => {
    const sc = moves.map((m) => gain(m, p));
    const idx = moves.map((_, i) => i).sort((a, b) => sc[b] - sc[a] || a - b);
    return idx.map((i) => moves[i]);
  };

  function make(m, p) {
    const base = flipStack.length;
    doMove(g, cells, p, m.from, m.to, m.jump, flipStack);
    return base;
  }
  function unmake(m, p, base) {
    for (let i = flipStack.length - 2; i >= base; i -= 2) cells[flipStack[i]] = flipStack[i + 1];
    flipStack.length = base;
    cells[m.to] = 0;
    if (m.jump) cells[m.from] = p;
  }

  function search(depth, alpha, beta, p, ply) {
    nodes++;
    if ((nodes & 511) === 0 && now() > deadline) throw ABORT;
    if (depth === 0) return evaluate(counts(cells, N), root, N);
    const moves = order(genMoves(g, cells, p), p);
    const maximizing = p === root;
    let best = maximizing ? -Infinity : Infinity;
    for (const m of moves) {
      const base = make(m, p);
      const r = resolveTurn(g, cells, N, p, ply + 1);
      const v = r.over ? terminalScore(counts(cells, N), root, N, r.claimer, depth) : search(depth - 1, alpha, beta, r.next, ply + 1);
      unmake(m, p, base);
      if (maximizing) { if (v > best) best = v; if (best > alpha) alpha = best; }
      else { if (v < best) best = v; if (best < beta) beta = best; }
      if (alpha >= beta) break;
    }
    return best;
  }

  // score every root move at a given depth (full window when we want noise, alpha-beta otherwise)
  function rootPass(depth, moves, fullWindow) {
    const scored = [];
    let alpha = -Infinity;
    for (const m of moves) {
      const base = make(m, root);
      const r = resolveTurn(g, cells, N, root, state.ply + 1);
      const v = r.over ? terminalScore(counts(cells, N), root, N, r.claimer, depth)
        : search(depth - 1, fullWindow ? -Infinity : alpha, Infinity, r.next, state.ply + 1);
      unmake(m, root, base);
      scored.push({ m, v });
      if (v > alpha) alpha = v;
    }
    return scored;
  }

  let moves = order(rootMoves, root);
  let best = { m: moves[0], v: 0 }; let reached = 0;
  const noisy = L.noise > 0 || L.blunder > 0;
  try {
    for (let d = 1; d <= maxDepth; d++) {
      const scored = rootPass(d, moves, noisy);
      // stable sort: best first (keeps earlier order on ties => deterministic)
      scored.sort((a, b) => b.v - a.v);
      moves = scored.map((s) => s.m);
      best = scored[0]; reached = d;
      if (noisy) {
        if (rand() < L.blunder) best = scored[Math.floor(rand() * scored.length)];
        else {
          let top = -Infinity;
          for (const s of scored) {
            const v = Math.abs(s.v) >= WIN / 2 ? s.v : s.v + rand() * L.noise;
            if (v > top) { top = v; best = s; }
          }
        }
      }
      if (Math.abs(best.v) >= WIN / 2 && !noisy) break; // forced result found
      if (now() > deadline) break;
    }
  } catch (e) {
    if (e !== ABORT) throw e;
  }
  return { from: best.m.from, to: best.m.to, jump: best.m.jump, score: best.v, depth: reached, nodes };
}
