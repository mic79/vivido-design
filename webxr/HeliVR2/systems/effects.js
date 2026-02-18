import * as THREE from 'three';

const FIRE_COUNT = 60;
const SMOKE_COUNT = 40;

export class EffectsSystem {
    constructor(scene) {
        this.scene = scene;
        this.fireSystems = [];
        this.smokeSystems = [];
    }

    addFire(position) {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(FIRE_COUNT * 3);
        const velocities = new Float32Array(FIRE_COUNT * 3);
        for (let i = 0; i < FIRE_COUNT; i++) {
            positions[i*3]   = position.x + (Math.random()-0.5) * 6;
            positions[i*3+1] = position.y + Math.random() * 8;
            positions[i*3+2] = position.z + (Math.random()-0.5) * 6;
            velocities[i*3]   = (Math.random()-0.5) * 2;
            velocities[i*3+1] = 2 + Math.random() * 4;
            velocities[i*3+2] = (Math.random()-0.5) * 2;
        }
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0xff6600,
            size: 3,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const points = new THREE.Points(geo, mat);
        this.scene.add(points);
        this.fireSystems.push({ points, velocities, origin: position.clone(), geo });
    }

    addSmoke(position) {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(SMOKE_COUNT * 3);
        const velocities = new Float32Array(SMOKE_COUNT * 3);
        for (let i = 0; i < SMOKE_COUNT; i++) {
            positions[i*3]   = position.x + (Math.random()-0.5) * 8;
            positions[i*3+1] = position.y + Math.random() * 30;
            positions[i*3+2] = position.z + (Math.random()-0.5) * 8;
            velocities[i*3]   = (Math.random()-0.5) * 1;
            velocities[i*3+1] = 1.5 + Math.random() * 3;
            velocities[i*3+2] = (Math.random()-0.5) * 1;
        }
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0x444444,
            size: 8,
            transparent: true,
            opacity: 0.35,
            depthWrite: false
        });
        const points = new THREE.Points(geo, mat);
        this.scene.add(points);
        this.smokeSystems.push({ points, velocities, origin: position.clone(), geo });
    }

    update(delta) {
        for (const sys of this.fireSystems) {
            const pos = sys.geo.attributes.position.array;
            for (let i = 0; i < FIRE_COUNT; i++) {
                pos[i*3]   += sys.velocities[i*3] * delta;
                pos[i*3+1] += sys.velocities[i*3+1] * delta;
                pos[i*3+2] += sys.velocities[i*3+2] * delta;
                if (pos[i*3+1] > sys.origin.y + 15) {
                    pos[i*3]   = sys.origin.x + (Math.random()-0.5) * 6;
                    pos[i*3+1] = sys.origin.y;
                    pos[i*3+2] = sys.origin.z + (Math.random()-0.5) * 6;
                }
            }
            sys.geo.attributes.position.needsUpdate = true;
        }

        for (const sys of this.smokeSystems) {
            const pos = sys.geo.attributes.position.array;
            for (let i = 0; i < SMOKE_COUNT; i++) {
                pos[i*3]   += sys.velocities[i*3] * delta;
                pos[i*3+1] += sys.velocities[i*3+1] * delta;
                pos[i*3+2] += sys.velocities[i*3+2] * delta;
                if (pos[i*3+1] > sys.origin.y + 60) {
                    pos[i*3]   = sys.origin.x + (Math.random()-0.5) * 8;
                    pos[i*3+1] = sys.origin.y;
                    pos[i*3+2] = sys.origin.z + (Math.random()-0.5) * 8;
                }
            }
            sys.geo.attributes.position.needsUpdate = true;
        }
    }
}
