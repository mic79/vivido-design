/**
 * brutalistVR8 — sector streaming
 *
 * The world is procedurally INFINITE in every direction. Sectors are
 * 80×80 m and identified by integer keys "sx,sz" (any int32 pair). Only
 * the active 5×5 around the player's current cell is loaded at any
 * moment; everything else is disposed. Each sector's archetype + slab
 * layout is determined by a deterministic 32-bit hash of its key, so
 * walking away and back reproduces the same composition exactly. The
 * old `GRID_HALF` constant (=4) is kept only as the size of the HUD
 * minimap window (a 9×9 view centred on the player).
 *
 *  Coords
 *  ──────
 *   sectorKey = "sx,sz" with sx,sz being any int32 — no world boundary.
 *   sector world centre = (sx, sz) * SECTOR_SIZE.
 *   slabs are positioned in sector-local coords (sector centre = origin),
 *   then offset by the sector's world centre when added.
 *
 *  Archetypes (10 of them — see ARCHETYPES below)
 *  ─────────────────────────────────────────────
 *   brutalist_block (~70 %, the dense reference layout from the original
 *      hand-tuned brutalistLayout.js) ·
 *   open_park · tower_cluster · slab_wall · pilotis_field · monolith ·
 *   courtyard · bridge_canyon · fortress · ruins
 *
 *  Lighting / shadows
 *  ──────────────────
 *   Each slab is created with castShadow + receiveShadow = true. The
 *   directional light in main.js (intensity ~4) handles lighting and
 *   real-time shadows directly — no lightmap, no overlay quads.
 *
 *  Per-sector cost (typical archetype):
 *   - 1 ground tile + 6–14 slabs → 7–15 draw calls, ~31–81 OBBs/sector (ground + slabs)
 *   - 9 active sectors → ~70–140 draw calls, ~280–730 OBBs
 *
 *  Public API:
 *   initSectors(scene, opts?)            — boot, reads URL config
 *   updateSectorStreaming(playerPos)     — call each frame; cheap, no-op
 *                                          unless the player crossed a cell
 *   getActiveCollisionBoxes()            — flat array, scratch-safe ref
 *   getActiveSceneObjects()              — meshes for shadow setup
 *   getCurrentSectorKey()                — "sx,sz"
 *   getActiveSectorKeys()                — Array<"sx,sz">
 *   getAllSectorMetas(centerKey, radius) — Array<{key, sx, sz, archetype}>
 *                                          for the window around the player
 *                                          (one per cell in the 9×9 grid)
 *   getSectorWorldCenter(key, out?)      — Vector3 at the cell's centre
 */

import * as THREE from "three";

/* ── Grid configuration ───────────────────────────────────────────────── */

export const SECTOR_SIZE = 80;
/** Half-width of the HUD minimap display window, in sectors (NOT a world
 * boundary — the world is infinite). 4 → a 9×9 window centred on the
 * player's current cell. */
export const GRID_HALF = 4;
/** Active set is 5×5 around the player's current cell (radius 2 sectors).
 *
 * Why 5×5 and not 3×3:
 *   3×3 puts the load/unload boundary one sector width (80 m) from the
 *   player at the moment of crossing. Even with aggressive fog, the pop
 *   is visible because (a) THREE.Fog is depth-based (`-mvPosition.z`),
 *   so a sector popping in laterally has near-zero fog depth, and (b)
 *   the directional shadow cutoff at ±60 m is *inside* an 80 m fog far,
 *   so the shadow seam is only ~64 % fogged. 5×5 pushes the streaming
 *   boundary to 160 m, well outside any reasonable fog wall, letting
 *   FogExp2 fully hide it from any viewing angle.
 *
 *   Cost: 25 active sectors instead of 9 (~250 OBBs vs ~90, ~250 draw
 *   calls vs ~90). Geometry + materials are shared across all sectors
 *   so per-sector RAM is just a Group + Mesh wrappers — trivial.
 */
const ACTIVE_HALF = 2;

/** Slab footprint must stay within ±SLAB_SOFT_EXTENT of the sector centre
 * (in plan view) so neighbouring sectors don't visually fight at borders.
 * Roof/ground extents along Y are unconstrained — slabs can be tall. */
const SLAB_SOFT_EXTENT = SECTOR_SIZE * 0.45; // 36 m for an 80 m cell

const CONCRETE_LIGHT = 0xb8b1a4;
const CONCRETE_MID = 0x8d877c;
const CONCRETE_DARK = 0x6e6960;

/* ── Determinism: sector-key → seed → mulberry32 PRNG ─────────────────── */

/** Fast 32-bit integer hash of (sx,sz). Two distinct keys differ in many
 * bits even when adjacent (so adjacent sectors don't pick correlated
 * archetypes). Constants from Knuth / common practice. Math.imul is
 * required for correct int32 wrapping when sx/sz are large (the world
 * is infinite, so the player can in principle reach any int). */
function sectorSeed(sx, sz) {
  /* eslint-disable no-bitwise */
  let h = Math.imul(sx | 0, 0x9e3779b1) ^ Math.imul(sz | 0, 0x85ebca77);
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
  /* eslint-enable no-bitwise */
}

/** Mulberry32 PRNG — small, fast, decent statistical quality, perfect for
 * deterministic procedural generation. Returns [0,1). */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    /* eslint-disable no-bitwise */
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    /* eslint-enable no-bitwise */
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const randRange = (rand, lo, hi) => lerp(lo, hi, rand());
const pickWeighted = (rand, items) => {
  let total = 0;
  for (const it of items) total += it.w;
  let r = rand() * total;
  for (const it of items) {
    r -= it.w;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
};

/* ── Archetypes ───────────────────────────────────────────────────────── */

/* Each archetype is a function (rand) → Array<{p:[x,y,z], s:[w,h,d],
 * rot:[rx,ry,rz], color}>. Coordinates are sector-LOCAL (sector centre
 * = (0,0,0)). Y is up; slab `p[1]` is the slab CENTRE, so a slab of
 * height H sits on the ground when p[1] = H/2.
 *
 * Constraints every archetype must satisfy:
 *   - All slab footprints fit within ±SLAB_SOFT_EXTENT of (0,0).
 *   - All slabs sit on or above y=0 (slab centre y >= h/2).
 *   - Total slab count ≤ ~14 to keep per-sector draw calls predictable.
 */

/** Empty-ish: just a couple of low concrete benches scattered. Lots of
 * walkable space — feels like a public square. */
function archetype_open_park(rand) {
  const slabs = [];
  const n = Math.floor(randRange(rand, 0, 3));
  for (let i = 0; i < n; i++) {
    const x = randRange(rand, -SLAB_SOFT_EXTENT * 0.7, SLAB_SOFT_EXTENT * 0.7);
    const z = randRange(rand, -SLAB_SOFT_EXTENT * 0.7, SLAB_SOFT_EXTENT * 0.7);
    const w = randRange(rand, 3, 7);
    const d = randRange(rand, 1.5, 3);
    const h = randRange(rand, 0.6, 1.4);
    slabs.push({ p: [x, h / 2, z], s: [w, h, d], rot: [0, randRange(rand, 0, Math.PI), 0], color: CONCRETE_MID });
  }
  return slabs;
}

/** 3–5 tall narrow towers of varying heights, clustered. */
function archetype_tower_cluster(rand) {
  const slabs = [];
  const count = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rand() * 0.5;
    const r = randRange(rand, 4, SLAB_SOFT_EXTENT * 0.6);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const h = randRange(rand, 18, 42);
    const w = randRange(rand, 4, 9);
    const d = randRange(rand, 4, 9);
    slabs.push({
      p: [x, h / 2, z], s: [w, h, d], rot: [0, randRange(rand, 0, Math.PI / 4), 0],
      color: rand() < 0.3 ? CONCRETE_DARK : CONCRETE_MID,
    });
  }
  return slabs;
}

/** 1–3 huge horizontal slabs stacked / staggered like brutalist apartment
 * blocks. Walkable rooftops at multiple heights. */
function archetype_slab_wall(rand) {
  const slabs = [];
  const count = 1 + Math.floor(rand() * 3);
  let y = 0;
  for (let i = 0; i < count; i++) {
    const w = randRange(rand, 40, 64);
    const h = randRange(rand, 6, 14);
    const d = randRange(rand, 6, 14);
    const x = randRange(rand, -8, 8);
    const z = randRange(rand, -SLAB_SOFT_EXTENT * 0.5, SLAB_SOFT_EXTENT * 0.5);
    slabs.push({ p: [x, y + h / 2, z], s: [w, h, d], rot: [0, 0, 0], color: CONCRETE_LIGHT });
    y += h + randRange(rand, 1, 4);
  }
  /* Plus a short perpendicular fin */
  if (rand() < 0.7) {
    const fh = randRange(rand, 6, 14);
    slabs.push({
      p: [randRange(rand, -SLAB_SOFT_EXTENT * 0.5, SLAB_SOFT_EXTENT * 0.5), fh / 2,
        randRange(rand, -SLAB_SOFT_EXTENT * 0.5, SLAB_SOFT_EXTENT * 0.5)],
      s: [randRange(rand, 4, 8), fh, randRange(rand, 30, 50)],
      rot: [0, 0, 0], color: CONCRETE_DARK,
    });
  }
  return slabs;
}

/** Grid of short stubby pillars — a "pilotis field" supporting an
 * imaginary slab. No top slab (would conflict with slab_wall); pure
 * forest of columns. */
function archetype_pilotis_field(rand) {
  const slabs = [];
  const cols = 3 + Math.floor(rand() * 3);
  const rows = 3 + Math.floor(rand() * 3);
  const spacing = SLAB_SOFT_EXTENT * 1.6 / Math.max(cols, rows);
  const ox = -((cols - 1) * spacing) / 2;
  const oz = -((rows - 1) * spacing) / 2;
  const h = randRange(rand, 8, 14);
  const w = randRange(rand, 1.2, 2.6);
  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const jx = randRange(rand, -0.4, 0.4);
      const jz = randRange(rand, -0.4, 0.4);
      slabs.push({
        p: [ox + cx * spacing + jx, h / 2, oz + cz * spacing + jz],
        s: [w, h, w], rot: [0, 0, 0], color: CONCRETE_MID,
      });
    }
  }
  return slabs;
}

/** One enormous central block — pure mass. */
function archetype_monolith(rand) {
  const w = randRange(rand, 28, 44);
  const h = randRange(rand, 24, 48);
  const d = randRange(rand, 28, 44);
  const slab = {
    p: [randRange(rand, -3, 3), h / 2, randRange(rand, -3, 3)],
    s: [w, h, d], rot: [0, randRange(rand, -0.2, 0.2), 0],
    color: CONCRETE_DARK,
  };
  return [slab];
}

/** Four walls forming a hollow courtyard with one opening. */
function archetype_courtyard(rand) {
  const slabs = [];
  const inner = randRange(rand, 22, 34);
  const t = randRange(rand, 2, 4);
  const h = randRange(rand, 8, 16);
  const opening = Math.floor(rand() * 4); // which wall has the gap
  const gap = randRange(rand, 6, 10);
  for (let i = 0; i < 4; i++) {
    const isOpen = i === opening;
    if (isOpen) {
      /* Two short segments flanking the gap. */
      const segLen = (inner - gap) / 2;
      for (const sign of [-1, 1]) {
        const ofsAlong = sign * (gap / 2 + segLen / 2);
        let p, s;
        if (i === 0)      { p = [ofsAlong, h / 2, -inner / 2]; s = [segLen, h, t]; }
        else if (i === 1) { p = [ofsAlong, h / 2,  inner / 2]; s = [segLen, h, t]; }
        else if (i === 2) { p = [-inner / 2, h / 2, ofsAlong]; s = [t, h, segLen]; }
        else              { p = [ inner / 2, h / 2, ofsAlong]; s = [t, h, segLen]; }
        slabs.push({ p, s, rot: [0, 0, 0], color: CONCRETE_LIGHT });
      }
    } else {
      let p, s;
      if (i === 0)      { p = [0, h / 2, -inner / 2]; s = [inner + t, h, t]; }
      else if (i === 1) { p = [0, h / 2,  inner / 2]; s = [inner + t, h, t]; }
      else if (i === 2) { p = [-inner / 2, h / 2, 0]; s = [t, h, inner + t]; }
      else              { p = [ inner / 2, h / 2, 0]; s = [t, h, inner + t]; }
      slabs.push({ p, s, rot: [0, 0, 0], color: CONCRETE_LIGHT });
    }
  }
  return slabs;
}

/** Two tall walls + a horizontal bridge spanning between them. */
function archetype_bridge_canyon(rand) {
  const slabs = [];
  const span = randRange(rand, 32, 48);
  const wallH = randRange(rand, 24, 38);
  const wallD = randRange(rand, 6, 12);
  const t = randRange(rand, 3, 5);
  for (const sign of [-1, 1]) {
    slabs.push({
      p: [sign * (span / 2), wallH / 2, 0],
      s: [t, wallH, wallD], rot: [0, 0, 0],
      color: CONCRETE_MID,
    });
  }
  /* Bridge at ~70% height, slightly off-centre. */
  const bridgeY = wallH * randRange(rand, 0.55, 0.85);
  const bridgeH = randRange(rand, 2, 4);
  slabs.push({
    p: [0, bridgeY, randRange(rand, -2, 2)],
    s: [span, bridgeH, randRange(rand, 6, 10)],
    rot: [0, 0, 0], color: CONCRETE_DARK,
  });
  /* Optional second bridge lower down */
  if (rand() < 0.5) {
    const lowY = randRange(rand, 8, 16);
    slabs.push({
      p: [0, lowY, randRange(rand, -3, 3)],
      s: [span, randRange(rand, 1.5, 2.5), randRange(rand, 5, 8)],
      rot: [0, 0, 0], color: CONCRETE_DARK,
    });
  }
  return slabs;
}

/** Central core surrounded by 4 outer walls, with bridges. The
 * "fortress" — most slab-dense archetype. */
function archetype_fortress(rand) {
  const slabs = [];
  /* Core */
  const ch = randRange(rand, 16, 26);
  const cw = randRange(rand, 12, 20);
  slabs.push({ p: [0, ch / 2, 0], s: [cw, ch, cw], rot: [0, 0, 0], color: CONCRETE_DARK });
  /* Outer ring of low walls */
  const outer = randRange(rand, 24, 32);
  const oh = randRange(rand, 6, 10);
  const t = randRange(rand, 2, 4);
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const x = Math.cos(angle) * outer;
    const z = Math.sin(angle) * outer;
    const len = randRange(rand, 14, 22);
    slabs.push({
      p: [x, oh / 2, z],
      /* Long axis perpendicular to the radial direction, achieved with
       * Y rotation = angle. */
      s: [len, oh, t], rot: [0, -angle, 0], color: CONCRETE_LIGHT,
    });
  }
  /* Two diagonal bridges connecting core to outer walls */
  for (const dir of [0, 2]) {
    const angle = (dir / 4) * Math.PI * 2;
    slabs.push({
      p: [Math.cos(angle) * outer / 2, ch * 0.7, Math.sin(angle) * outer / 2],
      s: [outer, randRange(rand, 1.5, 2.5), randRange(rand, 3, 5)],
      rot: [0, -angle, 0], color: CONCRETE_MID,
    });
  }
  return slabs;
}

/** Reference archetype — derived from the original hand-tuned
 * `brutalistLayout.js` from brutalistVR5–7. That layout had:
 *   - a tall central core (28×52×28),
 *   - two enormous perimeter walls (120×36×8 north, 100×28×10 south),
 *   - two long flanking towers (10×44×70 east, 12×32×65 west),
 *   - a podium (70×6×40), bridge (48×4×14), cantilever (36×3×18 tilted),
 *   - and 5 vertical fins.
 * That's ~14 slabs in roughly 120×100 m, which doesn't fit a single
 * 80 m sector. So everything is scaled to roughly 60% to fit within
 * ±SLAB_SOFT_EXTENT (36 m), while keeping the same proportions and
 * the same dense, layered, monumental feel. Each call randomises sizes
 * and which optional pieces (cantilever, fins, podium, bridge) appear
 * so adjacent brutalist sectors don't look identical. */
function archetype_brutalist_block(rand) {
  const slabs = [];

  /* Central core — tall vertical mass, the visual anchor. Mirrors the
   * original 28×52×28 core, scaled to 16-22 wide, 30-46 tall. */
  const cw = randRange(rand, 16, 22);
  const ch = randRange(rand, 30, 46);
  const cd = randRange(rand, 16, 22);
  slabs.push({
    p: [randRange(rand, -3, 3), ch / 2, randRange(rand, -3, 3)],
    s: [cw, ch, cd],
    rot: [0, randRange(rand, -0.15, 0.15), 0],
    color: CONCRETE_MID,
  });

  /* Two big perpendicular perimeter walls (north + south of original).
   * Length 50-66, height 18-28, thickness 5-8. Pushed to opposite
   * extremes of the sector. */
  const wallH = randRange(rand, 18, 28);
  const wallT = randRange(rand, 5, 8);
  const wallLen = randRange(rand, 50, 66);
  const wallOffs = randRange(rand, 24, 32);
  /* Random which axis the long walls run along — gives variety. */
  if (rand() < 0.5) {
    slabs.push({
      p: [randRange(rand, -4, 4), wallH / 2, -wallOffs],
      s: [wallLen, wallH, wallT], rot: [0, 0, 0], color: CONCRETE_LIGHT,
    });
    slabs.push({
      p: [randRange(rand, -4, 4), wallH / 2, wallOffs],
      s: [wallLen * randRange(rand, 0.7, 1.0), wallH * randRange(rand, 0.75, 1.0),
        wallT], rot: [0, 0, 0], color: CONCRETE_LIGHT,
    });
  } else {
    slabs.push({
      p: [-wallOffs, wallH / 2, randRange(rand, -4, 4)],
      s: [wallT, wallH, wallLen], rot: [0, 0, 0], color: CONCRETE_LIGHT,
    });
    slabs.push({
      p: [wallOffs, wallH / 2, randRange(rand, -4, 4)],
      s: [wallT, wallH * randRange(rand, 0.75, 1.0),
        wallLen * randRange(rand, 0.7, 1.0)], rot: [0, 0, 0], color: CONCRETE_LIGHT,
    });
  }

  /* Two flanking tower slabs perpendicular to the walls (east/west of
   * original). Tall and narrow. */
  const towerH = randRange(rand, 22, 36);
  const towerT = randRange(rand, 5, 9);
  const towerLen = randRange(rand, 28, 44);
  const towerOff = randRange(rand, 26, 32);
  /* Place perpendicular to the wall axis above. */
  if (slabs[1].s[0] > slabs[1].s[2]) {
    /* Walls run along X → towers run along Z. */
    slabs.push({
      p: [-towerOff, towerH / 2, randRange(rand, -3, 3)],
      s: [towerT, towerH, towerLen], rot: [0, 0, 0], color: CONCRETE_DARK,
    });
    slabs.push({
      p: [towerOff, towerH / 2, randRange(rand, -3, 3)],
      s: [towerT, towerH * randRange(rand, 0.75, 1.0), towerLen * randRange(rand, 0.7, 1.0)],
      rot: [0, 0, 0], color: CONCRETE_DARK,
    });
  } else {
    slabs.push({
      p: [randRange(rand, -3, 3), towerH / 2, -towerOff],
      s: [towerLen, towerH, towerT], rot: [0, 0, 0], color: CONCRETE_DARK,
    });
    slabs.push({
      p: [randRange(rand, -3, 3), towerH / 2, towerOff],
      s: [towerLen * randRange(rand, 0.7, 1.0), towerH * randRange(rand, 0.75, 1.0), towerT],
      rot: [0, 0, 0], color: CONCRETE_DARK,
    });
  }

  /* Podium — low broad slab off-centre (original was 70×6×40). */
  if (rand() < 0.85) {
    const pw = randRange(rand, 26, 38);
    const pd = randRange(rand, 14, 22);
    const ph = randRange(rand, 3, 6);
    slabs.push({
      p: [randRange(rand, -10, 10), ph / 2, randRange(rand, -10, 10)],
      s: [pw, ph, pd], rot: [0, randRange(rand, 0, Math.PI / 4), 0],
      color: CONCRETE_MID,
    });
  }

  /* Bridge — horizontal slab at mid-height (original 48×4×14). */
  if (rand() < 0.6) {
    const by = randRange(rand, ch * 0.4, ch * 0.7);
    const blen = randRange(rand, 22, 32);
    const bw = randRange(rand, 6, 10);
    slabs.push({
      p: [randRange(rand, -8, 8), by, randRange(rand, -6, 6)],
      s: [blen, randRange(rand, 2.5, 4), bw],
      rot: [0, randRange(rand, 0, Math.PI), 0], color: CONCRETE_DARK,
    });
  }

  /* Cantilever — tilted slab cantilevering out (original 36×3×18 with
   * Euler rotation 0.35, 0.12, -0.25). */
  if (rand() < 0.5) {
    const cantH = randRange(rand, 18, 26);
    slabs.push({
      p: [randRange(rand, -8, 8), cantH, randRange(rand, -8, 8)],
      s: [randRange(rand, 14, 22), randRange(rand, 2, 3), randRange(rand, 8, 14)],
      rot: [randRange(rand, 0.15, 0.4), randRange(rand, 0, Math.PI),
        randRange(rand, -0.3, 0.3)], color: CONCRETE_LIGHT,
    });
  }

  /* Vertical fins — original had 5 thin vertical fins (1.2×24×6) lined up. */
  if (rand() < 0.7) {
    const finCount = 3 + Math.floor(rand() * 3);
    const finH = randRange(rand, 12, 18);
    const finT = randRange(rand, 0.9, 1.5);
    const finD = randRange(rand, 4, 6);
    /* Pick a side-edge to plant the fins along. */
    const side = Math.floor(rand() * 4);
    const sideR = SLAB_SOFT_EXTENT * randRange(rand, 0.6, 0.85);
    for (let i = 0; i < finCount; i++) {
      const t = (i - (finCount - 1) / 2) * randRange(rand, 4, 6);
      let p;
      if (side === 0) p = [t, finH / 2, -sideR];
      else if (side === 1) p = [t, finH / 2,  sideR];
      else if (side === 2) p = [-sideR, finH / 2, t];
      else                 p = [ sideR, finH / 2, t];
      slabs.push({
        p, s: [finT, finH, finD], rot: [0, 0, 0], color: CONCRETE_DARK,
      });
    }
  }

  return slabs;
}

/** Tilted, broken slabs scattered. */
function archetype_ruins(rand) {
  const slabs = [];
  const count = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const x = randRange(rand, -SLAB_SOFT_EXTENT * 0.7, SLAB_SOFT_EXTENT * 0.7);
    const z = randRange(rand, -SLAB_SOFT_EXTENT * 0.7, SLAB_SOFT_EXTENT * 0.7);
    const w = randRange(rand, 4, 14);
    const h = randRange(rand, 4, 18);
    const d = randRange(rand, 2, 6);
    const tilt = randRange(rand, -0.4, 0.4);
    slabs.push({
      p: [x, h / 2 - 0.5, z], s: [w, h, d],
      rot: [tilt, randRange(rand, 0, Math.PI), randRange(rand, -0.4, 0.4)],
      color: rand() < 0.4 ? CONCRETE_DARK : CONCRETE_MID,
    });
  }
  return slabs;
}

/** Weights chosen so `brutalist_block` is ~70 % of all sectors:
 *   sum(others) = 1.8+1.0+1.0+0.9+0.7+0.9+0.8+0.6+0.9 = 8.6
 *   brutalist_block w=20 →  20 / (20+8.6) ≈ 69.9 %.
 * Tunable via `?brutalistweight=` (integer; default 20). */
const _brutalistWeight = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get("brutalistweight");
    if (v) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch (_) { /* noop */ }
  return 20;
})();

const ARCHETYPES = [
  { name: "brutalist_block", build: archetype_brutalist_block, w: _brutalistWeight },
  { name: "open_park", build: archetype_open_park,      w: 1.8 },
  { name: "tower_cluster", build: archetype_tower_cluster, w: 1.0 },
  { name: "slab_wall", build: archetype_slab_wall,      w: 1.0 },
  { name: "pilotis_field", build: archetype_pilotis_field, w: 0.9 },
  { name: "monolith", build: archetype_monolith,        w: 0.7 },
  { name: "courtyard", build: archetype_courtyard,      w: 0.9 },
  { name: "bridge_canyon", build: archetype_bridge_canyon, w: 0.8 },
  { name: "fortress", build: archetype_fortress,        w: 0.6 },
  { name: "ruins", build: archetype_ruins,              w: 0.9 },
];

/* ── Sector model ─────────────────────────────────────────────────────── */

/**
 * @typedef {{
 *   key: string,
 *   sx: number, sz: number,
 *   archetype: string,
 *   group: THREE.Group,
 *   meshes: THREE.Mesh[],
 *   collisionBoxes: Array<{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number,m:THREE.Matrix3,mInv:THREE.Matrix3}>,
 * }} Sector
 */

/** Build the procedural slab list for a sector, deterministic from key. */
function buildSlabsForSector(sx, sz) {
  const seed = sectorSeed(sx, sz);
  const rand = mulberry32(seed);
  /* Pick archetype with weighted random — but seed (0,0) special-cases
   * to "open_park" so the player always spawns in a clear area. */
  let archetypeName;
  let slabs;
  if (sx === 0 && sz === 0) {
    archetypeName = "open_park";
    slabs = archetype_open_park(rand);
  } else {
    const pick = pickWeighted(rand, ARCHETYPES.map((a) => ({ w: a.w, ref: a })));
    archetypeName = pick.ref.name;
    slabs = pick.ref.build(rand);
  }
  return { archetypeName, slabs };
}

/* ── HQ (anti-air anchor) detection ──────────────────────────────────────
 * Returns the rooftop of each sector's LARGEST building — its "HQ" —
 * for placing an AntiAirTurret. Used by bots.js when sectors stream in.
 *
 * The previous implementation looked for narrow towers only (max
 * footprint 14 m, height ≥ 22 m), which excluded essentially every
 * slab in `brutalist_block` (the dominant 70%-weight archetype): its
 * core is 16-22 m wide and its flanking towers are 28-44 m long. The
 * result was that the player almost never saw an AA emplacement.
 *
 * The new criterion is "is this slab a meaningful BUILDING"?
 *   - upright (|rotX|, |rotZ| ≤ HQ_TILT_TOLERANCE) — must be flat-topped
 *     so the turret can stand on it cleanly.
 *   - rooftop ≥ HQ_MIN_TOP_Y — excludes podiums, benches, and the tiny
 *     ornaments in `open_park`.
 *   - smallest footprint dimension ≥ HQ_MIN_MIN_FOOTPRINT — excludes
 *     fins (1.2 m thick) and decorative beams.
 *   - no maximum-footprint cap. The biggest slab IS the HQ.
 *
 * Among qualifying slabs we pick by VOLUME × HEIGHT-BIAS, so a tall
 * core wins over a long low podium of equivalent volume. Returns at
 * most one anchor per sector to keep AA density manageable across
 * the 5×5 active window. The anchor includes the slab's footprint
 * dimensions so callers can size the emplacement to fit the rooftop. */
const HQ_TILT_TOLERANCE = 0.10;
const HQ_MIN_TOP_Y = 8;
const HQ_MIN_MIN_FOOTPRINT = 4;

function _slabIsHQCandidate(s) {
  const [w, h, d] = s.s;
  const [rx, , rz] = s.rot;
  if (Math.abs(rx) > HQ_TILT_TOLERANCE) return false;
  if (Math.abs(rz) > HQ_TILT_TOLERANCE) return false;
  const top = s.p[1] + h / 2;
  if (top < HQ_MIN_TOP_Y) return false;
  if (Math.min(w, d) < HQ_MIN_MIN_FOOTPRINT) return false;
  return true;
}

/** HQ anchor for a sector, in world coordinates. Returns either an
 *  empty array (no HQ — sector is open_park, ruins, or pure pilotis-
 *  field) or a single anchor `{ x, y, z, yaw, w, d, sx, sz, key }`
 *  on the rooftop of the largest building. The function is named
 *  `getSectorTowerAnchors` for backward compatibility with the
 *  existing bots.js import; semantically it now returns HQ anchors. */
export function getSectorTowerAnchors(key) {
  const [sx, sz] = key.split(",").map(Number);
  const wx = sx * SECTOR_SIZE;
  const wz = sz * SECTOR_SIZE;
  const { slabs } = buildSlabsForSector(sx, sz);
  let best = null;
  let bestScore = -Infinity;
  for (const s of slabs) {
    if (!_slabIsHQCandidate(s)) continue;
    const [w, h, d] = s.s;
    /* Volume × sqrt(height) — favours mass first, then verticality.
     * Without the height bias a wide low podium would beat a tall
     * skinny core of equivalent volume; we want the visually
     * imposing one to be the HQ. */
    const score = w * h * d * Math.sqrt(h);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (!best) return [];
  return [{
    x: wx + best.p[0],
    y: best.p[1] + best.s[1] / 2,
    z: wz + best.p[2],
    /* Y rotation comes from the slab so the launcher can align with
     * the building's long axis rather than always face world-north. */
    yaw: best.rot[1] || 0,
    w: best.s[0],
    d: best.s[2],
    sx, sz, key,
  }];
}

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
function buildOBBFromSlab(slabSpec, sectorWorldX, sectorWorldZ) {
  const [px, py, pz] = slabSpec.p;
  const [w, h, d] = slabSpec.s;
  const [rx, ry, rz] = slabSpec.rot;
  _euler.set(rx, ry, rz, "XYZ");
  _quat.setFromEuler(_euler);
  _m4.makeRotationFromQuaternion(_quat);
  const m = new THREE.Matrix3().setFromMatrix4(_m4);
  const mInv = m.clone().transpose();
  return {
    cx: px + sectorWorldX,
    cy: py,
    cz: pz + sectorWorldZ,
    hx: w / 2, hy: h / 2, hz: d / 2,
    m, mInv,
  };
}

/** Thin axis-aligned OBB for the 80×80 ground plane (same footprint as
 *  `getGroundGeometry()`). Slabs already had collision; the *visual*
 *  floor tile did not — arrows raycast only `collisionBoxes`, so shots
 *  fell through until some unrelated slab far below won the ray, which
 *  mis-placed explosive VFX/AOE. This matches the ground mesh: group at
 *  (wx,0,wz), child at y=0.001, plane spans ±SECTOR_SIZE/2 in XZ. */
const GROUND_COLLISION_HALF_THICK = 0.06;
const GROUND_COLLISION_CY = 0.001 + GROUND_COLLISION_HALF_THICK * 0.35;

function buildGroundCollisionOBB(sectorWorldX, sectorWorldZ) {
  const m = new THREE.Matrix3().identity();
  const mInv = new THREE.Matrix3().identity();
  const half = SECTOR_SIZE / 2;
  return {
    cx: sectorWorldX,
    cy: GROUND_COLLISION_CY,
    cz: sectorWorldZ,
    hx: half,
    hy: GROUND_COLLISION_HALF_THICK,
    hz: half,
    m,
    mInv,
  };
}

/* ── PBR texture sets + four-layer anti-repetition pipeline ─────────────
 *
 * Two texture sets, both Polyhaven 2K JPGs with packed ARM channels:
 *
 *   • SLAB    (concrete_layers_02_*)        → slabs (walls + columns)
 *   • GROUND  (hangar_concrete_floor_*)     → ground tiles
 *
 * Each set is three JPGs:
 *   • diff   — sRGB albedo
 *   • nor_gl — OpenGL-convention tangent-space normal
 *   • arm    — packed R=AO, G=Roughness, B=Metalness (Polyhaven layout)
 *
 * Three.js samples ARM channels automatically when the same texture is
 * bound to multiple PBR slots (.r → aoMap, .g → roughnessMap, .b →
 * metalnessMap), so a single binding feeds all three slots. With aoMap
 * on r151+ Three.js the renderer falls back to the `uv` attribute when
 * no `uv1` exists — we don't need a second UV set.
 *
 * Loading is lazy + asynchronous: first material request triggers a
 * fetch of all three JPGs; materials render flat-tinted until they
 * decode (~<1 s on a LAN), then Three.js auto-rebinds. No await/promise
 * plumbing required.
 *
 * Anti-repetition strategy — FOUR layers stacked, each fixing a
 * different category of repetition:
 *
 *   1. Stochastic / hex-cell sampling (the heavy hitter)
 *      Implemented in the fragment shader via _attachAntiRepShader().
 *      Replaces every PBR map's `texture2D(map, uv)` with a 4-tap
 *      jittered sample: 4 corner offsets hashed by their integer cell
 *      index, then bilinearly blended by the cell-local position. This
 *      kills the periodic tile pattern *within a single surface* —
 *      adjacent jitter cells (1 tile = 3 m on a side) get different
 *      offsets, so the eye can't lock onto a 3 m grid. Cost: ~3-4×
 *      texture-fetch traffic, well within Quest 3 budget thanks to GPU
 *      texture cache (adjacent pixels read overlapping memory ranges).
 *
 *   2. Per-slab UV jitter (geometry layer)
 *      Each slab picks one of 16 cache variants — 4 UV rotations × 4
 *      sub-tile offsets — hashed by sector + slab index. Adjacent
 *      slabs of identical dimensions therefore have *different* UV
 *      orientations, so even after stochastic sampling the player
 *      can't memorise a slab's exact texture orientation.
 *
 *   3. Per-slab tint jitter (material layer)
 *      Each base tint (LIGHT / MID / DARK) spawns 8 brightness
 *      variants (±10 %). Two slabs sharing a base colour but living
 *      at different positions read as different weathering grades.
 *      Total slab materials: 3 × 8 = 24 — texture bindings still
 *      shared, only the program cache key differs.
 *
 *   4. Macro low-frequency shader tint
 *      A 30 m-period 2D value-noise field on world XZ multiplies the
 *      diffuse channel by ±15 %. Adds organic large-scale brightness
 *      variation that hides any residual tile period under a slow
 *      gradient. Cost: a handful of ALU ops, zero extra texture taps.
 *
 * Surface depth: normalScale boosted to (2, 2) on the slab material —
 * brutalist concrete needs the bumps to *carve* into the lighting,
 * not whisper. Anything subtler reads as "smooth wall with grime".
 */
const TEXTURE_TILE_M = 3.0; // world metres per texture repeat. Larger than
// the 2 m default because a 2 m period on a 30 m wall is 15 visible
// repeats; 3 m drops that to 10 and combined with stochastic sampling
// the surface feels more monumental and less "tiled".
let _maxAnisotropy = 4;

const _slabSet = { diff: null, normal: null, arm: null, requested: false };
const _groundSet = { diff: null, normal: null, arm: null, requested: false };

/** Configure shared properties for an image-based PBR texture. Sets
 *  repeat wrap, sRGB colour space if requested, and max anisotropy.
 *  Image-based textures auto-mipmap on first GPU upload, so we don't
 *  need to flip generateMipmaps explicitly here. */
function _configurePbrTexture(tex, isSrgb) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = _maxAnisotropy;
  if (isSrgb) tex.colorSpace = THREE.SRGBColorSpace;
}

function ensureSlabTextures() {
  if (_slabSet.requested) return;
  _slabSet.requested = true;
  const tl = new THREE.TextureLoader();
  _slabSet.diff = tl.load("textures/concrete_layers_02_diff_1k.jpg");
  _configurePbrTexture(_slabSet.diff, true);
  _slabSet.normal = tl.load("textures/concrete_layers_02_nor_gl_1k.jpg");
  _configurePbrTexture(_slabSet.normal, false);
  _slabSet.arm = tl.load("textures/concrete_layers_02_arm_1k.jpg");
  _configurePbrTexture(_slabSet.arm, false);
}

function ensureGroundTextures() {
  if (_groundSet.requested) return;
  _groundSet.requested = true;
  const tl = new THREE.TextureLoader();
  _groundSet.diff = tl.load("textures/hangar_concrete_floor_diff_1k.jpg");
  _configurePbrTexture(_groundSet.diff, true);
  _groundSet.normal = tl.load("textures/hangar_concrete_floor_nor_gl_1k.jpg");
  _configurePbrTexture(_groundSet.normal, false);
  _groundSet.arm = tl.load("textures/hangar_concrete_floor_arm_1k.jpg");
  _configurePbrTexture(_groundSet.arm, false);
}

/** Module-level uniform for runtime anti-repetition toggle. Shared
 *  across all materials patched by _attachAntiRepShader so flipping
 *  the value affects everything in one shot. The branch on this
 *  uniform inside the fragment shader is *uniform-controlled*: every
 *  pixel takes the same path, so there's no warp divergence and the
 *  unused branch's texture samples are skipped — flipping it OFF
 *  delivers most of the perf savings of compiling without stochastic
 *  sampling, with the convenience of an instant runtime toggle. */
const _antiRepUniforms = {
  uStochEnabled: { value: 1.0 },
};

export function setAntiRepetition(enabled) {
  _antiRepUniforms.uStochEnabled.value = enabled ? 1.0 : 0.0;
}

export function getAntiRepetition() {
  return _antiRepUniforms.uStochEnabled.value > 0.5;
}

/* ── Textures-on/off master switch ─────────────────────────────────────
 *
 * Master toggle that nulls every texture slot (map / normalMap / aoMap /
 * roughnessMap / metalnessMap) on every slab + ground material we own,
 * then forces a Three.js shader recompile so the stripped-down material
 * uses zero texture samples. Useful as a perf diagnostic ("how much of
 * the frame is the texture pipeline?") and as a fast-mode option for
 * low-end hardware.
 *
 * What stays visible when textures are off:
 *   • Per-slab tint multiplier (3 base colours × 8 brightness levels)
 *   • Macro low-frequency brightness wave from the shader patch
 *     (still runs because it's outside the `#ifdef USE_MAP` block)
 *   • Per-slab UV jitter and per-archetype geometry — fully unaffected
 *
 * What disappears:
 *   • Diffuse pattern, surface normals, roughness, metalness, AO
 *   • The stochastic anti-repetition shader becomes irrelevant
 *     (no textures to sample), so its perf cost goes to zero.
 *
 * Implementation: each material's texture refs are stashed in a
 * WeakMap on first toggle so we can restore them later. Toggling
 * back to ON re-binds the original refs — texture data isn't reloaded
 * (the GPU upload persists), so flipping is instant either way.
 */
let _texturesEnabled = true;
const _materialTextureBackup = new WeakMap();

function _stripOrRestoreMaterialTextures(m) {
  /* On first call for a given material, snapshot its texture refs. */
  if (!_materialTextureBackup.has(m)) {
    _materialTextureBackup.set(m, {
      map: m.map,
      normalMap: m.normalMap,
      aoMap: m.aoMap,
      roughnessMap: m.roughnessMap,
      metalnessMap: m.metalnessMap,
    });
  }
  const orig = _materialTextureBackup.get(m);
  if (_texturesEnabled) {
    m.map = orig.map;
    m.normalMap = orig.normalMap;
    m.aoMap = orig.aoMap;
    m.roughnessMap = orig.roughnessMap;
    m.metalnessMap = orig.metalnessMap;
  } else {
    m.map = null;
    m.normalMap = null;
    m.aoMap = null;
    m.roughnessMap = null;
    m.metalnessMap = null;
  }
  /* Force a shader recompile so the USE_MAP / USE_NORMALMAP / etc.
   * defines reflect the new state. Three.js will re-trigger our
   * onBeforeCompile patch on the next render — the patch itself is
   * robust to texture-less compilation (all texture-using code is
   * inside `#ifdef USE_*` blocks; the macro tint is outside and
   * still runs). */
  m.needsUpdate = true;
}

export function setTextures(enabled) {
  const want = !!enabled;
  if (_texturesEnabled === want) return;
  _texturesEnabled = want;
  for (const m of _materialCache.values()) _stripOrRestoreMaterialTextures(m);
  if (_groundMaterial) _stripOrRestoreMaterialTextures(_groundMaterial);
}

export function getTextures() {
  return _texturesEnabled;
}

/** Inject the anti-repetition fragment-shader pipeline into any
 *  MeshStandardMaterial:
 *
 *   1. Stochastic 4-tap sampling on the DIFFUSE map only. Each
 *      `texture2D(map, vMapUv)` for the diffuse channel is replaced by
 *      a 2D-hash-jittered 4-corner blend, eliminating any visible 3 m
 *      tile period in the colour pattern across a single surface.
 *      Wrapped in a uniform branch (`uStochEnabled`) so it can be
 *      turned off at runtime without recompiling.
 *
 *      Why diffuse-only: the eye locks onto repeating *colour
 *      patterns* far more than repeating bump direction or roughness
 *      values. A periodic roughness map is essentially invisible
 *      because the lighting integral averages it out; a periodic
 *      normal map is barely noticeable on noisy concrete. So
 *      stochastic-sampling normal/AO/roughness/metalness paid for
 *      visual differences the player can't actually see while
 *      tripling the texture-fetch cost. v1 of this patch did
 *      stochastic on every slot (12 taps/pixel); v2 limits it to
 *      diffuse (4 taps + 1 normal + 1 ARM = 6 taps/pixel).
 *
 *   2. Macro-tint multiplier on the diffuse channel — slow value-noise
 *      on world XZ at 30 m period gives ±15 % brightness variation,
 *      hiding any residual repetition under an organic gradient.
 *      Always on; cost is a few ALU ops, no extra texture samples.
 *
 *   3. ARM dedup: aoMap, roughnessMap, metalnessMap all bind to the
 *      same texture in our setup, but Three.js exposes them as
 *      distinct sampler uniforms which the GLSL compiler can't
 *      deduplicate. We sample ARM once (in the roughness chunk) and
 *      reuse the vec4 across all three. Saves 2 taps per pixel
 *      regardless of stochastic on/off.
 *
 *  All Three.js standard chunks for textured PBR slots are replaced
 *  in-place — see the chunk-by-chunk source below for r169. The patch
 *  source is identical for every material it's attached to, so they
 *  share one compiled shader program.
 *
 *  Cost summary (per slab pixel, post-dedup):
 *    Anti-rep ON  → 4 (diff stoch) + 1 (normal) + 1 (ARM) = 6 taps
 *    Anti-rep OFF → 1 (diff)       + 1 (normal) + 1 (ARM) = 3 taps
 *  vs the v1 numbers (12 ON / 3 OFF), v2 cuts the ON cost in half. */
function _attachAntiRepShader(material) {
  material.onBeforeCompile = (shader) => {
    /* Hook up the shared uniform. Multiple materials referencing the
     * same uniform object share its `value`, so a single setter call
     * updates every material in the scene at once. */
    shader.uniforms.uStochEnabled = _antiRepUniforms.uStochEnabled;
    shader.vertexShader = shader.vertexShader
      .replace(
        `#include <common>`,
        `#include <common>\nvarying vec3 vMacroWorldPos;`,
      )
      .replace(
        `#include <begin_vertex>`,
        `#include <begin_vertex>\nvMacroWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );

    /* Helpers prepended to the fragment shader. Defined once at the
     * top so every chunk replacement below can call them. */
    const FRAG_HELPERS = `
varying vec3 vMacroWorldPos;
const float MACRO_PERIOD_M = 30.0;
const float MACRO_AMOUNT   = 0.15;

/* Wide-spectrum 2D hash → vec2 in [-1, 1]. Used both as a value-noise
 * scalar (just take .x) and as a 2D UV jitter offset for stochastic
 * sampling. The dot products with irrational-ish constants give good
 * decorrelation between adjacent integer cells so the jitter looks
 * random across a wall instead of striped. */
vec2 _hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return -1.0 + 2.0 * fract((p3.xx + p3.yz) * p3.zy);
}

/* Smooth value-noise on world XZ — used for the macro tint. */
float _macroNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float h00 = _hash22(i).x;
  float h10 = _hash22(i + vec2(1.0, 0.0)).x;
  float h01 = _hash22(i + vec2(0.0, 1.0)).x;
  float h11 = _hash22(i + vec2(1.0, 1.0)).x;
  return 0.5 + 0.5 * mix(mix(h00, h10, u.x), mix(h01, h11, u.x), u.y);
}

/* 4-tap stochastic sample. Splits the UV space into a unit grid;
 * each cell hashes to a unique offset in the texture; the four
 * neighbouring cells' samples are bilinearly blended by the
 * cell-local position so neighbouring cells overlap smoothly without
 * a visible seam. The smoothstep narrows the blend region from a
 * full bilinear gradient to the central half of the cell, which keeps
 * each region looking sharp (most of a cell shows ~one offset's
 * texture) while the seams are soft enough to disappear. */
vec4 _stochSample(sampler2D tex, vec2 uv) {
  vec2 iuv = floor(uv);
  vec2 fuv = fract(uv);
  vec4 c00 = texture2D(tex, uv + _hash22(iuv + vec2(0.0, 0.0)));
  vec4 c10 = texture2D(tex, uv + _hash22(iuv + vec2(1.0, 0.0)));
  vec4 c01 = texture2D(tex, uv + _hash22(iuv + vec2(0.0, 1.0)));
  vec4 c11 = texture2D(tex, uv + _hash22(iuv + vec2(1.0, 1.0)));
  vec2 b = smoothstep(0.25, 0.75, fuv);
  return mix(mix(c00, c10, b.x), mix(c01, c11, b.x), b.y);
}

/* Toggle gate: dispatches to stochastic or single-tap based on the
 * uniform. The branch is uniform across all pixels in a draw, so warps
 * stay coherent and the unused branch's texture samples are skipped. */
uniform float uStochEnabled;
vec4 _maybeStoch(sampler2D tex, vec2 uv) {
  if (uStochEnabled > 0.5) return _stochSample(tex, uv);
  return texture2D(tex, uv);
}
`;

    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <common>`,
      `#include <common>\n${FRAG_HELPERS}`,
    );

    /* === Diffuse map (+ macro tint) ====================================
     * Replaces the standard map_fragment chunk:
     *   #ifdef USE_MAP
     *     vec4 sampledDiffuseColor = texture2D(map, vMapUv);
     *     diffuseColor *= sampledDiffuseColor;
     *   #endif
     * Stochastic sample, then multiply the diffuse channel by the
     * macro tint so the whole PBR pipeline sees the modulation. */
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <map_fragment>`,
      `#ifdef USE_MAP
  vec4 sampledDiffuseColor = _maybeStoch(map, vMapUv);
  diffuseColor *= sampledDiffuseColor;
#endif
{
  float _n = _macroNoise(vMacroWorldPos.xz / MACRO_PERIOD_M);
  diffuseColor.rgb *= (1.0 - MACRO_AMOUNT) + 2.0 * MACRO_AMOUNT * _n;
}`,
    );

    /* === Normal map ====================================================
     * Single-tap (vanilla) — see header comment for why stochastic-
     * sampling normals isn't worth the cost. Effectively this chunk
     * matches the standard r169 normal_fragment_maps; we still replace
     * it (rather than leaving it as #include) so the patched shader
     * has consistent provenance and a future maintainer doesn't have
     * to hunt through Three.js internals to understand the path. */
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <normal_fragment_maps>`,
      `#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = -normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize(normalMatrix * normal);
#elif defined(USE_NORMALMAP_TANGENTSPACE)
  vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize(tbn * mapN);
#elif defined(USE_BUMPMAP)
  normal = perturbNormalArb(vViewPosition, normal, dHdxy_fwd(), faceDirection);
#endif`,
    );

    /* === ARM (AO + Roughness + Metalness) shared sample ================
     *
     * KEY OPTIMIZATION: getConcreteMaterial() and getGroundMaterial()
     * bind the *same* ARM texture to all three PBR slots — but Three.js
     * exposes each as a distinct sampler uniform (`aoMap`, `roughnessMap`,
     * `metalnessMap`), and the GLSL compiler can't deduplicate
     * `texture2D` calls across different samplers even when they alias
     * the same texture object. So a naive port of the chunks samples
     * ARM three times per pixel — 12 taps with stochastic, vs the 4
     * taps that are actually meaningful.
     *
     * Sample ARM ONCE here (in the roughness chunk, which runs first of
     * the three) and stash the vec4 in `_armSampled`. Reuse those
     * channels in the metalness and AO chunks below — net cost drops
     * from 12 ARM taps to 4 (stochastic) or 3 ARM taps to 1 (off).
     *
     * Caveat: this assumes the three slots share one texture, which is
     * true for the materials this patch is attached to. If a future
     * material uses three different ARM-style textures, the patch
     * would need to fan out — but that would be an unusual setup.
     */
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <roughnessmap_fragment>`,
      `float roughnessFactor = roughness;
/* Single-tap, shared across rough / metal / AO chunks — see header
 * comment block above this patch for the dedup rationale. Always
 * single-tap regardless of uStochEnabled, since stochastic-sampling
 * AO/roughness/metalness produces no perceptible visual difference
 * but doubles the texture-fetch cost. */
vec4 _armSampled = vec4(1.0, 1.0, 0.0, 1.0);
#if defined(USE_ROUGHNESSMAP) || defined(USE_METALNESSMAP) || defined(USE_AOMAP)
  _armSampled = texture2D(roughnessMap, vRoughnessMapUv);
#endif
#ifdef USE_ROUGHNESSMAP
  roughnessFactor *= _armSampled.g;
#endif`,
    );

    /* === Metalness map (reuses _armSampled) =========================== */
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <metalnessmap_fragment>`,
      `float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  metalnessFactor *= _armSampled.b;
#endif`,
    );

    /* === AO map (reuses _armSampled) ================================== */
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <aomap_fragment>`,
      `#ifdef USE_AOMAP
  float ambientOcclusion = (_armSampled.r - 1.0) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined(USE_ENVMAP) && defined(STANDARD)
    float dotNV = saturate(dot(geometryNormal, geometryViewDir));
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(dotNV, ambientOcclusion, material.roughness);
  #endif
#endif`,
    );
  };
}

/** Per-slab tint jitter — 8 brightness levels per base colour. Result
 *  spans [1 - TINT_RANGE .. 1 + TINT_RANGE] applied as an RGB multiplier.
 *  Ensures two same-colour slabs at different positions read as different
 *  weathering grades rather than identical. */
const TINT_LEVELS = 8;
const TINT_RANGE = 0.10; // ±10%
function _tintForLevel(baseHex, level) {
  const lvl = ((level | 0) % TINT_LEVELS + TINT_LEVELS) % TINT_LEVELS;
  const mul = 1.0 - TINT_RANGE + (lvl / (TINT_LEVELS - 1)) * 2 * TINT_RANGE;
  const c = new THREE.Color(baseHex);
  c.multiplyScalar(mul);
  return c;
}

/** Shared slab materials (dedup across sectors). Cache key is
 *  `${baseHex}_${level}` so the 3 base tints × 8 levels = 24 materials
 *  max. All share the same three texture bindings — only the program
 *  cache key + uniform block differ. The anti-repetition shader hook
 *  (stochastic sampling + macro tint) is attached on creation. */
const _materialCache = new Map();
function getConcreteMaterial(colorHex, tintLevel) {
  const lvl = (tintLevel | 0) % TINT_LEVELS;
  const cacheKey = `${colorHex}_${lvl}`;
  const cached = _materialCache.get(cacheKey);
  if (cached) return cached;
  ensureSlabTextures();
  /* roughness / metalness factors at 1.0 so the ARM map's G/B channels
   * provide the absolute values rather than being multiplied down. The
   * concrete_layers ARM has B (metalness) ≈ 0 across the surface, so
   * even at metalness factor 1 the slabs read as fully dielectric —
   * matte concrete, no mirror highlights.
   *
   * normalScale boosted to (2, 2): brutalist concrete needs the bumps
   * to *carve* into the lighting, not whisper. The default (1, 1) made
   * surfaces feel like flat panels with grime; (2, 2) gives the
   * board-form pattern in the normal map enough impact to read as
   * actual surface depth. */
  const m = new THREE.MeshStandardMaterial({
    color: _tintForLevel(colorHex, lvl),
    map: _slabSet.diff,
    normalMap: _slabSet.normal,
    normalScale: new THREE.Vector2(2.0, 2.0),
    aoMap: _slabSet.arm,
    roughnessMap: _slabSet.arm,
    metalnessMap: _slabSet.arm,
    roughness: 1.0,
    metalness: 1.0,
    aoMapIntensity: 1.0,
  });
  _attachAntiRepShader(m);
  _materialCache.set(cacheKey, m);
  /* Apply the current textures-on/off state. If a player turned
   * textures off, walks into a new sector that triggers creation
   * of a new colour-tint variant, the new material would otherwise
   * spawn with full textures and break the perf-comparison mode. */
  if (!_texturesEnabled) _stripOrRestoreMaterialTextures(m);
  return m;
}

/** Shared ground material — independent texture set (hangar concrete
 *  floor), neutral tint, same anti-repetition shader as the slabs so
 *  the stochastic sampling + macro-tint variation run continuously
 *  across slabs and ground. The 80 m × 80 m ground tile is the most
 *  obviously-tiling surface in the scene, so stochastic sampling
 *  matters even more here than on slabs. */
let _groundMaterial = null;
function getGroundMaterial() {
  if (_groundMaterial) return _groundMaterial;
  ensureGroundTextures();
  _groundMaterial = new THREE.MeshStandardMaterial({
    color: 0xa8a39a,
    map: _groundSet.diff,
    normalMap: _groundSet.normal,
    normalScale: new THREE.Vector2(1.5, 1.5),
    aoMap: _groundSet.arm,
    roughnessMap: _groundSet.arm,
    metalnessMap: _groundSet.arm,
    roughness: 1.0,
    metalness: 1.0,
    aoMapIntensity: 1.0,
  });
  _attachAntiRepShader(_groundMaterial);
  if (!_texturesEnabled) _stripOrRestoreMaterialTextures(_groundMaterial);
  return _groundMaterial;
}

/** Box-geometry cache keyed by (size_mm, jitter_idx). For each unique
 *  (w,h,d) we keep up to 16 jitter variants — 4 UV rotations × 4 sub-tile
 *  offsets — so neighbouring slabs of identical dimensions show the
 *  texture in different orientations and offsets. Caching by jitter
 *  index (not raw rot+offU+offV) keeps the cache size strictly bounded
 *  even if many slabs reuse the same dimensions. */
const _boxGeometryCache = new Map();
const JITTER_VARIANTS = 16; // 4 rotations × 4 (offU, offV) cells

function getBoxGeometryForSlab(w, h, d, jitterIdx) {
  const j = ((jitterIdx | 0) % JITTER_VARIANTS + JITTER_VARIANTS) % JITTER_VARIANTS;
  const key = `${(w * 1000) | 0}_${(h * 1000) | 0}_${(d * 1000) | 0}_${j}`;
  let geo = _boxGeometryCache.get(key);
  if (geo) return geo;
  geo = new THREE.BoxGeometry(w, h, d);
  /* Decode the 4-bit jitterIdx into rotation index (low 2 bits) and a
   * 2×2 offset-cell index (next 2 bits). Offsets are at 0 and 0.5 of the
   * tile so the texture lands at four distinct sub-tile positions. */
  const rotIdx = j & 0b11;
  const offCellIdx = (j >>> 2) & 0b11;
  const offU = (offCellIdx & 1) * 0.5;
  const offV = ((offCellIdx >>> 1) & 1) * 0.5;
  _bakeBoxUVs(geo, w, h, d, TEXTURE_TILE_M, rotIdx, offU, offV);
  _boxGeometryCache.set(key, geo);
  return geo;
}

/** Bake world-space tile UVs + per-slab rotation + offset into a
 *  BoxGeometry's `uv` attribute. Three.js BoxGeometry generates faces in
 *  this fixed order, with each face's vanilla UVs spanning [0..1]:
 *      0  +X  →  u along local +Z (face width = d), v along local +Y (h)
 *      1  -X  →  same dims as +X
 *      2  +Y  →  u along local +X (w), v along local +Z (d)
 *      3  -Y  →  same dims as +Y
 *      4  +Z  →  u along local +X (w), v along local +Y (h)
 *      5  -Z  →  same dims as +Z
 *
 *  Pipeline per face:
 *    raw_uv ∈ [0,1]² → world_uv = raw_uv * (face_w/tileM, face_h/tileM)
 *                    → rotated_uv via 90°·rotIdx rotation in tex-UV space
 *                    → final_uv = rotated_uv + (offU, offV)
 *  RepeatWrapping on the texture handles negative / non-zero starting UVs. */
function _bakeBoxUVs(geo, w, h, d, tileM, rotIdx, offU, offV) {
  const arr = geo.attributes.uv.array;
  const FACES = [
    [d, h], [d, h], // ±X
    [w, d], [w, d], // ±Y
    [w, h], [w, h], // ±Z
  ];
  for (let f = 0; f < 6; f++) {
    const W = FACES[f][0];
    const H = FACES[f][1];
    for (let v = 0; v < 4; v++) {
      const i = (f * 4 + v) * 2;
      const uTex = arr[i] * (W / tileM);
      const vTex = arr[i + 1] * (H / tileM);
      let uOut, vOut;
      switch (rotIdx) {
        case 1: uOut =  vTex; vOut = -uTex; break;  // 90° CW
        case 2: uOut = -uTex; vOut = -vTex; break;  // 180°
        case 3: uOut = -vTex; vOut =  uTex; break;  // 270° CW
        default: uOut = uTex; vOut = vTex;          // 0°
      }
      arr[i]     = uOut + offU;
      arr[i + 1] = vOut + offV;
    }
  }
  geo.attributes.uv.needsUpdate = true;
}

/** Per-slab deterministic hash → drives both the geometry jitter and the
 *  tint level. Sector-stable: same slab in the same sector always picks
 *  the same variants, so a returning player sees the same composition. */
function _slabHash(sx, sz, idx) {
  /* eslint-disable no-bitwise */
  let h = Math.imul(sx | 0, 0x9e3779b1) ^ Math.imul(sz | 0, 0x85ebca77);
  h = Math.imul(h ^ (idx | 0), 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
  /* eslint-enable no-bitwise */
}

/** Shared ground geometry: one PlaneGeometry per session, with UVs scaled
 *  so the texture tiles SECTOR_SIZE / TEXTURE_TILE_M times across the
 *  80 m tile (= 40 repeats at 2 m tile). Because that is an integer count
 *  and the texture wraps with RepeatWrapping, adjacent ground tiles meet
 *  with no visible seam. */
let _groundGeometry = null;
function getGroundGeometry() {
  if (_groundGeometry) return _groundGeometry;
  _groundGeometry = new THREE.PlaneGeometry(SECTOR_SIZE, SECTOR_SIZE);
  const repeats = SECTOR_SIZE / TEXTURE_TILE_M;
  const arr = _groundGeometry.attributes.uv.array;
  for (let i = 0; i < arr.length; i++) arr[i] *= repeats;
  _groundGeometry.attributes.uv.needsUpdate = true;
  return _groundGeometry;
}

/* ── Module state ─────────────────────────────────────────────────────── */

let scene_ = null;
/** @type {Map<string, Sector>} key -> sector */
const loadedSectors_ = new Map();
let lastPlayerSectorKey_ = null;
/** Flat aggregated array, rebuilt on streaming changes. */
let activeCollisionBoxes_ = [];
/** Flat aggregated meshes (slabs + ground tiles), rebuilt on streaming changes. */
let activeSceneObjects_ = [];
/** Small bounded LRU cache for archetype lookups. Keys are sector keys.
 *  Used by getAllSectorMetas() to avoid recomputing the hash+weighted
 *  pick when the minimap window mostly overlaps frame-to-frame. */
const archetypeCache_ = new Map();
const ARCHETYPE_CACHE_MAX = 512;

/** Optional callback invoked on sector load/unload events so dependent
 *  systems (e.g. dynamic shadow setup) can refresh. */
let onChangedCallback_ = null;

/* ── Public coordinate helpers ────────────────────────────────────────── */

export function sectorKeyForWorld(x, z) {
  const sx = Math.round(x / SECTOR_SIZE);
  const sz = Math.round(z / SECTOR_SIZE);
  return `${sx},${sz}`;
}

export function neighborKeysFor(key) {
  const [sx, sz] = key.split(",").map(Number);
  const out = [];
  /* No clamp — the world is infinite. The 5×5 active set is whatever
   * window currently surrounds the player; sectors stream in/out as the
   * player walks, but there's no edge to walk off. */
  for (let dz = -ACTIVE_HALF; dz <= ACTIVE_HALF; dz++) {
    for (let dx = -ACTIVE_HALF; dx <= ACTIVE_HALF; dx++) {
      out.push(`${sx + dx},${sz + dz}`);
    }
  }
  return out;
}

export function getSectorWorldCenter(key, out) {
  const [sx, sz] = key.split(",").map(Number);
  const v = out || new THREE.Vector3();
  return v.set(sx * SECTOR_SIZE, 0, sz * SECTOR_SIZE);
}

/* ── Loading / unloading ──────────────────────────────────────────────── */

function loadSector(key) {
  if (loadedSectors_.has(key)) return loadedSectors_.get(key);
  const [sx, sz] = key.split(",").map(Number);
  const wx = sx * SECTOR_SIZE;
  const wz = sz * SECTOR_SIZE;

  const group = new THREE.Group();
  group.name = `sector_${key}`;
  group.position.set(wx, 0, wz);

  const meshes = [];
  const obbs = [];

  /* Ground tile (one per sector). +1 mm above y=0 to avoid z-fighting at
   * sector borders where two tiles meet. */
  const ground = new THREE.Mesh(getGroundGeometry(), getGroundMaterial());
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.001;
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.name = `ground_${key}`;
  group.add(ground);
  meshes.push(ground);
  obbs.push(buildGroundCollisionOBB(wx, wz));

  /* Slabs. The geometry carries the slab's real-world dimensions (so its
   * UVs are pre-scaled for consistent texture tiling across all sizes);
   * a per-slab hash drives a 16-way jitter variant (UV rotation + offset)
   * and an 8-way tint level so neighbouring identical-sized slabs show
   * different texture orientations + brightness, breaking the wallpaper
   * effect. The mesh stays at scale 1; only position + rotation apply. */
  const { archetypeName, slabs } = buildSlabsForSector(sx, sz);
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    const [sw, sh, sd] = s.s;
    const seed = _slabHash(sx, sz, i);
    const jitterIdx = seed & 0b1111;          // 4 bits: 16 geometry variants
    const tintLevel = (seed >>> 4) & 0b111;   // 3 bits: 8 tint levels
    const mesh = new THREE.Mesh(
      getBoxGeometryForSlab(sw, sh, sd, jitterIdx),
      getConcreteMaterial(s.color, tintLevel),
    );
    mesh.position.set(s.p[0], s.p[1], s.p[2]);
    mesh.rotation.set(s.rot[0], s.rot[1], s.rot[2], "XYZ");
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `slab_${key}_${i}`;
    group.add(mesh);
    meshes.push(mesh);
    obbs.push(buildOBBFromSlab(s, wx, wz));
  }

  scene_.add(group);

  /** @type {Sector} */
  const sector = { key, sx, sz, archetype: archetypeName, group, meshes, collisionBoxes: obbs };
  loadedSectors_.set(key, sector);
  return sector;
}

function unloadSector(key) {
  const sector = loadedSectors_.get(key);
  if (!sector) return;
  scene_.remove(sector.group);
  /* Geometries / materials are SHARED — never dispose them. The
   * Group + child Meshes are GC'd once we drop our refs. */
  loadedSectors_.delete(key);
}

function rebuildAggregates() {
  activeCollisionBoxes_ = [];
  activeSceneObjects_ = [];
  for (const sector of loadedSectors_.values()) {
    for (const obb of sector.collisionBoxes) activeCollisionBoxes_.push(obb);
    for (const mesh of sector.meshes) activeSceneObjects_.push(mesh);
  }
}

/* ── Public streaming + queries ───────────────────────────────────────── */

export function initSectors(scene, opts = {}) {
  scene_ = scene;
  /* Read max anisotropy from the renderer if provided. The PBR concrete
   * textures tile densely on every face, so without anisotropic filtering
   * they alias hard at grazing angles (which is most of what the player
   * sees on tall walls). Quest 3 supports 16x; desktop GPUs the same —
   * falls back to 4 if no renderer was passed. */
  if (opts.renderer && opts.renderer.capabilities) {
    _maxAnisotropy = opts.renderer.capabilities.getMaxAnisotropy?.() || 4;
  }
  /* URL flags. Both can be flipped at runtime via brutalistVR8.setAntiRep
   * and brutalistVR8.setTextures; these are just boot-time defaults.
   *   ?antirep=0  → stochastic anti-repetition sampling off (slight tile
   *                 period reappears on diffuse, ~half the fragment-shader
   *                 cost saved)
   *   ?textures=0 → all PBR maps stripped (slabs + ground render as
   *                 flat-tinted surfaces with macro brightness wave;
   *                 zero texture-fetch cost — useful for measuring
   *                 the texture pipeline's frame budget). */
  try {
    const params = new URLSearchParams(window.location.search);
    const ar = params.get("antirep");
    if (ar === "0" || ar === "off" || ar === "false") {
      setAntiRepetition(false);
    }
    const tx = params.get("textures");
    if (tx === "0" || tx === "off" || tx === "false") {
      setTextures(false);
    }
  } catch (_) { /* SSR / test envs without window: ignore */ }
  /* Load the player's initial 3×3 around (0,0). updateSectorStreaming
   * will repeat this work cheaply; calling it here primes the world so
   * collision queries work before the first frame. */
  const initialKey = opts.initialKey || "0,0";
  lastPlayerSectorKey_ = null; // force first update to do work
  _streamTo(initialKey);
}

/** Call once per frame from the animate loop. Cheap when the player
 * stays inside the current cell. */
export function updateSectorStreaming(playerPos) {
  const key = sectorKeyForWorld(playerPos.x, playerPos.z);
  if (key === lastPlayerSectorKey_) return false;
  _streamTo(key);
  return true;
}

function _streamTo(key) {
  const want = new Set(neighborKeysFor(key));
  /* Unload anything not in `want`. */
  for (const loadedKey of [...loadedSectors_.keys()]) {
    if (!want.has(loadedKey)) unloadSector(loadedKey);
  }
  /* Load anything in `want` that's not already loaded. */
  for (const k of want) {
    if (!loadedSectors_.has(k)) loadSector(k);
  }
  lastPlayerSectorKey_ = key;
  rebuildAggregates();
  if (onChangedCallback_) onChangedCallback_({ currentKey: key, activeKeys: [...want] });
}

export function getActiveCollisionBoxes() {
  return activeCollisionBoxes_;
}

export function getActiveSceneObjects() {
  return activeSceneObjects_;
}

export function getCurrentSectorKey() {
  return lastPlayerSectorKey_ || "0,0";
}

export function getActiveSectorKeys() {
  return [...loadedSectors_.keys()];
}

/** Archetype name for a single sector key. Result is deterministic and
 *  cached — the same (sx,sz) always produces the same archetype. */
function archetypeForKey(sx, sz) {
  const key = `${sx},${sz}`;
  const hit = archetypeCache_.get(key);
  if (hit !== undefined) {
    /* LRU touch: re-insert so it's youngest. */
    archetypeCache_.delete(key);
    archetypeCache_.set(key, hit);
    return hit;
  }
  let archetype;
  if (sx === 0 && sz === 0) {
    archetype = "open_park";
  } else {
    const rand = mulberry32(sectorSeed(sx, sz));
    archetype = pickWeighted(rand, ARCHETYPES.map((a) => ({ w: a.w, ref: a }))).ref.name;
  }
  archetypeCache_.set(key, archetype);
  if (archetypeCache_.size > ARCHETYPE_CACHE_MAX) {
    /* Evict oldest. */
    const firstKey = archetypeCache_.keys().next().value;
    archetypeCache_.delete(firstKey);
  }
  return archetype;
}

/** Per-cell metadata for the (2*radius+1)² window centred on `centerKey`
 *  (defaults to the player's current sector). Used by the HUD minimap
 *  to colour-code cells around the player. The world is infinite, so
 *  this window slides as the player moves. */
export function getAllSectorMetas(centerKey, radius = GRID_HALF) {
  let csx = 0;
  let csz = 0;
  const key = centerKey || lastPlayerSectorKey_;
  if (key) {
    const parts = key.split(",");
    csx = parseInt(parts[0], 10) | 0;
    csz = parseInt(parts[1], 10) | 0;
  }
  const out = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const sx = csx + dx;
      const sz = csz + dz;
      out.push({ key: `${sx},${sz}`, sx, sz, archetype: archetypeForKey(sx, sz) });
    }
  }
  return out;
}

/** Subscribe to sector load/unload events. Single subscriber for now. */
export function setOnSectorsChanged(cb) {
  onChangedCallback_ = cb;
}

/** Useful for tests / hot reloads. */
export function _resetSectors() {
  for (const k of [...loadedSectors_.keys()]) unloadSector(k);
  loadedSectors_.clear();
  activeCollisionBoxes_ = [];
  activeSceneObjects_ = [];
  lastPlayerSectorKey_ = null;
  archetypeCache_.clear();
  scene_ = null;
}
