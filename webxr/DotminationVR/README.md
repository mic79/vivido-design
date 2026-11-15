# DotminationVR

The flatscreen/mobile **Dotmination** (Dotmination-v1/dotmination-v3/www) rebuilt for
WebXR on the StacksVR stack: same lobby/networking, Mixamo body IK, VR wrist menu,
mobile/desktop spectating, stats + replays. The earlier sphere prototype lives in
`../DotminationVR360`.

## Faithful to the original

`dot-rules.js` and `dot-bot.js` are direct ports of the phone game's `script.js`,
`modules/botLogic.js` and `modules/realTimeResourceMode.js`:

* Same field: 9 rows, alternating 4/5 dots (40 dots), 6 touching neighbours.
* Tap an empty dot or your own: +1 stage. A dot always takes the colour of whoever grows it.
* Growing a stage-5 dot bursts it: it empties and every neighbour gets +1. Increments run
  one at a time, lowest dot first (0.1 s each, like the original). Burst dots can be refilled
  by the same chain.
* Score = sum of your dot stages. After 2 moves, whoever has no dots left loses —
  "Dotmination!".
* **Levels 1–200** use the original pi-based generator, so the maps are identical to
  the phone game. Winning unlocks the next level (saved). The bot is the original
  **Normal** bot in levels, like the original.
* **Random** maps, the **Normal** / **Harder** bots, and the multiplayer **half-filled**
  start.
* **Real-Time** mode: own dots only, 25 energy, +1 every 2 s, 0.1 s cooldown, starts
  from one stage-5 dot each.
* The look: white field, teal `#12DACE` vs pink `#E11168`, dots grow with the original
  halo rings, empty dots tinted in the current player's colour, tap ripples, floating
  "+1", rising sonar pitch per increment, sonar on game over.

## Modes (wrist menu, host-synced)

| Button | What |
|---|---|
| **DUEL** | Turn-based on one vertical board; each player sees it from their own side. Solo vs bot = Levels; lobby vs bot = Random map; PvP = half-filled start. |
| **LIVE** | Original Real-Time mode on the shared board. In multiplayer the host referees every tap. |
| **RUSH** | VR extra: own board each vs a purple "virus" (original Normal bot) on an identical Random map. First to clear their board wins (3:00 clock: higher % wins). Chains of 4+ bursts flip the opponent's strongest dots to virus. Your own chains first cancel incoming infections (StacksVR attack buffer). |

**NORM / HARD** = original bot difficulty (lobby/random games; levels always use Normal).
**BOT SPEED** = bot pace (12 = the original 1 s think time; 40 = original real-time pace).

## Controls

* **VR:** point with either controller + trigger, or poke a dot with the controller tip.
  Left **X** = wrist menu.
* **Desktop:** click a dot. `B` = start vs bot, `M` = menu, `N` = cycle DUEL/LIVE/RUSH.
* **Phone / `?spectate=1`:** Watch a lobby or Offline Preview with an orbit camera.

## VR-only choices (not in the original)

* DUEL turn clock: after 25 s your own client plays a Normal-bot move for you, so
  multiplayer can't stall.
* Long chains keep the original 0.1 s pace for 30 increments, then speed up. The longest
  chains (~150 increments) take ~6 s instead of ~15 s.
* 600-move safety cap: higher score wins (never reached in simulations).

## Files

New: `dot-rules.js` (rules/levels/maps), `dot-bot.js` (bots), `dot-board.js` (VR board
view), `dot-game.js` (match component — lifecycle/network/avatar/spectator code copied
from StacksVR's `stacks-game.js`), `scripts/test-rules.mjs` (`node scripts/test-rules.mjs`).

Copied from StacksVR, kept diff-able so fixes can be synced: `lobby.js`, `game-menu.js`,
`mixamo-body.js`, `locomotion.js`, `mobile-spectator.js`, `match-replay.js`, `stats.js`,
`attack.js`, `modes.js`, `stacks-audio.js`. Changes are limited to:
* `dotminationvr-` peer ids / storage / IndexedDB names
* `[dot-game]`
* the IDLE toggle → mode and the board-size slot → bot difficulty
* seat positions from `dot-game.seatPose()`
* labels, an audio `ping()` and a replay hook

`ice-servers.json` (TURN credentials) is only in the local backup copy, same as StacksVR.
