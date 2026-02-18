import * as THREE from 'three';

export class HudSystem {
    constructor() {
        this.container = document.getElementById('hud');
        this.compassEl = document.getElementById('hud-compass');
        this.arrowEl = document.getElementById('hud-arrow');
        this.distEl = document.getElementById('hud-distance');
        this.statusEl = document.getElementById('hud-status');
        this.scoreEl = document.getElementById('hud-score');
        this.onboardEl = document.getElementById('hud-onboard');
        this._dir = new THREE.Vector3();
        this._heliForward = new THREE.Vector3();
        this.show();
    }

    show() { if (this.container) this.container.style.display = 'block'; }
    hide() { if (this.container) this.container.style.display = 'none'; }

    update(heliMesh, rescueSystem) {
        if (!heliMesh || !rescueSystem) return;

        this.scoreEl.textContent = `Rescued: ${rescueSystem.score} / ${rescueSystem.totalPickups}`;
        this.onboardEl.textContent = rescueSystem.onBoard > 0 ? `On board: ${rescueSystem.onBoard}` : '';
        this.statusEl.textContent = rescueSystem.statusText;

        const target = rescueSystem.getActiveTarget();
        if (!target) {
            this.arrowEl.style.display = 'none';
            this.distEl.textContent = '';
            this.compassEl.textContent = '';
            return;
        }

        this._dir.subVectors(target.position, heliMesh.position);
        const dist = this._dir.length();
        this._dir.y = 0;
        this._dir.normalize();

        this._heliForward.set(0, 0, 1).applyQuaternion(heliMesh.quaternion);
        this._heliForward.y = 0;
        this._heliForward.normalize();

        const dot = this._heliForward.x * this._dir.x + this._heliForward.z * this._dir.z;
        const cross = this._heliForward.x * this._dir.z - this._heliForward.z * this._dir.x;
        const angle = Math.atan2(cross, dot) * (180 / Math.PI);

        this.arrowEl.style.display = 'block';
        this.arrowEl.style.transform = `rotate(${-angle}deg)`;

        this.distEl.textContent = `${Math.round(dist)}m`;

        const worldAngle = Math.atan2(this._dir.x, this._dir.z) * (180 / Math.PI);
        let compass = '';
        if (worldAngle > -22.5 && worldAngle <= 22.5) compass = 'N';
        else if (worldAngle > 22.5 && worldAngle <= 67.5) compass = 'NE';
        else if (worldAngle > 67.5 && worldAngle <= 112.5) compass = 'E';
        else if (worldAngle > 112.5 && worldAngle <= 157.5) compass = 'SE';
        else if (worldAngle > 157.5 || worldAngle <= -157.5) compass = 'S';
        else if (worldAngle > -157.5 && worldAngle <= -112.5) compass = 'SW';
        else if (worldAngle > -112.5 && worldAngle <= -67.5) compass = 'W';
        else compass = 'NW';
        this.compassEl.textContent = compass;

        const typeColor = target.type === 'pickup' ? '#ff4444' : '#44ff88';
        this.arrowEl.style.color = typeColor;
        this.distEl.style.color = typeColor;
    }

    createVRHud(playerGroup) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        this._vrCanvas = canvas;
        this._vrCtx = canvas.getContext('2d');

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85 });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), mat);
        plane.position.set(0, -0.6, -1.5);
        playerGroup.add(plane);
        this._vrTex = tex;
        this._vrPlane = plane;
    }

    updateVRHud(rescueSystem, target) {
        if (!this._vrCtx || !rescueSystem) return;
        const ctx = this._vrCtx;
        ctx.clearRect(0, 0, 512, 128);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.rect(0, 0, 512, 128);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = '22px Arial';
        ctx.fillText(`Rescued: ${rescueSystem.score}/${rescueSystem.totalPickups}`, 15, 30);
        if (rescueSystem.onBoard > 0) {
            ctx.fillStyle = '#ffcc00';
            ctx.fillText(`On board: ${rescueSystem.onBoard}`, 15, 60);
        }
        ctx.fillStyle = '#aaa';
        ctx.font = '18px Arial';
        const status = rescueSystem.statusText;
        ctx.fillText(status.length > 45 ? status.substring(0, 45) + '...' : status, 15, 95);

        if (target) {
            ctx.fillStyle = target.type === 'pickup' ? '#ff4444' : '#44ff88';
            ctx.fillText(this.distEl.textContent + ' ' + this.compassEl.textContent, 330, 30);
        }

        this._vrTex.needsUpdate = true;
    }
}
