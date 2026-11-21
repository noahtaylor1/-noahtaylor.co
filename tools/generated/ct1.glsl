// generated from table ref.3dm by curve_extract.py + sdf_gen.py -- do not hand-edit
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

float pathLeg(vec2 p, float zs){
  float d = 1e9;
  d = min(d, sdArcSeg(p, vec2(5.784, (-37.107 + uH)), 5.785, vec2(0.0, (-37.0 + uH)), vec2(1.137, (-33.661 + uH))));
  d = min(d, sdArcSeg(p, vec2(9.724, (-39.973 + uH)), 10.657, vec2(1.137, (-33.661 + uH)), vec2(4.167, (-30.88 + uH))));
  d = min(d, sdArcSeg(p, vec2(14.569, (-47.726 + uH)), 19.799, vec2(4.167, (-30.88 + uH)), vec2(9.862, (-28.495 + uH))));
  d = min(d, sdArcSeg(p, vec2(16.74, (-55.414 + uH)), 27.784, vec2(9.862, (-28.495 + uH)), vec2(16.196, (-27.635 + uH))));
  d = min(d, sdSeg(p, vec2(16.196, (-27.635 + uH)), vec2(44.296, (-26.23 + uH))));
  d = min(d, sdArcSeg(p, vec2(44.196, (-24.233 + uH)), 2.0, vec2(44.296, (-26.23 + uH)), vec2(46.196, (-24.233 + uH))));
  d = min(d, sdSeg(p, vec2(46.196, (-24.233 + uH)), vec2(46.196, (-22.038 + uH))));
  d = min(d, sdArcSeg(p, vec2(44.196, (-22.038 + uH)), 2.0, vec2(46.196, (-22.038 + uH)), vec2(44.296, (-20.04 + uH))));
  d = min(d, sdSeg(p, vec2(44.296, (-20.04 + uH)), vec2(16.196, (-18.635 + uH))));
  d = min(d, sdArcSeg(p, vec2(17.022, (7.891 + uH)), 26.539, vec2(16.196, (-18.635 + uH)), vec2(6.989, (-16.678 + uH))));
  d = min(d, sdArcSeg(p, vec2(12.787, (-2.299 + uH)), 15.504, vec2(6.989, (-16.678 + uH)), vec2(2.418, (-13.825 + uH))));
  d = min(d, sdArcSeg(p, vec2(7.699, (-7.926 + uH)), 7.918, vec2(2.418, (-13.825 + uH)), vec2(0.345, (-10.86 + uH))));
  d = min(d, sdArcSeg(p, vec2(5.333, (-8.974 + uH)), 5.333, vec2(0.345, (-10.86 + uH)), vec2(0.0, (-9.0 + uH))));
  d = min(d, sdArcSeg(p, vec2(-4.0, (-9.0 + uH)), 4.0, vec2(0.0, (-9.0 + uH)), vec2(-4.0, (-5.0 + uH))));
  d = min(d, sdArcSeg(p, vec2(-4.0, (-9.0 + uH)), 4.0, vec2(-4.0, (-5.0 + uH)), vec2(-8.0, (-9.0 + uH))));
  d = min(d, sdSeg(p, vec2(-8.0, (-9.0 + uH)), vec2(-8.0, 9.0)));
  d = min(d, sdArcSeg(p, vec2(-4.0, 9.0), 4.0, vec2(-8.0, 9.0), vec2(-4.0, 5.0)));
  d = min(d, sdArcSeg(p, vec2(-4.0, 9.0), 4.0, vec2(-4.0, 5.0), vec2(0.0, 9.0)));
  d = min(d, sdSeg(p, vec2(0.0, 9.0), vec2(0.0, (-13.865 + zs))));
  d = min(d, sdArcSeg(p, vec2(8.135, (-13.976 + zs)), 8.136, vec2(0.0, (-13.865 + zs)), vec2(1.808, (-8.862 + zs))));
  d = min(d, sdArcSeg(p, vec2(10.83, (-16.137 + zs)), 11.589, vec2(1.808, (-8.862 + zs)), vec2(7.007, (-5.196 + zs))));
  d = min(d, sdArcSeg(p, vec2(11.666, (-18.031 + zs)), 13.655, vec2(7.007, (-5.196 + zs)), vec2(11.089, (-4.388 + zs))));
  d = min(d, sdSeg(p, vec2(11.089, (-4.388 + zs)), vec2(39.189, (-2.983 + zs))));
  d = min(d, sdArcSeg(p, vec2(39.089, (-0.986 + zs)), 2.0, vec2(39.189, (-2.983 + zs)), vec2(41.089, (-0.986 + zs))));
  d = min(d, sdSeg(p, vec2(41.089, (-0.986 + zs)), vec2(41.089, (1.209 + zs))));
  d = min(d, sdArcSeg(p, vec2(39.089, (1.209 + zs)), 2.0, vec2(41.089, (1.209 + zs)), vec2(39.189, (3.207 + zs))));
  d = min(d, sdSeg(p, vec2(39.189, (3.207 + zs)), vec2(11.089, (4.612 + zs))));
  d = min(d, sdArcSeg(p, vec2(11.605, (17.706 + zs)), 13.104, vec2(11.089, (4.612 + zs)), vec2(3.453, (7.446 + zs))));
  d = min(d, sdArcSeg(p, vec2(9.296, (14.842 + zs)), 9.426, vec2(3.453, (7.446 + zs)), vec2(0.357, (11.852 + zs))));
  d = min(d, sdArcSeg(p, vec2(7.58, (14.152 + zs)), 7.58, vec2(0.357, (11.852 + zs)), vec2(0.0, (14.135 + zs))));
  d = min(d, sdSeg(p, vec2(0.0, (14.135 + zs)), vec2(0.0, (-37.0 + uH))));
  return d - 5.0;
}

float pathDeck(vec2 p, float zc){
  float d = 1e9;
  d = min(d, sdArcSeg(p, vec2((18.0 - uLy*0.5), (zc)), 13.0, vec2((18.0 - uLy*0.5), (13.0 + zc)), vec2((5.0 - uLy*0.5), (zc))));
  d = min(d, sdArcSeg(p, vec2((18.0 - uLy*0.5), (zc)), 13.0, vec2((5.0 - uLy*0.5), (zc)), vec2((18.0 - uLy*0.5), (-13.0 + zc))));
  d = min(d, sdSeg(p, vec2((18.0 - uLy*0.5), (-13.0 + zc)), vec2((-18.0 + uLy*0.5), (-13.0 + zc))));
  d = min(d, sdArcSeg(p, vec2((-18.0 + uLy*0.5), (zc)), 13.0, vec2((-18.0 + uLy*0.5), (-13.0 + zc)), vec2((-5.0 + uLy*0.5), (zc))));
  d = min(d, sdArcSeg(p, vec2((-18.0 + uLy*0.5), (zc)), 13.0, vec2((-5.0 + uLy*0.5), (zc)), vec2((-18.0 + uLy*0.5), (13.0 + zc))));
  d = min(d, sdSeg(p, vec2((-18.0 + uLy*0.5), (13.0 + zc)), vec2((18.0 - uLy*0.5), (13.0 + zc))));
  return d - 5.0;
}
