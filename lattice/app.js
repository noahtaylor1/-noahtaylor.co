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
  renderer.setPixelRatio(window.devicePixelRatio);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  soup: null,        // Float64Array triangle soup (mm)
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
};

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
  status(`${name}\n${(soup.length / 9).toLocaleString()} triangles, ` +
    `${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} × ${(b.maxZ - b.minZ).toFixed(1)} mm`);
  fitCamera(b);
}

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
    // wasm is embedded as base64 (vendor/rhino3dm_wasm_b64.js) so the page
    // needs no external fetch — same pattern as the slicer
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
});

function fitCamera(b) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, cz = (b.minZ + b.maxZ) / 2;
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
  controls.target.set(cx, cy, cz);
  const d = size * 1.6 + 20;
  camera.position.set(cx + d * 0.7, cy - d, cz + d * 0.6);
  camera.far = d * 20;
  camera.updateProjectionMatrix();
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
      radius: parseFloat(ui.radius.value) || 1.2,
      blend: parseFloat(ui.blend.value) || 0.7,
      voxel: parseFloat(ui.detail.value) || 0.4,
      accel: state.accel,
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
      color: 0x5aa7e8, metalness: 0.1, roughness: 0.5,
    });
    state.solidMesh = new THREE.Mesh(g, mat);
    scene.add(state.solidMesh);
    if (state.latticeLines) state.latticeLines.visible = false;

    const s = state.solid.stats;
    status(`Smooth mesh ready in ${dt}s — ${s.tris.toLocaleString()} triangles at ` +
      `${s.voxel.toFixed(2)}mm detail (~${(s.tris * 50 / 1e6).toFixed(0)} MB STL).`);
    ui.export.disabled = false;
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
window.latticeApp = { state, loadFromArrayBuffer, generate, buildSolid, exportSTLBytes: () => exportBinarySTL(state.solid, 'x') };
