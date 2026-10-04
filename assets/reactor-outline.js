const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
async function initOutlineReactor() {
  const host = document.querySelector('.personal-reactor');
  if (!host) return;
  host.classList.add('reactor-outline'); host.dataset.ready = 'loading'; host.replaceChildren();
  const stage = document.createElement('div'); stage.className = 'reactor-outline-stage';
  const control = document.createElement('button'); control.type = 'button'; control.className = 'reactor-outline-control';
  control.setAttribute('aria-label', 'Proof that Oluwaseun has a heart. Hover or hold to illuminate the reactor.'); control.disabled = true;
  const plate = document.createElement('span'); plate.className = 'reactor-outline-plate';
  const orbit = document.createElement('span'); orbit.className = 'reactor-orbit-light'; orbit.setAttribute('aria-hidden', 'true');
  const glow = document.createElement('span'); glow.className = 'reactor-outline-glow'; glow.setAttribute('aria-hidden', 'true');
  plate.append(orbit, glow); control.append(plate); stage.append(control);
  const status = document.createElement('span'); status.className = 'reactor-outline-status';
  status.setAttribute('role', 'status'); status.textContent = 'Loading reactor…'; host.append(stage, status);
  try {
    const response = await fetch(new URL('./reactor-outline.svg?v=20261004-outline', import.meta.url));
    if (!response.ok) throw new Error('Reactor artwork unavailable');
    const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement;
    if (svg.localName !== 'svg') throw new Error('Invalid artwork');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); plate.prepend(document.importNode(svg, true));
  } catch { status.textContent = 'Reactor artwork could not load. Refresh to try again.'; host.dataset.ready = 'error'; return; }
  status.hidden = true; control.disabled = false; host.dataset.ready = 'true';
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const fineQuery = matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = () => document.documentElement.dataset.motion === 'reduced' || (document.documentElement.dataset.motion !== 'full' && motionQuery.matches);
  let hover = false, held = null, key = null, aimX = 0, aimY = 0;
  let charge = 0, engage = 0, x = 0, y = 0, lastDirect = -Infinity, assistiveUntil = 0;
  let raf = 0, lastTime = 0, elapsed = 0, visible = true;
  const active = now => hover || held !== null || key !== null || now < assistiveUntil;
  function paintPower(now) {
    host.style.setProperty('--reactor-power', charge.toFixed(4)); host.style.setProperty('--reactor-whiteout', Math.pow(charge, 5).toFixed(4));
    host.style.setProperty('--reactor-halo', `${(2 + charge * 17).toFixed(1)}px`);
    host.dataset.charge = charge.toFixed(3);
    host.dataset.chargeState = charge === 1 ? 'charged' : charge === 0 ? 'idle' : active(now) ? 'charging' : 'discharging';
  }
  function render(now) {
    raf = 0; if (!visible || document.hidden) return;
    const dt = Math.max(0, (now - lastTime) / 1000 || .016); lastTime = now; elapsed += dt;
    const on = active(now), still = reduced(); charge = clamp(charge + (on ? dt / 4 : -dt / .8), 0, 1);
    const blend = 1 - Math.exp(-Math.min(dt, .15) * 7); engage += ((on ? 1 : 0) - engage) * blend;
    // Continuous circular dipping, never a latched manually rotated view.
    const phase = elapsed * Math.PI * 2 / 9;
    const targetX = still ? 0 : -8 + Math.cos(phase) * 15 - engage * 10 + aimX * engage;
    const targetY = still ? 0 : Math.sin(phase) * 19 + aimY * engage;
    x += (targetX - x) * blend; y += (targetY - y) * blend;
    plate.style.transform = `translateY(${(still ? 0 : Math.sin(phase) * 5).toFixed(2)}px) rotateX(${x.toFixed(3)}deg) rotateY(${y.toFixed(3)}deg)`;
    host.dataset.interaction = on ? 'active' : 'idle'; host.dataset.tilt = JSON.stringify([+x.toFixed(2), +y.toFixed(2)]); paintPower(now);
    const settling = Math.abs(targetX - x) + Math.abs(targetY - y) > .02;
    if (!still || settling || (on ? charge < 1 : charge > 0) || now < assistiveUntil) raf = requestAnimationFrame(render);
  }
  function wake() { if (!raf && visible && !document.hidden) { lastTime = performance.now(); raf = requestAnimationFrame(render); } }
  function releaseHold() {
    const previous = held; held = null;
    if (previous && previous.kind === 'pointer') {
      try { if (control.hasPointerCapture(previous.id)) control.releasePointerCapture(previous.id); } catch { /* Capture is optional. */ }
    }
    wake();
  }
  function stopInput() { hover = false; key = null; assistiveUntil = 0; aimX = aimY = 0; releaseHold(); }
  function mouseAim(event) {
    const box = control.getBoundingClientRect();
    aimX = clamp(-((event.clientY - box.top) / box.height - .5) * 10, -5, 5);
    aimY = clamp(((event.clientX - box.left) / box.width - .5) * 14, -7, 7); wake();
  }
  function beginHold(id, kind, event) {
    releaseHold(); lastDirect = performance.now(); assistiveUntil = 0; held = { id, kind, x: event.clientX, y: event.clientY };
    if (kind !== 'mouse') { hover = false; aimX = aimY = 0; } wake();
  }
  function movedHold(event) {
    // Finger jitter must not reset charging. A deliberate swipe gives scrolling back to the page.
    if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 24) releaseHold();
  }
  if ('PointerEvent' in window) {
    control.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' && fineQuery.matches) { hover = true; mouseAim(event); wake(); } });
    control.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') { hover = false; aimX = aimY = 0; wake(); } });
    control.addEventListener('pointerdown', event => {
      if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
      beginHold(event.pointerId, 'pointer', event);
      if (event.pointerType === 'mouse' && fineQuery.matches) { hover = true; mouseAim(event); }
      try { control.setPointerCapture(event.pointerId); } catch { /* Window release listeners cover capture failures. */ }
    });
    control.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse' && fineQuery.matches) mouseAim(event);
      else if (held && held.id === event.pointerId) movedHold(event);
    });
    const end = event => {
      if (!held || held.id !== event.pointerId) return;
      lastDirect = performance.now();
      if (event.type === 'pointercancel' || event.pointerType !== 'mouse') { hover = false; aimX = aimY = 0; } releaseHold();
    };
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); control.addEventListener('lostpointercapture', end);
  } else {
    // Older Safari fallback: charge starts on contact without waiting for a synthetic click.
    control.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) { stopInput(); return; }
      const touch = event.changedTouches[0]; beginHold(touch.identifier, 'touch', touch);
    }, { passive: true });
    control.addEventListener('touchmove', event => {
      const touch = Array.from(event.touches).find(item => held && item.identifier === held.id); if (touch) movedHold(touch);
    }, { passive: true });
    const endTouch = event => {
      if (Array.from(event.changedTouches).some(item => held && item.identifier === held.id)) { lastDirect = performance.now(); hover = false; releaseHold(); }
    };
    window.addEventListener('touchend', endTouch, { passive: true }); window.addEventListener('touchcancel', endTouch, { passive: true });
    control.addEventListener('mouseenter', event => { if (fineQuery.matches && performance.now() - lastDirect > 700) { hover = true; mouseAim(event); } });
    control.addEventListener('mousemove', event => { if (hover) mouseAim(event); });
    control.addEventListener('mouseleave', () => { hover = false; aimX = aimY = 0; wake(); });
  }
  control.addEventListener('contextmenu', event => event.preventDefault());
  control.addEventListener('keydown', event => {
    if (event.key === 'Escape') { stopInput(); return; }
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) { key = event.key; lastDirect = performance.now(); assistiveUntil = 0; wake(); } }
  });
  control.addEventListener('keyup', event => { if (event.key === key) { event.preventDefault(); key = null; lastDirect = performance.now(); wake(); } });
  control.addEventListener('click', event => { if (event.detail === 0 && performance.now() - lastDirect > 700) { assistiveUntil = performance.now() + 4400; wake(); } });
  control.addEventListener('blur', stopInput); window.addEventListener('blur', stopInput);
  function suspend() { stopInput(); cancelAnimationFrame(raf); raf = 0; charge = 0; paintPower(performance.now()); host.dataset.suspended = 'true'; }
  function resume() { host.dataset.suspended = String(!visible || document.hidden); wake(); }
  document.addEventListener('visibilitychange', () => document.hidden ? suspend() : resume());
  window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; visible ? resume() : suspend(); }, { rootMargin: '60px' }).observe(host);
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', wake);
  else if (motionQuery.addListener) motionQuery.addListener(wake);
  new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  wake();
}
initOutlineReactor();
