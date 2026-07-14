/**
 * CapVR arena fixtures — editable spawn pyramids + goal/flag anchors.
 * Markers are movable in level-editor; positions persist in layout.fixtures.
 */
(function () {
  'use strict';

  const FLAG_INSET = 2.3; // meters from goal toward field center (matches classic CapVR HOMEs)
  const SPAWN_SLOTS = 4;
  const SPAWN_HEIGHT = 2;
  const DEFAULT_LATERAL = [2, -2, 3.5, -3.5];
  const DEFAULT_GOAL_Z = { red: -38.8, blue: 38.8 };
  const DEFAULT_STANDOFF = 1;

  let _editorOn = false;
  let _syncing = false;

  function sceneEl() { return document.querySelector('a-scene'); }

  function defaultSpawn(team, idx) {
    const goalZ = DEFAULT_GOAL_Z[team] ?? -38.8;
    const toward = goalZ < 0 ? 1 : -1;
    return {
      x: DEFAULT_LATERAL[idx % DEFAULT_LATERAL.length],
      y: SPAWN_HEIGHT,
      z: goalZ + toward * DEFAULT_STANDOFF,
      rotY: goalZ < 0 ? 180 : 0
    };
  }

  function defaultGoal(team) {
    return { x: 0, y: 1.5, z: DEFAULT_GOAL_Z[team] ?? 0 };
  }

  function flagHomeFromGoal(goal) {
    if (!goal) return null;
    const toward = goal.z < 0 ? 1 : -1;
    return {
      x: goal.x,
      y: 2.6,
      z: goal.z + toward * FLAG_INSET
    };
  }

  function ensureRoot() {
    const scene = sceneEl();
    if (!scene) return null;
    let root = document.getElementById('arena-fixtures');
    if (!root) {
      root = document.createElement('a-entity');
      root.id = 'arena-fixtures';
      scene.appendChild(root);
    }
    return root;
  }

  function stripPhysics(el) {
    if (!el) return;
    try {
      const gs = el.components?.['grab-surface'];
      if (gs?.body && typeof world !== 'undefined') {
        world.removeBody(gs.body);
        gs.body = null;
      }
      if (el.body && typeof world !== 'undefined') {
        try { world.removeBody(el.body); } catch (e) { /* */ }
        el.body = null;
      }
    } catch (e) { /* */ }
  }

  function makePyramid(id, color, label) {
    const el = document.createElement('a-cone');
    el.id = id;
    el.setAttribute('radius-bottom', 0.55);
    el.setAttribute('radius-top', 0.02);
    el.setAttribute('height', 0.9);
    el.setAttribute('segments-radial', 4); // square base → pyramid look
    el.setAttribute('color', color);
    el.setAttribute('material', {
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      opacity: 0.92,
      transparent: true
    });
    el.classList.add('arena-fixture', 'arena-spawn-marker');
    el.dataset.arenaFixture = 'spawn';
    el.setAttribute('data-visual-only', 'true');
    el.setAttribute('data-arena-fixture', 'spawn');
    const text = document.createElement('a-text');
    text.setAttribute('value', label);
    text.setAttribute('align', 'center');
    text.setAttribute('width', 2.2);
    text.setAttribute('color', '#ffffff');
    text.setAttribute('position', '0 0.7 0');
    text.setAttribute('data-visual-only', 'true');
    el.appendChild(text);
    return el;
  }

  function ensureSpawnMarkers() {
    const root = ensureRoot();
    if (!root) return;
    ['red', 'blue'].forEach((team) => {
      for (let i = 0; i < SPAWN_SLOTS; i++) {
        const id = `spawn-${team}-${i}`;
        let el = document.getElementById(id);
        if (!el) {
          const color = team === 'red' ? '#ff4444' : '#4488ff';
          el = makePyramid(id, color, `${team[0].toUpperCase()}${i}`);
          el.dataset.fixtureTeam = team;
          el.dataset.fixtureSlot = String(i);
          const s = defaultSpawn(team, i);
          el.setAttribute('position', `${s.x} ${s.y} ${s.z}`);
          el.setAttribute('rotation', `0 ${s.rotY} 0`);
          root.appendChild(el);
        }
        el.setAttribute('visible', _editorOn);
        if (_editorOn) {
          if (!el.hasAttribute('grab-surface')) el.setAttribute('grab-surface', '');
        } else {
          if (el.hasAttribute('grab-surface')) {
            stripPhysics(el);
            el.removeAttribute('grab-surface');
            el.classList.remove('grabbable-surface');
          }
        }
      }
    });
  }

  function setGoalEditable(on) {
    ['red', 'blue'].forEach((team) => {
      const goal = document.getElementById(`${team}-goal`);
      if (!goal) return;
      goal.classList.add('arena-fixture', 'arena-goal-fixture');
      goal.dataset.arenaFixture = 'goal';
      goal.setAttribute('data-arena-fixture', 'goal');
      goal.dataset.fixtureTeam = team;
      if (on) {
        if (!goal.hasAttribute('grab-surface')) goal.setAttribute('grab-surface', '');
        // Goals must stay fly-through — kill any physics the grab-surface might add
        setTimeout(() => stripPhysics(goal), 120);
        const mat = goal.getAttribute('material') || {};
        if (goal.dataset._prevOpacity === undefined) {
          goal.dataset._prevOpacity = mat.opacity != null ? String(mat.opacity) : '0.35';
        }
        goal.setAttribute('material', Object.assign({}, typeof mat === 'object' ? mat : {}, {
          opacity: 0.55,
          transparent: true
        }));
      } else {
        if (goal.hasAttribute('grab-surface')) {
          stripPhysics(goal);
          goal.removeAttribute('grab-surface');
          goal.classList.remove('grabbable-surface');
        }
        if (goal.dataset._prevOpacity !== undefined && goal.dataset._prevOpacity !== '') {
          const mat = goal.getAttribute('material') || {};
          goal.setAttribute('material', Object.assign({}, typeof mat === 'object' ? mat : {}, {
            opacity: parseFloat(goal.dataset._prevOpacity)
          }));
        }
      }
      const ring = goal.querySelector('[goal-ring], a-torus');
      if (ring) {
        ring.removeAttribute('grab-surface');
        ring.classList.remove('grabbable-surface');
        stripPhysics(ring);
      }
    });
  }

  function worldPos(el) {
    if (!el?.object3D) return null;
    const p = new THREE.Vector3();
    el.object3D.getWorldPosition(p);
    return { x: p.x, y: p.y, z: p.z };
  }

  function readYaw(el) {
    const rot = el.getAttribute('rotation') || { x: 0, y: 0, z: 0 };
    return rot.y != null ? rot.y : 0;
  }

  function syncHomesFromGoals(opts) {
    opts = opts || {};
    const F = window.CapVRFlags;
    if (!F?.HOME) return;
    ['red', 'blue'].forEach((team) => {
      const goal = document.getElementById(`${team}-goal`);
      const gp = worldPos(goal) || defaultGoal(team);
      const home = flagHomeFromGoal(gp);
      if (!home) return;
      F.HOME[team] = home;
      if (window.CapVRGame?.setTeamGoalZ) {
        window.CapVRGame.setTeamGoalZ(team, gp.z);
      } else if (window.CapVR?.TEAM_GOAL_Z) {
        window.CapVR.TEAM_GOAL_Z[team] = gp.z;
      }
      if (opts.moveHomeFlag && F.state?.[team]?.home) {
        F.resetHome?.(team, true);
      }
    });
  }

  function captureFixtures() {
    ensureSpawnMarkers();
    const goals = {};
    const spawns = { red: [], blue: [] };
    ['red', 'blue'].forEach((team) => {
      const goal = document.getElementById(`${team}-goal`);
      goals[team] = worldPos(goal) || defaultGoal(team);
      for (let i = 0; i < SPAWN_SLOTS; i++) {
        const el = document.getElementById(`spawn-${team}-${i}`);
        if (el) {
          const p = worldPos(el) || defaultSpawn(team, i);
          spawns[team].push({
            x: p.x, y: p.y, z: p.z, rotY: readYaw(el)
          });
        } else {
          spawns[team].push(defaultSpawn(team, i));
        }
      }
    });
    return {
      goals,
      spawns,
      flagHomes: {
        red: flagHomeFromGoal(goals.red),
        blue: flagHomeFromGoal(goals.blue)
      }
    };
  }

  function applyFixtures(fixtures) {
    if (!fixtures) return;
    _syncing = true;
    try {
      ensureSpawnMarkers();
      ['red', 'blue'].forEach((team) => {
        const g = fixtures.goals?.[team];
        if (g) {
          const goal = document.getElementById(`${team}-goal`);
          if (goal) {
            goal.setAttribute('position', `${g.x} ${g.y} ${g.z}`);
            if (goal.object3D) goal.object3D.position.set(g.x, g.y, g.z);
            if (goal.body?.position) goal.body.position.set(g.x, g.y, g.z);
          }
        }
        const list = fixtures.spawns?.[team] || [];
        for (let i = 0; i < SPAWN_SLOTS; i++) {
          const s = list[i] || defaultSpawn(team, i);
          const el = document.getElementById(`spawn-${team}-${i}`);
          if (el) {
            el.setAttribute('position', `${s.x} ${s.y} ${s.z}`);
            el.setAttribute('rotation', `0 ${s.rotY || 0} 0`);
            if (el.object3D) {
              el.object3D.position.set(s.x, s.y, s.z);
              el.object3D.rotation.y = ((s.rotY || 0) * Math.PI) / 180;
            }
          }
        }
      });
      syncHomesFromGoals({ moveHomeFlag: true });
    } finally {
      _syncing = false;
    }
    console.log('[CapVR] arena fixtures applied', fixtures.goals);
  }

  function getSpawn(team, idx) {
    const el = document.getElementById(`spawn-${team}-${idx % SPAWN_SLOTS}`);
    if (!el?.object3D) return null;
    const p = worldPos(el);
    if (!p) return null;
    return { x: p.x, y: p.y, z: p.z, rotY: readYaw(el) };
  }

  function setEditorMode(on) {
    _editorOn = !!on;
    ensureSpawnMarkers();
    setGoalEditable(_editorOn);
    document.querySelectorAll('.arena-spawn-marker').forEach((el) => {
      el.setAttribute('visible', _editorOn);
    });
    if (_editorOn) {
      syncHomesFromGoals({ moveHomeFlag: false });
      console.log('[CapVR] fixtures editor ON — move spawn pyramids & goals (flags follow goals)');
    }
  }

  function onFixtureMoved(el) {
    if (_syncing || !el) return;
    const kind = el.dataset?.arenaFixture || el.getAttribute('data-arena-fixture');
    if (kind === 'goal' || el.hasAttribute?.('goal')) {
      syncHomesFromGoals({ moveHomeFlag: true });
    }
  }

  function isArenaFixture(el) {
    if (!el) return false;
    if (el.classList?.contains('arena-fixture')) return true;
    if (el.dataset?.arenaFixture) return true;
    if (el.getAttribute?.('data-arena-fixture')) return true;
    if (el.id === 'arena-fixtures' || el.closest?.('#arena-fixtures')) return true;
    if (el.hasAttribute?.('goal') || el.closest?.('[goal]')) return true;
    return false;
  }

  function patchGrabSurfaceSkipFixtures() {
    const comp = AFRAME.components?.['grab-surface'];
    if (!comp?.Component?.prototype || comp.Component.prototype._capvrFixtureSkip) return;
    const proto = comp.Component.prototype;
    proto._capvrFixtureSkip = true;
    const orig = proto.createPhysicsBody;
    proto.createPhysicsBody = function () {
      if (isArenaFixture(this.el) || this.el?.hasAttribute?.('data-visual-only')) {
        // Selectable in editor, but never a solid blocker
        return;
      }
      return orig.call(this);
    };
  }

  function patchEditorLifecycle() {
    if (!AFRAME.components['capvr-fixture-bridge']) {
      AFRAME.registerComponent('capvr-fixture-bridge', {
        init: function () {
          this._was = null;
          patchGrabSurfaceSkipFixtures();
          ensureSpawnMarkers();
          setEditorMode(false);
        },
        tick: function () {
          const le = this.el.components['level-editor'];
          const on = !!le?.data?.enabled;
          if (on !== this._was) {
            this._was = on;
            setEditorMode(on);
          }
          if (on && !_syncing) {
            const sel = le?.selectedObject;
            if (sel && (sel.dataset?.arenaFixture === 'goal' || sel.hasAttribute?.('goal'))) {
              syncHomesFromGoals({ moveHomeFlag: true });
            }
          }
        }
      });
    }
    const scene = sceneEl();
    if (scene && !scene.getAttribute('capvr-fixture-bridge')) {
      scene.setAttribute('capvr-fixture-bridge', '');
    }

    document.addEventListener('mouseup', () => {
      if (!_editorOn) return;
      const le = sceneEl()?.components?.['level-editor'];
      if (le?.selectedObject) onFixtureMoved(le.selectedObject);
    });

    // Never allow Delete to wipe goals or spawn pyramids
    document.addEventListener('keydown', (e) => {
      if (!_editorOn) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const le = sceneEl()?.components?.['level-editor'];
      const sel = le?.selectedObject;
      if (sel && isArenaFixture(sel)) {
        e.preventDefault();
        e.stopPropagation();
        console.log('[CapVR] fixtures cannot be deleted — move them instead');
      }
    }, true);
  }

  window.CapVRArenaFixtures = {
    ensureSpawnMarkers,
    captureFixtures,
    applyFixtures,
    getSpawn,
    setEditorMode,
    syncHomesFromGoals,
    defaultSpawn,
    isArenaFixture,
    FLAG_INSET
  };

  function boot() {
    if (typeof AFRAME === 'undefined') {
      setTimeout(boot, 50);
      return;
    }
    patchGrabSurfaceSkipFixtures();
    patchEditorLifecycle();
    ensureSpawnMarkers();
    setEditorMode(false);
    syncHomesFromGoals({ moveHomeFlag: true });
    console.log('[CapVR] arena fixtures ready (spawn pyramids + editable goals)');
  }

  if (document.querySelector('a-scene')?.hasLoaded) boot();
  else document.querySelector('a-scene')?.addEventListener('loaded', boot, { once: true });
  // Fallback if scene element not yet parsed
  if (!document.querySelector('a-scene')) {
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelector('a-scene')?.addEventListener('loaded', boot, { once: true });
      if (document.querySelector('a-scene')?.hasLoaded) boot();
    });
  }
})();
