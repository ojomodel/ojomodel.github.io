import * as THREE from './three.module.min.js';

// Exact CAD mesh data is shared between instances; every card keeps its own view.
const modelCache = new Map();
let nextId = 0;
async function getModel(url) {
  const absolute = new URL(url, document.baseURI).href;
  if (!modelCache.has(absolute)) modelCache.set(absolute, (async () => {
    const response = await fetch(absolute);
    if (!response.ok) throw new Error('Model unavailable');
    const model = await response.json();
    if (model.format !== 'portfolio-native-mesh-v1' || !model.meshes?.length) throw new Error('Unsupported model');
    const bin = await fetch(new URL(model.buffer,absolute));
    if (!bin.ok) throw new Error('Geometry unavailable');
    return {model, buffer:await bin.arrayBuffer()};
  })().catch(error => {modelCache.delete(absolute); throw error;}));
  return modelCache.get(absolute);
}

export function createPrototypeViewer(host) {
  if (host.dataset.viewerReady) return;
  host.dataset.viewerReady = 'true';
  const name = host.dataset.prototypeName || 'Prototype';
  const touchUI=window.matchMedia('(pointer:coarse)').matches;
  const id = 'prototype-viewer-' + ++nextId;
  host.classList.add('prototype-viewer');
  host.setAttribute('role','region');
  host.setAttribute('aria-label',name+' interactive 3D model');
  const stage = document.createElement('div');
  stage.className='prototype-viewer-stage';
  const status = document.createElement('p');
  status.className='prototype-viewer-status';
  status.setAttribute('role','status');
  status.textContent='Loading 3D model…';
  const hint = document.createElement('p');
  hint.id=id+'-hint';
  hint.className='prototype-viewer-hint';
  hint.textContent=touchUI?'Tap Explore to rotate · swipe the page to scroll':'Drag to rotate · use + / − to zoom';
  const controls=document.createElement('div');
  controls.className='prototype-viewer-controls';
  const makeButton=(text,label,handler)=>{
    const button=document.createElement('button');
    button.type='button';button.textContent=text;button.setAttribute('aria-label',label);
    button.addEventListener('click',handler);controls.append(button);return button;
  };
  let scene,renderer,camera,object,resizeObserver;
  let visible=true,ready=false,disposed=false,focused=false,interacting=false;
  let theta=-0.95,phi=1.08,distance=3.8,fitDistance=3.8,radius=1;
  let fitPoints=new Float32Array();
  const target=new THREE.Vector3();
  const pointers=new Map();
  let lastPinch=0;
  const angleStep=Math.PI/12;
  const touchButton=makeButton('Explore','Enable touch rotation for '+name,()=>setInteracting(!interacting));
  touchButton.className='prototype-viewer-explore';
  touchButton.setAttribute('aria-pressed','false');
  const leftButton=makeButton('←','Rotate '+name+' left',()=>orbit(-angleStep,0));
  const rightButton=makeButton('→','Rotate '+name+' right',()=>orbit(angleStep,0));
  const plusButton=makeButton('+','Zoom into '+name,()=>zoom(0.82));
  const minusButton=makeButton('−','Zoom out from '+name,()=>zoom(1.22));
  const resetButton=makeButton('Reset','Reset '+name+' view',reset);
  resetButton.className='prototype-viewer-reset';
  host.append(stage,controls,hint);stage.append(status);
  [leftButton,rightButton,plusButton,minusButton,resetButton].forEach(button=>button.disabled=true);
  touchButton.disabled=true;
  function render(){
    if (!ready || disposed || !visible) return;
    host.dataset.viewTheta=theta.toFixed(6);host.dataset.viewPhi=phi.toFixed(6);host.dataset.viewDistance=distance.toFixed(6);
    camera.position.set(target.x+distance*Math.sin(phi)*Math.sin(theta),target.y+distance*Math.cos(phi),target.z+distance*Math.sin(phi)*Math.cos(theta));
    camera.lookAt(target);renderer.render(scene,camera);
  }
  function zoom(factor){distance=THREE.MathUtils.clamp(distance*factor,radius*1.25,fitDistance*3.8);render();}
  function orbit(horizontal,vertical){theta+=horizontal;phi=THREE.MathUtils.clamp(phi+vertical,0.1,Math.PI-0.1);render();}
  function fitForView(){
    const tanV=Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),tanH=tanV*camera.aspect;
    const sinT=Math.sin(theta),cosT=Math.cos(theta),sinP=Math.sin(phi),cosP=Math.cos(phi);
    let required=radius*0.3;
    // Solve perspective framing against actual normalized CAD vertices rather than
    // a bounding sphere, which wastes most of a narrow card for long robot arms.
    for(let i=0;i<fitPoints.length;i+=3){
      const x=fitPoints[i],y=fitPoints[i+1],z=fitPoints[i+2];
      const across=x*cosT-z*sinT;
      const up=-x*cosP*sinT+y*sinP-z*cosP*cosT;
      const toward=x*sinP*sinT+y*cosP+z*sinP*cosT;
      required=Math.max(required,toward+Math.max(Math.abs(across)/tanH,Math.abs(up)/tanV)/0.86);
    }
    return required+radius*0.025;
  }
  function reset(){theta=-0.95;phi=1.08;fitDistance=fitForView();distance=fitDistance;render();}
  function setInteracting(value){
    interacting=value;host.classList.toggle('is-exploring',value);
    touchButton.textContent=value?'Done':'Explore';touchButton.setAttribute('aria-pressed',String(value));
    touchButton.setAttribute('aria-label',(value?'Finish touch rotation for ':'Enable touch rotation for ')+name);
    hint.textContent=value?'Drag to rotate · pinch or + / − to zoom · Done to scroll':touchUI?'Tap Explore to rotate · swipe the page to scroll':'Drag to rotate · use + / − to zoom';
    pointers.clear();lastPinch=0;
    if (renderer) renderer.domElement.style.touchAction=value?'none':'pan-y';
  }
  function resize(){
    if (!renderer) return;
    const width=stage.clientWidth,height=stage.clientHeight;
    if (!width || !height) return;
    camera.aspect=width/height;camera.updateProjectionMatrix();
    renderer.setSize(width,height,false);
    const oldFit=fitDistance;
    fitDistance=fitForView();
    distance=oldFit?distance/oldFit*fitDistance:fitDistance;
    render();
  }
  async function initialize(){
    try {
      const {model,buffer}=await getModel(host.dataset.prototypeModel);
      if (disposed) return;
      renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.75));
      renderer.outputColorSpace=THREE.SRGBColorSpace;
      renderer.toneMapping=THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure=0.92;
      scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(34,1,0.01,100);
      object=new THREE.Group();
      for(const row of model.meshes){
        const read=view=>{
          if (!Number.isInteger(view.byteOffset)||!Number.isInteger(view.count)||view.byteOffset<0||view.count<0||view.byteOffset+view.count*4>buffer.byteLength) throw new Error('Invalid geometry');
          return view.type==='uint32'?new Uint32Array(buffer,view.byteOffset,view.count):new Float32Array(buffer,view.byteOffset,view.count);
        };
        const geometry=new THREE.BufferGeometry();
        geometry.setAttribute('position',new THREE.BufferAttribute(read(row.positions),3));
        geometry.setIndex(new THREE.BufferAttribute(read(row.indices),1));
        if(row.normals)geometry.setAttribute('normal',new THREE.BufferAttribute(read(row.normals),3));
        else geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const material=new THREE.MeshStandardMaterial({color:row.color||'#aeb4bb',metalness:0.32,roughness:0.62,side:THREE.DoubleSide});
        material.color.multiplyScalar(0.8);
        object.add(new THREE.Mesh(geometry,material));
      }
      const sourceUp=new THREE.Vector3(...(model.up==='Z'?[0,0,1]:model.up==='X'?[1,0,0]:[0,1,0])).multiplyScalar(model.upSign||1);
      object.quaternion.setFromUnitVectors(sourceUp,new THREE.Vector3(0,1,0));
      object.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(object);
      const center=bounds.getCenter(new THREE.Vector3());
      const size=bounds.getSize(new THREE.Vector3());
      const scale=2/Math.max(size.x,size.y,size.z);
      object.scale.setScalar(scale);object.position.copy(center).multiplyScalar(-scale);object.updateMatrixWorld(true);
      radius=new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere()).radius;
      const pointCount=object.children.reduce((count,item)=>count+item.geometry.attributes.position.count,0);
      fitPoints=new Float32Array(pointCount*3);
      const vertex=new THREE.Vector3();let pointOffset=0;
      for(const item of object.children){
        const position=item.geometry.attributes.position;
        for(let i=0;i<position.count;i++){
          vertex.fromBufferAttribute(position,i).applyMatrix4(item.matrixWorld);
          fitPoints[pointOffset++]=vertex.x;fitPoints[pointOffset++]=vertex.y;fitPoints[pointOffset++]=vertex.z;
        }
      }
      scene.add(object);
      scene.add(new THREE.HemisphereLight(0xe7efff,0x252b35,0.95));
      const key=new THREE.DirectionalLight(0xffffff,1.65);key.position.set(-3,5,4);scene.add(key);
      const rim=new THREE.DirectionalLight(0xb7dcff,1.1);rim.position.set(4,2,-3);scene.add(rim);
      const fill=new THREE.DirectionalLight(0xffffff,0.25);fill.position.set(-3,-1,-2);scene.add(fill);
      const canvas=renderer.domElement;
      canvas.tabIndex=0;canvas.setAttribute('role','img');
      canvas.setAttribute('aria-label',name+' 3D model. Arrow keys rotate; plus and minus zoom; Home resets; Escape exits touch rotation.');
      canvas.setAttribute('aria-describedby',hint.id);canvas.style.touchAction='pan-y';
      canvas.addEventListener('focus',()=>focused=true);
      canvas.addEventListener('blur',()=>{focused=false;pointers.clear();});
      canvas.addEventListener('pointerdown',event=>{
        if(event.pointerType==='touch'&&!interacting)return;
        if(event.button!==0)return;
        event.preventDefault();canvas.focus({preventScroll:true});
        pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});canvas.setPointerCapture(event.pointerId);
        if(pointers.size===2){const [a,b]=[...pointers.values()];lastPinch=Math.hypot(a.x-b.x,a.y-b.y);}
        canvas.classList.add('is-dragging');
      });
      canvas.addEventListener('pointermove',event=>{
        const previous=pointers.get(event.pointerId);if(!previous)return;
        const next={x:event.clientX,y:event.clientY};pointers.set(event.pointerId,next);
        if(pointers.size===2){
          const [a,b]=[...pointers.values()],pinch=Math.hypot(a.x-b.x,a.y-b.y);
          if(lastPinch>0&&pinch>0)zoom(lastPinch/pinch);lastPinch=pinch;
        }else orbit(-(next.x-previous.x)*0.009,-(next.y-previous.y)*0.009);
      });
      const release=event=>{pointers.delete(event.pointerId);lastPinch=0;if(!pointers.size)canvas.classList.remove('is-dragging');};
      ['pointerup','pointercancel','lostpointercapture'].forEach(type=>canvas.addEventListener(type,release));
      // Wheel stays ordinary page scrolling unless the user explicitly enters Explore mode.
      canvas.addEventListener('wheel',event=>{if(interacting&&focused){event.preventDefault();zoom(Math.exp(event.deltaY*0.0012));}},{passive:false});
      canvas.addEventListener('keydown',event=>{
        const actions={ArrowLeft:()=>orbit(-angleStep,0),ArrowRight:()=>orbit(angleStep,0),ArrowUp:()=>orbit(0,-angleStep),ArrowDown:()=>orbit(0,angleStep),'+':()=>zoom(0.82),'=':()=>zoom(0.82),'-':()=>zoom(1.22),Home:reset,Escape:()=>setInteracting(false)};
        if(actions[event.key]){event.preventDefault();actions[event.key]();}
      });
      canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();status.textContent='3D view paused. Reload the page to restore it.';status.hidden=false;ready=false;});
      stage.append(canvas);status.hidden=true;ready=true;
      [touchButton,leftButton,rightButton,plusButton,minusButton,resetButton].forEach(button=>button.disabled=false);
      resizeObserver=new ResizeObserver(resize);resizeObserver.observe(stage);resize();reset();
      host.dataset.modelLoaded='true';
      host.dispatchEvent(new CustomEvent('prototype3dready',{detail:{name,meshCount:model.meshes.length}}));
    }catch(error){status.hidden=false;status.textContent='The 3D model could not load. Please refresh to try again.';host.dataset.modelError=error.message;}
  }
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){visible=entry.isIntersecting;if(visible){if(!host.dataset.loadStarted){host.dataset.loadStarted='true';initialize();}else render();}}
  },{rootMargin:'160px'});observer.observe(host);
  return {dispose(){disposed=true;observer.disconnect();resizeObserver?.disconnect();object?.traverse(item=>{item.geometry?.dispose();item.material?.dispose();});renderer?.dispose();host.replaceChildren();delete host.dataset.viewerReady;}};
}

export function initPrototypeViewers(root=document){return [...root.querySelectorAll('[data-prototype-model]')].map(createPrototypeViewer);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>initPrototypeViewers(),{once:true});
else initPrototypeViewers();
