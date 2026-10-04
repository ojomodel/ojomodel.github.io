const MODEL_ID = 'c37adc7fd9074213a011de9336b79d8f';
const MODEL_URL = 'https://sketchfab.com/3d-models/arc-reactor-proof-that-tony-stark-has-a-heart-' + MODEL_ID;
const SDK_URL = 'https://static.sketchfab.com/api/sketchfab-viewer-1.12.1.js';
let sdkPromise;

function loadViewerSDK() {
  if (typeof window.Sketchfab === 'function') return Promise.resolve(window.Sketchfab);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    let script = document.querySelector('script[data-portfolio-sketchfab-sdk]');
    const timeout = setTimeout(() => reject(new Error('Viewer SDK timeout')), 25000);
    const loaded = () => {
      clearTimeout(timeout);
      typeof window.Sketchfab === 'function' ? resolve(window.Sketchfab) : reject(new Error('Viewer SDK unavailable'));
    };
    const failed = () => { clearTimeout(timeout); reject(new Error('Viewer SDK unavailable')); };
    if (!script) {
      script = document.createElement('script'); script.src = SDK_URL; script.async = true;
      script.dataset.portfolioSketchfabSdk = 'true';
      script.addEventListener('load', loaded, { once: true }); script.addEventListener('error', failed, { once: true });
      document.head.appendChild(script);
    } else {
      script.addEventListener('load', loaded, { once: true }); script.addEventListener('error', failed, { once: true });
    }
  });
  return sdkPromise;
}

export function initSketchfabReactor(host = document.querySelector('.personal-reactor'), options = {}) {
  if (!host || host.dataset.sketchfabInitialized) return null;
  host.dataset.sketchfabInitialized = 'true'; host.dataset.ready = 'loading';
  host.classList.add('reactor-sketchfab');
  // This component replaces the procedural ornament; the original hosted model
  // stays inside its official viewer with attribution and controls intact.
  host.replaceChildren();
  const stage = document.createElement('div'); stage.className = 'reactor-embed-stage';
  const frame = document.createElement('iframe'); frame.className = 'reactor-embed-frame';
  frame.title = 'Arc reactor — original Sketchfab 3D model';
  frame.allow = 'autoplay; fullscreen; xr-spatial-tracking'; frame.allowFullscreen = true;
  const control = document.createElement('button'); control.className = 'reactor-charge-control'; control.type = 'button';
  control.setAttribute('aria-label', 'Charge the arc reactor');
  control.setAttribute('aria-describedby', 'reactor-embed-instructions'); control.disabled = true;
  const label = document.createElement('span'); label.className = 'reactor-accessible-only';
  label.textContent = 'Hover or hold to build up light. Move across the reactor or use arrow keys to tilt it. Home recenters.'; control.appendChild(label);
  const bloom = document.createElement('div'); bloom.className = 'reactor-embed-bloom'; bloom.setAttribute('aria-hidden', 'true');
  stage.append(frame, control, bloom);
  const caption = document.createElement('figcaption'); caption.className = 'reactor-embed-caption';
  const phrase = document.createElement('span'); phrase.className = 'reactor-personal-phrase'; phrase.textContent = 'PROOF THAT OLUWASEUN HAS A HEART';
  const hint = document.createElement('span'); hint.id = 'reactor-embed-instructions'; hint.className = 'reactor-embed-hint';
  hint.innerHTML = '<span class="reactor-mouse-instruction">Move to tilt · linger to charge</span><span class="reactor-touch-instruction">Hold to charge · move to tilt</span><span class="reactor-key-instruction">Arrows tilt · Home centers · hold Space or Enter to charge</span>';
  const credit = document.createElement('a'); credit.href = MODEL_URL; credit.target = '_blank'; credit.rel = 'noopener';
  credit.className = 'reactor-source-link'; credit.textContent = '3D model by Huqandiy · Sketchfab ↗';
  const status = document.createElement('span'); status.className = 'reactor-embed-status'; status.setAttribute('role', 'status'); status.textContent = 'Loading 3D reactor…';
  caption.append(phrase, hint, credit, status); host.append(stage, caption);

  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const fineQuery = matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = () => document.documentElement.dataset.motion === 'reduced' || (document.documentElement.dataset.motion !== 'full' && reducedQuery.matches);
  const baseTarget = options.target || [0, .2556604366, 2.3284352164];
  const basePosition = options.position || [.7, 3.92, 2.8];
  const offset = basePosition.map((value, index) => value - baseTarget[index]);
  const radius = Math.hypot(...offset), baseYaw = Math.atan2(offset[1], offset[0]);
  const baseElevation = Math.atan2(offset[2], Math.hypot(offset[0], offset[1]));
  const hiddenNames = new Set(['holder_12', 'platform_17', 'PROOF THAT TONY STARK.001_18', 'HAS A HEART.001_21']);
  let api, ready = false, disposed = false, inView = true, running = false, pendingFrame = 0;
  let hover = false, heldPointer = null, heldKey = null, keyboardTilt = false, assistiveUntil = 0, lastDirectInput = -Infinity;
  let charge = 0, targetYaw = 0, targetPitch = 0, yaw = 0, pitch = 0, elapsed = 0;
  let previousTime = 0, lastCameraTime = 0, lastMaterialTime = 0, lastMaterialCharge = -1;
  let materialRecords = [];
  const cleanup = [];
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function listen(target, event, handler, settings) {
    target.addEventListener(event, handler, settings); cleanup.push(() => target.removeEventListener(event, handler, settings));
  }
  const intendedOn = time => hover || heldPointer !== null || heldKey !== null || time < assistiveUntil;
  function chargeAttributes() {
    host.dataset.charge = charge.toFixed(3);
    host.dataset.chargeState = charge >= .999 ? 'charged' : charge <= .001 ? 'idle' : intendedOn(performance.now()) ? 'charging' : 'discharging';
    host.style.setProperty('--reactor-charge', charge.toFixed(3));
    host.style.setProperty('--reactor-bloom', Math.pow(charge, 5).toFixed(3));
  }
  function updateMaterials(force = false) {
    if (!api || !materialRecords.length || (!force && charge !== 0 && charge !== 1 && Math.abs(charge - lastMaterialCharge) < .009)) return;
    if (!force && charge === lastMaterialCharge) return;
    lastMaterialCharge = charge;
    materialRecords.forEach(record => {
      const material = record.material;
      if (charge <= .001) {
        material.channels.EmitColor = record.baseline ? structuredClone(record.baseline) : { enable: false, factor: 0, color: [1, 1, 1] };
      } else {
        const original = record.baseline || {}, originalColor = original.color || [.75, .87, 1];
        const amount = Math.pow(charge, .75);
        material.channels.EmitColor = {
          ...original, enable: true,
          color: originalColor.map((value, i) => value + ([.91, .97, 1][i] - value) * amount),
          factor: (original.enable === false ? 0 : original.factor || 0) + Math.pow(charge, 1.7) * 12,
        };
      }
      api.setMaterial(material, () => {});
    });
  }
  function submitCamera(time) {
    const still = reduced();
    const idle = !hover && heldPointer === null && !keyboardTilt;
    const desiredYaw = still ? 0 : targetYaw + (idle ? Math.sin(elapsed * .55) * .025 : 0);
    const desiredPitch = still ? 0 : targetPitch + (idle ? Math.sin(elapsed * .7) * .012 : 0);
    const easing = still ? 1 : .2;
    yaw += (desiredYaw - yaw) * easing; pitch += (desiredPitch - pitch) * easing;
    const elevation = clamp(baseElevation + pitch, -1.2, 1.2), angle = baseYaw + yaw;
    const position = [baseTarget[0] + Math.cos(angle) * Math.cos(elevation) * radius,
      baseTarget[1] + Math.sin(angle) * Math.cos(elevation) * radius, baseTarget[2] + Math.sin(elevation) * radius];
    api.setCameraLookAt(position, baseTarget, 0, () => {});
    host.dataset.tiltX = (pitch * 180 / Math.PI).toFixed(1); host.dataset.tiltY = (yaw * 180 / Math.PI).toFixed(1);
    host.dataset.viewCamera = JSON.stringify({ position, target: baseTarget }); lastCameraTime = time;
  }
  function animate(time) {
    pendingFrame = 0;
    if (!ready || disposed || !inView || document.hidden) return;
    const dt = Math.min((time - previousTime) / 1000 || .016, .05); previousTime = time; elapsed += dt;
    charge = intendedOn(time) ? Math.min(1, charge + dt / 4) : Math.max(0, charge - dt / .8);
    chargeAttributes();
    if (time - lastMaterialTime > 80) { updateMaterials(); lastMaterialTime = time; }
    if (time - lastCameraTime > (fineQuery.matches ? 40 : 60)) submitCamera(time);
    if (!reduced() || charge > 0 || intendedOn(time) || Math.abs(yaw) + Math.abs(pitch) > .0001) pendingFrame = requestAnimationFrame(animate);
  }
  function wake() {
    if (!ready || disposed || !inView || document.hidden) return;
    if (!running) { api.start(); running = true; }
    if (!pendingFrame) { previousTime = performance.now(); pendingFrame = requestAnimationFrame(animate); }
  }
  function release() {
    heldKey = null; assistiveUntil = 0;
    const pointer = heldPointer; heldPointer = null;
    if (pointer !== null && control.hasPointerCapture(pointer)) control.releasePointerCapture(pointer);
    if (!keyboardTilt) targetYaw = targetPitch = 0;
    wake();
  }
  function resetInteraction() { hover = false; keyboardTilt = false; release(); }
  function suspend() {
    cancelAnimationFrame(pendingFrame); pendingFrame = 0; resetInteraction();
    cancelAnimationFrame(pendingFrame); pendingFrame = 0;
    charge = 0; chargeAttributes(); updateMaterials(true);
    if (api && running) { api.stop(); running = false; }
  }
  function tilt(event) {
    if (reduced() || (event.pointerType !== 'mouse' && heldPointer !== event.pointerId)) return;
    keyboardTilt = false;
    const bounds = control.getBoundingClientRect();
    targetYaw = clamp(((event.clientX - bounds.left) / bounds.width - .5) * 1.08, -.54, .54);
    targetPitch = clamp(-((event.clientY - bounds.top) / bounds.height - .5) * 1.0, -.5, .5);
    wake();
  }
  listen(control, 'pointerenter', event => { if (event.pointerType === 'mouse' && fineQuery.matches) { hover = true; tilt(event); wake(); } });
  listen(control, 'pointermove', tilt);
  listen(control, 'pointerleave', event => { if (event.pointerType === 'mouse') { hover = false; keyboardTilt = false; targetYaw = targetPitch = 0; wake(); } });
  listen(control, 'pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    release(); heldPointer = event.pointerId; lastDirectInput = performance.now();
    if (event.pointerType !== 'mouse') hover = false;
    control.setPointerCapture(event.pointerId); tilt(event); wake();
  });
  const endPointer = event => { if (event.pointerId === heldPointer) { lastDirectInput = performance.now(); release(); } };
  listen(window, 'pointerup', endPointer); listen(window, 'pointercancel', endPointer); listen(control, 'lostpointercapture', endPointer);
  listen(control, 'contextmenu', event => event.preventDefault());
  listen(control, 'keydown', event => {
    if (event.key === 'Escape') { resetInteraction(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (reduced()) return;
      keyboardTilt = true;
      if (event.key === 'Home') targetYaw = targetPitch = 0;
      if (event.key === 'ArrowLeft') targetYaw = clamp(targetYaw - .18, -.54, .54);
      if (event.key === 'ArrowRight') targetYaw = clamp(targetYaw + .18, -.54, .54);
      if (event.key === 'ArrowUp') targetPitch = clamp(targetPitch + .18, -.5, .5);
      if (event.key === 'ArrowDown') targetPitch = clamp(targetPitch - .18, -.5, .5);
      wake(); return;
    }
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault(); if (event.repeat) return;
    release(); heldKey = event.key; lastDirectInput = performance.now(); wake();
  });
  listen(control, 'keyup', event => { if (event.key === heldKey) { event.preventDefault(); lastDirectInput = performance.now(); release(); } });
  listen(control, 'click', event => {
    if (event.detail === 0 && performance.now() - lastDirectInput > 500) { assistiveUntil = performance.now() + 4400; wake(); }
  });
  listen(control, 'blur', resetInteraction); listen(window, 'blur', resetInteraction);
  listen(document, 'visibilitychange', () => document.hidden ? suspend() : wake());
  listen(window, 'pagehide', suspend);
  const changeMotion = () => { keyboardTilt = false; targetYaw = targetPitch = 0; lastCameraTime = -Infinity; wake(); };
  listen(reducedQuery, 'change', changeMotion); listen(fineQuery, 'change', changeMotion);
  const motionObserver = new MutationObserver(changeMotion);
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  const visibilityObserver = new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting; inView ? wake() : suspend();
  }, { rootMargin: '50px' }); visibilityObserver.observe(host);
  function failed() {
    if (disposed) return;
    ready = false; host.dataset.ready = 'error'; status.textContent = 'Open the 3D model on Sketchfab';
    status.hidden = false; control.hidden = true;
    cancelAnimationFrame(pendingFrame); pendingFrame = 0;
    if (api && running) { api.stop(); running = false; }
  }
  const readyTimeout = setTimeout(() => { if (!ready) failed(); }, 60000);
  loadViewerSDK().then(Sketchfab => {
    if (disposed) return;
    const client = new Sketchfab('1.12.1', frame);
    client.init(MODEL_ID, {
      autostart: 1, camera: 0, autospin: 0, dnt: 1, scrollwheel: 0, max_texture_size: 2048,
      success(viewer) {
        api = viewer; running = true;
        api.addEventListener('viewerready', () => {
          if (disposed) return;
          api.setBackground({ color: [10 / 255, 10 / 255, 10 / 255] }, () => {});
          api.getNodeMap((error, nodeMap) => {
            if (disposed) return;
            const nodes = error ? [] : Object.values(nodeMap).filter(node => node.type === 'MatrixTransform' && hiddenNames.has(node.name));
            const uniqueNames = new Set(nodes.map(node => node.name));
            host.dataset.hiddenNodes = '[]'; host.dataset.modelVariant = 'original';
            const finish = () => api.setBackground({ color: [10 / 255, 10 / 255, 10 / 255] }, () => {
              if (disposed) return;
              clearTimeout(readyTimeout);
              ready = true; host.dataset.ready = 'true'; status.hidden = true; control.hidden = false; control.disabled = false;
              api.setCameraLookAt(basePosition, baseTarget, 0, () => {});
              api.getMaterialList((materialError, materials) => {
                if (!materialError && !disposed) {
                  materialRecords = materials.filter(material => ['led', 'led.001', 'led.002'].includes(material.name)).map(material => ({
                    material: structuredClone(material), baseline: material.channels.EmitColor ? structuredClone(material.channels.EmitColor) : null,
                  }));
                  host.dataset.emissiveMaterials = JSON.stringify(materialRecords.map(record => ({ name: record.material.name, stateSetID: record.material.stateSetID })));
                  wake();
                }
              });
              inView && !document.hidden ? wake() : suspend();
            });
            if (uniqueNames.size !== hiddenNames.size) { failed(); return; }
            let remaining = nodes.length; const hiddenIds = [];
            nodes.forEach(node => api.hide(node.instanceID, hideError => {
              if (!hideError) hiddenIds.push(node.instanceID);
              if (--remaining === 0) {
                host.dataset.hiddenNodes = JSON.stringify(hiddenIds);
                if (hiddenIds.length !== nodes.length) { failed(); return; }
                host.dataset.modelVariant = 'reactor-core'; finish();
              }
            }));
          });
        });
        api.start();
      },
      error: failed,
    });
  }).catch(failed);
  chargeAttributes();
  return { dispose() {
    disposed = true; ready = false; clearTimeout(readyTimeout); cancelAnimationFrame(pendingFrame);
    cleanup.forEach(remove => remove()); motionObserver.disconnect(); visibilityObserver.disconnect();
    if (api) api.stop(); host.replaceChildren(); delete host.dataset.sketchfabInitialized;
  } };
}

initSketchfabReactor();
