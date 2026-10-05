import * as THREE from './three.module.min.js';
import { armTransforms } from './current-arm-viewer.js';

// Project screen points onto a virtual sphere with a smooth hyperbolic rim.
// Quaternion deltas avoid the poles and axis locks of an azimuth/elevation orbit.
export function virtualSpherePoint(x, y, width, height) {
  const radius = Math.max(1, Math.min(width, height) * .43);
  const point = new THREE.Vector3((x - width / 2) / radius, (height / 2 - y) / radius, 0);
  const lengthSquared = point.x * point.x + point.y * point.y;
  point.z = lengthSquared <= .5 ? Math.sqrt(1 - lengthSquared) : .5 / Math.sqrt(lengthSquared);
  return point.normalize();
}

export function sphereRotation(from, to) {
  return new THREE.Quaternion().setFromUnitVectors(from, to).normalize();
}

function studioEnvironment(renderer) {
  // Only light is captured in this environment. There is no visible backdrop,
  // floor, grid or downloaded texture behind the actual CAD geometry.
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x24282e);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const materials = [];
  const panels = [
    { color: 0xffffff, intensity: 6, position: [-3, 3, 4], size: [3, 5] },
    { color: 0xd6e6ff, intensity: 3.5, position: [4, 1, 1], size: [2, 4] },
    { color: 0xffffff, intensity: 5, position: [0, 4, -3], size: [4, 2] },
    { color: 0xb3c1d4, intensity: 1.8, position: [-2, -2, -2], size: [2, 3] }
  ];
  for (const panel of panels) {
    const material = new THREE.MeshBasicMaterial({ color: panel.color, side: THREE.DoubleSide });
    material.color.multiplyScalar(panel.intensity);
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...panel.position);
    mesh.scale.set(...panel.size, 1);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  }
  const generator = new THREE.PMREMGenerator(renderer);
  let target;
  try { target = generator.fromScene(studio, .07, .1, 30); }
  finally {
    generator.dispose();
    geometry.dispose();
    materials.forEach(material => material.dispose());
  }
  return target;
}

let nextShowcase = 0;
export async function createArmShowcase(host) {
  if (host.dataset.showcaseReady) return;
  host.dataset.showcaseReady = 'loading';
  host.classList.add('arm-showcase');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Rotating 3D robotic arm');
  const id = `arm-showcase-${++nextShowcase}`;
  host.innerHTML = `<div class="arm-showcase-stage"><p class="arm-showcase-status" role="status">Loading the arm…</p></div><div class="arm-showcase-controls"><span class="arm-showcase-label" aria-hidden="true">LIVE 3D</span><div class="arm-showcase-actions"><button type="button" data-showcase-action="rotate" aria-pressed="false">Rotate</button><button type="button" data-showcase-action="motion" aria-pressed="false">Pause rotation</button><button type="button" data-showcase-action="home">Home view</button></div></div><p class="arm-showcase-hint" id="${id}-hint"></p>`;
  const stage = host.querySelector('.arm-showcase-stage');
  const status = host.querySelector('.arm-showcase-status');
  const hint = host.querySelector('.arm-showcase-hint');
  const motionButton = host.querySelector('[data-showcase-action="motion"]');
  const rotateButton = host.querySelector('[data-showcase-action="rotate"]');
  const buttons = [...host.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  const coarsePointer = matchMedia('(any-pointer: coarse)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const hasReducedMotion = () => document.documentElement.dataset.motion === 'reduced' ||
    (document.documentElement.dataset.motion !== 'full' && reducedMotion.matches);

  let renderer, scene, camera, rig, environment;
  let ready = false, disposed = false, contextLost = false;
  let intersecting = false, pageVisible = !document.hidden, touchRotating = false;
  let autoRotate = !hasReducedMotion(), frame = 0, lastTime = 0, frameCount = 0;
  let pointer = null, modelRadius = .3, currentZoom = 1;
  let resizeObserver, intersectionObserver, panelObserver, motionObserver;
  const geometryResources = [], materialResources = [], cleanupListeners = [];
  // Match the simulation's side view: gripper at left, 15 degrees above level.
  const homeTheta = 2.85, homePhi = 1.31;
  const homeEye = new THREE.Vector3(Math.sin(homeTheta) * Math.sin(homePhi), Math.cos(homePhi), Math.cos(homeTheta) * Math.sin(homePhi));
  const homeOrientation = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(homeEye, new THREE.Vector3(), new THREE.Vector3(0, 1, 0))
  ).invert();
  const idleAxis = new THREE.Vector3(.055, 1, .025).normalize();
  const idleRotation = new THREE.Quaternion();
  const listen = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    cleanupListeners.push(() => target.removeEventListener(event, handler, options));
  };
  const shown = () => ready && !disposed && !contextLost && intersecting && pageVisible &&
    !host.closest('[hidden], [aria-hidden="true"]') && stage.clientWidth > 0 && stage.clientHeight > 0;

  function updateControls() {
    motionButton.textContent = autoRotate ? 'Pause rotation' : 'Resume rotation';
    motionButton.setAttribute('aria-pressed', String(autoRotate));
    rotateButton.textContent = touchRotating ? 'Done' : 'Rotate';
    rotateButton.setAttribute('aria-pressed', String(touchRotating));
    host.dataset.autoRotate = String(autoRotate);
    host.dataset.touchRotating = String(touchRotating);
    hint.textContent = touchRotating ? 'Drag in any direction · Done to scroll' :
      coarsePointer.matches ? 'Tap Rotate to explore · swipe to scroll' : 'Drag in any direction to explore';
  }
  function stopFrame() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    host.dataset.animating = 'false';
  }
  function queueFrame() {
    if (shown() && !frame) frame = requestAnimationFrame(render);
  }
  function render(time) {
    frame = 0;
    if (!shown()) { stopFrame(); return; }
    const delta = lastTime ? Math.min((time - lastTime) / 1000, .05) : 0;
    lastTime = time;
    if (autoRotate && !pointer) {
      idleRotation.setFromAxisAngle(idleAxis, delta * .24);
      rig.quaternion.premultiply(idleRotation).normalize();
    }
    renderer.render(scene, camera);
    host.dataset.frameCount = String(++frameCount);
    host.dataset.orientation = JSON.stringify(rig.quaternion.toArray().map(value => Number(value.toFixed(6))));
    host.dataset.animating = String(autoRotate && !pointer);
    if (autoRotate && !pointer) queueFrame();
    else lastTime = 0;
  }
  function setMotion(value) {
    autoRotate = value;
    lastTime = 0;
    updateControls();
    if (!value) stopFrame();
    queueFrame();
  }
  function releasePointer() {
    if (!pointer || !renderer) return;
    const canvas = renderer.domElement;
    const pointerId = pointer.id;
    pointer = null;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }
  function setTouchRotation(value) {
    touchRotating = value;
    releasePointer();
    host.classList.toggle('is-touch-rotating', value);
    if (renderer) renderer.domElement.style.touchAction = value ? 'none' : 'pan-y';
    if (value) setMotion(false);
    updateControls();
  }
  function updateVisibility() {
    if (shown()) queueFrame();
    else { stopFrame(); setTouchRotation(false); }
  }
  function fitCamera() {
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    // A bounding sphere fits every orientation, including upside-down and edge-on.
    const distance = modelRadius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * 1.12;
    camera.position.set(0, 0, distance * currentZoom);
    camera.near = Math.max(.001, distance - modelRadius * 3);
    camera.far = distance + modelRadius * 8;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    host.dataset.cameraDistance = camera.position.z.toFixed(6);
  }
  function resize() {
    if (!ready || !stage.clientWidth || !stage.clientHeight) { stopFrame(); return; }
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    camera.aspect = stage.clientWidth / stage.clientHeight;
    fitCamera();
    queueFrame();
  }
  function home() {
    if (!ready) return;
    setMotion(false);
    rig.quaternion.copy(homeOrientation);
    currentZoom = 1;
    fitCamera();
    queueFrame();
  }
  function cleanResources() {
    stopFrame();
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    panelObserver?.disconnect();
    motionObserver?.disconnect();
    cleanupListeners.forEach(remove => remove());
    environment?.dispose();
    geometryResources.forEach(geometry => geometry.dispose());
    materialResources.forEach(material => material.dispose());
    renderer?.dispose();
  }
  function fail(message) {
    ready = false;
    host.dataset.showcaseReady = 'error';
    host.dataset.modelLoaded = 'false';
    status.hidden = false;
    status.textContent = message;
    host.querySelector('.arm-showcase-controls').hidden = true;
    hint.hidden = true;
    renderer?.domElement.remove();
    cleanResources();
  }

  updateControls();
  try {
    const url = new URL(host.dataset.armShowcase, document.baseURI);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Model unavailable');
    const model = await response.json();
    if (model.format !== 'portfolio-articulated-arm-v1') throw new Error('Unsupported model');
    const binary = await fetch(new URL(model.buffer, url));
    if (!binary.ok) throw new Error('Geometry unavailable');
    const buffer = await binary.arrayBuffer();
    const angles = JSON.parse(host.dataset.armPose || '[90,30.3,5.5,70,-15.3]');
    if (!Array.isArray(angles) || angles.length !== 5 || angles.some((angle, i) =>
      !Number.isFinite(angle) || angle < model.joints[i].min || angle > model.joints[i].max)) {
      throw new Error('Invalid presentation pose');
    }
    const { matrices, closureError } = armTransforms(model, angles);
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(34, 1, .001, 10);
    rig = new THREE.Group();
    scene.add(rig);
    const assembly = new THREE.Group();
    rig.add(assembly);
    environment = studioEnvironment(renderer);
    scene.environment = environment.texture;
    const silver = new THREE.MeshStandardMaterial({ color: 0xaeb5bf, roughness: .39, metalness: .62, envMapIntensity: 1.0 });
    const cover = new THREE.MeshStandardMaterial({ color: 0x8b949f, roughness: .43, metalness: .5, envMapIntensity: .95 });
    const graphite = new THREE.MeshStandardMaterial({ color: 0x373f49, roughness: .38, metalness: .3, envMapIntensity: 1.1 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xd0d4db, roughness: .22, metalness: .86, envMapIntensity: 1.15 });
    materialResources.push(silver, cover, graphite, metal);
    const coverCodes = new Set(['40', '41', '42', '43', '39', '44', '07', '07B']);
    const read = view => {
      if (!Number.isInteger(view.byteOffset) || !Number.isInteger(view.count) || view.byteOffset < 0 || view.count < 0 ||
          view.byteOffset % 4 || view.byteOffset + view.count * 4 > buffer.byteLength || !['uint32', 'float32'].includes(view.type)) {
        throw new Error('Invalid geometry');
      }
      return view.type === 'uint32' ? new Uint32Array(buffer, view.byteOffset, view.count) : new Float32Array(buffer, view.byteOffset, view.count);
    };
    for (const row of model.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometryResources.push(geometry);
      geometry.setAttribute('position', new THREE.BufferAttribute(read(row.positions), 3));
      geometry.setIndex(new THREE.BufferAttribute(read(row.indices), 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const material = row.kind === 'horn' ? metal : row.kind === 'servo' ? graphite : coverCodes.has(row.code) ? cover : silver;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = row.name;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrices.get(row.code));
      assembly.add(mesh);
    }
    assembly.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(assembly);
    const center = bounds.getCenter(new THREE.Vector3());
    assembly.position.copy(center).negate();
    // Exact posed vertices keep the floating object large without clipping on spin.
    modelRadius = 0;
    const point = new THREE.Vector3();
    for (const mesh of assembly.children) {
      const positions = mesh.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) {
        point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrix).sub(center);
        modelRadius = Math.max(modelRadius, point.length());
      }
    }
    rig.quaternion.copy(homeOrientation);
    scene.add(new THREE.HemisphereLight(0xecf3ff, 0x333641, 1.8));
    for (const [color, intensity, position] of [[0xffffff, 2.7, [-.5, .7, .6]], [0xccddff, 1.8, [.6, .2, -.5]], [0xffffff, 1.2, [-.4, -.1, -.6]]]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position);
      scene.add(light);
    }
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Three-dimensional robotic arm. Drag or use arrow keys to rotate; Q and E roll, Space pauses or resumes, Home restores the starting view.');
    canvas.setAttribute('aria-describedby', hint.id);
    canvas.style.touchAction = 'pan-y';
    stage.append(canvas);
    listen(canvas, 'pointerdown', event => {
      if (event.button !== 0 || pointer || (event.pointerType === 'touch' && !touchRotating)) return;
      event.preventDefault();
      setMotion(false);
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      const rect = canvas.getBoundingClientRect();
      pointer = { id: event.pointerId, point: virtualSpherePoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height) };
      canvas.classList.add('is-dragging');
    });
    listen(canvas, 'pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const rect = canvas.getBoundingClientRect();
      const next = virtualSpherePoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
      rig.quaternion.premultiply(sphereRotation(pointer.point, next)).normalize();
      pointer.point = next;
      queueFrame();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => listen(canvas, type, event => {
      if (pointer?.id === event.pointerId) releasePointer();
    }));
    listen(canvas, 'blur', releasePointer);
    listen(canvas, 'keydown', event => {
      const rotations = { ArrowLeft: [0, 1, 0, -.15], ArrowRight: [0, 1, 0, .15], ArrowUp: [1, 0, 0, -.15], ArrowDown: [1, 0, 0, .15], q: [0, 0, 1, .15], e: [0, 0, 1, -.15] };
      const rotation = rotations[event.key];
      if (rotation) {
        event.preventDefault(); setMotion(false);
        rig.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...rotation.slice(0, 3)), rotation[3])).normalize();
        queueFrame();
      } else if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); setMotion(!autoRotate); }
      else if (event.key === 'Home') { event.preventDefault(); home(); }
      else if (event.key === 'Escape') { event.preventDefault(); setTouchRotation(false); }
    });
    listen(motionButton, 'click', () => { releasePointer(); setTouchRotation(false); setMotion(!autoRotate); });
    listen(rotateButton, 'click', () => setTouchRotation(!touchRotating));
    listen(host.querySelector('[data-showcase-action="home"]'), 'click', home);
    listen(document, 'visibilitychange', () => { pageVisible = !document.hidden; updateVisibility(); });
    listen(window, 'pagehide', event => { stopFrame(); if (!event.persisted) { disposed = true; cleanResources(); } });
    listen(window, 'pageshow', () => { pageVisible = !document.hidden; updateVisibility(); });
    listen(coarsePointer, 'change', updateControls);
    const preferenceChanged = () => { setTouchRotation(false); setMotion(!hasReducedMotion()); };
    listen(reducedMotion, 'change', preferenceChanged);
    motionObserver = new MutationObserver(preferenceChanged);
    motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    const panel = host.closest('[data-gallery-panel]');
    if (panel) {
      panelObserver = new MutationObserver(updateVisibility);
      panelObserver.observe(panel, { attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class'] });
    }
    listen(canvas, 'webglcontextlost', event => {
      event.preventDefault(); contextLost = true; stopFrame();
      releasePointer(); setTouchRotation(false);
      host.dataset.showcaseReady = 'context-lost';
      status.hidden = false;
      status.textContent = 'Your browser paused the 3D view. Reload to try again, or explore the project below.';
      buttons.forEach(button => { button.disabled = true; });
    });
    listen(canvas, 'webglcontextrestored', () => {
      try {
        scene.environment = null;
        environment.dispose();
        environment = studioEnvironment(renderer);
        scene.environment = environment.texture;
        contextLost = false;
        host.dataset.showcaseReady = 'ready';
        status.hidden = true;
        buttons.forEach(button => { button.disabled = false; });
        resize(); updateVisibility();
      } catch (error) {
        fail('The 3D view could not restart. Reload to try again, or explore the project below.');
      }
    });
    ready = true;
    host.dataset.showcaseReady = 'ready';
    host.dataset.modelLoaded = 'true';
    host.dataset.meshCount = String(model.meshes.length);
    host.dataset.jointAngles = JSON.stringify(angles);
    host.dataset.linkageErrorMm = (closureError * 1000).toExponential(3);
    host.dataset.background = 'transparent';
    status.hidden = true;
    buttons.forEach(button => { button.disabled = false; });
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    intersectionObserver = new IntersectionObserver(entries => { intersecting = entries[0].isIntersecting; updateVisibility(); });
    intersectionObserver.observe(host);
    resize(); updateControls();
  } catch (error) {
    fail('The 3D model could not load. You can still explore the project and CAD images.');
    console.warn('Arm showcase:', error.message);
  }
}

export function initArmShowcases(root = document) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      createArmShowcase(entry.target);
    }
  }, { rootMargin: '180px' });
  root.querySelectorAll('[data-arm-showcase]').forEach(host => observer.observe(host));
}
if (typeof document !== 'undefined') initArmShowcases();
