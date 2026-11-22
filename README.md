# Hexclaim

**A 3-minute strategy duel on a hex board.** Clone into a touching hex or jump two away, and every
enemy piece touching your landing spot flips to your colour. Most hexes when the board fills up wins.

Hexclaim uses the classic "infection" mechanic (the family of games that Ataxx belongs to) on hexes.
The name, art, sounds, boards and code are all original.

## Modes
- **Play vs Bot**: four bots, all clearly labelled 🤖 BOT. **Rookie** (the default for new players) and **Adept** allow undo.
  After a loss the results card offers an easier bot, and after a win streak it offers the next one up.
  **Expert** and **Grandmaster** use alpha-beta search with iterative deepening, limited by a time budget,
  and run in a Web Worker so the UI never freezes. You choose your colour (Coral moves first) and the board.
- **Daily Challenge**: everyone who plays on the same local date gets the same seeded board and
  opening position, against the same deterministic Daily Bot (it takes the biggest immediate gain,
  with seeded tie-breaks). The game also computes a **par**, the margin the Daily Bot reaches when it
  plays your side. An intro card shows the goals before you start: ★ for a win, ★★ for winning by at
  least par (minimum +1) and ★★★ for par + 10 or a wipeout. Only your first finished game counts.
  If you quit or refresh, an attempt in progress is resumed rather than restarted. After that you can
  practise as much as you like, and the Daily tile opens your result with **Share**, which copies an
  emoji result to the clipboard.
- **Pass & Play**: two people on one device.
- **4-Player Brawl**: you against three labelled bots. Players who can't move are skipped.

Six boards with pits (holes) in them: Hive, Skirmish, Atoll, Spokes, Twin Lakes and Grand. Every
2-player board is symmetric, so neither side starts with an advantage, and a unit test checks this.

Stats, streaks, settings and daily results are stored in `localStorage` on your own device. Nothing
is sent anywhere.

## Controls
- **Touch or mouse:** tap one of your pieces, then a highlighted hex. A solid dot means **clone** and
  a dashed ring means **jump**. On a mouse, hovering previews the move, showing which pieces would flip
  and a +N gain. On touch, tapping an empty hex your pieces can clone into shows the preview, and a
  second tap places the piece.
- **Keyboard:** arrow keys move the cursor, Enter/Space selects or places, Esc cancels or opens the
  pause menu, U undoes, M mutes, ? opens the rules.

## Rules (exact)
1. On your turn, move one of your pieces to an empty hex at distance 1 (**clone**: the original stays)
   or distance 2 (**jump**: the original's hex becomes empty).
2. Every opponent piece touching the landing hex becomes yours.
3. A player with no legal move is skipped. If only one player can still move, that player
   **claims every remaining empty hex** and the game ends.
4. The game also ends when the board is full, when only one colour has pieces left, or after a
   ply limit of 4× the number of hexes. Most hexes wins, and ties are draws.

## Run locally
No build step and no dependencies.

```sh
python3 -m http.server 8861 -d docs
# open http://localhost:8861/
```
The game must be served over http(s), because the bot worker is an ES module. Opening
`index.html` straight from `file://` won't work.

## Tests
```sh
npm test            # node --test: rules engine, bots, daily generator (no dependencies)
npm run e2e         # port 8863; headless Chrome plays every mode at 1280x800, 390x844 (touch) and 960x540
```
The e2e script uses a Playwright install from a sibling directory as a dev-only tool, and saves
screenshots to `/workspace/arcade-shots/hexclaim/` (override this with `SHOTS=...`).

## Deploy to GitHub Pages
The deployable site is the `docs/` folder. All of its paths are relative and it makes no external
requests, so it works from a sub-path such as `https://<user>.github.io/hexclaim/`.
1. Push this repo to GitHub.
2. Open Settings → Pages → *Deploy from a branch* and choose `main`, folder `/docs`.
3. The "More games" link points to `../arcade/`, the sibling studio hub.

## Project layout
```
docs/                 deployable static site
  index.html          screens + overlays
  css/style.css       all styling (mobile-first, landscape side-panel layout)
  js/engine.js        PURE rules engine: geometry, moves, turn resolution, seeded RNG (no DOM)
  js/ai.js            PURE bot search (alpha-beta / paranoid for 4P, iterative deepening, time box)
  js/daily.js         PURE daily generator, par, stars, share text
  js/ai-worker.js     Web Worker wrapper around ai.js
  js/render.js        canvas board renderer + animations (flip cascades, particles)
  js/audio.js         WebAudio synthesized sound effects
  js/app.js           UI controller (modes, input, HUD, end screen, replay, stats)
tests/                unit tests (node --test) + Playwright e2e
tools/make-assets.mjs regenerates favicon PNGs and og.png
```

## Credits
- Design, code, art and sounds: original work for this project, released under the MIT License (see `LICENSE`).
- No third-party assets, fonts or data are used. Text uses the system font stack, and every sound is
  synthesized at runtime with WebAudio.
- The mechanic comes from the public-domain "infection" family of abstract games (the family that
  includes Ataxx). Game mechanics aren't owned, and Hexclaim uses no name, art or levels from any
  existing game.
