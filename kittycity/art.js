// Kitty City — procedural art. Style: thick dark outlines, pastel fills,
// blobby rounded shapes on cream, like a cute sticker sheet.

import { T, W, H, idx, inB, catXY } from "./sim.js";

const PAL = {
  bg: "#fffdf7",
  grass: "#f4f9ee",
  ink: "#1a1a1a",
  road: "#e8e3da",
  roadEdge: "#1a1a1a",
  track: "#c9c2b8",
  pastels: ["#f9c9d4", "#aecbfa", "#c8e6c9", "#ffe0a3", "#e1d5f5", "#b9e8e0"],
  park: "#bfe3b4",
  leaf: "#8fce85",
  plaza: "#ffe9f0",
  gold: "#ffd97a",
};

const LINE = 0.09; // outline width in tile units

function vc(v, n) { return PAL.pastels[(v + n) % PAL.pastels.length]; }

// deterministic wobble from variant so shapes look hand-drawn but stable
function wob(v, k) { return (((v * 37 + k * 101) % 17) / 17 - 0.5) * 0.08; }

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- tiles --------------------------------------------------------------

function drawTile(ctx, state, x, y, time) {
  const i = idx(x, y);
  const t = state.grid[i];
  const v = state.variant[i];
  if (t === T.EMPTY) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = LINE;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";

  switch (t) {
    case T.ROAD: drawRoad(ctx, state, x, y); break;
    case T.RZONE: drawZonePlot(ctx, v, "#f9c9d4"); break;
    case T.WZONE: drawZonePlot(ctx, v, "#aecbfa"); break;
    case T.HOUSE: drawHouse(ctx, v); break;
    case T.WORK: drawWork(ctx, v); break;
    case T.PARK: drawPark(ctx, v, time); break;
    case T.TRACK: drawTrack(ctx, state, x, y); break;
    case T.STATION: drawStation(ctx, state, x, y, v); break;
    case T.PLAZA: drawPlaza(ctx, v); break;
    case T.STATUE: drawStatue(ctx, time); break;
  }
  ctx.restore();
}

function roadMask(state, x, y, kinds) {
  let m = 0;
  const dirs = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]];
  for (const [dx, dy, bit] of dirs) {
    if (inB(x + dx, y + dy) && kinds.includes(state.grid[idx(x + dx, y + dy)])) m |= bit;
  }
  return m;
}

function drawRoad(ctx, state, x, y) {
  const m = roadMask(state, x, y, [T.ROAD, T.STATION, T.PLAZA]);
  ctx.fillStyle = PAL.road;
  const w = 0.62, o = (1 - w) / 2;
  // core
  rr(ctx, o, o, w, w, 0.18);
  ctx.fill();
  // arms
  ctx.beginPath();
  if (m & 1) ctx.rect(o, -0.01, w, o + 0.06);
  if (m & 2) ctx.rect(1 - o - 0.05, o, o + 0.06, w);
  if (m & 4) ctx.rect(o, 1 - o - 0.05, w, o + 0.06);
  if (m & 8) ctx.rect(-0.01, o, o + 0.06, w);
  ctx.fill();
  // paw prints along road
  ctx.fillStyle = "#d4cec4";
  ctx.beginPath();
  ctx.arc(0.5, 0.5, 0.055, 0, 7);
  ctx.arc(0.41, 0.41, 0.03, 0, 7);
  ctx.arc(0.59, 0.41, 0.03, 0, 7);
  ctx.fill();
}

function drawZonePlot(ctx, v, color) {
  ctx.setLineDash([0.09, 0.07]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.06;
  rr(ctx, 0.12, 0.12, 0.76, 0.76, 0.2);
  ctx.stroke();
  ctx.setLineDash([]);
  // paw stamp
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(0.5, 0.55, 0.11, 0, 7);
  ctx.arc(0.38, 0.42, 0.055, 0, 7);
  ctx.arc(0.5, 0.37, 0.055, 0, 7);
  ctx.arc(0.62, 0.42, 0.055, 0, 7);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawHouse(ctx, v) {
  const c = vc(v, 0);
  const w1 = wob(v, 1), w2 = wob(v, 2);
  // body
  ctx.fillStyle = c;
  rr(ctx, 0.12 + w1, 0.3, 0.76, 0.6, 0.16);
  ctx.fill(); ctx.stroke();
  // roof = cat head with ears
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0.14 + w1, 0.42);
  ctx.lineTo(0.16 + w1, 0.14);   // left ear
  ctx.lineTo(0.34 + w1, 0.26);
  ctx.quadraticCurveTo(0.5, 0.18 + w2, 0.66 - w1, 0.26); // brow
  ctx.lineTo(0.84 - w1, 0.14);   // right ear
  ctx.lineTo(0.86 - w1, 0.42);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // face
  ctx.fillStyle = PAL.ink;
  ctx.beginPath();
  ctx.arc(0.38, 0.33, 0.028, 0, 7);
  ctx.arc(0.62, 0.33, 0.028, 0, 7);
  ctx.fill();
  drawW(ctx, 0.5, 0.375, 0.05);
  // door
  ctx.fillStyle = PAL.bg;
  rr(ctx, 0.42, 0.62, 0.16, 0.28, 0.08);
  ctx.fill(); ctx.stroke();
}

function drawWork(ctx, v) {
  const c = vc(v, 3);
  // factory body
  ctx.fillStyle = c;
  rr(ctx, 0.08, 0.34, 0.84, 0.56, 0.14);
  ctx.fill(); ctx.stroke();
  // sawtooth roof (rounded)
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(0.08, 0.4);
  ctx.quadraticCurveTo(0.14, 0.12, 0.36, 0.34);
  ctx.quadraticCurveTo(0.44, 0.12, 0.64, 0.34);
  ctx.quadraticCurveTo(0.72, 0.12, 0.92, 0.4);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // fish sign
  ctx.fillStyle = PAL.bg;
  rr(ctx, 0.3, 0.48, 0.4, 0.26, 0.1);
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 0.05;
  ctx.beginPath(); // little fish
  ctx.ellipse(0.47, 0.61, 0.09, 0.055, 0, 0, 7);
  ctx.moveTo(0.56, 0.61);
  ctx.lineTo(0.63, 0.55);
  ctx.lineTo(0.63, 0.67);
  ctx.closePath();
  ctx.stroke();
}

function drawPark(ctx, v, time) {
  ctx.fillStyle = PAL.park;
  rr(ctx, 0.06, 0.06, 0.88, 0.88, 0.3);
  ctx.fill(); ctx.stroke();
  const sway = Math.sin(time * 1.5 + v) * 0.02;
  // tree = blobby leaf pile
  ctx.fillStyle = PAL.leaf;
  ctx.beginPath();
  ctx.arc(0.5 + sway, 0.38, 0.17, 0, 7);
  ctx.arc(0.36 + sway, 0.48, 0.13, 0, 7);
  ctx.arc(0.64 + sway, 0.48, 0.13, 0, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#a5836a";
  rr(ctx, 0.465, 0.55, 0.07, 0.24, 0.03);
  ctx.fill(); ctx.stroke();
  // yarn ball
  ctx.fillStyle = "#f9c9d4";
  ctx.beginPath(); ctx.arc(0.72, 0.74, 0.09, 0, 7); ctx.fill(); ctx.stroke();
  ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0.72, 0.74, 0.05, 0.6, 3.6); ctx.stroke();
}

function drawTrack(ctx, state, x, y) {
  const m = roadMask(state, x, y, [T.TRACK, T.STATION]);
  ctx.strokeStyle = PAL.track;
  ctx.lineWidth = 0.3;
  ctx.lineCap = "round";
  ctx.beginPath();
  const arms = [[1, 0.5, 0], [2, 1, 0.5], [4, 0.5, 1], [8, 0, 0.5]];
  let any = false;
  for (const [bit, ax, ay] of arms) {
    if (m & bit) { ctx.moveTo(0.5, 0.5); ctx.lineTo(ax, ay); any = true; }
  }
  if (!any) { ctx.moveTo(0.25, 0.5); ctx.lineTo(0.75, 0.5); }
  ctx.stroke();
  // center line
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 0.045;
  ctx.stroke();
  ctx.lineCap = "butt";
}

function drawStation(ctx, state, x, y, v) {
  drawTrack(ctx, state, x, y);
  ctx.fillStyle = vc(v, 1);
  rr(ctx, 0.2, 0.2, 0.6, 0.6, 0.22);
  ctx.fill();
  ctx.lineWidth = LINE;
  ctx.strokeStyle = PAL.ink;
  ctx.stroke();
  // ears on the station roof too
  ctx.beginPath();
  ctx.moveTo(0.24, 0.24); ctx.lineTo(0.28, 0.1) ; ctx.lineTo(0.4, 0.2);
  ctx.moveTo(0.76, 0.24); ctx.lineTo(0.72, 0.1); ctx.lineTo(0.6, 0.2);
  ctx.fillStyle = vc(v, 1);
  ctx.fill(); ctx.stroke();
  // T for tram... make it a bell
  ctx.fillStyle = PAL.gold;
  ctx.beginPath(); ctx.arc(0.5, 0.5, 0.12, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = PAL.ink;
  ctx.beginPath(); ctx.arc(0.5, 0.56, 0.03, 0, 7); ctx.fill();
}

function drawPlaza(ctx, v) {
  ctx.fillStyle = PAL.plaza;
  rr(ctx, 0.04, 0.04, 0.92, 0.92, 0.2);
  ctx.fill(); ctx.stroke();
  // fountain
  ctx.fillStyle = "#aecbfa";
  ctx.beginPath(); ctx.arc(0.5, 0.5, 0.22, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = PAL.bg;
  ctx.beginPath(); ctx.arc(0.5, 0.5, 0.1, 0, 7); ctx.fill(); ctx.stroke();
  // sparkles
  ctx.fillStyle = PAL.ink;
  for (const [sx, sy] of [[0.2, 0.2], [0.8, 0.24], [0.24, 0.8], [0.78, 0.78]]) {
    ctx.beginPath(); ctx.arc(sx, sy, 0.02, 0, 7); ctx.fill();
  }
}

function drawStatue(ctx, time) {
  ctx.fillStyle = PAL.gold;
  rr(ctx, 0.16, 0.6, 0.68, 0.3, 0.1);
  ctx.fill(); ctx.stroke();
  const bob = Math.sin(time * 2) * 0.02;
  ctx.beginPath();
  ctx.arc(0.5, 0.38 + bob, 0.2, 0, 7);
  ctx.fill(); ctx.stroke();
  ctx.lineWidth = 0.035;
  ctx.beginPath();
  ctx.arc(0.5, 0.38 + bob, 0.13, 0.5, 3.5);
  ctx.arc(0.5, 0.38 + bob, 0.07, 3.8, 6.5);
  ctx.stroke();
  ctx.lineWidth = LINE;
}

function drawW(ctx, cx, cy, s) {
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 0.025;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy);
  ctx.quadraticCurveTo(cx - s / 2, cy + s, cx, cy);
  ctx.quadraticCurveTo(cx + s / 2, cy + s, cx + s, cy);
  ctx.stroke();
}

// --- cats ---------------------------------------------------------------

function drawCat(ctx, c, time) {
  const [x, y] = catXY(c);
  ctx.save();
  ctx.translate(x, y);
  const s = 0.36;
  const wag = Math.sin(time * 6 + c.id) * 0.25;
  ctx.lineWidth = 0.07;
  ctx.strokeStyle = PAL.ink;
  ctx.lineJoin = "round";
  // tail
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, 0.05);
  ctx.quadraticCurveTo(-s * 1.1, -0.1 + wag * 0.1, -s * 0.9, -0.25 + wag * 0.12);
  ctx.stroke();
  // body blob
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.62, s * 0.5, 0, 0, 7);
  ctx.fill(); ctx.stroke();
  // ears
  ctx.beginPath();
  ctx.moveTo(-s * 0.35, -s * 0.3); ctx.lineTo(-s * 0.42, -s * 0.75); ctx.lineTo(-s * 0.08, -s * 0.5);
  ctx.moveTo(s * 0.35, -s * 0.3);  ctx.lineTo(s * 0.42, -s * 0.75);  ctx.lineTo(s * 0.08, -s * 0.5);
  ctx.fillStyle = c.color;
  ctx.fill(); ctx.stroke();
  // eyes
  ctx.fillStyle = PAL.ink;
  ctx.beginPath();
  ctx.arc(-s * 0.2, -s * 0.05, 0.035, 0, 7);
  ctx.arc(s * 0.2, -s * 0.05, 0.035, 0, 7);
  ctx.fill();
  drawW(ctx, 0, s * 0.1, 0.06);
  ctx.restore();
}

// --- shared cursors ------------------------------------------------------

function drawRemoteCursor(ctx, cur, scale) {
  ctx.save();
  ctx.translate(cur.x, cur.y);
  const s = 0.9 / scale * 24; // roughly constant screen size
  ctx.scale(s / 24, s / 24);
  ctx.lineWidth = 0.08;
  ctx.strokeStyle = PAL.ink;
  // paw cursor
  ctx.fillStyle = cur.color || "#f9c9d4";
  ctx.beginPath();
  ctx.arc(0, 0.1, 0.28, 0, 7);
  ctx.fill(); ctx.stroke();
  for (const [dx, dy] of [[-0.22, -0.22], [0, -0.3], [0.22, -0.22]]) {
    ctx.beginPath(); ctx.arc(dx, dy, 0.11, 0, 7); ctx.fill(); ctx.stroke();
  }
  // name tag
  ctx.font = "0.42px system-ui";
  const name = cur.name || "cat";
  const w = ctx.measureText(name).width + 0.3;
  ctx.fillStyle = cur.color || "#f9c9d4";
  rr(ctx, 0.35, 0.35, w, 0.62, 0.2);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = PAL.ink;
  ctx.fillText(name, 0.5, 0.8);
  ctx.restore();
}

export { PAL, drawTile, drawCat, drawRemoteCursor, rr };
