// generated from table ref.3dm by curve_extract.py + sdf_gen.py -- do not hand-edit
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

function pathLeg(px, py, zs){
  let d = 1e9;
  d = Math.min(d, sdArcSeg(px, py, 5.784, (-37.107 + S.H), 5.785, 0.0, (-37.0 + S.H), 1.137, (-33.661 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 9.724, (-39.973 + S.H), 10.657, 1.137, (-33.661 + S.H), 4.167, (-30.88 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 14.569, (-47.726 + S.H), 19.799, 4.167, (-30.88 + S.H), 9.862, (-28.495 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 16.74, (-55.414 + S.H), 27.784, 9.862, (-28.495 + S.H), 16.196, (-27.635 + S.H)));
  d = Math.min(d, sdSeg(px, py, 16.196, (-27.635 + S.H), 44.296, (-26.23 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 44.196, (-24.233 + S.H), 2.0, 44.296, (-26.23 + S.H), 46.196, (-24.233 + S.H)));
  d = Math.min(d, sdSeg(px, py, 46.196, (-24.233 + S.H), 46.196, (-22.038 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 44.196, (-22.038 + S.H), 2.0, 46.196, (-22.038 + S.H), 44.296, (-20.04 + S.H)));
  d = Math.min(d, sdSeg(px, py, 44.296, (-20.04 + S.H), 16.196, (-18.635 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 17.022, (7.891 + S.H), 26.539, 16.196, (-18.635 + S.H), 6.989, (-16.678 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 12.787, (-2.299 + S.H), 15.504, 6.989, (-16.678 + S.H), 2.418, (-13.825 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 7.699, (-7.926 + S.H), 7.918, 2.418, (-13.825 + S.H), 0.345, (-10.86 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, 5.333, (-8.974 + S.H), 5.333, 0.345, (-10.86 + S.H), 0.0, (-9.0 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, -4.0, (-9.0 + S.H), 4.0, 0.0, (-9.0 + S.H), -4.0, (-5.0 + S.H)));
  d = Math.min(d, sdArcSeg(px, py, -4.0, (-9.0 + S.H), 4.0, -4.0, (-5.0 + S.H), -8.0, (-9.0 + S.H)));
  d = Math.min(d, sdSeg(px, py, -8.0, (-9.0 + S.H), -8.0, 9.0));
  d = Math.min(d, sdArcSeg(px, py, -4.0, 9.0, 4.0, -8.0, 9.0, -4.0, 5.0));
  d = Math.min(d, sdArcSeg(px, py, -4.0, 9.0, 4.0, -4.0, 5.0, 0.0, 9.0));
  d = Math.min(d, sdSeg(px, py, 0.0, 9.0, 0.0, (-13.865 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 8.135, (-13.976 + zs), 8.136, 0.0, (-13.865 + zs), 1.808, (-8.862 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 10.83, (-16.137 + zs), 11.589, 1.808, (-8.862 + zs), 7.007, (-5.196 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 11.666, (-18.031 + zs), 13.655, 7.007, (-5.196 + zs), 11.089, (-4.388 + zs)));
  d = Math.min(d, sdSeg(px, py, 11.089, (-4.388 + zs), 39.189, (-2.983 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 39.089, (-0.986 + zs), 2.0, 39.189, (-2.983 + zs), 41.089, (-0.986 + zs)));
  d = Math.min(d, sdSeg(px, py, 41.089, (-0.986 + zs), 41.089, (1.209 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 39.089, (1.209 + zs), 2.0, 41.089, (1.209 + zs), 39.189, (3.207 + zs)));
  d = Math.min(d, sdSeg(px, py, 39.189, (3.207 + zs), 11.089, (4.612 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 11.605, (17.706 + zs), 13.104, 11.089, (4.612 + zs), 3.453, (7.446 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 9.296, (14.842 + zs), 9.426, 3.453, (7.446 + zs), 0.357, (11.852 + zs)));
  d = Math.min(d, sdArcSeg(px, py, 7.58, (14.152 + zs), 7.58, 0.357, (11.852 + zs), 0.0, (14.135 + zs)));
  d = Math.min(d, sdSeg(px, py, 0.0, (14.135 + zs), 0.0, (-37.0 + S.H)));
  return d - 5.0;
}

function pathDeck(px, py, zc){
  let d = 1e9;
  d = Math.min(d, sdArcSeg(px, py, (18.0 - S.Ly*0.5), (zc), 13.0, (18.0 - S.Ly*0.5), (13.0 + zc), (5.0 - S.Ly*0.5), (zc)));
  d = Math.min(d, sdArcSeg(px, py, (18.0 - S.Ly*0.5), (zc), 13.0, (5.0 - S.Ly*0.5), (zc), (18.0 - S.Ly*0.5), (-13.0 + zc)));
  d = Math.min(d, sdSeg(px, py, (18.0 - S.Ly*0.5), (-13.0 + zc), (-18.0 + S.Ly*0.5), (-13.0 + zc)));
  d = Math.min(d, sdArcSeg(px, py, (-18.0 + S.Ly*0.5), (zc), 13.0, (-18.0 + S.Ly*0.5), (-13.0 + zc), (-5.0 + S.Ly*0.5), (zc)));
  d = Math.min(d, sdArcSeg(px, py, (-18.0 + S.Ly*0.5), (zc), 13.0, (-5.0 + S.Ly*0.5), (zc), (-18.0 + S.Ly*0.5), (13.0 + zc)));
  d = Math.min(d, sdSeg(px, py, (-18.0 + S.Ly*0.5), (13.0 + zc), (18.0 - S.Ly*0.5), (13.0 + zc)));
  return d - 5.0;
}
