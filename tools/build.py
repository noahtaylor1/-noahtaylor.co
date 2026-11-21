#!/usr/bin/env python3
"""
build.py -- design file to published page, in one command.

    python3 build.py rigs/ct1.json            # regenerate and inject
    python3 build.py rigs/ct1.json --extract  # re-read the .3dm first

A product file (the rig) says where its design file is, where the extracted
spec goes, and which page to inject the generated code into.  The page carries
a pair of markers for each language:

    // @gen:glsl ... // @end
    // @gen:js   ... // @end

Everything between a marker and its end is replaced, so the page keeps its own
camera, controls and copy, and only the geometry comes from Rhino.
"""

import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run(*cmd):
    r = subprocess.run([sys.executable] + list(cmd), cwd=HERE,
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stdout + r.stderr)
    return r.stdout.strip()


def inject(page, lang, body):
    src = open(page).read()
    pat = re.compile(r'(//[ \t]*@gen:%s[^\n]*\n)(.*?)([ \t]*//[ \t]*@end\b[^\n]*)'
                     % lang, re.S)
    if not pat.search(src):
        sys.exit('%s has no // @gen:%s ... // @end markers' % (page, lang))
    out, n = pat.subn(lambda m: m.group(1) + body.strip('\n') + '\n' + m.group(3),
                      src)
    changed = out != src
    if changed:
        open(page, 'w').write(out)
    return n, changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('rig')
    ap.add_argument('--extract', action='store_true',
                    help='re-read the design file before generating')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    rig = json.load(open(os.path.join(HERE, args.rig)
                         if not os.path.isabs(args.rig) else args.rig))
    spec = rig['spec']
    source = os.path.expanduser(rig.get('source', ''))
    page = rig.get('page')

    if args.extract or not os.path.exists(os.path.join(HERE, spec)):
        if not source or not os.path.exists(source):
            sys.exit('need the design file to extract: %r' % source)
        print(run('curve_extract.py', source, '-o', spec))

    gl = os.path.join(HERE, 'generated', os.path.basename(spec).replace('.json', '.glsl'))
    js = gl.replace('.glsl', '.js')
    cs = gl.replace('.glsl', '.consts.js')
    print(run('sdf_gen.py', spec, args.rig, '-o', gl, '--js', js,
              '--consts', cs, '--check'))

    if not page:
        return
    page = os.path.normpath(os.path.join(HERE, page))
    body = {'glsl': open(gl).read(), 'js': open(js).read(),
            'consts': open(cs).read()}
    for lang in ('consts', 'glsl', 'js'):
        text = '\n'.join(l for l in body[lang].splitlines()
                         if not l.startswith('// generated from'))
        if args.dry_run:
            print('would inject %d lines of %s into %s'
                  % (len(text.splitlines()), lang, page))
            continue
        n, changed = inject(page, lang, text)
        print('%s: %s %d block(s)' % (os.path.basename(page),
                                      'injected' if changed else 'unchanged', n))


if __name__ == '__main__':
    main()
