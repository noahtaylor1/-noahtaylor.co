/*
 * Ginger Web Slicer -- core (no three.js dependency, node-testable)
 * =================================================================
 * Nonplanar spiral slicer for open-top / open-bottom shell meshes.
 *
 * Pipeline:
 *   weld()        raw triangle soup -> indexed mesh (positions welded)
 *   analyze()     largest connected component, boundary loops (bottom/top)
 *   buildField()  scalar field h in [0,1] over the mesh: h = dB/(dB+dT)
 *                 where dB/dT are multi-source Dijkstra distances from the
 *                 bottom/top boundary loops, measured ALONG THE SURFACE.
 *                 Iso-contours of h are nonplanar rings that morph smoothly
 *                 from the bottom rim to the top rim -- this replaces the
 *                 UV-walk / horizontal-section approaches (works on any
 *                 mesh topology, wavy rims included, no tangling: every
 *                 ring lives exactly on the mesh).
 *   extractRing() marching-triangles iso-contour -> closed polyline
 *   slicePath()   aligned ring resampling + spiral blend + optional flat
 *                 base spiral (center -> rim, joins the wall spiral start)
 *   makeGcode()   Ginger G1 (Klipper START_PRINT macro) flavored gcode,
 *                 volumetric E (filament area = 1mm^2), flat feedrate,
 *                 same conventions as rhino_curve_to_gcode_ginger_g1.py
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- weld
  // Merge duplicate vertices from a triangle soup (Float32/64 positions,
  // 9 numbers per tri) into an indexed mesh. Tolerance is relative to bbox.
  function weld(positions, tolScale) {
    var n = positions.length / 3;
    var minx = Infinity, miny = Infinity, minz = Infinity;
    var maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (var i = 0; i < n; i++) {
      var x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    var diag = Math.sqrt((maxx - minx) * (maxx - minx) + (maxy - miny) * (maxy - miny) + (maxz - minz) * (maxz - minz)) || 1;
    var tol = diag * 1e-5 * (tolScale || 1);
    var inv = 1.0 / tol;

    // Cell -> LIST of vertex ids, cell size = tol, and a merge candidate is
    // searched across the cell and its 26 neighbours with a real distance test.
    //
    // Snapping each vertex to a single hash cell (what this used to do) makes
    // welding depend on WHERE the mesh sits in space: two vertices closer than
    // tol still land in different cells whenever they straddle a cell edge, so
    // the same shape translated by a few mm welds differently, opens or closes
    // hairline seams, and changes the boundary loops the slicer keys off. That
    // turned "move the part up 10mm" into a different toolpath. Searching the
    // neighbourhood makes the result depend only on the shape.
    //
    // Buckets are keyed by an integer spatial hash in a Map (string keys cost
    // ~5x here). Two cells can collide onto one bucket; that only lends the
    // search a few extra candidates, because every candidate is distance
    // tested anyway -- it can never merge points that are too far apart.
    var map = new Map();       // hashed cell -> [vertex index, ...]
    var verts = [];            // flat xyz
    var index = new Uint32Array(n);
    var tol2 = tol * tol;
    function cellHash(a, b, c) {
      return (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) | 0;
    }
    for (var i = 0; i < n; i++) {
      var x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      var vi = -1, best2 = tol2;

      // fast path -- a triangle soup repeats every shared corner bit for bit,
      // so most vertices find an exact match in their own cell and stop here
      var homeKey = cellHash(cx, cy, cz);
      var home = map.get(homeKey);
      if (home !== undefined) {
        for (var b = 0; b < home.length; b++) {
          var c0 = home[b];
          var ex = verts[c0 * 3] - x, ey = verts[c0 * 3 + 1] - y, ez = verts[c0 * 3 + 2] - z;
          var d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < best2) { best2 = d2; vi = c0; if (d2 === 0) break; }
        }
      }
      if (best2 !== 0) {
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            for (var dz = -1; dz <= 1; dz++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;   // done above
              var bucket = map.get(cellHash(cx + dx, cy + dy, cz + dz));
              if (bucket === undefined) continue;
              for (var b2 = 0; b2 < bucket.length; b2++) {
                var c1 = bucket[b2];
                var fx = verts[c1 * 3] - x, fy = verts[c1 * 3 + 1] - y, fz = verts[c1 * 3 + 2] - z;
                var e2 = fx * fx + fy * fy + fz * fz;
                if (e2 < best2) { best2 = e2; vi = c1; }
              }
            }
          }
        }
      }
      if (vi < 0) {
        vi = verts.length / 3;
        verts.push(x, y, z);
        if (home === undefined) map.set(homeKey, [vi]);
        else home.push(vi);
      }
      index[i] = vi;
    }
    // drop degenerate tris
    var tris = [];
    for (var t = 0; t < n; t += 3) {
      var a = index[t], b = index[t + 1], c = index[t + 2];
      if (a !== b && b !== c && a !== c) tris.push(a, b, c);
    }
    return { verts: new Float64Array(verts), tris: new Uint32Array(tris) };
  }

  // ------------------------------------------------------------- analyze
  // Largest connected component + boundary loop extraction.
  function analyze(mesh) {
    var verts = mesh.verts, tris = mesh.tris;
    var nv = verts.length / 3, nt = tris.length / 3;

    // union-find over vertices via triangles
    var parent = new Uint32Array(nv);
    for (var i = 0; i < nv; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    for (var t = 0; t < nt; t++) { union(tris[t * 3], tris[t * 3 + 1]); union(tris[t * 3 + 1], tris[t * 3 + 2]); }

    // count tris per component, keep largest
    var compTriCount = {};
    for (var t = 0; t < nt; t++) {
      var r = find(tris[t * 3]);
      compTriCount[r] = (compTriCount[r] || 0) + 1;
    }
    var bestRoot = -1, bestCount = -1, totalComps = 0;
    for (var k in compTriCount) { totalComps++; if (compTriCount[k] > bestCount) { bestCount = compTriCount[k]; bestRoot = +k; } }

    var keptTris = [];
    for (var t = 0; t < nt; t++) {
      if (find(tris[t * 3]) === bestRoot) keptTris.push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
    }
    tris = new Uint32Array(keptTris);
    nt = tris.length / 3;

    // boundary edges: edges used by exactly one triangle
    var edgeCount = {};
    function ekey(a, b) { return a < b ? a + "_" + b : b + "_" + a; }
    for (var t = 0; t < nt; t++) {
      var a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      edgeCount[ekey(a, b)] = (edgeCount[ekey(a, b)] || 0) + 1;
      edgeCount[ekey(b, c)] = (edgeCount[ekey(b, c)] || 0) + 1;
      edgeCount[ekey(c, a)] = (edgeCount[ekey(c, a)] || 0) + 1;
    }
    var adj = {}; // boundary adjacency vertex -> [vertex,...]
    var boundaryEdges = 0;
    for (var k in edgeCount) {
      if (edgeCount[k] === 1) {
        boundaryEdges++;
        var parts = k.split("_");
        var a = +parts[0], b = +parts[1];
        (adj[a] = adj[a] || []).push(b);
        (adj[b] = adj[b] || []).push(a);
      }
    }

    // chain boundary edges into loops
    var visited = {};
    var loops = [];
    for (var start in adj) {
      start = +start;
      if (visited[start]) continue;
      var loop = [start];
      visited[start] = true;
      var cur = start, prev = -1;
      while (true) {
        var nbrs = adj[cur];
        var next = -1;
        for (var i = 0; i < nbrs.length; i++) {
          if (nbrs[i] !== prev && !visited[nbrs[i]]) { next = nbrs[i]; break; }
        }
        if (next === -1) {
          // closed back to start (or open chain -- discard opens)
          break;
        }
        loop.push(next);
        visited[next] = true;
        prev = cur; cur = next;
      }
      if (loop.length >= 3) {
        var meanZ = 0, len = 0;
        for (var i = 0; i < loop.length; i++) {
          meanZ += verts[loop[i] * 3 + 2];
          var jn = loop[(i + 1) % loop.length];
          var dx = verts[jn * 3] - verts[loop[i] * 3];
          var dy = verts[jn * 3 + 1] - verts[loop[i] * 3 + 1];
          var dz = verts[jn * 3 + 2] - verts[loop[i] * 3 + 2];
          len += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        meanZ /= loop.length;
        loops.push({ verts: loop, meanZ: meanZ, length: len });
      }
    }
    loops.sort(function (a, b) { return a.meanZ - b.meanZ; });

    return { verts: verts, tris: tris, loops: loops, components: totalComps, keptTriCount: nt };
  }

  // ---------------------------------------------------------- buildField
  // Multi-source Dijkstra along mesh edges. sources: array of vertex ids.
  function dijkstra(verts, tris, sources) {
    var nv = verts.length / 3;
    // adjacency (vertex -> [nbr, dist, nbr, dist, ...]) built flat
    var deg = new Uint32Array(nv);
    var nt = tris.length / 3;
    for (var t = 0; t < nt; t++) {
      deg[tris[t * 3]] += 2; deg[tris[t * 3 + 1]] += 2; deg[tris[t * 3 + 2]] += 2;
    }
    var off = new Uint32Array(nv + 1);
    for (var i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i];
    var nbr = new Uint32Array(off[nv]);
    var fill = new Uint32Array(nv);
    function addEdge(a, b) { nbr[off[a] + fill[a]++] = b; }
    for (var t = 0; t < nt; t++) {
      var a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      addEdge(a, b); addEdge(a, c);
      addEdge(b, a); addEdge(b, c);
      addEdge(c, a); addEdge(c, b);
    }

    var dist = new Float64Array(nv);
    for (var i = 0; i < nv; i++) dist[i] = Infinity;

    // binary heap
    var heap = new Uint32Array(nv * 4);
    var hn = 0;
    function push(v) {
      var i = hn++;
      heap[i] = v;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (dist[heap[p]] <= dist[heap[i]]) break;
        var tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
        i = p;
      }
    }
    function pop() {
      var top = heap[0];
      heap[0] = heap[--hn];
      var i = 0;
      while (true) {
        var l = i * 2 + 1, r = l + 1, s = i;
        if (l < hn && dist[heap[l]] < dist[heap[s]]) s = l;
        if (r < hn && dist[heap[r]] < dist[heap[s]]) s = r;
        if (s === i) break;
        var tmp = heap[s]; heap[s] = heap[i]; heap[i] = tmp;
        i = s;
      }
      return top;
    }

    for (var i = 0; i < sources.length; i++) { dist[sources[i]] = 0; push(sources[i]); }
    var done = new Uint8Array(nv);
    while (hn > 0) {
      var u = pop();
      if (done[u]) continue;
      done[u] = 1;
      var du = dist[u];
      for (var e = off[u]; e < off[u + 1]; e++) {
        var v = nbr[e];
        if (done[v]) continue;
        var dx = verts[u * 3] - verts[v * 3];
        var dy = verts[u * 3 + 1] - verts[v * 3 + 1];
        var dz = verts[u * 3 + 2] - verts[v * 3 + 2];
        var nd = du + Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (nd < dist[v]) { dist[v] = nd; push(v); }
      }
    }
    return dist;
  }

  function buildField(verts, tris, bottomVerts, topVerts) {
    var dB = dijkstra(verts, tris, bottomVerts);
    var dT = dijkstra(verts, tris, topVerts);
    var nv = verts.length / 3;
    var h = new Float64Array(nv);
    var wallLenSum = 0, wallLenCount = 0;
    for (var i = 0; i < nv; i++) {
      var s = dB[i] + dT[i];
      h[i] = s > 1e-12 ? dB[i] / s : 0;
      if (isFinite(s)) { wallLenSum += s; wallLenCount++; }
    }
    var meanWallLen = wallLenCount ? wallLenSum / wallLenCount : 0;
    return { h: h, meanWallLen: meanWallLen };
  }

  // --------------------------------------------------------- extractRing
  // Marching triangles: iso-contour of per-vertex scalar h at value t.
  // Returns the LONGEST closed polyline [x,y,z, x,y,z, ...] or null.
  function extractRing(verts, tris, h, t, triMin, triMax) {
    var nt = tris.length / 3;
    var segs = [];        // [keyA, keyB, ax,ay,az, bx,by,bz]
    var keyPts = {};      // edgeKey -> [x,y,z]

    function crossPt(a, b) {
      var ha = h[a], hb = h[b];
      var f = (t - ha) / (hb - ha);
      if (f < 0) f = 0; if (f > 1) f = 1;
      return [
        verts[a * 3] + (verts[b * 3] - verts[a * 3]) * f,
        verts[a * 3 + 1] + (verts[b * 3 + 1] - verts[a * 3 + 1]) * f,
        verts[a * 3 + 2] + (verts[b * 3 + 2] - verts[a * 3 + 2]) * f
      ];
    }
    function edgeKey(a, b) { return a < b ? a + "_" + b : b + "_" + a; }

    for (var i = 0; i < nt; i++) {
      if (triMin[i] > t || triMax[i] < t) continue;
      var a = tris[i * 3], b = tris[i * 3 + 1], c = tris[i * 3 + 2];
      var sa = h[a] < t, sb = h[b] < t, sc = h[c] < t;
      if (sa === sb && sb === sc) continue;
      var keys = [];
      if (sa !== sb) { var k = edgeKey(a, b); if (!keyPts[k]) keyPts[k] = crossPt(a, b); keys.push(k); }
      if (sb !== sc) { var k = edgeKey(b, c); if (!keyPts[k]) keyPts[k] = crossPt(b, c); keys.push(k); }
      if (sc !== sa) { var k = edgeKey(c, a); if (!keyPts[k]) keyPts[k] = crossPt(c, a); keys.push(k); }
      if (keys.length === 2) segs.push([keys[0], keys[1]]);
    }
    if (segs.length < 3) return null;

    // adjacency: key -> [segIdx...]
    var kadj = {};
    for (var i = 0; i < segs.length; i++) {
      (kadj[segs[i][0]] = kadj[segs[i][0]] || []).push(i);
      (kadj[segs[i][1]] = kadj[segs[i][1]] || []).push(i);
    }
    var used = new Uint8Array(segs.length);
    var best = null, bestLen = 0;

    for (var s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      var chainKeys = [segs[s0][0], segs[s0][1]];
      used[s0] = 1;
      var closed = false;
      while (true) {
        var tail = chainKeys[chainKeys.length - 1];
        var cand = kadj[tail];
        var found = -1;
        for (var i = 0; i < cand.length; i++) if (!used[cand[i]]) { found = cand[i]; break; }
        if (found === -1) break;
        used[found] = 1;
        var nk = segs[found][0] === tail ? segs[found][1] : segs[found][0];
        if (nk === chainKeys[0]) { closed = true; break; }
        chainKeys.push(nk);
      }
      if (!closed || chainKeys.length < 3) continue;
      var len = 0;
      for (var i = 0; i < chainKeys.length; i++) {
        var p = keyPts[chainKeys[i]], q = keyPts[chainKeys[(i + 1) % chainKeys.length]];
        len += Math.sqrt((p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]) + (p[2] - q[2]) * (p[2] - q[2]));
      }
      if (len > bestLen) {
        bestLen = len;
        var flat = new Float64Array(chainKeys.length * 3);
        for (var i = 0; i < chainKeys.length; i++) {
          var p = keyPts[chainKeys[i]];
          flat[i * 3] = p[0]; flat[i * 3 + 1] = p[1]; flat[i * 3 + 2] = p[2];
        }
        best = flat;
      }
    }
    return best;
  }

  // ------------------------------------------------------- ring resample
  function ringLength(poly) {
    var n = poly.length / 3, len = 0;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var dx = poly[j * 3] - poly[i * 3], dy = poly[j * 3 + 1] - poly[i * 3 + 1], dz = poly[j * 3 + 2] - poly[i * 3 + 2];
      len += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return len;
  }

  // Sample closed polyline at N even arc-length steps starting at fraction s0,
  // direction +1/-1. Returns Float64Array N*3.
  function sampleRing(poly, N, s0, dir) {
    var n = poly.length / 3;
    var cum = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var dx = poly[j * 3] - poly[i * 3], dy = poly[j * 3 + 1] - poly[i * 3 + 1], dz = poly[j * 3 + 2] - poly[i * 3 + 2];
      cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    var total = cum[n];
    var out = new Float64Array(N * 3);
    for (var k = 0; k < N; k++) {
      var s = s0 + dir * (k / N);
      s = s - Math.floor(s);
      var target = s * total;
      // binary search cum
      var lo = 0, hi = n;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
      var i1 = Math.max(1, lo), i0 = i1 - 1;
      var seg = cum[i1] - cum[i0];
      var f = seg > 1e-12 ? (target - cum[i0]) / seg : 0;
      var a = i0 % n, b = i1 % n;
      out[k * 3] = poly[a * 3] + (poly[b * 3] - poly[a * 3]) * f;
      out[k * 3 + 1] = poly[a * 3 + 1] + (poly[b * 3 + 1] - poly[a * 3 + 1]) * f;
      out[k * 3 + 2] = poly[a * 3 + 2] + (poly[b * 3 + 2] - poly[a * 3 + 2]) * f;
    }
    return out;
  }

  // fraction along poly of the point closest to (x,y,z)
  function closestFraction(poly, x, y, z) {
    var n = poly.length / 3;
    var cum = 0, total = ringLength(poly);
    var bestD = Infinity, bestS = 0;
    var run = 0;
    for (var i = 0; i < n; i++) {
      var dx = poly[i * 3] - x, dy = poly[i * 3 + 1] - y, dz = poly[i * 3 + 2] - z;
      var d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; bestS = run / total; }
      var j = (i + 1) % n;
      var ex = poly[j * 3] - poly[i * 3], ey = poly[j * 3 + 1] - poly[i * 3 + 1], ez = poly[j * 3 + 2] - poly[i * 3 + 2];
      run += Math.sqrt(ex * ex + ey * ey + ez * ez);
    }
    return bestS;
  }

  // Taubin lambda/mu smoothing on a CLOSED ring (Float64Array N*3, wraps).
  // Rounds off jagged facet-to-facet direction changes inherited from the
  // mesh triangulation WITHOUT shrinking the shape (the negative mu pass
  // re-inflates what the positive lambda pass pulled in -- plain moving-
  // average smoothing would visibly shrink every ring and the part).
  function taubinSmoothRing(pts, iterations) {
    var n = pts.length / 3;
    if (n < 5 || iterations <= 0) return pts;
    var a = pts, b = new Float64Array(pts.length);
    function pass(src, dst, f) {
      for (var i = 0; i < n; i++) {
        var ip = (i - 1 + n) % n, inx = (i + 1) % n;
        for (var c = 0; c < 3; c++) {
          var v = src[i * 3 + c];
          dst[i * 3 + c] = v + f * ((src[ip * 3 + c] + src[inx * 3 + c]) / 2 - v);
        }
      }
    }
    for (var k = 0; k < iterations; k++) {
      pass(a, b, 0.5);      // lambda: smooth
      pass(b, a, -0.53);    // mu: anti-shrink
    }
    return a;
  }

  // Same Taubin smoothing along the assembled OPEN path (stride 4, xyz only;
  // first/last points pinned). Kills the residual kinks where the spiral
  // interpolates across ring levels and at the base-to-wall handoff.
  function taubinSmoothPathOpen(path, iterations) {
    var n = path.length / 4;
    if (n < 5 || iterations <= 0) return path;
    var a = path, b = new Float64Array(path.length);
    function pass(src, dst, f) {
      dst.set(src);
      for (var i = 1; i < n - 1; i++) {
        for (var c = 0; c < 3; c++) {
          var v = src[i * 4 + c];
          dst[i * 4 + c] = v + f * ((src[(i - 1) * 4 + c] + src[(i + 1) * 4 + c]) / 2 - v);
        }
      }
    }
    for (var k = 0; k < iterations; k++) {
      pass(a, b, 0.5);
      pass(b, a, -0.53);
    }
    return a;
  }

  function sumDist(a, b) {
    var n = Math.min(a.length, b.length) / 3;
    var s = 0;
    for (var i = 0; i < n; i++) {
      var dx = a[i * 3] - b[i * 3], dy = a[i * 3 + 1] - b[i * 3 + 1], dz = a[i * 3 + 2] - b[i * 3 + 2];
      s += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return s;
  }

  // ----------------------------------------------------------- slicePath
  // opts: { spacing, ptsPerRev, ringsPerRev, seamDeg, baseOn, baseSpacing,
  //         traceTopRim, onProgress(pct,msg) }
  // mesh verts must already be in FINAL coordinates (mm, Z-up).
  function slicePath(analyzed, opts) {
    var verts = analyzed.verts, tris = analyzed.tris, loops = analyzed.loops;
    var warnings = [];
    if (loops.length === 0) {
      throw new Error("Mesh has no open boundary -- this slicer needs a shell with an open top (and ideally an open bottom). Export your Gravity Sketch surface without capping it.");
    }
    var bottomLoop, topLoop;
    if (loops.length === 1) {
      // closed bottom: treat the single loop as the top, seed the bottom from
      // the lowest vertices of the mesh
      topLoop = loops[0];
      var minZ = Infinity;
      var nv = verts.length / 3;
      for (var i = 0; i < nv; i++) if (verts[i * 3 + 2] < minZ) minZ = verts[i * 3 + 2];
      var band = [];
      var eps = (topLoop.meanZ - minZ) * 0.02 + 1e-9;
      for (var i = 0; i < nv; i++) if (verts[i * 3 + 2] < minZ + eps) band.push(i);
      bottomLoop = { verts: band, meanZ: minZ, length: 0, synthetic: true };
      warnings.push("Only ONE open boundary found -- treating it as the top and the mesh's lowest points as the bottom.");
    } else {
      bottomLoop = loops[0];
      topLoop = loops[loops.length - 1];
      if (loops.length > 2) warnings.push((loops.length - 2) + " extra boundary loop(s) (holes?) ignored -- using lowest and highest.");
    }

    if (opts.onProgress) opts.onProgress(5, "Building surface distance field...");
    var field = buildField(verts, tris, bottomLoop.verts, topLoop.verts);
    var h = field.h;

    var revs = Math.max(1, Math.round(field.meanWallLen / opts.spacing));
    var RPR = Math.max(1, opts.ringsPerRev | 0);
    var K = revs * RPR + 1;             // ring levels, uniform in h
    var N = Math.max(16, opts.ptsPerRev | 0);

    // per-tri h min/max for fast ring extraction
    var nt = tris.length / 3;
    var triMin = new Float64Array(nt), triMax = new Float64Array(nt);
    for (var i = 0; i < nt; i++) {
      var ha = h[tris[i * 3]], hb = h[tris[i * 3 + 1]], hc = h[tris[i * 3 + 2]];
      triMin[i] = Math.min(ha, hb, hc);
      triMax[i] = Math.max(ha, hb, hc);
    }

    // extract raw ring polylines at every level first; levels near a closed
    // pole (or a pinched rim) can come back degenerate -- keep the longest
    // contiguous run of good rings instead of dying on the first bad level
    // (same fix as planarcontour.py's section-run logic).
    var EPS = 0.003;
    var smoothIter = Math.max(0, opts.smoothing | 0);
    var polys = [];
    for (var k = 0; k < K; k++) {
      var t = EPS + (1 - 2 * EPS) * (k / (K - 1));
      var poly = extractRing(verts, tris, h, t, triMin, triMax);
      // reject degenerate slivers (a ring around a pole point)
      polys.push(poly && ringLength(poly) > 1e-6 ? poly : null);
    }
    var bestLo = 0, bestLen = 0, runLo = -1;
    for (var k = 0; k <= K; k++) {
      var good = k < K && polys[k] !== null;
      if (good && runLo < 0) runLo = k;
      else if (!good && runLo >= 0) {
        if (k - runLo > bestLen) { bestLo = runLo; bestLen = k - runLo; }
        runLo = -1;
      }
    }
    if (bestLen < 2) {
      throw new Error("Could not extract usable rings -- is the shape a single tube/vessel wall?");
    }
    if (bestLo > 0 || bestLo + bestLen < K) {
      warnings.push("Skipped " + (K - bestLen) + " degenerate ring level(s) at the ends " +
        "(closed pole or pinched rim) -- spiral covers the clean body.");
      // keep the revolution SPACING the user asked for: scale rev count to the
      // portion of the wall actually covered
      revs = Math.max(1, Math.round(revs * bestLen / K));
    }
    var keptPolys = polys.slice(bestLo, bestLo + bestLen);
    K = bestLen;

    var rings = [];      // Float64Array N*3 each
    var ringLens = [];
    var prev = null;
    var seamX = 0, seamY = 0, seamZ = 0;
    for (var k = 0; k < K; k++) {
      var poly = keptPolys[k];
      var s0, dir = 1;
      if (prev === null) {
        var n0 = poly.length / 3;
        var bestD = Infinity, bestI = 0;
        if (opts.seamAtLowest) {
          // seam at the LOWEST point of the bottom ring -- starts the spiral
          // where the bottom edge dips closest to the bed
          for (var i = 0; i < n0; i++) {
            if (poly[i * 3 + 2] < bestD) { bestD = poly[i * 3 + 2]; bestI = i; }
          }
        } else {
          // seam at requested angle about the ring centroid
          var cx = 0, cy = 0;
          for (var i = 0; i < n0; i++) { cx += poly[i * 3]; cy += poly[i * 3 + 1]; }
          cx /= n0; cy /= n0;
          var want = (opts.seamDeg || 0) * Math.PI / 180;
          for (var i = 0; i < n0; i++) {
            var ang = Math.atan2(poly[i * 3 + 1] - cy, poly[i * 3] - cx);
            var d = Math.abs(((ang - want + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
            if (d < bestD) { bestD = d; bestI = i; }
          }
        }
        s0 = closestFraction(poly, poly[bestI * 3], poly[bestI * 3 + 1], poly[bestI * 3 + 2]);
        var sampled = taubinSmoothRing(sampleRing(poly, N, s0, 1), smoothIter);
        rings.push(sampled); ringLens.push(ringLength(poly));
        prev = sampled;
        seamX = sampled[0]; seamY = sampled[1]; seamZ = sampled[2];
        continue;
      }
      s0 = closestFraction(poly, seamX, seamY, seamZ);
      var fwd = sampleRing(poly, N, s0, 1);
      var rev = sampleRing(poly, N, s0, -1);
      var pick = sumDist(fwd, prev) <= sumDist(rev, prev) ? fwd : rev;
      pick = taubinSmoothRing(pick, smoothIter);
      rings.push(pick); ringLens.push(ringLength(poly));
      prev = pick;
      seamX = pick[0]; seamY = pick[1]; seamZ = pick[2];
      if (opts.onProgress && (k % 25 === 0)) opts.onProgress(10 + 60 * k / K, "Extracting rings " + k + "/" + K);
    }

    // ------------------------------------------------ path assembly
    // Points: [x, y, z, loopLen] per entry; loopLen drives the heat map.
    var path = [];

    // base spiral: center -> bottom ring, ends exactly at ring0 column 0
    var baseInfo = null;
    if (opts.baseOn) {
      var B = rings[0];
      var cx = 0, cy = 0, cz = 0;
      for (var i = 0; i < N; i++) { cx += B[i * 3]; cy += B[i * 3 + 1]; cz += B[i * 3 + 2]; }
      cx /= N; cy /= N; cz /= N;
      var meanR = 0;
      for (var i = 0; i < N; i++) {
        var dx = B[i * 3] - cx, dy = B[i * 3 + 1] - cy;
        meanR += Math.sqrt(dx * dx + dy * dy);
      }
      meanR /= N;
      // One extra revolution started from the DEAD CENTER (t0 = 0) so the base
      // fully closes -- no leftover hole in the middle. The innermost turn
      // spirals from r=0 out to ~one baseSpacing, capping the center; the rest
      // tile out to the rim as before.
      var P = Math.max(1, Math.round(meanR / opts.baseSpacing)) + 1;
      var totalBase = P * N;
      var rimLen = ringLens[0];
      for (var kk = 0; kk <= totalBase; kk++) {
        var tt = kk / totalBase;              // 0 (center) -> 1 (rim)
        var m = kk % N;
        var px = cx + (B[m * 3] - cx) * tt;
        var py = cy + (B[m * 3 + 1] - cy) * tt;
        var pz = cz + (B[m * 3 + 2] - cz) * tt;
        path.push(px, py, pz, rimLen * tt);   // morphed ring length scales linearly
      }
      baseInfo = { passes: P, meanR: meanR };
      // path currently ends at ring0 column 0 (kk=totalBase -> m=0, tt=1)
    }

    // wall spiral
    var totalWall = revs * N;
    var startI = opts.baseOn ? 1 : 0;   // skip duplicate of base end point
    for (var i = startI; i <= totalWall; i++) {
      var f = i / totalWall;
      var m = i % N;
      var L = f * (K - 1);
      var j0 = Math.floor(L);
      var j1 = Math.min(j0 + 1, K - 1);
      var fr = L - j0;
      var r0 = rings[j0], r1 = rings[j1];
      var px = r0[m * 3] + (r1[m * 3] - r0[m * 3]) * fr;
      var py = r0[m * 3 + 1] + (r1[m * 3 + 1] - r0[m * 3 + 1]) * fr;
      var pz = r0[m * 3 + 2] + (r1[m * 3 + 2] - r0[m * 3 + 2]) * fr;
      var ll = ringLens[j0] + (ringLens[j1] - ringLens[j0]) * fr;
      path.push(px, py, pz, ll);
    }

    // trace the top rim once so a wavy top is fully finished
    if (opts.traceTopRim) {
      var top = rings[K - 1];
      var mEnd = totalWall % N;
      var ll = ringLens[K - 1];
      for (var i = 1; i <= N; i++) {
        var m = (mEnd + i) % N;
        path.push(top[m * 3], top[m * 3 + 1], top[m * 3 + 2], ll);
      }
    }

    // Remove the tapered TOP by dropping the last revolution(s) -- same fix as
    // nonplanarcontour.py's REMOVE_TOP_REVOLUTIONS: as the spiral climbs into
    // the top the passes crowd together and the nozzle globs; the simplest fix
    // is to cut the final revolution(s) off the END of the assembled path
    // (after the rim trace, exactly like the Rhino script's main() does).
    var removeTopRevs = Math.max(0, opts.removeTopRevs || 0);
    if (removeTopRevs > 0) {
      var nRemove = Math.round(removeTopRevs * N) * 4;
      var minKeep = ((opts.baseOn && baseInfo ? (baseInfo.passes * N + 1) : 0) + 2 * N) * 4;
      if (path.length - nRemove >= minKeep) {
        path.length = path.length - nRemove;
      } else {
        warnings.push("Remove-top-revolutions skipped -- would leave less than 2 wall revolutions.");
      }
    }

    if (opts.onProgress) opts.onProgress(90, "Path assembled");

    // final gentle smoothing pass ALONG the path: removes interpolation kinks
    // (ring-level transitions, base-to-wall handoff) the ring smoothing can't see
    var flat = new Float64Array(path);
    if (smoothIter > 0) flat = taubinSmoothPathOpen(flat, smoothIter);

    return {
      path: flat,                       // stride 4: x,y,z,loopLen
      revs: revs,
      rings: K,
      pointsPerRev: N,
      base: baseInfo,
      meanWallLen: field.meanWallLen,
      warnings: warnings
    };
  }

  // ------------------------------------------------------------ makeGcode
  // Mirrors rhino_curve_to_gcode_ginger_g1.py conventions:
  // START_PRINT macro (incl. the profile's "PURGE_LENGHT" spelling), M83
  // relative volumetric E (filament area = 1 mm^2 -> E == mm^3), flat
  // feedrate with the volumetric cap, fixed E-30/E+40 F9000 prime, park+
  // END_PRINT footer.
  function makeGcode(sliced, S) {
    var path = sliced.path;
    var n = path.length / 4;
    if (n < 2) throw new Error("Empty path");

    var beadArea = api.beadArea(S.extrusionWidth, S.layerHeight); // mm^2
    var ePerMm = beadArea * S.extrusionMultiplier;       // filament area = 1mm^2
    var feedReq = S.printSpeed * 60;                     // mm/min
    var volCap = (S.maxVolumetricSpeed / beadArea) * 60; // mm/min
    var feed = Math.min(feedReq, volCap);
    var feedCapped = volCap < feedReq;
    var travelFeed = S.travelSpeed * 60;
    var zFeed = S.zTravelSpeed * 60;

    // rotation on bed: rotate the whole path about its bbox center (Z axis)
    var rotDeg = S.bedRotationDeg || 0;
    if (rotDeg) {
      var pmnx = Infinity, pmxx = -Infinity, pmny = Infinity, pmxy = -Infinity;
      for (var i = 0; i < n; i++) {
        if (path[i * 4] < pmnx) pmnx = path[i * 4];
        if (path[i * 4] > pmxx) pmxx = path[i * 4];
        if (path[i * 4 + 1] < pmny) pmny = path[i * 4 + 1];
        if (path[i * 4 + 1] > pmxy) pmxy = path[i * 4 + 1];
      }
      var pcx = (pmnx + pmxx) / 2, pcy = (pmny + pmxy) / 2;
      var ca = Math.cos(rotDeg * Math.PI / 180), sa = Math.sin(rotDeg * Math.PI / 180);
      var rp = new Float64Array(path.length);
      for (var i = 0; i < n; i++) {
        var rx = path[i * 4] - pcx, ry = path[i * 4 + 1] - pcy;
        rp[i * 4] = pcx + rx * ca - ry * sa;
        rp[i * 4 + 1] = pcy + rx * sa + ry * ca;
        rp[i * 4 + 2] = path[i * 4 + 2];
        rp[i * 4 + 3] = path[i * 4 + 3];
      }
      path = rp;
    }

    // translate: bed placement + height off plate
    var minZ = Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < n; i++) {
      var x = path[i * 4], y = path[i * 4 + 1], z = path[i * 4 + 2];
      if (z < minZ) minZ = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    var ox = 0, oy = 0;
    if (S.autoCenter) {
      ox = S.bedCenterX - (minX + maxX) / 2;
      oy = S.bedCenterY - (minY + maxY) / 2;
    }
    var oz = S.heightOffPlate - minZ;

    var lines = [];
    var timeS = 0;
    lines.push("; Generated by Ginger Web Slicer (nonplanar spiral)");
    lines.push("; Mode: SPIRAL | Nozzle: " + S.nozzle + "mm | Material: Generic PETG GF");
    lines.push("; revs=" + sliced.revs + " ringLevels=" + sliced.rings +
      (sliced.base ? " basePasses=" + sliced.base.passes : " base=off"));
    lines.push("; estimated printing time: __TIME__");
    if (feedCapped) {
      lines.push("; feedrate capped by max volumetric speed: " + (feedReq / 60).toFixed(1) +
        " -> " + (feed / 60).toFixed(1) + " mm/s (bead " + beadArea.toFixed(2) + "mm^2)");
    }

    if (S.leveling) {
      var cx = (minX + maxX) / 2 + ox, cy = (minY + maxY) / 2 + oy;
      var x0 = minX + ox, x1 = maxX + ox, y0 = minY + oy, y1 = maxY + oy;
      lines.push("EXCLUDE_OBJECT_DEFINE NAME=GingerWebSlicer CENTER=" + cx.toFixed(3) + "," + cy.toFixed(3) +
        " POLYGON=[[" + x0.toFixed(3) + "," + y0.toFixed(3) + "],[" + x1.toFixed(3) + "," + y0.toFixed(3) +
        "],[" + x1.toFixed(3) + "," + y1.toFixed(3) + "],[" + x0.toFixed(3) + "," + y1.toFixed(3) + "]]");
    }
    lines.push("START_PRINT BED_TEMPERATURE=" + S.bedTemp +
      " KAMP_LEVELING=" + (S.leveling ? 1 : 0) +
      " EXTRUDER_ROTATION_VOLUME=" + S.extruderRotationVolume +
      " MIXING_STEPPER_ROTATION_VOLUME=" + S.mixingStepperRotationVolume +
      " PURGE_LAYER_HEIGHT=2 PURGE_PARKING_SPEED=10000 PURGE_LENGHT=500" +
      " PURGE_SPEED=400 PURGE_MATERIAL_QUANTITY=" + S.purgeQuantity +
      " EXTRUDER_TEMPERATURE=" + S.zone3Temp +
      " EXTRUDER_TEMPERATURE_INITIAL_LAYER=" + S.zone3Temp +
      " PRESSURE_ADVANCE=" + S.pressureAdvance.toFixed(2) +
      " PRESSURE_ADVANCE_SMOOTH_TIME=" + S.pressureAdvanceSmoothTime.toFixed(2) +
      " ZONE_1_TEMPERATURE=" + S.zone1Temp +
      " ZONE_2_TEMPERATURE=" + S.zone2Temp +
      " ZONE_3_TEMPERATURE=" + S.zone3Temp);
    lines.push("G21 ; mm units");
    lines.push("G90 ; absolute positioning");
    lines.push("M83 ; relative extrusion");
    lines.push("SET_PRESSURE_ADVANCE EXTRUDER=extruder SMOOTH_TIME=" + S.pressureAdvanceSmoothTime.toFixed(2));
    lines.push("SET_PRESSURE_ADVANCE ADVANCE=" + S.pressureAdvance.toFixed(2) + " ; Override pressure advance value");
    lines.push("SET_EXTRUDER_ROTATION_DISTANCE EXTRUDER=extruder DISTANCE=" + S.extruderRotationVolume);
    lines.push("SET_EXTRUDER_ROTATION_DISTANCE EXTRUDER=mixing_stepper DISTANCE=" + S.mixingStepperRotationVolume);
    lines.push("M106 S0");
    lines.push("SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=" + S.squareCornerVelocity);
    lines.push("SET_VELOCITY_LIMIT ACCEL=" + S.accelPrint + " ; print accel (flat, whole print)");
    lines.push("G92 E0");

    // prime + travel to start (fixed sequence, same as the Rhino script)
    var sx = path[0] + ox, sy = path[1] + oy, sz = path[2] + oz;
    lines.push("G1 E-30.0000 F9000 ; initial retract (fixed prime, not material-derived)");
    lines.push("G1 X" + sx.toFixed(3) + " Y" + sy.toFixed(3) + " Z" + sz.toFixed(3) + " F" + Math.round(travelFeed) + " ; travel to path start");
    lines.push("G1 E40.0000 F9000 ; initial un-retract (fixed prime)");
    timeS += 70 / (9000 / 60) + 1; // rough prime time

    var px = sx, py = sy, pz = sz;
    var lastZ = sz;
    var totalLen = 0, totalE = 0;
    for (var i = 1; i < n; i++) {
      var x = path[i * 4] + ox, y = path[i * 4 + 1] + oy, z = path[i * 4 + 2] + oz;
      var dx = x - px, dy = y - py, dz = z - pz;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-4) continue;
      var e = d * ePerMm;
      lines.push("G1 X" + x.toFixed(3) + " Y" + y.toFixed(3) + " Z" + z.toFixed(3) + " E" + e.toFixed(4) + " F" + Math.round(feed));
      timeS += d / (feed / 60);
      totalLen += d; totalE += e;
      px = x; py = y; pz = z; lastZ = z;
    }

    // footer: park IN PLACE -- raise the toolhead 20mm straight up off the
    // finished print, retract to stop oozing, done. No travel to a corner.
    var safeZ = lastZ + 20;
    lines.push("; --- end of print: raise 20mm in place + retract, stop ---");
    lines.push("G92 E0");
    lines.push("G1 Z" + safeZ.toFixed(3) + " F" + Math.round(zFeed) + " ; raise toolhead 20mm clear of print (in place)");
    timeS += 20 / S.zTravelSpeed;
    if (S.retractLength > 0) {
      lines.push("G1 E-" + S.retractLength.toFixed(1) + " F" + Math.round(S.retractSpeed * 60) + " ; retract to stop");
      timeS += S.retractLength / S.retractSpeed;
    }
    lines.push("END_PRINT");

    // splice the real time estimate into the header
    var hh = Math.floor(timeS / 3600), mm2 = Math.floor((timeS % 3600) / 60), ss = Math.round(timeS % 60);
    var tstr = (hh > 0 ? hh + "h " : "") + mm2 + "m " + ss + "s";
    lines[3] = "; estimated printing time: " + tstr;

    return {
      text: lines.join("\n") + "\n",
      timeSeconds: timeS,
      timeString: tstr,
      totalLengthMm: totalLen,
      totalVolumeMm3: totalE,
      feedMmS: feed / 60,
      feedCapped: feedCapped
    };
  }

  // mm^2 cross-sectional area of the extruded bead -- a rectangle capped with
  // two semicircular ends (the "stadium" shape slicers use), width x height.
  // Mirrors bead_area() in rhino_curve_to_gcode_ginger_g1.py exactly, so the
  // volumetric-speed cap matches the Rhino script for the same settings.
  function beadArea(width, height) {
    return width * height - (height * height) * (1 - Math.PI / 4);
  }

  // ----------------------------------------------------------- shrinkwrap
  // Rhino 8's ShrinkWrap, in the browser: wrap a skin around the OUTSIDE of the
  // geometry and throw away everything it can't see. Same method Rhino uses --
  // a voxel distance field, an iso-surface at the offset distance, and an
  // outside-only flood fill so internal walls, cavities and stray shells never
  // reach the result.
  //
  //   1. voxelize the triangle soup                    (occupancy grid)
  //   2. exact Euclidean distance transform            (distance to surface)
  //   3. flood fill from the grid boundary through      (what "outside" means --
  //      voxels further than `offset` from the mesh      this is the step that
  //                                                      makes it a WRAP and not
  //                                                      just a dilation)
  //   4. extract the iso-surface at `offset` with       (back to a triangle soup)
  //      naive surface nets
  //
  // Because it returns an ordinary soup, the rest of the pipeline (analyze ->
  // buildField -> extractRing) runs on it completely unchanged.
  //
  // Gaps narrower than about 2 x offset get bridged, which is the whole point:
  // it is what turns a lobed / multi-shell / self-intersecting model into one
  // closed outer surface the spiral can actually follow.
  //
  // NOTE the result is watertight -- it has no boundary rims. The slicer needs
  // an open top and bottom, so shrinkwrapping must happen BEFORE the clip
  // planes cut it open, never after.

  function edt1d(f, n, d, v, z) {
    // Felzenszwalb & Huttenlocher exact squared distance transform, 1-D.
    var k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (var q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      var dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  function edt3d(grid, nx, ny, nz) {
    // grid: Float64Array of 0 (on surface) / EDT_FAR (elsewhere). The "empty"
    // marker must be a large FINITE number, not Infinity: the parabola
    // intersection below evaluates (f[q]+q*q) - (f[v]+v*v), and with two
    // infinite entries that is Inf-Inf = NaN, which silently poisons the whole
    // transform and yields no surface at all.
    // Returns squared distance, in voxel units, by transforming along each axis.
    var maxn = Math.max(nx, ny, nz);
    var f = new Float64Array(maxn), d = new Float64Array(maxn);
    var v = new Int32Array(maxn), z = new Float64Array(maxn + 1);
    var i, j, k, idx;

    for (k = 0; k < nz; k++) for (j = 0; j < ny; j++) {          // along X
      var base = (k * ny + j) * nx;
      for (i = 0; i < nx; i++) f[i] = grid[base + i];
      edt1d(f, nx, d, v, z);
      for (i = 0; i < nx; i++) grid[base + i] = d[i];
    }
    for (k = 0; k < nz; k++) for (i = 0; i < nx; i++) {          // along Y
      for (j = 0; j < ny; j++) f[j] = grid[(k * ny + j) * nx + i];
      edt1d(f, ny, d, v, z);
      for (j = 0; j < ny; j++) grid[(k * ny + j) * nx + i] = d[j];
    }
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {          // along Z
      for (k = 0; k < nz; k++) f[k] = grid[(k * ny + j) * nx + i];
      edt1d(f, nz, d, v, z);
      for (k = 0; k < nz; k++) grid[(k * ny + j) * nx + i] = d[k];
    }
    return grid;
  }

  function largestShell(soup) {
    // Union-find over welded vertex ids, keeping the component with the most
    // triangles. Same approach analyze() uses, run here so the ghost preview
    // shows what will actually be sliced rather than every stray shell.
    var m = weld(soup);
    var tris = m.tris, nt = tris.length / 3;
    var parent = new Uint32Array(m.verts.length / 3);
    for (var i = 0; i < parent.length; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function uni(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    for (var t = 0; t < nt; t++) { uni(tris[t*3], tris[t*3+1]); uni(tris[t*3+1], tris[t*3+2]); }
    var count = {}, shells = 0, best = -1, bestN = -1;
    for (var t = 0; t < nt; t++) {
      var r = find(tris[t*3]);
      count[r] = (count[r] || 0) + 1;
    }
    for (var k in count) { shells++; if (count[k] > bestN) { bestN = count[k]; best = +k; } }
    if (shells <= 1) return { soup: soup, shells: shells };
    var out = new Float64Array(bestN * 9), o = 0;
    for (var t = 0; t < nt; t++) {
      if (find(tris[t*3]) !== best) continue;
      for (var c = 0; c < 3; c++) {
        var v = tris[t*3+c];
        out[o++] = m.verts[v*3]; out[o++] = m.verts[v*3+1]; out[o++] = m.verts[v*3+2];
      }
    }
    return { soup: out, shells: shells };
  }

  function shrinkwrap(positions, opts) {
    opts = opts || {};
    var offsetMM = opts.offset > 0 ? opts.offset : 1.0;
    var res = Math.max(24, Math.min(320, opts.resolution | 0 || 128));
    var prog = opts.onProgress || function () {};

    // ---- bbox, padded so the wrap has room and the flood fill has a rim of
    // free voxels to start from on every side
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var p = 0; p < positions.length; p += 3) {
      for (var a = 0; a < 3; a++) {
        if (positions[p + a] < mn[a]) mn[a] = positions[p + a];
        if (positions[p + a] > mx[a]) mx[a] = positions[p + a];
      }
    }
    var span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    if (!(span > 0)) throw new Error("Shrinkwrap: model has no size.");
    var vox = span / res;                       // mm per voxel

    // The iso-surface is extracted at `offset` from the mesh, so the offset has
    // to be worth at least a voxel or two or the surface lands inside the very
    // first voxel and comes out ragged -- which downstream shows up as stray
    // boundary loops and a spiral that gives up part way. Raise the resolution
    // rather than silently producing a bad wrap.
    var wrapWarn = "";
    var minOffset = vox * 1.5;
    if (offsetMM < minOffset) {
      var needRes = Math.ceil(res * minOffset / offsetMM / 16) * 16;
      wrapWarn = "offset " + offsetMM.toFixed(1) + "mm is under 1.5 voxels (" +
                 vox.toFixed(1) + "mm each) -- the wrap will be ragged. Raise " +
                 "resolution to about " + needRes + ", or the offset to " +
                 minOffset.toFixed(1) + "mm.";
    }
    var pad = offsetMM + 3 * vox;               // wrap thickness + a safety rim
    for (var a = 0; a < 3; a++) { mn[a] -= pad; mx[a] += pad; }

    var nx = Math.max(3, Math.ceil((mx[0] - mn[0]) / vox) + 1);
    var ny = Math.max(3, Math.ceil((mx[1] - mn[1]) / vox) + 1);
    var nz = Math.max(3, Math.ceil((mx[2] - mn[2]) / vox) + 1);
    var total = nx * ny * nz;
    if (total > 40e6) throw new Error("Shrinkwrap: grid too large (" +
      nx + "x" + ny + "x" + nz + "). Lower the resolution.");

    // ---- 1. voxelize: point-sample every triangle at ~half-voxel spacing.
    // Exact triangle/box overlap would be tidier, but the EDT + an offset of at
    // least a voxel closes any pinhole this leaves, and this is far faster.
    prog(5, "Shrinkwrap: voxelizing");
    var grid = new Float64Array(total);
    var EDT_FAR = (nx + ny + nz) * (nx + ny + nz);   // finite, > any real d^2
    for (var i = 0; i < total; i++) grid[i] = EDT_FAR;

    function mark(x, y, z) {
      var i = Math.round((x - mn[0]) / vox);
      var j = Math.round((y - mn[1]) / vox);
      var k = Math.round((z - mn[2]) / vox);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
      grid[(k * ny + j) * nx + i] = 0;
    }

    var ntri = positions.length / 9;
    for (var t = 0; t < ntri; t++) {
      var o = t * 9;
      var ax = positions[o],     ay = positions[o + 1], az = positions[o + 2];
      var bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
      var cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
      var eAB = Math.sqrt((bx-ax)*(bx-ax) + (by-ay)*(by-ay) + (bz-az)*(bz-az));
      var eAC = Math.sqrt((cx-ax)*(cx-ax) + (cy-ay)*(cy-ay) + (cz-az)*(cz-az));
      var steps = Math.ceil(Math.max(eAB, eAC) / (vox * 0.5));
      if (steps < 1) steps = 1;
      if (steps > 4096) steps = 4096;
      for (var u = 0; u <= steps; u++) {
        var fu = u / steps;
        for (var w = 0; w <= steps - u; w++) {
          var fv = w / steps;
          mark(ax + (bx-ax)*fu + (cx-ax)*fv,
               ay + (by-ay)*fu + (cy-ay)*fv,
               az + (bz-az)*fu + (cz-az)*fv);
        }
      }
      if ((t & 1023) === 0) prog(5 + 25 * t / ntri, "Shrinkwrap: voxelizing");
    }

    // ---- 2. distance to the surface, in mm
    prog(32, "Shrinkwrap: distance field");
    edt3d(grid, nx, ny, nz);
    var dist = grid;                     // still squared, in voxel units
    for (var i = 0; i < total; i++) dist[i] = Math.sqrt(dist[i]) * vox;

    // ---- 3. flood fill "outside": voxels reachable from the grid rim without
    // ever coming within `offset` of the mesh. Anything the fill cannot reach
    // -- interior cavities, the space between close-together shells, hollow
    // cores -- is treated as solid, which is exactly what makes this a wrap.
    prog(48, "Shrinkwrap: flood fill from outside");
    var outer = new Uint8Array(total);
    var stack = new Int32Array(total);
    var sp = 0;
    function push(i) { if (!outer[i] && dist[i] > offsetMM) { outer[i] = 1; stack[sp++] = i; } }
    for (var k = 0; k < nz; k++) for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
      if (i === 0 || j === 0 || k === 0 || i === nx-1 || j === ny-1 || k === nz-1) {
        push((k * ny + j) * nx + i);
      }
    }
    while (sp > 0) {
      var idx = stack[--sp];
      var i = idx % nx, j = ((idx - i) / nx) % ny, k = (idx - i - j * nx) / (nx * ny);
      if (i > 0)      push(idx - 1);
      if (i < nx - 1) push(idx + 1);
      if (j > 0)      push(idx - nx);
      if (j < ny - 1) push(idx + nx);
      if (k > 0)      push(idx - nx * ny);
      if (k < nz - 1) push(idx + nx * ny);
    }

    // ---- signed field: > 0 outside the wrap, < 0 within it.
    // Voxels the fill never reached are forced negative even when they sit far
    // from any triangle, so enclosed voids read as solid instead of sprouting
    // an inner surface of their own.
    prog(62, "Shrinkwrap: building iso-surface");
    var phi = new Float64Array(total);
    for (var i = 0; i < total; i++) {
      phi[i] = outer[i] ? (dist[i] - offsetMM)
                        : (dist[i] < offsetMM ? dist[i] - offsetMM : -offsetMM);
    }

    // ---- 4. naive surface nets. One vertex per cell that straddles the
    // iso-value, positioned by averaging the zero-crossings on that cell's 12
    // edges; quads then join the vertices around every sign-changing edge.
    // Chosen over marching cubes for the smoother surface and no 256-case table.
    var cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
    var cellVert = new Int32Array(cnx * cny * cnz);
    for (var i = 0; i < cellVert.length; i++) cellVert[i] = -1;
    var vpos = [];
    var CORNER = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
    var EDGE = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

    function at(i, j, k) { return phi[(k * ny + j) * nx + i]; }

    for (var k = 0; k < cnz; k++) {
      for (var j = 0; j < cny; j++) {
        for (var i = 0; i < cnx; i++) {
          var s = [], neg = 0;
          for (var c = 0; c < 8; c++) {
            var val = at(i + CORNER[c][0], j + CORNER[c][1], k + CORNER[c][2]);
            s.push(val);
            if (val < 0) neg++;
          }
          if (neg === 0 || neg === 8) continue;
          var sx = 0, sy = 0, sz = 0, cnt = 0;
          for (var e = 0; e < 12; e++) {
            var a = EDGE[e][0], b = EDGE[e][1];
            if ((s[a] < 0) === (s[b] < 0)) continue;
            var tt = s[a] / (s[a] - s[b]);
            sx += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * tt;
            sy += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * tt;
            sz += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * tt;
            cnt++;
          }
          if (!cnt) continue;
          cellVert[(k * cny + j) * cnx + i] = vpos.length / 3;
          vpos.push(mn[0] + (i + sx / cnt) * vox,
                    mn[1] + (j + sy / cnt) * vox,
                    mn[2] + (k + sz / cnt) * vox);
        }
      }
      if ((k & 15) === 0) prog(62 + 25 * k / cnz, "Shrinkwrap: building iso-surface");
    }

    // quads around every sign-changing edge of the primal grid
    var out = [];
    function cv(i, j, k) {
      if (i < 0 || j < 0 || k < 0 || i >= cnx || j >= cny || k >= cnz) return -1;
      return cellVert[(k * cny + j) * cnx + i];
    }
    function quad(a, b, c, d, flip) {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      var q = flip ? [a, d, c, b] : [a, b, c, d];
      for (var n = 0; n < 2; n++) {
        var tri = n === 0 ? [q[0], q[1], q[2]] : [q[0], q[2], q[3]];
        for (var m = 0; m < 3; m++) {
          out.push(vpos[tri[m] * 3], vpos[tri[m] * 3 + 1], vpos[tri[m] * 3 + 2]);
        }
      }
    }
    for (var k = 0; k < nz - 1; k++) {
      for (var j = 0; j < ny - 1; j++) {
        for (var i = 0; i < nx - 1; i++) {
          var p0 = at(i, j, k) < 0;
          if ((at(i + 1, j, k) < 0) !== p0)
            quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), p0);
          if ((at(i, j + 1, k) < 0) !== p0)
            quad(cv(i - 1, j, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i - 1, j, k), !p0);
          if ((at(i, j, k + 1) < 0) !== p0)
            quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), p0);
        }
      }
    }

    if (out.length < 9) throw new Error(
      "Shrinkwrap produced no surface -- try a larger offset or higher resolution.");

    var soup = new Float64Array(out);
    var shells = 1;
    if (opts.outerOnly !== false) {
      // An OPEN input (a Gravity Sketch surface, or anything with a free edge)
      // lets the flood fill reach round the back of it, so the wrap comes back
      // as a thin film over both faces -- and a hollow model wraps its bore as
      // a second shell. Keeping only the biggest connected piece leaves the
      // outermost skin, which is the "all outside sides" surface wanted here.
      var r = largestShell(soup);
      soup = r.soup; shells = r.shells;
    }

    prog(92, "Shrinkwrap: done");
    return {
      soup: soup,
      voxelMM: vox,
      dims: [nx, ny, nz],
      shells: shells,
      warning: wrapWarn,
      triCount: soup.length / 9
    };
  }

  // ---------------------------------------------------------------- clipZ
  // Cut a raw triangle soup (9 numbers per tri) with one or two horizontal
  // planes, keeping the slab zMin <= z <= zMax. Pass null for either bound to
  // leave that side uncut.
  //
  // Sutherland-Hodgman per triangle, re-fanned into triangles. The cut is left
  // OPEN (no cap) on purpose -- an open planar rim is exactly the shell
  // boundary analyze()/slicePath() want, so a bottom cut becomes the base rim
  // and a top cut becomes a dead-flat top rim.
  //
  // Split points are computed from a CANONICALLY ordered edge (endpoints
  // sorted lexicographically) so the two triangles sharing an edge emit
  // bit-identical vertices -- otherwise the a->b and b->a interpolations
  // differ in the last ulp and weld() can tear the new rim into an open chain,
  // which analyze() discards.
  function clipZ(positions, zMin, zMax) {
    var hasMin = (zMin !== null && zMin !== undefined);
    var hasMax = (zMax !== null && zMax !== undefined);
    if (!hasMin && !hasMax) return positions;
    var out = [];
    var nt = (positions.length / 9) | 0;
    for (var t = 0; t < nt; t++) {
      var o = t * 9;
      var poly = [positions[o], positions[o + 1], positions[o + 2],
                  positions[o + 3], positions[o + 4], positions[o + 5],
                  positions[o + 6], positions[o + 7], positions[o + 8]];
      if (hasMin) poly = clipHalfZ(poly, zMin, 1);
      if (poly.length && hasMax) poly = clipHalfZ(poly, zMax, -1);
      var m = poly.length / 3;
      for (var i = 1; i + 1 < m; i++) {
        out.push(poly[0], poly[1], poly[2],
                 poly[i * 3], poly[i * 3 + 1], poly[i * 3 + 2],
                 poly[(i + 1) * 3], poly[(i + 1) * 3 + 1], poly[(i + 1) * 3 + 2]);
      }
    }
    return new Float64Array(out);
  }

  // Keep the half-space where sign * (z - z0) >= 0. poly is a flat xyz list.
  function clipHalfZ(poly, z0, sign) {
    var m = poly.length / 3;
    var out = [];
    for (var i = 0; i < m; i++) {
      var j = (i + 1) % m;
      var ax = poly[i * 3], ay = poly[i * 3 + 1], az = poly[i * 3 + 2];
      var bx = poly[j * 3], by = poly[j * 3 + 1], bz = poly[j * 3 + 2];
      var da = sign * (az - z0), db = sign * (bz - z0);
      if (da >= 0) out.push(ax, ay, az);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        // canonical endpoint order -> same split point from either triangle
        var swap = (ax > bx) || (ax === bx && (ay > by || (ay === by && az > bz)));
        var p0x = swap ? bx : ax, p0y = swap ? by : ay, p0z = swap ? bz : az;
        var p1x = swap ? ax : bx, p1y = swap ? ay : by, p1z = swap ? az : bz;
        var f = (z0 - p0z) / (p1z - p0z);
        out.push(p0x + (p1x - p0x) * f, p0y + (p1y - p0y) * f, z0);
      }
    }
    return out;
  }

  var api = { weld: weld, analyze: analyze, clipZ: clipZ, shrinkwrap: shrinkwrap,
              buildField: buildField, extractRing: extractRing, slicePath: slicePath,
              makeGcode: makeGcode, beadArea: beadArea };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GingerSlicer = api;
})(typeof self !== "undefined" ? self : this);
