// End-to-end: serve docs/ statically, play every mode start-to-finish at desktop 1280x800 and
// phone 390x844 (touch), plus a 16:9 landscape sanity pass. Asserts zero console errors / page errors.
// Dev-only dependency: Playwright from a sibling project (not a dependency of the game).
//   node tests/e2e.mjs            (PORT=8863 SHOTS=/workspace/arcade-shots/hexclaim)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8863;
const SHOTS = process.env.SHOTS || '/workspace/arcade-shots/hexclaim';
const BASE = `http://127.0.0.1:${PORT}/`;
fs.mkdirSync(SHOTS, { recursive: true });

const results = []; let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function serve() {
  const py = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', path.join(ROOT, 'docs')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => http.get(BASE, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
    if (ok) return py;
    await new Promise((r) => setTimeout(r, 100));
  }
  py.kill(); throw new Error('server did not start');
}

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  landscape: { viewport: { width: 960, height: 540 } },
};

async function shot(page, vp, name) { await page.screenshot({ path: path.join(SHOTS, `${vp}-${name}.png`) }); }
const H = (page, expr, arg) => page.evaluate(expr, arg);

async function tapAt(page, vp, pt) {
  if (vp === 'phone') await page.touchscreen.tap(pt.x, pt.y); else await page.mouse.click(pt.x, pt.y);
}
async function tapSel(page, vp, sel) {
  if (vp === 'phone') { await page.locator(sel).first().tap(); } else await page.locator(sel).first().click();
}

/** Layout sanity on whatever is on screen: no horizontal overflow, visible buttons inside the viewport. */
async function layoutCheck(page, vp, label) {
  const r = await page.evaluate(() => {
    const W = innerWidth, Hh = innerHeight; const bad = []; const small = [];
    const over = document.documentElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1;
    for (const el of document.querySelectorAll('button, a, input')) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const st = getComputedStyle(el); if (st.visibility === 'hidden') continue;
      // only things on the active screen / open overlay
      if (!el.closest('.screen.active, .overlay:not([hidden])')) continue;
      if (el.closest('.overlay:not([hidden])') == null && document.querySelector('.overlay:not([hidden])')) continue;
      const scroller = el.closest('.setup-body, .card, #scr-title');
      if (!scroller && (b.left < -1 || b.right > W + 1 || b.top < -1 || b.bottom > Hh + 1)) bad.push((el.id || el.dataset.act || el.textContent.trim()).slice(0, 30));
      if (b.height < 40 && !el.matches('input[type=range]')) small.push(`${(el.id || el.dataset.act || el.textContent.trim()).slice(0, 20)}:${Math.round(b.height)}`);
    }
    return { over, bad, small };
  });
  check(`[${vp}] ${label}: no horizontal overflow`, !r.over);
  check(`[${vp}] ${label}: controls inside viewport`, r.bad.length === 0, r.bad.join(', '));
  if (vp === 'phone') check(`[${vp}] ${label}: tap targets ≥ 40px`, r.small.length === 0, r.small.join(', '));
}

/** Play human turns with greedy moves (real clicks/taps on the canvas) until the game ends. */
async function playToEnd(page, vp, { midShot = null, midAt = 6, maxTurns = 400 } = {}) {
  let humanMoves = 0;
  for (let t = 0; t < maxTurns; t++) {
    await page.waitForFunction(() => window.__hex.over || window.__hex.humanTurn, null, { timeout: 60000 });
    if (await H(page, () => window.__hex.over)) break;
    const m = await H(page, () => window.__hex.greedyMove());
    const before = await H(page, () => window.__hex.moves);
    await tapAt(page, vp, await H(page, (i) => window.__hex.cellPoint(i), m.from));
    await page.waitForTimeout(40);
    if (midShot && humanMoves === midAt) { await page.waitForTimeout(250); await shot(page, vp, midShot); }
    await tapAt(page, vp, await H(page, (i) => window.__hex.cellPoint(i), m.to));
    try {
      await page.waitForFunction((b) => window.__hex.moves > b, before, { timeout: 10000 });
    } catch (err) {
      await shot(page, vp, 'FAIL-move');
      const dbg = await H(page, () => ({ st: document.querySelector('#status').textContent, ov: window.__hex.overlay, ht: window.__hex.humanTurn, busy: window.__hex.busy, toMove: window.__hex.state.toMove }));
      throw new Error(`move ${JSON.stringify(m)} not applied: ${JSON.stringify(dbg)}`);
    }
    humanMoves++;
  }
  await page.waitForFunction(() => window.__hex.overlay === '#dlg-end', null, { timeout: 30000 });
  await page.waitForTimeout(900);
  return humanMoves;
}

async function setupPick(page, vp, { level, board, seat } = {}) {
  if (level) await tapSel(page, vp, `#level-chips [data-level="${level}"]`);
  if (seat) await tapSel(page, vp, `#seat-chips [data-seat="${seat}"]`);
  await page.waitForTimeout(80);
  if (board) { await page.locator(`#board-cards [data-board="${board}"]`).scrollIntoViewIfNeeded(); await tapSel(page, vp, `#board-cards [data-board="${board}"]`); }
}

async function runViewport(browser, vp) {
  console.log(`\n=== ${vp} ===`);
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], permissions: vp === 'desktop' ? ['clipboard-read', 'clipboard-write'] : [] });
  await ctx.route(/gc\.zgo\.at|goatcounter\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' })); // analytics stubbed in tests
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message} @ ${(e.stack || "").split("\n").slice(1, 4).join(" < ")}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  const external = [];
  page.on('request', (r) => { if (!/gc\.zgo\.at|goatcounter\.com/.test(r.url()) && !r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

  await page.goto(BASE);
  await page.waitForFunction(() => window.__hex && window.__hex.screen === 'title');
  await page.waitForTimeout(1500);
  await shot(page, vp, '01-title');
  await layoutCheck(page, vp, 'title');

  if (vp === 'landscape') {
    await tapSel(page, vp, '[data-act="mode-bot"]');
    await setupPick(page, vp, { level: 'rookie', board: 'hive' });
    await shot(page, vp, '02-setup');
    await tapSel(page, vp, '#btn-start');
    await page.waitForSelector('#dlg-howto:not([hidden])');
    for (let i = 0; i < 3; i++) await tapSel(page, vp, '#howto-next');
    await H(page, () => window.__hex.setSpeed(6));
    const n = await playToEnd(page, vp, { midShot: '03-midgame', midAt: 5 });
    check(`[${vp}] vs Rookie bot finished`, n > 0, `${n} human moves`);
    await shot(page, vp, '04-end');
    await layoutCheck(page, vp, 'end screen');
    await tapSel(page, vp, '#dlg-end [data-act="quit"]');
    await tapSel(page, vp, '[data-act="mode-ffa"]');
    await setupPick(page, vp, { level: 'rookie', board: 'grand' });
    await tapSel(page, vp, '#btn-start');
    await page.waitForTimeout(1500);
    await shot(page, vp, '05-ffa-start');
    await layoutCheck(page, vp, '4-player game');
    check(`[${vp}] zero console/page errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
    await ctx.close();
    return { errors: errors.length };
  }

  // ---------- how-to from title ----------
  await tapSel(page, vp, '.title-links [data-act="howto"]');
  await page.waitForSelector('#dlg-howto:not([hidden])');
  await page.waitForTimeout(900);
  await shot(page, vp, '02-howto-1');
  await tapSel(page, vp, '#howto-next'); await page.waitForTimeout(800);
  await shot(page, vp, '02-howto-2');
  await tapSel(page, vp, '#howto-next'); await page.waitForTimeout(1300);
  await shot(page, vp, '02-howto-3');
  await layoutCheck(page, vp, 'how-to');
  await tapSel(page, vp, '#howto-next');
  check(`[${vp}] how-to closes`, await page.locator('#dlg-howto').isHidden());

  // ---------- vs bot (Rookie, with undo) ----------
  await tapSel(page, vp, '[data-act="mode-bot"]');
  await page.waitForSelector('#scr-setup.active');
  await setupPick(page, vp, { level: 'rookie', board: vp === 'phone' ? 'hive' : 'spokes', seat: '1' });
  await page.waitForTimeout(200);
  await shot(page, vp, '03-setup-bot');
  await layoutCheck(page, vp, 'setup');
  await tapSel(page, vp, '#btn-start');
  await page.waitForFunction(() => window.__hex.screen === 'game');
  // first game ever shows the how-to again? (no: already seen from the title)
  check(`[${vp}] how-to not forced twice`, await page.locator('#dlg-howto').isHidden());
  await H(page, () => window.__hex.setSpeed(5));
  // first human move, then undo it after the bot replies
  await page.waitForFunction(() => window.__hex.humanTurn, null, { timeout: 10000 });
  const m0 = await H(page, () => window.__hex.greedyMove());
  await tapAt(page, vp, await H(page, (i) => window.__hex.cellPoint(i), m0.from));
  await page.waitForTimeout(150);
  await shot(page, vp, '04-select-targets');
  await tapAt(page, vp, await H(page, (i) => window.__hex.cellPoint(i), m0.to));
  await page.waitForFunction(() => window.__hex.moves >= 2 && window.__hex.humanTurn, null, { timeout: 15000 });
  await tapSel(page, vp, '#btn-undo');
  await page.waitForTimeout(200);
  check(`[${vp}] undo reverts to before your move`, (await H(page, () => window.__hex.moves)) === 0);
  // touch preview: tap an empty clone-able hex twice (phone) / hover preview (desktop)
  if (vp === 'phone') {
    const m = await H(page, () => window.__hex.legalMoves().find((x) => !x.jump));
    await tapAt(page, vp, await H(page, (i) => window.__hex.cellPoint(i), m.to));
    await page.waitForTimeout(200);
    check(`[${vp}] first tap on empty hex only previews`, (await H(page, () => window.__hex.moves)) === 0);
    await shot(page, vp, '05-touch-preview');
    await tapAt(page, vp, await H(page, (i) => window.__hex.cellPoint(i), m.to));
    await page.waitForFunction(() => window.__hex.moves >= 1, null, { timeout: 5000 });
    check(`[${vp}] second tap places the clone`, true);
  } else {
    const m = await H(page, () => window.__hex.legalMoves().find((x) => !x.jump));
    const pt = await H(page, (i) => window.__hex.cellPoint(i), m.to);
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(250);
    await shot(page, vp, '05-hover-preview');
    // keyboard: Enter on the cursor selects a piece, Esc cancels
    await page.mouse.move(5, 5);
    await page.locator('#board').focus();
    const kb0 = await H(page, () => window.__hex.moves);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const st = await page.locator('#status').textContent();
    const moved = (await H(page, () => window.__hex.moves)) > kb0;
    check(`[${vp}] keyboard Enter acts on the cursor hex`, /clone/.test(st) || moved, moved ? 'placed a move' : st);
    if (!moved) await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check(`[${vp}] Esc cancels selection (no pause menu)`, await page.locator('#dlg-pause').isHidden());
  }
  const n1 = await playToEnd(page, vp, { midShot: '06-midgame-bot', midAt: 8 });
  check(`[${vp}] vs Rookie bot played to result screen`, n1 > 3, `${n1} human moves`);
  await shot(page, vp, '07-end-bot');
  await layoutCheck(page, vp, 'end screen');
  const title = await page.locator('#end-title').textContent();
  check(`[${vp}] result title shown`, /Victory|Defeat|Draw/.test(title), title);
  // replay
  await tapSel(page, vp, '#dlg-end [data-act="replay"]');
  await page.waitForTimeout(1200);
  const rp = await H(page, () => window.__hex.replay);
  check(`[${vp}] replay running`, !!rp && rp.total > 0, JSON.stringify(rp));
  await shot(page, vp, '08-replay');
  await layoutCheck(page, vp, 'replay');
  await tapSel(page, vp, '[data-act="rp-next"]');
  await tapSel(page, vp, '[data-act="rp-done"]');
  await page.waitForSelector('#dlg-end:not([hidden])');
  await tapSel(page, vp, '#dlg-end [data-act="quit"]');
  await page.waitForSelector('#scr-title.active');

  // ---------- Daily ----------
  await tapSel(page, vp, '[data-act="mode-daily"]');
  await page.waitForSelector('#dlg-daily:not([hidden])');
  await page.waitForTimeout(400);
  await shot(page, vp, '09-daily-intro');
  await layoutCheck(page, vp, 'daily intro');
  check(`[${vp}] daily intro explains the star goals`, (await page.locator('#daily-goals li').count()) === 3);
  await tapSel(page, vp, '#daily-go');
  await page.waitForFunction(() => window.__hex.screen === 'game' && window.__hex.mode === 'daily');
  await page.waitForTimeout(700);
  await shot(page, vp, '09-daily-start');
  await H(page, () => window.__hex.setSpeed(5));
  const nd = await playToEnd(page, vp, { midShot: '10-daily-mid', midAt: 5 });
  check(`[${vp}] daily played to result`, nd > 0, `${nd} moves`);
  await page.waitForTimeout(600);
  await shot(page, vp, '11-daily-end');
  await layoutCheck(page, vp, 'daily end');
  check(`[${vp}] daily shows stars`, await page.locator('#end-stars').isVisible());
  await tapSel(page, vp, '#btn-share');
  await page.waitForTimeout(300);
  const share = await H(page, () => window.__hex.lastShare());
  check(`[${vp}] share text copied`, !!share && share.startsWith('Hexclaim Daily #') && share.includes('🟧'), JSON.stringify(share));
  if (vp === 'desktop') {
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    check(`[${vp}] clipboard contains share text`, clip === share);
  }
  const stored = await H(page, () => JSON.parse(localStorage.getItem('hexclaim:v1')).daily.results[window.__hex.dailyKey()]);
  check(`[${vp}] daily result persisted`, !!stored && typeof stored.margin === 'number');
  await tapSel(page, vp, '#dlg-end [data-act="quit"]');
  const sub = await page.locator('#daily-sub').textContent();
  check(`[${vp}] title shows daily done`, sub.startsWith('Done'), sub);
  // tapping a finished Daily shows the result card with Share (not a new game)
  await tapSel(page, vp, '[data-act="mode-daily"]');
  await page.waitForSelector('#dlg-daily:not([hidden])');
  check(`[${vp}] finished daily opens result card with share`, (await page.locator('#daily-share').isVisible()) && (await H(page, () => window.__hex.screen)) === 'title');
  await page.waitForTimeout(300);
  await shot(page, vp, '11b-daily-done-card');
  await tapSel(page, vp, '#dlg-daily [data-act="daily-close"]');

  // ---------- Pass & Play ----------
  await tapSel(page, vp, '[data-act="mode-pnp"]');
  await setupPick(page, vp, { board: 'skirmish' });
  await tapSel(page, vp, '#btn-start');
  await page.waitForFunction(() => window.__hex.screen === 'game' && window.__hex.mode === 'pnp');
  await H(page, () => window.__hex.setSpeed(6));
  const np = await playToEnd(page, vp, { midShot: '12-pnp-mid', midAt: 7 });
  check(`[${vp}] pass & play finished`, np > 4, `${np} moves`);
  await shot(page, vp, '13-pnp-end');
  const pt = await page.locator('#end-title').textContent();
  check(`[${vp}] pass & play winner named`, /Coral wins|Teal wins|Draw/.test(pt), pt);
  await tapSel(page, vp, '#dlg-end [data-act="quit"]');

  // ---------- 4-player brawl vs 3 bots ----------
  await tapSel(page, vp, '[data-act="mode-ffa"]');
  await setupPick(page, vp, { level: 'rookie', board: vp === 'phone' ? 'skirmish' : 'grand' });
  await shot(page, vp, '14-setup-ffa');
  await tapSel(page, vp, '#btn-start');
  await page.waitForFunction(() => window.__hex.screen === 'game' && window.__hex.mode === 'ffa');
  await H(page, () => window.__hex.setSpeed(6));
  const nf = await playToEnd(page, vp, { midShot: '15-ffa-mid', midAt: 4 });
  check(`[${vp}] 4-player brawl finished`, nf > 0, `${nf} moves`);
  await shot(page, vp, '16-ffa-end');
  await layoutCheck(page, vp, 'ffa end');
  const bots = await page.locator('#end-scores .bot-tag').count();
  check(`[${vp}] all 3 bots labelled BOT on results`, bots === 3, String(bots));
  await tapSel(page, vp, '#dlg-end [data-act="quit"]');

  // ---------- stats + harder bot smoke (Grandmaster thinks in the worker) ----------
  await tapSel(page, vp, '[data-act="stats"]');
  await page.waitForSelector('#dlg-stats:not([hidden])');
  await page.waitForTimeout(500);
  await shot(page, vp, '17-stats');
  await layoutCheck(page, vp, 'stats');
  await tapSel(page, vp, '#dlg-stats [data-act="close"]');
  await tapSel(page, vp, '[data-act="mode-bot"]');
  await setupPick(page, vp, { level: 'grandmaster', seat: '2', board: 'hive' });
  await tapSel(page, vp, '#btn-start');
  await page.waitForFunction(() => window.__hex.moves >= 1 && window.__hex.humanTurn, null, { timeout: 20000 });
  check(`[${vp}] Grandmaster bot (worker) moved first as Coral`, true);
  check(`[${vp}] undo disabled vs Grandmaster`, await page.locator('#btn-undo').isDisabled());
  await shot(page, vp, '18-grandmaster');

  check(`[${vp}] no external requests`, external.length === 0, external.slice(0, 3).join(', '));
  check(`[${vp}] zero console/page errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
  return { errors: errors.length };
}

const server = await serve();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const summary = {};
try {
  for (const vp of (process.env.VP ? process.env.VP.split(',') : ['desktop', 'phone', 'landscape'])) {
    try { summary[vp] = await runViewport(browser, vp); } catch (err) { check(`[${vp}] run completed`, false, err.message.split('\n')[0]); summary[vp] = { errors: 'n/a (crashed)' }; }
  }
} finally {
  await browser.close(); server.kill();
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed; console errors per viewport: ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.errors])))}`);
console.log(`screenshots: ${SHOTS}`);
fs.writeFileSync(path.join(SHOTS, 'e2e-results.json'), JSON.stringify({ when: new Date().toISOString(), passed, total: results.length, summary, results }, null, 2));
process.exit(failures ? 1 : 0);
