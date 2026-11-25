/* ════════════════════════════════════════════════════════════════════
   THE FINISH, AND WHAT IT DOES TO THE REST OF THE PAGE

   One list of colours for the whole site, kept where every page can
   read it. A pigment is a thing in a room, so choosing one puts the
   whole site in that room: a deep, nearly black wash of the same hue
   over every surface, with the type and the rules sitting on it in a
   pale one. The pigment itself still only ever lands on the object -
   it is the only thing on the page at full strength.

   Two schemes, because the site runs in two: the dark pages that take
   style.css, and the plates the configurators are drawn on, which are
   paper until a finish is chosen and the same dark ground after. Both
   sets of names are written every time - a page simply ignores the
   ones it does not use, and Raw takes every one of them back off.
   ════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* Twelve pigments, four families of three. Index 0 is no pigment at
   all - the drawing as it comes off the machine. */
var FINISH = [
  { name:'Raw',         hex:null      },
  { name:'Graphite',    hex:'#1C1D20' },
  { name:'Ultramarine', hex:'#01029D' },
  { name:'Ice',         hex:'#DAE6FC' },
  { name:'Moss',        hex:'#202E08' },
  { name:'Fern',        hex:'#2B5523' },
  { name:'Acid',        hex:'#D9FD6D' },
  { name:'Ochre',       hex:'#C89031' },
  { name:'Amber',       hex:'#F5C46C' },
  { name:'Bone',        hex:'#FBEDC5' },
  { name:'Oxblood',     hex:'#5B0F07' },
  { name:'Crimson',     hex:'#971D1F' },
  { name:'Rust',        hex:'#993E18' }
];
var KEY = 'malleable.finish';

function rgb(hex){
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
function hsl(hex){
  var c = rgb(hex), r = c[0]/255, g = c[1]/255, b = c[2]/255;
  var mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2, h = 0, s = 0;
  if(mx !== mn){
    var d = mx - mn;
    s = l > 0.5 ? d/(2-mx-mn) : d/(mx+mn);
    h = mx === r ? (g-b)/d + (g < b ? 6 : 0) : mx === g ? (b-r)/d + 2 : (r-g)/d + 4;
    h *= 60;
  }
  return [h, s*100, l*100];
}
/* back out of hsl, because the rules and the type are given as the ink
   at an alpha and so need the three numbers, not a string */
function toRGB(h, s, l){
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  var c = (1 - Math.abs(2*l - 1))*s, x = c*(1 - Math.abs((h/60) % 2 - 1)), m = l - c/2;
  var t = h < 60  ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x]
        : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
  return [Math.round((t[0]+m)*255), Math.round((t[1]+m)*255), Math.round((t[2]+m)*255)];
}
var hex2 = function(n){ return (n < 16 ? '0' : '') + n.toString(16); };
function hex(h, s, l){
  var c = toRGB(h,s,l);
  return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
}
/* Past a point more saturation makes no difference at these depths, so
   it is clamped before anything is taken off it. */
var sat = function(s, k){ return Math.min(s, 72)*k; };

/* How light the pigment actually looks, which is not its hsl lightness:
   a saturated blue at 31% reads nearly black and a yellow at 71% reads
   nearly white. Oklab's L is the one number that gets that right, and
   two things downstream need it - how deep the room goes, and how hard
   the lamp has to work. */
function oklab(c){
  var f = function(u){ u = Math.max(0, Math.min(1, u));
                       return u <= 0.04045 ? u/12.92 : Math.pow((u + 0.055)/1.055, 2.4); };
  var r = f(c[0]), g = f(c[1]), b = f(c[2]);
  var cr = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b),
      cg = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b),
      cb = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [0.2104542553*cr + 0.7936177850*cg - 0.0040720468*cb,
          1.9779984951*cr - 2.4285922050*cg + 0.4505937099*cb,
          0.0259040371*cr + 0.7827717662*cg - 0.8086757660*cb];
}
var okL = function(c){ return oklab(c)[0]; };
/* The hsl lightness that lands this hue, at this saturation, on a
   wanted Oklab lightness. No closed form, so it is simply found. */
function solveL(h, s, target){
  var lo = 0, hi = 100, i, mid;
  for(i=0;i<22;i++){
    mid = (lo + hi)/2;
    if(okL(toRGB(h, s, mid).map(function(v){ return v/255; })) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi)/2;
}

/* ────────────────────────────────────────────────────────────────
   Every name both stylesheets know, given the pigment.

   The room does not move. All twelve put the site in the same low
   room, at one depth, carrying nothing of the pigment but a cast of
   its hue - so choosing a finish changes the temperature of the page
   and never its key. A page that flips from near-black to near-white
   between two swatches is not a room, it is a light switch.

   What moves is the sweep behind the object, which is the only thing
   that has to separate from it. It is placed opposite the pigment:
   a dark one gets a lit sweep and reads as a dark object against it,
   a pale one - bone, ice, acid, amber - gets a dim one and reads as
   a pale object against that. The sweep lives inside the plate, the
   way a backdrop lives inside a studio, and the room around it stays
   where it was. Nothing is ever done to the pigment itself: it lands
   on the object at full strength and is left alone.

   Which way the sweep goes is decided on how light a middling lit
   face actually looks, not on the pigment's own hsl lightness,
   because a saturated blue at 31% reads nearly black.
   ──────────────────────────────────────────────────────────────── */
function vars(h, s, c0){
  var m = [c0[0]/255, c0[1]/255, c0[2]/255];
  /* a middling lit face, the same one the shader draws */
  var fL = okL(m.map(function(v){ return Math.min(1, v*0.732); }));
  var lit = fL < 0.56;             // does this pigment want a lit sweep
  /* the room carries only a cast of the pigment, the way a wall does */
  var RS = sat(s, 0.14);
  /* One depth for every pigment. The page has nothing to separate
     from, so it has no reason to move. */
  var PL   = solveL(h, RS, 0.28);
  var room = hex(h, RS, PL);
  /* Far enough from the lit face to be plain, and no further - the
     ceiling is only as high as the one mid pigment needs. */
  var tgt = lit ? Math.min(Math.max(fL + 0.34, 0.52), 0.86)
                : Math.min(Math.max(fL - 0.34, 0.14), 0.32);
  var SL    = solveL(h, RS, tgt);
  var stage = hex(h, RS, SL);

  /* what a mark is made in: pale on the page, which is always dim,
     and whichever way the sweep went on the sweep */
  var mark = toRGB(h, sat(s, 0.16), 95);
  var a = function(x){ return 'rgba(' + mark[0] + ',' + mark[1] + ',' + mark[2] + ',' + x + ')'; };
  var markHex = '#' + hex2(mark[0]) + hex2(mark[1]) + hex2(mark[2]);
  /* the far end of the light, which is dark against either sweep, or
     the shadow under the part comes out brighter than the floor */
  var deep = hex(h, sat(s, lit ? 0.55 : 0.60), lit ? 18 : SL*0.26);
  /* The frosted nav bar and the wash under a card's caption are the
     room seen through glass, not a dark overlay laid over it. */
  var sb = toRGB(h, RS, PL*0.55);
  var scrim = function(x){
    return 'rgba(' + sb[0] + ',' + sb[1] + ',' + sb[2] + ',' + x + ')'; };
  var step = function(d){ return hex(h, RS*0.8, Math.min(Math.max(PL + d, 2), 97)); };
  /* and the same thing for the sweep, which the hint sits on */
  var rm = toRGB(h, sat(s, 0.16), lit ? 14 : 95);
  var renderMark = '#' + hex2(rm[0]) + hex2(rm[1]) + hex2(rm[2]);

  return {
    /* the plates - the configurators */
    '--paper':    room,                        // the room the plate is in
    '--ink':      markHex,                     // and every mark made in it
    '--chrome':   step(-2),
    '--chrome-2': step(2),
    '--chrome-3': step(6),
    '--rule':      a('.16'),
    '--rule-soft': a('.08'),
    '--t1':        a('.94'),
    '--t2':        a('.58'),
    '--t3':        a('.34'),
    '--guide':     a('.82'),
    '--sel':       markHex,
    /* What the shader is handed, and what is drawn over it. These are
       not the page's pair: the sweep can be lit while the room around
       it stays dim, so a mark on the sweep and a mark on the page are
       made in different colours, and render-ink is the far end of the
       light rather than either of them. */
    '--render-paper': stage,
    '--render-ink':   deep,
    '--render-mark':  renderMark,
    '--render-t3':    'rgba(' + rm[0] + ',' + rm[1] + ',' + rm[2] + ',.4)',
    '--render-dark':  lit ? '0' : '1',
    /* the rest of the site - style.css */
    '--bg':     room,
    '--bg-2':   step(3),
    '--panel':  step(-2),
    '--border': hex(h, RS*0.9, PL + 14),
    '--faint':  hex(h, RS*0.9, PL + 20),
    '--text':   markHex,
    '--text-2': hex(h, sat(s, 0.15), 84),
    '--text-3': hex(h, sat(s, 0.15), 70),
    '--muted':  hex(h, sat(s, 0.15), 66),
    '--scrim':      scrim('.86'),
    '--scrim-soft': scrim('.5'),
    /* the scrollbars and the form controls go with it */
    'color-scheme': 'dark'
  };
}

var NAMES = Object.keys(vars(0, 0, [128,128,128]));

function apply(tint){
  var root = document.documentElement, i;
  if(!tint){
    for(i=0;i<NAMES.length;i++) root.style.removeProperty(NAMES[i]);
  } else {
    var c = hsl(tint), v = vars(c[0], c[1], rgb(tint));
    for(i=0;i<NAMES.length;i++) root.style.setProperty(NAMES[i], v[NAMES[i]]);
  }
  bar();
}

/* The phone's own chrome, so the notch does not sit in the old colour.
   Which colour that is depends on the page: both sets of names are
   written to the root whether the page uses them or not, so the only
   honest answer is whatever the body actually ended up painted. */
function bar(){
  if(!document.body) return;
  var bg = getComputedStyle(document.body).backgroundColor;
  if(!bg || bg === 'transparent' || /,\s*0\)$/.test(bg)) return;
  var m = document.querySelector('meta[name="theme-color"]');
  if(!m){ m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
  m.setAttribute('content', bg);
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar);
else bar();

/* One finish for the whole object, held as a hex or as nothing at all. */
function read(){
  try {
    var o = JSON.parse(localStorage.getItem(KEY) || 'null');
    if(typeof o === 'string') return o;
    if(o && typeof o === 'object') return o.color || o.top || null;
  } catch(e){}
  return null;
}
function write(c){
  c = c || null;
  try { localStorage.setItem(KEY, JSON.stringify({ color:c })); } catch(e){}
  apply(c);
  window.dispatchEvent(new CustomEvent('finishchange', { detail:{ color:c } }));
}

apply(read());
/* a second tab, or the page the choice was made on, left open behind */
window.addEventListener('storage', function(e){
  if(e.key !== KEY) return;
  var c = read();
  apply(c);
  window.dispatchEvent(new CustomEvent('finishchange', { detail:{ color:c } }));
});

window.Finish = { list:FINISH, get:read, set:write, apply:apply, key:KEY };
})();
