import * as THREE from './three.module.min.js';

// The meshes, joint frames and four-bar dimensions are the native CAD data used
// by the Unity simulation. These transforms are visual only.
const radians = THREE.MathUtils.degToRad;
const vector = value => new THREE.Vector3(...value);
const translatedRotation = (pivot, rotation, destination = pivot) => new THREE.Matrix4()
  .makeTranslation(...destination.toArray())
  .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
  .multiply(new THREE.Matrix4().makeTranslation(...pivot.clone().negate().toArray()));
const signedAngle = (from, to, axis) => Math.atan2(
  axis.dot(new THREE.Vector3().crossVectors(from, to)), from.dot(to));

export function armTransforms(model, angles) {
  const stages = { Fixed: new THREE.Matrix4() };
  for (let i = 0; i < 4; i++) {
    const joint = model.joints[i];
    const rotation = new THREE.Quaternion().setFromAxisAngle(vector(joint.axis).normalize(), radians(angles[i]));
    stages[joint.name] = stages[joint.parent].clone().multiply(translatedRotation(vector(joint.pivot), rotation));
  }
  const gripper = new Map();
  const tips = [];
  const axis = vector(model.gripper.axis).normalize();
  let closureError = 0;
  for (const side of model.gripper.sides) {
    const [a,b,c,d] = ['a','b','c','d'].map(key => vector(side[key]));
    const gear = new THREE.Quaternion().setFromAxisAngle(axis, radians(angles[4] * side.direction));
    const nextB = b.clone().sub(a).applyQuaternion(gear).add(a);
    const bd = d.clone().sub(nextB), distance = bd.length();
    const jawLength = c.distanceTo(b), linkLength = c.distanceTo(d);
    if (distance < 1e-8 || distance > jawLength + linkLength + 1e-6 || distance < Math.abs(jawLength-linkLength)-1e-6) {
      throw new Error('The gripper cannot close at this pose.');
    }
    const x = (jawLength*jawLength-linkLength*linkLength+distance*distance)/(2*distance);
    const heightSquared = jawLength*jawLength-x*x;
    if (heightSquared < -1e-8) throw new Error('The gripper cannot close at this pose.');
    const unit = bd.normalize();
    const perpendicular = new THREE.Vector3().crossVectors(axis, unit).normalize();
    const originalSide = new THREE.Vector3().crossVectors(axis, d.clone().sub(b).normalize()).normalize();
    const branch = c.clone().sub(b).dot(originalSide) >= 0 ? 1 : -1;
    const nextC = nextB.clone().addScaledVector(unit,x).addScaledVector(perpendicular,Math.sqrt(Math.max(0,heightSquared))*branch);
    const jaw = new THREE.Quaternion().setFromAxisAngle(axis,signedAngle(c.clone().sub(b),nextC.clone().sub(nextB),axis));
    const link = new THREE.Quaternion().setFromAxisAngle(axis,signedAngle(c.clone().sub(d),nextC.clone().sub(d),axis));
    for (const code of [side.gearCode,...side.hornCodes]) gripper.set(code,translatedRotation(a,gear));
    gripper.set(side.jawCode,translatedRotation(b,jaw,nextB));
    for (const code of side.linkCodes) gripper.set(code,translatedRotation(d,link));
    tips.push(vector(side.tip).sub(b).applyQuaternion(jaw).add(nextB));
    closureError = Math.max(closureError,Math.abs(nextB.distanceTo(nextC)-jawLength),Math.abs(d.distanceTo(nextC)-linkLength));
  }
  const matrices = new Map(model.meshes.map(mesh => [mesh.code,
    mesh.stage === 'Gripper' ? stages.Wrist.clone().multiply(gripper.get(mesh.code) || new THREE.Matrix4()) : stages[mesh.stage].clone()
  ]));
  return {matrices,tips,closureError};
}

let nextViewer = 0;
export async function createCurrentArmViewer(host) {
  if (host.dataset.viewerReady) return;
  host.dataset.viewerReady = 'true';
  host.classList.add('current-arm-viewer');
  host.setAttribute('role','region');
  host.setAttribute('aria-label','Interactive robotic arm CAD model');
  const id = 'current-arm-' + ++nextViewer;
  host.innerHTML = `<div class="current-arm-visual"><div class="current-arm-stage"><p class="current-arm-status" role="status">Loading the CAD model…</p></div></div><div class="current-arm-controls"><div class="current-arm-control-heading"><span>Joint angles</span><button type="button" data-action="reset">Reset pose</button></div><div class="current-arm-sliders"></div><p class="current-arm-note">CAD exploration · four positioning joints + gripper</p></div>`;
  const stage = host.querySelector('.current-arm-stage');
  const status = host.querySelector('.current-arm-status');
  const sliderHost = host.querySelector('.current-arm-sliders');
  const buttons = [...host.querySelectorAll('button')];
  buttons.forEach(button => button.disabled = true);
  let renderer, scene, camera, model, angles, meshes, resizeObserver;
  let ready = false, visible = true, pendingFrame = 0;
  const homeTheta = -1.18, homePhi = 1.23;
  let theta = homeTheta, phi = homePhi, distance = .85, fittedDistance = .85;
  const target = new THREE.Vector3();
  const bounds = new THREE.Box3();
  const pointers = new Map();
  const sliders = [];
  let pinchDistance = 0;
  function render() {
    pendingFrame = 0;
    if (!ready || !visible) return;
    camera.position.set(target.x+distance*Math.sin(phi)*Math.sin(theta),target.y+distance*Math.cos(phi),target.z+distance*Math.sin(phi)*Math.cos(theta));
    camera.lookAt(target);
    renderer.render(scene,camera);
    host.dataset.viewTheta = theta.toFixed(5);
    host.dataset.viewPhi = phi.toFixed(5);
    host.dataset.viewDistance = distance.toFixed(5);
  }
  function requestRender() { if (!pendingFrame) pendingFrame = requestAnimationFrame(render); }
  function orbit(dx,dy) { theta += dx; phi = THREE.MathUtils.clamp(phi+dy,.12,Math.PI-.12); requestRender(); }
  function zoom(factor) { distance = THREE.MathUtils.clamp(distance*factor,.18,2.8); requestRender(); }
  function poseBounds() {
    bounds.makeEmpty();
    for (const mesh of meshes.values()) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrix));
    return bounds;
  }
  function fit(resetDirection = false) {
    if (!ready) return;
    if (resetDirection) { theta = homeTheta; phi = homePhi; }
    const box = poseBounds();
    box.getCenter(target);
    const tanV = Math.tan(radians(camera.fov/2)), tanH = tanV*camera.aspect;
    let needed = .1;
    for (const mesh of meshes.values()) {
      const local=mesh.geometry.boundingBox;
      for (const x0 of [local.min.x,local.max.x]) for (const y0 of [local.min.y,local.max.y]) for (const z0 of [local.min.z,local.max.z]) {
      const point=new THREE.Vector3(x0,y0,z0).applyMatrix4(mesh.matrix).sub(target);
      const {x,y,z}=point;
      const across=x*Math.cos(theta)-z*Math.sin(theta);
      const up=-x*Math.cos(phi)*Math.sin(theta)+y*Math.sin(phi)-z*Math.cos(phi)*Math.cos(theta);
      const toward=x*Math.sin(phi)*Math.sin(theta)+y*Math.cos(phi)+z*Math.sin(phi)*Math.cos(theta);
      needed=Math.max(needed,toward+Math.max(Math.abs(across)/tanH,Math.abs(up)/tanV)/.88);
      }
    }
    fittedDistance=needed+.01;distance=fittedDistance;requestRender();
  }
  function updatePose() {
    const {matrices,closureError} = armTransforms(model,angles);
    for (const [code,mesh] of meshes) { mesh.matrix.copy(matrices.get(code)); mesh.matrixWorldNeedsUpdate=true; }
    sliders.forEach(({input,output},i) => {
      input.value=String(angles[i]);
      output.value=i===4 ? `${Math.round((27-angles[i])/87*100)}% open` : `${Math.round(angles[i])}°`;
      input.setAttribute('aria-valuetext',output.value);
    });
    host.dataset.jointAngles=JSON.stringify(angles);
    host.dataset.linkageErrorMm=(closureError*1000).toExponential(3);
    requestRender();
  }
  function releasePointers() {
    pointers.clear();pinchDistance=0;
    renderer?.domElement.classList.remove('is-dragging');
  }
  function resize() {
    if (!ready || !stage.clientWidth || !stage.clientHeight) return;
    camera.aspect=stage.clientWidth/stage.clientHeight;camera.updateProjectionMatrix();
    renderer.setSize(stage.clientWidth,stage.clientHeight,false);fit();
  }
  try {
    const url = new URL(host.dataset.currentArmModel || 'assets/current-arm.model.json',document.baseURI);
    const response=await fetch(url);if (!response.ok) throw new Error('Model unavailable');
    model=await response.json();
    if (model.format!=='portfolio-articulated-arm-v1') throw new Error('Unsupported model');
    const binary=await fetch(new URL(model.buffer,url));if (!binary.ok) throw new Error('Geometry unavailable');
    const buffer=await binary.arrayBuffer();
    renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.75));
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
    camera=new THREE.PerspectiveCamera(35,1,.005,10);scene=new THREE.Scene();meshes=new Map();
    const read = view => {
      if (!Number.isInteger(view.byteOffset)||!Number.isInteger(view.count)||view.byteOffset<0||view.count<0||view.byteOffset+view.count*4>buffer.byteLength) throw new Error('Invalid geometry');
      return view.type==='uint32' ? new Uint32Array(buffer,view.byteOffset,view.count) : new Float32Array(buffer,view.byteOffset,view.count);
    };
    const red=new THREE.MeshStandardMaterial({color:0xb62738,roughness:.54,metalness:.13,flatShading:true});
    const graphite=new THREE.MeshStandardMaterial({color:0x4d5157,roughness:.62,metalness:.12,flatShading:true});
    const servo=new THREE.MeshStandardMaterial({color:0x171c23,roughness:.5,metalness:.25,flatShading:true});
    const metal=new THREE.MeshStandardMaterial({color:0xb7b8b9,roughness:.27,metalness:.8,flatShading:true});
    const darkPrinted=new Set(['40','41','42','43','08','09','20','39','44']);
    for (const row of model.meshes) {
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(read(row.positions),3));geometry.setIndex(new THREE.BufferAttribute(read(row.indices),1));geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
      const material=row.kind==='horn'?metal:row.kind==='servo'?servo:darkPrinted.has(row.code)?graphite:red;
      const mesh=new THREE.Mesh(geometry,material);mesh.name=row.name;mesh.matrixAutoUpdate=false;scene.add(mesh);meshes.set(row.code,mesh);
    }
    scene.add(new THREE.HemisphereLight(0xeaf3ff,0x323039,2.2));
    for (const [color,intensity,position] of [[0xffffff,3.4,[-.3,.7,.6]],[0xaccfff,2,[.5,.35,-.4]],[0xffffff,1.5,[-.5,.12,-.6]]]) {
      const light=new THREE.DirectionalLight(color,intensity);light.position.set(...position);scene.add(light);
    }
    const grid=new THREE.GridHelper(.66,12,0x353b44,0x22262d);grid.position.y=-.002;grid.material.transparent=true;grid.material.opacity=.5;scene.add(grid);
    const canvas=renderer.domElement;canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Robot arm CAD model. Arrow keys rotate, plus and minus zoom, Home fits the view.');canvas.style.touchAction='pan-y pinch-zoom';stage.append(canvas);
    model.joints.forEach((joint,i) => {
      const row=document.createElement('label');row.className='current-arm-slider';
      const heading=document.createElement('span');heading.className='current-arm-slider-heading';
      const name=document.createElement('span');name.textContent=i===3?'Wrist pitch':joint.name;
      const output=document.createElement('output');output.htmlFor=`${id}-joint-${i}`;
      const input=document.createElement('input');input.type='range';input.id=`${id}-joint-${i}`;input.min=String(joint.min);input.max=String(joint.max);input.step='1';input.setAttribute('aria-label',name.textContent);
      input.addEventListener('input',()=>{angles[i]=Number(input.value);updatePose();fit();});
      heading.append(name,output);row.append(heading,input);sliderHost.append(row);sliders.push({input,output});
    });
    canvas.addEventListener('pointerdown',event => {
      if (event.button!==0) return;
      if(event.pointerType!=='touch')event.preventDefault();canvas.focus({preventScroll:true});canvas.setPointerCapture(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});canvas.classList.add('is-dragging');
      if(pointers.size===2){const [a,b]=pointers.values();pinchDistance=Math.hypot(a.x-b.x,a.y-b.y);}
    });
    canvas.addEventListener('pointermove',event => {
      const previous=pointers.get(event.pointerId);if (!previous) return;
      const dx=event.clientX-previous.x,dy=event.clientY-previous.y;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(pointers.size===2){const [a,b]=pointers.values();const next=Math.hypot(a.x-b.x,a.y-b.y);if(pinchDistance>0&&next>0)zoom(pinchDistance/next);pinchDistance=next;}else orbit(-dx*.009,-dy*.009);
    });
    const release=event=>{pointers.delete(event.pointerId);pinchDistance=0;if(!pointers.size)canvas.classList.remove('is-dragging');};
    ['pointerup','pointercancel','lostpointercapture'].forEach(type=>canvas.addEventListener(type,release));
    canvas.addEventListener('blur',()=>{pointers.clear();pinchDistance=0;canvas.classList.remove('is-dragging');});
    canvas.addEventListener('keydown',event=>{
      const actions={ArrowLeft:()=>orbit(-.15,0),ArrowRight:()=>orbit(.15,0),ArrowUp:()=>orbit(0,-.15),ArrowDown:()=>orbit(0,.15),'+':()=>zoom(.85),'=':()=>zoom(.85),'-':()=>zoom(1.18),Home:()=>fit(true),Escape:releasePointers};
      if(actions[event.key]){event.preventDefault();actions[event.key]();}
    });
    const actions={reset:()=>{angles=[...model.presentationPose];updatePose();fit(true);}};
    host.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',actions[button.dataset.action]));
    ready=true;angles=[...model.presentationPose];updatePose();status.hidden=true;buttons.forEach(button=>button.disabled=false);host.dataset.modelLoaded='true';host.dataset.meshCount=String(meshes.size);
    resizeObserver=new ResizeObserver(resize);resizeObserver.observe(stage);resize();
    const visibilityObserver=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible)requestRender();else releasePointers();});visibilityObserver.observe(host);
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();ready=false;status.hidden=false;status.textContent='The 3D view was paused by your browser. Reload the page to try again.';buttons.forEach(button=>button.disabled=true);});
  } catch(error) {
    host.dataset.modelLoaded='false';
    status.textContent='The interactive view could not load. You can still explore the build photos below.';
    host.querySelector('.current-arm-controls').hidden=true;
    if(renderer)renderer.dispose();if(resizeObserver)resizeObserver.disconnect();
    console.warn('Arm CAD viewer:',error.message);
  }
}

export function initCurrentArmViewers(root=document) {
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);createCurrentArmViewer(entry.target);}},{rootMargin:'240px'});
  root.querySelectorAll('[data-current-arm-model]').forEach(host=>observer.observe(host));
}
if(typeof document!=='undefined')initCurrentArmViewers();
