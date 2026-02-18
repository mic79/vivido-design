import { Game } from './game.js';
import canyonEnv from './environments/canyon.js';
import nycEnv from './environments/nyc.js';

const envs = { canyon: canyonEnv, nyc: nycEnv };

document.querySelectorAll('#menu button[data-env]').forEach(btn => {
    btn.addEventListener('click', () => {
        const envName = btn.dataset.env;
        document.getElementById('menu').style.display = 'none';
        document.getElementById('info').style.display = 'block';

        if (envName === 'nyc') {
            document.getElementById('info').innerHTML =
                'NYC Rescue<br>W/S: Altitude, A/D: Yaw, Arrows: Pitch &amp; Bank<br>Land near survivors to rescue them';
        }

        Ammo().then(AmmoLib => {
            window.Ammo = AmmoLib;
            new Game(envs[envName]);
        });
    });
});
