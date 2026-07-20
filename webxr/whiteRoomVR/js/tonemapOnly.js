/**
 * OutputPass-only post path — same tonemap/color as bloom, without UnrealBloom cost.
 * Used when bloom is toggled off so floor color stays consistent while FPS improves.
 */
import AFRAME from 'aframe';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

AFRAME.registerComponent('tonemap-only', {
  schema: {
    enabled: { type: 'boolean', default: false },
  },

  init() {
    this.size = new THREE.Vector2();
    this.originalRender = null;
    this.originalSetRT = null;
    this.composer = null;
    this.renderPass = null;
    this.outputPass = null;
    this._inside = false;
  },

  update(oldData) {
    if (this.data.enabled === oldData.enabled) return;
    if (this.data.enabled) this.enable();
    else this.disable();
  },

  enable() {
    const sceneEl = this.el;
    const renderer = sceneEl.renderer;
    if (!renderer || this.composer) return;

    this.originalRender = renderer.render.bind(renderer);
    this.originalSetRT = renderer.setRenderTarget.bind(renderer);

    const resolution = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(resolution.width, resolution.height, {
      type: THREE.HalfFloatType,
      samples: 4,
    });

    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(sceneEl.object3D, sceneEl.camera);
    this.composer.addPass(this.renderPass);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    const self = this;
    renderer.render = function tonemapOnlyRender(sceneArg, cameraArg) {
      if (self._inside) {
        return self.originalRender(sceneArg, cameraArg);
      }
      // Floor reflector / blur FBOs (not the XR layer)
      const cur = renderer.getRenderTarget();
      if (cur !== null && cur.isXRRenderTarget !== true) {
        return self.originalRender(sceneArg, cameraArg);
      }

      self._inside = true;
      const presentTarget = cur; // null on desktop, XR RT while presenting
      self.renderPass.scene = sceneArg || sceneEl.object3D;
      self.renderPass.camera = cameraArg || sceneEl.camera;

      // OutputPass uses setRenderTarget(null); redirect to XR FB while presenting
      if (presentTarget !== null) {
        renderer.setRenderTarget = (target, ...rest) => {
          self.originalSetRT(target === null ? presentTarget : target, ...rest);
        };
      }
      try {
        self.composer.render();
      } finally {
        renderer.setRenderTarget = self.originalSetRT;
        self.originalSetRT(presentTarget);
        self._inside = false;
      }
    };

    this.onResize = () => {
      if (!this.composer) return;
      renderer.getSize(this.size);
      this.composer.setSize(this.size.width, this.size.height);
    };
    sceneEl.addEventListener('rendererresize', this.onResize);
  },

  disable() {
    const sceneEl = this.el;
    const renderer = sceneEl.renderer;
    if (this.onResize) {
      sceneEl.removeEventListener('rendererresize', this.onResize);
      this.onResize = null;
    }
    if (renderer && this.originalRender) {
      renderer.render = this.originalRender;
      this.originalRender = null;
    }
    if (renderer && this.originalSetRT) {
      renderer.setRenderTarget = this.originalSetRT;
      this.originalSetRT = null;
    }
    this.composer?.dispose();
    this.outputPass?.dispose();
    this.composer = null;
    this.renderPass = null;
    this.outputPass = null;
  },

  remove() {
    this.disable();
  },
});
