#!/usr/bin/env python3
"""
sdf_gen.py -- turn an extracted toolpath spec into the shader and the script
the malleable pages raymarch.

curve_extract.py gives literal millimetres straight out of Rhino.  A rig file
says which of those numbers are parameters: the leg's head follows the height,
the returns follow whichever level they index into, the deck stretches.  Every
vertex coordinate is then either the literal from the design file or an
expression in those parameters.

    python3 sdf_gen.py specs/ct1.json rigs/ct1.json -o generated/ct1.glsl \
            --js generated/ct1.js --check

The rig, per piece:
  piece    the name in the spec (or its index)
  as       what to call the generated function
  offset   added to every vertex, for moving into the page's own frame
  scale    multiplied first, so [-1,1] mirrors a piece
  args     extra arguments the generated function takes, e.g. the level a
           deck sits at, so one function serves both levels
  rules    [{axis, in|ge|le, expr}] -- the first match wins, and the expression
           may use {u}/{v} for the literal and any declared symbol.  Both the
           thresholds and {u}/{v} are in the page's frame, i.e. after offset
           and scale, so a rule reads in the same numbers the page works in.
  symbols  {NAME: {glsl, js}} -- what a symbol is called in each output

The SDF it writes is the distance to the path.  The solid is that minus the
bead radius, which the function returns already subtracted unless --open.
"""

import argparse, json, math, sys

GLSL_PRELUDE = """\
// distance to a line segment
float sdSeg(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba*clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0));
}
// distance to the arc from e0 to e1 about c, the short way round
float sdArcSeg(vec2 p, vec2 c, float r, vec2 e0, vec2 e1){
  vec2 v = p - c, d0 = e0 - c, d1 = e1 - c;
  if(d0.x*d1.y - d0.y*d1.x < 0.0){ vec2 t = d0; d0 = d1; d1 = t; }
  if(d0.x*v.y - d0.y*v.x >= 0.0 && v.x*d1.y - v.y*d1.x >= 0.0)
    return abs(length(v) - r);
  return min(length(p - e0), length(p - e1));
}
"""

JS_PRELUDE = """\
function sdSeg(px, py, ax, ay, bx, by){
  const pax = px-ax, pay = py-ay, bax = bx-ax, bay = by-ay;
  const t = Math.min(1, Math.max(0, (pax*bax + pay*bay)/(bax*bax + bay*bay)));
  return Math.hypot(pax - bax*t, pay - bay*t);
}
function sdArcSeg(px, py, cx, cy, r, e0x, e0y, e1x, e1y){
  let vx = px-cx, vy = py-cy;
  let d0x = e0x-cx, d0y = e0y-cy, d1x = e1x-cx, d1y = e1y-cy;
  if(d0x*d1y - d0y*d1x < 0){ [d0x,d1x] = [d1x,d0x]; [d0y,d1y] = [d1y,d0y]; }
  if(d0x*vy - d0y*vx >= 0 && vx*d1y - vy*d1x >= 0)
    return Math.abs(Math.hypot(vx,vy) - r);
  return Math.min(Math.hypot(px-e0x, py-e0y), Math.hypot(px-e1x, py-e1y));
}
"""


def fnum(v):
    s = '%.4f' % v
    return s.rstrip('0').rstrip('.') + '.0' if s.rstrip('0').endswith('.') \
        else s.rstrip('0')


def which(val, axis, rules):
    """Index of the rule that claims this coordinate, or None."""
    for i, r in enumerate(rules):
        if r.get('axis', axis) != axis:
            continue
        if 'in' in r and not (r['in'][0] - 1e-6 <= val <= r['in'][1] + 1e-6):
            continue
        if 'ge' in r and val < r['ge'] - 1e-6:
            continue
        if 'le' in r and val > r['le'] + 1e-6:
            continue
        return i
    return None


def fold(e):
    """Sum the plain numbers in a flat a + b - c expression, for legibility.

    '-163.0 - uLy*0.5 + 181.0' reads better as '18.0 - uLy*0.5'.  Anything
    with brackets or anything else unexpected is left exactly as it came.
    """
    if any(ch in e for ch in '()'):
        return e
    terms, sign, cur = [], 1, ''
    for ch in e:
        if ch in '+-' and cur.strip() and not cur.strip()[-1] in '*/':
            terms.append((sign, cur.strip()))
            sign, cur = (1 if ch == '+' else -1), ''
        else:
            cur += ch
    terms.append((sign, cur.strip()))
    num, rest = 0.0, []
    for sg, t in terms:
        try:
            num += sg * float(t)
        except ValueError:
            rest.append((sg, t))
    out = ''
    if num or not rest:
        out = fnum(num)
    for sg, t in rest:
        if not out:
            out = ('-' if sg < 0 else '') + t
        else:
            out += (' + ' if sg > 0 else ' - ') + t
    return out


def coord(val, axis, rules, symbols, lang, forced=None):
    """One vertex coordinate: the literal, or the rule that claims it."""
    i = which(val, axis, rules) if forced is None else forced
    if i is None:
        return fnum(val)
    e = rules[i]['expr'].replace('{u}' if axis == 'u' else '{v}', fnum(val))
    for name, how in symbols.items():
        e = e.replace(name, how[lang] if isinstance(how, dict) else how)
    return '(' + fold(e) + ')'


def arc_parts(a, b, c, r, m, limit=120.0):
    """An arc split into pieces of at most `limit` degrees.

    The distance function picks the short way between two ends, so a piece has
    to stay well under a half turn for that to be the way the design meant.
    The sampled midpoint says which way round the original went.
    """
    def ang(p):
        return math.atan2(p[1] - c[1], p[0] - c[0])
    t0, t1 = ang(a), ang(b)
    ccw = (ang(m) - t0) % (2 * math.pi) <= (t1 - t0) % (2 * math.pi) if m else True
    sweep = ((t1 - t0) % (2 * math.pi)) if ccw else -((t0 - t1) % (2 * math.pi))
    n = max(1, int(math.ceil(abs(math.degrees(sweep)) / limit)))
    pts = []
    for k in range(n + 1):
        t = t0 + sweep * k / n
        pts.append([c[0] + r * math.cos(t), c[1] + r * math.sin(t)])
    pts[0], pts[-1] = list(a), list(b)       # keep the design's own endpoints
    return [(pts[k], pts[k + 1]) for k in range(n)]


def place(p, xy, scale, offset):
    return [xy[0] * scale[0] + offset[0], xy[1] * scale[1] + offset[1]]


def emit(piece, rig, lang):
    name = rig.get('as') or piece['name']
    fn = 'path' + ''.join(w.capitalize() for w in name.replace('-', ' ').split())
    scale = rig.get('scale', [1, 1])
    offset = rig.get('offset', [0, 0])
    rules = rig.get('rules', [])
    syms = rig.get('symbols', {})
    bead = 0.0 if rig.get('open') else (piece.get('bead') or 0.0)
    extra = rig.get('args', [])

    def XY(xy):
        return place(piece, xy, scale, offset)

    def V(xy, forced=(None, None)):
        x, y = XY(xy)
        return (coord(x, 'u', rules, syms, lang, forced[0]),
                coord(y, 'v', rules, syms, lang, forced[1]))

    def band(xy):
        x, y = XY(xy)
        return (which(x, 'u', rules), which(y, 'v', rules))

    lines = []
    for s in piece['path']:
        if s['k'] == 'P':
            v = s['v']
            pairs = [(V(v[i]), V(v[i + 1])) for i in range(len(v) - 1)]
            for a, b in pairs:
                lines.append(('seg', a, b, None))
            continue
        a, b = V(s['a']), V(s['b'])
        if s['k'] == 'L':
            lines.append(('seg', a, b, None))
        else:
            # the centre of an arc belongs to the same group as its ends, even
            # where it sits outside the band -- a long radius can have its
            # centre most of the way down the leg
            ba, bb = band(s['a']), band(s['b'])
            forced = tuple(ba[i] if ba[i] == bb[i] else None for i in (0, 1))
            c = V(s['c'], forced)
            r = s['r'] * abs(scale[0])
            # a mirror swaps which way round the arc runs; the short-way test
            # in the distance function reorders the ends itself, so only the
            # radius matters here -- but it needs pieces under a half turn
            for pa, pb in arc_parts(s['a'], s['b'], s['c'], s['r'], s.get('m')):
                lines.append(('arc', V(pa, forced), V(pb, forced), (c, r)))

    out = []
    if lang == 'glsl':
        sig = ', '.join(['vec2 p'] + extra)
        out.append('float %s(%s){' % (fn, sig))
        out.append('  float d = 1e9;')
        for kind, a, b, extra in lines:
            if kind == 'seg':
                out.append('  d = min(d, sdSeg(p, vec2(%s, %s), vec2(%s, %s)));'
                           % (a[0], a[1], b[0], b[1]))
            else:
                c, r = extra
                out.append('  d = min(d, sdArcSeg(p, vec2(%s, %s), %s, '
                           'vec2(%s, %s), vec2(%s, %s)));'
                           % (c[0], c[1], fnum(r), a[0], a[1], b[0], b[1]))
        out.append('  return d%s;' % ('' if bead == 0 else ' - ' + fnum(bead)))
        out.append('}')
    else:
        names = [a.split()[-1] for a in extra]
        out.append('function %s(%s){'
                   % (fn, ', '.join(['px', 'py'] + names)))
        out.append('  let d = 1e9;')
        for kind, a, b, extra in lines:
            if kind == 'seg':
                out.append('  d = Math.min(d, sdSeg(px, py, %s, %s, %s, %s));'
                           % (a[0], a[1], b[0], b[1]))
            else:
                c, r = extra
                out.append('  d = Math.min(d, sdArcSeg(px, py, %s, %s, %s, '
                           '%s, %s, %s, %s));'
                           % (c[0], c[1], fnum(r), a[0], a[1], b[0], b[1]))
        out.append('  return d%s;' % ('' if bead == 0 else ' - ' + fnum(bead)))
        out.append('}')
    return fn, '\n'.join(out), len(lines)


# ------------------------------------------------------------------ check

def sd_seg(p, a, b):
    pa = (p[0] - a[0], p[1] - a[1])
    ba = (b[0] - a[0], b[1] - a[1])
    dd = ba[0] * ba[0] + ba[1] * ba[1]
    t = 0.0 if dd < 1e-12 else max(0.0, min(1.0, (pa[0] * ba[0] + pa[1] * ba[1]) / dd))
    return math.hypot(pa[0] - ba[0] * t, pa[1] - ba[1] * t)


def sd_arc(p, c, r, e0, e1):
    v = (p[0] - c[0], p[1] - c[1])
    d0 = (e0[0] - c[0], e0[1] - c[1])
    d1 = (e1[0] - c[0], e1[1] - c[1])
    if d0[0] * d1[1] - d0[1] * d1[0] < 0:
        d0, d1 = d1, d0
    if d0[0] * v[1] - d0[1] * v[0] >= 0 and v[0] * d1[1] - v[1] * d1[0] >= 0:
        return abs(math.hypot(*v) - r)
    return min(math.hypot(p[0] - e0[0], p[1] - e0[1]),
               math.hypot(p[0] - e1[0], p[1] - e1[1]))


def check(piece):
    """The distance field has to vanish on the path it was built from."""
    prims = []
    for s in piece['path']:
        if s['k'] == 'P':
            v = s['v']
            prims += [('s', v[i], v[i + 1]) for i in range(len(v) - 1)]
        elif s['k'] == 'L':
            prims.append(('s', s['a'], s['b']))
        else:
            prims.append(('a', s['a'], s['b'], s['c'], s['r']))
    worst = 0.0
    for s in piece['path']:
        if s['k'] == 'A':
            c, r, a, b = s['c'], s['r'], s['a'], s['b']
            t0 = math.atan2(a[1] - c[1], a[0] - c[0])
            t1 = math.atan2(b[1] - c[1], b[0] - c[0])
            d = (t1 - t0) % (2 * math.pi)
            if d > math.pi:
                d -= 2 * math.pi
            pts = [(c[0] + r * math.cos(t0 + d * k / 12),
                    c[1] + r * math.sin(t0 + d * k / 12)) for k in range(13)]
        elif s['k'] == 'L':
            a, b = s['a'], s['b']
            pts = [(a[0] + (b[0] - a[0]) * k / 12, a[1] + (b[1] - a[1]) * k / 12)
                   for k in range(13)]
        else:
            pts = [tuple(p) for p in s['v']]
        for p in pts:
            d = min(sd_seg(p, q[1], q[2]) if q[0] == 's'
                    else sd_arc(p, q[3], q[4], q[1], q[2]) for q in prims)
            worst = max(worst, d)
    return worst


def consts(spec, rig):
    """The numbers the page would otherwise retype: bead, pitch, spacings.

    A name maps to a place in the spec -- 'leg.bead', 'leg.pitch',
    'leg.gap.u.0' for the first gap between the straight runs -- so the page
    cannot drift from the design file.
    """
    names = {}
    for r in rig.get('pieces', []):
        p = r.get('as') or r['piece']
        names[p] = r['piece']
    by = {pp['name']: pp for pp in spec['pieces']}
    out = []
    width = max((len(k) for k in rig.get('consts', {})), default=0)
    for name, where in rig.get('consts', {}).items():
        bits = where.split('.')
        piece = by[names.get(bits[0], bits[0])]
        if bits[1] == 'gap':
            val = piece['measure'][bits[2]]['gaps'][int(bits[3])]
        else:
            val = piece[bits[1]]
        out.append('const %-*s = %s;   // %s' % (width, name, val, where))
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('spec')
    ap.add_argument('rig', nargs='?')
    ap.add_argument('-o', '--out', help='GLSL out (default: stdout)')
    ap.add_argument('--js', help='also write the JS mirror here')
    ap.add_argument('--consts', help='also write the script constants here')
    ap.add_argument('--no-prelude', action='store_true')
    ap.add_argument('--module', action='store_true',
                    help='export the JS functions, for a module page')
    ap.add_argument('--check', action='store_true',
                    help='verify the field vanishes on the extracted path')
    args = ap.parse_args()

    spec = json.load(open(args.spec))
    whole = json.load(open(args.rig)) if args.rig else {}
    rigs = whole['pieces'] if args.rig else \
        [{'piece': p['name']} for p in spec['pieces']]

    by = {p['name']: p for p in spec['pieces']}
    head = '// generated from %s by curve_extract.py + sdf_gen.py -- do not hand-edit\n' \
           % spec.get('source', args.spec)

    gl, js, report = [], [], []
    for rig in rigs:
        key = rig['piece']
        piece = by.get(key) or spec['pieces'][int(key)]
        f, code, n = emit(piece, rig, 'glsl')
        gl.append(code)
        f2, code2, _ = emit(piece, rig, 'js')
        js.append(code2)
        line = '  %-18s %3d primitives  bead %s  pitch %s' % (
            f + '()', n, piece.get('bead'), piece.get('pitch'))
        if args.check:
            line += '  path error %.4f mm' % check(piece)
        report.append(line)

    gtext = head + ('' if args.no_prelude else GLSL_PRELUDE + '\n') + '\n\n'.join(gl) + '\n'
    jtext = head + ('' if args.no_prelude else JS_PRELUDE + '\n') + '\n\n'.join(js) + '\n'

    if args.out:
        open(args.out, 'w').write(gtext)
        print(args.out)
    else:
        print(gtext)
    if args.module:
        jtext = jtext.replace('\nfunction ', '\nexport function ')
    if args.js:
        open(args.js, 'w').write(jtext)
        print(args.js)
    if args.consts:
        open(args.consts, 'w').write(head + consts(spec, whole) + '\n')
        print(args.consts)
    print('\n'.join(report))


if __name__ == '__main__':
    main()
