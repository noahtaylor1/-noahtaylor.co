// Kitty City — main: rendering, input, UI, host/guest orchestration.

import {
  W, H, T, COST, TOOL_LEVEL, LEVELS, newState, idx, inB,
  applyBuild, applyDiffTiles, tickSim, animateCats,
  serialize, deserialize, computePower, computeCongestion,
} from "./sim.js";
import { PAL, drawTile, drawCat, drawRemoteCursor, drawPlane, drawTrain, drawUnpowered, drawCongestion } from "./art.js";
import { HostNet, GuestNet } from "./net.js";

const $ = s => document.querySelector(s);
const canvas = $("#game"), ctx = canvas.getContext("2d");

// ---------- app state ----------
let state = newState();
let isHost = false;
let net = null;               // HostNet or GuestNet
let me = { name: "cat", color: "#f9c9d4" };
let tool = "road";
let cam = { x: W / 2, y: H / 2, scale: 22 };
let remoteCursors = new Map(); // id -> {x,y,name,color,seen}
let painting = false, lastPaint = null, panning = false, panStart = null;
let mouse = { x: 0, y: 0, wx: 0, wy: 0 };
let toastTimer = null;
const SAVE_KEY = "kittycity-save-v1";
const TICK_MS = 2000;

// ---------- boot / start screen ----------
const params = new URLSearchParams(location.search);
const joinRoom = params.get("room");

function boot() {
  drawTitleCats($("#titleCats"));
  const saved = localStorage.getItem(SAVE_KEY);
  if (joinRoom) {
    $("#hostButtons").style.display = "none";
    $("#joinButtons").style.display = "";
  } else {
    if (saved) $("#btnContinue").style.display = "";
  }
  // restore identity
  try {
    const id = JSON.parse(localStorage.getItem("kittycity-id") || "null");
    if (id) { $("#nameInput").value = id.name; selectColor(id.color); }
  } catch {}

  $("#btnNew").onclick = () => startHost(newState());
  $("#btnContinue").onclick = () => {
    try { startHost(deserialize(localStorage.getItem(SAVE_KEY))); }
    catch { startHost(newState()); }
  };
  $("#btnJoin").onclick = () => startGuest(joinRoom);
  document.querySelectorAll(".swatch").forEach(el => {
    el.onclick = () => selectColor(el.dataset.c);
  });
}

function selectColor(c) {
  me.color = c;
  document.querySelectorAll(".swatch").forEach(el =>
    el.classList.toggle("sel", el.dataset.c === c));
}

function identity() {
  me.name = ($("#nameInput").value || "cat").slice(0, 14);
  localStorage.setItem("kittycity-id", JSON.stringify(me));
}

// ---------- host ----------
function startHost(initial) {
  identity();
  state = initial;
  isHost = true;
  net = new HostNet(onGuestOp, relayCursorLocal, showPeers);
  net.getStateJson = () => serialize(state);
  net.ready.then(roomId => {
    const link = location.origin + location.pathname + "?room=" + roomId;
    $("#shareLink").value = link;
    $("#shareBar").style.display = "";
    enterGame();
    setInterval(hostTick, TICK_MS);
    setInterval(() => localStorage.setItem(SAVE_KEY, serialize(state)), 15000);
    addEventListener("beforeunload", () => localStorage.setItem(SAVE_KEY, serialize(state)));
  }).catch(() => {
    enterGame();
    toast("Playing offline — multiplayer broker unreachable 😿");
  });
}

function hostTick() {
  const { grown, levelUp } = tickSim(state);
  if (grown.length) net.broadcast({ t: "tiles", changed: grown, fish: state.fish });
  net.broadcast({
    t: "econ", fish: state.fish, pop: state.pop, level: state.level,
    happiness: state.happiness, income: state.income, cats: state.cats,
    grads: state.grads, powerCap: state.powerCap, powerDemand: state.powerDemand,
  });
  if (levelUp) {
    net.broadcast({ t: "levelup", ...levelUp });
    onLevelUp(levelUp);
  }
  refreshHud();
}

function onGuestOp(d) {
  const res = applyBuild(state, d.tool, d.tiles);
  if (res) net.broadcast({ t: "tiles", changed: res.changed, fish: state.fish });
  refreshHud();
}

function relayCursorLocal(msg) { noteCursor(msg); }

// ---------- guest ----------
function startGuest(roomId) {
  identity();
  isHost = false;
  net = new GuestNet(roomId, { name: me.name, color: me.color }, {
    onOpen: () => enterGame(),
    onState: d => { state = deserialize(d.json); refreshHud(); },
    onTiles: d => { applyDiffTiles(state, d.changed); state.fish = d.fish; refreshHud(); },
    onEcon: d => {
      state.fish = d.fish; state.pop = d.pop; state.level = d.level;
      state.happiness = d.happiness; state.income = d.income; state.cats = d.cats;
      state.grads = d.grads; state.powerCap = d.powerCap; state.powerDemand = d.powerDemand;
      refreshHud();
    },
    onLevelup: d => onLevelUp(d),
    onCursor: d => noteCursor(d),
    onPeers: d => showPeers(d.names),
    onClosed: () => overlayMsg("Host napped 💤", "The city lives in your partner's tab — ask them to reopen it, then rejoin."),
    onNoRoom: () => overlayMsg("No city here 🐾", "That room isn't open right now. Ask your partner to start the city, then use their fresh link."),
  });
}

function overlayMsg(title, body) {
  $("#msgTitle").textContent = title;
  $("#msgBody").textContent = body;
  $("#msgOverlay").style.display = "flex";
}

// ---------- shared ----------
function enterGame() {
  $("#startOverlay").style.display = "none";
  $("#hud").style.display = "";
  $("#toolbar").style.display = "";
  buildToolbar();
  refreshHud();
  requestAnimationFrame(frame);
}

function noteCursor(d) {
  if (d.id === myCursorId()) return;
  remoteCursors.set(d.id, { ...d, seen: performance.now() });
}
function myCursorId() { return isHost ? "host" : net?.peer?.id; }

function showPeers(names) {
  $("#peers").textContent = names.length ? "🐱 " + names.join(", ") : "";
}

function onLevelUp(l) {
  toast(`⭐ Level up: ${l.name}! ${l.unlock || ""} +${l.bonus} fish`);
  buildToolbar();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 4200);
}

// ---------- toolbar / hud ----------
const TOOLS = [
  ["hand", "✋", "Pan"],
  ["road", "🛣", "Road"],
  ["avenue", "🚗", "Avenue"],
  ["bike", "🚲", "Bikes"],
  ["rzone", "🏠", "Homes"],
  ["wzone", "🐟", "Market"],
  ["mill", "🧶", "Mill"],
  ["cafe", "☕", "Cafe"],
  ["lab", "🧪", "Lab"],
  ["solar", "☀️", "Solar"],
  ["oilplant", "🏭", "Oil"],
  ["school", "🎓", "School"],
  ["park", "🌳", "Park"],
  ["track", "🚃", "Rails"],
  ["station", "🔔", "Stop"],
  ["plaza", "⛲", "Plaza"],
  ["airport", "✈️", "Airport"],
  ["monument", "🗿", "Monument"],
  ["statue", "🏆", "Statue"],
  ["bulldoze", "💥", "Clear"],
];

function buildToolbar() {
  const bar = $("#toolbar");
  bar.innerHTML = "";
  for (const [id, icon, label] of TOOLS) {
    const locked = state.level < (TOOL_LEVEL[id] ?? 0);
    const b = document.createElement("button");
    b.className = "tool" + (tool === id ? " sel" : "") + (locked ? " locked" : "");
    const cost = COST[id] ? `<span class="cost">${COST[id]}🐟</span>` : "";
    b.innerHTML = locked
      ? `<span class="ticon">🔒</span><span class="tlabel">${LEVELS[TOOL_LEVEL[id]].pop} cats</span>`
      : `<span class="ticon">${icon}</span><span class="tlabel">${label}</span>${cost}`;
    if (!locked) b.onclick = () => { tool = id; buildToolbar(); };
    bar.appendChild(b);
  }
}

let _lastLevelSeen = -1;
function refreshHud() {
  if (state.level !== _lastLevelSeen) {
    _lastLevelSeen = state.level;
    buildToolbar(); // unlocks reflect current level even when joining mid-game
  }
  $("#fish").textContent = Math.floor(state.fish);
  $("#pop").textContent = state.pop;
  $("#income").textContent = "+" + (state.income || 0);
  const lvl = LEVELS[state.level];
  const next = LEVELS[state.level + 1];
  $("#levelName").textContent = lvl.name;
  if (next) {
    const prev = lvl.pop;
    const frac = Math.min(1, (state.pop - prev) / (next.pop - prev));
    $("#levelFill").style.width = (frac * 100).toFixed(0) + "%";
    $("#levelNext").textContent = `${state.pop}/${next.pop}`;
  } else {
    $("#levelFill").style.width = "100%";
    $("#levelNext").textContent = "MAX";
  }
  const h = state.happiness ?? 1;
  $("#mood").textContent = (h > 0.85 ? "😻" : h > 0.6 ? "😺" : h > 0.4 ? "😾" : "🙀")
    + " " + Math.round(h * 100) + "%";
  // power chip: green when capacity covers demand, red in brownout
  const cap = state.powerCap ?? 0, dem = state.powerDemand ?? 0;
  const pw = $("#power");
  if (pw) {
    pw.textContent = "⚡ " + dem + "/" + cap;
    pw.style.color = dem > cap ? "#c0392b" : "#1a1a1a";
  }
  const gr = $("#grads");
  if (gr) gr.textContent = "🎓 " + (state.grads ?? 0);
}

$("#copyLink") && ($("#copyLink").onclick = async () => {
  await navigator.clipboard.writeText($("#shareLink").value).catch(() => {});
  $("#shareLink").select();
  document.execCommand && document.execCommand("copy");
  toast("Link copied! Send it to your co-mayor 💌");
});

// ---------- input ----------
function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
}
addEventListener("resize", resize);
resize();

function screenToWorld(sx, sy) {
  return [
    (sx - innerWidth / 2) / cam.scale + cam.x,
    (sy - innerHeight / 2) / cam.scale + cam.y,
  ];
}

canvas.addEventListener("pointerdown", e => {
  canvas.setPointerCapture(e.pointerId);
  const pan = tool === "hand" || e.button === 1 || e.button === 2 || e.shiftKey;
  if (pan) {
    panning = true;
    panStart = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
  } else if (e.button === 0) {
    painting = true;
    lastPaint = null;
    paintAt(e.clientX, e.clientY);
  }
});
canvas.addEventListener("pointermove", e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  [mouse.wx, mouse.wy] = screenToWorld(e.clientX, e.clientY);
  sendCursorThrottled();
  if (panning && panStart) {
    cam.x = panStart.cx - (e.clientX - panStart.sx) / cam.scale;
    cam.y = panStart.cy - (e.clientY - panStart.sy) / cam.scale;
  } else if (painting) {
    paintAt(e.clientX, e.clientY);
  }
});
addEventListener("pointerup", () => { painting = false; panning = false; lastPaint = null; });
canvas.addEventListener("contextmenu", e => e.preventDefault());

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const [wx0, wy0] = screenToWorld(e.clientX, e.clientY);
  cam.scale = Math.max(9, Math.min(52, cam.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
  const [wx1, wy1] = screenToWorld(e.clientX, e.clientY);
  cam.x += wx0 - wx1; cam.y += wy0 - wy1;
}, { passive: false });

// pinch zoom
let pinch = null;
canvas.addEventListener("touchstart", e => {
  if (e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    pinch = { d, scale: cam.scale };
  }
}, { passive: true });
canvas.addEventListener("touchmove", e => {
  if (pinch && e.touches.length === 2) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    cam.scale = Math.max(9, Math.min(52, pinch.scale * d / pinch.d));
  }
}, { passive: true });
canvas.addEventListener("touchend", () => (pinch = null));

function paintAt(sx, sy) {
  const [wx, wy] = screenToWorld(sx, sy);
  const x = Math.floor(wx), y = Math.floor(wy);
  if (!inB(x, y)) return;
  if (lastPaint && lastPaint[0] === x && lastPaint[1] === y) return;
  // Bresenham from lastPaint for smooth drag lines
  const tiles = [];
  if (lastPaint) {
    let [x0, y0] = lastPaint;
    const dx = Math.abs(x - x0), dy = Math.abs(y - y0);
    const sxx = x0 < x ? 1 : -1, syy = y0 < y ? 1 : -1;
    let err = dx - dy;
    while (x0 !== x || y0 !== y) {
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sxx; }
      if (e2 < dx) { err += dx; y0 += syy; }
      tiles.push([x0, y0]);
    }
  } else tiles.push([x, y]);
  lastPaint = [x, y];

  if (isHost) {
    const res = applyBuild(state, tool, tiles);
    if (res) {
      net?.broadcast({ t: "tiles", changed: res.changed, fish: state.fish });
      refreshHud();
    }
  } else {
    net?.send({ t: "op", tool, tiles });
  }
}

let lastCursorSend = 0;
function sendCursorThrottled() {
  const now = performance.now();
  if (now - lastCursorSend < 45) return;
  lastCursorSend = now;
  if (isHost) net?.sendCursor(mouse.wx, mouse.wy, me.name, me.color);
  else net?.send({ t: "cursor", x: mouse.wx, y: mouse.wy });
}

// ---------- trains ----------
// Each contiguous track group gets a train shuttling end to end. Paths are
// rebuilt from the grid once a second (tracks change rarely; the walk is
// cheap). Purely decorative, so host and guest each animate locally.
let trainPaths = [], trainPathsBuilt = 0;

function buildTrainPaths() {
  const seen = new Uint8Array(W * H);
  const isTrack = i => state.grid[i] === T.TRACK || state.grid[i] === T.STATION;
  const paths = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i0 = y * W + x;
    if (!isTrack(i0) || seen[i0]) continue;
    // flood the group
    const group = [];
    const stack = [i0];
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop();
      group.push(i);
      const gx = i % W, gy = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx, ny = gy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
          const ni = ny * W + nx;
          if (isTrack(ni) && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        }
      }
    }
    if (group.length < 4) continue;
    // walk from an endpoint (degree 1) if one exists, else anywhere
    const deg = i => {
      const gx = i % W, gy = (i / W) | 0;
      let d = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx, ny = gy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && isTrack(ny * W + nx)) d++;
      }
      return d;
    };
    let start = group.find(i => deg(i) === 1) ?? group[0];
    const path = [];
    const used = new Set();
    let cur = start;
    while (cur !== undefined && !used.has(cur)) {
      used.add(cur);
      path.push([cur % W, (cur / W) | 0]);
      const gx = cur % W, gy = (cur / W) | 0;
      cur = undefined;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx, ny = gy + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
          const ni = ny * W + nx;
          if (isTrack(ni) && !used.has(ni)) { cur = ni; break; }
        }
      }
    }
    if (path.length >= 4) paths.push(path);
  }
  return paths;
}

function trainPose(path, sTiles) {
  const f = Math.max(0, Math.min(path.length - 1.001, sTiles));
  const i = f | 0, t = f - i;
  const [x0, y0] = path[i], [x1, y1] = path[i + 1];
  return {
    x: x0 + (x1 - x0) * t + 0.5,
    y: y0 + (y1 - y0) * t + 0.5,
    angle: Math.atan2(y1 - y0, x1 - x0),
  };
}

function drawTrains(time) {
  if (time - trainPathsBuilt > 1) {
    trainPaths = buildTrainPaths();
    trainPathsBuilt = time;
  }
  const SPEED = 2.2; // tiles/sec
  for (let g = 0; g < trainPaths.length; g++) {
    const path = trainPaths[g];
    const span = path.length - 1;
    // ping-pong along the line, each train offset in phase
    const cyc = (time * SPEED + g * 3.7) % (span * 2);
    const head = cyc <= span ? cyc : span * 2 - cyc;
    const dir = cyc <= span ? 1 : -1;
    const engine = trainPose(path, head);
    if (dir < 0) engine.angle += Math.PI;
    drawTrain(ctx, engine.x, engine.y, engine.angle, time, g, true);
    const car = trainPose(path, head - dir * 0.9);
    if (dir < 0) car.angle += Math.PI;
    drawTrain(ctx, car.x, car.y, car.angle, time, g, false);
  }
}

// ---------- render ----------
let lastT = performance.now();
let _infraPower = null, _infraCong = null, _infraBuilt = -9;
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  animateCats(state, dt);
  const time = now / 1000;

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  ctx.translate(innerWidth / 2, innerHeight / 2);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-cam.x, -cam.y);

  // world plate
  ctx.fillStyle = PAL.grass;
  ctx.beginPath();
  const m = 0.4;
  ctx.roundRect(-m, -m, W + 2 * m, H + 2 * m, 1.2);
  ctx.fill();
  ctx.lineWidth = 0.14;
  ctx.strokeStyle = PAL.ink;
  ctx.stroke();

  // faint grid
  ctx.strokeStyle = "rgba(0,0,0,0.045)";
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  for (let x = 0; x <= W; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y <= H; y++) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  // visible tile range
  const [wx0, wy0] = screenToWorld(0, 0);
  const [wx1, wy1] = screenToWorld(innerWidth, innerHeight);
  const x0 = Math.max(0, Math.floor(wx0) - 1), x1 = Math.min(W - 1, Math.ceil(wx1));
  const y0 = Math.max(0, Math.floor(wy0) - 1), y1 = Math.min(H - 1, Math.ceil(wy1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawTile(ctx, state, x, y, time);

  // infrastructure overlays: derived locally from synced grid+cats, so host
  // and guests see the same warnings without extra network traffic
  if (time - _infraBuilt > 1) {
    _infraPower = computePower(state);
    _infraCong = computeCongestion(state);
    _infraBuilt = time;
  }
  if (_infraPower) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = idx(x, y);
      if (_infraPower.unpowered[i]) drawUnpowered(ctx, x, y, time);
      if (_infraCong[i] > 1) drawCongestion(ctx, x, y, _infraCong[i] - 1, time);
    }
  }

  // trains on the rails
  drawTrains(time);

  // planes circling airports (drawn above neighboring tiles)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (state.grid[idx(x, y)] === T.AIRPORT) {
      drawPlane(ctx, x + 0.5, y + 0.5, time, state.variant[idx(x, y)]);
    }
  }

  // cats
  for (const c of state.cats) drawCat(ctx, c, time);

  // hover highlight
  const hx = Math.floor(mouse.wx), hy = Math.floor(mouse.wy);
  if (inB(hx, hy) && tool !== "hand") {
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.setLineDash([0.12, 0.08]);
    ctx.lineWidth = 0.06;
    ctx.strokeRect(hx + 0.05, hy + 0.05, 0.9, 0.9);
    ctx.setLineDash([]);
  }

  // remote cursors (fade after 4s)
  const nowMs = performance.now();
  for (const [id, cur] of remoteCursors) {
    if (nowMs - cur.seen > 4000) { remoteCursors.delete(id); continue; }
    drawRemoteCursor(ctx, cur, cam.scale);
  }

  requestAnimationFrame(frame);
}

// ---------- title art (three hugging cats, like the sample) ----------
function drawTitleCats(cv) {
  if (!cv) return;
  const c = cv.getContext("2d");
  const s = cv.width / 300;
  c.scale(s, s);
  c.lineWidth = 7;
  c.strokeStyle = "#1a1a1a";
  c.lineJoin = "round";
  const cat = (x, y, w, h, color, earL, earR) => {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x - w / 2, y + h / 2);
    c.quadraticCurveTo(x - w / 2 - 8, y - h / 2, x + earL[0], y + earL[1]);
    c.lineTo(x + earL[2], y + earL[3]);
    c.quadraticCurveTo(x, y - h / 2 - 6, x + earR[2], y + earR[3]);
    c.lineTo(x + earR[0], y + earR[1]);
    c.quadraticCurveTo(x + w / 2 + 8, y - h / 2, x + w / 2, y + h / 2);
    c.closePath();
    c.fill(); c.stroke();
  };
  cat(75, 78, 95, 90, "#aecbfa", [-42, -55, -18, -38], [42, -55, 18, -38]);
  cat(225, 78, 95, 90, "#f9c9d4", [-42, -55, -18, -38], [42, -55, 18, -38]);
  cat(150, 88, 88, 80, "#b9bdc4", [-38, -52, -15, -35], [38, -52, 15, -35]);
  // gray cat face
  c.fillStyle = "#1a1a1a";
  const eye = (ex, ey) => {
    c.fillStyle = "#f5a623"; c.beginPath(); c.arc(ex, ey, 11, 0, 7); c.fill(); c.stroke();
    c.fillStyle = "#1a1a1a"; c.beginPath(); c.arc(ex, ey, 5, 0, 7); c.fill();
    c.fillStyle = "#fff"; c.beginPath(); c.arc(ex - 2, ey - 3, 2.5, 0, 7); c.fill();
  };
  eye(128, 82); eye(172, 82);
  c.strokeStyle = "#1a1a1a"; c.lineWidth = 4;
  c.beginPath(); c.moveTo(146, 96); c.lineTo(150, 100); c.lineTo(154, 96); c.stroke();
  // hugging arms
  c.lineWidth = 7;
  const arm = (x0, y0, x1, y1, color) => {
    c.strokeStyle = "#1a1a1a";
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x0, y0);
    c.quadraticCurveTo((x0 + x1) / 2, y0 + 25, x1, y1);
    c.lineTo(x1, y1 + 16);
    c.quadraticCurveTo((x0 + x1) / 2, y0 + 42, x0, y0 + 18);
    c.closePath();
    c.fill(); c.stroke();
  };
  arm(95, 95, 138, 118, "#aecbfa");
  arm(205, 95, 162, 118, "#f9c9d4");
}

boot();

// console/debug hook (also handy for future troubleshooting)
window.__kc = {
  get state() { return state; },
  get cursors() { return [...remoteCursors.values()]; },
  build(t, tiles) {
    if (isHost) {
      const res = applyBuild(state, t, tiles);
      if (res) { net?.broadcast({ t: "tiles", changed: res.changed, fish: state.fish }); refreshHud(); }
      return !!res;
    }
    net?.send({ t: "op", tool: t, tiles });
    return true;
  },
  gridCount(type) { return state.grid.reduce((n, v) => n + (v === type ? 1 : 0), 0); },
};
