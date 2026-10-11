import * as THREE from './three.module.min.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

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
  try { target = generator.fromScene(studio, .03, .1, 30); }
  finally {
    generator.dispose();
    geometry.dispose();
    materials.forEach(material => material.dispose());
  }
  return target;
}

export async function createPcbShowcase(host) {
  if (host.dataset.showcaseReady) return;
  host.dataset.showcaseReady = 'loading';
  host.classList.add('pcb-showcase');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Rotating 3D PCB assembly');
  host.innerHTML = `<div class="pcb-showcase-stage"><p class="pcb-showcase-status" role="status">Loading the 3D model…</p></div>`;
  const stage = host.querySelector('.pcb-showcase-stage');
  const status = host.querySelector('.pcb-showcase-status');

  let renderer, scene, camera, rig, environment;
  let ready = false, disposed = false, contextLost = false;
  let intersecting = false, pageVisible = !document.hidden;
  let frame = 0, lastTime = 0, frameCount = 0;
  let pointer = null, modelRadius = .035, currentZoom = 1;
  let resizeObserver, intersectionObserver, panelObserver;
  const geometryResources = [], materialResources = [], cleanupListeners = [];
  // Native KiCad GLB is Y-up, with components on +Y. Tilt the top toward the viewer.
  const homeOrientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.95, .16, -.25));
  const idleAxis = new THREE.Vector3(.055, 1, .025).normalize();
  const idleRotation = new THREE.Quaternion();
  const listen = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    cleanupListeners.push(() => target.removeEventListener(event, handler, options));
  };
  const shown = () => ready && !disposed && !contextLost && intersecting && pageVisible &&
    !host.closest('[hidden], [aria-hidden="true"]') && stage.clientWidth > 0 && stage.clientHeight > 0;

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
    if (!pointer) {
      idleRotation.setFromAxisAngle(idleAxis, delta * .20);
      rig.quaternion.premultiply(idleRotation).normalize();
    }
    renderer.render(scene, camera);
    host.dataset.frameCount = String(++frameCount);
    host.dataset.orientation = JSON.stringify(rig.quaternion.toArray().map(value => Number(value.toFixed(6))));
    host.dataset.animating = String(!pointer);
    if (!pointer) queueFrame();
    else lastTime = 0;
  }
  function releasePointer() {
    if (!pointer || !renderer) return;
    const canvas = renderer.domElement;
    const pointerId = pointer.id;
    pointer = null;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    lastTime = 0;
    queueFrame();
  }
  function updateVisibility() {
    if (shown()) queueFrame();
    else { stopFrame(); releasePointer(); }
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
    releasePointer();
    lastTime = 0;
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
    renderer?.domElement.remove();
    cleanResources();
  }

  host.dataset.autoRotate = 'true';
  try {
    const url = new URL(host.dataset.pcbShowcase, document.baseURI);
    const gltf = await new GLTFLoader().loadAsync(url.href);
    const assembly = gltf.scene;
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(34, 1, .001, 10);
    rig = new THREE.Group();
    scene.add(rig);
    rig.add(assembly);
    environment = studioEnvironment(renderer);
    scene.environment = environment.texture;
    const geometries = new Set(), materials = new Set();
    let meshCount = 0;
    assembly.traverse(node => {
      if (!node.isMesh) return;
      meshCount++;
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(material);
      }
    });
    geometryResources.push(...geometries);
    materialResources.push(...materials);
    assembly.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(assembly);
    const center = bounds.getCenter(new THREE.Vector3());
    const point = new THREE.Vector3();
    modelRadius = 0;
    assembly.traverse(node => {
      if (!node.isMesh) return;
      const positions = node.geometry.attributes.position;
      for (let index = 0; index < positions.count; index++) {
        point.fromBufferAttribute(positions, index).applyMatrix4(node.matrixWorld).sub(center);
        modelRadius = Math.max(modelRadius, point.length());
      }
    });
    if (!Number.isFinite(modelRadius) || modelRadius <= 0) throw new Error('Empty PCB geometry');
    assembly.position.sub(center);
    host.dataset.meshCount = String(meshCount);
    host.dataset.modelSource = 'Native KiCad assembly';
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
    canvas.setAttribute('aria-label', 'Continuously rotating three-dimensional PCB assembly. Drag or use arrow keys to turn it; Q and E roll, Home restores the starting view. Automatic rotation resumes when you release it.');
    canvas.style.touchAction = 'pan-y pinch-zoom';
    stage.append(canvas);
    listen(canvas, 'pointerdown', event => {
      if (event.button !== 0 || pointer) return;
      if (event.pointerType !== 'touch') event.preventDefault();
      stopFrame();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      const rect = canvas.getBoundingClientRect();
      pointer = { id: event.pointerId, point: virtualSpherePoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height) };
      canvas.classList.add('is-dragging');
      queueFrame();
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
    listen(window, 'blur', releasePointer);
    listen(canvas, 'keydown', event => {
      const rotations = { ArrowLeft: [0, 1, 0, -.15], ArrowRight: [0, 1, 0, .15], ArrowUp: [1, 0, 0, -.15], ArrowDown: [1, 0, 0, .15], q: [0, 0, 1, .15], e: [0, 0, 1, -.15] };
      const rotation = rotations[event.key];
      if (rotation) {
        event.preventDefault();
        rig.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...rotation.slice(0, 3)), rotation[3])).normalize();
        queueFrame();
      } else if (event.key === 'Home') { event.preventDefault(); home(); }
      else if (event.key === 'Escape') { event.preventDefault(); releasePointer(); }
    });
    listen(document, 'visibilitychange', () => { pageVisible = !document.hidden; updateVisibility(); });
    listen(window, 'pagehide', event => { pageVisible = false; releasePointer(); stopFrame(); if (!event.persisted) { disposed = true; cleanResources(); } });
    listen(window, 'pageshow', () => { pageVisible = !document.hidden; updateVisibility(); });
    const panel = host.closest('[data-gallery-panel]');
    if (panel) {
      panelObserver = new MutationObserver(updateVisibility);
      panelObserver.observe(panel, { attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class'] });
    }
    listen(canvas, 'webglcontextlost', event => {
      event.preventDefault(); contextLost = true; stopFrame();
      releasePointer();
      host.dataset.showcaseReady = 'context-lost';
      status.hidden = false;
      status.textContent = 'Your browser paused the 3D view. Reload to try again, or explore the project below.';
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
        resize(); updateVisibility();
      } catch (error) {
        fail('The 3D view could not restart. Reload to try again, or explore the project below.');
      }
    });
    ready = true;
    host.dataset.showcaseReady = 'ready';
    host.dataset.modelLoaded = 'true';
    host.dataset.background = 'transparent';
    status.hidden = true;
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    intersectionObserver = new IntersectionObserver(entries => { intersecting = entries[0].isIntersecting; updateVisibility(); });
    intersectionObserver.observe(host);
    resize();
  } catch (error) {
    fail('The 3D PCB could not load. Select Top layer or Bottom layer to inspect the board.');
    console.warn('PCB showcase:', error.message);
  }
}

export function initPcbShowcases(root = document) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      createPcbShowcase(entry.target);
    }
  }, { rootMargin: '180px' });
  root.querySelectorAll('[data-pcb-showcase]').forEach(host => observer.observe(host));
}
if (typeof document !== 'undefined') initPcbShowcases();
