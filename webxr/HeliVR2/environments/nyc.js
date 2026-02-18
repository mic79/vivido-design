import * as THREE from 'three';
import { EffectsSystem } from '../systems/effects.js';

const STREET_W = 20;
const BLOCK_SIZE = 60;
const GRID_STEP = BLOCK_SIZE + STREET_W;
const RIVER_X_MIN = -50;
const RIVER_X_MAX = 50;
const RIVER_WIDTH = RIVER_X_MAX - RIVER_X_MIN;

const DISTRICTS = [
    { name: 'Downtown',   xMin: -950, xMax: -100, zMin:  400, zMax:  950, hMin: 80,  hMax: 250, density: 0.8, color: 0x5a6577, damaged: true  },
    { name: 'Midtown',    xMin: -950, xMax: -100, zMin:    0, zMax:  400, hMin: 50,  hMax: 120, density: 0.7, color: 0x7a8a96, damaged: true  },
    { name: 'CentralPark',xMin: -950, xMax: -100, zMin: -400, zMax:    0, hMin:  0,  hMax:   0, density: 0,   color: 0x48bb78, isPark: true   },
    { name: 'Uptown',     xMin: -950, xMax: -100, zMin: -950, zMax: -400, hMin: 40,  hMax: 100, density: 0.6, color: 0x9aa5b0, damaged: false },
    { name: 'Industrial', xMin:  100, xMax:  950, zMin:  400, zMax:  950, hMin: 15,  hMax:  50, density: 0.5, color: 0x8b7355, damaged: true  },
    { name: 'Residential',xMin:  100, xMax:  950, zMin:    0, zMax:  400, hMin: 20,  hMax:  50, density: 0.6, color: 0xc4b5a0, damaged: false },
    { name: 'Medical',    xMin:  100, xMax:  950, zMin: -400, zMax:    0, hMin: 30,  hMax:  80, density: 0.4, color: 0xe8e8e8, damaged: false },
    { name: 'Suburbs',    xMin:  100, xMax:  950, zMin: -950, zMax: -400, hMin: 10,  hMax:  30, density: 0.4, color: 0xd4c5a9, damaged: false },
];

const BRIDGES = [
    { z: 700,  label: 'Brooklyn Bridge' },
    { z: 200,  label: 'Midtown Bridge' },
    { z: -200, label: 'Park Bridge' },
];

const OVERPASS_ROUTES = [
    { x: -500, zMin: -800, zMax: 800, y: 18 },
    { x:  500, zMin: -600, zMax: 700, y: 18 },
];

const PICKUP_DEFS = [
    { name: 'Downtown Rooftop',       position: new THREE.Vector3(-400, 160, 700),  landingY: 160 },
    { name: 'Financial Plaza',         position: new THREE.Vector3(-600,   1, 850),  landingY: 1   },
    { name: 'Midtown Office',          position: new THREE.Vector3(-350,  90, 250),  landingY: 90  },
    { name: 'Highway Overpass',        position: new THREE.Vector3(-500,  19, 100),  landingY: 19  },
    { name: 'Park Pavilion',           position: new THREE.Vector3(-600,   1, -200), landingY: 1   },
    { name: 'Brooklyn Bridge',         position: new THREE.Vector3(   0,  26, 700),  landingY: 26  },
    { name: 'Industrial Warehouse',    position: new THREE.Vector3( 350,  35, 600),  landingY: 35  },
    { name: 'Residential Block',       position: new THREE.Vector3( 400,   1, 300),  landingY: 1   },
    { name: 'Medical Courtyard',       position: new THREE.Vector3( 300,   1, -100), landingY: 1   },
    { name: 'Suburb Park',             position: new THREE.Vector3( 500,   1, -600), landingY: 1   },
    { name: 'Park Bridge',             position: new THREE.Vector3(   0,  26, -200), landingY: 26  },
    { name: 'Uptown Apartment',        position: new THREE.Vector3(-400,  65, -600), landingY: 65  },
];

const DROPOFF_DEFS = [
    { name: 'City Hospital Helipad',   position: new THREE.Vector3( 200,  61, -50),  landingY: 61  },
    { name: 'Central Park LZ',         position: new THREE.Vector3(-500,   1,  -80), landingY: 1   },
    { name: 'Fire Station',            position: new THREE.Vector3(-700,   1,  350), landingY: 1   },
    { name: 'Downtown Parking',        position: new THREE.Vector3(-800,   1,  650), landingY: 1   },
    { name: 'School Yard',             position: new THREE.Vector3( 600,   1,  250), landingY: 1   },
    { name: 'Church Square',           position: new THREE.Vector3( 400,   1, -750), landingY: 1   },
    { name: 'Dock Rescue',             position: new THREE.Vector3( 750,   1,  800), landingY: 1   },
    { name: 'Suburb Clinic',           position: new THREE.Vector3( 500,   1, -450), landingY: 1   },
    { name: 'Uptown Plaza',            position: new THREE.Vector3(-700,   1, -800), landingY: 1   },
    { name: 'Midtown Bridge Staging',  position: new THREE.Vector3(   0,  26,  200), landingY: 26  },
    { name: 'East Side Clinic',        position: new THREE.Vector3( 300,   1,  200), landingY: 1   },
    { name: 'Stadium Field',           position: new THREE.Vector3(-250,   1, -700), landingY: 1   },
];

let effects = null;
const buildingTops = [];
const damagePositions = [];

function seededRandom(seed) {
    let s = seed;
    return function() {
        s = (s * 16807 + 0) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

export default {
    name: 'NYC Rescue',
    spawnPosition: new THREE.Vector3(-300, 80, 0),
    fogColor: 0x8899aa,
    fogNear: 300,
    fogFar: 2500,

    build(ctx) {
        const { scene, createRigidBody } = ctx;
        const Ammo = window.Ammo;
        const rand = seededRandom(42);
        buildingTops.length = 0;
        damagePositions.length = 0;

        effects = new EffectsSystem(scene);

        // Ground planes
        const groundMat = new THREE.MeshPhongMaterial({ color: 0x333333 });
        const westGround = new THREE.Mesh(new THREE.BoxGeometry(900, 2, 1900), groundMat);
        createRigidBody(westGround, new Ammo.btBoxShape(new Ammo.btVector3(450, 1, 950)), 0,
            new THREE.Vector3(-525, -1, 0), new THREE.Quaternion(0,0,0,1));
        const eastGround = new THREE.Mesh(new THREE.BoxGeometry(900, 2, 1900), groundMat);
        createRigidBody(eastGround, new Ammo.btBoxShape(new Ammo.btVector3(450, 1, 950)), 0,
            new THREE.Vector3(525, -1, 0), new THREE.Quaternion(0,0,0,1));

        // River
        const riverGeo = new THREE.PlaneGeometry(RIVER_WIDTH, 1900);
        const riverMat = new THREE.MeshPhongMaterial({ color: 0x1a5276, transparent: true, opacity: 0.7 });
        const river = new THREE.Mesh(riverGeo, riverMat);
        river.rotation.x = -Math.PI / 2;
        river.position.set(0, -0.3, 0);
        scene.add(river);

        // Street markings on ground (yellow center lines along Z avenues)
        const lineMat = new THREE.MeshBasicMaterial({ color: 0xccaa00 });
        for (let side = -1; side <= 1; side += 2) {
            const baseX = side === -1 ? -950 : 100;
            for (let x = baseX + BLOCK_SIZE; x < baseX + 850; x += GRID_STEP) {
                const line = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 1900), lineMat);
                line.position.set(x + STREET_W/2, 0.02, 0);
                scene.add(line);
            }
        }

        // Districts - buildings
        for (const dist of DISTRICTS) {
            if (dist.isPark) {
                this._buildPark(scene, dist, rand);
                continue;
            }
            const mat = new THREE.MeshPhongMaterial({ color: dist.color, flatShading: true });
            const damagedMat = new THREE.MeshPhongMaterial({ color: 0x3a3a3a, flatShading: true });

            for (let x = dist.xMin + 10; x < dist.xMax - 10; x += GRID_STEP) {
                for (let z = dist.zMin + 10; z < dist.zMax - 10; z += GRID_STEP) {
                    if (rand() > dist.density) continue;

                    const bCount = 1 + Math.floor(rand() * 2);
                    for (let b = 0; b < bCount; b++) {
                        const bw = 15 + rand() * 30;
                        const bd = 15 + rand() * 30;
                        const bh = dist.hMin + rand() * (dist.hMax - dist.hMin);
                        const bx = x + rand() * (BLOCK_SIZE - bw);
                        const bz = z + rand() * (BLOCK_SIZE - bd);

                        const isDamaged = dist.damaged && rand() < 0.2;
                        const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), isDamaged ? damagedMat : mat);
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;

                        const pos = new THREE.Vector3(bx, bh/2, bz);
                        const quat = new THREE.Quaternion(0,0,0,1);

                        if (isDamaged && rand() < 0.5) {
                            const tiltAxis = rand() < 0.5 ? 'x' : 'z';
                            const tiltAngle = (rand() - 0.5) * 0.2;
                            const euler = new THREE.Euler(
                                tiltAxis === 'x' ? tiltAngle : 0,
                                0,
                                tiltAxis === 'z' ? tiltAngle : 0
                            );
                            quat.setFromEuler(euler);
                            damagePositions.push(new THREE.Vector3(bx, bh, bz));
                        }

                        createRigidBody(mesh, new Ammo.btBoxShape(new Ammo.btVector3(bw/2, bh/2, bd/2)), 0, pos, quat);
                        buildingTops.push({ x: bx, y: bh, z: bz, district: dist.name });

                        // Rooftop details on taller buildings
                        if (bh > 60 && rand() < 0.4) {
                            const detail = new THREE.Mesh(
                                new THREE.BoxGeometry(2, 4, 2),
                                new THREE.MeshPhongMaterial({ color: 0x999999 })
                            );
                            detail.position.set(bx, bh + 2, bz);
                            scene.add(detail);
                        }

                        // Rubble at base of damaged buildings
                        if (isDamaged) {
                            for (let r = 0; r < 5; r++) {
                                const rw = 1 + rand() * 3;
                                const rubble = new THREE.Mesh(
                                    new THREE.BoxGeometry(rw, rw * 0.5, rw),
                                    damagedMat
                                );
                                rubble.position.set(
                                    bx + (rand()-0.5) * bw,
                                    rw * 0.25,
                                    bz + (rand()-0.5) * bd
                                );
                                rubble.rotation.set(rand(), rand(), rand());
                                scene.add(rubble);
                            }
                        }
                    }
                }
            }
        }

        // Bridges
        for (const bridge of BRIDGES) {
            this._buildBridge(scene, createRigidBody, Ammo, bridge.z, 25);
        }

        // Overpasses
        for (const route of OVERPASS_ROUTES) {
            this._buildOverpass(scene, createRigidBody, Ammo, route);
        }

        // Fire & smoke at damage points
        const firePoints = damagePositions.slice(0, 18);
        for (const fp of firePoints) {
            effects.addFire(fp);
            effects.addSmoke(new THREE.Vector3(fp.x, fp.y + 5, fp.z));
        }

        // Ensure there are fire effects even if few damaged buildings were generated
        if (firePoints.length < 8) {
            const extraFires = [
                new THREE.Vector3(-400, 120, 650),
                new THREE.Vector3(-300, 80, 500),
                new THREE.Vector3(-700, 60, 200),
                new THREE.Vector3(300, 30, 550),
                new THREE.Vector3(200, 40, 700),
            ];
            for (const ef of extraFires) {
                effects.addFire(ef);
                effects.addSmoke(new THREE.Vector3(ef.x, ef.y + 5, ef.z));
            }
        }

        // Landing platforms at pickup/dropoff locations that are at ground level
        const padMat = new THREE.MeshPhongMaterial({ color: 0xdddddd });
        const allPoints = [...PICKUP_DEFS, ...DROPOFF_DEFS];
        for (const pt of allPoints) {
            if (pt.landingY <= 1) {
                const pad = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 0.2, 16), padMat);
                pad.position.set(pt.position.x, 0.1, pt.position.z);
                pad.receiveShadow = true;
                scene.add(pad);
            }
        }

        // Hospital building with helipad (Medical district, position matches dropoff)
        const hospMat = new THREE.MeshPhongMaterial({ color: 0xffffff });
        const hosp = new THREE.Mesh(new THREE.BoxGeometry(40, 60, 40), hospMat);
        createRigidBody(hosp, new Ammo.btBoxShape(new Ammo.btVector3(20, 30, 20)), 0,
            new THREE.Vector3(200, 30, -50), new THREE.Quaternion(0,0,0,1));
        // Red cross on hospital
        const crossH = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 3), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
        crossH.position.set(200, 60.3, -50);
        scene.add(crossH);
        const crossV = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 12), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
        crossV.position.set(200, 60.3, -50);
        scene.add(crossV);
        // Helipad circle on roof
        const helipad = new THREE.Mesh(
            new THREE.RingGeometry(5, 7, 24),
            new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide })
        );
        helipad.rotation.x = -Math.PI / 2;
        helipad.position.set(200, 60.4, -50);
        scene.add(helipad);
    },

    _buildPark(scene, dist, rand) {
        const parkMat = new THREE.MeshPhongMaterial({ color: 0x3a7d44 });
        const parkGround = new THREE.Mesh(
            new THREE.BoxGeometry(dist.xMax - dist.xMin, 0.5, dist.zMax - dist.zMin),
            parkMat
        );
        parkGround.position.set(
            (dist.xMin + dist.xMax) / 2,
            0.1,
            (dist.zMin + dist.zMax) / 2
        );
        parkGround.receiveShadow = true;
        scene.add(parkGround);

        const trunkMat = new THREE.MeshPhongMaterial({ color: 0x5c4033 });
        const leafMat = new THREE.MeshPhongMaterial({ color: 0x228b22 });

        for (let i = 0; i < 80; i++) {
            const tx = dist.xMin + 30 + rand() * (dist.xMax - dist.xMin - 60);
            const tz = dist.zMin + 30 + rand() * (dist.zMax - dist.zMin - 60);
            const th = 6 + rand() * 10;

            const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, th, 6), trunkMat);
            trunk.position.set(tx, th/2, tz);
            trunk.castShadow = true;
            scene.add(trunk);

            const canopySize = 3 + rand() * 5;
            const canopy = new THREE.Mesh(new THREE.SphereGeometry(canopySize, 8, 6), leafMat);
            canopy.position.set(tx, th + canopySize * 0.5, tz);
            canopy.castShadow = true;
            scene.add(canopy);
        }

        // Pathways
        const pathMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa });
        const pathH = new THREE.Mesh(new THREE.BoxGeometry(dist.xMax - dist.xMin - 40, 0.1, 4), pathMat);
        pathH.position.set((dist.xMin + dist.xMax)/2, 0.15, (dist.zMin + dist.zMax)/2);
        scene.add(pathH);
        const pathV = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, dist.zMax - dist.zMin - 40), pathMat);
        pathV.position.set((dist.xMin + dist.xMax)/2, 0.15, (dist.zMin + dist.zMax)/2);
        scene.add(pathV);
    },

    _buildBridge(scene, createRigidBody, Ammo, z, deckY) {
        const deckMat = new THREE.MeshPhongMaterial({ color: 0x888888 });
        const cableMat = new THREE.MeshPhongMaterial({ color: 0x555555 });
        const towerMat = new THREE.MeshPhongMaterial({ color: 0x666666 });

        // Deck
        const deckW = RIVER_WIDTH + 60;
        const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 2, 25), deckMat);
        createRigidBody(deck, new Ammo.btBoxShape(new Ammo.btVector3(deckW/2, 1, 12.5)), 0,
            new THREE.Vector3(0, deckY, z), new THREE.Quaternion(0,0,0,1));

        // Railings
        const railMat = new THREE.MeshPhongMaterial({ color: 0x444444 });
        for (const side of [-1, 1]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(deckW, 3, 0.5), railMat);
            rail.position.set(0, deckY + 2.5, z + side * 12);
            scene.add(rail);
        }

        // Towers at each end
        const towerH = 60;
        for (const xSide of [RIVER_X_MIN - 10, RIVER_X_MAX + 10]) {
            const tower = new THREE.Mesh(new THREE.BoxGeometry(4, towerH, 4), towerMat);
            tower.position.set(xSide, deckY + towerH/2, z);
            tower.castShadow = true;
            scene.add(tower);

            // Suspension cables (simplified as angled cylinders)
            for (const zOff of [-8, 0, 8]) {
                const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 40, 4), cableMat);
                cable.position.set(xSide + (xSide < 0 ? 20 : -20), deckY + towerH * 0.6, z + zOff);
                cable.rotation.z = xSide < 0 ? 0.6 : -0.6;
                scene.add(cable);
            }
        }
    },

    _buildOverpass(scene, createRigidBody, Ammo, route) {
        const roadMat = new THREE.MeshPhongMaterial({ color: 0x555555 });
        const pillarMat = new THREE.MeshPhongMaterial({ color: 0x777777 });
        const totalLen = route.zMax - route.zMin;

        // Road deck segments
        const segLen = 80;
        for (let z = route.zMin; z < route.zMax; z += segLen) {
            const seg = new THREE.Mesh(new THREE.BoxGeometry(16, 1.5, segLen), roadMat);
            createRigidBody(seg, new Ammo.btBoxShape(new Ammo.btVector3(8, 0.75, segLen/2)), 0,
                new THREE.Vector3(route.x, route.y, z + segLen/2), new THREE.Quaternion(0,0,0,1));

            // Support pillars
            if ((z - route.zMin) % 160 < segLen) {
                for (const xOff of [-6, 6]) {
                    const pillar = new THREE.Mesh(new THREE.BoxGeometry(2, route.y, 2), pillarMat);
                    pillar.position.set(route.x + xOff, route.y / 2, z + segLen/2);
                    scene.add(pillar);
                }
            }
        }

        // Railings along overpass
        for (const side of [-1, 1]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, totalLen), new THREE.MeshPhongMaterial({ color: 0x444444 }));
            rail.position.set(route.x + side * 8, route.y + 1.5, (route.zMin + route.zMax)/2);
            scene.add(rail);
        }
    },

    getPickupPoints() { return PICKUP_DEFS; },
    getDropoffPoints() { return DROPOFF_DEFS; },

    update(delta) {
        if (effects) effects.update(delta);
    }
};
