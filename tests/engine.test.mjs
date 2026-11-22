// Unit tests for the pure modules. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../docs/js/engine.js';
import { chooseMove, LEVELS, LEVEL_ORDER } from '../docs/js/ai.js';
import * as D from '../docs/js/daily.js';

const open = (R) => ({ id: 'open' + R, name: 'Open', radius: R, holes: [] });
const idx = (g, q, r) => { const i = g.at(q, r); assert.ok(i >= 0, `cell ${q},${r} exists`); return i; };
/** Build a state from a list of [q, r, owner] on a hole-free board. */
function position(R, pieces, toMove = 1, numPlayers = 2) {
  const spec = open(R); const g = E.geometry(spec);
  const cells = new Int8Array(g.size);
  for (const [q, r, o] of pieces) cells[idx(g, q, r)] = o;
  return { spec, numPlayers, cells, toMove, ply: 0, over: false, result: null };
}

test('geometry: hexagon sizes, neighbours and distance-2 rings', () => {
  for (const [R, n] of [[2, 19], [3, 37], [4, 61], [5, 91]]) assert.equal(E.geometry(open(R)).size, n);
  const g = E.geometry(open(4));
  const c = idx(g, 0, 0);
  assert.equal(g.n1[c].length, 6);
  assert.equal(g.n2[c].length, 12);
  for (const j of g.n2[c]) { const { q, r } = g.cells[j]; assert.equal(E.hexDist(0, 0, q, r), 2); }
  assert.equal(g.n1[idx(g, 4, 0)].length, 3, 'corner has 3 neighbours');
});

test('board catalogue: every board is fair (symmetric) for 2 players; holes really are removed', () => {
  for (const b of E.BOARDS) {
    const spec = E.boardSpec(b.id);
    const g = E.geometry(spec);
    const full = 3 * spec.radius * (spec.radius + 1) + 1;
    assert.equal(g.size, full - spec.holes.length, `${b.id} hole count`);
    assert.ok(E.isFairBoard(spec, 2), `${b.id} fair for 2`);
  }
  const four = E.BOARDS.filter((b) => E.isFairBoard(E.boardSpec(b.id), 4)).map((b) => b.id);
  assert.ok(four.includes('grand') && four.includes('hive') && four.length >= 4, 'enough 4-player boards: ' + four);
});

test('newGame: three corners each for 2 players, one corner each for 4', () => {
  const s2 = E.newGame({ spec: E.boardSpec('hive') });
  assert.deepEqual(E.counts(s2.cells, 2), [E.geometry(s2.spec).size - 6, 3, 3]);
  assert.equal(s2.toMove, 1);
  const s4 = E.newGame({ spec: E.boardSpec('grand'), numPlayers: 4 });
  assert.deepEqual(E.counts(s4.cells, 4).slice(1), [1, 1, 1, 1]);
});

test('clone keeps the source, adds a piece and flips touching enemies', () => {
  const s = position(3, [[0, 0, 1], [2, 0, 2], [2, -1, 2], [1, 1, 2], [-3, 0, 2]]);
  const g = E.geometry(s.spec);
  const to = idx(g, 1, 0);
  assert.equal(E.moveKind(s, idx(g, 0, 0), to), 'clone');
  const res = E.applyMove(s, { from: idx(g, 0, 0), to });
  assert.equal(res.kind, 'clone');
  assert.equal(res.state.cells[idx(g, 0, 0)], 1, 'source stays');
  assert.equal(res.flips.length, 3);
  assert.deepEqual(E.counts(res.state.cells, 2).slice(1), [5, 1]);
  assert.equal(res.state.toMove, 2);
  assert.deepEqual(E.counts(s.cells, 2).slice(1), [1, 4], 'input state untouched');
});

test('jump vacates the source; distance 3 and occupied targets are illegal', () => {
  const s = position(3, [[0, 0, 1], [2, -2, 2], [-3, 3, 2]]);
  const g = E.geometry(s.spec);
  const res = E.applyMove(s, { from: idx(g, 0, 0), to: idx(g, 2, -1) });
  assert.equal(res.kind, 'jump');
  assert.equal(res.state.cells[idx(g, 0, 0)], 0);
  assert.equal(res.state.cells[idx(g, 2, -2)], 1, 'flipped');
  assert.throws(() => E.applyMove(s, { from: idx(g, 0, 0), to: idx(g, 3, 0) }), /illegal/);
  assert.throws(() => E.applyMove(s, { from: idx(g, 0, 0), to: idx(g, 2, -2) }), /illegal/);
  assert.throws(() => E.applyMove(s, { from: idx(g, 2, -2), to: idx(g, 1, -2) }), /illegal/, 'not your piece');
});

test('legalMoves de-duplicates clones by target and lists every jump', () => {
  const s = position(3, [[0, 0, 1], [1, 0, 1], [-3, 0, 2]]);
  const ms = E.legalMoves(s);
  const clones = ms.filter((m) => !m.jump); const jumps = ms.filter((m) => m.jump);
  assert.equal(new Set(clones.map((m) => m.to)).size, clones.length);
  assert.equal(clones.length, 8, 'union of the two neighbourhoods minus the pieces');
  for (const m of ms) assert.ok(E.moveKind(s, m.from, m.to));
  assert.ok(jumps.length > 12);
});

test('when only one player can move they claim every empty hex and the game ends', () => {
  // radius 2, Teal boxed in at a corner by Coral with nowhere to go after Coral's move
  const R = 2; const spec = open(R); const g = E.geometry(spec);
  const cells = new Int8Array(g.size).fill(1);
  const teal = idx(g, 2, -2); cells[teal] = 2;
  // leave a few empties far from Teal (distance >= 3)
  const empties = [idx(g, -2, 2), idx(g, -2, 1), idx(g, -1, 2)];
  for (const e of empties) cells[e] = 0;
  const s = { spec, numPlayers: 2, cells, toMove: 1, ply: 0, over: false, result: null };
  const res = E.applyMove(s, { from: idx(g, -1, 1), to: empties[0] });
  assert.equal(res.state.over, true);
  assert.equal(res.state.result.reason, 'claim');
  assert.equal(res.state.result.claimer, 1);
  assert.equal(res.claimed.length, 2);
  assert.equal(E.counts(res.state.cells, 2)[0], 0);
  assert.equal(res.state.result.winner, 1);
});

test('wiping out the opponent ends the game', () => {
  const s = position(3, [[0, 0, 1], [2, 0, 2]]);
  const g = E.geometry(s.spec);
  const res = E.applyMove(s, { from: idx(g, 0, 0), to: idx(g, 1, 0) });
  assert.equal(res.state.over, true);
  assert.equal(res.state.result.reason, 'wipeout');
  assert.equal(res.state.result.winner, 1);
});

test('a full board ends the game (checked before wipeout)', () => {
  const spec = open(1); const g = E.geometry(spec); // 7 cells
  const cells = new Int8Array(g.size);
  // centre empty; ring alternates so the result after Coral fills the centre is decided by flips
  const ring = E.DIRS.map(([q, r]) => idx(g, q, r));
  ring.forEach((i, k) => { cells[i] = k % 2 ? 2 : 1; });
  const s = { spec, numPlayers: 2, cells, toMove: 1, ply: 0, over: false, result: null };
  const res = E.applyMove(s, { from: ring[0], to: idx(g, 0, 0) });
  assert.equal(res.state.over, true);
  assert.equal(res.state.result.reason, 'full');
  assert.equal(res.state.result.winner, 1);
  // explicit draw: finished 2-2 position via resolveTurn on a full board
  const full = Int8Array.from([1, 1, 2, 2]);
  const fakeG = { n1: [[], [], [], []], n2: [[], [], [], []], maxPly: 99 };
  assert.deepEqual(E.resolveTurn(fakeG, full, 2, 1, 1), { over: true, reason: 'full', claimer: 0 });
});

test('4 players: a player without moves is skipped, turn order is clockwise', () => {
  const s0 = E.newGame({ spec: E.boardSpec('grand'), numPlayers: 4 });
  const s1 = E.applyMove(s0, E.legalMoves(s0)[0]).state;
  assert.equal(s1.toMove, 2);
  // box in player 2 completely
  const g = E.geometry(s1.spec);
  const cells = Int8Array.from(s1.cells);
  const p2 = cells.indexOf(2);
  for (const n of [...g.n1[p2], ...g.n2[p2]]) if (cells[n] === 0) cells[n] = 3;
  const s = { ...s1, cells, toMove: 1 };
  const m = E.legalMoves(s)[0];
  const r = E.applyMove(s, m).state;
  assert.equal(r.toMove, 3, 'player 2 skipped');
});

test('replay + serialize round-trip are deterministic', () => {
  let s = E.newGame({ spec: E.boardSpec('spokes') });
  const moves = [];
  for (let k = 0; k < 20 && !s.over; k++) { const m = chooseMove(s, { level: 'adept', seed: 9 }); moves.push(m); s = E.applyMove(s, m).state; }
  const states = E.replay(E.newGame({ spec: E.boardSpec('spokes') }), moves);
  assert.deepEqual(Array.from(states.at(-1).cells), Array.from(s.cells));
  const rt = E.deserialize(JSON.parse(JSON.stringify(E.serialize(s))));
  assert.deepEqual(Array.from(rt.cells), Array.from(s.cells));
  assert.equal(rt.toMove, s.toMove);
});

test('rng + hash are deterministic', () => {
  const a = E.makeRng(42), b = E.makeRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.equal(E.hashStr('hexclaim'), E.hashStr('hexclaim'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
});

test('bots: every level returns legal moves through complete games on every board', () => {
  for (const b of E.BOARDS) {
    let s = E.newGame({ spec: E.boardSpec(b.id) });
    const lv = { 1: 'rookie', 2: 'adept' };
    let guard = 0;
    while (!s.over && guard++ < 500) {
      const m = chooseMove(s, { level: lv[s.toMove], seed: guard });
      assert.ok(E.moveKind(s, m.from, m.to), `${b.id}: legal`);
      s = E.applyMove(s, m).state;
    }
    assert.ok(s.over, `${b.id} finished`);
  }
});

test('bots: 4-player self-play finishes', () => {
  let s = E.newGame({ spec: E.boardSpec('hive'), numPlayers: 4 });
  let guard = 0;
  while (!s.over && guard++ < 800) s = E.applyMove(s, chooseMove(s, { level: 'adept', seed: 3 })).state;
  assert.ok(s.over);
  assert.equal(s.result.ranking.length, 4);
});

test('bots: Expert grabs an obvious big capture and Grandmaster respects its time box', () => {
  const s = position(3, [[0, 0, 1], [2, -1, 2], [1, -2, 2], [2, -2, 2], [0, -1, 2], [3, -3, 2], [-3, 3, 2]]);
  const g = E.geometry(s.spec);
  const m = chooseMove(s, { level: 'expert' });
  assert.equal(m.to, idx(g, 1, -1), 'lands among four enemies');
  const t = Date.now();
  const gm = chooseMove(E.newGame({ spec: E.boardSpec('grand') }), { level: 'grandmaster', timeMs: 150 });
  assert.ok(Date.now() - t < 1200, 'time boxed');
  assert.ok(gm.depth >= 1);
  assert.deepEqual(LEVEL_ORDER, ['rookie', 'adept', 'expert', 'grandmaster']);
  assert.ok(LEVELS.rookie.undo && LEVELS.adept.undo && !LEVELS.expert.undo && !LEVELS.grandmaster.undo);
});

test('bots: stronger levels beat Rookie', () => {
  let wins = 0;
  for (let seed = 1; seed <= 4; seed++) {
    let s = E.newGame({ spec: E.boardSpec('skirmish') });
    const lv = seed % 2 ? { 1: 'expert', 2: 'rookie' } : { 1: 'rookie', 2: 'expert' };
    const expert = seed % 2 ? 1 : 2;
    while (!s.over) s = E.applyMove(s, chooseMove(s, { level: lv[s.toMove], seed, timeMs: 200 })).state;
    if (s.result.winner === expert) wins++;
  }
  assert.ok(wins >= 3, `expert won ${wins}/4`);
});

test('daily: same date => same challenge; dates differ; numbering starts at #1', () => {
  const a = D.makeDaily('2026-12-03'), b = D.makeDaily('2026-12-03');
  assert.deepEqual(Array.from(a.start.cells), Array.from(b.start.cells));
  assert.equal(D.dailyNumber('2026-11-21'), 1);
  assert.equal(D.dailyNumber('2026-12-03'), 13);
  const keys = ['2026-12-01', '2026-12-02', '2026-12-04', '2027-02-14'];
  const sigs = new Set(keys.map((k) => { const d = D.makeDaily(k); return d.spec.holes.join(';') + '|' + Array.from(d.start.cells).join(''); }));
  assert.equal(sigs.size, keys.length);
  assert.equal(D.dailyKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('daily: positions are balanced, Coral to move, par is deterministic and in range', () => {
  for (let i = 0; i < 20; i++) {
    const key = D.dailyKey(new Date(2027, 0, 1 + i));
    const d = D.makeDaily(key);
    assert.equal(d.start.toMove, 1); assert.equal(d.start.over, false);
    assert.ok(E.isFairBoard(d.spec, 2), 'daily board symmetric');
    assert.ok(d.par.margin >= -4 && d.par.margin <= 14, `par ${d.par.margin}`);
    assert.deepEqual(D.computePar(d), d.par);
  }
});

test('daily: stars and share text', () => {
  assert.equal(D.starsFor({ won: false, margin: -3, par: 0 }), 0);
  assert.equal(D.starsFor({ won: true, margin: 2, par: 6 }), 1);
  assert.equal(D.starsFor({ won: true, margin: 6, par: 6 }), 2);
  assert.equal(D.starsFor({ won: true, margin: 16, par: 6 }), 3);
  assert.equal(D.starsFor({ won: true, margin: 1, par: 6, wipeout: true }), 3);
  const t = D.shareText({ number: 7, counts: [0, 35, 20], par: 4, moves: 22, stars: 3, won: true });
  const lines = t.split('\n');
  assert.equal(lines[0], 'Hexclaim Daily #7 ★★★');
  assert.match(lines[1], /^(🟧|🟦){10} 35–20$/u);
  assert.equal([...lines[1].matchAll(/🟧/gu)].length, 6);
  assert.match(lines[2], /Won \+15 vs 🤖 Daily Bot · par \+4 · 22 moves/);
});

// Casual-player model used to tune the ladder: greedy 1-ply, prefers clones. Deterministic seeds.
function casualGame(board, botLevel, seed) {
  let s = E.newGame({ spec: E.boardSpec(board), numPlayers: 2 }); const me = (seed % 2) + 1; const rnd = E.makeRng(seed * 7 + 1);
  while (!s.over) {
    let m;
    if (s.toMove === me) { let bv = -1e9; for (const x of E.legalMoves(s)) { const v = E.previewFlips(s, x.to).length * 2 + (x.jump ? 0 : 1.5) + rnd() * 0.9; if (v > bv) { bv = v; m = x; } } }
    else m = chooseMove(s, { level: botLevel, seed: seed * 13 + s.ply });
    s = E.applyMove(s, m).state;
  }
  const c = s.result.counts; return c[me] - c[3 - me];
}
test('bots: difficulty ladder has a middle rung (casual player beats Rookie mostly, Adept sometimes)', () => {
  let rw = 0, aw = 0; const N = 12;
  for (let k = 0; k < N; k++) { if (casualGame('skirmish', 'rookie', k) > 0) rw++; if (casualGame('skirmish', 'adept', k) > 0) aw++; }
  assert.ok(rw >= N * 0.6, `casual vs Rookie ${rw}/${N}`);
  assert.ok(aw >= 1 && aw < rw, `casual vs Adept ${aw}/${N} (Rookie ${rw})`);
});
test('daily: Daily Bot replies are identical for identical positions (seeded tie-breaks)', () => {
  const d = D.makeDaily('2026-11-21');
  const a = chooseMove(d.start, { level: 'daily', seed: 1 }), b = chooseMove(E.deserialize(JSON.parse(JSON.stringify(E.serialize(d.start)))), { level: 'daily', seed: 1 });
  assert.deepEqual([a.from, a.to], [b.from, b.to]);
  assert.deepEqual(D.computePar(d), D.computePar(d));
});
