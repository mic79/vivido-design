/** Dynamic shadows — helps judge hand/ball distance to floor and props. */
(function () {
  const THREE = window.THREE;

  function applyShadowFlags(root, cast, receive) {
    if (!root) return;
    root.traverse((node) => {
      if (!node.isMesh) return;
      if (cast != null) node.castShadow = cast;
      if (receive != null) node.receiveShadow = receive;
    });
  }

  window.VRDriftShadows = {
    apply: applyShadowFlags,

    enableRenderer: function (sceneEl) {
      const renderer = sceneEl && sceneEl.renderer;
      if (!renderer || !renderer.shadowMap) return;
      renderer.shadowMap.enabled = true;
      if (THREE && THREE.PCFSoftShadowMap) {
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    }
  };

  AFRAME.registerComponent('drift-shadow-follow', {
    schema: {
      height: { type: 'number', default: 4.5 },
      side: { type: 'number', default: 2.2 },
      forward: { type: 'number', default: 1.8 },
      lookDown: { type: 'number', default: 1.1 }
    },

    tick: function () {
      const camera = document.querySelector('#camera');
      if (!camera) return;
      const head = new THREE.Vector3();
      camera.object3D.getWorldPosition(head);
      const d = this.data;
      this.el.object3D.position.set(
        head.x + d.side,
        head.y + d.height,
        head.z + d.forward
      );
      this.el.object3D.lookAt(head.x, head.y - d.lookDown, head.z);
    }
  });

  AFRAME.registerComponent('drift-shadows', {
    init: function () {
      const sceneEl = this.el;
      const onReady = () => {
        VRDriftShadows.enableRenderer(sceneEl);
        this.setupDirectionalLight();
        this.enableSceneShadows();
      };
      if (sceneEl.hasLoaded) onReady();
      else sceneEl.addEventListener('loaded', onReady);
      sceneEl.addEventListener('enter-vr', () => this.enableSceneShadows());
    },

    setupDirectionalLight: function () {
      const el = document.querySelector('#shadow-light');
      if (!el) return;
      const light = el.getObject3D && el.getObject3D('light');
      if (!light) return;
      light.castShadow = true;
      light.shadow.mapSize.width = 2048;
      light.shadow.mapSize.height = 2048;
      light.shadow.camera.near = 0.25;
      light.shadow.camera.far = 65;
      light.shadow.camera.left = -28;
      light.shadow.camera.right = 28;
      light.shadow.camera.top = 28;
      light.shadow.camera.bottom = -28;
      light.shadow.bias = -0.00035;
      light.shadow.normalBias = 0.02;
    },

    enableSceneShadows: function () {
      const arena = document.querySelector('#arena');
      if (arena) applyShadowFlags(arena.object3D, true, true);

      const ball = document.querySelector('#arena-game-ball');
      if (ball) applyShadowFlags(ball.object3D, true, true);

      ['#leftHand', '#rightHand'].forEach((sel) => {
        const hand = document.querySelector(sel);
        if (hand) applyShadowFlags(hand.object3D, true, false);
      });
    }
  });
})();
