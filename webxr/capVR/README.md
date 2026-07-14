# CapVR — Zero-G Capture the Flag

BoltVR shell + Box3D physics (Cannon shim) + body-rigged4 combat + dual-flag CTF.

## Run

```bash
# from WebXR root
python -m http.server 8080
```

Open `http://localhost:8080/capVR/?mode=zerog` and **hard-refresh** (`Ctrl+Shift+R`).

## How to play

1. Restart match from the menu.
2. Grab the **enemy** flag (you cannot grab your own).
3. Carry it through **your** glowing goal ring.
4. Score only if **your** flag is HOME (dropped flags auto-return in 20s).
5. Shoot bots (limb shatter). Sticky player-balls stick → beep → **re-grab to yank** → boom.
6. Death drops the flag; respawn after ~4s at your base.

## Live script path (loaded)

- `capvr-cannon-shim.js` + `capvr-box3d-ext.js` — Box3D-only sim
- `capvr-ctf-rules.js` — flag ownership, score, bots seek flags
- `capvr-combat.js` — lasers, shatter, death/respawn
- `capvr-boot.js` — sticky stick/beep/yank, loco patches, checklist

Unused prototypes live in `js/_orphans/` (not loaded).

## Status

| Feature | Status |
|---------|--------|
| Dual flags + home-gate score | Working |
| No soccer ball reset on CTF score | Working |
| Flag hold (no 0.18m auto-release) | Working |
| Sticky stick / beep / yank / boom | Working |
| Player + bot death → drop → respawn | Working |
| Bot CTF seek / score push | Working |
| Box3D via shim | Working |
| PeerJS MP CTF authority | Shell only — SP-first |

Console: `[CapVR] CTF ready` then `[CapVR] Ready` with the feature list.
