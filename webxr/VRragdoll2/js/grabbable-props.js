/**
 * Grabbable props — inverse hand coupling (pull hand down → body up), fixed anchor on prop.
 */
import * as THREE from 'three';

/** @typedef {'bar' | 'pipe'} PropKind */

/**
 * @typedef {object} GrabMeta
 * @property {THREE.Vector3} anchorOnProp — fixed world point on the prop at grab
 * @property {THREE.Vector3} handLocalStart — grip in crouchViewGroup space at grab
 * @property {boolean} syncNextFrame — re-anchor on first step after grab (no snap)
 * @property {THREE.Vector3} rigStart — camera rig world pos at grab
 * @property {number} maxRigY
 * @property {PropKind} kind
 */

/**
 * @typedef {object} PropDef
 * @property {string} id
 * @property {PropKind} kind
 * @property {THREE.Mesh} mesh
 * @property {THREE.Vector3} a
 * @property {THREE.Vector3} b
 * @property {number} grabRadius
 * @property {number} climbHeight
 */

export class GrabbablePropManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('@dimforge/rapier3d-compat').World} world
   * @param {typeof import('@dimforge/rapier3d-compat')} RAPIER
   */
  constructor(scene, world, RAPIER) {
    this.scene = scene;
    this.world = world;
    this.RAPIER = RAPIER;
    /** @type {PropDef[]} */
    this.props = [];
    /** @type {{ left: string | null, right: string | null }} */
    this.grabbedId = { left: null, right: null };
    /** @type {{ left: THREE.Vector3, right: THREE.Vector3 }} */
    this.grabPointWorld = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    /** @type {{ left: GrabMeta | null, right: GrabMeta | null }} */
    this.grabMeta = { left: null, right: null };
    this._seg = new THREE.Vector3();
    this._closest = new THREE.Vector3();
    this._pt = new THREE.Vector3();
    this._handDelta = new THREE.Vector3();
    this._handNow = new THREE.Vector3();
    this._targetRig = new THREE.Vector3();
    this._rigQuat = new THREE.Quaternion();
  }

  addBar(opts) {
    const { id, center, lengthX, thickness, color = 0x6b8cae } = opts;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(lengthX, thickness, thickness),
      new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.15 })
    );
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const half = lengthX * 0.5;
    const a = new THREE.Vector3(center.x - half, center.y, center.z);
    const b = new THREE.Vector3(center.x + half, center.y, center.z);

    const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z));
    this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(half, thickness * 0.5, thickness * 0.5),
      body
    );

    this.props.push({
      id,
      kind: 'bar',
      mesh,
      a,
      b,
      grabRadius: 0.22,
      climbHeight: 1.6
    });
  }

  addPipe(opts) {
    const { id, base, height, radius, color = 0x7a9e6a } = opts;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.12 })
    );
    mesh.position.set(base.x, base.y + height * 0.5, base.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const a = new THREE.Vector3(base.x, base.y, base.z);
    const b = new THREE.Vector3(base.x, base.y + height, base.z);

    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.fixed().setTranslation(base.x, base.y + height * 0.5, base.z)
    );
    this.world.createCollider(this.RAPIER.ColliderDesc.cylinder(height * 0.5, radius), body);

    this.props.push({
      id,
      kind: 'pipe',
      mesh,
      a,
      b,
      grabRadius: 0.2,
      climbHeight: height
    });
  }

  _syncSegmentFromMesh(prop) {
    prop.mesh.updateMatrixWorld(true);
    const c = prop.mesh.position;
    if (prop.kind === 'bar') {
      const hx = prop.mesh.geometry.parameters.width * 0.5;
      prop.a.set(c.x - hx, c.y, c.z);
      prop.b.set(c.x + hx, c.y, c.z);
    } else {
      const h = prop.mesh.geometry.parameters.height;
      prop.a.set(c.x, c.y - h * 0.5, c.z);
      prop.b.set(c.x, c.y + h * 0.5, c.z);
    }
  }

  _closestOnSegment(point, a, b, out) {
    this._seg.subVectors(b, a);
    const lenSq = this._seg.lengthSq();
    if (lenSq < 1e-10) return out.copy(a);
    this._pt.subVectors(point, a);
    const t = Math.max(0, Math.min(1, this._seg.dot(this._pt) / lenSq));
    return out.copy(a).addScaledVector(this._seg, t);
  }

  findClosestGrab(handPos, maxDist = 0.32) {
    let best = null;
    let bestD = maxDist;
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      this._syncSegmentFromMesh(prop);
      this._closestOnSegment(handPos, prop.a, prop.b, this._closest);
      const d = handPos.distanceTo(this._closest);
      if (d < bestD) {
        bestD = d;
        best = { prop, point: this._closest.clone(), dist: d };
      }
    }
    return best;
  }

  /**
   * @param {THREE.Vector3} handPos — world (for hit test)
   * @param {'left' | 'right'} hand
   * @param {THREE.Object3D} cameraRig
   * @param {THREE.Object3D} grip — controller grip in crouchViewGroup
   */
  tryGrab(handPos, hand, cameraRig, grip) {
    if (this.grabbedId[hand]) return false;
    const hit = this.findClosestGrab(handPos);
    if (!hit) return false;

    const prop = hit.prop;
    this.grabbedId[hand] = prop.id;
    this.grabPointWorld[hand].copy(hit.point);

    const maxRigY = cameraRig.position.y + prop.climbHeight;

    this.grabMeta[hand] = {
      anchorOnProp: hit.point.clone(),
      handLocalStart: grip.position.clone(),
      rigStart: cameraRig.position.clone(),
      maxRigY,
      kind: prop.kind,
      syncNextFrame: true
    };
    return true;
  }

  /** @param {'left' | 'right'} hand */
  releaseGrab(hand) {
    this.grabbedId[hand] = null;
    this.grabMeta[hand] = null;
  }

  _propById(id) {
    if (!id) return null;
    for (let i = 0; i < this.props.length; i++) {
      if (this.props[i].id === id) return this.props[i];
    }
    return null;
  }

  get anyGrabActive() {
    return !!(this.grabbedId.left || this.grabbedId.right);
  }

  get isClimbingPipe() {
    const l = this._propById(this.grabbedId.left);
    const r = this._propById(this.grabbedId.right);
    return l?.kind === 'pipe' || r?.kind === 'pipe';
  }

  get maxClimbY() {
    let maxY = 0;
    for (const side of ['left', 'right']) {
      const meta = this.grabMeta[side];
      if (meta) maxY = Math.max(maxY, meta.maxRigY);
    }
    return maxY;
  }

  /**
   * Rig moves opposite to hand motion in rig space (pull hand down → body up). Anchor stays on prop.
   * @param {{ left?: { grip: THREE.Object3D }, right?: { grip: THREE.Object3D }} | null} hands
   * @param {THREE.Object3D} cameraRig
   */
  stepGrabs(hands, cameraRig) {
    if (!hands) return;

    let n = 0;
    this._targetRig.set(0, 0, 0);
    let limitY = 0.05;
    cameraRig.getWorldQuaternion(this._rigQuat);

    for (const side of ['left', 'right']) {
      const id = this.grabbedId[side];
      const h = hands[side];
      const meta = this.grabMeta[side];
      if (!id || !h?.grip || !meta) continue;

      if (meta.syncNextFrame) {
        meta.handLocalStart.copy(h.grip.position);
        meta.rigStart.copy(cameraRig.position);
        meta.syncNextFrame = false;
        continue;
      }

      this._handNow.copy(h.grip.position);
      this._handDelta.subVectors(this._handNow, meta.handLocalStart);
      this._handDelta.applyQuaternion(this._rigQuat);

      this._targetRig.x += meta.rigStart.x - this._handDelta.x;
      this._targetRig.y += meta.rigStart.y - this._handDelta.y;
      this._targetRig.z += meta.rigStart.z - this._handDelta.z;

      limitY = Math.max(limitY, meta.maxRigY);
      n++;
    }

    if (n === 0) return;

    this._targetRig.multiplyScalar(1 / n);
    this._targetRig.y = THREE.MathUtils.clamp(this._targetRig.y, 0, limitY);

    cameraRig.position.copy(this._targetRig);
  }

  fillCollisionSegments(out) {
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      this._syncSegmentFromMesh(prop);
      const segRadius = prop.kind === 'bar' ? 0.055 : 0.06;
      out.push({ a: prop.a, b: prop.b, segRadius });
    }
  }
}
