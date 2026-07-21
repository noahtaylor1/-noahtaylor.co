// Kitty City — procedural art, HAND-DRAWN edition.
// Nothing is a perfect shape: every line wobbles (seeded per tile so it's
// stable), fills are slightly misregistered like marker coloring outside
// the lines, buildings lean, faces are uneven — and the jitter "boils"
// through 3 phases per second like a flipbook cartoon.

import { T, W, H, idx, inB, catXY } from "./sim.js";

const PAL = {
  bg: "#fffdf7",
  grass: "#f4f9ee",
  ink: "#242220",
  road: "#e8e3da",
  track: "#c9c2b8",
  pastels: ["#f9c9d4", "#aecbfa", "#c8e6c9", "#ffe0a3", "#e1d5f5", "#b9e8e0"],
  park: "#bfe3b4",
  leaf: "#8fce85",
  plaza: "#ffe9f0",
  gold: "#ffd97a",
};

const LINE = 0.085;

// --- scribble math -------------------------------------------------------

// deterministic hash -> [0,1)
function r01(seed) {
  let n = (seed | 0) * 2654435761;
  n = (n ^ (n >>> 16)) * 2246822519;
  n = (n ^ (n >>> 13)) * 3266489917;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
// jitter in [-amp, amp]
function jit(seed, k, amp) { return (r01(seed * 131 + k * 7919) - 0.5) * 2 * amp; }

// boil phase: the whole drawing re-rolls its wobble ~5x/sec, cycling 3 poses
function boil(time) { return (((time * 5) | 0) % 3) * 977; }

// closed blob through N jittered ring points, smoothed with quadratics
function blobPath(ctx, cx, cy, rx, ry, seed, amp = 0.12, N = 8) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rj = 1 + jit(seed, i, amp);
    pts.push([cx + Math.cos(a) * rx * rj, cy + Math.sin(a) * ry * rj]);
  }
  ctx.beginPath();
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let m = mid(pts[N - 1], pts[0]);
  ctx.moveTo(m[0], m[1]);
  for (let i = 0; i < N; i++) {
    const nm = mid(pts[i], pts[(i + 1) % N]);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], nm[0], nm[1]);
  }
  ctx.closePath();
}

// wobbly polyline: each segment gets a bowed jittered midpoint
function wline(ctx, pts, seed, amp = 0.03) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] + jit(seed, 0, amp), pts[0][1] + jit(seed, 1, amp));
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2 + jit(seed, i * 2 + 7, amp * 1.6);
    const my = (y0 + y1) / 2 + jit(seed, i * 2 + 8, amp * 1.6);
    ctx.quadraticCurveTo(mx, my, x1 + jit(seed, i * 2 + 9, amp), y1 + jit(seed, i * 2 + 10, amp));
  }
}

// wobbly rectangle path (corners + bowed edges)
function wrectPath(ctx, x, y, w, h, seed, amp = 0.03) {
  const c = [
    [x + jit(seed, 1, amp), y + jit(seed, 2, amp)],
    [x + w + jit(seed, 3, amp), y + jit(seed, 4, amp)],
    [x + w + jit(seed, 5, amp), y + h + jit(seed, 6, amp)],
    [x + jit(seed, 7, amp), y + h + jit(seed, 8, amp)],
  ];
  ctx.beginPath();
  ctx.moveTo(c[0][0], c[0][1]);
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2 + jit(seed, 20 + i, amp * 1.8);
    const my = (a[1] + b[1]) / 2 + jit(seed, 30 + i, amp * 1.8);
    ctx.quadraticCurveTo(mx, my, b[0], b[1]);
  }
  ctx.closePath();
}

// fill slightly offset from where the outline will go — "colored outside
// the lines" — then stroke the true path on top
function sketch(ctx, pathFn, fillColor, seed) {
  if (fillColor) {
    ctx.save();
    ctx.translate(jit(seed, 91, 0.035), jit(seed, 92, 0.035));
    pathFn();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.restore();
  }
  pathFn();
  ctx.stroke();
}

// --- tiles ---------------------------------------------------------------

function drawTile(ctx, state, x, y, time) {
  const i = idx(x, y);
  const t = state.grid[i];
  if (t === T.EMPTY) return;
  // line boil animates everything EXCEPT roads and houses (per request:
  // "fun but not on everything, not on roads or houses") -- those two are
  // most of the screen, so freezing them calms the scene while factories,
  // parks, trams and plazas stay lively
  const still = t === T.ROAD || t === T.HOUSE;
  const v = state.variant[i] + (still ? 0 : boil(time));

  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = LINE;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // buildings lean a little, each its own way
  if (t === T.HOUSE || t === T.WORK || t === T.STATION || t === T.STATUE) {
    ctx.translate(0.5, 0.5);
    ctx.rotate(jit(v, 999, 0.05));
    ctx.translate(-0.5, -0.5);
  }

  switch (t) {
    case T.ROAD: drawRoad(ctx, state, x, y, v); break;
    case T.AVENUE: drawAvenue(ctx, state, x, y, v); break;
    case T.BIKE: drawBike(ctx, state, x, y, v); break;
    case T.RZONE: drawZonePlot(ctx, v, "#f2a9bc"); break;
    case T.WZONE: drawZonePlot(ctx, v, "#8fb4f7"); break;
    case T.HOUSE: drawHouse(ctx, v); break;
    case T.WORK: drawWork(ctx, v); break;
    case T.PARK: drawPark(ctx, v, time); break;
    case T.TRACK: drawTrack(ctx, state, x, y, v); break;
    case T.STATION: drawStation(ctx, state, x, y, v); break;
    case T.PLAZA: drawPlaza(ctx, v); break;
    case T.STATUE: drawStatue(ctx, v, time); break;
    case T.AIRPORT: drawAirport(ctx, v); break;
    case T.MONUMENT: drawMonument(ctx, v); break;
  }
  ctx.restore();
}

function vc(v, n) { return PAL.pastels[(((v % 977) | 0) + n) % PAL.pastels.length]; }

function roadMask(state, x, y, kinds) {
  let m = 0;
  const dirs = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]];
  for (const [dx, dy, bit] of dirs) {
    if (inB(x + dx, y + dy) && kinds.includes(state.grid[idx(x + dx, y + dy)])) m |= bit;
  }
  return m;
}

function drawRoad(ctx, state, x, y, v) {
  const m = roadMask(state, x, y, [T.ROAD, T.AVENUE, T.STATION, T.PLAZA, T.BIKE]);
  const w = 0.64, o = (1 - w) / 2;
  ctx.fillStyle = PAL.road;
  // wobbly core patch (no outline — it's ground)
  wrectPath(ctx, o, o, w, w, v, 0.05);
  ctx.fill();
  if (m & 1) { wrectPath(ctx, o, -0.02, w, o + 0.07, v + 1, 0.03); ctx.fill(); }
  if (m & 2) { wrectPath(ctx, 1 - o - 0.05, o, o + 0.07, w, v + 2, 0.03); ctx.fill(); }
  if (m & 4) { wrectPath(ctx, o, 1 - o - 0.05, w, o + 0.07, v + 3, 0.03); ctx.fill(); }
  if (m & 8) { wrectPath(ctx, -0.02, o, o + 0.07, w, v + 4, 0.03); ctx.fill(); }
  // pawprint doodle
  ctx.fillStyle = "#d2cabf";
  blobPath(ctx, 0.5 + jit(v, 40, 0.08), 0.52 + jit(v, 41, 0.08), 0.075, 0.065, v + 5, 0.25, 6);
  ctx.fill();
  for (let k = 0; k < 3; k++) {
    blobPath(ctx, 0.38 + k * 0.12 + jit(v, 50 + k, 0.02), 0.38 + (k === 1 ? -0.03 : 0), 0.035, 0.035, v + 6 + k, 0.3, 5);
    ctx.fill();
  }
}

function drawAvenue(ctx, state, x, y, v) {
  const m = roadMask(state, x, y, [T.AVENUE, T.ROAD, T.STATION, T.PLAZA, T.BIKE]);
  const w = 0.86, o = (1 - w) / 2;
  ctx.fillStyle = "#ddd6ca";
  wrectPath(ctx, o, o, w, w, v, 0.04);
  ctx.fill();
  if (m & 1) { wrectPath(ctx, o, -0.02, w, o + 0.06, v + 1, 0.025); ctx.fill(); }
  if (m & 2) { wrectPath(ctx, 1 - o - 0.04, o, o + 0.06, w, v + 2, 0.025); ctx.fill(); }
  if (m & 4) { wrectPath(ctx, o, 1 - o - 0.04, w, o + 0.06, v + 3, 0.025); ctx.fill(); }
  if (m & 8) { wrectPath(ctx, -0.02, o, o + 0.06, w, v + 4, 0.025); ctx.fill(); }
  // scribbled center dashes, following the strongest direction
  ctx.strokeStyle = "#fff6d8";
  ctx.lineWidth = 0.06;
  const vertical = (m & 5) && !(m & 10) ? true : (m & 10) && !(m & 5) ? false : ((v % 2) === 0);
  for (let k = 0; k < 2; k++) {
    const a = 0.18 + k * 0.5, b = a + 0.22;
    wline(ctx, vertical ? [[0.5, a], [0.5, b]] : [[a, 0.5], [b, 0.5]], v + 10 + k, 0.02);
    ctx.stroke();
  }
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = LINE;
}

function drawBike(ctx, state, x, y, v) {
  const m = roadMask(state, x, y, [T.BIKE, T.ROAD, T.AVENUE, T.STATION, T.PLAZA]);
  ctx.strokeStyle = "#cfe6c3";
  ctx.lineWidth = 0.3;
  ctx.lineCap = "round";
  const arms = [[1, 0.5, 0], [2, 1, 0.5], [4, 0.5, 1], [8, 0, 0.5]];
  let any = false;
  for (const [bit, ax, ay] of arms) {
    if (m & bit) { wline(ctx, [[0.5, 0.5], [ax, ay]], v + bit, 0.03); ctx.stroke(); any = true; }
  }
  if (!any) { wline(ctx, [[0.22, 0.5], [0.78, 0.5]], v, 0.03); ctx.stroke(); }
  // every few tiles, a doodled bicycle: two wheels + frame
  if (v % 3 === 0) {
    ctx.strokeStyle = "#7ba86f";
    ctx.lineWidth = 0.04;
    blobPath(ctx, 0.38, 0.55, 0.09, 0.09, v + 5, 0.12, 6); ctx.stroke();
    blobPath(ctx, 0.64, 0.55, 0.09, 0.09, v + 6, 0.12, 6); ctx.stroke();
    wline(ctx, [[0.38, 0.55], [0.5, 0.42], [0.64, 0.55], [0.5, 0.56], [0.38, 0.55]], v + 7, 0.015);
    ctx.stroke();
    wline(ctx, [[0.5, 0.42], [0.47, 0.34]], v + 8, 0.01); ctx.stroke();
  }
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = LINE;
  ctx.lineCap = "round";
}

function drawZonePlot(ctx, v, color) {
  // hand-dashed plot: 8 loose strokes roughly around the square
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.055;
  const segs = [
    [[0.15, 0.12], [0.45, 0.13]], [[0.55, 0.11], [0.86, 0.15]],
    [[0.88, 0.18], [0.87, 0.48]], [[0.89, 0.56], [0.86, 0.85]],
    [[0.84, 0.88], [0.53, 0.87]], [[0.44, 0.89], [0.14, 0.86]],
    [[0.12, 0.83], [0.13, 0.52]], [[0.11, 0.45], [0.14, 0.15]],
  ];
  for (let k = 0; k < segs.length; k++) {
    wline(ctx, segs[k], v + k, 0.03);
    ctx.stroke();
  }
  // paw scribble in the middle
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 0.05;
  blobPath(ctx, 0.5, 0.56, 0.1, 0.09, v + 20, 0.25, 6); ctx.stroke();
  for (let k = 0; k < 3; k++) {
    blobPath(ctx, 0.38 + k * 0.12, 0.4 + (k === 1 ? -0.04 : 0), 0.04, 0.04, v + 21 + k, 0.3, 5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawHouse(ctx, v) {
  const c = vc(v, 0);
  // body
  sketch(ctx, () => wrectPath(ctx, 0.14, 0.34, 0.72, 0.55, v, 0.035), c, v);
  // roof = wonky cat head: ears different heights, brow hand-drawn
  const earL = 0.13 + jit(v, 60, 0.05), earR = 0.13 + jit(v, 61, 0.05);
  const roof = () => {
    ctx.beginPath();
    ctx.moveTo(0.15 + jit(v, 62, 0.02), 0.44);
    ctx.lineTo(0.17 + jit(v, 63, 0.03), earL);
    ctx.lineTo(0.36, 0.27 + jit(v, 64, 0.02));
    ctx.quadraticCurveTo(0.5 + jit(v, 65, 0.05), 0.16 + jit(v, 66, 0.04), 0.64, 0.27 + jit(v, 67, 0.02));
    ctx.lineTo(0.83 - jit(v, 68, 0.03), earR);
    ctx.lineTo(0.85 + jit(v, 69, 0.02), 0.44);
    ctx.closePath();
  };
  sketch(ctx, roof, c, v + 1);
  // face: uneven eyes + :3
  ctx.fillStyle = PAL.ink;
  const e1 = 0.026 + jit(v, 70, 0.008), e2 = 0.026 + jit(v, 71, 0.008);
  ctx.beginPath(); ctx.arc(0.38 + jit(v, 72, 0.015), 0.335, e1, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(0.62 + jit(v, 73, 0.015), 0.34, e2, 0, 7); ctx.fill();
  catMouth(ctx, 0.5, 0.375, 0.05, v);
  // door, a bit off square
  sketch(ctx, () => wrectPath(ctx, 0.42 + jit(v, 74, 0.03), 0.63, 0.16, 0.26, v + 2, 0.03), PAL.bg, v + 3);
}

function drawWork(ctx, v) {
  const c = vc(v, 3);
  sketch(ctx, () => wrectPath(ctx, 0.1, 0.36, 0.8, 0.54, v, 0.035), c, v);
  // scribbled sawtooth roof
  const roof = () => {
    ctx.beginPath();
    ctx.moveTo(0.1 + jit(v, 80, 0.02), 0.42);
    ctx.quadraticCurveTo(0.16, 0.13 + jit(v, 81, 0.04), 0.37 + jit(v, 82, 0.02), 0.35);
    ctx.quadraticCurveTo(0.45, 0.13 + jit(v, 83, 0.04), 0.64 + jit(v, 84, 0.02), 0.35);
    ctx.quadraticCurveTo(0.72, 0.13 + jit(v, 85, 0.04), 0.9 + jit(v, 86, 0.02), 0.42);
    ctx.closePath();
  };
  sketch(ctx, roof, c, v + 1);
  // sign with doodled fish
  sketch(ctx, () => wrectPath(ctx, 0.3, 0.5, 0.4, 0.25, v + 2, 0.03), PAL.bg, v + 2);
  ctx.lineWidth = 0.045;
  blobPath(ctx, 0.46, 0.625, 0.085, 0.05, v + 3, 0.2, 6);
  ctx.stroke();
  wline(ctx, [[0.55, 0.625], [0.63, 0.56], [0.63, 0.69], [0.55, 0.625]], v + 4, 0.015);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(0.42, 0.615, 0.012, 0, 7); ctx.fillStyle = PAL.ink; ctx.fill();
  ctx.lineWidth = LINE;
}

function drawPark(ctx, v, time) {
  sketch(ctx, () => blobPath(ctx, 0.5, 0.5, 0.46, 0.45, v, 0.09), PAL.park, v);
  const sway = Math.sin(time * 1.5 + v) * 0.02;
  // scribbly tree
  ctx.lineWidth = 0.05;
  wline(ctx, [[0.5, 0.78], [0.5 + jit(v, 90, 0.04), 0.55]], v + 1, 0.02);
  ctx.stroke();
  ctx.lineWidth = LINE;
  sketch(ctx, () => blobPath(ctx, 0.5 + sway, 0.42, 0.2, 0.17, v + 2, 0.18, 7), PAL.leaf, v + 2);
  // yarn doodle
  sketch(ctx, () => blobPath(ctx, 0.73, 0.75, 0.095, 0.09, v + 3, 0.15, 6), "#f9c9d4", v + 3);
  ctx.lineWidth = 0.03;
  wline(ctx, [[0.66, 0.72], [0.78, 0.7], [0.68, 0.79], [0.8, 0.77]], v + 4, 0.012);
  ctx.stroke();
  ctx.lineWidth = LINE;
}

function drawTrack(ctx, state, x, y, v) {
  const m = roadMask(state, x, y, [T.TRACK, T.STATION]);
  const arms = [[1, 0.5, 0], [2, 1, 0.5], [4, 0.5, 1], [8, 0, 0.5]];
  ctx.strokeStyle = PAL.track;
  ctx.lineWidth = 0.26;
  let any = false;
  for (const [bit, ax, ay] of arms) {
    if (m & bit) { wline(ctx, [[0.5, 0.5], [ax, ay]], v + bit, 0.02); ctx.stroke(); any = true; }
  }
  if (!any) { wline(ctx, [[0.24, 0.5], [0.76, 0.5]], v, 0.02); ctx.stroke(); }
  // sketchy center line
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 0.04;
  for (const [bit, ax, ay] of arms) {
    if (m & bit) { wline(ctx, [[0.5, 0.5], [ax, ay]], v + bit + 5, 0.025); ctx.stroke(); }
  }
  if (!any) { wline(ctx, [[0.24, 0.5], [0.76, 0.5]], v + 5, 0.025); ctx.stroke(); }
  ctx.lineWidth = LINE;
}

function drawStation(ctx, state, x, y, v) {
  drawTrack(ctx, state, x, y, v);
  const c = vc(v, 1);
  sketch(ctx, () => wrectPath(ctx, 0.22, 0.24, 0.56, 0.55, v, 0.04), c, v);
  // crooked little ears
  const ear = (x0, tipX, tipY, x1, y1) => () => {
    ctx.beginPath();
    ctx.moveTo(x0, 0.28);
    ctx.lineTo(tipX + jit(v, 95, 0.03), tipY + jit(v, 96, 0.03));
    ctx.lineTo(x1, y1);
    ctx.closePath();
  };
  sketch(ctx, ear(0.26, 0.3, 0.11, 0.42, 0.24), c, v + 1);
  sketch(ctx, ear(0.74, 0.68, 0.13, 0.56, 0.24), c, v + 2);
  // bell doodle
  sketch(ctx, () => blobPath(ctx, 0.5, 0.52, 0.12, 0.11, v + 3, 0.15, 6), PAL.gold, v + 3);
  ctx.fillStyle = PAL.ink;
  ctx.beginPath(); ctx.arc(0.5 + jit(v, 97, 0.02), 0.58, 0.028, 0, 7); ctx.fill();
}

function drawPlaza(ctx, v) {
  sketch(ctx, () => wrectPath(ctx, 0.06, 0.06, 0.88, 0.88, v, 0.045), PAL.plaza, v);
  sketch(ctx, () => blobPath(ctx, 0.5, 0.5, 0.23, 0.21, v + 1, 0.12, 7), "#aecbfa", v + 1);
  sketch(ctx, () => blobPath(ctx, 0.5, 0.5, 0.1, 0.09, v + 2, 0.18, 6), PAL.bg, v + 2);
  // sparkle scribbles: little plus signs, all crooked
  ctx.lineWidth = 0.04;
  for (const [k, [sx, sy]] of [[0, [0.2, 0.2]], [1, [0.8, 0.24]], [2, [0.24, 0.8]], [3, [0.78, 0.78]]]) {
    wline(ctx, [[sx - 0.04, sy], [sx + 0.04, sy]], v + 10 + k, 0.015); ctx.stroke();
    wline(ctx, [[sx, sy - 0.04], [sx, sy + 0.04]], v + 20 + k, 0.015); ctx.stroke();
  }
  ctx.lineWidth = LINE;
}

function drawStatue(ctx, v, time) {
  sketch(ctx, () => wrectPath(ctx, 0.18, 0.62, 0.64, 0.28, v, 0.035), PAL.gold, v);
  const bob = Math.sin(time * 2) * 0.02;
  sketch(ctx, () => blobPath(ctx, 0.5, 0.4 + bob, 0.21, 0.2, v + 1, 0.12, 7), PAL.gold, v + 1);
  // yarn wraps: loose scribble arcs
  ctx.lineWidth = 0.035;
  wline(ctx, [[0.33, 0.36 + bob], [0.52, 0.3 + bob], [0.67, 0.42 + bob]], v + 2, 0.02); ctx.stroke();
  wline(ctx, [[0.35, 0.48 + bob], [0.55, 0.52 + bob], [0.66, 0.44 + bob]], v + 3, 0.02); ctx.stroke();
  ctx.lineWidth = LINE;
}

function drawAirport(ctx, v) {
  // landmark: drawn oversized, spilling past its tile a bit
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.scale(1.45, 1.45);
  ctx.translate(-0.5, -0.5);
  ctx.lineWidth = LINE / 1.45;
  // runway diagonal-ish strip
  ctx.fillStyle = "#d8d2c6";
  wrectPath(ctx, 0.02, 0.62, 0.96, 0.24, v, 0.03);
  ctx.fill();
  ctx.strokeStyle = "#fffdf7";
  ctx.lineWidth = 0.035;
  for (let k = 0; k < 4; k++) {
    wline(ctx, [[0.12 + k * 0.24, 0.74], [0.22 + k * 0.24, 0.74]], v + k, 0.012);
    ctx.stroke();
  }
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = LINE / 1.45;
  // terminal with cat ears
  sketch(ctx, () => wrectPath(ctx, 0.14, 0.34, 0.5, 0.26, v + 5, 0.03), vc(v, 2), v + 5);
  const ear = (x0, tx, ty, x1) => () => {
    ctx.beginPath(); ctx.moveTo(x0, 0.36); ctx.lineTo(tx, ty); ctx.lineTo(x1, 0.34); ctx.closePath();
  };
  sketch(ctx, ear(0.17, 0.2, 0.24, 0.3), vc(v, 2), v + 6);
  sketch(ctx, ear(0.61, 0.58, 0.25, 0.48), vc(v, 2), v + 7);
  // control tower: stalk + goldfish-bowl top
  ctx.lineWidth = 0.05;
  wline(ctx, [[0.78, 0.6], [0.79, 0.32]], v + 8, 0.015); ctx.stroke();
  ctx.lineWidth = LINE / 1.45;
  sketch(ctx, () => blobPath(ctx, 0.79, 0.26, 0.1, 0.09, v + 9, 0.15, 6), "#aecbfa", v + 9);
  // windsock scribble
  ctx.lineWidth = 0.035;
  wline(ctx, [[0.06, 0.58], [0.06, 0.42], [0.2, 0.46], [0.06, 0.5]], v + 10, 0.015);
  ctx.stroke();
  ctx.restore();
}

function drawMonument(ctx, v) {
  ctx.save();
  ctx.translate(0.5, 0.5);
  ctx.scale(1.2, 1.2);
  ctx.translate(-0.5, -0.5);
  ctx.lineWidth = LINE / 1.2;
  const kind = ((v % 977) | 0) % 3;
  if (kind === 0) {
    // giant scratching post
    sketch(ctx, () => wrectPath(ctx, 0.2, 0.78, 0.6, 0.14, v, 0.03), "#e0cdb2", v);
    sketch(ctx, () => wrectPath(ctx, 0.42, 0.2, 0.16, 0.6, v + 1, 0.025), "#e8b98a", v + 1);
    ctx.lineWidth = 0.035;
    for (let k = 0; k < 4; k++) {
      wline(ctx, [[0.42, 0.28 + k * 0.13], [0.58, 0.24 + k * 0.13]], v + 2 + k, 0.012);
      ctx.stroke();
    }
    ctx.lineWidth = LINE / 1.2;
    sketch(ctx, () => blobPath(ctx, 0.5, 0.14, 0.16, 0.09, v + 8, 0.15, 6), "#f9c9d4", v + 8);
  } else if (kind === 1) {
    // cat obelisk
    const ob = () => {
      ctx.beginPath();
      ctx.moveTo(0.38 + jit(v, 1, 0.02), 0.85);
      ctx.lineTo(0.44 + jit(v, 2, 0.02), 0.18);
      ctx.lineTo(0.56 + jit(v, 3, 0.02), 0.18);
      ctx.lineTo(0.62 + jit(v, 4, 0.02), 0.85);
      ctx.closePath();
    };
    sketch(ctx, ob, "#d9d3c8", v);
    // ears on top + carved face
    sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(0.44, 0.2); ctx.lineTo(0.42, 0.08); ctx.lineTo(0.5, 0.16); ctx.closePath(); }, "#d9d3c8", v + 5);
    sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(0.56, 0.2); ctx.lineTo(0.58, 0.08); ctx.lineTo(0.5, 0.16); ctx.closePath(); }, "#d9d3c8", v + 6);
    ctx.fillStyle = PAL.ink;
    ctx.beginPath(); ctx.arc(0.47, 0.3, 0.018, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(0.53, 0.3, 0.018, 0, 7); ctx.fill();
    catMouth(ctx, 0.5, 0.34, 0.03, v);
    sketch(ctx, () => wrectPath(ctx, 0.3, 0.82, 0.4, 0.1, v + 7, 0.02), "#c8c2b6", v + 7);
  } else {
    // fountain of milk
    sketch(ctx, () => blobPath(ctx, 0.5, 0.72, 0.34, 0.16, v, 0.1, 8), "#fffef5", v);
    sketch(ctx, () => blobPath(ctx, 0.5, 0.52, 0.2, 0.1, v + 1, 0.12, 7), "#fffef5", v + 1);
    ctx.lineWidth = 0.04;
    wline(ctx, [[0.5, 0.5], [0.46 + jit(v, 9, 0.03), 0.3], [0.5, 0.22]], v + 2, 0.02);
    ctx.stroke();
    for (const [k, dx] of [[3, -0.12], [4, 0.12]]) {
      wline(ctx, [[0.5, 0.26], [0.5 + dx, 0.4 + jit(v, k, 0.03)]], v + k, 0.02);
      ctx.stroke();
    }
    ctx.lineWidth = LINE / 1.2;
  }
  ctx.restore();
}

// little plane that orbits each airport (drawn by main.js after all tiles)
function drawPlane(ctx, cx, cy, time, seed) {
  const a = time * 0.9 + (seed % 977);
  const px = cx + Math.cos(a) * 1.25, py = cy + Math.sin(a) * 0.95;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(a + Math.PI / 2 + Math.sin(time * 3 + seed) * 0.08);
  const v = (seed % 977) + boil(time);
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";
  sketch(ctx, () => blobPath(ctx, 0, 0, 0.22, 0.09, v, 0.12, 6), "#fffdf7", v);
  // wings + tail
  sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(-0.02, -0.04); ctx.lineTo(-0.1, -0.22); ctx.lineTo(0.06, -0.06); ctx.closePath(); }, "#aecbfa", v + 1);
  sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(-0.02, 0.04); ctx.lineTo(-0.1, 0.22); ctx.lineTo(0.06, 0.06); ctx.closePath(); }, "#aecbfa", v + 2);
  sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(-0.18, 0); ctx.lineTo(-0.28, -0.1); ctx.lineTo(-0.16, -0.02); ctx.closePath(); }, "#f9c9d4", v + 3);
  // pilot cat's window
  ctx.fillStyle = PAL.ink;
  ctx.beginPath(); ctx.arc(0.12, 0, 0.025, 0, 7); ctx.fill();
  ctx.restore();
}

// the train: an engine + cars with cat ears, driven along track paths by main.js
function drawTrain(ctx, x, y, angle, time, colorIdx, isEngine) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const v = colorIdx * 53 + (isEngine ? 0 : 31) + boil(time);
  const col = PAL.pastels[colorIdx % PAL.pastels.length];
  const L = isEngine ? 0.82 : 0.66, Hh = isEngine ? 0.46 : 0.4;
  ctx.lineWidth = 0.06;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";
  // wheels peeking under
  ctx.fillStyle = PAL.ink;
  for (const wx of [-L * 0.28, L * 0.28]) {
    ctx.beginPath(); ctx.arc(wx, Hh * 0.42, 0.07, 0, 7); ctx.fill();
  }
  // body
  sketch(ctx, () => wrectPath(ctx, -L / 2, -Hh / 2, L, Hh, v, 0.025), col, v);
  if (isEngine) {
    // ears + face on the front
    sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(L * 0.16, -Hh / 2); ctx.lineTo(L * 0.26, -Hh * 0.95); ctx.lineTo(L * 0.4, -Hh / 2); ctx.closePath(); }, col, v + 1);
    sketch(ctx, () => { ctx.beginPath(); ctx.moveTo(-L * 0.05, -Hh / 2); ctx.lineTo(L * 0.06, -Hh * 0.9); ctx.lineTo(L * 0.2, -Hh / 2); ctx.closePath(); }, col, v + 2);
    ctx.fillStyle = PAL.ink;
    ctx.beginPath(); ctx.arc(L * 0.18, -0.03, 0.028, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(L * 0.34, -0.02, 0.028, 0, 7); ctx.fill();
    catMouth(ctx, L * 0.26, 0.035, 0.035, v);
    // headlight
    ctx.fillStyle = PAL.gold;
    ctx.beginPath(); ctx.arc(L * 0.5, 0.02, 0.045, 0, 7); ctx.fill(); ctx.stroke();
  } else {
    // windows with passenger cats
    for (const wx of [-L * 0.2, L * 0.14]) {
      sketch(ctx, () => wrectPath(ctx, wx, -Hh * 0.28, 0.16, 0.18, v + 3, 0.015), PAL.bg, v + 3);
      ctx.fillStyle = PAL.ink;
      ctx.beginPath(); ctx.arc(wx + 0.08, -Hh * 0.1, 0.02, 0, 7); ctx.fill();
    }
  }
  ctx.restore();
}

// :3 mouth — two crooked little arcs
function catMouth(ctx, cx, cy, s, seed) {
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 0.024;
  ctx.beginPath();
  ctx.moveTo(cx - s + jit(seed, 75, 0.01), cy);
  ctx.quadraticCurveTo(cx - s / 2, cy + s + jit(seed, 76, 0.015), cx + jit(seed, 77, 0.008), cy);
  ctx.quadraticCurveTo(cx + s / 2, cy + s + jit(seed, 78, 0.015), cx + s + jit(seed, 79, 0.01), cy);
  ctx.stroke();
  ctx.lineWidth = LINE;
}

// --- cats -----------------------------------------------------------------

function drawCat(ctx, c, time) {
  const [x, y] = catXY(c);
  const v = (c.id % 977) + boil(time);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(jit(v, 1, 0.06));
  const s = 0.36;
  const wag = Math.sin(time * 6 + c.id) * 0.25;
  ctx.lineWidth = 0.065;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // squiggle tail
  wline(ctx, [
    [-s * 0.5, 0.05],
    [-s * 0.95, -0.05 + wag * 0.1],
    [-s * 0.85, -0.28 + wag * 0.14],
  ], v + 2, 0.03);
  ctx.stroke();
  // blobby body
  sketch(ctx, () => blobPath(ctx, 0, 0, s * 0.64, s * 0.5, v + 3, 0.14, 7), c.color, v + 3);
  // wonky ears (one taller)
  const tall = jit(v, 4, 0.1);
  const earPath = (sx, tx, ty) => () => {
    ctx.beginPath();
    ctx.moveTo(sx, -s * 0.28);
    ctx.lineTo(tx + jit(v, 5, 0.03), ty + tall);
    ctx.lineTo(sx * 0.25, -s * 0.5);
    ctx.closePath();
  };
  sketch(ctx, earPath(-s * 0.38, -s * 0.45, -s * 0.8), c.color, v + 6);
  sketch(ctx, earPath(s * 0.38, s * 0.45, -s * 0.72), c.color, v + 7);
  // uneven eyes + :3
  ctx.fillStyle = PAL.ink;
  ctx.beginPath(); ctx.arc(-s * 0.2, -s * 0.06, 0.032 + jit(v, 8, 0.008), 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(s * 0.21, -s * 0.04, 0.032 + jit(v, 9, 0.008), 0, 7); ctx.fill();
  catMouth(ctx, 0, s * 0.12, 0.06, v);
  ctx.restore();
}

// --- shared cursors ---------------------------------------------------------

function drawRemoteCursor(ctx, cur, scale) {
  ctx.save();
  ctx.translate(cur.x, cur.y);
  const s = 0.9 / scale * 24;
  ctx.scale(s / 24, s / 24);
  const v = boil(performance.now() / 1000) + 7;
  ctx.lineWidth = 0.075;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";
  const col = cur.color || "#f9c9d4";
  // scribbly paw
  sketch(ctx, () => blobPath(ctx, 0, 0.12, 0.29, 0.26, v, 0.15, 6), col, v);
  for (const [k, [dx, dy]] of [[1, [-0.24, -0.22]], [2, [0, -0.32]], [3, [0.24, -0.22]]]) {
    sketch(ctx, () => blobPath(ctx, dx, dy, 0.115, 0.11, v + k, 0.22, 5), col, v + k);
  }
  // name tag
  ctx.font = "0.42px 'Comic Sans MS', 'Chalkboard SE', system-ui";
  const name = cur.name || "cat";
  const w = ctx.measureText(name).width + 0.3;
  sketch(ctx, () => wrectPath(ctx, 0.35, 0.35, w, 0.62, v + 9, 0.04), col, v + 9);
  ctx.fillStyle = PAL.ink;
  ctx.fillText(name, 0.5, 0.8);
  ctx.restore();
}

export { PAL, drawTile, drawCat, drawRemoteCursor, drawPlane, drawTrain };
