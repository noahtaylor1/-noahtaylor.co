// app.js — UI + three.js viewer around lattice-core.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import {
  LATTICES, buildAccel, generateLattice, buildSmoothMesh, exportBinarySTL,
} from './lattice-core.js';

const SPACING = 10; // mm — fixed cubic cell size

// ---------------------------------------------------------------------------
// three.js scene
// ---------------------------------------------------------------------------
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1c1e22);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
camera.position.set(120, -160, 100);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true });
viewport.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x33383f, 1.0));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
dirLight.position.set(1, -1.5, 2);
scene.add(dirLight);
const grid = new THREE.GridHelper(300, 30, 0x3a3f48, 0x2a2e35);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
let refitTimer = null;
function scheduleRefit() {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => fitView(false), 120);
}
window.addEventListener('resize', () => { resize(); scheduleRefit(); });
window.addEventListener('orientationchange', scheduleRefit);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  soup: null,        // Float64Array triangle soup (mm), after scaling
  baseSoup: null,    // unscaled soup as loaded/built
  fileName: null,
  accel: null,
  lattice: null,     // result of generateLattice
  solid: null,       // Float32Array triangle soup of the strut solid
  inputMesh: null,   // THREE.Mesh
  latticeLines: null,
  solidMesh: null,
};

const $ = (id) => document.getElementById(id);
const ui = {
  drop: $('drop'), file: $('file'), lattice: $('lattice'), edges: $('edges'),
  radius: $('radius'), blend: $('blend'), detail: $('detail'), showInput: $('showInput'),
  generate: $('generate'), solid: $('solid'), export: $('export'),
  status: $('status'), barFill: $('barFill'),
  prim: $('prim'), dimsLabel: $('dimsLabel'),
  dimA: $('dimA'), dimB: $('dimB'), dimC: $('dimC'),
  loadPrim: $('loadPrim'), scale: $('scale'),
};

// ---------------------------------------------------------------------------
// mobile: the panel is a bottom sheet, and the device has far less memory
// ---------------------------------------------------------------------------
const isTouchLayout = () =>
  window.matchMedia('(max-width: 700px), (pointer: coarse) and (max-width: 1024px)').matches;

// The sheet is dragged up from the bottom by its handle or title bar, and
// snaps to peek / half / full. Tapping the bar (no drag) toggles it.
const sheet = (() => {
  const panel = $('panel'), pull = $('sheetPull'), head = $('panelHead');
  const barHeight = () => pull.offsetHeight + head.offsetHeight;

  function snaps() {
    const H = window.innerHeight;
    const peek = barHeight();
    // never open taller than the content actually needs
    const needed = peek + $('panelBody').scrollHeight + 8;
    return {
      peek,
      half: Math.min(Math.round(H * 0.46), needed),
      full: Math.min(Math.round(H * 0.86), needed),
    };
  }

  let settleTimer = null;
  function setHeight(px, animate) {
    document.documentElement.style.setProperty('--sheet-h', Math.round(px) + 'px');
    document.body.classList.toggle('sheet-closed', px <= barHeight() + 4);
    if (animate) {
      // refit once the height animation has actually landed; the timer is a
      // fallback for when no transition runs (reduced motion, hidden tab)
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => fitView(false), 320);
    }
  }

  function snapTo(px) {
    const s = snaps();
    const options = [s.peek, s.half, s.full];
    let best = options[0];
    for (const o of options) if (Math.abs(o - px) < Math.abs(best - px)) best = o;
    setHeight(best, true);
    return best;
  }

  // drag state
  let dragging = false, startY = 0, startH = 0, moved = 0, startTime = 0;

  function onDown(e) {
    if (!isTouchLayout()) return;
    dragging = true; moved = 0; startTime = Date.now();
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    document.body.classList.add('sheet-dragging');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or stale pointer */ }
  }

  function onMove(e) {
    if (!dragging) return;
    const dy = startY - e.clientY;            // up is positive
    moved = Math.max(moved, Math.abs(dy));
    const s = snaps();
    const h = Math.min(Math.max(startH + dy, s.peek), Math.max(s.full, s.peek));
    setHeight(h, false);
    e.preventDefault();
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('sheet-dragging');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    const s = snaps();
    const isTap = moved < 6 && Date.now() - startTime < 400;
    if (isTap) {
      const atPeek = panel.getBoundingClientRect().height <= s.peek + 4;
      setHeight(atPeek ? s.half : s.peek, true);
    } else {
      snapTo(panel.getBoundingClientRect().height);
    }
  }

  panel.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'height') { clearTimeout(settleTimer); fitView(false); }
  });

  for (const el of [pull, head]) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  return {
    open: () => setHeight(snaps().half, true),
    close: () => setHeight(snaps().peek, true),
    reset: () => { if (isTouchLayout()) setHeight(snaps().half, false); },
  };
})();

// start at half height so the model and the controls are both visible
sheet.reset();
window.addEventListener('orientationchange', () => setTimeout(sheet.reset, 250));

// a phone can't hold a 20M-sample field plus the mesh; keep it modest
const sampleBudget = () => (isTouchLayout() ? 5e6 : 20e6);

// finest practical voxel differs hugely between a laptop and a phone
if (isTouchLayout()) $('detail').value = '0.4';

for (const key of Object.keys(LATTICES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = LATTICES[key].label;
  ui.lattice.appendChild(opt);
}

function status(msg) { ui.status.textContent = msg; }
function progress(f) { ui.barFill.style.width = (f * 100).toFixed(1) + '%'; }
// Yield to the event loop so the UI can paint. rAF never fires in hidden tabs
// and setTimeout is throttled there, so fall back to an unthrottled
// MessageChannel yield when the page isn't visible.
const frame = () => new Promise((resolve) => {
  if (document.hidden) {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  } else {
    requestAnimationFrame(() => resolve());
  }
});

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
ui.drop.addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', () => {
  if (ui.file.files.length) loadFile(ui.file.files[0]);
});
window.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('hover'); });
window.addEventListener('dragleave', () => ui.drop.classList.remove('hover'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.drop.classList.remove('hover');
  if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
});

async function loadFile(file) {
  status('Reading ' + file.name + ' …');
  await frame();
  try {
    const buffer = await file.arrayBuffer();
    await loadFromArrayBuffer(file.name, buffer);
  } catch (err) {
    console.error(err);
    status('Failed to load: ' + err.message);
  }
}

async function loadFromArrayBuffer(name, buffer) {
  const ext = name.split('.').pop().toLowerCase();
  let soup;
  if (ext === 'stl') soup = soupFromGeometry(new STLLoader().parse(buffer));
  else if (ext === 'obj') soup = soupFromObj(buffer);
  else if (ext === '3dm') soup = await soupFrom3dm(buffer);
  else throw new Error('Unsupported file type: .' + ext);

  if (!soup || soup.length === 0) throw new Error('No triangles found in file.');
  ui.scale.value = 100;
  setModel(name, soup);
}

// shared entry for uploads and primitives; applies the current Scale %
function setModel(name, baseSoup) {
  state.baseSoup = baseSoup;
  const pct = (parseFloat(ui.scale.value) || 100) / 100;
  let soup = baseSoup;
  if (pct !== 1) {
    soup = new Float64Array(baseSoup.length);
    for (let i = 0; i < baseSoup.length; i++) soup[i] = baseSoup[i] * pct;
  }
  state.soup = soup;
  state.fileName = name.replace(/\.[^.]+$/, '');
  state.accel = null;
  state.lattice = null;
  state.solid = null;
  clearObject('latticeLines');
  clearObject('solidMesh');
  showInputMesh();
  ui.generate.disabled = false;
  ui.solid.disabled = true;
  ui.export.disabled = true;

  const b = bboxOfSoup(soup);
  status(`${name}${pct !== 1 ? ' @ ' + (pct * 100) + '%' : ''}\n` +
    `${(soup.length / 9).toLocaleString()} triangles, ` +
    `${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} × ${(b.maxZ - b.minZ).toFixed(1)} mm`);
  fitView(true);
}

// ---------------------------------------------------------------------------
// primitives (triangle soups in mm, sitting on z=0, centred in x/y)
// ---------------------------------------------------------------------------
function boxPrimitive(w, d, h) {
  const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2, z0 = 0, z1 = h;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
  const out = [];
  for (const [a, b, c, d2] of quads) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d2]);
  return new Float64Array(out);
}

function cylinderPrimitive(dia, h, segs = 96) {
  const r = dia / 2, out = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const x0 = r * Math.cos(a0), y0 = r * Math.sin(a0);
    const x1 = r * Math.cos(a1), y1 = r * Math.sin(a1);
    out.push(x0, y0, 0, x1, y1, 0, x1, y1, h,  x0, y0, 0, x1, y1, h, x0, y0, h); // wall
    out.push(0, 0, 0, x1, y1, 0, x0, y0, 0);   // bottom cap
    out.push(0, 0, h, x0, y0, h, x1, y1, h);   // top cap
  }
  return new Float64Array(out);
}

function spherePrimitive(dia, rings = 48, segs = 96) {
  const r = dia / 2, cz = r, out = [];
  const pt = (ri, si) => {
    const phi = (ri / rings) * Math.PI, th = (si / segs) * Math.PI * 2;
    return [r * Math.sin(phi) * Math.cos(th), r * Math.sin(phi) * Math.sin(th), cz + r * Math.cos(phi)];
  };
  for (let ri = 0; ri < rings; ri++) {
    for (let si = 0; si < segs; si++) {
      const a = pt(ri, si), b = pt(ri + 1, si), c = pt(ri + 1, si + 1), d = pt(ri, si + 1);
      if (ri > 0) out.push(...a, ...b, ...c);
      if (ri < rings - 1) out.push(...a, ...c, ...d);
    }
  }
  return new Float64Array(out);
}

const PRIM_DIMS = {
  cube: { label: 'W × D × H (mm)', inputs: 3 },
  cylinder: { label: 'Ø × H (mm)', inputs: 2 },
  sphere: { label: 'Ø (mm)', inputs: 1 },
};

function updateDimInputs() {
  const cfg = PRIM_DIMS[ui.prim.value];
  ui.dimsLabel.textContent = cfg.label;
  ui.dimB.style.display = cfg.inputs >= 2 ? '' : 'none';
  ui.dimC.style.display = cfg.inputs >= 3 ? '' : 'none';
}
ui.prim.addEventListener('change', updateDimInputs);
updateDimInputs();

ui.loadPrim.addEventListener('click', () => {
  const a = parseFloat(ui.dimA.value) || 100;
  const b = parseFloat(ui.dimB.value) || 100;
  const c = parseFloat(ui.dimC.value) || 100;
  const type = ui.prim.value;
  let soup, name;
  if (type === 'cube') { soup = boxPrimitive(a, b, c); name = `cube ${a}×${b}×${c}`; }
  else if (type === 'cylinder') { soup = cylinderPrimitive(a, b); name = `cylinder Ø${a}×${b}`; }
  else { soup = spherePrimitive(a); name = `sphere Ø${a}`; }
  setModel(name, soup);
});

ui.scale.addEventListener('change', () => {
  if (state.baseSoup) setModel(state.fileName || 'model', state.baseSoup);
});

function soupFromGeometry(geometry, scale = 1) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const out = new Float64Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i) * scale;
    out[i * 3 + 1] = pos.getY(i) * scale;
    out[i * 3 + 2] = pos.getZ(i) * scale;
  }
  return out;
}

function soupFromObj(buffer) {
  const text = new TextDecoder().decode(buffer);
  const group = new OBJLoader().parse(text);
  const parts = [];
  group.traverse((child) => {
    if (child.isMesh) parts.push(soupFromGeometry(child.geometry));
  });
  return concatSoups(parts);
}

let rhinoPromise = null;
async function soupFrom3dm(buffer) {
  if (!rhinoPromise) {
    // wasm embedded as base64 (vendor/rhino3dm_wasm_b64.js) — no external fetch
    const b = atob(RHINO3DM_WASM_B64);
    const bin = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) bin[i] = b.charCodeAt(i);
    rhinoPromise = rhino3dm({ wasmBinary: bin.buffer });
  }
  const rhino = await rhinoPromise;
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
  if (!doc) throw new Error('Could not parse .3dm file.');

  const scale = rhinoUnitScale(rhino, doc.settings().modelUnitSystem);
  const parts = [];
  let facesWithoutMesh = 0;
  const objects = doc.objects();
  for (let i = 0; i < objects.count; i++) {
    const geom = objects.get(i).geometry();
    if (!geom) continue;
    const meshes = [];
    if (geom.objectType === rhino.ObjectType.Mesh) {
      meshes.push(geom);
    } else if (geom.objectType === rhino.ObjectType.Brep) {
      const faces = geom.faces();
      for (let f = 0; f < faces.count; f++) {
        const m = faces.get(f).getMesh(rhino.MeshType.Any);
        if (m) meshes.push(m); else facesWithoutMesh++;
      }
    } else if (geom.objectType === rhino.ObjectType.Extrusion) {
      const m = geom.getMesh(rhino.MeshType.Any);
      if (m) meshes.push(m); else facesWithoutMesh++;
    }
    for (const m of meshes) {
      const json = m.toThreejsJSON();
      const g = new THREE.BufferGeometryLoader().parse(json);
      parts.push(soupFromGeometry(g, scale));
    }
  }
  if (parts.length === 0) {
    throw new Error(facesWithoutMesh
      ? 'This .3dm has NURBS with no saved render meshes. In Rhino: switch a viewport to Shaded, then save again (uncheck "save geometry only").'
      : 'No meshable geometry found in the .3dm.');
  }
  if (facesWithoutMesh) {
    console.warn(facesWithoutMesh + ' faces had no render mesh and were skipped.');
  }
  return concatSoups(parts);
}

function rhinoUnitScale(rhino, us) {
  const U = rhino.UnitSystem;
  if (us === U.Millimeters) return 1;
  if (us === U.Centimeters) return 10;
  if (us === U.Decimeters) return 100;
  if (us === U.Meters) return 1000;
  if (us === U.Microns) return 0.001;
  if (us === U.Inches) return 25.4;
  if (us === U.Feet) return 304.8;
  return 1;
}

function concatSoups(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bboxOfSoup(soup) {
  const b = { minX: 1e18, minY: 1e18, minZ: 1e18, maxX: -1e18, maxY: -1e18, maxZ: -1e18 };
  for (let i = 0; i < soup.length; i += 3) {
    b.minX = Math.min(b.minX, soup[i]); b.maxX = Math.max(b.maxX, soup[i]);
    b.minY = Math.min(b.minY, soup[i + 1]); b.maxY = Math.max(b.maxY, soup[i + 1]);
    b.minZ = Math.min(b.minZ, soup[i + 2]); b.maxZ = Math.max(b.maxZ, soup[i + 2]);
  }
  return b;
}

// ---------------------------------------------------------------------------
// scene helpers
// ---------------------------------------------------------------------------
function clearObject(key) {
  const obj = state[key];
  if (!obj) return;
  scene.remove(obj);
  obj.geometry.dispose();
  obj.material.dispose();
  state[key] = null;
}

function geometryFromSoup(soup) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
  g.computeVertexNormals();
  return g;
}

function showInputMesh() {
  clearObject('inputMesh');
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8891a0, transparent: true, opacity: 0.28,
    side: THREE.DoubleSide, depthWrite: false,
  });
  state.inputMesh = new THREE.Mesh(geometryFromSoup(state.soup), mat);
  state.inputMesh.visible = ui.showInput.checked;
  scene.add(state.inputMesh);
}

ui.showInput.addEventListener('change', () => {
  if (state.inputMesh) state.inputMesh.visible = ui.showInput.checked;
  fitView(false);
});

// ---------------------------------------------------------------------------
// Framing: keep whatever is on screen fully visible, inside the area the
// control panel doesn't cover. Called whenever the content or the layout
// changes — not while the user is orbiting, so it never fights their input.
// ---------------------------------------------------------------------------
const FIT_MARGIN = 1.12;
const DEFAULT_DIR = new THREE.Vector3(0.7, -1, 0.6).normalize();

// bounds of every object currently drawn
function visibleBounds() {
  const box = new THREE.Box3();
  let any = false;
  for (const key of ['solidMesh', 'latticeLines', 'inputMesh']) {
    const obj = state[key];
    if (obj && obj.visible) { box.expandByObject(obj); any = true; }
  }
  return any && !box.isEmpty() ? box : null;
}

// Pixels of the viewport the lattice must stay clear of. The floating side
// panel only overlaps a corner, so the lattice is framed to the whole view
// there; an open full-width bottom sheet genuinely hides its half of the
// screen, so that one counts.
function viewInsets() {
  const r = $('panel').getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const ins = { l: 0, r: 0, t: 0, b: 0 };
  if (r.width >= W * 0.9) ins.b = Math.max(0, H - r.top) + 8;
  return ins;
}

function fitView(resetDirection) {
  const box = visibleBounds();
  if (!box) return;
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);

  const W = window.innerWidth, H = window.innerHeight;
  const ins = viewInsets();
  // never let the panel squeeze the framing area to nothing
  const Wv = Math.max(W - ins.l - ins.r, W * 0.3);
  const Hv = Math.max(H - ins.t - ins.b, H * 0.3);

  // half-angles of the *visible* sub-rect of the frustum
  const fovY = THREE.MathUtils.degToRad(camera.fov);
  const tanY = Math.tan(fovY / 2);
  const halfV = Math.atan(tanY * (Hv / H));
  const halfH = Math.atan(tanY * camera.aspect * (Wv / W));
  const dist = FIT_MARGIN * Math.max(radius / Math.sin(halfV), radius / Math.sin(halfH));

  // keep the user's current orbit unless we're framing a brand-new model
  const dir = resetDirection
    ? DEFAULT_DIR.clone()
    : camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-9) dir.copy(DEFAULT_DIR);

  // offset the target so the model centres in the visible rect, not the canvas
  const forward = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const perPx = (2 * dist * tanY) / H;
  const dxPx = (ins.l + Wv / 2) - W / 2;
  const dyPx = (ins.t + Hv / 2) - H / 2;
  const offset = right.clone().multiplyScalar(dxPx * perPx)
    .add(up.clone().multiplyScalar(-dyPx * perPx));

  controls.target.copy(centre).sub(offset);
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist + radius * 8;
  camera.updateProjectionMatrix();

  // The bounding sphere is a loose fit — a box's silhouette is much smaller
  // than the sphere around it, which would leave a third of the frame empty.
  // Refine against the actually projected corners: measure, rescale distance,
  // recentre. Converges in a couple of passes.
  const corners = [];
  for (let i = 0; i < 8; i++) {
    corners.push(new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z));
  }
  const targetW = Wv / FIT_MARGIN, targetH = Hv / FIT_MARGIN;
  const wantCx = ins.l + Wv / 2, wantCy = ins.t + Hv / 2;
  const v = new THREE.Vector3();

  for (let pass = 0; pass < 4; pass++) {
    camera.updateMatrixWorld();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of corners) {
      v.copy(c).project(camera);
      const px = (v.x * 0.5 + 0.5) * W, py = (-v.y * 0.5 + 0.5) * H;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const gotW = maxX - minX, gotH = maxY - minY;
    if (!(gotW > 0 && gotH > 0)) break;

    const scale = Math.max(gotW / targetW, gotH / targetH);
    const newDist = THREE.MathUtils.clamp(
      camera.position.distanceTo(controls.target) * scale, radius * 0.05, radius * 500);

    // recentre using the measured rect, then apply the new distance
    const perPx2 = (2 * newDist * tanY) / H;
    const recentre = right.clone().multiplyScalar((((minX + maxX) / 2) - wantCx) * perPx2)
      .add(up.clone().multiplyScalar(-(((minY + maxY) / 2) - wantCy) * perPx2));
    controls.target.add(recentre);
    camera.position.copy(controls.target).addScaledVector(dir, newDist);
    camera.near = Math.max(newDist / 1000, 0.01);
    camera.far = newDist + radius * 8;
    camera.updateProjectionMatrix();

    if (Math.abs(scale - 1) < 0.005) break;
  }
  controls.update();
}

// ---------------------------------------------------------------------------
// generate / solid / export
// ---------------------------------------------------------------------------
ui.generate.addEventListener('click', () => generate());
ui.solid.addEventListener('click', () => buildSolid());
ui.export.addEventListener('click', () => downloadSTL());

// Drop struts that don't end at real joints. Every endpoint must be shared
// by at least MIN_JOINT struts — degree-1 ends are free-hanging, and
// degree-2 ends are corner V-spikes that the smooth blend fuses into a
// single protruding stub. Repeats until stable so removals cascade.
// Post-filter only; the generator's output is untouched.
const MIN_JOINT = 3;
function removeDanglingStruts(segments) {
  const q = (v) => Math.round(v * 1024);
  const keyA = (g) => q(g.ax) + ',' + q(g.ay) + ',' + q(g.az);
  const keyB = (g) => q(g.bx) + ',' + q(g.by) + ',' + q(g.bz);
  let segs = segments;
  for (;;) {
    const deg = new Map();
    for (const g of segs) {
      deg.set(keyA(g), (deg.get(keyA(g)) || 0) + 1);
      deg.set(keyB(g), (deg.get(keyB(g)) || 0) + 1);
    }
    const keep = segs.filter((g) => deg.get(keyA(g)) >= MIN_JOINT && deg.get(keyB(g)) >= MIN_JOINT);
    if (keep.length === segs.length) return segs;
    segs = keep;
  }
}

async function generate() {
  if (!state.soup) return;
  ui.generate.disabled = true;
  try {
    if (!state.accel) {
      status('Building spatial index …');
      await frame();
      state.accel = buildAccel(state.soup, SPACING);
    }
    status('Generating ' + ui.lattice.value + ' lattice …');
    await frame();
    const t0 = performance.now();
    state.lattice = await generateLattice(state.accel, {
      spacing: SPACING,
      lattice: ui.lattice.value,
      cellEdges: ui.edges.checked,
      onProgress: async (n, total) => { progress(n / total); await frame(); },
    });
    progress(0);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);

    const before = state.lattice.segments.length;
    state.lattice.segments = removeDanglingStruts(state.lattice.segments);
    state.lattice.stats.kept = state.lattice.segments.length;
    state.lattice.stats.dangling = before - state.lattice.segments.length;

    clearObject('latticeLines');
    clearObject('solidMesh');
    state.solid = null;
    const pos = new Float32Array(state.lattice.segments.length * 6);
    let o = 0;
    for (const g of state.lattice.segments) {
      pos[o++] = g.ax; pos[o++] = g.ay; pos[o++] = g.az;
      pos[o++] = g.bx; pos[o++] = g.by; pos[o++] = g.bz;
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    state.latticeLines = new THREE.LineSegments(
      lg, new THREE.LineBasicMaterial({ color: 0x4fc37f }));
    scene.add(state.latticeLines);
    if (state.inputMesh) state.inputMesh.material.opacity = 0.12;
    fitView(false);

    const s = state.lattice.stats;
    status(`Lattice ready in ${dt}s — ${s.kept.toLocaleString()} struts, ` +
      `${s.joints.toLocaleString()} joints` +
      (s.dangling ? `, ${s.dangling.toLocaleString()} loose struts removed` : '') +
      ` (${s.cells.toLocaleString()} cells scanned).\nNow build the smooth mesh.`);
    ui.solid.disabled = false;
    ui.export.disabled = true;
  } catch (err) {
    console.error(err);
    status('Generation failed: ' + err.message);
  } finally {
    ui.generate.disabled = false;
  }
}

async function buildSolid() {
  if (!state.lattice) return;
  ui.solid.disabled = true;
  try {
    status('Building smooth strut mesh …');
    await frame(); await frame();
    const t0 = performance.now();
    state.solid = await buildSmoothMesh(state.lattice, {
      radius: parseFloat(ui.radius.value) || 0.8,
      blend: parseFloat(ui.blend.value) || 2,
      voxel: parseFloat(ui.detail.value) || 0.1,
      accel: state.accel,
      maxSamples: sampleBudget(),
      onProgress: async (n, total, phase) => {
        status((phase === 'stamping' ? 'Evaluating strut field … '
          : phase === 'trimming' ? 'Trimming to surface … ' : 'Extracting surface … ') +
          Math.round((n / total) * 100) + '%');
        progress(n / total);
        await frame();
      },
    });
    progress(0);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);

    clearObject('solidMesh');
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(state.solid.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(state.solid.normals, 3));
    g.setIndex(new THREE.BufferAttribute(state.solid.indices, 1));
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.05, roughness: 0.6,
    });
    state.solidMesh = new THREE.Mesh(g, mat);
    scene.add(state.solidMesh);
    if (state.latticeLines) state.latticeLines.visible = false;

    const s = state.solid.stats;
    status(`Smooth mesh ready in ${dt}s — ${s.tris.toLocaleString()} triangles at ` +
      `${s.voxel.toFixed(2)}mm detail (~${(s.tris * 50 / 1e6).toFixed(0)} MB STL).`);
    ui.export.disabled = false;
    // on a phone the sheet covers the model — drop it to reveal the result
    if (isTouchLayout()) sheet.close();
    else fitView(false);
  } catch (err) {
    console.error(err);
    status('Smooth mesh build failed: ' + err.message);
  } finally {
    ui.solid.disabled = false;
  }
}

function downloadSTL() {
  if (!state.solid) return;
  const name = (state.fileName || 'lattice') + '_' + ui.lattice.value + '_10mm.stl';
  const buf = exportBinarySTL(state.solid, name);
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  status('Exported ' + name);
}

// exposed for testing / scripting
window.latticeApp = {
  state, loadFromArrayBuffer, generate, buildSolid, fitView,
  exportSTLBytes: () => exportBinarySTL(state.solid, 'x'),
  // test hook: where the visible content lands on screen, in pixels
  probeFraming: () => {
    const box = visibleBounds();
    if (!box) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z).project(camera);
      const px = (v.x * 0.5 + 0.5) * window.innerWidth;
      const py = (-v.y * 0.5 + 0.5) * window.innerHeight;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    return { minX, minY, maxX, maxY, insets: viewInsets(),
             W: window.innerWidth, H: window.innerHeight };
  },
};
