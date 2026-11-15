# DotminationVR

Dotmination (the flatscreen/mobile chain-reaction game) rebuilt for WebXR on top of the
StacksVR stack: same lobby/networking, Mixamo body IK, VR wrist menu, mobile/desktop
spectating, stats + replays. The earlier sphere/hexasphere prototype now lives in
`../DotminationVR360`.

## How to play

Tap an empty dot or one of your own dots to grow it (stage 1–5, shown by size).
Growing a stage-5 dot makes it **burst**: all neighbours grow one stage and turn your
colour; neighbours that go past 5 burst too → chain reactions. Own every coloured dot to win.

* **VR:** point with either controller and pull the trigger, or just poke the dot with
  your controller tip. Left **X** opens the wrist menu.
* **Desktop:** click a dot. `B` = start vs bot, `M` = menu, `N` = toggle DUEL/RUSH.
* **Phone / `?spectate=1`:** Watch a lobby or Offline Preview with orbit camera.

## Modes (wrist menu toggle, host-synced)

| | DUEL (default) | RUSH |
|---|---|---|
| Field | One vertical board between the players; each sees it from their own side | Each player has an own board at a StacksVR-style station |
| Opponent | The other player (or bot), turn-based | A purple **virus** bot on your own board; you race the other player |
| Win | Opponent has no dots left (160-move safety cap: most dots) | First to clear the virus. Lose if it overruns you. 3:00 clock: higher % wins |
| Interaction | Direct | Chains of 4+ bursts **infect** the other player's board (their strongest dots flip to virus). Your own chains first cancel incoming infections — StacksVR's attack buffer/offset rules |

Board size toggle: **S** = 37 dots, **L** = 61 dots. **BOT SPEED** = bot moves/min
(DUEL: think time, RUSH: pace, 0 = frozen).

## Files

New for Dotmination:
* `dot-board.js` – rules (deterministic, seeded symmetric "Random mode" starts) + hex board view
* `dot-bot.js` – AI (2-ply duel bot, sloppier virus)
* `dot-game.js` – match component. Lifecycle, networking, avatar routing, countdown,
  victory, history and spectator code are copied from StacksVR's `stacks-game.js`
* `scripts/test-rules.mjs` – `node scripts/test-rules.mjs` (rules + AI sanity, no browser)

Copied from StacksVR (kept diff-able so fixes can be synced between the two games):
`lobby.js`, `game-menu.js`, `mixamo-body.js`, `locomotion.js`, `mobile-spectator.js`,
`match-replay.js`, `stats.js`, `attack.js`, `modes.js`, `stacks-audio.js`, `assets/`, `audio/`.
Changes there are limited to: peer ids / localStorage / IndexedDB names prefixed
`dotminationvr-` (so lobbies and saves don't collide with StacksVR on the same site),
`[stacks-game]` → `[dot-game]`, the IDLE toggle repurposed as DUEL/RUSH, seat positions
from `dot-game.seatPose()`, a few labels, an audio `ping()` and a replay hook.

`ice-servers.json` (TURN credentials) is only in the local backup copy, same as StacksVR.

## Rule note

`DotBoard.BURST_LEAVES` (top of `dot-board.js`): a burst dot stays as a stage-1 dot of
the burster (`'own'`). The 360 prototype emptied it (`'empty'`), but simulated games then
swing back and forth for 300+ moves and often never end. Switch it if the original
flatscreen rule differs.
