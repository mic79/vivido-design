import * as THREE from 'three';

const PICKUP_RADIUS = 20;
const DROPOFF_RADIUS = 20;
const LAND_VELOCITY = 2.5;
const LAND_HEIGHT = 5;

export class RescueSystem {
    constructor(scene, pickupDefs, dropoffDefs) {
        this.scene = scene;
        this.state = 'IDLE';
        this.score = 0;
        this.totalPickups = pickupDefs.length;
        this.onBoard = 0;
        this.activePickupIndex = 0;
        this.statusText = '';

        this.pickups = pickupDefs.map((def, i) => ({
            ...def,
            index: i,
            rescued: false,
            beacon: this._createBeacon(def.position, 0xff3333, def.landingY),
            person: this._createPerson(def.position, def.landingY)
        }));

        this.dropoffs = dropoffDefs.map(def => ({
            ...def,
            beacon: this._createBeacon(def.position, 0x33ff66, def.landingY)
        }));

        this._showPickupBeacons();
        this._hideDropoffBeacons();
        this._advanceToNextPickup();
    }

    _createBeacon(pos, color, landingY) {
        const group = new THREE.Group();

        const padGeo = new THREE.CylinderGeometry(8, 8, 0.3, 16);
        const padMat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.5 });
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.position.set(pos.x, (landingY || pos.y) + 0.2, pos.z);
        group.add(pad);

        const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 80, 8);
        const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3 });
        const beam = new THREE.Mesh(beamGeo, beamMat);
        beam.position.set(pos.x, (landingY || pos.y) + 40, pos.z);
        group.add(beam);

        this.scene.add(group);
        return group;
    }

    _createPerson(pos, landingY) {
        const group = new THREE.Group();
        const bodyMat = new THREE.MeshPhongMaterial({ color: 0xff8800 });

        const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 8), bodyMat);
        torso.position.y = 0.8;
        group.add(torso);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), new THREE.MeshPhongMaterial({ color: 0xffcc88 }));
        head.position.y = 1.55;
        group.add(head);

        group.position.set(pos.x + 3, (landingY || pos.y) + 0.01, pos.z + 3);
        this.scene.add(group);
        return group;
    }

    _showPickupBeacons() {
        this.pickups.forEach(p => {
            if (!p.rescued) {
                p.beacon.visible = true;
                p.person.visible = true;
            }
        });
    }

    _hidePickupBeacons() {
        this.pickups.forEach(p => { p.beacon.visible = false; p.person.visible = false; });
    }

    _showDropoffBeacons() {
        this.dropoffs.forEach(d => { d.beacon.visible = true; });
    }

    _hideDropoffBeacons() {
        this.dropoffs.forEach(d => { d.beacon.visible = false; });
    }

    _advanceToNextPickup() {
        const next = this.pickups.find(p => !p.rescued);
        if (next) {
            this.activePickupIndex = next.index;
            this.state = 'IDLE';
            this.statusText = `Rescue survivor at ${next.name}`;
        } else {
            this.state = 'COMPLETE';
            this.statusText = `All ${this.totalPickups} survivors rescued!`;
        }
    }

    getActiveTarget() {
        if (this.state === 'IDLE') {
            const p = this.pickups[this.activePickupIndex];
            return p ? { position: p.position, name: p.name, type: 'pickup' } : null;
        }
        if (this.state === 'CARRYING') {
            let nearest = null, nearDist = Infinity;
            for (const d of this.dropoffs) {
                const dist = d.position.distanceTo(this._heliPos || new THREE.Vector3());
                if (dist < nearDist) { nearDist = dist; nearest = d; }
            }
            return nearest ? { position: nearest.position, name: nearest.name, type: 'dropoff' } : null;
        }
        return null;
    }

    update(delta, heliMesh, heliBody) {
        if (this.state === 'COMPLETE') return;
        if (!heliMesh || !heliBody) return;

        this._heliPos = heliMesh.position;
        const vel = heliBody.getLinearVelocity();
        const speed = Math.sqrt(vel.x()*vel.x() + vel.y()*vel.y() + vel.z()*vel.z());
        const landed = speed < LAND_VELOCITY;

        if (this.state === 'IDLE') {
            const pickup = this.pickups[this.activePickupIndex];
            if (!pickup || pickup.rescued) { this._advanceToNextPickup(); return; }
            const dx = heliMesh.position.x - pickup.position.x;
            const dz = heliMesh.position.z - pickup.position.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            const yOk = Math.abs(heliMesh.position.y - (pickup.landingY || pickup.position.y)) < LAND_HEIGHT;
            if (dist < PICKUP_RADIUS && landed && yOk) {
                pickup.rescued = true;
                pickup.beacon.visible = false;
                pickup.person.visible = false;
                this.onBoard++;
                this.state = 'CARRYING';
                this.statusText = `Survivor on board! Deliver to a rescue point`;
                this._showDropoffBeacons();
            }
        } else if (this.state === 'CARRYING') {
            for (const dropoff of this.dropoffs) {
                const dx = heliMesh.position.x - dropoff.position.x;
                const dz = heliMesh.position.z - dropoff.position.z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                const yOk = Math.abs(heliMesh.position.y - (dropoff.landingY || dropoff.position.y)) < LAND_HEIGHT;
                if (dist < DROPOFF_RADIUS && landed && yOk) {
                    this.onBoard--;
                    this.score++;
                    this._hideDropoffBeacons();
                    this._advanceToNextPickup();
                    this._showPickupBeacons();
                    break;
                }
            }
        }

        // Animate beacons (pulse)
        const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.003);
        this.pickups.forEach(p => {
            if (p.beacon.visible) p.beacon.children.forEach(c => { c.material.opacity = pulse * 0.5; });
        });
        this.dropoffs.forEach(d => {
            if (d.beacon.visible) d.beacon.children.forEach(c => { c.material.opacity = pulse * 0.5; });
        });
    }
}
