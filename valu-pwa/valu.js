import { initValuAppLandingIntro, killValuAppLandingIntro, landingIntroShortAccel } from './valu-landing-intro.js';

/**
 * Valu orb animation — direct port from the original Framework7 app (valu.js).
 * Structure: .valu-orb-sm > .spheres (70x70, overflow:hidden) > .spheres-group > .sphere*3
 * GSAP fades in, rotates, pulses spheres, then bgToIcon() shrinks group to 30x30.
 * Click/tap shows a Material-style ripple.
 * Device shake triggers a short speed-up burst + vibration.
 */

const timelines = new Map();

/**
 * @param {{ runBgToIcon?: boolean, useSlowmo?: boolean }} opts
 *   useSlowmo: navbar/small orb — extreme slow-mo (reference). Landing hero uses false so motion stays visible.
 */
function attachOrbTimeline(containerEl, group, s1, s2, s3, opts) {
  const runBgToIcon = opts?.runBgToIcon !== false;
  const useSlowmo = opts?.useSlowmo !== false;

  const tl = gsap.timeline();

  tl.set([s1, s2, s3], { transformOrigin: 'center center', scale: 1 })
    .to(group, { duration: 1, opacity: 1 })
    .to(group, {
      duration: 1,
      repeat: -1,
      rotate: 360,
      ease: 'none',
    }, -1)
    .to(s3, {
      duration: 1,
      scale: 2.4,
      visibility: 'visible',
      ease: 'quad.inOut',
      repeat: -1,
      yoyo: true,
    })
    .to(s1, {
      duration: 1,
      scale: 3,
      visibility: 'visible',
      ease: 'quad.inOut',
      repeat: -1,
      yoyo: true,
    }, '-=0.55')
    .to(s2, {
      duration: 1,
      scale: 2.6,
      visibility: 'visible',
      ease: 'quad.inOut',
      repeat: -1,
      yoyo: true,
    }, '-=0.60');

  let ambientTweens = [];

  function killAmbient() {
    ambientTweens.forEach((t) => {
      if (t && t.kill) t.kill();
    });
    ambientTweens = [];
  }

  /** Reference app: timeline nearly freezes so the tiny navbar orb feels calm. */
  function startNavbarSlowmo() {
    killAmbient();
    ambientTweens.push(gsap.fromTo(tl, { timeScale: 2 }, { duration: 2, timeScale: 0.05 }));
    ambientTweens.push(gsap.fromTo(
      tl,
      { timeScale: 0.05 },
      { duration: 10, timeScale: 0.005, delay: 2, repeat: -1, yoyo: true }
    ));
  }

  /** Landing hero: keep rotation + pulse clearly visible; only a light breathing on timeScale. */
  function startHeroAmbient() {
    killAmbient();
    tl.timeScale(1);
    ambientTweens.push(gsap.fromTo(
      tl,
      { timeScale: 0.82 },
      { duration: 5.5, timeScale: 1.08, repeat: -1, yoyo: true, ease: 'sine.inOut' }
    ));
  }

  function accel() {
    killAmbient();
    gsap.to(tl, {
      duration: useSlowmo ? 1 : 0.45,
      timeScale: 2,
      onComplete: () => {
        if (useSlowmo) {
          gsap.to(tl, {
            duration: 1,
            timeScale: 1,
            onComplete: startNavbarSlowmo,
          });
        } else {
          gsap.to(tl, {
            duration: 1.25,
            timeScale: 1,
            ease: 'power2.out',
            onComplete: startHeroAmbient,
          });
        }
      },
    });
  }

  if (useSlowmo) {
    startNavbarSlowmo();
  } else {
    startHeroAmbient();
  }

  if (runBgToIcon) {
    function bgToIcon() {
      killAmbient();
      gsap.to(tl, { duration: 1, timeScale: 1, onComplete: startNavbarSlowmo });
      gsap.to(group, { duration: 1, scale: 1, height: 30, width: 30 });
    }
    bgToIcon();
  }

  const onOrbClick = (e) => createRipple(containerEl, e);
  containerEl.addEventListener('click', onOrbClick);

  timelines.set(containerEl, { tl, accel, onOrbClick, killAmbient });
}

function killOrbContainer(containerEl) {
  if (!containerEl) return;
  const meta = timelines.get(containerEl);
  if (meta) {
    if (meta.killAmbient) meta.killAmbient();
    if (meta.tl) meta.tl.kill();
    if (meta.onOrbClick) containerEl.removeEventListener('click', meta.onOrbClick);
  }
  timelines.delete(containerEl);
}

function init(containerEl) {
  if (!containerEl || timelines.has(containerEl)) return;
  if (typeof gsap === 'undefined') return;

  const group = containerEl.querySelector('.spheres-group');
  const s1 = containerEl.querySelector('.s1');
  const s2 = containerEl.querySelector('.s2');
  const s3 = containerEl.querySelector('.s3');
  if (!group || !s1 || !s2 || !s3) return;

  attachOrbTimeline(containerEl, group, s1, s2, s3, { runBgToIcon: true, useSlowmo: true });
}

/** Landing / hero: same sphere motion as the app reference, without shrinking to icon size. */
function initHeroSpheres(containerEl) {
  if (!containerEl || typeof gsap === 'undefined') return;

  killOrbContainer(containerEl);

  const group = containerEl.querySelector('.spheres-group');
  const s1 = containerEl.querySelector('.s1');
  const s2 = containerEl.querySelector('.s2');
  const s3 = containerEl.querySelector('.s3');
  if (!group || !s1 || !s2 || !s3) return;

  attachOrbTimeline(containerEl, group, s1, s2, s3, { runBgToIcon: false, useSlowmo: false });
}

/** Stroke-draw wordmark (auth / compact SVG only). */
function initValuWordmarkDraw(svg) {
  if (!svg || typeof gsap === 'undefined') return;
  /* Landing mark-up uses id="valu" / .valu-site-intro — never dash-animate that SVG here. */
  if (svg.id === 'valu' || svg.closest('.valu-site-intro')) return;
  let parts = svg.querySelectorAll('#logo .ch1, #logo .ch2, #logo .ch3');
  if (!parts.length) {
    parts = svg.querySelectorAll('.valu-logo-ch1, .valu-logo-ch2, .valu-logo-ch3');
  }
  parts.forEach((el) => {
    gsap.killTweensOf(el);
    el.style.strokeDasharray = '';
    el.style.strokeDashoffset = '';
  });

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    parts.forEach((el) => {
      el.removeAttribute('stroke-dasharray');
      el.removeAttribute('stroke-dashoffset');
    });
    return;
  }

  parts.forEach((el, i) => {
    let len = 0;
    try {
      len = el.getTotalLength();
    } catch (_) {
      return;
    }
    if (!len) return;
    el.setAttribute('stroke-dasharray', String(len));
    el.setAttribute('stroke-dashoffset', String(len));
    gsap.to(el, {
      attr: { 'stroke-dashoffset': 0 },
      duration: 1.15,
      delay: 0.35 + i * 0.32,
      ease: 'power2.inOut',
    });
  });
}

/** Landing: https://valu-app.com/ intro (DrawSVG + spheres) or legacy orb + wordmark. */
function initLandingVisualStack(root) {
  if (!root) return;

  const site = root.querySelector('.valu-site-intro');
  if (site) {
    killValuAppLandingIntro();
    initValuAppLandingIntro(site);
    return;
  }

  const spheresRoot = root.querySelector('.valu-orb-spheres-hero');
  if (spheresRoot) initHeroSpheres(spheresRoot);
  const svg = root.querySelector('.valu-wordmark-svg');
  if (svg) initValuWordmarkDraw(svg);
}

function createRipple(container, e) {
  const rect = container.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.5;
  const x = (e ? e.clientX - rect.left : rect.width / 2) - size / 2;
  const y = (e ? e.clientY - rect.top : rect.height / 2) - size / 2;

  const ripple = document.createElement('span');
  ripple.className = 'orb-ripple';
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = x + 'px';
  ripple.style.top = y + 'px';
  container.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
}

function triggerShakeAccel() {
  timelines.forEach(({ accel }) => {
    if (accel) accel();
  });
  landingIntroShortAccel();
  if (window.navigator && window.navigator.vibrate) {
    window.navigator.vibrate(10);
  }
}

let shakeListenerAdded = false;
let lastShakeTime = 0;

function initShakeDetection() {
  if (shakeListenerAdded) return;
  shakeListenerAdded = true;

  let lastX = null; let lastY = null; let lastZ = null;
  const threshold = 15;

  window.addEventListener('devicemotion', (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;

    if (lastX !== null) {
      const delta = Math.abs(acc.x - lastX) + Math.abs(acc.y - lastY) + Math.abs(acc.z - lastZ);
      if (delta > threshold) {
        const now = Date.now();
        if (now - lastShakeTime > 1000) {
          lastShakeTime = now;
          triggerShakeAccel();
        }
      }
    }
    lastX = acc.x;
    lastY = acc.y;
    lastZ = acc.z;
  });
}

function initAll() {
  document.querySelectorAll('.valu-orb, .valu-orb-sm').forEach(init);
  document.querySelectorAll('.valu-landing-hero').forEach(initLandingVisualStack);
  initShakeDetection();
}

export default { init, initAll, initLandingVisualStack, initHeroSpheres, initValuWordmarkDraw };
