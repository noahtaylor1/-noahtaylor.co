// lattice-core.js — geometry engine, no DOM/three.js dependencies.
//
// Everything works on a triangle soup: Float64Array of [ax,ay,az,bx,by,bz,cx,cy,cz]*n
// in millimetres. The pipeline is:
//   buildAccel(soup, cellSize)          -> spatial bins for fast queries
//   generateLattice(accel, opts)        -> clipped strut segments + joint nodes
//   buildSmoothMesh(result, opts)       -> watertight blended mesh (SDF + surface nets)
//   exportBinarySTL(mesh)               -> ArrayBuffer ready to download
//
// ---------------------------------------------------------------------------
// LATTICE LIBRARY
// A lattice type is a list of struts in fractional unit-cell coordinates.
// Each entry is [[fx,fy,fz],[fx,fy,fz]] with components in [0..1]; a value of 1
// refers to the shared boundary with the next cell (duplicates are removed by
// the generator). To add a new type, add an entry here — nothing else needed.
// ---------------------------------------------------------------------------

// All 12 edges of the unit cell, not just the three from its origin corner.
// Relying on neighbouring cells to supply the other nine works everywhere
// except the far boundary, where there is no neighbour — that left the max-X/
// Y/Z faces without their in-plane edges, so the joint filter ate them and
// only some sides came out flat. Duplicates between cells are removed by the
// generator, so the interior is unchanged.
const CUBIC_EDGES = [
  [[0, 0, 0], [1, 0, 0]], [[0, 1, 0], [1, 1, 0]],
  [[0, 0, 1], [1, 0, 1]], [[0, 1, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]],
  [[0, 0, 1], [0, 1, 1]], [[1, 0, 1], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1]], [[1, 0, 0], [1, 0, 1]],
  [[0, 1, 0], [0, 1, 1]], [[1, 1, 0], [1, 1, 1]],
];

function fccEdges() {
  const edges = [];
  // each face: centre connected to its 4 corners (octet truss arrangement)
  for (const axis of [0, 1, 2]) {
    for (const side of [0, 1]) {
      const centre = [0.5, 0.5, 0.5];
      centre[axis] = side;
      for (const u of [0, 1]) {
        for (const v of [0, 1]) {
          const corner = [0, 0, 0];
          corner[axis] = side;
          corner[(axis + 1) % 3] = u;
          corner[(axis + 2) % 3] = v;
          edges.push([centre.slice(), corner]);
        }
      }
    }
  }
  return edges;
}

export const LATTICES = {
  bcc: {
    label: 'BCC (body-centred cubic)',
    edges: [0, 1].flatMap((i) =>
      [0, 1].flatMap((j) =>
        [0, 1].map((k) => [[0.5, 0.5, 0.5], [i, j, k]])
      )
    ),
  },
  fcc: {
    label: 'FCC / octet truss',
    edges: fccEdges(),
  },
  cubic: {
    label: 'Simple cubic (edges only)',
    edges: CUBIC_EDGES.map((e) => [e[0].slice(), e[1].slice()]),
  },
};

// numeric tolerances (millimetres)
const EPS_PARITY = 1e-6;   // strictness of the ray-parity comparison
const TOL_ON = 0.05;       // points closer than this to the surface count as inside
const MIN_SEG = 1e-3;      // discard clipped fragments shorter than this
// small irrational-ish jitter so grid-aligned rays don't skim faces exactly
const JIT_Y = 1.23456789e-4;
const JIT_Z = 0.76543211e-4;

// ---------------------------------------------------------------------------
// Acceleration structure
// ---------------------------------------------------------------------------

export function buildAccel(soup, cellSize) {
  const triCount = soup.length / 9;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cs = cellSize;
  const pad = TOL_ON * 2;
  const oX = minX - pad, oY = minY - pad, oZ = minZ - pad;
  const nX = Math.max(1, Math.ceil((maxX - oX + pad) / cs));
  const nY = Math.max(1, Math.ceil((maxY - oY + pad) / cs));
  const nZ = Math.max(1, Math.ceil((maxZ - oZ + pad) / cs));

  // 2D bins over (y,z) for +X parity rays
  const bins2d = new Map();
  // 3D bins for segment clipping / distance queries
  const bins3d = new Map();

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const txmin = Math.min(soup[o], soup[o + 3], soup[o + 6]);
    const txmax = Math.max(soup[o], soup[o + 3], soup[o + 6]);
    const tymin = Math.min(soup[o + 1], soup[o + 4], soup[o + 7]);
    const tymax = Math.max(soup[o + 1], soup[o + 4], soup[o + 7]);
    const tzmin = Math.min(soup[o + 2], soup[o + 5], soup[o + 8]);
    const tzmax = Math.max(soup[o + 2], soup[o + 5], soup[o + 8]);

    const jy0 = clampi(Math.floor((tymin - oY) / cs), 0, nY - 1);
    const jy1 = clampi(Math.floor((tymax - oY) / cs), 0, nY - 1);
    const jz0 = clampi(Math.floor((tzmin - oZ) / cs), 0, nZ - 1);
    const jz1 = clampi(Math.floor((tzmax - oZ) / cs), 0, nZ - 1);
    for (let jy = jy0; jy <= jy1; jy++) {
      for (let jz = jz0; jz <= jz1; jz++) {
        pushBin(bins2d, jy * nZ + jz, t);
      }
    }
    const jx0 = clampi(Math.floor((txmin - oX) / cs), 0, nX - 1);
    const jx1 = clampi(Math.floor((txmax - oX) / cs), 0, nX - 1);
    for (let jx = jx0; jx <= jx1; jx++) {
      for (let jy = jy0; jy <= jy1; jy++) {
        for (let jz = jz0; jz <= jz1; jz++) {
          pushBin(bins3d, (jx * nY + jy) * nZ + jz, t);
        }
      }
    }
  }

  return {
    soup, triCount, cs,
    bbox: { minX, minY, minZ, maxX, maxY, maxZ },
    oX, oY, oZ, nX, nY, nZ,
    bins2d, bins3d,
  };
}

function pushBin(map, key, t) {
  const arr = map.get(key);
  if (arr) arr.push(t); else map.set(key, [t]);
}

function clampi(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------------------------------------------------------------------------
// Point-in-mesh (ray parity along +X) and distance-to-surface
// ---------------------------------------------------------------------------

function rayCrossings(accel, py, pz) {
  // x-coordinates where the infinite line (y=py, z=pz) crosses the mesh
  const y = py + JIT_Y, z = pz + JIT_Z;
  const jy = Math.floor((y - accel.oY) / accel.cs);
  const jz = Math.floor((z - accel.oZ) / accel.cs);
  if (jy < 0 || jy >= accel.nY || jz < 0 || jz >= accel.nZ) return [];
  const tris = accel.bins2d.get(jy * accel.nZ + jz);
  if (!tris) return [];
  const soup = accel.soup;
  const xs = [];
  for (const t of tris) {
    const o = t * 9;
    const ay = soup[o + 1], az = soup[o + 2];
    const e1y = soup[o + 4] - ay, e1z = soup[o + 5] - az;
    const e2y = soup[o + 7] - ay, e2z = soup[o + 8] - az;
    const det = e1y * e2z - e1z * e2y;
    if (Math.abs(det) < 1e-14) continue; // parallel to the ray
    const qy = y - ay, qz = z - az;
    const s = (qy * e2z - qz * e2y) / det;
    const u = (e1y * qz - e1z * qy) / det;
    if (s < 0 || u < 0 || s + u > 1) continue;
    xs.push(soup[o] + s * (soup[o + 3] - soup[o]) + u * (soup[o + 6] - soup[o]));
  }
  xs.sort((a, b) => a - b);
  return xs;
}

export function pointInside(accel, px, py, pz) {
  const xs = rayCrossings(accel, py, pz);
  let count = 0;
  for (const x of xs) if (x > px + EPS_PARITY) count++;
  return (count & 1) === 1;
}

function distToSurfaceUnder(accel, px, py, pz, tol) {
  // true if the point is within `tol` of any triangle (checks nearby bins only)
  const cs = accel.cs;
  const jx = Math.floor((px - accel.oX) / cs);
  const jy = Math.floor((py - accel.oY) / cs);
  const jz = Math.floor((pz - accel.oZ) / cs);
  const tol2 = tol * tol;
  const seen = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    const ix = jx + dx;
    if (ix < 0 || ix >= accel.nX) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const iy = jy + dy;
      if (iy < 0 || iy >= accel.nY) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const iz = jz + dz;
        if (iz < 0 || iz >= accel.nZ) continue;
        const tris = accel.bins3d.get((ix * accel.nY + iy) * accel.nZ + iz);
        if (!tris) continue;
        for (const t of tris) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (pointTriDist2(accel.soup, t, px, py, pz) <= tol2) return true;
        }
      }
    }
  }
  return false;
}

export function insideOrOn(accel, px, py, pz) {
  if (pointInside(accel, px, py, pz)) return true;
  return distToSurfaceUnder(accel, px, py, pz, TOL_ON);
}

// squared distance from point to triangle t (Ericson, Real-Time Collision Detection)
function pointTriDist2(soup, t, px, py, pz) {
  const o = t * 9;
  const ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
  const bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
  const cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const rx = bx + w * (cx - bx) - px;
    const ry = by + w * (cy - by) - py;
    const rz = bz + w * (cz - bz) - pz;
    return rx * rx + ry * ry + rz * rz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const rx = ax + abx * v + acx * w - px;
  const ry = ay + aby * v + acy * w - py;
  const rz = az + abz * v + acz * w - pz;
  return rx * rx + ry * ry + rz * rz;
}

// Möller–Trumbore, returns t in [0,1] along segment or -1
function segTriHit(soup, t, ax, ay, az, dx, dy, dz) {
  const o = t * 9;
  const v0x = soup[o], v0y = soup[o + 1], v0z = soup[o + 2];
  const e1x = soup[o + 3] - v0x, e1y = soup[o + 4] - v0y, e1z = soup[o + 5] - v0z;
  const e2x = soup[o + 6] - v0x, e2y = soup[o + 7] - v0y, e2z = soup[o + 8] - v0z;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ax - v0x, ty = ay - v0y, tz = az - v0z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (tt < 1e-9 || tt > 1 - 1e-9) return -1;
  return tt;
}

// ---------------------------------------------------------------------------
// Strut clipping
// ---------------------------------------------------------------------------

function gatherSegTris(accel, ax, ay, az, bx, by, bz) {
  const cs = accel.cs;
  const jx0 = clampi(Math.floor((Math.min(ax, bx) - accel.oX) / cs), 0, accel.nX - 1);
  const jx1 = clampi(Math.floor((Math.max(ax, bx) - accel.oX) / cs), 0, accel.nX - 1);
  const jy0 = clampi(Math.floor((Math.min(ay, by) - accel.oY) / cs), 0, accel.nY - 1);
  const jy1 = clampi(Math.floor((Math.max(ay, by) - accel.oY) / cs), 0, accel.nY - 1);
  const jz0 = clampi(Math.floor((Math.min(az, bz) - accel.oZ) / cs), 0, accel.nZ - 1);
  const jz1 = clampi(Math.floor((Math.max(az, bz) - accel.oZ) / cs), 0, accel.nZ - 1);
  const out = new Set();
  for (let jx = jx0; jx <= jx1; jx++) {
    for (let jy = jy0; jy <= jy1; jy++) {
      for (let jz = jz0; jz <= jz1; jz++) {
        const tris = accel.bins3d.get((jx * accel.nY + jy) * accel.nZ + jz);
        if (tris) for (const t of tris) out.add(t);
      }
    }
  }
  return out;
}

// returns list of [t0,t1] intervals of the segment that lie inside the solid
export function clipSegment(accel, ax, ay, az, bx, by, bz) {
  const outsideBox =
    (ax < accel.bbox.minX - TOL_ON && bx < accel.bbox.minX - TOL_ON) ||
    (ax > accel.bbox.maxX + TOL_ON && bx > accel.bbox.maxX + TOL_ON) ||
    (ay < accel.bbox.minY - TOL_ON && by < accel.bbox.minY - TOL_ON) ||
    (ay > accel.bbox.maxY + TOL_ON && by > accel.bbox.maxY + TOL_ON) ||
    (az < accel.bbox.minZ - TOL_ON && bz < accel.bbox.minZ - TOL_ON) ||
    (az > accel.bbox.maxZ + TOL_ON && bz > accel.bbox.maxZ + TOL_ON);
  if (outsideBox) return [];

  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < MIN_SEG) return [];

  const tris = gatherSegTris(accel, ax, ay, az, bx, by, bz);
  const ts = [0, 1];
  for (const t of tris) {
    const hit = segTriHit(accel.soup, t, ax, ay, az, dx, dy, dz);
    if (hit >= 0) ts.push(hit);
  }
  ts.sort((a, b) => a - b);

  const kept = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if ((t1 - t0) * len < MIN_SEG) continue;
    const tm = (t0 + t1) / 2;
    if (insideOrOn(accel, ax + dx * tm, ay + dy * tm, az + dz * tm)) {
      // merge with previous interval when contiguous
      if (kept.length && Math.abs(kept[kept.length - 1][1] - t0) < 1e-9) {
        kept[kept.length - 1][1] = t1;
      } else {
        kept.push([t0, t1]);
      }
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Lattice generation
// ---------------------------------------------------------------------------


// True if a cell-sized box lies entirely within the solid: all eight corners
// inside, and no surface passing through it. Whole-cell mode keeps only these,
// so every cell built is complete and none of it sticks out of the model.
function cellInsideSolid(accel, cx, cy, cz, s) {
  // Test a slightly shrunken cell, so a cell that merely abuts the surface
  // doesn't count. Without this a 100mm cube (faces exactly on grid planes)
  // would pull in the ring of cells beyond each face and come out 120mm.
  const eps = Math.min(0.02 * s, 0.2);
  const lo = { x: cx + eps, y: cy + eps, z: cz + eps };
  const hi = { x: cx + s - eps, y: cy + s - eps, z: cz + s - eps };

  // every corner (and the centre) must be in the solid
  for (const [px, py, pz] of [
    [cx + s / 2, cy + s / 2, cz + s / 2],
    [lo.x, lo.y, lo.z], [hi.x, lo.y, lo.z], [lo.x, hi.y, lo.z], [hi.x, hi.y, lo.z],
    [lo.x, lo.y, hi.z], [hi.x, lo.y, hi.z], [lo.x, hi.y, hi.z], [hi.x, hi.y, hi.z],
  ]) {
    if (!insideOrOn(accel, px, py, pz)) return false;
  }
  // corners can all be inside while the surface still cuts through the middle
  // (a thin wall, a notch) — such a cell is not complete
  const soup = accel.soup, cs = accel.cs;
  const i0 = clampi(Math.floor((cx - accel.oX) / cs), 0, accel.nX - 1);
  const i1 = clampi(Math.floor((cx + s - accel.oX) / cs), 0, accel.nX - 1);
  const j0 = clampi(Math.floor((cy - accel.oY) / cs), 0, accel.nY - 1);
  const j1 = clampi(Math.floor((cy + s - accel.oY) / cs), 0, accel.nY - 1);
  const k0 = clampi(Math.floor((cz - accel.oZ) / cs), 0, accel.nZ - 1);
  const k1 = clampi(Math.floor((cz + s - accel.oZ) / cs), 0, accel.nZ - 1);
  const seen = new Set();
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      for (let k = k0; k <= k1; k++) {
        const tris = accel.bins3d.get((i * accel.nY + j) * accel.nZ + k);
        if (!tris) continue;
        for (const t of tris) {
          if (seen.has(t)) continue;
          seen.add(t);
          const o = t * 9;
          if (Math.min(soup[o], soup[o + 3], soup[o + 6]) >= hi.x) continue;
          if (Math.max(soup[o], soup[o + 3], soup[o + 6]) <= lo.x) continue;
          if (Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) >= hi.y) continue;
          if (Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) <= lo.y) continue;
          if (Math.min(soup[o + 2], soup[o + 5], soup[o + 8]) >= hi.z) continue;
          if (Math.max(soup[o + 2], soup[o + 5], soup[o + 8]) <= lo.z) continue;
          return false;
        }
      }
    }
  }
  return true;
}

export async function generateLattice(accel, opts) {
  const s = opts.spacing;
  const lat = LATTICES[opts.lattice];
  if (!lat) throw new Error('Unknown lattice type: ' + opts.lattice);
  const edges = lat.edges.map((e) => e);
  if (opts.cellEdges && opts.lattice !== 'cubic') {
    for (const e of CUBIC_EDGES) edges.push(e);
  }

  const wholeCells = !!opts.wholeCells;
  const b = accel.bbox;
  // One full cell of padding each side, grid centred on the bounding box.
  // The cell count must snap when the span is within a hair of a whole number
  // of cells: float noise (e.g. 100.0000001mm) would otherwise bump ceil() up
  // one, making the count's parity flip so centred nodes miss the faces by
  // half a cell on that axis only.
  const cellsAcross = (span) => {
    const c = span / s;
    const snapped = Math.round(c);
    return (Math.abs(c - snapped) < 1e-4 ? snapped : Math.ceil(c)) + 2;
  };
  // In whole-cell mode the grid is phased so the block of COMPLETE cells is
  // centred on the model: a 105mm span keeps 10 whole cells centred (100mm)
  // instead of straddling the grid and only fitting 9.
  const wholeCellsAcross = (span) => Math.max(1, Math.floor(span / s + 1e-6)) + 2;

  const nx = wholeCells ? wholeCellsAcross(b.maxX - b.minX) : cellsAcross(b.maxX - b.minX);
  const ny = wholeCells ? wholeCellsAcross(b.maxY - b.minY) : cellsAcross(b.maxY - b.minY);
  const nz = wholeCells ? wholeCellsAcross(b.maxZ - b.minZ) : cellsAcross(b.maxZ - b.minZ);
  const x0 = (b.minX + b.maxX) / 2 - (nx * s) / 2;
  const y0 = (b.minY + b.maxY) / 2 - (ny * s) / 2;
  const z0 = (b.minZ + b.maxZ) / 2 - (nz * s) / 2;

  // unique candidate struts, keyed by quantised endpoints
  const seen = new Set();
  const struts = [];
  const q = (v) => Math.round(v * 1024);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const cx = x0 + i * s, cy = y0 + j * s, cz = z0 + k * s;
        // whole-cell mode builds every cell the model touches, complete, so
        // the lattice ends on flat grid planes instead of the model surface
        if (wholeCells && !cellInsideSolid(accel, cx, cy, cz, s)) continue;
        for (const [f1, f2] of edges) {
          const ax = cx + f1[0] * s, ay = cy + f1[1] * s, az = cz + f1[2] * s;
          const bx = cx + f2[0] * s, by = cy + f2[1] * s, bz = cz + f2[2] * s;
          const k1 = q(ax) + ',' + q(ay) + ',' + q(az);
          const k2 = q(bx) + ',' + q(by) + ',' + q(bz);
          const key = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
          if (seen.has(key)) continue;
          seen.add(key);
          struts.push(ax, ay, az, bx, by, bz);
        }
      }
    }
  }

  const total = struts.length / 6;
  const segments = [];       // {ax..bz, aNode, bNode}
  const nodeKeys = new Set(); // joints that keep their exact lattice position
  const nodes = [];

  // Rhino-style rule: a strut is kept only if the WHOLE node-to-node segment
  // lies inside the solid (boundary counts as inside). No partial struts are
  // ever created, so every kept strut runs joint to joint. clipSegment
  // returning a single full-span interval is an exact containment test that
  // also rejects struts tunnelling across gaps between bodies. On top of
  // that, struts whose interior runs along or grazes the surface are dropped:
  // the surface would clip their pipes into slivers ("hairs"). Only the ends
  // are allowed surface contact, so diagonals may still land on face nodes.
  for (let n = 0; n < total; n++) {
    const o = n * 6;
    const ax = struts[o], ay = struts[o + 1], az = struts[o + 2];
    const bx = struts[o + 3], by = struts[o + 4], bz = struts[o + 5];
    if (wholeCells) {
      // the cell already qualified; its struts are kept whole even where they
      // run outside the model, which is what squares off the sides
      segments.push({ ax, ay, az, bx, by, bz, aNode: true, bNode: true });
      addNode(nodeKeys, nodes, ax, ay, az, q);
      addNode(nodeKeys, nodes, bx, by, bz, q);
      if (opts.onProgress && n % 4096 === 0) await opts.onProgress(n, total);
      continue;
    }
    const intervals = clipSegment(accel, ax, ay, az, bx, by, bz);
    // "whole" within the usual boundary tolerance: a node sitting a float-hair
    // outside the surface must not disqualify its strut, so allow the interval
    // to start/end up to TOL_ON short of the endpoints
    const segLen = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2);
    const epsT = TOL_ON / Math.max(segLen, 1e-6);
    const whole = intervals.length === 1 &&
      intervals[0][0] < epsT && intervals[0][1] > 1 - epsT;
    if (whole && !axisGrazesSurface(accel, ax, ay, az, bx, by, bz)) {
      segments.push({ ax, ay, az, bx, by, bz, aNode: true, bNode: true });
      addNode(nodeKeys, nodes, ax, ay, az, q);
      addNode(nodeKeys, nodes, bx, by, bz, q);
    }
    if (opts.onProgress && n % 4096 === 0) await opts.onProgress(n, total);
  }

  return {
    segments, nodes,
    stats: {
      cells: nx * ny * nz,
      candidates: total,
      kept: segments.length,
      joints: nodes.length,
    },
  };
}

// True if the strut's interior touches or hugs the surface — samples along
// the axis (skipping an exemption zone at each end so endpoint contact with
// a face is allowed) must be strictly inside with HAIR_CLEAR of clearance.
const HAIR_CLEAR = 0.6;   // mm of required surface clearance along the span
const END_EXEMPT = 2.0;   // mm at each end where surface contact is fine
const HAIR_STEP = 1.0;    // mm sampling step

function axisGrazesSurface(accel, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const span = len - 2 * END_EXEMPT;
  if (span <= 0) return false;
  const steps = Math.max(1, Math.ceil(span / HAIR_STEP));
  const t0 = END_EXEMPT / len, t1 = 1 - t0;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const px = ax + dx * t, py = ay + dy * t, pz = az + dz * t;
    if (!pointInside(accel, px, py, pz)) return true;
    if (distToSurfaceUnder(accel, px, py, pz, HAIR_CLEAR)) return true;
  }
  return false;
}

function addNode(keys, nodes, x, y, z, q) {
  const key = q(x) + ',' + q(y) + ',' + q(z);
  if (keys.has(key)) return;
  keys.add(key);
  nodes.push(x, y, z);
}

// ---------------------------------------------------------------------------
// Smooth solid mesh (MultiPipe-style)
//
// The strut network is evaluated as a signed distance field: each strut is a
// flat-capped cylinder SDF, and struts are combined with a polynomial
// smooth-minimum so junctions blend into organic fillets instead of showing
// separate primitives. The surface is then extracted with naive surface nets,
// which yields a single watertight, indexed manifold mesh. Normals come from
// the field gradient, so shading is genuinely smooth.
// ---------------------------------------------------------------------------

export async function buildSmoothMesh(result, opts) {
  const r = opts.radius;
  const k = Math.max(0.05, opts.blend == null ? r * 0.6 : opts.blend);
  let voxel = opts.voxel || 0.5;
  // field only needs to be valid a little beyond the iso-surface: far enough
  // for blend pairs (≤ ~1.25k) and gradient sampling (± a voxel or so)
  const dmax = 1.25 * k + 1.5 * voxel;
  const range = r + dmax;           // stamping halo around each strut axis
  const segs = result.segments;
  if (!segs.length) throw new Error('No struts to mesh.');

  // grid over the strut network, padded so the field closes around everything
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const g of segs) {
    mnx = Math.min(mnx, g.ax, g.bx); mxx = Math.max(mxx, g.ax, g.bx);
    mny = Math.min(mny, g.ay, g.by); mxy = Math.max(mxy, g.ay, g.by);
    mnz = Math.min(mnz, g.az, g.bz); mxz = Math.max(mxz, g.az, g.bz);
  }
  const pad = range + 2 * voxel;
  mnx -= pad; mny -= pad; mnz -= pad; mxx += pad; mxy += pad; mxz += pad;
  // shift the grid off the lattice planes: samples landing exactly on flat
  // caps produce degenerate sign patterns (checkerboard faces -> bad topology)
  mnx -= 0.371 * voxel; mny -= 0.293 * voxel; mnz -= 0.417 * voxel;

  // keep the dense field under a sample budget; coarsen the voxel if needed.
  // Callers on memory-constrained devices (phones) pass a smaller budget.
  const MAX_SAMPLES = opts.maxSamples || 20e6;
  let nx, ny, nz;
  for (;;) {
    nx = Math.ceil((mxx - mnx) / voxel) + 1;
    ny = Math.ceil((mxy - mny) / voxel) + 1;
    nz = Math.ceil((mxz - mnz) / voxel) + 1;
    if (nx * ny * nz <= MAX_SAMPLES) break;
    voxel *= 1.25;
  }

  const BIG = 1e6;
  // per voxel: the two smallest strut distances. Blending only the two nearest
  // struts (polynomial smooth-min) is order-independent and bounded, so joints
  // fillet without the inflation or flat spots that N-way accumulation causes.
  const field = new Float32Array(nx * ny * nz).fill(BIG); // nearest distance
  const second = new Float32Array(nx * ny * nz).fill(BIG); // second nearest
  const idx = (i, j, kk) => (i * ny + j) * nz + kk;

  for (let n = 0; n < segs.length; n++) {
    const g = segs[n];
    let dx = g.bx - g.ax, dy = g.by - g.ay, dz = g.bz - g.az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) continue;
    dx /= len; dy /= len; dz /= len;
    const half = len / 2;
    const cx = (g.ax + g.bx) / 2, cy = (g.ay + g.by) / 2, cz = (g.az + g.bz) / 2;

    const i0 = Math.max(0, Math.floor((Math.min(g.ax, g.bx) - range - mnx) / voxel));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(g.ax, g.bx) + range - mnx) / voxel));
    const j0 = Math.max(0, Math.floor((Math.min(g.ay, g.by) - range - mny) / voxel));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(g.ay, g.by) + range - mny) / voxel));
    const k0 = Math.max(0, Math.floor((Math.min(g.az, g.bz) - range - mnz) / voxel));
    const k1 = Math.min(nz - 1, Math.ceil((Math.max(g.az, g.bz) + range - mnz) / voxel));

    for (let i = i0; i <= i1; i++) {
      const px = mnx + i * voxel - cx;
      for (let j = j0; j <= j1; j++) {
        const py = mny + j * voxel - cy;
        for (let kk = k0; kk <= k1; kk++) {
          const pz = mnz + kk * voxel - cz;
          // flat-capped cylinder SDF, axis through the segment midpoint
          const t = px * dx + py * dy + pz * dz;
          const rad2 = px * px + py * py + pz * pz - t * t;
          const dRad = (rad2 > 0 ? Math.sqrt(rad2) : 0) - r;
          const dAx = Math.abs(t) - half;
          let d;
          if (dRad <= 0 && dAx <= 0) d = Math.max(dRad, dAx);
          else {
            const ox = dRad > 0 ? dRad : 0, oy = dAx > 0 ? dAx : 0;
            d = Math.sqrt(ox * ox + oy * oy);
          }
          if (d < dmax) {
            const id = idx(i, j, kk);
            if (d < field[id]) { second[id] = field[id]; field[id] = d; }
            else if (d < second[id]) second[id] = d;
          }
        }
      }
    }
    if (opts.onProgress && n % 256 === 0) await opts.onProgress(n, segs.length, 'stamping');
  }

  // How close each voxel is to the model surface, used to taper the blend.
  // Only needed within a shallow band — anything deeper is fully interior.
  let depth = null;
  if (opts.accel) {
    const accel = opts.accel;
    const soup = accel.soup;
    const band = r + k + 2 * voxel;
    const band2 = band * band;
    depth = new Float32Array(field.length).fill(BIG);
    for (let t = 0; t < accel.triCount; t++) {
      const o = t * 9;
      const i0 = Math.max(0, Math.floor((Math.min(soup[o], soup[o + 3], soup[o + 6]) - band - mnx) / voxel));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(soup[o], soup[o + 3], soup[o + 6]) + band - mnx) / voxel));
      const j0 = Math.max(0, Math.floor((Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) - band - mny) / voxel));
      const j1 = Math.min(ny - 1, Math.ceil((Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) + band - mny) / voxel));
      const k0 = Math.max(0, Math.floor((Math.min(soup[o + 2], soup[o + 5], soup[o + 8]) - band - mnz) / voxel));
      const k1 = Math.min(nz - 1, Math.ceil((Math.max(soup[o + 2], soup[o + 5], soup[o + 8]) + band - mnz) / voxel));
      for (let i = i0; i <= i1; i++) {
        const x = mnx + i * voxel;
        for (let j = j0; j <= j1; j++) {
          const y = mny + j * voxel;
          for (let kk = k0; kk <= k1; kk++) {
            const d2 = pointTriDist2(soup, t, x, y, mnz + kk * voxel);
            if (d2 < band2) {
              const id = idx(i, j, kk);
              const d = Math.sqrt(d2);
              if (d < depth[id]) depth[id] = d;
            }
          }
        }
      }
      if (opts.onProgress && t % 2048 === 0) await opts.onProgress(t, accel.triCount, 'trimming');
    }
    // Sign it: a voxel outside the model gets negative depth, so the taper
    // below switches the fillet off there too. Without this the pipe surface
    // itself (a radius proud of the model) still picked up part of the blend
    // and the node kept a visible lump.
    for (let j = 0; j < ny; j++) {
      const y = mny + j * voxel;
      for (let kk = 0; kk < nz; kk++) {
        const xs = rayCrossings(accel, y, mnz + kk * voxel);
        let ptr = 0;
        for (let i = 0; i < nx; i++) {
          const x = mnx + i * voxel;
          while (ptr < xs.length && xs[ptr] <= x + EPS_PARITY) ptr++;
          if (((xs.length - ptr) & 1) === 0) {
            const id = idx(i, j, kk);
            if (depth[id] < BIG) depth[id] = -depth[id];
          }
        }
      }
    }
  }

  // Blend the two nearest struts per voxel. The fillet is what makes joints
  // organic, but at the model surface it swells into a lump standing proud of
  // the struts. Taper it to nothing over the last `fade` of depth so exterior
  // joints are a plain strut union — strut and node colinear — while interior
  // joints keep the full fillet.
  const fade = Math.max(k, 1e-6);
  for (let i = 0; i < field.length; i++) {
    let kk2 = k;
    if (depth) {
      const w = Math.max(0, Math.min(depth[i] / fade, 1));
      kk2 = k * w;
      if (kk2 < 1e-4) continue;   // at or outside the surface: no blend at all
    }
    const h = kk2 - (second[i] - field[i]);
    if (h > 0) field[i] -= (h * h * 0.25) / kk2;
  }

  // Optionally cut the pipes flush with the input solid. Off by default: the
  // generator already keeps struts inside, so this would only slice the
  // outermost pipes into flat half-rounds.
  if (opts.accel && opts.trimToSurface) {
    const accel = opts.accel;
    const soup = accel.soup;
    const band = r + k + 2 * voxel;
    const sdMag = new Float32Array(field.length).fill(BIG);
    for (let t = 0; t < accel.triCount; t++) {
      const o = t * 9;
      const i0 = Math.max(0, Math.floor((Math.min(soup[o], soup[o + 3], soup[o + 6]) - band - mnx) / voxel));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(soup[o], soup[o + 3], soup[o + 6]) + band - mnx) / voxel));
      const j0 = Math.max(0, Math.floor((Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) - band - mny) / voxel));
      const j1 = Math.min(ny - 1, Math.ceil((Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) + band - mny) / voxel));
      const k0 = Math.max(0, Math.floor((Math.min(soup[o + 2], soup[o + 5], soup[o + 8]) - band - mnz) / voxel));
      const k1 = Math.min(nz - 1, Math.ceil((Math.max(soup[o + 2], soup[o + 5], soup[o + 8]) + band - mnz) / voxel));
      const band2 = band * band;
      for (let i = i0; i <= i1; i++) {
        const x = mnx + i * voxel;
        for (let j = j0; j <= j1; j++) {
          const y = mny + j * voxel;
          for (let kk = k0; kk <= k1; kk++) {
            const d2 = pointTriDist2(soup, t, x, y, mnz + kk * voxel);
            if (d2 < band2) {
              const id = idx(i, j, kk);
              const d = Math.sqrt(d2);
              if (d < sdMag[id]) sdMag[id] = d;
            }
          }
        }
      }
      if (opts.onProgress && t % 2048 === 0) await opts.onProgress(t, accel.triCount, 'trimming');
    }
    // Walk each x-column once, tracking inside/outside via sorted crossings.
    // The cut is inset slightly: pipes lying exactly in the surface would meet
    // a flush cut tangentially along their silhouettes, which aliases into
    // pinched non-manifold topology at any grid resolution.
    const trimInset = Math.max(0.2, 0.3 * voxel);
    for (let j = 0; j < ny; j++) {
      const y = mny + j * voxel;
      for (let kk = 0; kk < nz; kk++) {
        const xs = rayCrossings(accel, y, mnz + kk * voxel);
        let ptr = 0;
        for (let i = 0; i < nx; i++) {
          const x = mnx + i * voxel;
          while (ptr < xs.length && xs[ptr] <= x + EPS_PARITY) ptr++;
          const inside = ((xs.length - ptr) & 1) === 1;
          const id = idx(i, j, kk);
          const s = (inside ? -sdMag[id] : sdMag[id]) + trimInset;
          if (s > field[id]) field[id] = s;
        }
      }
    }
  }

  // ---- naive surface nets ----
  const cellVert = new Map();  // packed cell id -> vertex index
  const positions = [];
  const cellId = (i, j, kk) => (i * (ny - 1) + j) * (nz - 1) + kk;
  const CUBE = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],  // x edges
    [0, 2], [1, 3], [4, 6], [5, 7],  // y edges
    [0, 4], [1, 5], [2, 6], [3, 7],  // z edges
  ];

  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let kk = 0; kk < nz - 1; kk++) {
        const f = [];
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[idx(i + CUBE[c][0], j + CUBE[c][1], kk + CUBE[c][2])];
          f.push(v);
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of EDGES) {
          const fa = f[a], fb = f[b];
          if ((fa < 0) === (fb < 0)) continue;
          const t = fa / (fa - fb);
          sx += CUBE[a][0] + t * (CUBE[b][0] - CUBE[a][0]);
          sy += CUBE[a][1] + t * (CUBE[b][1] - CUBE[a][1]);
          sz += CUBE[a][2] + t * (CUBE[b][2] - CUBE[a][2]);
          cnt++;
        }
        cellVert.set(cellId(i, j, kk), positions.length / 3);
        positions.push(
          mnx + (i + sx / cnt) * voxel,
          mny + (j + sy / cnt) * voxel,
          mnz + (kk + sz / cnt) * voxel);
      }
    }
    if (opts.onProgress && i % 16 === 0) await opts.onProgress(i, nx, 'meshing');
  }

  // faces: one quad per grid edge with a sign change, joining the 4 cells
  // that share the edge
  const indices = [];
  const quad = (a, b, c, d, flip) => {
    if (a == null || b == null || c == null || d == null) return;
    if (flip) indices.push(a, b, c, a, c, d);
    else indices.push(a, c, b, a, d, c);
  };
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let kk = 0; kk < nz - 1; kk++) {
        const f0 = field[idx(i, j, kk)];
        const in0 = f0 < 0;
        // x edge
        if (j > 0 && kk > 0 && ((field[idx(i + 1, j, kk)] < 0) !== in0)) {
          quad(cellVert.get(cellId(i, j - 1, kk - 1)), cellVert.get(cellId(i, j, kk - 1)),
               cellVert.get(cellId(i, j, kk)), cellVert.get(cellId(i, j - 1, kk)), in0);
        }
        // y edge
        if (i > 0 && kk > 0 && ((field[idx(i, j + 1, kk)] < 0) !== in0)) {
          quad(cellVert.get(cellId(i - 1, j, kk - 1)), cellVert.get(cellId(i - 1, j, kk)),
               cellVert.get(cellId(i, j, kk)), cellVert.get(cellId(i, j, kk - 1)), in0);
        }
        // z edge
        if (i > 0 && j > 0 && ((field[idx(i, j, kk + 1)] < 0) !== in0)) {
          quad(cellVert.get(cellId(i - 1, j - 1, kk)), cellVert.get(cellId(i, j - 1, kk)),
               cellVert.get(cellId(i, j, kk)), cellVert.get(cellId(i - 1, j, kk)), in0);
        }
      }
    }
  }

  // smooth normals from the field gradient
  const normals = new Float32Array(positions.length);
  const fieldAt = (x, y, z) => {
    let gx = (x - mnx) / voxel, gy = (y - mny) / voxel, gz = (z - mnz) / voxel;
    gx = Math.min(Math.max(gx, 0), nx - 1.001);
    gy = Math.min(Math.max(gy, 0), ny - 1.001);
    gz = Math.min(Math.max(gz, 0), nz - 1.001);
    const i = Math.floor(gx), j = Math.floor(gy), kk = Math.floor(gz);
    const fx = gx - i, fy = gy - j, fz = gz - kk;
    const c000 = field[idx(i, j, kk)], c100 = field[idx(i + 1, j, kk)];
    const c010 = field[idx(i, j + 1, kk)], c110 = field[idx(i + 1, j + 1, kk)];
    const c001 = field[idx(i, j, kk + 1)], c101 = field[idx(i + 1, j, kk + 1)];
    const c011 = field[idx(i, j + 1, kk + 1)], c111 = field[idx(i + 1, j + 1, kk + 1)];
    const c00 = c000 + fx * (c100 - c000), c10 = c010 + fx * (c110 - c010);
    const c01 = c001 + fx * (c101 - c001), c11 = c011 + fx * (c111 - c011);
    const c0 = c00 + fy * (c10 - c00), c1 = c01 + fy * (c11 - c01);
    return c0 + fz * (c1 - c0);
  };
  const h = voxel * 0.5;
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v], y = positions[v + 1], z = positions[v + 2];
    let gx = fieldAt(x + h, y, z) - fieldAt(x - h, y, z);
    let gy = fieldAt(x, y + h, z) - fieldAt(x, y - h, z);
    let gz = fieldAt(x, y, z + h) - fieldAt(x, y, z - h);
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    normals[v] = gx / l; normals[v + 1] = gy / l; normals[v + 2] = gz / l;
  }

  return {
    positions: new Float32Array(positions),
    normals,
    indices: positions.length / 3 > 65535
      ? new Uint32Array(indices) : new Uint16Array(indices),
    stats: { verts: positions.length / 3, tris: indices.length / 3, voxel },
  };
}

// ---------------------------------------------------------------------------
// Binary STL export (indexed mesh)
// ---------------------------------------------------------------------------

export function exportBinarySTL(mesh, name) {
  const { positions, indices } = mesh;
  const triCount = indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = (name || 'lattice') + ' — generated by bcc lattice web';
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    const l = Math.sqrt(nxv * nxv + nyv * nyv + nzv * nzv) || 1;
    dv.setFloat32(o, nxv / l, true); o += 4;
    dv.setFloat32(o, nyv / l, true); o += 4;
    dv.setFloat32(o, nzv / l, true); o += 4;
    for (const vi of [a, b, c]) {
      dv.setFloat32(o, positions[vi], true); o += 4;
      dv.setFloat32(o, positions[vi + 1], true); o += 4;
      dv.setFloat32(o, positions[vi + 2], true); o += 4;
    }
    o += 2;
  }
  return buf;
}
