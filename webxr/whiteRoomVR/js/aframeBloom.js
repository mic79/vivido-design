/**
 * Exact A-Frame / spaceshooter bloom path (no A-Frame dependency).
 * Source: aframe v1.7.1 examples/showcase/post-processing/bloom.js
 *
 * spaceshooter.html defaults: threshold 0.98, strength 0.3, radius 0.15
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{ threshold?: number, strength?: number, radius?: number }} [opts]
 */
export function bindAframeBloom(renderer, scene, camera, opts = {}) {
  const threshold = opts.threshold ?? 0.98;
  const strength = opts.strength ?? 0.3;
  const radius = opts.radius ?? 0.15;

  const size = new THREE.Vector2();
  const resolution = renderer.getDrawingBufferSize(new THREE.Vector2());
  const renderTarget = new THREE.WebGLRenderTarget(resolution.width, resolution.height, {
    type: THREE.HalfFloatType,
    samples: 8,
  });

  const composer = new EffectComposer(renderer, renderTarget);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(resolution, strength, radius, threshold);
  composer.addPass(bloomPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const originalRender = renderer.render.bind(renderer);
  let isInsideComposerRender = false;

  // Identical to A-Frame bloom.bind()
  renderer.render = function () {
    if (isInsideComposerRender) {
      originalRender.apply(this, arguments);
    } else {
      isInsideComposerRender = true;
      renderPass.camera = camera;
      // When XR is presenting, originalRender (inside RenderPass) swaps to xr.getCamera()
      composer.render();
      isInsideComposerRender = false;
    }
  };

  function resize() {
    renderer.getSize(size);
    composer.setSize(size.width, size.height);
    bloomPass.resolution.set(size.width, size.height);
  }

  return {
    composer,
    bloomPass,
    resize,
    dispose() {
      renderer.render = originalRender;
      bloomPass.dispose();
      outputPass.dispose();
      composer.dispose();
    },
  };
}
