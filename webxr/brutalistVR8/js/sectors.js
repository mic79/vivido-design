/**
 * brutalistVR8 — sector streaming
 *
 * The world is a 9×9 grid of 80×80 m sectors centred on (0,0). Only the
 * 3×3 sectors around the player's current cell are loaded; everything
 * else is disposed. Each sector is fully procedural — its archetype +
 * slab placements are determined by a deterministic 32-bit hash of the
 * sector key, so reloading or re-entering a sector reproduces exactly
 * the same composition.
 *
 *  Coords
 *  ──────
 *   sectorKey = "sx,sz" with sx,sz ∈ [-GRID_HALF, +GRID_HALF].
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
 *   - 1 ground tile + 6–14 slabs → 7–15 draw calls, ~30–80 OBBs world-wide
 *   - 9 active sectors → ~70–140 draw calls, ~270–720 OBBs
 *
 *  Public API:
 *   initSectors(scene, opts?)            — boot, reads URL config
 *   updateSectorStreaming(playerPos)     — call each frame; cheap, no-op
 *                                          unless the player crossed a cell
 *   getActiveCollisionBoxes()            — flat array, scratch-safe ref
 *   getActiveSceneObjects()              — meshes for shadow setup
 *   getCurrentSectorKey()                — "sx,sz"
 *   getActiveSectorKeys()                — Array<"sx,sz">
 *   getAllSectorMetas()                  — Array<{key, sx, sz, archetype}>
 *                                          (one per cell in the 9×9 grid)
 *   getSectorWorldCenter(key, out?)      — Vector3 at the cell's centre
 */

import * as THREE from "three";

/* ── Grid configuration ───────────────────────────────────────────────── */

export const SECTOR_SIZE = 80;
/** Half-width of the world grid, in sectors. Total = 2*GRID_HALF+1 per axis. */
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
 * archetypes). Constants from Knuth / common practice. */
function sectorSeed(sx, sz) {
  /* eslint-disable no-bitwise */
  let h = (sx | 0) * 0x9e3779b1 ^ ((sz | 0) * 0x85ebca77);
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

/** Shared materials (dedup across sectors) */
const _materialCache = new Map();
function getConcreteMaterial(colorHex) {
  if (_materialCache.has(colorHex)) return _materialCache.get(colorHex);
  const m = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.85,
    metalness: 0.04,
  });
  _materialCache.set(colorHex, m);
  return m;
}

/** Shared ground material — cheap, single shared MeshStandardMaterial. */
let _groundMaterial = null;
function getGroundMaterial() {
  if (_groundMaterial) return _groundMaterial;
  _groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x807a72,
    roughness: 0.95,
    metalness: 0.02,
  });
  return _groundMaterial;
}

/** Reuse one BoxGeometry + scale per slab — keeps GPU memory low. We can't
 * use InstancedMesh since each slab has a unique scale and rotation, but
 * sharing the unit-cube geometry across all slabs of a single sector
 * (and across sectors) saves memory at the cost of one extra matrix
 * multiply per draw, which is negligible. */
let _unitBoxGeometry = null;
function getUnitBoxGeometry() {
  if (_unitBoxGeometry) return _unitBoxGeometry;
  _unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
  return _unitBoxGeometry;
}

let _groundGeometry = null;
function getGroundGeometry() {
  if (_groundGeometry) return _groundGeometry;
  _groundGeometry = new THREE.PlaneGeometry(SECTOR_SIZE, SECTOR_SIZE);
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
/** Cached per-cell metadata for the full 9×9 grid, computed lazily for the
 *  HUD minimap. */
let allSectorMetas_ = null;

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
  for (let dz = -ACTIVE_HALF; dz <= ACTIVE_HALF; dz++) {
    for (let dx = -ACTIVE_HALF; dx <= ACTIVE_HALF; dx++) {
      const nx = sx + dx;
      const nz = sz + dz;
      if (Math.abs(nx) > GRID_HALF || Math.abs(nz) > GRID_HALF) continue;
      out.push(`${nx},${nz}`);
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

  /* Slabs */
  const { archetypeName, slabs } = buildSlabsForSector(sx, sz);
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    const mesh = new THREE.Mesh(getUnitBoxGeometry(), getConcreteMaterial(s.color));
    mesh.scale.set(s.s[0], s.s[1], s.s[2]);
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

/** All cells in the 9×9 grid + their archetype names. Used by the HUD
 *  minimap to colour-code unloaded cells too. Cached after first call —
 *  archetype assignment is deterministic per sector key. */
export function getAllSectorMetas() {
  if (allSectorMetas_) return allSectorMetas_;
  allSectorMetas_ = [];
  for (let sz = -GRID_HALF; sz <= GRID_HALF; sz++) {
    for (let sx = -GRID_HALF; sx <= GRID_HALF; sx++) {
      const key = `${sx},${sz}`;
      const seed = sectorSeed(sx, sz);
      const rand = mulberry32(seed);
      let archetype;
      if (sx === 0 && sz === 0) {
        archetype = "open_park";
      } else {
        archetype = pickWeighted(rand, ARCHETYPES.map((a) => ({ w: a.w, ref: a }))).ref.name;
      }
      allSectorMetas_.push({ key, sx, sz, archetype });
    }
  }
  return allSectorMetas_;
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
  allSectorMetas_ = null;
  scene_ = null;
}
