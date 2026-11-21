#!/usr/bin/env python3
"""
curve_extract.py -- read the toolpaths out of a Rhino .3dm and write them as a
spec the malleable pages can be generated from.

These products are beads on a path: the solid is everything within one bead
radius of a curve, and the curve is stacked at the layer pitch up the print
direction.  So the whole shape is carried by a handful of numbers, and this
pulls them out of the design file instead of me measuring renders.

    python3 curve_extract.py "table ref.3dm" -o specs/ct1.json

What it writes, per piece:
  normal/axes  the plane the curve lives in; the normal is the print direction
  bead         the radius the bead is swept at, read off the solids
  pitch        the spacing between stacked copies
  path         the curve as typed segments: lines, arcs, polylines
  instances    where that same curve is repeated, and whether it is mirrored
  measure      the distinct run coordinates and the gaps between them, which
               is where the parameters (loop spacing, wall thickness) are read

Needs rhino3dm:  python3 -m pip install --user rhino3dm
"""

import argparse, json, math, sys
from collections import defaultdict

try:
    import rhino3dm
except ImportError:
    sys.exit("rhino3dm not found.  python3 -m pip install --user rhino3dm")

AX = ('x', 'y', 'z')


def xyz(p):
    return (p.X, p.Y, p.Z)


# ---------------------------------------------------------------- segments

def circle_through(a, b, c):
    """Centre and radius of the circle through three 2d points, or None."""
    (x1, y1), (x2, y2), (x3, y3) = a, b, c
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-12:
        return None
    s1, s2, s3 = x1 * x1 + y1 * y1, x2 * x2 + y2 * y2, x3 * x3 + y3 * y3
    ux = (s1 * (y2 - y3) + s2 * (y3 - y1) + s3 * (y1 - y2)) / d
    uy = (s1 * (x3 - x2) + s2 * (x1 - x3) + s3 * (x2 - x1)) / d
    return (ux, uy), math.hypot(x1 - ux, y1 - uy)


def classify(pts, tol):
    """A sampled segment -> line, arc or polyline."""
    a, b = pts[0], pts[-1]
    vx, vy = b[0] - a[0], b[1] - a[1]
    chord = math.hypot(vx, vy)

    if chord > 1e-9:
        sag = max(abs(((p[0] - a[0]) * vy - (p[1] - a[1]) * vx) / chord)
                  for p in pts[1:-1]) if len(pts) > 2 else 0.0
        if sag < tol:
            return {'k': 'L', 'a': list(a), 'b': list(b)}

    m = pts[len(pts) // 2]
    fit = circle_through(a, m, b)
    if fit:
        (cx, cy), r = fit
        if max(abs(math.hypot(p[0] - cx, p[1] - cy) - r) for p in pts) < tol:
            d0 = (a[0] - cx, a[1] - cy)
            d1 = (b[0] - cx, b[1] - cy)
            return {'k': 'A', 'a': list(a), 'b': list(b), 'c': [cx, cy], 'r': r,
                    'm': list(m),      # a point part way along, so which half
                    'dir': 1 if d0[0] * d1[1] - d0[1] * d1[0] > 0 else -1}

    return None          # neither: the caller refines it into a polyline


def plane_of(crv, tol):
    """Which axis the curve's plane is normal to, and where along it."""
    bb = crv.GetBoundingBox()
    lo, hi = xyz(bb.Min), xyz(bb.Max)
    flat = [i for i in range(3) if hi[i] - lo[i] <= tol]
    if len(flat) != 1:
        return None
    n = flat[0]
    return n, (lo[n] + hi[n]) * 0.5, [i for i in range(3) if i != n], lo, hi


def fit_run(pts, i, tol):
    """Longest arc (or line) starting at pts[i] that holds every point to tol."""
    def holds(j):
        a, m, b = pts[i], pts[(i + j) // 2], pts[j]
        vx, vy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(vx, vy)
        if L > 1e-9:
            sag = max(abs(((p[0] - a[0]) * vy - (p[1] - a[1]) * vx) / L)
                      for p in pts[i:j + 1])
            if sag < tol:
                return {'k': 'L', 'a': list(a), 'b': list(b)}
        fit = circle_through(a, m, b)
        if not fit:
            return None
        (cx, cy), r = fit
        if max(abs(math.hypot(p[0] - cx, p[1] - cy) - r)
               for p in pts[i:j + 1]) >= tol:
            return None
        d0 = (a[0] - cx, a[1] - cy)
        d1 = (b[0] - cx, b[1] - cy)
        return {'k': 'A', 'a': list(a), 'b': list(b), 'c': [cx, cy], 'r': r,
                'm': list(m),
                'dir': 1 if d0[0] * d1[1] - d0[1] * d1[0] > 0 else -1}

    best, bestj = holds(i + 1), i + 1
    lo, hi = i + 1, len(pts) - 1
    while lo < hi:                      # grow it as far as it will go
        mid = (lo + hi + 1) // 2
        got = holds(mid)
        if got:
            best, bestj, lo = got, mid, mid
        else:
            hi = mid - 1
    return best, bestj


def fit_arcs(pts, tol):
    """A free-form blend as the fewest arcs and lines that hold it to tol.

    Rhino blends are not single arcs -- the leg's turn into its return strays
    half a millimetre from any circle -- but two or three arcs carry them
    inside print tolerance, and an arc is one evaluation in the shader where a
    polyline of thirty points is twenty-nine.
    """
    out, i = [], 0
    while i < len(pts) - 1:
        seg, j = fit_run(pts, i, tol)
        if seg is None:
            seg = {'k': 'L', 'a': list(pts[i]), 'b': list(pts[i + 1])}
            j = i + 1
        out.append(seg)
        i = j
    return out


def refine(at, t0, t1, tol, depth=0):
    """Fewest vertices that hold a free-form blend to tol.  Splits where the
    curve strays from the chord, so a gentle bend costs two points and a
    tight one costs as many as it needs."""
    a, b = at(t0), at(t1)
    tm = (t0 + t1) * 0.5
    m = at(tm)
    vx, vy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(vx, vy)
    dev = abs(((m[0] - a[0]) * vy - (m[1] - a[1]) * vx) / L) if L > 1e-9 \
        else math.hypot(m[0] - a[0], m[1] - a[1])
    if dev <= tol or depth >= 10:
        return [a, b]
    left = refine(at, t0, tm, tol, depth + 1)
    right = refine(at, tm, t1, tol, depth + 1)
    return left[:-1] + right


def read_path(crv, n, uv, samples, tol):
    """The curve as typed 2d segments in its own plane, absolute coords."""
    out = []
    for s in range(crv.SegmentCount):
        c = crv.SegmentCurve(s)
        t0, t1 = c.Domain.T0, c.Domain.T1

        def at(t, c=c):
            p = xyz(c.PointAt(t))
            return (p[uv[0]], p[uv[1]])

        pts = [at(t0 + (t1 - t0) * k / samples) for k in range(samples + 1)]
        seg = classify(pts, tol)
        if seg is not None:
            out.append(seg)
        else:
            dense = refine(at, t0, t1, tol * 0.25)
            out.extend(fit_arcs(dense, tol))
    return out


# ---------------------------------------------------------------- grouping

def signature(path, lo2, hi2, grid):
    """Order- and mirror-independent fingerprint, so stacked copies collapse.

    Measured from the curve's own corner, and once again from the opposite
    corner, so a mirrored copy of the same piece lands on the same key.
    """
    def key(mx):
        parts = []
        for s in path:
            vs = s['v'] if s['k'] == 'P' else [s['a'], s['b']]
            f = []
            for (u, v) in vs:
                du = (u - lo2[0]) if mx > 0 else (hi2[0] - u)
                f.append((round(du / grid), round((v - lo2[1]) / grid)))
            f.sort()
            parts.append((s['k'], round(s.get('r', 0) / grid), tuple(f)))
        parts.sort()
        return tuple(parts)
    a, b = key(1), key(-1)
    return (a, 1) if a <= b else (b, -1)


def bead_radius(curve_bbox, breps, tol):
    """The bead radius, from the solid that wraps this curve's plane."""
    n, off, lo, hi = curve_bbox
    best = None
    for bb in breps:
        bl, bh = bb
        if not (bl[n] - tol <= off <= bh[n] + tol):
            continue
        if any(bh[i] < lo[i] - 1 or bl[i] > hi[i] + 1 for i in range(3)):
            continue
        # the curve is a single plane in n, so the solid's extent there is 2r
        r = (bh[n] - bl[n]) * 0.5
        # and it should sit centred on the curve's plane
        if abs((bl[n] + bh[n]) * 0.5 - off) > tol + 0.05:
            continue
        if best is None or r < best:
            best = r
    return best


def runs(path, tol):
    """Straight runs grouped by their constant coordinate, with the gaps.

    This is where loop spacing and wall thickness live: two parallel runs 8
    apart is the leg loop, 26 apart is the deck loop.
    """
    out = {}
    for i, axis in enumerate(('u', 'v')):
        vals = defaultdict(float)
        for s in path:
            if s['k'] != 'L':
                continue
            a, b = s['a'], s['b']
            if abs(a[i] - b[i]) <= tol:
                vals[round((a[i] + b[i]) * 0.5, 3)] += abs(a[1 - i] - b[1 - i])
        keep = sorted(v for v, L in vals.items() if L > tol * 10)
        out[axis] = {
            'at': keep,
            'gaps': [round(keep[k + 1] - keep[k], 3) for k in range(len(keep) - 1)],
        }
    return out


def rnd(o, nd):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [rnd(x, nd) for x in o]
    if isinstance(o, dict):
        return {k: rnd(v, nd) for k, v in o.items()}
    return o


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('-o', '--out')
    ap.add_argument('--tol', type=float, default=0.01,
                    help='how far off a line or arc a sample may be (mm)')
    ap.add_argument('--grid', type=float, default=0.05,
                    help='fingerprint grid for matching repeated curves (mm)')
    ap.add_argument('--samples', type=int, default=8,
                    help='points per segment used to classify it')
    ap.add_argument('--round', type=int, default=3, dest='nd')
    ap.add_argument('--layer', action='append',
                    help='only these layer names (repeatable)')
    ap.add_argument('--min-layers', type=int, default=1,
                    help='skip pieces stacked fewer times than this')
    args = ap.parse_args()

    f = rhino3dm.File3dm.Read(args.file)
    if f is None:
        sys.exit('could not read %s' % args.file)

    names = {l.Index: l.Name for l in f.Layers}
    want = set(args.layer) if args.layer else None

    breps, curves = [], []
    for o in f.Objects:
        g = o.Geometry
        lay = names.get(o.Attributes.LayerIndex, '')
        if want and lay not in want:
            continue
        if type(g).__name__ == 'Brep' or 'Extrusion' in type(g).__name__:
            bb = g.GetBoundingBox()
            breps.append((xyz(bb.Min), xyz(bb.Max)))
        elif hasattr(g, 'SegmentCount'):
            curves.append((g, lay))
        elif type(g).__name__ in ('LineCurve', 'ArcCurve', 'NurbsCurve'):
            curves.append((g, lay))

    groups = defaultdict(list)
    skipped = 0
    for crv, lay in curves:
        pl = plane_of(crv, args.tol)
        if pl is None:
            skipped += 1
            continue
        n, off, uv, lo, hi = pl
        path = read_path(crv, n, uv, args.samples, args.tol)
        lo2 = (lo[uv[0]], lo[uv[1]])
        sig, mirror = signature(path, lo2, (hi[uv[0]], hi[uv[1]]), args.grid)
        groups[(lay, n, sig)].append({
            'off': off, 'lo2': lo2, 'hi2': (hi[uv[0]], hi[uv[1]]),
            'mirror': mirror, 'path': path, 'uv': uv,
            'bbox': (n, off, lo, hi),
            'closed': bool(getattr(crv, 'IsClosed', False)),
        })

    pieces = []
    for (lay, n, _sig), members in sorted(groups.items(),
                                          key=lambda kv: -len(kv[1])):
        if len(members) < args.min_layers:
            continue
        # one instance per distinct in-plane position
        spots = defaultdict(list)
        for m in members:
            spots[(round(m['lo2'][0], 3), round(m['lo2'][1], 3),
                   m['mirror'])].append(m)
        rep = sorted(spots.values(), key=len)[-1][0]
        uv = rep['uv']
        o2 = rep['lo2']
        path = []
        for s in rep['path']:
            s = dict(s)
            for k in ('a', 'b', 'c', 'm'):
                if k in s:
                    s[k] = [s[k][0] - o2[0], s[k][1] - o2[1]]
            if 'v' in s:
                s['v'] = [[p[0] - o2[0], p[1] - o2[1]] for p in s['v']]
            path.append(s)

        insts = []
        for (ux, vy, mirror), ms in sorted(spots.items()):
            offs = sorted(m['off'] for m in ms)
            planes = sorted(set(round(v, 3) for v in offs))
            pitch = min((round(planes[k + 1] - planes[k], 3)
                         for k in range(len(planes) - 1)), default=None)
            insts.append({
                'at': [ux - o2[0], vy - o2[1]],
                'mirror': mirror,
                'layers': len(planes),
                'copies': len(ms) // max(len(planes), 1),
                'stack': [offs[0], offs[-1]],
                'pitch': pitch,
            })

        # ask every layer, and take the answer most of them agree on
        votes = defaultdict(int)
        for m in members:
            r = bead_radius(m['bbox'], breps, args.tol)
            if r is not None:
                votes[round(r, 3)] += 1
        bead = max(votes.items(), key=lambda kv: kv[1])[0] if votes else None
        planes = sorted(set(round(m['off'], 3) for m in members))
        pitch = min((round(planes[k + 1] - planes[k], 3)
                     for k in range(len(planes) - 1)), default=None)

        pieces.append({
            'name': (lay or 'piece') + '-%d' % (len(pieces) + 1),
            'layer': lay,
            'normal': AX[n],
            'axes': [AX[uv[0]], AX[uv[1]]],
            'origin': [o2[0], o2[1]],
            'size': [rep['hi2'][0] - o2[0], rep['hi2'][1] - o2[1]],
            'bead': bead,
            'pitch': pitch,
            'layers': len(planes),
            'closed': rep['closed'],
            'segments': len(path),
            'instances': insts,
            'measure': runs(path, args.tol),
            'path': path,
        })

    spec = {
        'source': args.file.split('/')[-1],
        'units': 'mm',
        'tol': args.tol,
        'curves': len(curves),
        'skipped_nonplanar': skipped,
        'pieces': pieces,
    }
    text = json.dumps(rnd(spec, args.nd), indent=1)
    if args.out:
        open(args.out, 'w').write(text + '\n')
        print('%s: %d pieces from %d curves' % (args.out, len(pieces), len(curves)))
        for p in pieces:
            print('  %-12s %s-plane  bead %s  pitch %s  %d layers x %d spots  %d segs'
                  % (p['name'], ''.join(p['axes']), p['bead'], p['pitch'],
                     p['layers'], len(p['instances']), p['segments']))
            for k, v in p['measure'].items():
                if v['gaps']:
                    print('        runs in %s at %s  gaps %s' % (k, v['at'], v['gaps']))
    else:
        print(text)


if __name__ == '__main__':
    main()
