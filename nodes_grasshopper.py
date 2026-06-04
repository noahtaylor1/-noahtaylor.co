"""
Nodes — Grasshopper Reverse-Engineered Script
Noah Taylor / Turf

Drop into a GHPython component with inputs:
  curves      (List of Curve)   — any intersecting 3D curves
  node_radius (float, default 3.0) — clash sphere radius; controls node size
  dowel_radius (float, default 1.2) — pipe radius for timber dowels

Outputs:
  node_geos   — Brep spheres for 3D printing (one per intersection)
  dowel_geos  — Cylinder Breps for each timber span
  node_pts    — centre points of each node (for reference / tagging)
  dowel_lengths — list of floats (cm) matching dowel_geos order
  tags        — sorted tag strings for cut sheet ("A1", "A2", ...)
  sorted_curves — input curves sorted bottom→top by midpoint Z
"""

import rhinoscriptsyntax as rs
import Rhino.Geometry as rg
import ghpythonlib.treehelpers as th
import math

# ─── 0. Sort curves bottom → top by midpoint Z ───────────────────────────────
def midpoint_z(crv):
    t = crv.Domain.ParameterAt(0.5)
    return crv.PointAt(t).Z

sorted_curves = sorted(curves, key=midpoint_z)

# ─── 1. Clash detection ───────────────────────────────────────────────────────
# For every unique pair of curves, find their closest approach.
# If distance < 2 × node_radius  →  intersection zone, create a node.

clash_threshold = node_radius * 2.0

node_origins  = []   # Point3d — centre of each node
clash_pairs   = []   # (i, j, tA, tB) — which curves and their t-params
visited_nodes = []   # avoid duplicate nodes from the same region

n = len(sorted_curves)
for i in range(n):
    for j in range(i + 1, n):
        cA = sorted_curves[i]
        cB = sorted_curves[j]

        # Find closest points between the two curves
        ok, tA, tB = rg.Curve.GetClosestPoints(cA, cB, 0.001)
        if not ok:
            continue

        pA = cA.PointAt(tA)
        pB = cB.PointAt(tB)
        dist = pA.DistanceTo(pB)

        if dist > clash_threshold:
            continue  # no clash

        # Node origin = midpoint of the two closest points
        origin = rg.Point3d(
            (pA.X + pB.X) * 0.5,
            (pA.Y + pB.Y) * 0.5,
            (pA.Z + pB.Z) * 0.5,
        )

        # Deduplicate: skip if we already have a node within node_radius
        duplicate = any(origin.DistanceTo(existing) < node_radius * 1.5
                        for existing in node_origins)
        if duplicate:
            continue

        node_origins.append(origin)
        clash_pairs.append((i, j, tA, tB))

# ─── 2. Node geometry (sphere) ───────────────────────────────────────────────
node_geos = []
node_pts  = node_origins[:]

for pt in node_origins:
    sphere = rg.Sphere(pt, node_radius)
    node_geos.append(sphere.ToBrep())

# ─── 3. Trim curves at clash zones → dowel spans ─────────────────────────────
# For each curve, collect all the t-parameters where it enters/exits a node.
# Trim those regions out; remaining segments become dowels.

# Map curve index → list of (t_enter, t_exit) clash intervals
clash_intervals = {i: [] for i in range(n)}

for (ci, cj, tA, tB) in clash_pairs:
    for (cidx, t_center) in [(ci, tA), (cj, tB)]:
        crv = sorted_curves[cidx]
        # Find the t-params where the node sphere intersects the curve
        # Approximation: walk ±node_radius along the curve from t_center
        length_in = crv.GetLength()
        # Convert node_radius to t-param delta (approximate)
        dt = crv.Domain.Length * (node_radius / max(length_in, 0.001))
        t_lo = max(crv.Domain.Min, t_center - dt)
        t_hi = min(crv.Domain.Max, t_center + dt)
        clash_intervals[cidx].append((t_lo, t_hi))

dowel_geos    = []
dowel_lengths = []
dowel_tags    = []
tag_counter   = 1

for ci, crv in enumerate(sorted_curves):
    intervals = sorted(clash_intervals[ci], key=lambda x: x[0])

    # Merge overlapping intervals
    merged = []
    for lo, hi in intervals:
        if merged and lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append([lo, hi])

    # Build list of span domains (the gaps between intervals)
    domain = crv.Domain
    span_params = [domain.Min]
    for lo, hi in merged:
        span_params.append(lo)
        span_params.append(hi)
    span_params.append(domain.Max)

    for k in range(0, len(span_params) - 1, 2):
        t0, t1 = span_params[k], span_params[k + 1]
        if abs(t1 - t0) < 1e-6:
            continue

        segment = crv.Trim(t0, t1)
        if segment is None:
            continue

        seg_len = segment.GetLength()
        if seg_len < node_radius * 0.5:  # too short to be a real dowel
            continue

        # Create a pipe (cylinder) along the segment
        pipe_breps = rg.Brep.CreatePipe(
            segment,
            dowel_radius,
            False,
            rg.PipeCapMode.Flat,
            True,
            0.001,
            0.001
        )
        for b in pipe_breps:
            dowel_geos.append(b)
            dowel_lengths.append(round(seg_len, 1))
            dowel_tags.append("D{:02d}".format(tag_counter))
            tag_counter += 1

# ─── 4. Engrave tag numbers into node ends ───────────────────────────────────
# In Rhino/GH: use TextObject → Extrude → BooleanDifference from the sphere.
# This step is left as manual GH wiring (needs access to the font mesh).
# Pseudo-code:
#
#   for each dowel end point near a node:
#       text_crv  = TextObject(tag, plane_at_dowel_end, height=node_radius*0.35)
#       text_srf  = Extrude(text_crv, normal * node_radius * 0.3)
#       node_brep = BooleanDifference(node_brep, text_srf)
#
# In practice: use the "Text Object" component (Params > Geometry > Text Object)
# piped into Boundary Surface + Extrude + Solid Difference.

# ─── 5. Assign outputs ───────────────────────────────────────────────────────
tags = dowel_tags
# node_geos, dowel_geos, node_pts, dowel_lengths, tags, sorted_curves
# are all set above and will auto-bind to GHPython output params.

# ─── 6. Cut sheet (optional: pipe to Panel or TT Toolbox Excel export) ───────
cut_sheet_rows = ["Tag\tLength(mm)\tComponent"]
for tag, length in zip(dowel_tags, dowel_lengths):
    cut_sheet_rows.append("{}\t{}\tDowel".format(tag, length))

cut_sheet = "\n".join(cut_sheet_rows)
