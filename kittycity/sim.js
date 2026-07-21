// Kitty City — simulation core (no DOM). Host-authoritative: only the host
// runs tickSim; guests receive diffs and render.

const W = 64, H = 64;

// tile types
const T = {
  EMPTY: 0, ROAD: 1,
  RZONE: 2, HOUSE: 3,     // residential zone -> grows into house
  WZONE: 4, WORK: 5,      // work zone -> grows into workplace
  PARK: 6,
  TRACK: 7, STATION: 8,   // tram/train
  PLAZA: 9, STATUE: 10,
  AVENUE: 11,             // wide fast road
  BIKE: 12,               // bike path
  AIRPORT: 13, MONUMENT: 14,
  MILL: 15,               // yarn mill: industry jobs, better pay
  CAFE: 16,               // cat cafe: service jobs + happiness aura
  LAB: 17,                // catnip lab: top pay, educated cats only
  SOLAR: 18,              // sunny spot solar: small clean power
  OILPLANT: 19,           // fish-oil generator: big power, pollutes
  SCHOOL: 20,             // scratch school: educates cats
};

const COST = { road: 5, avenue: 12, bike: 3, rzone: 10, wzone: 15, park: 20, track: 12, station: 40, plaza: 40, airport: 400, monument: 150, statue: 500, mill: 60, cafe: 80, lab: 200, solar: 120, oilplant: 250, school: 180, bulldoze: 1 };

const TOOL_TILE = { road: T.ROAD, avenue: T.AVENUE, bike: T.BIKE, rzone: T.RZONE, wzone: T.WZONE, park: T.PARK, track: T.TRACK, station: T.STATION, plaza: T.PLAZA, airport: T.AIRPORT, monument: T.MONUMENT, statue: T.STATUE, mill: T.MILL, cafe: T.CAFE, lab: T.LAB, solar: T.SOLAR, oilplant: T.OILPLANT, school: T.SCHOOL };

const LEVELS = [
  { pop: 0,   name: "Kitten Corner",   bonus: 0 },
  { pop: 10,  name: "Pawville",        bonus: 100, unlock: "Parks, avenues, bikes & solar power unlocked!" },
  { pop: 25,  name: "Whisker Heights", bonus: 200, unlock: "Trains, schools & yarn mills unlocked!" },
  { pop: 50,  name: "Purropolis",      bonus: 400, unlock: "Plazas, airports, monuments, cafes & the fish-oil plant unlocked!" },
  { pop: 100, name: "Meowtropolis",    bonus: 800, unlock: "Golden Yarn Statue & Catnip Lab unlocked!" },
];
// tool -> level index required
const TOOL_LEVEL = { road: 0, rzone: 0, wzone: 0, bulldoze: 0, hand: 0, park: 1, avenue: 1, bike: 1, solar: 1, track: 2, station: 2, school: 2, mill: 2, plaza: 3, airport: 3, monument: 3, cafe: 3, oilplant: 3, statue: 4, lab: 4 };

// --- power / jobs / school constants ---
const POWER_CAP = { [T.SOLAR]: 8, [T.OILPLANT]: 30 };
const POWER_DEMAND = {
  [T.HOUSE]: 1, [T.WORK]: 2, [T.MILL]: 3, [T.CAFE]: 2, [T.LAB]: 4,
  [T.SCHOOL]: 3, [T.STATION]: 1, [T.AIRPORT]: 5,
};
const JOB_CAP = { [T.WORK]: 3, [T.MILL]: 4, [T.CAFE]: 3, [T.LAB]: 3 };
const JOB_PAY = { [T.WORK]: 2, [T.MILL]: 3, [T.CAFE]: 3, [T.LAB]: 5 };
const EDU_ONLY = { [T.LAB]: true };
const UPKEEP = { [T.SOLAR]: 1, [T.OILPLANT]: 3, [T.SCHOOL]: 2 };
const SCHOOL_SEATS = 12;       // grads each school can produce
const GRADS_PER_TICK = 2;      // per school with capacity left
const POLLUTION_R = 4;         // fish-oil stink radius
const CONGESTION_CAP = { [T.ROAD]: 6, [T.AVENUE]: 16, [T.BIKE]: 10, [T.STATION]: 12, [T.PLAZA]: 20 };

const HOUSE_CAP = 2, WORK_CAP = 3, MAX_CATS = 150;
const CAT_COLORS = ["#aecbfa", "#f9c9d4", "#b9bdc4", "#c8e6c9", "#ffe0a3", "#e1d5f5"];

function newState() {
  return {
    grid: new Uint8Array(W * H),
    variant: new Uint8Array(W * H).map(() => (Math.random() * 250) | 0),
    growth: new Uint8Array(W * H),
    fish: 400,
    pop: 0,
    level: 0,
    tick: 0,
    cats: [],          // {id,hx,hy,wx,wy,color,path:[[x,y]..],p:0..1,speed}
    happiness: 1,
    income: 0,
  };
}

const idx = (x, y) => y * W + x;
const inB = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function levelFor(pop) {
  let l = 0;
  for (let i = 0; i < LEVELS.length; i++) if (pop >= LEVELS[i].pop) l = i;
  return l;
}

// --- building ---------------------------------------------------------

function canPlace(state, tool, x, y) {
  if (!inB(x, y)) return false;
  const t = state.grid[idx(x, y)];
  if (tool === "bulldoze") return t !== T.EMPTY;
  if (tool === "station") return t === T.TRACK; // stations upgrade track
  return t === T.EMPTY;
}

// Applies a build op. Returns {changed:[{x,y,t,v}], spent} or null if rejected.
// Free=true for applying remote-authoritative diffs (no cost check).
function applyBuild(state, tool, tiles) {
  const cost = COST[tool] ?? 0;
  const changed = [];
  let spent = 0;
  for (const [x, y] of tiles) {
    if (!canPlace(state, tool, x, y)) continue;
    if (state.fish - spent < cost) break;
    const i = idx(x, y);
    if (tool === "bulldoze") {
      removeCatsAt(state, x, y);
      state.grid[i] = T.EMPTY;
      state.growth[i] = 0;
    } else {
      state.grid[i] = TOOL_TILE[tool];
      state.growth[i] = 0;
      state.variant[i] = (Math.random() * 250) | 0;
    }
    spent += cost;
    changed.push({ x, y, t: state.grid[i], v: state.variant[i], g: 0 });
  }
  if (!changed.length) return null;
  state.fish -= spent;
  return { changed, spent };
}

function applyDiffTiles(state, changed) {
  for (const c of changed) {
    const i = idx(c.x, c.y);
    state.grid[i] = c.t;
    state.variant[i] = c.v;
    state.growth[i] = c.g;
  }
}

function removeCatsAt(state, x, y) {
  state.cats = state.cats.filter(c => !((c.hx === x && c.hy === y) || (c.wx === x && c.wy === y)));
  state.pop = state.cats.length;
}

// --- network / pathfinding --------------------------------------------
// Walk network: roads (cost 1) + station-to-station along contiguous track
// (cost 0.35/tile). Houses/works connect via 4-adjacency to roads.

// --- derived infrastructure state (deterministic from grid+cats, so host
// and guests each compute it locally -- nothing extra crosses the wire) ---

function computePower(state) {
  let cap = 0, demand = 0;
  const needs = []; // tile indices that draw power, in scan order
  for (let i = 0; i < W * H; i++) {
    const t = state.grid[i];
    if (POWER_CAP[t]) cap += POWER_CAP[t];
    if (POWER_DEMAND[t]) { demand += POWER_DEMAND[t]; needs.push(i); }
  }
  const unpowered = new Uint8Array(W * H);
  if (demand > cap) {
    // brownout: allocate in scan order until the budget runs out
    let budget = cap;
    for (const i of needs) {
      const d = POWER_DEMAND[state.grid[i]];
      if (budget >= d) budget -= d;
      else unpowered[i] = 1;
    }
  }
  return { cap, demand, unpowered };
}

function computeCongestion(state) {
  const usage = new Float32Array(W * H);
  for (const c of state.cats) {
    if (!c.path) continue;
    for (let k = 1; k < c.path.length - 1; k++) {
      usage[idx(c.path[k][0], c.path[k][1])]++;
    }
  }
  // convert to load factor vs capacity (0..n, >1 = congested)
  for (let i = 0; i < W * H; i++) {
    if (usage[i] > 0) {
      const cap = CONGESTION_CAP[state.grid[i]] || 99;
      usage[i] = usage[i] / cap;
    }
  }
  return usage;
}

const JOB_TYPES = [T.WORK, T.MILL, T.CAFE, T.LAB];

function buildDistanceField(state) {
  // multi-source BFS (Dijkstra-lite with small costs) from all job tiles
  const dist = new Float32Array(W * H).fill(Infinity);
  const q = []; // [cost, x, y]
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (JOB_TYPES.includes(state.grid[idx(x, y)])) {
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (inB(nx, ny) && walkable(state, nx, ny) && dist[idx(nx, ny)] > 0) {
          dist[idx(nx, ny)] = 0;
          q.push([0, nx, ny]);
        }
      }
    }
  }
  // station adjacency: precompute contiguous track groups
  const stations = stationGroups(state);
  while (q.length) {
    q.sort((a, b) => a[0] - b[0]); // small frontier; fine at this scale
    const [d, x, y] = q.shift();
    const i = idx(x, y);
    if (d > dist[i]) continue;
    const push = (nx, ny, nd) => {
      if (inB(nx, ny) && walkable(state, nx, ny) && nd < dist[idx(nx, ny)]) {
        dist[idx(nx, ny)] = nd;
        q.push([nd, nx, ny]);
      }
    };
    for (const [dx, dy] of N4) {
      if (inB(x + dx, y + dy) && walkable(state, x + dx, y + dy)) {
        push(x + dx, y + dy, d + stepCost(state, x + dx, y + dy));
      }
    }
    if (state.grid[i] === T.STATION) {
      for (const [sx, sy, hops] of stations.linked(x, y)) push(sx, sy, d + hops * 0.35);
    }
  }
  return dist;
}

function walkable(state, x, y) {
  const t = state.grid[idx(x, y)];
  return t === T.ROAD || t === T.AVENUE || t === T.BIKE || t === T.STATION || t === T.PLAZA;
}

// per-tile commute cost: avenues are fast, bikes zippy, roads normal
function stepCost(state, x, y) {
  const t = state.grid[idx(x, y)];
  if (t === T.AVENUE) return 0.55;
  if (t === T.BIKE) return 0.7;
  return 1;
}

// groups of contiguous track (+stations); returns station->other stations in
// same group with hop counts (track distance approx by BFS on track tiles)
function stationGroups(state) {
  const gid = new Int16Array(W * H).fill(-1);
  const groups = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t0 = state.grid[idx(x, y)];
    if ((t0 === T.TRACK || t0 === T.STATION) && gid[idx(x, y)] < 0) {
      const g = groups.length, members = [], st = [];
      const stack = [[x, y]];
      gid[idx(x, y)] = g;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        members.push([cx, cy]);
        if (state.grid[idx(cx, cy)] === T.STATION) st.push([cx, cy]);
        for (const [dx, dy] of N4) {
          const nx = cx + dx, ny = cy + dy;
          if (inB(nx, ny) && gid[idx(nx, ny)] < 0) {
            const tt = state.grid[idx(nx, ny)];
            if (tt === T.TRACK || tt === T.STATION) {
              gid[idx(nx, ny)] = g;
              stack.push([nx, ny]);
            }
          }
        }
      }
      groups.push({ members, stations: st });
    }
  }
  return {
    linked(x, y) {
      const g = gid[idx(x, y)];
      if (g < 0) return [];
      const out = [];
      for (const [sx, sy] of groups[g].stations) {
        if (sx === x && sy === y) continue;
        const hops = Math.abs(sx - x) + Math.abs(sy - y); // manhattan approx
        out.push([sx, sy, hops]);
      }
      return out;
    },
    trackGroups: groups,
  };
}

// simple BFS path on walk network from house door to its workplace (for cat
// animation); returns list of [x,y] or null
function findPath(state, hx, hy, wx, wy) {
  const starts = [], goals = new Set();
  for (const [dx, dy] of N4) {
    if (inB(hx + dx, hy + dy) && walkable(state, hx + dx, hy + dy)) starts.push([hx + dx, hy + dy]);
    if (inB(wx + dx, wy + dy) && walkable(state, wx + dx, wy + dy)) goals.add(idx(wx + dx, wy + dy));
  }
  if (!starts.length || !goals.size) return null;
  const prev = new Int32Array(W * H).fill(-2);
  const q = [];
  for (const [sx, sy] of starts) { prev[idx(sx, sy)] = -1; q.push(idx(sx, sy)); }
  let found = -1;
  for (let qi = 0; qi < q.length && found < 0; qi++) {
    const i = q[qi];
    if (goals.has(i)) { found = i; break; }
    const x = i % W, y = (i / W) | 0;
    const tryN = (nx, ny) => {
      if (inB(nx, ny) && prev[idx(nx, ny)] === -2 && walkable(state, nx, ny)) {
        prev[idx(nx, ny)] = i;
        q.push(idx(nx, ny));
      }
    };
    for (const [dx, dy] of N4) tryN(x + dx, y + dy);
    if (state.grid[i] === T.STATION) {
      // hop between stations of the same group
      for (const [sx, sy] of stationGroupsCache(state).linked(x, y)) tryN(sx, sy);
    }
  }
  if (found < 0) return null;
  const path = [];
  let cur = found;
  while (cur !== -1) { path.push([cur % W, (cur / W) | 0]); cur = prev[cur]; }
  path.reverse();
  path.unshift([hx, hy]);
  path.push([wx, wy]);
  return path;
}

let _sgCache = null, _sgTick = -1;
function stationGroupsCache(state) {
  if (_sgTick !== state.tick || !_sgCache) { _sgCache = stationGroups(state); _sgTick = state.tick; }
  return _sgCache;
}

// --- simulation tick ---------------------------------------------------

const _unhappyStreak = new Map(); // house idx -> consecutive very-unhappy ticks (host-side)

function tickSim(state) {
  state.tick++;
  _sgCache = null;
  const events = [];

  // zone growth (needs road/avenue adjacency) + building census
  let airports = 0, schools = 0, upkeep = 0;
  const oilPlants = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    const t = state.grid[i];
    if (t === T.AIRPORT) airports++;
    if (t === T.SCHOOL) schools++;
    if (t === T.OILPLANT) oilPlants.push([x, y]);
    if (UPKEEP[t]) upkeep += UPKEEP[t];
    if (t === T.RZONE || t === T.WZONE) {
      const nearRoad = N4.some(([dx, dy]) => {
        if (!inB(x + dx, y + dy)) return false;
        const nt = state.grid[idx(x + dx, y + dy)];
        return nt === T.ROAD || nt === T.AVENUE;
      });
      if (nearRoad && ++state.growth[i] >= 2) {
        state.grid[i] = t === T.RZONE ? T.HOUSE : T.WORK;
        state.growth[i] = 0;
        events.push({ x, y, t: state.grid[i], v: state.variant[i], g: 0 });
      }
    }
  }

  // infrastructure state
  const power = computePower(state);
  const congestion = computeCongestion(state);
  const dist = buildDistanceField(state);

  // --- education: schools graduate cats over time ---
  const seatCap = schools * SCHOOL_SEATS;
  let grads = state.cats.filter(c => c.edu).length;
  let gradBudget = schools * GRADS_PER_TICK;
  for (const c of state.cats) {
    if (grads >= seatCap || gradBudget <= 0) break;
    if (!c.edu) {
      c.edu = true;
      grads++;
      gradBudget--;
    }
  }

  // job vacancies (all job types; labs educated-only)
  const jobsAt = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = state.grid[idx(x, y)];
    if (JOB_CAP[t]) jobsAt.set(idx(x, y), JOB_CAP[t]);
  }
  for (const c of state.cats) {
    const k = idx(c.wx, c.wy);
    if (jobsAt.has(k)) jobsAt.set(k, jobsAt.get(k) - 1);
  }

  // educated cats upgrade to open lab jobs (better pay)
  for (const c of state.cats) {
    if (!c.edu || state.grid[idx(c.wx, c.wy)] === T.LAB) continue;
    let best = null, bestD = Infinity;
    for (const [k, vac] of jobsAt) {
      if (vac <= 0 || state.grid[k] !== T.LAB) continue;
      const d = Math.abs(k % W - c.hx) + Math.abs(((k / W) | 0) - c.hy);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best !== null) {
      jobsAt.set(idx(c.wx, c.wy), (jobsAt.get(idx(c.wx, c.wy)) ?? 0) + 1);
      jobsAt.set(best, jobsAt.get(best) - 1);
      c.wx = best % W; c.wy = (best / W) | 0;
      c.path = findPath(state, c.hx, c.hy, c.wx, c.wy);
    }
  }

  // --- per-house satisfaction, move-ins and move-outs ---
  const occ = new Map();
  for (const c of state.cats) {
    const k = idx(c.hx, c.hy);
    occ.set(k, (occ.get(k) || 0) + 1);
  }
  const polluted = (x, y) => oilPlants.some(([px, py]) =>
    Math.abs(px - x) + Math.abs(py - y) <= POLLUTION_R);

  let happySum = 0, homes = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    if (state.grid[i] !== T.HOUSE) continue;
    homes++;
    let door = Infinity, congMax = 0;
    for (const [dx, dy] of N4) {
      if (inB(x + dx, y + dy)) {
        door = Math.min(door, dist[idx(x + dx, y + dy)]);
        congMax = Math.max(congMax, Math.max(0, congestion[idx(x + dx, y + dy)] - 1));
      }
    }
    const h = Math.max(0.05, Math.min(1,
      0.5
      + (nearAmenity(state, x, y, 5) ? 0.15 : 0)
      + (power.unpowered[i] ? -0.25 : 0.1)
      + (polluted(x, y) ? -0.2 : 0)
      + (door < 25 ? 0.1 : 0)
      - Math.min(1, congMax) * 0.15
      + (schools > 0 ? 0.05 : 0)
    ));
    happySum += h;

    const residents = occ.get(i) || 0;
    if (h < 0.35) {
      // deeply unhappy: after 3 straight ticks, a cat packs its yarn and leaves
      const streak = (_unhappyStreak.get(i) || 0) + 1;
      _unhappyStreak.set(i, streak);
      if (streak >= 3 && residents > 0) {
        const gone = state.cats.findIndex(c => c.hx === x && c.hy === y);
        if (gone >= 0) {
          const [c] = state.cats.splice(gone, 1);
          jobsAt.set(idx(c.wx, c.wy), (jobsAt.get(idx(c.wx, c.wy)) ?? 0) + 1);
        }
        _unhappyStreak.set(i, 0);
      }
    } else {
      _unhappyStreak.set(i, 0);
      // move-in: needs vacancy, a reachable job, powered home helps a lot
      const vac = HOUSE_CAP - residents;
      if (vac > 0 && door < 60 && state.cats.length < MAX_CATS && Math.random() < 0.3 * h) {
        const job = pickJob(state, jobsAt, x, y, false);
        if (job) {
          const [wx, wy] = job;
          jobsAt.set(idx(wx, wy), jobsAt.get(idx(wx, wy)) - 1);
          state.cats.push({
            id: (Math.random() * 1e9) | 0, hx: x, hy: y, wx, wy, edu: false,
            color: CAT_COLORS[(Math.random() * CAT_COLORS.length) | 0],
            path: findPath(state, x, y, wx, wy), p: Math.random(), dir: 1,
            speed: 0.10 + Math.random() * 0.06,
          });
        }
      }
    }
  }

  state.pop = state.cats.length;
  state.happiness = homes ? happySum / homes : 1;
  state.grads = grads;
  state.powerCap = power.cap;
  state.powerDemand = power.demand;

  // --- income: pay by job type, no pay if the workplace is browned out ---
  let wages = 0;
  for (const c of state.cats) {
    const wi = idx(c.wx, c.wy);
    const wt = state.grid[wi];
    if (JOB_PAY[wt] && !power.unpowered[wi]) wages += JOB_PAY[wt];
  }
  state.income = wages + 3 + airports * 25 - upkeep;
  state.fish = Math.max(0, state.fish + state.income);

  // level ups
  const newLevel = levelFor(state.pop);
  let levelUp = null;
  if (newLevel > state.level) {
    state.level = newLevel;
    state.fish += LEVELS[newLevel].bonus;
    levelUp = { level: newLevel, name: LEVELS[newLevel].name, unlock: LEVELS[newLevel].unlock, bonus: LEVELS[newLevel].bonus };
  }

  return { grown: events, levelUp };
}

function nearAmenity(state, x, y, r) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const nx = x + dx, ny = y + dy;
    if (inB(nx, ny)) {
      const t = state.grid[idx(nx, ny)];
      if (t === T.PARK || t === T.PLAZA || t === T.STATUE || t === T.MONUMENT) return true;
    }
  }
  return false;
}

function pickJob(state, jobsAt, hx, hy, edu) {
  let best = null, bestD = Infinity;
  for (const [k, vac] of jobsAt) {
    if (vac <= 0) continue;
    if (EDU_ONLY[state.grid[k]] && !edu) continue; // labs want a diploma
    const x = k % W, y = (k / W) | 0;
    const d = Math.abs(x - hx) + Math.abs(y - hy);
    if (d < bestD) { bestD = d; best = [x, y]; }
  }
  return best;
}

// advance cat animation (both host and guest run this for smoothness)
function animateCats(state, dt) {
  for (const c of state.cats) {
    if (!c.path || c.path.length < 2) continue;
    c.p += c.dir * c.speed * dt / c.path.length * 10;
    if (c.p > 1) { c.p = 1; c.dir = -1; }
    if (c.p < 0) { c.p = 0; c.dir = 1; }
  }
}

function catXY(c) {
  if (!c.path || c.path.length < 2) return [c.hx + 0.5, c.hy + 0.5];
  const f = c.p * (c.path.length - 1);
  const i = Math.min(c.path.length - 2, f | 0);
  const t = f - i;
  const [x0, y0] = c.path[i], [x1, y1] = c.path[i + 1];
  return [x0 + (x1 - x0) * t + 0.5, y0 + (y1 - y0) * t + 0.5];
}

// --- serialization -----------------------------------------------------

function serialize(state) {
  return JSON.stringify({
    grid: Array.from(state.grid), variant: Array.from(state.variant),
    growth: Array.from(state.growth), fish: state.fish, pop: state.pop,
    level: state.level, tick: state.tick,
    cats: state.cats.map(c => ({ ...c, path: c.path })),
  });
}

function deserialize(json) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  const s = newState();
  s.grid = Uint8Array.from(d.grid);
  s.variant = Uint8Array.from(d.variant);
  s.growth = Uint8Array.from(d.growth);
  s.fish = d.fish; s.pop = d.pop; s.level = d.level; s.tick = d.tick;
  s.cats = d.cats || [];
  return s;
}

export {
  W, H, T, COST, TOOL_TILE, TOOL_LEVEL, LEVELS, newState, idx, inB,
  canPlace, applyBuild, applyDiffTiles, tickSim, animateCats, catXY,
  serialize, deserialize, levelFor, stationGroupsCache,
  computePower, computeCongestion, POWER_CAP, POWER_DEMAND,
};
