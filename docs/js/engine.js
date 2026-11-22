// Hexclaim — pure, deterministic rules engine. No DOM, no globals, no Math.random.
// Runs unchanged in the browser, a Web Worker, and Node (tests / a future server).
//
// Board: axial hex coordinates (q, r), a hexagon of radius R with some cells removed ("holes").
// Rules:
//  - On your turn pick one of your pieces and a target empty hex:
//      distance 1  -> CLONE: a new piece appears on the target (the original stays)
//      distance 2  -> JUMP:  the piece moves to the target (its old hex becomes empty)
//  - Every opponent piece touching the landing hex flips to your color.
//  - Players who cannot move are skipped. If only one player can still move, that player
//    claims every remaining empty hex and the game ends.
//  - The game also ends when the board is full, when at most one player has pieces left,
//    or after a hard ply limit. Most hexes wins.

export const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
export const PLAYER_NAMES = ['', 'Coral', 'Teal', 'Amber', 'Violet'];

/* ---------------- seeded randomness ---------------- */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}

/* ---------------- hex helpers ---------------- */
export const hexDist = (aq, ar, bq, br) => (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
const k = (q, r) => q + ',' + r;
const neg = ([q, r]) => [-q, -r];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, n) => [a[0] * n, a[1] * n];
/** Rotate an axial coordinate by 60° * n around the origin. */
export function rot60([q, r], n = 1) {
  let x = q, z = r, y = -q - r;
  for (let i = 0; i < ((n % 6) + 6) % 6; i++) { const nx = -z, ny = -x, nz = -y; x = nx; y = ny; z = nz; }
  return [x, z];
}
/** Mirror across the q axis. */
export const mirror = ([q, r]) => [q + r, -r];
const sym6 = (cells) => { const out = []; for (const c of cells) for (let i = 0; i < 6; i++) out.push(rot60(c, i)); return out; };
const sym2 = (cells) => { const out = []; for (const c of cells) out.push(c, neg(c)); return out; };
const sym3 = (cells) => { const out = []; for (const c of cells) out.push(c, rot60(c, 2), rot60(c, 4)); return out; };
const between = (i, n = 1) => add(mul(DIRS[i % 6], n), DIRS[(i + 1) % 6]);

/* ---------------- board catalogue ---------------- */
// Every 2-player board is fair: some symmetry of the hexagon maps holes->holes and Coral's start->Teal's.
export const BOARDS = [
  { id: 'hive', name: 'Hive', radius: 4, blurb: 'The classic. Three pits ring the centre.',
    holes: [between(0), between(2), between(4)] },
  { id: 'skirmish', name: 'Skirmish', radius: 3, blurb: 'Small and fast. No holes, no mercy.', holes: [] },
  { id: 'atoll', name: 'Atoll', radius: 4, blurb: 'A lagoon in the middle splits the fight.',
    holes: [[0, 0], ...DIRS] },
  { id: 'spokes', name: 'Spokes', radius: 4, blurb: 'Six pits on the spokes make jump lanes.',
    holes: sym6([[2, 0]]) },
  { id: 'twinlakes', name: 'Twin Lakes', radius: 4, blurb: 'Two lakes, one per flank.',
    holes: sym2([[1, -2], [2, -2], [1, -1]]) },
  { id: 'grand', name: 'Grand', radius: 5, blurb: 'Big board for long games and 4-player brawls.',
    holes: [[0, 0], ...sym6([[3, -1]])] },
];
export const BOARD_BY_ID = Object.fromEntries(BOARDS.map((b) => [b.id, b]));
export { sym2, sym3, sym6 };

/** A plain-data board spec (what gets serialized / sent over the wire). */
export function boardSpec(id) {
  const b = BOARD_BY_ID[id] || BOARDS[0];
  return { id: b.id, name: b.name, radius: b.radius, holes: dedupe(b.holes) };
}
function dedupe(cells) {
  const seen = new Set(); const out = [];
  for (const c of cells) { const s = k(c[0], c[1]); if (!seen.has(s)) { seen.add(s); out.push([c[0], c[1]]); } }
  return out;
}

/** Corner start cells, by player count. Corners are R * DIRS[i]. */
export function startCorners(numPlayers) {
  if (numPlayers === 4) return [[], [0], [1], [3], [4]];
  return [[], [0, 2, 4], [1, 3, 5]];
}

/* ---------------- geometry (cached, derived from spec) ---------------- */
const geoCache = new Map();
export function geometry(spec) {
  const id = spec.id + '|' + spec.radius + '|' + spec.holes.map((h) => k(h[0], h[1])).join(';');
  let g = geoCache.get(id);
  if (g) return g;
  const R = spec.radius;
  const holes = new Set(spec.holes.map((h) => k(h[0], h[1])));
  const cells = []; const index = new Map();
  for (let q = -R; q <= R; q++) {
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      if (holes.has(k(q, r))) continue;
      index.set(k(q, r), cells.length); cells.push({ q, r });
    }
  }
  const at = (q, r) => { const i = index.get(k(q, r)); return i === undefined ? -1 : i; };
  const off2 = [...DIRS.map((d) => mul(d, 2)), ...DIRS.map((_, i) => between(i))];
  const n1 = cells.map((c) => DIRS.map((d) => at(c.q + d[0], c.r + d[1])).filter((i) => i >= 0));
  const n2 = cells.map((c) => off2.map((d) => at(c.q + d[0], c.r + d[1])).filter((i) => i >= 0));
  // all hexagon positions incl. holes, for drawing the "pits"
  const holeCells = [];
  for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) if (holes.has(k(q, r))) holeCells.push({ q, r });
  g = { spec, R, size: cells.length, cells, holeCells, n1, n2, at, maxPly: cells.length * 4 };
  geoCache.set(id, g);
  return g;
}

/* ---------------- low level (array based, shared with the AI) ---------------- */
export function counts(cells, numPlayers) {
  const c = new Array(numPlayers + 1).fill(0);
  for (let i = 0; i < cells.length; i++) c[cells[i]]++;
  return c;
}
export function hasMove(g, cells, p) {
  const { n1, n2 } = g;
  for (let s = 0; s < cells.length; s++) {
    if (cells[s] !== p) continue;
    const a = n1[s]; for (let j = 0; j < a.length; j++) if (cells[a[j]] === 0) return true;
    const b = n2[s]; for (let j = 0; j < b.length; j++) if (cells[b[j]] === 0) return true;
  }
  return false;
}
/** All distinct legal moves for p. Clones are de-duplicated by target (any source gives the same result). */
export function genMoves(g, cells, p) {
  const out = []; const { n1, n2 } = g;
  for (let t = 0; t < cells.length; t++) {
    if (cells[t] !== 0) continue;
    const a = n1[t];
    for (let j = 0; j < a.length; j++) if (cells[a[j]] === p) { out.push({ from: a[j], to: t, jump: false }); break; }
  }
  for (let s = 0; s < cells.length; s++) {
    if (cells[s] !== p) continue;
    const b = n2[s];
    for (let j = 0; j < b.length; j++) if (cells[b[j]] === 0) out.push({ from: s, to: b[j], jump: true });
  }
  return out;
}
/** Mutates cells. Pushes [index, previousOwner] pairs into flipsOut (if given). Returns flip count. */
export function doMove(g, cells, p, from, to, jump, flipsOut) {
  cells[to] = p;
  if (jump) cells[from] = 0;
  const a = g.n1[to]; let n = 0;
  for (let j = 0; j < a.length; j++) {
    const o = cells[a[j]];
    if (o > 0 && o !== p) { cells[a[j]] = p; n++; if (flipsOut) flipsOut.push(a[j], o); }
  }
  return n;
}
/**
 * After `last` moved: decide who moves next, or that the game is over.
 * Returns { next } or { over: true, reason, claimer } (claimer = player who takes all empties, or 0).
 */
export function resolveTurn(g, cells, numPlayers, last, ply) {
  const c = counts(cells, numPlayers);
  if (c[0] === 0) return { over: true, reason: 'full', claimer: 0 };
  let alive = 0;
  for (let p = 1; p <= numPlayers; p++) if (c[p] > 0) alive++;
  if (alive <= 1) return { over: true, reason: 'wipeout', claimer: 0 };
  const movers = [];
  for (let p = 1; p <= numPlayers; p++) if (c[p] > 0 && hasMove(g, cells, p)) movers.push(p);
  if (movers.length === 0) return { over: true, reason: 'blocked', claimer: 0 };
  if (movers.length === 1) return { over: true, reason: 'claim', claimer: movers[0] };
  if (ply >= g.maxPly) return { over: true, reason: 'limit', claimer: 0 };
  for (let i = 1; i <= numPlayers; i++) {
    const p = ((last - 1 + i) % numPlayers) + 1;
    if (movers.includes(p)) return { next: p };
  }
  return { over: true, reason: 'blocked', claimer: 0 }; // unreachable
}

/* ---------------- high level, immutable state API ---------------- */
export function newGame({ spec = boardSpec('hive'), numPlayers = 2 } = {}) {
  const g = geometry(spec);
  const cells = new Int8Array(g.size);
  const corners = startCorners(numPlayers);
  for (let p = 1; p <= numPlayers; p++) {
    for (const ci of corners[p]) {
      const [q, r] = mul(DIRS[ci], g.R);
      const i = g.at(q, r);
      if (i >= 0) cells[i] = p;
    }
  }
  return { spec, numPlayers, cells, toMove: 1, ply: 0, over: false, result: null };
}

export function cloneState(s) { return { ...s, cells: Int8Array.from(s.cells) }; }

/** Check a candidate move. Returns 'clone' | 'jump' | null. */
export function moveKind(state, from, to) {
  if (state.over) return null;
  const g = geometry(state.spec); const c = state.cells;
  if (from < 0 || to < 0 || from >= g.size || to >= g.size) return null;
  if (c[from] !== state.toMove || c[to] !== 0) return null;
  if (g.n1[from].includes(to)) return 'clone';
  if (g.n2[from].includes(to)) return 'jump';
  return null;
}

export function legalMoves(state) {
  if (state.over) return [];
  return genMoves(geometry(state.spec), state.cells, state.toMove);
}

/** Targets reachable from one of the mover's pieces. */
export function targetsFrom(state, from) {
  const g = geometry(state.spec); const c = state.cells;
  if (state.over || c[from] !== state.toMove) return { clones: [], jumps: [] };
  return { clones: g.n1[from].filter((i) => c[i] === 0), jumps: g.n2[from].filter((i) => c[i] === 0) };
}

/** Which pieces would flip if the mover landed on `to`. */
export function previewFlips(state, to) {
  const g = geometry(state.spec); const c = state.cells; const p = state.toMove;
  return g.n1[to].filter((i) => c[i] > 0 && c[i] !== p);
}

function finalize(g, cells, numPlayers, reason, claimer) {
  const claimed = [];
  if (claimer) for (let i = 0; i < cells.length; i++) if (cells[i] === 0) { cells[i] = claimer; claimed.push(i); }
  const c = counts(cells, numPlayers);
  const ranking = [];
  for (let p = 1; p <= numPlayers; p++) ranking.push(p);
  ranking.sort((a, b) => c[b] - c[a] || a - b);
  const top = c[ranking[0]];
  const winners = ranking.filter((p) => c[p] === top);
  return { result: { reason, claimer, counts: c, ranking, winners, winner: winners.length === 1 ? winners[0] : 0 }, claimed };
}

/**
 * Apply a move. Returns { state, kind, flips: [{i, from}], claimed: [i] } or throws on an illegal move.
 * The input state is not modified.
 */
export function applyMove(state, move) {
  const kind = moveKind(state, move.from, move.to);
  if (!kind) throw new Error(`illegal move ${move.from}->${move.to} for P${state.toMove}`);
  const g = geometry(state.spec);
  const cells = Int8Array.from(state.cells);
  const raw = [];
  const p = state.toMove;
  doMove(g, cells, p, move.from, move.to, kind === 'jump', raw);
  const flips = [];
  for (let i = 0; i < raw.length; i += 2) flips.push({ i: raw[i], from: raw[i + 1] });
  const ply = state.ply + 1;
  const r = resolveTurn(g, cells, state.numPlayers, p, ply);
  let next = { ...state, cells, ply, lastMove: { from: move.from, to: move.to, kind, player: p } };
  let claimed = [];
  if (r.over) {
    const f = finalize(g, cells, state.numPlayers, r.reason, r.claimer);
    claimed = f.claimed;
    next = { ...next, over: true, result: f.result, toMove: 0 };
  } else {
    next.toMove = r.next;
  }
  return { state: next, kind, player: p, flips, claimed };
}

/** Replay a list of moves from a start state; returns every intermediate state (length = moves+1). */
export function replay(start, moves) {
  const states = [start];
  let s = start;
  for (const m of moves) { s = applyMove(s, m).state; states.push(s); }
  return states;
}

/* ---------------- serialization (worker / network) ---------------- */
export function serialize(s) {
  return { spec: s.spec, numPlayers: s.numPlayers, cells: Array.from(s.cells), toMove: s.toMove, ply: s.ply,
    over: s.over, result: s.result, lastMove: s.lastMove || null };
}
export function deserialize(o) {
  return { ...o, cells: Int8Array.from(o.cells) };
}

/** A self-inverse hexagon symmetry mapping holes->holes and Coral's start onto Teal's (or null). */
export function fairInvolution(spec) {
  const holes = new Set(spec.holes.map((h) => k(h[0], h[1])));
  const corners = startCorners(2);
  const set = (p) => new Set(corners[p].map((ci) => k(...mul(DIRS[ci], spec.radius))));
  const maps = (f, from, to) => [...from].every((x) => to.has(k(...f(x.split(',').map(Number)))));
  const probe = [[1, 0], [2, -1], [3, 1]];
  for (let i = 0; i < 6; i++) {
    for (const f of [(c) => rot60(c, i), (c) => rot60(mirror(c), i)]) {
      if (!probe.every((c) => { const b = f(f(c)); return b[0] === c[0] && b[1] === c[1]; })) continue;
      if (maps(f, holes, holes) && maps(f, set(1), set(2))) return f;
    }
  }
  return null;
}

/** Symmetry check used by tests: is there a hexagon symmetry mapping holes->holes and P1 starts->P2 starts? */
export function isFairBoard(spec, numPlayers = 2) {
  const holes = new Set(spec.holes.map((h) => k(h[0], h[1])));
  const corners = startCorners(numPlayers);
  const startSet = (p) => new Set(corners[p].map((ci) => k(...mul(DIRS[ci], spec.radius))));
  const transforms = [];
  for (let i = 0; i < 6; i++) { transforms.push((c) => rot60(c, i)); transforms.push((c) => rot60(mirror(c), i)); }
  const maps = (f, from, to) => [...from].every((s) => to.has(k(...f(s.split(',').map(Number)))));
  for (let p = 2; p <= numPlayers; p++) {
    const ok = transforms.some((f) => maps(f, holes, holes) && maps(f, startSet(1), startSet(p)));
    if (!ok) return false;
  }
  return true;
}
