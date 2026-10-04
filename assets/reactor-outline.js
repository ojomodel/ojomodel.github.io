const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

async function initOutlineReactor() {
  const host = document.querySelector('.personal-reactor');
  if (!host) return;
  host.classList.add('reactor-outline');
  host.dataset.ready = 'loading';
  host.replaceChildren();
  const stage = document.createElement('div'); stage.className = 'reactor-outline-stage';
  const control = document.createElement('button'); control.type = 'button'; control.className = 'reactor-outline-control';
  control.setAttribute('aria-label', 'Proof that Oluwaseun has a heart. Drag to rotate the reactor. Hold to charge.');
  control.setAttribute('aria-describedby', 'reactor-outline-help'); control.disabled = true;
  const plate = document.createElement('span'); plate.className = 'reactor-outline-plate';
  const glow = document.createElement('span'); glow.className = 'reactor-outline-glow'; glow.setAttribute('aria-hidden', 'true');
  plate.append(glow); control.append(plate); stage.append(control);
  const caption = document.createElement('figcaption'); caption.className = 'reactor-outline-caption';
  const hint = document.createElement('span'); hint.id = 'reactor-outline-help';
  hint.innerHTML = '<span class="reactor-pointer-help">Drag to rotate · hover to charge</span><span class="reactor-touch-help">Drag to rotate · hold still to charge</span><span class="reactor-key-help">Arrow keys rotate · hold Space to charge</span>';
  const reset = document.createElement('button'); reset.className = 'reactor-outline-reset'; reset.type = 'button'; reset.textContent = 'Reset view';
  const status = document.createElement('span'); status.className = 'reactor-outline-status'; status.setAttribute('role', 'status'); status.textContent = 'Loading reactor…';
  caption.append(hint, reset, status); host.append(stage, caption);
  try {
    const response = await fetch(new URL('./reactor-outline.svg?v=20261004-outline', import.meta.url));
    if (!response.ok) throw new Error('Reactor artwork unavailable');
    const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement;
    if (svg.localName !== 'svg') throw new Error('Invalid artwork');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    plate.prepend(document.importNode(svg, true));
  } catch {
    status.textContent = 'Reactor artwork could not load. Refresh to try again.';
    host.dataset.ready = 'error'; return;
  }
  status.hidden = true; control.disabled = false; host.dataset.ready = 'true';
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const fineQuery = matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = () => document.documentElement.dataset.motion === 'reduced' ||
    (document.documentElement.dataset.motion !== 'full' && motionQuery.matches);
  let hover = false, pointer = null, key = null, drag = null, dragging = false, manual = false;
  let orbitX = 0, orbitY = 0, tiltX = 0, tiltY = 0, x = 0, y = 0, charge = 0;
  let lastMove = -Infinity, lastDirect = -Infinity, assistiveUntil = 0, raf = 0, lastTime = 0, elapsed = 0, visible = true;
  const charging = now => now - lastMove > 180 && (hover || pointer !== null || key !== null || now < assistiveUntil);
  function render(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    // Charge follows elapsed time, including on lower-frame-rate phones.
    const dt = Math.max(0, (now - lastTime) / 1000 || .016); lastTime = now; elapsed += dt;
    const on = charging(now);
    charge = now - lastMove <= 180 ? 0 : clamp(charge + (on ? dt / 4 : -dt / .8), 0, 1);
    const still = reduced(), idle = !manual && !hover && pointer === null && key === null;
    const targetX = orbitX + (still ? 0 : tiltX + (idle ? Math.sin(elapsed * .6) * 3 : 0));
    const targetY = orbitY + (still ? 0 : tiltY + (idle ? Math.sin(elapsed * .4) * 5 : 0));
    const blend = still || dragging ? 1 : 1 - Math.exp(-dt * 14);
    x += (targetX - x) * blend; y += (targetY - y) * blend;
    plate.style.transform = `rotateX(${x.toFixed(3)}deg) rotateY(${y.toFixed(3)}deg)`;
    host.style.setProperty('--reactor-power', charge.toFixed(4));
    host.style.setProperty('--reactor-whiteout', Math.pow(charge, 5).toFixed(4));
    host.style.setProperty('--reactor-halo', `${(2 + charge * 17).toFixed(1)}px`);
    host.dataset.charge = charge.toFixed(3);
    host.dataset.chargeState = charge === 1 ? 'charged' : charge === 0 ? 'idle' : on ? 'charging' : 'discharging';
    host.dataset.orbitYaw = orbitY.toFixed(1); host.dataset.orbitPitch = orbitX.toFixed(1);
    host.dataset.tilt = JSON.stringify([+x.toFixed(2), +y.toFixed(2)]);
    const settling = Math.abs(targetX - x) + Math.abs(targetY - y) > .02;
    const progressing = on ? charge < 1 : charge > 0;
    const waiting = (hover || pointer !== null || key !== null) && now - lastMove <= 180;
    if (settling || progressing || waiting || now < assistiveUntil || (!still && idle)) raf = requestAnimationFrame(render);
  }
  function wake() { if (!raf && visible && !document.hidden) { lastTime = performance.now(); raf = requestAnimationFrame(render); } }
  function release() {
    const previous = pointer; pointer = null; key = null; drag = null; dragging = false; assistiveUntil = 0;
    host.dataset.dragging = 'false';
    if (previous !== null && control.hasPointerCapture(previous)) control.releasePointerCapture(previous);
    wake();
  }
  function stopInput() { hover = false; tiltX = tiltY = 0; release(); }
  function clearCharge() { charge = 0; assistiveUntil = 0; lastMove = performance.now(); }
  function resetView() { stopInput(); orbitX = orbitY = tiltX = tiltY = 0; manual = false; clearCharge(); wake(); }
  function move(event) {
    const box = control.getBoundingClientRect();
    if (pointer === event.pointerId && drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = manual = true; host.dataset.dragging = 'true';
      orbitY = drag.yaw + dx / box.width * 360; orbitX = clamp(drag.pitch - dy / box.height * 140, -75, 75);
      tiltX = tiltY = 0; clearCharge(); wake(); return;
    }
    if (event.pointerType === 'mouse' && fineQuery.matches && !reduced()) {
      tiltX = clamp(-((event.clientY - box.top) / box.height - .5) * 36, -18, 18);
      tiltY = clamp(((event.clientX - box.left) / box.width - .5) * 44, -22, 22); wake();
    }
  }
  control.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse' && fineQuery.matches) { hover = true; move(event); wake(); } });
  control.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') { hover = false; tiltX = tiltY = 0; wake(); } });
  control.addEventListener('pointermove', move);
  control.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    release(); pointer = event.pointerId; lastDirect = performance.now();
    if (event.pointerType !== 'mouse') hover = false;
    drag = { x: event.clientX, y: event.clientY, yaw: orbitY, pitch: orbitX };
    tiltX = tiltY = 0; control.setPointerCapture(pointer); wake();
  });
  const end = event => {
    if (event.pointerId !== pointer) return;
    const box = control.getBoundingClientRect();
    hover = event.type !== 'pointercancel' && event.pointerType === 'mouse' && fineQuery.matches && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    lastDirect = performance.now(); release();
  };
  window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  control.addEventListener('lostpointercapture', event => { if (event.pointerId === pointer) stopInput(); });
  control.addEventListener('contextmenu', event => event.preventDefault());
  control.addEventListener('keydown', event => {
    if (event.key === 'Escape') { stopInput(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) {
      event.preventDefault(); lastDirect = performance.now();
      if (event.key === 'Home') { resetView(); return; }
      manual = true; tiltX = tiltY = 0;
      if (event.key === 'ArrowLeft') orbitY -= 15;
      if (event.key === 'ArrowRight') orbitY += 15;
      if (event.key === 'ArrowUp') orbitX = clamp(orbitX + 10, -75, 75);
      if (event.key === 'ArrowDown') orbitX = clamp(orbitX - 10, -75, 75);
      clearCharge(); wake(); return;
    }
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) { release(); key = event.key; lastDirect = performance.now(); wake(); } }
  });
  control.addEventListener('keyup', event => { if (event.key === key) { event.preventDefault(); lastDirect = performance.now(); release(); } });
  control.addEventListener('click', event => { if (event.detail === 0 && performance.now() - lastDirect > 500) { assistiveUntil = performance.now() + 4400; wake(); } });
  control.addEventListener('blur', stopInput); window.addEventListener('blur', stopInput);
  reset.addEventListener('click', resetView);
  const suspend = () => { stopInput(); cancelAnimationFrame(raf); raf = 0; charge = 0; host.style.setProperty('--reactor-power', '0'); host.style.setProperty('--reactor-whiteout', '0'); host.dataset.charge = '0.000'; host.dataset.chargeState = 'idle'; };
  document.addEventListener('visibilitychange', () => document.hidden ? suspend() : wake());
  window.addEventListener('pagehide', suspend);
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; visible ? wake() : suspend(); }, { rootMargin: '60px' }).observe(host);
  const motionChanged = () => { tiltX = tiltY = 0; wake(); };
  motionQuery.addEventListener('change', motionChanged);
  new MutationObserver(motionChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  wake();
}
initOutlineReactor();
