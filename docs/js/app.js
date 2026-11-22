// Hexclaim — UI controller. All rules live in engine.js; bots in ai.js (run in ai-worker.js).
import { BOARDS, BOARD_BY_ID, boardSpec, newGame, applyMove, moveKind, targetsFrom, previewFlips, legalMoves,
  counts, serialize, geometry, isFairBoard, PLAYER_NAMES } from './engine.js';
import { LEVELS, LEVEL_ORDER, chooseMove } from './ai.js';
import { dailyKey, makeDaily, computePar, starsFor, shareText } from './daily.js'; // eslint-disable-line no-unused-vars
import { BoardView, PCOL, drawMiniBoard } from './render.js';
import { sfx, unlock, setMuted, isMuted } from './audio.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================== storage */
const STORE_KEY = 'hexclaim:v1';
const store = (() => {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { data = {}; }
  data.prefs ||= {}; data.bot ||= {}; data.ffa ||= { played: 0, wins: 0, places: [0, 0, 0, 0] };
  data.pnp ||= { played: 0 }; data.daily ||= { results: {} };
  return {
    data,
    save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* private mode */ } },
  };
})();
const prefs = store.data.prefs;

/* =========================================================== bot worker */
const bot = (() => {
  let worker = null; let seq = 0; const pending = new Map();
  try {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data); } };
    worker.onerror = (e) => { console.warn('bot worker unavailable, using main thread', e.message || ''); e.preventDefault?.(); worker = null; for (const p of pending.values()) p.fallback(); pending.clear(); };
  } catch { worker = null; }
  function local(msg) {
    if (msg.type === 'move') return { move: chooseMove(msg.state, { level: msg.level, seed: msg.seed }) };
    if (msg.type === 'par') return { par: computePar(makeDaily(msg.key)) };
    return {};
  }
  function ask(msg) {
    return new Promise((resolve, reject) => {
      const runLocal = () => setTimeout(() => { try { resolve(local(msg)); } catch (err) { reject(err); } }, 0);
      if (!worker) return runLocal();
      const id = ++seq; pending.set(id, { resolve, reject, fallback: runLocal });
      worker.postMessage({ ...msg, id });
    });
  }
  return { ask };
})();

/* =========================================================== DOM helpers */
const screens = { title: $('#scr-title'), setup: $('#scr-setup'), game: $('#scr-game') };
let currentScreen = 'title';
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
  currentScreen = name;
  clearTimeout(toastTimer); $('#toast').classList.remove('show');
  if (name === 'title') { attract.start(); refreshTitle(); } else attract.stop();
  if (name === 'game') requestAnimationFrame(() => view.resize());
}
const overlays = ['#dlg-howto', '#dlg-pause', '#dlg-end', '#dlg-stats', '#dlg-daily'];
let lastFocus = null;
function openOverlay(sel) {
  lastFocus = document.activeElement;
  const el = $(sel); el.hidden = false;
  const f = el.querySelector('.btn-primary:not([hidden])') || el.querySelector('button:not([hidden])'); f?.focus({ preventScroll: true });
}
function closeOverlay(sel) { $(sel).hidden = true; if (lastFocus && document.contains(lastFocus)) lastFocus.focus?.({ preventScroll: true }); }
const openOverlayId = () => overlays.find((s) => !$(s).hidden) || null;
let toastTimer = 0;
function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function banner(text, p) {
  const b = $('#banner'); b.textContent = text; b.style.setProperty('--bc', p ? PCOL[p].base : '#fff');
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}
function updateMuteUI() {
  for (const el of $$('.mute-toggle')) { el.setAttribute('aria-pressed', String(isMuted())); el.querySelector('.mute-ico').textContent = isMuted() ? '🔇' : '🔊'; }
}
function toggleMute() { setMuted(!isMuted()); prefs.muted = isMuted(); store.save(); updateMuteUI(); if (!isMuted()) sfx.click(); }
setMuted(!!prefs.muted); updateMuteUI();

/* =========================================================== game state */
const view = new BoardView($('#board'));
const S = {
  cfg: null, start: null, states: [], moves: [], gen: 0, busy: false, thinking: false,
  touchPreview: null, replay: null, endShown: false, startedAt: 0,
  pendingBot: null, // bot reply requested early (while the previous move animates)
  animCounts: null, // HUD counts while a move animates, so numbers tick with the flips
};
let SPEED = 1;
const cur = () => S.states[S.states.length - 1];
const seatOf = (p) => S.cfg?.seats[p];
const isHuman = (p) => seatOf(p) === 'human';
const humanTurn = () => { const s = cur(); return s && !s.over && isHuman(s.toMove) && !S.busy && !S.replay; };

function playerLabel(p, short = false) {
  const c = S.cfg;
  if (c.mode === 'pnp') return PLAYER_NAMES[p];
  if (isHuman(p)) return 'You';
  if (c.mode === 'daily') return short ? 'Daily Bot' : 'Daily Bot';
  if (c.mode === 'ffa') return short ? PLAYER_NAMES[p] : `${PLAYER_NAMES[p]} Bot`;
  return `${LEVELS[c.level].name} Bot`;
}
function playerSub(p) {
  const c = S.cfg;
  if (c.mode === 'pnp') return `Player ${p}`;
  if (isHuman(p)) return PLAYER_NAMES[p];
  if (c.mode === 'daily') return 'Teal';
  if (c.mode === 'ffa') return '';
  return PLAYER_NAMES[p];
}

/* =========================================================== start / setup */
function defaultSeats(mode, seat = 1) {
  if (mode === 'pnp') return [null, 'human', 'human'];
  if (mode === 'ffa') return [null, 'human', 'bot', 'bot', 'bot'];
  return seat === 2 ? [null, 'bot', 'human'] : [null, 'human', 'bot'];
}
let setupMode = 'bot';
const setupSel = { level: prefs.level || 'rookie', ffaLevel: prefs.ffaLevel || 'rookie', seat: prefs.seat || 1,
  board: prefs.board || 'hive', pnpBoard: prefs.pnpBoard || 'hive', ffaBoard: prefs.ffaBoard || 'grand' };

function openSetup(mode) {
  setupMode = mode;
  $('#setup-title').textContent = mode === 'bot' ? 'Play vs Bot' : mode === 'pnp' ? 'Pass & Play' : '4-Player Brawl';
  $('#field-level').hidden = mode === 'pnp';
  $('#field-seat').hidden = mode !== 'bot';
  renderLevelChips(); renderSeatChips(); renderBoardCards();
  $('#btn-start').textContent = mode === 'bot' ? 'Start game' : mode === 'pnp' ? 'Start — Coral goes first' : 'Start brawl';
  show('setup');
}
function levelKey() { return setupMode === 'ffa' ? 'ffaLevel' : 'level'; }
function boardKey() { return setupMode === 'ffa' ? 'ffaBoard' : setupMode === 'pnp' ? 'pnpBoard' : 'board'; }
function renderLevelChips() {
  const box = $('#level-chips'); box.innerHTML = '';
  LEVEL_ORDER.forEach((id, n) => {
    const L = LEVELS[id];
    const b = document.createElement('button');
    b.className = 'chip'; b.setAttribute('role', 'radio'); b.dataset.level = id;
    b.setAttribute('aria-checked', String(setupSel[levelKey()] === id));
    b.innerHTML = `<span aria-hidden="true">🤖</span>${L.name}<span class="lv-pips" aria-hidden="true">${[0, 1, 2, 3].map((k) => `<i class="${k <= n ? 'on' : ''}"></i>`).join('')}</span>`;
    b.addEventListener('click', () => { setupSel[levelKey()] = id; sfx.click(); renderLevelChips(); });
    box.appendChild(b);
  });
  const L = LEVELS[setupSel[levelKey()]];
  $('#level-blurb').textContent = `${L.blurb}${setupMode === 'bot' ? (L.undo ? ' Undo allowed.' : ' No undo.') : ''}`;
}
function renderSeatChips() {
  for (const b of $$('#seat-chips .seat')) {
    b.setAttribute('aria-checked', String(Number(b.dataset.seat) === setupSel.seat));
    b.onclick = () => { setupSel.seat = Number(b.dataset.seat); sfx.click(); renderSeatChips(); };
  }
}
function renderBoardCards() {
  const box = $('#board-cards'); box.innerHTML = '';
  const n = setupMode === 'ffa' ? 4 : 2;
  const list = BOARDS.filter((b) => isFairBoard(boardSpec(b.id), n));
  if (!list.find((b) => b.id === setupSel[boardKey()])) setupSel[boardKey()] = list[0].id;
  for (const b of list) {
    const el = document.createElement('button');
    el.className = 'board-card'; el.setAttribute('role', 'radio'); el.dataset.board = b.id;
    el.setAttribute('aria-checked', String(setupSel[boardKey()] === b.id));
    el.title = b.blurb;
    const spec = boardSpec(b.id);
    el.innerHTML = `<canvas aria-hidden="true"></canvas><b>${b.name}</b><small>${geometry(spec).size} hexes</small>`;
    el.addEventListener('click', () => { setupSel[boardKey()] = b.id; sfx.click(); renderBoardCards(); toast(b.blurb, 1500); });
    box.appendChild(el);
    const cv = el.querySelector('canvas'); const cells = newGame({ spec, numPlayers: n }).cells;
    requestAnimationFrame(() => drawMiniBoard(cv, spec, cells));
  }
}
function startFromSetup() {
  const m = setupMode;
  Object.assign(prefs, { level: setupSel.level, ffaLevel: setupSel.ffaLevel, seat: setupSel.seat, board: setupSel.board, pnpBoard: setupSel.pnpBoard, ffaBoard: setupSel.ffaBoard });
  store.save();
  if (m === 'bot') startGame({ mode: 'bot', level: setupSel.level, boardId: setupSel.board, numPlayers: 2, seats: defaultSeats('bot', setupSel.seat) });
  else if (m === 'pnp') startGame({ mode: 'pnp', boardId: setupSel.pnpBoard, numPlayers: 2, seats: defaultSeats('pnp') });
  else startGame({ mode: 'ffa', level: setupSel.ffaLevel, boardId: setupSel.ffaBoard, numPlayers: 4, seats: defaultSeats('ffa') });
}

function getDaily() { return makeDaily(dailyKey()); }
const dailyDone = (d = getDaily()) => !!store.data.daily.results[d.key];
function startDaily() {
  const d = getDaily();
  const practice = dailyDone(d);
  // a scored attempt in progress is resumed (refresh / quit can't be used to re-roll today's game)
  const ip = store.data.daily.inprog;
  const resume = !practice && ip && ip.key === d.key && Array.isArray(ip.moves) && ip.moves.length ? ip.moves : null;
  startGame({ mode: 'daily', level: 'daily', daily: d, practice, numPlayers: 2, seats: defaultSeats('daily'), boardId: d.spec.id }, resume);
}
const sgn = (v) => (v > 0 ? '+' + v : String(v));
function dailyGoals(par) { return { two: Math.max(1, par), three: Math.max(1, par) + 10 }; }
/** Daily card: an intro before a scored attempt, or today's result (share / practise) once done. */
function openDailyCard() {
  const d = getDaily(); const rec = store.data.daily.results[d.key];
  const g = dailyGoals(d.par.margin);
  $('#daily-title').textContent = `Daily #${d.number}`;
  $('#daily-kicker').textContent = `${d.spec.name} variant · same for everyone`;
  $('#daily-goals').innerHTML = `<li><b>★</b> Beat the 🤖 Daily Bot</li><li><b>★★</b> Win by ${sgn(g.two)} or more <small>(par)</small></li><li><b>★★★</b> Win by ${sgn(g.three)} or wipe it out</li>`;
  const ip = store.data.daily.inprog;
  const resuming = !rec && ip && ip.key === d.key && ip.moves?.length;
  if (rec) {
    $('#daily-body').textContent = '';
    $('#daily-result').hidden = false;
    $('#daily-result').innerHTML = `<div class="stars">${[0, 1, 2].map((k) => `<span class="${k < rec.stars ? '' : 'off'}">★</span>`).join('')}</div><p>${rec.won ? 'Won' : rec.draw ? 'Draw' : 'Lost'} <b>${rec.counts[1]}–${rec.counts[2]}</b> (${sgn(rec.margin)}) in ${rec.moves} moves</p>`;
    $('#daily-share').hidden = false;
    $('#daily-go').textContent = 'Practise (not scored)';
    $('#daily-go').classList.remove('btn-primary');
    S.shareText = shareText({ ...rec, url: location.protocol.startsWith('http') ? location.origin + location.pathname : '' });
    startCountdown('#daily-next');
  } else {
    $('#daily-result').hidden = true;
    $('#daily-body').textContent = resuming
      ? 'Your attempt is still in progress. Pick up where you left off.'
      : "You're Coral and you move first. The hex counts may start uneven, but every Daily is checked to be winnable. Only your first finished game counts.";
    $('#daily-share').hidden = true;
    $('#daily-go').textContent = resuming ? 'Resume' : 'Start';
    $('#daily-go').classList.add('btn-primary');
    $('#daily-next').textContent = '';
  }
  openOverlay('#dlg-daily');
}

function startGame(cfg, resumeMoves = null) {
  S.gen++;
  S.cfg = cfg;
  const start = cfg.mode === 'daily' ? cfg.daily.start : newGame({ spec: boardSpec(cfg.boardId), numPlayers: cfg.numPlayers });
  S.start = start; S.states = [start]; S.moves = []; S.busy = false; S.thinking = false; S.touchPreview = null;
  S.pendingBot = null; S.animCounts = null;
  if (resumeMoves) {
    try { for (const m of resumeMoves) { const r = applyMove(cur(), m); S.states.push(r.state); S.moves.push({ from: m.from, to: m.to }); if (r.state.over) break; } } catch { S.states = [start]; S.moves = []; }
  }
  S.replay = null; S.endShown = false; S.startedAt = Date.now(); S.seed = (Date.now() & 0xffffff) ^ 0x5eed;
  if (cfg.mode === 'daily') S.seed = 1;
  for (const o of overlays) $(o).hidden = true;
  $('#toast').classList.remove('show');
  $('#replay-controls').hidden = true; $('#controls').hidden = false;
  clearSelection();
  const last = cur();
  view.setState(last);
  view.lastMove = last.lastMove ? { from: last.lastMove.from, to: last.lastMove.to, kind: last.lastMove.kind, p: last.lastMove.player } : null;
  const lvl = cfg.level ? LEVELS[cfg.level] : null;
  const spec = start.spec; const bname = BOARD_BY_ID[spec.id]?.name || spec.name;
  $('#match-title').textContent = cfg.mode === 'bot' ? `vs 🤖 ${lvl.name} · ${bname}`
    : cfg.mode === 'daily' ? `Daily #${cfg.daily.number}${cfg.practice ? ' · practice' : ''} · ★★ at ${sgn(dailyGoals(cfg.daily.par.margin).two)}`
      : cfg.mode === 'pnp' ? `Pass & Play · ${bname}` : `Brawl · vs 3 🤖 ${lvl.name} bots · ${bname}`;
  const R = geometry(start.spec).R;
  $('#board-wrap').style.setProperty('--ar', String((3 * R + 2) / (Math.sqrt(3) * (2 * R + 1))));
  buildPlayers();
  updateHUD();
  show('game');
  if (!store.data.seenHowto) openHowto();
  const p = last.toMove;
  if (resumeMoves) toast('Resumed your Daily attempt');
  else if (cfg.mode === 'pnp') banner(`${PLAYER_NAMES[p]} first`, p);
  else if (cfg.mode === 'daily') banner(cfg.practice ? 'Practice round' : 'Beat the Daily Bot!', 1);
  else banner(isHuman(p) ? 'You move first' : 'Bot moves first', p);
  S.busy = true; // no input until the opening banner has played
  const gen = S.gen;
  setTimeout(() => { if (gen !== S.gen) return; S.busy = false; nextTurn(gen); }, 500 / SPEED);
}

/* =========================================================== HUD */
function buildPlayers() {
  const box = $('#players'); box.innerHTML = '';
  box.classList.toggle('four', S.cfg.numPlayers === 4);
  for (let p = 1; p <= S.cfg.numPlayers; p++) {
    const el = document.createElement('div');
    el.className = 'pcard'; el.dataset.p = p; el.style.setProperty('--pc', PCOL[p].base);
    const isBot = seatOf(p) === 'bot';
    el.innerHTML = `<i class="dot p${p}" aria-hidden="true"></i><span class="pname"><b>${playerLabel(p, S.cfg.numPlayers === 4)}</b><small>${isBot ? '<span class="bot-tag">BOT</span> ' : ''}${playerSub(p)}</small></span><span class="pcount">0</span>`;
    box.appendChild(el);
  }
  const bar = $('#scorebar'); bar.innerHTML = '';
  for (let p = 1; p <= S.cfg.numPlayers; p++) { const i = document.createElement('i'); i.className = 'p' + p; bar.appendChild(i); }
  const gap = document.createElement('i'); gap.className = 'p0'; bar.appendChild(gap);
}
let lastCounts = [];
function updateHUD() {
  const s = S.replay ? S.replay.states[S.replay.idx] : cur();
  const c = (!S.replay && S.animCounts) || counts(s.cells, s.numPlayers);
  for (const el of $$('#players .pcard')) {
    const p = Number(el.dataset.p);
    const cnt = el.querySelector('.pcount');
    if (cnt.textContent !== String(c[p])) { cnt.textContent = c[p]; if (lastCounts[p] !== undefined) { cnt.classList.remove('bump'); void cnt.offsetWidth; cnt.classList.add('bump'); } }
    // while a move animates, the glow stays on whoever is moving; it passes on when the move lands
    const glow = S.animCounts && S.animPlayer ? S.animPlayer : s.toMove;
    el.classList.toggle('turn', !S.replay && !s.over && glow === p);
    el.classList.toggle('out', c[p] === 0 && s.ply > 0);
  }
  lastCounts = c;
  const segs = $$('#scorebar i');
  segs.forEach((seg, k) => { seg.style.flexGrow = String(k < s.numPlayers ? c[k + 1] : c[0]); });
  const undoOk = canUndo();
  $('#btn-undo').disabled = !undoOk;
  $('#btn-undo').title = undoOk ? 'Undo your last move (U)' : (S.cfg.mode === 'bot' ? 'Undo is available vs Rookie and Adept bots' : 'Undo not available in this mode');
  $('#btn-undo').hidden = S.cfg.mode === 'daily' || S.cfg.mode === 'ffa';
  $('.keys-hint').textContent = S.replay ? 'Keys: ← → step · Space play/pause' : 'Keys: arrows move · Enter select/place · Esc cancel · U undo · M mute';
  if (!S.busy || S.replay) setStatus();
}
function setStatus(extra) {
  const box = $('#status');
  let el = box.firstElementChild;
  if (!el || el.tagName !== 'SPAN') { box.innerHTML = '<span></span>'; el = box.firstElementChild; }
  const s = cur();
  if (S.replay) { el.textContent = `Replay · move ${S.replay.idx} of ${S.replay.states.length - 1}`; return; }
  if (!s) return;
  if (s.over) { el.textContent = 'Game over'; return; }
  const p = s.toMove; const col = PCOL[p].base;
  if (extra) { el.innerHTML = extra; return; }
  if (!isHuman(p)) {
    el.innerHTML = `<span style="color:${col}">🤖 ${playerLabel(p)}</span> is thinking<span class="think"><i></i><i></i><i></i></span>`;
    return;
  }
  const who = S.cfg.mode === 'pnp' ? `<span style="color:${col}">${PLAYER_NAMES[p]}</span>` : `<span style="color:${col}">Your move</span>`;
  if (view.sel >= 0) el.innerHTML = `${who} — tap <b>●</b> clone or <b>◌</b> jump`;
  else if (S.touchPreview) el.innerHTML = `${who} — tap again to place`;
  else el.innerHTML = `${who} — pick a piece${S.cfg.mode === 'pnp' ? ' to move' : ''}`;
}

/* =========================================================== turn loop */
async function nextTurn(gen) {
  if (gen !== S.gen || S.replay) return;
  const s = cur();
  updateHUD();
  if (s.over) return endGame();
  if (isHuman(s.toMove)) {
    if (S.cfg.mode === 'pnp' && S.states.length > 1) { banner(`${PLAYER_NAMES[s.toMove]}'s turn`, s.toMove); sfx.turn(); }
    if (view.cursor < 0 || cur().cells[view.cursor] !== s.toMove) {
      const mine = []; s.cells.forEach((o, i) => { if (o === s.toMove) mine.push(i); });
      if (mine.length && (view.cursor < 0)) view.cursor = mine[0];
    }
    return;
  }
  // bot turn
  if (S.thinking) return; // already asked
  S.thinking = true; setStatus();
  const req = S.pendingBot && S.pendingBot.gen === gen && S.pendingBot.ply === s.ply ? S.pendingBot : requestBot(s, gen);
  S.pendingBot = null;
  let res;
  try { res = await req.promise; } catch (err) {
    console.warn('bot error', err);
    res = { move: chooseMove(s, { level: 'rookie', seed: s.ply }) };
  }
  // a short beat so the bot's reply never lands on top of your own animation
  const minThink = (S.cfg.mode === 'ffa' ? 280 : 420) / SPEED;
  const wait = Math.max(minThink - (performance.now() - req.t0), 160 / SPEED);
  await sleep(wait);
  await whilePaused(gen); // the pause menu / rules really pause the game
  if (gen !== S.gen || S.replay) return;
  S.thinking = false;
  await perform(res.move, gen);
}
function requestBot(s, gen) {
  const seed = S.cfg.mode === 'daily' ? 1 : (S.seed + s.ply * 7919) >>> 0; // daily: same bot as par
  return { gen, ply: s.ply, t0: performance.now(), promise: bot.ask({ type: 'move', state: serialize(s), level: S.cfg.level, seed }) };
}
const pausedNow = () => { const o = openOverlayId(); return o === '#dlg-pause' || o === '#dlg-howto' || o === '#dlg-daily'; };
async function whilePaused(gen) { while (gen === S.gen && pausedNow()) await sleep(120); }

function saveDailyProgress() {
  const c = S.cfg; if (c?.mode !== 'daily' || c.practice) return;
  const d = store.data.daily;
  if (cur().over) delete d.inprog; else d.inprog = { key: c.daily.key, moves: S.moves.slice() };
  store.save();
}
async function perform(move, gen = S.gen) {
  const prev = cur();
  const res = applyMove(prev, move);
  S.busy = true;
  clearSelection();
  S.states.push(res.state); S.moves.push({ from: move.from, to: move.to });
  saveDailyProgress();
  // the next bot (if any) starts thinking now, in parallel with this move's animation
  const nx = res.state;
  S.pendingBot = !nx.over && !isHuman(nx.toMove) ? requestBot(nx, gen) : null;
  view.setState(res.state, { keepAnims: true });
  const n = prev.numPlayers; const p = res.player;
  S.animCounts = counts(prev.cells, n); S.animPlayer = p;
  updateHUD();
  const gain = res.flips.length + (res.kind === 'clone' ? 1 : 0);
  const col = PCOL[p].base;
  setStatus(`<span style="color:${col}">${seatOf(p) === 'bot' ? '🤖 ' : ''}${playerLabel(p)}</span> ${res.kind === 'jump' ? 'jump' : 'clone'}${playerLabel(p) === 'You' ? '' : 's'}${gain ? ` · <b style="color:${col}">+${gain}</b>` : ''}`);
  const fromOf = new Map(res.flips.map((f) => [f.i, f.from]));
  const tick = (fn) => { if (gen !== S.gen || !S.animCounts) return; fn(S.animCounts); updateHUD(); };
  if (res.kind === 'jump') sfx.jump(p); else sfx.clone(p);
  await view.animateMove(res, {
    onFlip: (k, i) => { sfx.flip(k); tick((c) => { c[p]++; c[fromOf.get(i)]--; }); },
    onLand: () => { if (res.flips.length >= 4) sfx.bigFlip(); if (res.kind === 'clone') tick((c) => { c[p]++; c[0]--; }); },
    onClaim: () => sfx.claim(),
  });
  if (gen !== S.gen) return;
  S.animCounts = null;
  S.busy = false;
  updateHUD();
  // announce skipped players
  if (!res.state.over) {
    const n = prev.numPlayers; const skipped = [];
    for (let k = 1; k < n; k++) { const q = ((res.player - 1 + k) % n) + 1; if (q === res.state.toMove) break; if (counts(res.state.cells, n)[q] > 0) skipped.push(q); }
    if (skipped.length) toast(`${skipped.map((q) => playerLabel(q)).join(', ')} can't move — skipped`);
  }
  nextTurn(gen);
}

/* =========================================================== input */
function clearSelection() { view.sel = -1; view.targets = null; view.preview = null; S.touchPreview = null; }
function selectPiece(i) {
  const s = cur();
  view.sel = i; view.targets = targetsFrom(s, i); view.preview = null; S.touchPreview = null;
  if (!view.targets.clones.length && !view.targets.jumps.length) { toast('That piece is boxed in'); sfx.invalid(); }
  else sfx.select();
  setStatus();
}
function cloneSource(s, to) { return geometry(s.spec).n1[to].find((n) => s.cells[n] === s.toMove); }
function jumpSources(s, to) { return geometry(s.spec).n2[to].filter((n) => s.cells[n] === s.toMove); }
function makePreview(from, to) {
  const s = cur(); const kind = moveKind(s, from, to);
  if (!kind) return null;
  return { from, to, kind, flips: previewFlips(s, to), player: s.toMove };
}
let lastPointer = 'mouse';
function onCell(i, viaKeyboard = false) {
  if (!humanTurn()) return;
  const s = cur(); const p = s.toMove;
  if (i < 0) { if (view.sel >= 0) { clearSelection(); sfx.deselect(); setStatus(); } return; }
  const owner = s.cells[i];
  if (owner === p) {
    if (view.sel === i) { clearSelection(); sfx.deselect(); } else selectPiece(i);
    setStatus(); return;
  }
  if (owner !== 0) { if (view.sel >= 0) { clearSelection(); sfx.deselect(); } else { sfx.invalid(); toast(`That's ${playerLabel(owner)}'s piece — pick one of yours`); } setStatus(); return; }
  // empty hex
  if (view.sel >= 0) {
    if (moveKind(s, view.sel, i)) { perform({ from: view.sel, to: i }); return; }
    sfx.invalid(); clearSelection(); toast('Too far — clone 1 hex or jump 2'); setStatus(); return;
  }
  const touchLike = lastPointer !== 'mouse' && !viaKeyboard;
  const cs = cloneSource(s, i);
  if (cs !== undefined) {
    if (!touchLike || (S.touchPreview && S.touchPreview.to === i)) { perform({ from: cs, to: i }); return; }
    S.touchPreview = makePreview(cs, i); view.preview = S.touchPreview; sfx.select(); setStatus(); return;
  }
  const js = jumpSources(s, i);
  if (js.length === 1) {
    if (S.touchPreview && S.touchPreview.to === i) { perform({ from: js[0], to: i }); return; }
    view.sel = js[0]; view.targets = targetsFrom(s, js[0]);
    S.touchPreview = makePreview(js[0], i); view.preview = S.touchPreview; sfx.select();
    setStatus(`${S.cfg.mode === 'pnp' ? PLAYER_NAMES[p] : 'Jump'} — tap again to jump here`);
    // the next tap on i should execute: selection already set so onCell path handles it
    return;
  }
  if (js.length > 1) {
    view.hintSources = js; view.hintUntil = performance.now() + 1600; sfx.click();
    toast('Several pieces can jump there — pick one'); return;
  }
  sfx.invalid(); toast('Out of reach — pick a piece first');
}
const canvas = $('#board');
canvas.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; unlock(); });
canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  const i = view.hitTest(e.clientX - r.left, e.clientY - r.top);
  view.showCursor = false;
  if (i >= 0) view.cursor = i;
  onCell(i);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const r = canvas.getBoundingClientRect();
  const i = view.hitTest(e.clientX - r.left, e.clientY - r.top);
  hover(i);
});
canvas.addEventListener('pointerleave', () => hover(-1));
function hover(i) {
  view.hover = i;
  if (!humanTurn() || S.touchPreview) { if (!S.touchPreview) view.preview = null; return; }
  const s = cur();
  canvas.style.cursor = i >= 0 && (s.cells[i] === s.toMove || (s.cells[i] === 0 && (view.sel >= 0 ? moveKind(s, view.sel, i) : cloneSource(s, i) !== undefined))) ? 'pointer' : 'default';
  if (i < 0 || s.cells[i] !== 0) { view.preview = null; return; }
  if (view.sel >= 0) view.preview = makePreview(view.sel, i);
  else { const cs = cloneSource(s, i); view.preview = cs !== undefined ? makePreview(cs, i) : null; }
}

/* keyboard */
function moveCursor(dx, dy) {
  const g = view.g; if (!g) return;
  if (view.cursor < 0) { view.cursor = 0; return; }
  const a = view.pos[view.cursor]; let best = -1, bd = Infinity;
  view.pos.forEach((b, i) => {
    if (i === view.cursor) return;
    const vx = b.x - a.x, vy = b.y - a.y; const along = vx * dx + vy * dy;
    if (along <= view.size * 0.3) return;
    const perp = Math.abs(vx * dy - vy * dx);
    const d = along + perp * 2.2;
    if (d < bd) { bd = d; best = i; }
  });
  if (best >= 0) view.cursor = best;
  if (humanTurn() && cur().cells[view.cursor] === 0) {
    const s = cur();
    if (view.sel >= 0) view.preview = makePreview(view.sel, view.cursor);
    else { const cs = cloneSource(s, view.cursor); view.preview = cs !== undefined ? makePreview(cs, view.cursor) : null; }
  } else if (!S.touchPreview) view.preview = null;
}
document.addEventListener('keydown', (e) => {
  unlock();
  const ov = openOverlayId();
  if (e.key === 'Escape') {
    if (ov === '#dlg-end') return;
    if (ov) { closeOverlay(ov); e.preventDefault(); return; }
    if (currentScreen === 'game') { if (view.sel >= 0 || S.touchPreview) { clearSelection(); setStatus(); } else if (!S.replay) openPause(); }
    else if (currentScreen === 'setup') show('title');
    return;
  }
  if (e.key === 'm' || e.key === 'M') { toggleMute(); return; }
  if (ov === '#dlg-howto') {
    if (e.key === 'ArrowRight') { howtoGo(1); e.preventDefault(); } else if (e.key === 'ArrowLeft') { howtoGo(-1); e.preventDefault(); }
    return;
  }
  if (ov) { if (ov === '#dlg-end' && (e.key === 'r' || e.key === 'R')) rematch(); return; }
  if (currentScreen !== 'game') return;
  if (S.replay) {
    if (e.key === 'ArrowRight') { replayStep(1); e.preventDefault(); } else if (e.key === 'ArrowLeft') { replayStep(-1); e.preventDefault(); }
    else if (e.key === ' ') { replayToggle(); e.preventDefault(); }
    return;
  }
  const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  if (dirs[e.key]) {
    e.preventDefault(); view.showCursor = true; moveCursor(...dirs[e.key]); return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.tagName !== 'BUTTON') {
    e.preventDefault(); view.showCursor = true; if (view.cursor >= 0) onCell(view.cursor, true); return;
  }
  if (e.key === 'u' || e.key === 'U') { undo(); return; }
  if (e.key === '?' || e.key === 'h' || e.key === 'H') { openHowto(); }
});

function openPause() {
  // restarting a scored Daily would allow re-rolling today's game, so it's only offered in practice
  $('#btn-restart').hidden = S.cfg?.mode === 'daily' && !S.cfg.practice;
  openOverlay('#dlg-pause');
}

/* =========================================================== undo */
function canUndo() {
  const c = S.cfg; if (!c || S.replay || cur()?.over) return false;
  if (c.mode === 'pnp') return S.moves.length > 0;
  if (c.mode === 'bot' && LEVELS[c.level].undo) return S.states.some((st, k) => k < S.moves.length && isHuman(st.toMove));
  return false;
}
function undo() {
  if (!canUndo()) { if (S.cfg?.mode === 'bot') toast('Undo is available vs Rookie and Adept bots'); return; }
  let k;
  if (S.cfg.mode === 'pnp') k = S.moves.length - 1;
  else { k = -1; for (let j = S.moves.length - 1; j >= 0; j--) if (isHuman(S.states[j].toMove)) { k = j; break; } }
  if (k < 0) return;
  S.gen++; S.busy = false; S.thinking = false; S.pendingBot = null; S.animCounts = null;
  S.states.length = k + 1; S.moves.length = k;
  clearSelection();
  const s = cur();
  view.setState(s);
  view.lastMove = s.lastMove ? { from: s.lastMove.from, to: s.lastMove.to, kind: s.lastMove.kind, p: s.lastMove.player } : null;
  sfx.deselect(); toast('Move undone', 1000);
  nextTurn(S.gen);
}

/* =========================================================== end */
function rankOf(p, c, n) { let r = 1; for (let q = 1; q <= n; q++) if (q !== p && c[q] > c[p]) r++; return r; }
const ORD = ['', '1st', '2nd', '3rd', '4th'];
function reasonText(s, claimedCount) {
  const r = s.result;
  if (r.reason === 'full') return 'The board is full.';
  if (r.reason === 'claim') {
    const name = playerLabel(r.claimer);
    return claimedCount ? `${name} claimed ${claimedCount === 1 ? 'the last empty hex' : `the last ${claimedCount} empty hexes`}. Nobody else could move.` : 'Nobody else could move.';
  }
  if (r.reason === 'wipeout') {
    const n = s.numPlayers;
    if (n === 2) { const loser = r.counts[1] === 0 ? 1 : 2; return `${playerLabel(loser) === 'You' ? 'You were' : playerLabel(loser) + ' was'} wiped off the board!`; }
    return 'Only one colour is left standing!';
  }
  if (r.reason === 'limit') return 'Move limit reached.';
  return 'Nobody can move.';
}
async function endGame() {
  if (S.endShown) return; S.endShown = true;
  const s = cur(); const r = s.result; const c = r.counts; const cfg = S.cfg;
  const n = s.numPlayers;
  const lastRes = S.moves.length ? applyMove(S.states[S.states.length - 2], S.moves[S.moves.length - 1]) : null;
  const claimedCount = lastRes ? lastRes.claimed.length : 0;
  let title = '', cls = '', kicker = '', statsLine = '', outcome = 'draw';
  S.suggest = null;
  const human = [1, 2, 3, 4].find((p) => p <= n && isHuman(p));
  const myWin = r.winner === human; const isDraw = r.winner === 0 && r.winners.includes(human);
  if (cfg.mode === 'pnp') {
    title = r.winner ? `${PLAYER_NAMES[r.winner]} wins!` : 'Draw!'; cls = 'win';
    kicker = 'Pass & Play'; outcome = r.winner ? 'win' : 'draw';
    store.data.pnp.played++;
  } else if (cfg.mode === 'ffa') {
    const place = rankOf(human, c, n);
    outcome = place === 1 ? (isDraw ? 'draw' : 'win') : 'loss';
    title = place === 1 ? (isDraw ? 'Shared 1st!' : 'You win the brawl!') : `You placed ${ORD[place]}`;
    cls = place === 1 ? 'win' : '';
    kicker = `4-Player Brawl · vs 3 🤖 ${LEVELS[cfg.level].name} bots`;
    const f = store.data.ffa; f.played++; if (outcome === 'win') f.wins++; f.places[place - 1]++;
    statsLine = `Brawls: ${f.played} played · ${f.wins} won`;
  } else {
    outcome = myWin ? 'win' : isDraw ? 'draw' : 'loss';
    title = myWin ? 'Victory!' : isDraw ? 'Draw' : 'Defeat';
    cls = myWin ? 'win' : '';
    if (cfg.mode === 'bot') {
      kicker = `vs 🤖 ${LEVELS[cfg.level].name} Bot`;
      const b = (store.data.bot[cfg.level] ||= { w: 0, l: 0, d: 0, streak: 0, best: 0, bestMargin: null });
      if (outcome === 'win') { b.w++; b.streak++; b.best = Math.max(b.best, b.streak); } else if (outcome === 'loss') { b.l++; b.streak = 0; } else b.d++;
      const margin = c[human] - c[3 - human];
      if (outcome === 'win' && (b.bestMargin == null || margin > b.bestMargin)) b.bestMargin = margin;
      statsLine = `vs ${LEVELS[cfg.level].name}: ${b.w}W · ${b.l}L${b.d ? ` · ${b.d}D` : ''}${b.streak > 1 ? ` · 🔥 ${b.streak} in a row` : ''}`;
      // nudge along the difficulty ladder: an easier bot after a loss, a harder one after a streak
      const li = LEVEL_ORDER.indexOf(cfg.level);
      if (outcome === 'loss' && li > 0) S.suggest = { level: LEVEL_ORDER[li - 1], label: `Try 🤖 ${LEVELS[LEVEL_ORDER[li - 1]].name} (easier)` };
      else if (outcome === 'win' && li < LEVEL_ORDER.length - 1 && (b.streak >= 2 || li === 0)) S.suggest = { level: LEVEL_ORDER[li + 1], label: `Next: 🤖 ${LEVELS[LEVEL_ORDER[li + 1]].name} →` };
    } else {
      kicker = `Daily #${cfg.daily.number}${cfg.practice ? " · practice" : ""} · vs 🤖 Daily Bot`;
    }
  }
  store.save();
  // daily
  const shareBtn = $('#btn-share'); shareBtn.hidden = true;
  const starsEl = $('#end-stars'); starsEl.hidden = true;
  $('#end-next').textContent = '';
  $('#btn-rematch').textContent = cfg.mode === 'daily' ? 'Practise again (not scored)' : 'Rematch';
  $('#btn-rematch').classList.toggle('btn-primary', cfg.mode !== 'daily' && !(S.suggest && outcome === 'loss'));
  const sug = $('#btn-suggest'); sug.hidden = !S.suggest;
  if (S.suggest) { sug.textContent = S.suggest.label; sug.classList.toggle('btn-primary', outcome === 'loss'); }
  if (cfg.mode === 'daily') {
    const par = cfg.daily.par; const g = dailyGoals(par.margin);
    const margin = c[1] - c[2];
    const stars = starsFor({ won: myWin, margin, par: g.two, wipeout: r.reason === 'wipeout' && myWin });
    const key = cfg.daily.key;
    const res = store.data.daily.results;
    const first = !res[key] && !cfg.practice;
    const humanMoves = S.moves.filter((_, k) => isHuman(S.states[k].toMove)).length;
    const mine = { counts: [c[0], c[1], c[2]], margin, par: g.two, stars, moves: humanMoves, won: myWin, draw: isDraw, number: cfg.daily.number };
    if (first) { res[key] = mine; delete store.data.daily.inprog; store.save(); }
    const rec = res[key] || mine;
    const shown = cfg.practice ? stars : rec.stars;
    starsEl.hidden = false;
    starsEl.innerHTML = [0, 1, 2].map((k) => `<span class="${k < shown ? '' : 'off'}">★</span>`).join('');
    if (shown) [0, 1, 2].slice(0, shown).forEach((k) => sfx.star(k));
    shareBtn.hidden = false;
    shareBtn.textContent = cfg.practice ? "Share today's score" : 'Share result';
    statsLine = `Margin ${sgn(margin)} · ★ win · ★★ ${sgn(g.two)} · ★★★ ${sgn(g.three)}` + (cfg.practice ? ` · practice only; today's score stays ${'★'.repeat(rec.stars)}${'☆'.repeat(3 - rec.stars)}` : '') + ` · 🔥 streak ${dailyStreak()}`;
    S.shareText = shareText({ ...rec, counts: rec.counts, par: rec.par, url: location.protocol.startsWith('http') ? location.origin + location.pathname : '' });
    startCountdown('#end-next');
  }
  // render end card
  $('#end-kicker').textContent = kicker;
  const h = $('#end-title'); h.textContent = title; h.className = cls;
  $('#end-reason').textContent = reasonText(s, claimedCount);
  const sc = $('#end-scores'); sc.innerHTML = '';
  const total = geometry(s.spec).size;
  r.ranking.forEach((p) => {
    const row = document.createElement('div'); row.className = 'srow';
    const rk = n > 2 ? ORD[rankOf(p, c, n)] : '';
    row.innerHTML = `<span class="rank">${rk}</span><span class="who"><i class="dot p${p}"></i> ${playerLabel(p)}${seatOf(p) === 'bot' ? '<span class="bot-tag">BOT</span>' : ''}</span><span class="sbar"><i style="background:${PCOL[p].base}"></i></span><span class="sval">${c[p]}</span>`;
    sc.appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => { row.querySelector('.sbar i').style.width = `${(c[p] / total) * 100}%`; }));
  });
  $('#end-stats').textContent = statsLine;
  $('.end-burst').style.setProperty('--ec', outcome === 'win' ? 'rgba(255,211,107,.45)' : outcome === 'loss' ? 'rgba(120,140,255,.25)' : 'rgba(255,255,255,.2)');
  await sleep(700 / SPEED);
  if (outcome === 'win') sfx.win(); else if (outcome === 'loss') sfx.lose(); else sfx.draw();
  if (outcome === 'win' || cfg.mode === 'pnp') confetti();
  openOverlay('#dlg-end');
  drawGraph();
  updateHUD();
  refreshTitle();
}
function confetti() {
  const s = cur(); const g = geometry(s.spec);
  for (let k = 0; k < 10; k++) {
    setTimeout(() => {
      const i = Math.floor(Math.random() * g.size); const o = s.cells[i] || 1; const p = view.pos[i];
      if (p) view.burst(p.x, p.y, o, 14, 1.6);
    }, k * 90);
  }
}
function drawGraph() {
  const cv = $('#end-graph'); const w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
  const dpr = Math.min(devicePixelRatio || 1, 2); cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const n = S.cfg.numPlayers; const ref = [1, 2, 3, 4].find((p) => p <= n && isHuman(p)) || 1;
  const last = S.states.length - 1;
  // one point per round (when the reference player is to move), so the lines don't zig-zag every ply
  const series = S.states.filter((st, k) => k === 0 || k === last || st.toMove === ref).map((st) => counts(st.cells, n));
  const total = geometry(cur().spec).size; const L = series.length - 1 || 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  for (let p = 1; p <= n; p++) {
    ctx.beginPath();
    series.forEach((c, k) => { const x = 2 + (k / L) * (w - 4), y = h - 3 - (c[p] / total) * (h - 6); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = PCOL[p].base; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  }
}
let cdTimer = 0;
function startCountdown(sel) {
  clearInterval(cdTimer);
  const tick = () => {
    const now = new Date(); const t = new Date(now); t.setHours(24, 0, 0, 0);
    const ms = t - now; const hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
    $(sel).textContent = `Next Daily in ${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };
  tick(); cdTimer = setInterval(tick, 1000);
}
function dailyStreak() {
  const res = store.data.daily.results; let n = 0; const d = new Date();
  if (!res[dailyKey(d)]) d.setDate(d.getDate() - 1);
  while (res[dailyKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
async function share() {
  const text = S.shareText || '';
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove();
  }
  window.__hexLastShare = text;
  toast(ok ? 'Result copied — paste it anywhere!' : 'Could not copy — long-press to copy:\n' + text, ok ? 1800 : 5000);
  sfx.click();
}
function rematch() {
  const cfg = S.cfg; closeOverlay('#dlg-end'); clearInterval(cdTimer);
  if (cfg.mode === 'daily') startDaily(); else startGame({ ...cfg });
}
function playSuggested() {
  const sg = S.suggest; if (!sg) return;
  closeOverlay('#dlg-end'); clearInterval(cdTimer);
  setupSel.level = prefs.level = sg.level; store.save();
  startGame({ ...S.cfg, level: sg.level });
}

/* =========================================================== replay */
function enterReplay() {
  closeOverlay('#dlg-end');
  S.replay = { states: S.states.slice(), moves: S.moves.slice(), idx: 0, playing: false, timer: 0 };
  $('#controls').hidden = true; $('#replay-controls').hidden = false;
  const sl = $('#rp-slider'); sl.max = String(S.replay.moves.length); sl.value = '0';
  view.lastMove = null; clearSelection();
  view.setState(S.replay.states[0]);
  updateHUD();
  replayToggle(true);
}
function replaySet(idx) {
  const R = S.replay; R.idx = Math.max(0, Math.min(R.moves.length, idx));
  const s = R.states[R.idx];
  view.setState(s);
  view.lastMove = s.lastMove ? { from: s.lastMove.from, to: s.lastMove.to, kind: s.lastMove.kind, p: s.lastMove.player } : null;
  $('#rp-slider').value = String(R.idx); updateHUD();
}
async function replayStep(dir) {
  const R = S.replay; if (!R) return;
  if (dir < 0) { replaySet(R.idx - 1); return; }
  if (R.idx >= R.moves.length) { replayToggle(false); return; }
  const res = applyMove(R.states[R.idx], R.moves[R.idx]);
  R.idx++;
  view.setState(R.states[R.idx], { keepAnims: true });
  $('#rp-slider').value = String(R.idx); updateHUD();
  if (res.kind === 'jump') sfx.jump(res.player); else sfx.clone(res.player);
  await view.animateMove(res, { onFlip: (k) => sfx.flip(k), onClaim: () => sfx.claim() });
}
function replayToggle(force) {
  const R = S.replay; if (!R) return;
  R.playing = force ?? !R.playing;
  $('.rp-play').textContent = R.playing ? '⏸' : '▶';
  clearTimeout(R.timer);
  if (R.playing) {
    if (R.idx >= R.moves.length) replaySet(0);
    const loop = async () => {
      if (!S.replay || !R.playing) return;
      if (R.idx >= R.moves.length) { replayToggle(false); return; }
      await replayStep(1);
      R.timer = setTimeout(loop, 260 / SPEED);
    };
    R.timer = setTimeout(loop, 200 / SPEED);
  }
}
function exitReplay() {
  if (!S.replay) return;
  clearTimeout(S.replay.timer); S.replay = null;
  $('#replay-controls').hidden = true; $('#controls').hidden = false;
  const s = cur(); view.setState(s);
  updateHUD();
  openOverlay('#dlg-end'); drawGraph();
}
$('#rp-slider').addEventListener('input', (e) => { if (S.replay) { replayToggle(false); replaySet(Number(e.target.value)); } });

/* =========================================================== how to play */
const HX = 26, SQ3 = Math.sqrt(3);
function hexSvg(cells, extra = '') {
  // cells: [{q,r, cls, piece, pcls}]
  const pts = (x, y, s) => Array.from({ length: 6 }, (_, k) => `${(x + s * Math.cos(Math.PI / 3 * k)).toFixed(1)},${(y + s * Math.sin(Math.PI / 3 * k)).toFixed(1)}`).join(' ');
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  const body = cells.map((c) => {
    const x = HX * 1.5 * c.q, y = HX * SQ3 * (c.r + c.q / 2);
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    let s = `<polygon points="${pts(x, y, HX * 0.93)}" fill="${c.fill || '#243058'}" stroke="rgba(160,180,255,.18)" stroke-width="1.5" ${c.cls ? `class="${c.cls}"` : ''}/>`;
    if (c.ring) s += `<polygon points="${pts(x, y, HX * 0.72)}" fill="none" stroke="${c.ring}" stroke-width="2.5" stroke-dasharray="5 4"/>`;
    if (c.dot) s += `<circle cx="${x}" cy="${y}" r="5" fill="${c.dot}"/>`;
    if (c.piece) s += `<circle cx="${x}" cy="${y}" r="${HX * 0.6}" style="fill:var(--${c.piece})" stroke="rgba(0,0,0,.35)" stroke-width="2" ${c.pcls ? `class="${c.pcls}"` : ''}/>`;
    return s;
  }).join('');
  const m = HX * 1.3;
  return `<svg viewBox="${minx - m} ${miny - m} ${maxx - minx + 2 * m} ${maxy - miny + 2 * m}" role="img" aria-hidden="true">${body}${extra}</svg>`;
}
const FLOWER = [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
function buildHowtoArt() {
  const C = 'rgba(255,107,87,.35)';
  $('[data-art="clone"]').innerHTML = hexSvg(FLOWER.map(([q, r]) => ({ q, r, piece: q === 0 && r === 0 ? 'p1' : (q === 1 && r === 0 ? 'p1' : null), pcls: q === 1 && r === 0 ? 'ha-ghost' : '', fill: q || r ? '#2e2f55' : undefined, dot: (q || r) && !(q === 1 && r === 0) ? C : null })));
  const R2 = []; for (let q = -2; q <= 2; q++) for (let r = Math.max(-2, -q - 2); r <= Math.min(2, -q + 2); r++) R2.push([q, r]);
  const fx = HX * 1.5 * -1, fy = HX * SQ3 * (0 + -1 / 2), tx = HX * 1.5 * 1, ty = HX * SQ3 * (-1 + 1 / 2);
  $('[data-art="jump"]').innerHTML = hexSvg(R2.map(([q, r]) => {
    const src = q === -1 && r === 0, dst = q === 1 && r === -1;
    const far = Math.max(Math.abs(q + 1), Math.abs(r), Math.abs(-q - r - 1)) === 2;
    return { q, r, piece: src ? 'p1' : dst ? 'p1' : (q === 1 && r === 1 ? 'p2' : null), pcls: src ? 'ha-src' : dst ? 'ha-land' : '', ring: far && !dst ? 'rgba(255,107,87,.45)' : null };
  }), `<path d="M${fx} ${fy} Q ${(fx + tx) / 2} ${(fy + ty) / 2 - 50} ${tx} ${ty}" fill="none" stroke="var(--p1l)" stroke-width="3" stroke-dasharray="6 6" stroke-linecap="round"/>`);
  $('[data-art="flip"]').innerHTML = hexSvg([...FLOWER, [-2, 1], [2, -1]].map(([q, r], k) => {
    const flipIdx = { '1,0': 'a', '0,-1': 'b', '-1,1': 'c' }[q + ',' + r];
    return { q, r, piece: q === 0 && r === 0 ? 'p1' : flipIdx ? 'p2' : (q === -2 && r === 1 ? 'p1' : (q === 2 && r === -1 ? 'p2' : null)), pcls: q === 0 && r === 0 ? 'ha-land' : flipIdx ? `ha-flip ${flipIdx}` : '' };
  }));
}
let howtoStep = 0;
function openHowto() { if (!store.data.seenHowto) { store.data.seenHowto = true; store.save(); } howtoStep = 0; renderHowto(); openOverlay('#dlg-howto'); }
function renderHowto() {
  $$('#howto-steps .step').forEach((el, k) => el.classList.toggle('active', k === howtoStep));
  $$('#step-dots i').forEach((el, k) => el.classList.toggle('on', k === howtoStep));
  $('#howto-next').textContent = howtoStep === 2 ? "Let's play!" : 'Next';
  $('[data-act="howto-prev"]').disabled = howtoStep === 0;
}
function howtoGo(d) {
  if (d > 0 && howtoStep === 2) { closeOverlay('#dlg-howto'); return; }
  howtoStep = Math.max(0, Math.min(2, howtoStep + d)); sfx.click(); renderHowto();
}

/* =========================================================== stats */
function openStats() {
  const d = store.data; let played = 0, wins = 0;
  const rows = LEVEL_ORDER.map((id) => {
    const b = d.bot[id] || { w: 0, l: 0, d: 0, best: 0 }; played += b.w + b.l + b.d; wins += b.w;
    return `<tr><td>🤖 ${LEVELS[id].name}</td><td>${b.w}</td><td>${b.l}</td><td>${b.d}</td><td>${b.best || 0}</td></tr>`;
  }).join('');
  played += d.ffa.played + d.pnp.played; wins += d.ffa.wins;
  const dres = Object.values(d.daily.results);
  const dwins = dres.filter((r) => r.won).length; const stars = dres.reduce((a, r) => a + r.stars, 0);
  $('#stats-body').innerHTML = `
    <div class="stat-tiles"><div class="stat-tile"><b>${played}</b><small>Games</small></div><div class="stat-tile"><b>${wins}</b><small>Wins</small></div><div class="stat-tile"><b>${dailyStreak()}</b><small>Daily streak</small></div></div>
    <p class="stats-h">Vs bots</p>
    <table class="stats-table"><tr><th>Bot</th><th>W</th><th>L</th><th>D</th><th>Best run</th></tr>${rows}</table>
    <p class="stats-h">Daily</p>
    <table class="stats-table"><tr><th>Played</th><th>Won</th><th>Stars</th></tr><tr><td>${dres.length}</td><td>${dwins}</td><td>${stars} ★</td></tr></table>
    <p class="stats-h">Other modes</p>
    <table class="stats-table"><tr><th>4-Player Brawl</th><th>Played</th><th>Won</th></tr><tr><td>vs 3 bots</td><td>${d.ffa.played}</td><td>${d.ffa.wins}</td></tr>
    <tr><td>Pass &amp; Play</td><td>${d.pnp.played}</td><td>–</td></tr></table>`;
  openOverlay('#dlg-stats');
}

/* =========================================================== title */
function refreshTitle() {
  const d = getDaily(); const rec = store.data.daily.results[d.key];
  $('#daily-label').textContent = `Daily #${d.number}`;
  const ip = store.data.daily.inprog;
  $('#daily-sub').textContent = rec ? `Done ${'★'.repeat(rec.stars)}${'☆'.repeat(3 - rec.stars)} · see result & share` : ip && ip.key === d.key ? `${d.spec.name} variant · in progress, tap to resume` : `${d.spec.name} variant · beat today's position`;
  $('[data-act="mode-daily"]').classList.toggle('done', !!rec);
}
const attract = (() => {
  const cv = $('#attract'); let v = null; let s = null; let timer = 0; let on = false; let seed = 7;
  async function loop() {
    if (!on) return;
    if (!s || s.over) { s = newGame({ spec: boardSpec(['hive', 'spokes', 'atoll'][seed % 3]), numPlayers: 2 }); seed++; v.lastMove = null; v.setState(s); }
    else {
      const m = chooseMove(s, { level: 'rookie', seed: seed * 31 + s.ply });
      const res = applyMove(s, m); s = res.state; v.setState(s, { keepAnims: true }); v.animateMove(res);
    }
    timer = setTimeout(loop, s.over ? 2200 : 850);
  }
  return {
    start() { if (on) return; on = true; if (!v) { v = new BoardView(cv, { decorative: true }); } v.start(); clearTimeout(timer); timer = setTimeout(loop, 200); },
    stop() { on = false; clearTimeout(timer); v?.stop(); },
  };
})();

/* =========================================================== wiring */
const actions = {
  'mode-bot': () => openSetup('bot'), 'mode-pnp': () => openSetup('pnp'), 'mode-ffa': () => openSetup('ffa'),
  'mode-daily': openDailyCard,
  'daily-go': () => { closeOverlay('#dlg-daily'); clearInterval(cdTimer); startDaily(); },
  'daily-close': () => { closeOverlay('#dlg-daily'); clearInterval(cdTimer); },
  suggest: playSuggested,
  back: () => show('title'), start: startFromSetup,
  howto: openHowto, 'howto-next': () => howtoGo(1), 'howto-prev': () => howtoGo(-1),
  stats: openStats, close: () => closeOverlay('#dlg-stats'),
  mute: toggleMute, pause: openPause, resume: () => closeOverlay('#dlg-pause'),
  restart: () => { closeOverlay('#dlg-pause'); if (S.cfg.mode === 'daily') startDaily(); else startGame({ ...S.cfg }); },
  quit: () => { S.gen++; clearInterval(cdTimer); for (const o of overlays) $(o).hidden = true; if (S.replay) { clearTimeout(S.replay.timer); S.replay = null; } show('title'); },
  undo, share, rematch, replay: enterReplay,
  'rp-start': () => { replayToggle(false); replaySet(0); }, 'rp-prev': () => { replayToggle(false); replayStep(-1); },
  'rp-next': () => { replayToggle(false); replayStep(1); }, 'rp-play': () => replayToggle(), 'rp-done': exitReplay,
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  unlock();
  const a = actions[b.dataset.act]; if (!a) return;
  if (!['mute', 'howto-next', 'howto-prev'].includes(b.dataset.act)) sfx.click();
  a();
});
for (const o of overlays) $(o).addEventListener('click', (e) => { if (e.target === e.currentTarget && o !== '#dlg-end') { closeOverlay(o); if (o === '#dlg-daily') clearInterval(cdTimer); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) attract.stop(); else if (currentScreen === 'title') attract.start(); });

buildHowtoArt();
show('title');

/* =========================================================== test hook (used by tests/e2e.mjs) */
window.__hex = {
  get screen() { return currentScreen; },
  get state() { const s = cur(); return s ? serialize(s) : null; },
  get busy() { return S.busy || S.thinking; },
  get humanTurn() { return currentScreen === 'game' && !openOverlayId() && humanTurn(); },
  get over() { return !!cur()?.over; },
  get overlay() { return openOverlayId(); },
  get mode() { return S.cfg?.mode; },
  get moves() { return S.moves.length; },
  get replay() { return S.replay ? { idx: S.replay.idx, total: S.replay.moves.length, playing: S.replay.playing } : null; },
  setSpeed(x) { SPEED = x; view.speed = x; },
  legalMoves() { const s = cur(); return s ? legalMoves(s) : []; },
  /** greedy pick for the test player: most flips, prefer clones */
  greedyMove() {
    const s = cur(); const g = geometry(s.spec);
    let best = null, bv = -Infinity;
    for (const m of legalMoves(s)) { let v = previewFlips(s, m.to).length * 2 + (m.jump ? 0 : 1.5) + (m.to % 7) * 0.01; for (const n of g.n1[m.to]) if (s.cells[n] === s.toMove) v += 0.1; if (v > bv) { bv = v; best = m; } }
    return best;
  },
  /** page coordinates of a cell centre */
  cellPoint(i) { const r = canvas.getBoundingClientRect(); const p = view.cellCenter(i); return { x: r.left + p.x, y: r.top + p.y }; },
  dailyKey: () => dailyKey(),
  lastShare: () => window.__hexLastShare || null,
};
