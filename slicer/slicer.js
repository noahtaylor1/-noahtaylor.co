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

    var map = {};              // hash cell -> vertex index
    var verts = [];            // flat xyz
    var index = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      var key = Math.round(x * inv) + "_" + Math.round(y * inv) + "_" + Math.round(z * inv);
      var vi = map[key];
      if (vi === undefined) {
        vi = verts.length / 3;
        map[key] = vi;
        verts.push(x, y, z);
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
      var P = Math.max(1, Math.round(meanR / opts.baseSpacing));
      var totalBase = P * N;
      var t0 = Math.min(0.5, (opts.baseSpacing * 0.5) / (meanR || 1));  // start at ~half a pass from center
      var rimLen = ringLens[0];
      for (var kk = 0; kk <= totalBase; kk++) {
        var tt = t0 + (1 - t0) * (kk / totalBase);
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

    var beadArea = S.extrusionWidth * S.layerHeight;     // mm^2
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

  var api = { weld: weld, analyze: analyze, buildField: buildField, extractRing: extractRing, slicePath: slicePath, makeGcode: makeGcode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GingerSlicer = api;
})(typeof self !== "undefined" ? self : this);
