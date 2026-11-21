# From the design file to the page

These products are a bead on a path. The solid is everything within one bead
radius of a curve, and the curve is stacked at the layer pitch up the print
direction — so the whole object is carried by a handful of curves and two
numbers. That is why the pages can raymarch them exactly rather than loading a
mesh, and why the geometry should come out of Rhino rather than being drawn
again by hand in the shader.

Three steps, each its own file, each readable on its own:

    curve_extract.py   .3dm           ->  specs/<product>.json    what the design is
    sdf_gen.py         spec + rig     ->  generated/<product>.*   what the page runs
    build.py           rig            ->  the page                puts it in

One command does all three:

```bash
python3 tools/build.py rigs/ct1.json --extract
```

Leave `--extract` off to regenerate from the spec already on disk — a second or
two, against a couple of seconds for a 250 MB .3dm.

## What to model

The extractor reads **toolpath curves**, not meshes. A mesh is the bead already
swept and tessellated, so every slice through it cuts the bead at an arbitrary
height: the same run measures 0.13 wide at one layer and 3.95 two layers up.
The curves are the truth.

It needs, in the file:

- **One planar curve per layer**, in the plane the piece is printed in. Flat in
  x, y or z; the axis it is flat in is taken as the print direction.
- **The stacked copies**, so the pitch can be read off the spacing between
  their planes. Duplicates on one plane are counted and ignored.
- **The swept solids** (Brep or extrusion) for at least some of those layers.
  The bead radius is read from how far a solid stands proud of its curve's
  plane, and the answer most layers agree on wins. Without solids the spec
  carries `bead: null` and the rig has to say it.

Mirrored copies of the same piece are recognised as the same piece: the two
legs come out as one path with two instances, one of them `mirror: -1`.

Layer names are used if the file has them (`--layer leg --layer deck`), and
are not needed otherwise — `table ref.3dm` keeps everything on Default and
still comes apart correctly, because the fingerprint is the shape of the curve.

## What comes out

Per piece: the plane, the print direction, the pitch, the bead, every instance
and where it sits, and the path itself as typed segments — lines, arcs with
centre and radius, and free-form blends fitted to the fewest arcs that hold
them to tolerance. Rhino blends are not single arcs: the leg's turn into its
return strays half a millimetre from any circle, and comes out as four.

There is also a `measure` block listing the straight runs and the gaps between
them. That is where the parameters live, and it is how the CT1 numbers were
found: the leg loop's two runs 8.0 apart, the deck loop's 26.0.

## The rig: which numbers are parameters

The design file is one fixed size. The rig says which of its millimetres move,
and it is the only hand-written file in the chain.

```json
{
 "source": "~/Downloads/table ref.3dm",
 "spec":   "specs/ct1.json",
 "page":   "../malleable-ct1/index.html",
 "consts": { "PIPE": "leg.bead", "LEGSP": "leg.gap.u.0" },
 "pieces": [
  { "piece": "Default-2", "as": "leg",
    "offset": [-8.0, 5.0],
    "args":   ["float zs"],
    "symbols": { "H": {"glsl": "uH", "js": "S.H"} },
    "rules": [ { "axis": "v", "ge": 340.0, "expr": "{v} + H - 390.083" } ] }
 ]
}
```

- `offset` / `scale` move the extracted curve into the frame the page works in,
  before anything else. CT1's leg is measured from its outer face with the
  floor at zero, so `[-8, 5]`.
- `rules` claim coordinates. The first one that matches wins, `{u}`/`{v}` is the
  literal out of the design file, and the thresholds are in the page's frame.
  **Write a rule as a shift of `{u}`/`{v}`, not as a replacement**: every point
  in a group then keeps its own place within that group, which is what makes a
  group of segments move together rather than collapse.
- `args` are extra arguments the generated function takes, so one function can
  serve two levels: CT1's deck is drawn twice, at `zc`.
- `symbols` is what each name is called in the shader and in the script.
- `consts` are numbers the page would otherwise retype — bead, pitch, loop
  spacings — read straight out of the spec so the page cannot drift from the
  file. `leg.gap.u.0` is the first gap between the leg's straight runs.

An arc's centre follows whichever group its ends are in, even where the centre
itself sits outside that band, so a long radius does not get left behind.

## The markers in the page

The page carries three marker pairs. Everything between a marker and its `@end`
is replaced on every build, and nothing else in the page is touched.

    // @gen:consts ... // @end     the numbers read off the design file
    // @gen:glsl   ... // @end     the distance functions, for the shader
    // @gen:js     ... // @end     the same again, for picking and the elevation

## Checking it

`--check` evaluates the generated distance field on the extracted path itself
and reports the worst miss. It has to vanish on the curve it was built from:
CT1 comes out at 0.0006 mm.

## Adding a product

1. Export the toolpath curves and the swept solids to a .3dm.
2. `python3 tools/curve_extract.py file.3dm -o specs/<name>.json` and read the
   summary — pieces, bead, pitch, and the gaps between the runs.
3. Write `rigs/<name>.json`: the frame each piece sits in, and a rule for every
   group that has to move.
4. Put the three marker pairs in the page.
5. `python3 tools/build.py rigs/<name>.json`.

## What it does not do yet

- Curves that are not planar, and pieces whose section changes as they stack,
  are skipped — the count shows in the spec as `skipped_nonplanar`.
- The sweep along the print direction, the ribs, the joint reveal and how far
  one piece reaches into another are still the page's own: the extractor gives
  the curve in its plane, not the whole solid.
- A rule is a shift. Anything that has to rotate or scale with a parameter has
  to be written in the page by hand.
