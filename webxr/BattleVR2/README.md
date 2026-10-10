# BattleVR2 — FPS + RTS hybrid

First-person VR (Box3D) + RTSVR6-derived 1v1 sim on **Hera Planum**, with a boardable fighter/cockpit and PeerJS multiplayer.

## Modes

| Menu | Behavior |
|------|----------|
| **1v1 vs Bot** | Local host; P1 = `siege_answer` strategy bot |
| **Host / Join** | PeerJS lobbies `BattleVR2-host-{1..4}`; host-authoritative; seat drop → bot fill |

## Controls (desktop scaffold)

- Click **Start**, then use the menu (**1v1 vs Bot** / Host / Join)
- **WASD** — walk (on foot) / thrust+steer (in cockpit)
- **Mouse** — look after clicking the canvas (pointer lock). Press **Esc** before using the green **VR** button — lock captures all clicks
- **LMB** select unit; **RMB** move order; **Q / R** keyboard select/order
- **F** — board / exit fighter
- **On foot (VR):** CapVR **zero-G hover** body — **Y/B hand thrusters**, left-stick-click **look boost**, right-stick yaw (NOT walking). Mixamo body stays visible.
- **In cockpit (Battlezone):** grip **flight stick** (yaw) + **thrust lever forward = go forward** · left-stick-click boost/jump · **arms/hands stay visible** to grab controls · hover chassis with Box3D collisions
- Match start: hover-spawn on foot; fighter parked ~36m away
- **G** — hold “grip” near cockpit proxies (desktop stand-in)

## Assets (project-local)

- `assets/vehicles/space_fighter.glb` — exterior
- `assets/vehicles/spacefighter_cockpit_wasp_interdictor.glb` — cockpit
- `assets/terrain/terrain-skirmish-1v1.glb` — Hera Planum bake (from RTSVR6 / [BAR Hera Planum](https://www.beyondallreason.info/map/hera-planum))
- `assets/mesa/hera-planum/` — HQ textures

## Run

Serve the `BattleVR2` folder (any static server) and open `index.html`.

```bash
npx --yes serve -l 9120 BattleVR2
```

## Benchmarks / review (required before claiming done)

From repo root (Playwright installed at WebXR root):

```bash
node BattleVR2/scripts/review-boot.mjs
node BattleVR2/scripts/bench-sp-1v1-bot.mjs
node BattleVR2/scripts/bench-vehicle-cockpit.mjs
node BattleVR2/scripts/bench-pose-views.mjs
node BattleVR2/scripts/bench-mp-smoke.mjs
```

Reports land in `BattleVR2/bench-out/`.

## Architecture

- `js/rts/*` — ported RTSVR6 sim, terrain, bot, PeerJS network
- `js/box3d-world.js` + `vendor/box3d/*` — Box3D player/vehicle physics
- `js/vehicle.js` / `js/cockpit.js` — enter/exit + grip axes
- `js/input-fp.js` — FP locomotion + RTS rays
- `js/bot-body-box3d.js` — presence capsule for bot seats (strategy AI stays in `rts/bot.js`)

## Soft pose budgets (Phase 1)

Raw fighter+cockpit meshes are heavy (~60MB). Phase 2: Draco/UASTC + LODs. Soft caps logged in `bench-pose-views` report.
