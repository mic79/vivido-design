import * as THREE from 'three';

export default {
    name: 'Canyon',
    spawnPosition: new THREE.Vector3(0, 50, 0),
    fogColor: 0x87ceeb,
    fogNear: 200,
    fogFar: 2000,

    build(ctx) {
        const { scene, createRigidBody } = ctx;
        const Ammo = window.Ammo;
        const wallMat = new THREE.MeshPhongMaterial({ color: 0x5d4037, flatShading: true });

        const groundGeo = new THREE.BoxGeometry(2000, 2, 8000);
        const ground = new THREE.Mesh(groundGeo, new THREE.MeshPhongMaterial({ color: 0x3d2b1f }));
        createRigidBody(ground, new Ammo.btBoxShape(new Ammo.btVector3(1000, 1, 4000)), 0, new THREE.Vector3(0, -1, 0), new THREE.Quaternion(0, 0, 0, 1));

        for (let i = 0; i < 120; i++) {
            const z = (i - 60) * 60;
            const xOffset = Math.sin(i * 0.15) * 150;

            const lW = 200, lH = 200 + Math.random() * 500, lD = 65;
            const lWall = new THREE.Mesh(new THREE.BoxGeometry(lW, lH, lD), wallMat);
            createRigidBody(lWall, new Ammo.btBoxShape(new Ammo.btVector3(lW/2, lH/2, lD/2)), 0,
                new THREE.Vector3(xOffset - 250, lH/2, z), new THREE.Quaternion(0,0,0,1));

            const rW = 200, rH = 200 + Math.random() * 500, rD = 65;
            const rWall = new THREE.Mesh(new THREE.BoxGeometry(rW, rH, rD), wallMat);
            createRigidBody(rWall, new Ammo.btBoxShape(new Ammo.btVector3(rW/2, rH/2, rD/2)), 0,
                new THREE.Vector3(xOffset + 250, rH/2, z), new THREE.Quaternion(0,0,0,1));

            if (i % 8 === 0) {
                const pW = 30, pH = 150 + Math.random() * 200;
                const pillar = new THREE.Mesh(new THREE.BoxGeometry(pW, pH, pW), wallMat);
                createRigidBody(pillar, new Ammo.btBoxShape(new Ammo.btVector3(pW/2, pH/2, pW/2)), 0,
                    new THREE.Vector3(xOffset + (Math.random()-0.5)*150, pH/2, z + 30), new THREE.Quaternion(0,0,0,1));
            }

            if (Math.random() > 0.7) {
                const oW = 200, oH = 10, oD = 40;
                const overhang = new THREE.Mesh(new THREE.BoxGeometry(oW, oH, oD), wallMat);
                overhang.userData.breakable = true;
                createRigidBody(overhang, new Ammo.btBoxShape(new Ammo.btVector3(oW/2, oH/2, oD/2)), 0,
                    new THREE.Vector3(xOffset + (i%2===0 ? -100 : 100), 100 + Math.random()*50, z), new THREE.Quaternion(0,0,0,1));
            }
        }
    },

    getPickupPoints() { return []; },
    getDropoffPoints() { return []; },
    update(_delta) {}
};
