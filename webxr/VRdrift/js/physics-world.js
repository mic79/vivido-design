(function () {
  const C = window.VRDRIFT;

  const world = new CANNON.World();
  world.gravity.set(0, C.GRAVITY, 0);
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = 12;

  const defaultMat = new CANNON.Material('drift-default');
  const floorMat = new CANNON.Material('drift-floor');
  const playerMat = new CANNON.Material('drift-player');
  const gameBallMat = new CANNON.Material('drift-game-ball');
  const palmMat = new CANNON.Material('drift-palm');

  function contact(a, b, opts) {
    world.addContactMaterial(new CANNON.ContactMaterial(a, b, opts));
  }

  contact(floorMat, playerMat, { friction: 0.42, restitution: 0.02 });
  contact(defaultMat, playerMat, { friction: 0.36, restitution: 0.04 });
  contact(playerMat, playerMat, { friction: 0.2, restitution: 0.08 });

  const ballF = C.GAME_BALL_FRICTION != null ? C.GAME_BALL_FRICTION : 0.22;
  const ballR = C.GAME_BALL_RESTITUTION != null ? C.GAME_BALL_RESTITUTION : 0.52;
  const palmF = C.PALM_BALL_FRICTION != null ? C.PALM_BALL_FRICTION : 0.55;
  const palmR = C.PALM_BALL_RESTITUTION != null ? C.PALM_BALL_RESTITUTION : 0.06;
  const bodyF = C.PLAYER_BALL_FRICTION != null ? C.PLAYER_BALL_FRICTION : 0.52;
  const bodyR = C.PLAYER_BALL_RESTITUTION != null ? C.PLAYER_BALL_RESTITUTION : 0.08;
  contact(gameBallMat, floorMat, { friction: ballF, restitution: ballR });
  contact(gameBallMat, defaultMat, { friction: ballF, restitution: ballR * 0.95 });
  contact(gameBallMat, palmMat, { friction: palmF, restitution: palmR });
  contact(gameBallMat, playerMat, { friction: bodyF, restitution: bodyR });

  let stepAccum = 0;

  window.VRDriftPhysics = {
    world: world,
    defaultMat: defaultMat,
    floorMat: floorMat,
    playerMat: playerMat,
    gameBallMat: gameBallMat,
    palmMat: palmMat,

    stepWorld: function (dt) {
      if (!dt || dt <= 0) return;
      stepAccum += dt;
      const step = 1 / C.PHYSICS_HZ;
      const maxSubsteps = 3;
      let n = 0;
      while (stepAccum >= step && n < maxSubsteps) {
        world.step(step);
        stepAccum -= step;
        n++;
      }
      if (stepAccum > step * 2) stepAccum = step;
    },

    geometryFromElement: function (el) {
      const comp = el.components && el.components.geometry;
      if (comp && comp.data) {
        const d = comp.data;
        return {
          primitive: d.primitive || 'box',
          width: d.width,
          height: d.height,
          depth: d.depth,
          radius: d.radius
        };
      }
      const attr = el.getAttribute('geometry');
      if (attr && (attr.primitive || attr.width || attr.radius)) {
        return {
          primitive: attr.primitive || 'box',
          width: attr.width,
          height: attr.height,
          depth: attr.depth,
          radius: attr.radius
        };
      }
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'a-box') {
        return {
          primitive: 'box',
          width: parseFloat(el.getAttribute('width')) || 1,
          height: parseFloat(el.getAttribute('height')) || 1,
          depth: parseFloat(el.getAttribute('depth')) || 1
        };
      }
      if (tag === 'a-cylinder') {
        return {
          primitive: 'cylinder',
          radius: parseFloat(el.getAttribute('radius')) || 0.5,
          height: parseFloat(el.getAttribute('height')) || 2
        };
      }
      return null;
    },

    addStaticFromElement: function (el, material) {
      if (el._driftStaticBody) return el._driftStaticBody;
      const geo = this.geometryFromElement(el);
      if (!geo) return null;
      el.object3D.updateMatrixWorld(true);
      const pos = new THREE.Vector3();
      el.object3D.getWorldPosition(pos);
      const q = el.object3D.quaternion;
      const prim = geo.primitive || 'box';
      const body = new CANNON.Body({ mass: 0, material: material || defaultMat });
      if (prim === 'cylinder') {
        const r = geo.radius || 0.5;
        const h = geo.height || 2;
        const cyl = new CANNON.Cylinder(r, r, h, 12);
        const align = new CANNON.Quaternion();
        align.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI * 0.5);
        body.addShape(cyl, new CANNON.Vec3(0, 0, 0), align);
      } else {
        const box = new CANNON.Box(
          new CANNON.Vec3(
            (Number(geo.width) || 1) / 2,
            (Number(geo.height) || 1) / 2,
            (Number(geo.depth) || 1) / 2
          )
        );
        body.addShape(box);
      }
      body.position.set(pos.x, pos.y, pos.z);
      body.quaternion.set(q.x, q.y, q.z, q.w);
      world.addBody(body);
      el._driftStaticBody = body;
      return body;
    }
  };

  /* Arena registers static bodies on load; stepping runs from drift-locomotion after forces. */
  AFRAME.registerComponent('drift-physics-world', {
    init: function () {}
  });
})();
