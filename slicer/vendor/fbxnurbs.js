/*
 * FBXNurbs -- extract + tessellate NurbsSurface patches from binary FBX.
 * three.js' FBXLoader skips NURBS surface geometry entirely; Gravity Sketch's
 * NURBS export writes the real surface as a grid of rational bicubic
 * NurbsSurface patches (verified against a real GS 7.7 export: order 4x4,
 * 9x9 control points, 4 doubles per point = x,y,z,w). This parses the FBX
 * node tree directly (fflate handles the zlib-compressed arrays) and
 * evaluates the patches on a dense UV grid -- smooth geometry, no faceting.
 *
 * Usage: FBXNurbs.extract(arrayBuffer) -> {
 *   patches: [{ name, modelName, orderU, orderV, dimU, dimV,
 *               points (Float64Array, 4 per cp), knotsU, knotsV }],
 *   tessellate(patch, divs) -> Float64Array triangle soup (local space)
 * }
 */
(function (root) {
  "use strict";

  function parseNodes(buffer) {
    var data = new DataView(buffer);
    var bytes = new Uint8Array(buffer);
    var magic = "Kaydara FBX Binary  ";
    for (var i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic.charCodeAt(i)) throw new Error("Not a binary FBX file");
    }
    var version = data.getUint32(23, true);
    var big = version >= 7500;

    function readU64(off) {
      // FBX offsets fit comfortably in doubles
      return data.getUint32(off, true) + data.getUint32(off + 4, true) * 4294967296;
    }

    function readArrayProp(off, type) {
      var alen = data.getUint32(off, true);
      var enc = data.getUint32(off + 4, true);
      var clen = data.getUint32(off + 8, true);
      off += 12;
      var raw;
      if (enc) {
        raw = fflate.unzlibSync(bytes.subarray(off, off + clen));
        off += clen;
      } else {
        var sz = { f: 4, d: 8, i: 4, l: 8, b: 1 }[type];
        raw = bytes.slice(off, off + alen * sz);
        off += alen * sz;
      }
      var buf = raw.buffer.byteLength === raw.length ? raw.buffer : raw.slice().buffer;
      var arr;
      if (type === "f") arr = new Float32Array(buf, 0, alen);
      else if (type === "d") arr = new Float64Array(buf, 0, alen);
      else if (type === "i") arr = new Int32Array(buf, 0, alen);
      else if (type === "b") arr = new Uint8Array(buf, 0, alen);
      else { // 'l' int64 -> downcast to Number
        arr = new Float64Array(alen);
        var dv = new DataView(buf);
        for (var k = 0; k < alen; k++) arr[k] = dv.getInt32(k * 8, true) + dv.getInt32(k * 8 + 4, true) * 4294967296;
      }
      return { value: arr, off: off };
    }

    function readNode(off) {
      var end, nprops, plen, nlen, hdr;
      if (big) {
        end = readU64(off); nprops = readU64(off + 8); plen = readU64(off + 16); nlen = bytes[off + 24];
        hdr = 25;
      } else {
        end = data.getUint32(off, true); nprops = data.getUint32(off + 4, true);
        plen = data.getUint32(off + 8, true); nlen = bytes[off + 12];
        hdr = 13;
      }
      off += hdr;
      if (end === 0) return { node: null, off: off };
      var name = "";
      for (var i = 0; i < nlen; i++) name += String.fromCharCode(bytes[off + i]);
      off += nlen;
      var props = [];
      var pend = off + plen;
      while (off < pend) {
        var t = String.fromCharCode(bytes[off]); off += 1;
        if (t === "C" || t === "B") { props.push(bytes[off]); off += 1; }
        else if (t === "Y") { props.push(data.getInt16(off, true)); off += 2; }
        else if (t === "I") { props.push(data.getInt32(off, true)); off += 4; }
        else if (t === "L") { props.push(data.getInt32(off, true) + data.getInt32(off + 4, true) * 4294967296); off += 8; }
        else if (t === "F") { props.push(data.getFloat32(off, true)); off += 4; }
        else if (t === "D") { props.push(data.getFloat64(off, true)); off += 8; }
        else if (t === "S" || t === "R") {
          var ln = data.getUint32(off, true); off += 4;
          if (t === "S") {
            var s = "";
            for (var i = 0; i < ln; i++) s += String.fromCharCode(bytes[off + i]);
            props.push(s);
          } else props.push(null);
          off += ln;
        }
        else if ("fdilb".indexOf(t) >= 0) {
          var r = readArrayProp(off, t);
          props.push(r.value);
          off = r.off;
        }
        else throw new Error("Unknown FBX property type " + t);
      }
      var children = [];
      while (off < end) {
        var r = readNode(off);
        if (r.node === null) { off = r.off; break; }
        children.push(r.node);
        off = r.off;
      }
      return { node: { name: name, props: props, children: children }, off: Math.max(off, end) };
    }

    var top = 27;
    var roots = [];
    while (top < bytes.length - 32) {
      var r = readNode(top);
      if (r.node === null) break;
      roots.push(r.node);
      top = r.off;
    }
    return roots;
  }

  function child(node, name) {
    for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i];
    return null;
  }

  function extract(buffer) {
    var roots = parseNodes(buffer);
    var objects = null;
    for (var i = 0; i < roots.length; i++) if (roots[i].name === "Objects") objects = roots[i];
    var patches = [];
    if (objects) {
      for (var i = 0; i < objects.children.length; i++) {
        var g = objects.children[i];
        if (g.name !== "Geometry") continue;
        var isNurbs = false;
        for (var p = 0; p < g.props.length; p++) if (g.props[p] === "NurbsSurface") isNurbs = true;
        if (!isNurbs) continue;
        var order = child(g, "NurbsSurfaceOrder");
        var dims = child(g, "Dimensions");
        var pts = child(g, "Points");
        var ku = child(g, "KnotVectorU");
        var kv = child(g, "KnotVectorV");
        if (!order || !dims || !pts || !ku || !kv) continue;
        var rawName = typeof g.props[0] === "string" ? g.props[0] : (typeof g.props[1] === "string" ? g.props[1] : "");
        var cleanName = rawName.split("\u0000")[0];
        patches.push({
          name: cleanName,
          orderU: order.props[0], orderV: order.props[1],
          dimU: dims.props[0], dimV: dims.props[1],
          points: pts.props[0],       // Float64Array, 4 doubles per control point
          knotsU: ku.props[0], knotsV: kv.props[0]
        });
      }
    }
    return { patches: patches, tessellate: tessellate };
  }

  // --- rational B-spline surface evaluation (Cox-de Boor) -----------------
  function findSpan(n, degree, u, knots) {
    // n = number of control points - 1
    if (u >= knots[n + 1]) return n;
    if (u <= knots[degree]) return degree;
    var lo = degree, hi = n + 1, mid = (lo + hi) >> 1;
    while (u < knots[mid] || u >= knots[mid + 1]) {
      if (u < knots[mid]) hi = mid; else lo = mid;
      mid = (lo + hi) >> 1;
    }
    return mid;
  }

  function basisFuncs(span, u, degree, knots, out) {
    var left = [], right = [];
    out[0] = 1;
    for (var j = 1; j <= degree; j++) {
      left[j] = u - knots[span + 1 - j];
      right[j] = knots[span + j] - u;
      var saved = 0;
      for (var r = 0; r < j; r++) {
        var temp = out[r] / (right[r + 1] + left[j - r]);
        out[r] = saved + right[r + 1] * temp;
        saved = left[j - r] * temp;
      }
      out[j] = saved;
    }
  }

  function evalPoint(patch, u, v, uMajor) {
    var du = patch.orderU - 1, dv = patch.orderV - 1;
    var nu = patch.dimU, nv = patch.dimV;
    var su = findSpan(nu - 1, du, u, patch.knotsU);
    var sv = findSpan(nv - 1, dv, v, patch.knotsV);
    var Nu = [], Nv = [];
    basisFuncs(su, u, du, patch.knotsU, Nu);
    basisFuncs(sv, v, dv, patch.knotsV, Nv);
    var x = 0, y = 0, z = 0, w = 0;
    for (var a = 0; a <= du; a++) {
      var iu = su - du + a;
      for (var b = 0; b <= dv; b++) {
        var iv = sv - dv + b;
        var idx = uMajor ? (iv * nu + iu) : (iu * nv + iv);
        var o = idx * 4;
        var wt = patch.points[o + 3];
        var f = Nu[a] * Nv[b] * (wt || 1);
        x += patch.points[o] * f;
        y += patch.points[o + 1] * f;
        z += patch.points[o + 2] * f;
        w += f;
      }
    }
    if (w === 0) w = 1;
    return [x / w, y / w, z / w];
  }

  // Tessellate one patch into a Float64Array triangle soup (local space).
  // uMajor: control-point ordering flag -- FBX stores U varying fastest
  // (index = v*dimU + u); pass false to flip if a file disagrees.
  function tessellate(patch, divs, uMajor) {
    if (uMajor === undefined) uMajor = true;
    var u0 = patch.knotsU[patch.orderU - 1], u1 = patch.knotsU[patch.dimU];
    var v0 = patch.knotsV[patch.orderV - 1], v1 = patch.knotsV[patch.dimV];
    var D = Math.max(2, divs | 0);
    var grid = [];
    for (var j = 0; j <= D; j++) {
      for (var i = 0; i <= D; i++) {
        var u = u0 + (u1 - u0) * (i / D);
        var v = v0 + (v1 - v0) * (j / D);
        grid.push(evalPoint(patch, u, v, uMajor));
      }
    }
    var soup = new Float64Array(D * D * 2 * 9);
    var o = 0;
    for (var j = 0; j < D; j++) {
      for (var i = 0; i < D; i++) {
        var a = grid[j * (D + 1) + i], b = grid[j * (D + 1) + i + 1];
        var c = grid[(j + 1) * (D + 1) + i + 1], d = grid[(j + 1) * (D + 1) + i];
        soup[o++] = a[0]; soup[o++] = a[1]; soup[o++] = a[2];
        soup[o++] = b[0]; soup[o++] = b[1]; soup[o++] = b[2];
        soup[o++] = c[0]; soup[o++] = c[1]; soup[o++] = c[2];
        soup[o++] = a[0]; soup[o++] = a[1]; soup[o++] = a[2];
        soup[o++] = c[0]; soup[o++] = c[1]; soup[o++] = c[2];
        soup[o++] = d[0]; soup[o++] = d[1]; soup[o++] = d[2];
      }
    }
    return soup;
  }

  root.FBXNurbs = { extract: extract, tessellate: tessellate };
})(typeof self !== "undefined" ? self : this);
