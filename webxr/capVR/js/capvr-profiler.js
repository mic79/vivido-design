/**
 * CapVR frame profiler — FACTS, not guesses.
 *
 * Wraps every registered A-Frame component's tick/tock, accumulates real
 * per-frame cost, and every few seconds prints a ranked breakdown plus the
 * renderer draw-call / triangle counts. This tells us definitively whether a
 * script is eating the frame (CPU) or we're GPU-bound (render remainder).
 *
 * Controls (console):
 *   __capvrProf(false)   // stop logging (wrappers stay, ~0 cost)
 *   __capvrProf(true)    // resume logging
 *   __capvrProfDump()    // print immediately
 *   __capvrProfReset()   // clear counters
 */
(function () {
  'use strict';
  if (typeof AFRAME === 'undefined') return;

  const stats = Object.create(null); // name -> { tick, tock, calls }
  let frames = 0;
  let frameMsAccum = 0;
  let logging = true;
  let intervalMs = 3000;
  let lastReport = 0;

  // Frame-time distribution + render() CPU submit timing. Distinguishes a
  // half-rate reprojection LATCH (frames clustered ~27.7ms) from genuine
  // variable GPU/fill cost (frames scattered), and tells us if the cost is in
  // three.js CPU submit vs GPU/compositor (submit low but frame long = GPU/latch).
  let frameMin = Infinity, frameMax = 0;
  let over15 = 0, over20 = 0, over26 = 0;
  let renderMsAccum = 0, renderMsMax = 0, renderCalls = 0;
  let rendererWrapped = false;

  function wrapRenderer() {
    if (rendererWrapped) return;
    const scene = document.querySelector('a-scene');
    const r = scene && scene.renderer;
    if (!r || typeof r.render !== 'function') return;
    const orig = r.render.bind(r);
    r.render = function () {
      const c0 = performance.now();
      orig.apply(null, arguments);
      const c = performance.now() - c0;
      renderMsAccum += c;
      if (c > renderMsMax) renderMsMax = c;
      renderCalls++;
    };
    rendererWrapped = true;
  }

  function bucket(name) {
    return stats[name] || (stats[name] = { tick: 0, tock: 0, calls: 0 });
  }

  function wrapAll() {
    const comps = AFRAME.components || {};
    Object.keys(comps).forEach((name) => {
      const proto = comps[name] && comps[name].Component && comps[name].Component.prototype;
      if (!proto) return;
      ['tick', 'tock'].forEach((fn) => {
        if (typeof proto[fn] !== 'function') return;
        if (proto['_capvrProfWrapped_' + fn]) return;
        const orig = proto[fn];
        proto['_capvrProfWrapped_' + fn] = true;
        proto[fn] = function () {
          const t0 = performance.now();
          const r = orig.apply(this, arguments);
          const cost = performance.now() - t0;
          const s = bucket(name);
          s[fn] += cost;
          if (fn === 'tick') s.calls++;
          return r;
        };
      });
    });
  }

  function reset() {
    for (const k in stats) delete stats[k];
    frames = 0;
    frameMsAccum = 0;
    frameMin = Infinity; frameMax = 0;
    over15 = 0; over20 = 0; over26 = 0;
    renderMsAccum = 0; renderMsMax = 0; renderCalls = 0;
  }

  function pad(s, w) {
    s = String(s);
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
  }

  function dump() {
    const scene = document.querySelector('a-scene');
    const n = Math.max(1, frames);
    const rows = Object.keys(stats).map((name) => {
      const s = stats[name];
      return { name, total: (s.tick + s.tock) / n, tick: s.tick / n, tock: s.tock / n, calls: s.calls / n };
    }).filter((r) => r.total > 0.02).sort((a, b) => b.total - a.total);

    const avgFrame = frameMsAccum / n;
    let componentSum = 0;
    rows.forEach((r) => { componentSum += r.total; });

    // Single plain-text block — easy to copy from console (no console.table).
    const L = [];
    L.push('==== CapVR profiler ====');
    L.push('frame: ' + avgFrame.toFixed(2) + ' ms  (' + (1000 / Math.max(0.001, avgFrame)).toFixed(0) +
      ' fps)  over ' + frames + ' frames');
    L.push('CPU in components: ' + componentSum.toFixed(2) + ' ms/f   |   render+GPU+other: ' +
      Math.max(0, avgFrame - componentSum).toFixed(2) + ' ms/f');
    // Frame distribution: tight cluster near a multiple of 13.9 => compositor latch;
    // scattered high values => genuine variable GPU/fill cost.
    L.push('frame dist: min ' + (frameMin === Infinity ? 0 : frameMin).toFixed(1) + '  max ' + frameMax.toFixed(1) +
      ' ms  |  >15ms: ' + over15 + '  >20ms: ' + over20 + '  >26ms: ' + over26 + '  of ' + frames + ' frames');
    // three.js render() CPU submit time. If this is LOW while frames are long,
    // the cost is GPU execution or a reprojection latch, NOT CPU-side draw building.
    if (renderCalls > 0) {
      L.push('renderer.render() CPU submit: avg ' + (renderMsAccum / renderCalls).toFixed(2) +
        ' ms  max ' + renderMsMax.toFixed(2) + ' ms  over ' + renderCalls + ' calls');
    }
    L.push('-- components (ms/frame) --');
    L.push(pad('component', 24) + pad('total', 8) + pad('tick', 8) + pad('tock', 8) + 'calls/f');
    rows.forEach((r) => {
      L.push(pad(r.name, 24) + pad(r.total.toFixed(3), 8) + pad(r.tick.toFixed(3), 8) +
        pad(r.tock.toFixed(3), 8) + r.calls.toFixed(1));
    });

    const r = scene && scene.renderer;
    if (r && r.info) {
      L.push('-- renderer -- drawCalls=' + r.info.render.calls + '  triangles=' + r.info.render.triangles +
        '  programs=' + (r.info.programs ? r.info.programs.length : '?') +
        '  geometries=' + r.info.memory.geometries + '  textures=' + r.info.memory.textures);
    }

    if (scene && scene.object3D) {
      let objs = 0; let meshes = 0; const matSet = new Set();
      scene.object3D.traverse((o) => {
        objs++;
        if (o.isMesh) {
          meshes++;
          const m = o.material;
          (Array.isArray(m) ? m : [m]).forEach((mm) => { if (mm) matSet.add(mm); });
        }
      });
      L.push('-- scene graph -- object3Ds=' + objs + '  meshes=' + meshes + '  uniqueMaterials=' + matSet.size);
      const tm = topMeshes(scene.object3D, 14);
      L.push('-- geometry present=' + tm._totalTris + ' tris  |  effectively DRAWN=' + tm._drawnTris +
        ' tris  (hidden by ancestor=' + (tm._totalTris - tm._drawnTris) + ')');
      L.push('-- top triangle sources (by entity) --');
      L.push(pad('entity', 42) + pad('triangles', 12) + pad('meshes', 8) + 'drawn');
      tm.forEach((m) => {
        L.push(pad(m.entity, 42) + pad(m.triangles, 12) + pad(m.meshes, 8) + (m.drawn ? 'yes' : 'HIDDEN'));
      });
    }
    L.push('========================');
    console.log(L.join('\n'));
  }

  function labelFor(o) {
    // Walk up to the nearest A-Frame entity and describe it (id + components).
    let n = o;
    while (n) {
      if (n.el) {
        const el = n.el;
        const comps = el.components ? Object.keys(el.components).filter((c) =>
          /body|ragdoll|avatar|grab|bot|ball|arena|shard|shatter|flag|goal/i.test(c)) : [];
        return (el.id ? '#' + el.id : el.tagName ? el.tagName.toLowerCase() : '?') +
          (comps.length ? ' [' + comps.join(',') + ']' : '') +
          (o.isSkinnedMesh ? ' (skinned)' : '');
      }
      n = n.parent;
    }
    return o.name || (o.isSkinnedMesh ? '(skinned mesh)' : '(mesh)');
  }

  function triCount(geo) {
    if (!geo) return 0;
    const idx = geo.index;
    if (idx) return (idx.count / 3) | 0;
    const pos = geo.attributes && geo.attributes.position;
    return pos ? (pos.count / 3) | 0 : 0;
  }

  // Effective visibility: an object is only drawn if it AND every ancestor is visible.
  // (A-Frame visible="false" sets the entity object3D.visible=false — the child mesh's
  // own .visible stays true, which is why the old column lied.)
  function drawnVisible(o) {
    let n = o;
    while (n) {
      if (n.visible === false) return false;
      n = n.parent;
    }
    return true;
  }

  // Aggregate triangles by entity label so 8 skinned characters don't flood the list.
  // Splits geometry that is actually DRAWN vs present-but-hidden by an ancestor.
  function topMeshes(root, n) {
    const byLabel = Object.create(null);
    let totalTris = 0; let drawnTris = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      const t = triCount(o.geometry);
      if (t <= 0) return;
      const drawn = drawnVisible(o);
      totalTris += t;
      if (drawn) drawnTris += t;
      const label = labelFor(o);
      const e = byLabel[label] || (byLabel[label] = { label, triangles: 0, meshes: 0, drawn: false });
      e.triangles += t;
      e.meshes++;
      if (drawn) e.drawn = true;
    });
    const list = Object.values(byLabel)
      .sort((a, b) => b.triangles - a.triangles)
      .slice(0, n || 8)
      .map((e) => ({ entity: e.label, triangles: e.triangles, meshes: e.meshes, drawn: e.drawn }));
    list._totalTris = totalTris;
    list._drawnTris = drawnTris;
    return list;
  }

  AFRAME.registerComponent('capvr-profiler', {
    init: function () {
      wrapAll();
      // Some components register lazily — re-wrap a few times early on.
      setTimeout(wrapAll, 500);
      setTimeout(wrapAll, 2000);
      lastReport = performance.now();
      window.__capvrProf = (on) => { logging = on !== false; return logging; };
      window.__capvrProfDump = dump;
      window.__capvrProfReset = reset;
      window.__capvrMeshTop = (n) => {
        const s = document.querySelector('a-scene');
        const rows = topMeshes(s.object3D, n || 15);
        const L = ['-- geometry present=' + rows._totalTris + '  DRAWN=' + rows._drawnTris,
          '-- top triangle sources (by entity) --',
          pad('entity', 42) + pad('triangles', 12) + pad('meshes', 8) + 'drawn'];
        rows.forEach((m) => L.push(pad(m.entity, 42) + pad(m.triangles, 12) + pad(m.meshes, 8) + (m.drawn ? 'yes' : 'HIDDEN')));
        console.log(L.join('\n'));
      };
      console.log('%c[CapVR profiler] active — breakdown every 3s. __capvrProfDump() for now.', 'color:#5eead4');
    },
    tick: function (time, dt) {
      if (!rendererWrapped) wrapRenderer();
      frames++;
      const d = dt || 16.6;
      frameMsAccum += d;
      if (d < frameMin) frameMin = d;
      if (d > frameMax) frameMax = d;
      if (d > 15) over15++;
      if (d > 20) over20++;
      if (d > 26) over26++;
      if (logging && time - lastReport >= intervalMs) {
        lastReport = time;
        dump();
        reset();
      }
    }
  });
})();
