# DotminationVR

Dotmination — the original flatscreen/mobile game (vivido-design.com/dotmination, Google Play) — brought to WebXR.
It uses the same rules, maps and colours as the app, on one vertical board standing between two players.
Everything around the game (lobby, PeerJS networking, spectating, Mixamo body IK, locomotion, replays, stats, menu)
is copied from **StacksVR**, not rewritten.

The earlier sphere prototype now lives in `../DotminationVR360`.

## Rules (ported 1:1 from `dotmination-v3/www`)

- **Board:** 9 rows that alternate 5 and 4 dots, 40 dots in total. Neighbours are the dots that touch.
- **Turns:** on your turn, tap an empty dot or one of your own. It grows one stage (0–5) and takes your colour.
- **Bursts:** tapping a stage-5 dot makes it burst. It empties, and every neighbour gets +1 and turns your colour.
  The increments run one at a time, lowest index first, at 0.1 s each, exactly like the original's animation.
- **Winning:** from move 2 on, the first player with no dots left loses. That is *Dotmination!*
  The score shown is the sum of stages.
- **Colours:** you are pink `#E11168` (the original player--2) and the bot is teal `#12DACE`. **C** cycles the 4 original palettes.

## Modes

| Menu | What it is | Original equivalent |
| --- | --- | --- |
| SOLO · Level 1–200 | The app's pi-generated level maps vs the bot (Normal). Stars: win, under 2:00, under 1:00. Best time is saved, and a win unlocks the next level. | Level mode |
| SOLO · Random map | A random stage and owner for each dot, vs a **NORM** or **HARD** bot (the board-size toggle). | Random mode |
| MULTIPLAYER (lobby) | Turn-based PvP across the one shared vertical board. Start type: **BLANK** (default) or **HALF**-filled. The first player alternates each rematch. 25 s turn timer. | Multiplayer |
| Preview | Bot vs bot on the menu screen. | – |

The experimental Real-Time mode of the original is deliberately not included.

Progress is saved in `localStorage['dotminationvr-progress']` in the same shape the app uses:
`{level, levels:{levelN:{time}}}`.

## Controls

- **VR:** point and trigger, or poke a dot with your finger. The left-hand menu has the level picker (− / +), NORM/HARD, and BLANK/HALF.
- **Desktop/mobile:** click or tap a dot. **[ ]** change level, **C** changes the palette. Spectators get the orbit camera.

## Files

- `dot-rules.js` – the rules engine (layout, apply/bursts, level generator, random and half-filled starts, serialize).
- `dot-bot.js` – the original `botLogic.js` (random and smart).
- `dot-board.js` – the canvas view drawn like the app (rings per stage, spring easing, ripples, +1 floats).
- `dot-ui.js` – brand cards (tutorial, welcome, end card) and their laser/poke/mouse buttons.
- `dot-game.js` – the A-Frame game component. Its lobby, pointer, popup, victory, replay and spectator methods
  are verbatim copies of StacksVR's `stacks-game.js` methods; the Dotmination turn logic is new.
- `lobby.js`, `game-menu.js`, `mixamo-body.js`, `locomotion.js`, `mobile-spectator.js`, `match-replay.js`, `stats.js`,
  `stacks-audio.js`, `modes.js` – StacksVR copies (namespaced `dotminationvr-`).
- `scripts/test-rules.mjs` – a Node test for the rules and the bot.

## From the original app (v0.2.0)

- **Tutorial:**
  - The first visit opens "Welcome to Dotmination!" with [Start Tutorial] / [Play Level 1]. Afterwards it's always available under **HOW TO PLAY** in the menu.
  - The 5 original steps use the same boards, wording and checks: Claiming Dots, Growing Dots, Explosions & Take-overs, Chain Reactions, Tutorial Complete → Start Level 1.
  - A step card stands beside the board with live objective progress; the dots to tap pulse.
- **End card:** the original round "Dotmination!" card with 3 stars.
  - **Level win:** Next Level.
  - **Loss:** Retry.
  - **Random map:** Retry (same map) / Next (new map).
  - **Multiplayer:** You Win! / You Lose! with Rematch for the host.
- **Menu:**
  - The level list shows Random plus every unlocked level, with its number, 3 stars and best time.
  - Bot difficulty: Normal / Harder. Start type: Blank Start / Half-Filled.
  - **HOW TO PLAY** starts the tutorial; **CHANGE COLORS** cycles the 4 original palettes.
  - STATS shows best and worst level time, like "View Stats".
- **Stats:**
  - **Chains:** moves that set off a chain reaction (2+ explosions).
  - **Longest chain:** the most explosions from one move. Both appear per match in the history.
- **Look:** the original's dark mode throughout (darkslategrey cards, Roboto Condensed, teal/pink), plus the two-dot logo on the start screen.
- **Input:** every in-world button works with the VR laser + trigger, a finger poke, and the desktop mouse (`dot-ui.js`).

## Not ported

- The start "blink" animation.
- The app's light mode. VR uses the app's dark mode, which suits a headset.
