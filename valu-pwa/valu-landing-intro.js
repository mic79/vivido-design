/**
 * Valu marketing landing intro — spheres (GSAP) + logo/gfx timelines (DrawSVG), ported from valu-app.com.
 * Scoped under `.valu-site-intro`. `bgToIcon()` is omitted in the PWA.
 */

let activeMeta = null;

function killMeta(meta) {
  if (!meta) return;
  if (meta.tl) meta.tl.kill();
  if (meta.tlLogo) meta.tlLogo.kill();
  if (meta.tlIdle) meta.tlIdle.kill();
  if (meta.delayedCall) meta.delayedCall.kill();
  if (meta.shakeHandler) {
    window.removeEventListener('shake', meta.shakeHandler);
  }
  if (meta.shakeInstance && typeof meta.shakeInstance.stop === 'function') {
    try {
      meta.shakeInstance.stop();
    } catch (_) {
      /* ignore */
    }
  }
  if (meta.rootEl) {
    delete meta.rootEl._valuIntroStatusClick;
  }
}

export function killValuAppLandingIntro() {
  killMeta(activeMeta);
  activeMeta = null;
}

/** Let valu.js route device shake to this intro’s sphere timeline when landing is visible. */
export function landingIntroShortAccel() {
  if (activeMeta && typeof activeMeta.shortBgAccel === 'function') {
    activeMeta.shortBgAccel();
  }
}

/**
 * Reference: body click vibrates; if `animation === false`, `statusToggle()`.
 */
export function landingIntroHandleUserClick() {
  if (activeMeta && typeof activeMeta.onUserTap === 'function') {
    activeMeta.onUserTap();
  }
}

/**
 * @param {HTMLElement} container — element with .spheres / .spheres-group / svg#valu
 */
export function initValuAppLandingIntro(container) {
  if (!container || typeof gsap === 'undefined') return;

  killValuAppLandingIntro();

  const root = container;
  const spheresGroup = root.querySelector('.spheres-group');
  const s1 = root.querySelector('.s1');
  const s2 = root.querySelector('.s2');
  const s3 = root.querySelector('.s3');
  const ch1 = root.querySelector('#valu #logo .ch1');
  const ch2 = root.querySelector('#valu #logo .ch2');
  const ch3 = root.querySelector('#valu #logo .ch3');
  const logoG = root.querySelector('#valu #logo');
  const gfxG = root.querySelector('#valu #gfx');
  const c1 = root.querySelector('#valu #gfx .c1');
  const c2 = root.querySelector('#valu #gfx .c2');
  const c3 = root.querySelector('#valu #gfx .c3');

  if (!spheresGroup || !s1 || !s2 || !s3 || !ch1 || !ch2 || !ch3 || !c1 || !c2 || !c3) {
    return;
  }

  if (typeof window !== 'undefined' && window.DrawSVGPlugin && !gsap.plugins?.drawSVG) {
    gsap.registerPlugin(window.DrawSVGPlugin);
  }
  if (!gsap.plugins?.drawSVG) {
    console.warn('[Valu] DrawSVGPlugin missing — load vendor/DrawSVGPlugin.min.js after gsap.min.js.');
    return;
  }

  [ch1, ch2, ch3, c1, c2, c3].forEach((el) => {
    gsap.killTweensOf(el);
    el.removeAttribute('stroke-dasharray');
    el.removeAttribute('stroke-dashoffset');
    el.style.strokeDasharray = '';
    el.style.strokeDashoffset = '';
  });

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    gsap.set([ch1, ch2, ch3, c1, c2, c3], { visibility: 'visible', drawSVG: '100% 100%' });
    gsap.set([root.querySelector('#valu #logo'), root.querySelector('#valu #gfx')].filter(Boolean), {
      visibility: 'visible',
    });
    gsap.set(spheresGroup, { opacity: 1 });
    return;
  }

  const meta = {
    rootEl: root,
    tl: null,
    tlLogo: null,
    tlIdle: null,
    delayedCall: null,
    shakeHandler: null,
    shakeInstance: null,
    shortBgAccel: null,
    onUserTap: null,
  };
  activeMeta = meta;

  const rotationSpeed = 1;

  /* ── Background (HTML spheres) — reference ─────────────────────────── */
  const tl = gsap.timeline();
  meta.tl = tl;

  tl.set([s1, s2, s3], { transformOrigin: 'center center', scale: 1 })
    .to(spheresGroup, { duration: 1, opacity: 1 })
    .to(
      spheresGroup,
      {
        duration: rotationSpeed,
        repeat: -1,
        rotation: 360,
        ease: 'none',
      },
      -1,
    )
    .to(s3, {
      duration: 1,
      scale: 2.4,
      visibility: 'visible',
      ease: 'quad.inOut',
      repeat: -1,
      yoyo: true,
    })
    .to(
      s1,
      {
        duration: 1,
        scale: 3,
        visibility: 'visible',
        ease: 'quad.inOut',
        repeat: -1,
        yoyo: true,
      },
      '-=0.55',
    )
    .to(
      s2,
      {
        duration: 1,
        scale: 2.6,
        visibility: 'visible',
        ease: 'quad.inOut',
        repeat: -1,
        yoyo: true,
      },
      '-=0.60',
    );

  function slowmoBg() {
    gsap.fromTo(tl, { timeScale: 2 }, { duration: 2, timeScale: 0.05 });
    gsap.fromTo(
      tl,
      { timeScale: 0.05 },
      { duration: 10, timeScale: 0.005, delay: 2, repeat: -1, yoyo: true },
    );
  }
  slowmoBg();

  function shortBgAccel() {
    gsap.to(tl, { duration: 1, timeScale: 2, onComplete: slowmoBg });
  }

  meta.shortBgAccel = shortBgAccel;

  const onShake = () => {
    if (window.navigator && window.navigator.vibrate) {
      window.navigator.vibrate(10);
    }
    shortBgAccel();
  };
  meta.shakeHandler = onShake;
  if (typeof window.Shake === 'function') {
    try {
      const shakeEvent = new window.Shake({ threshold: 15 });
      shakeEvent.start();
      meta.shakeInstance = shakeEvent;
      window.addEventListener('shake', onShake, false);
    } catch (_) {
      meta.shakeHandler = null;
      meta.shakeInstance = null;
    }
  }

  /* ── Logo + gfx — reference tlLogo / tlIdle / statusToggle ───────── */
  /* Only #gfx (tlIdle + idleCenter): ×⅓ duration so rings move faster. Wordmark draw stays reference speed. */
  const gfxD = 1 / 3;
  let status = 'idle';
  let animation = true;

  const tlLogo = gsap.timeline({ paused: true });
  meta.tlLogo = tlLogo;

  tlLogo
    .fromTo(
      ch3,
      { drawSVG: '55% 55%' },
      {
        duration: 1,
        drawSVG: '0% 100%',
        visibility: 'visible',
        ease: 'quad.inOut',
      },
    )
    .fromTo(
      ch1,
      { drawSVG: '100% 100%' },
      {
        duration: 0.55,
        drawSVG: '0% 100%',
        visibility: 'visible',
        ease: 'quad.inOut',
      },
      '-=0.55',
    )
    .fromTo(
      ch2,
      { drawSVG: '25% 25%' },
      {
        duration: 0.7,
        drawSVG: '0% 100%',
        visibility: 'visible',
        ease: 'quad.inOut',
        onComplete: () => {
          animation = false;
        },
      },
      '-=0.60',
    );

  const tlIdle = gsap.timeline();
  meta.tlIdle = tlIdle;

  const gfxOrigin = { svgOrigin: '640 512', transformOrigin: '50% 50%' };

  tlIdle
    .set(gfxG, { visibility: 'visible' })
    .set([c1, c2, c3], {
      ...gfxOrigin,
      strokeWidth: 65,
      scale: 1,
    })
    .to([c1, c2, c3], {
      duration: 1 * gfxD,
      repeat: -1,
      rotation: 360,
      ease: 'none',
      ...gfxOrigin,
    })
    .fromTo(
      c3,
      { drawSVG: '33% 33%' },
      {
        duration: 1 * gfxD,
        drawSVG: '0% 33%',
        visibility: 'visible',
        ease: 'quad.inOut',
        repeat: -1,
        yoyo: true,
      },
    )
    .fromTo(
      c1,
      { drawSVG: '1% 1%' },
      {
        duration: 1 * gfxD,
        drawSVG: '1% 1%',
        visibility: 'visible',
        ease: 'quad.inOut',
        repeat: -1,
        yoyo: true,
      },
      `-=${0.55 * gfxD}`,
    )
    .fromTo(
      c2,
      { drawSVG: '66% 100%' },
      {
        duration: 1 * gfxD,
        drawSVG: '66% 66%',
        visibility: 'visible',
        ease: 'quad.inOut',
        repeat: -1,
        yoyo: true,
      },
      `-=${0.6 * gfxD}`,
    );

  function logoRestart() {
    if (logoG) gsap.set(logoG, { visibility: 'visible' });
    tlLogo.restart();
  }

  function idleCenter() {
    gsap.to([c1, c2, c3], {
      duration: 1 * gfxD,
      strokeWidth: 140,
      scale: 0.25,
      drawSVG: '100% 100%',
      ease: 'quad.inOut',
      ...gfxOrigin,
      onComplete: logoRestart,
    });
  }

  function statusToggle() {
    animation = true;
    if (status === 'idle') {
      status = 'logo';
      idleCenter();
    } else {
      status = 'idle';
      tlLogo.reverse();
      tlIdle.restart();
      /* PWA: no bgToIcon() */
    }
  }

  /* Reference waited 4s on gfx; shorten idle phase by gfxD so #logo draw starts sooner. */
  meta.delayedCall = gsap.delayedCall(4 * gfxD, statusToggle);

  meta.onUserTap = () => {
    if (window.navigator && window.navigator.vibrate) {
      window.navigator.vibrate(10);
    }
    if (animation === false) {
      statusToggle();
    }
  };
  root._valuIntroStatusClick = meta.onUserTap;
}
