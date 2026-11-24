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
/* how far apart two colours actually look, lightness and hue together */
function okDE(a, b){
  var A = oklab(a), B = oklab(b);
  return Math.sqrt(Math.pow(A[0]-B[0],2) + Math.pow(A[1]-B[1],2) + Math.pow(A[2]-B[2],2))*100;
}
var smooth = function(x, a, b){
  var t = Math.max(0, Math.min(1, (x - a)/(b - a)));
  return t*t*(3 - 2*t);
};

/* The exposure the key light needs for this pigment on this stage.
   A middling face is m*0.732; the floor is the stage's own wash. Open
   up until the two are plainly apart, but no further: past about a
   stop the pigment stops looking like itself, and an oxblood table
   lit until it is unmissable is just a red one. Most of the work is
   done by the room going deeper, which costs the pigment nothing -
   only graphite, moss and oxblood need the lamp touched at all. */
function expose(m, h, s, SL){
  var paper = toRGB(h, sat(s, 0.55), SL).map(function(v){ return v/255; });
  var ink   = toRGB(h, sat(s, 0.90), SL*0.17).map(function(v){ return v/255; });
  var grnd  = [0,1,2].map(function(i){ return paper[i] + (ink[i] - paper[i])*0.115; });
  var face  = function(f, k){
    return [0,1,2].map(function(i){
      return Math.min(1, m[i]*(0.12 + 1.02*f)*k + paper[i]*0.22*(1.0 - f)); });
  };
  var lo = 1.0, hi = 2.0, i, mid;
  for(i=0;i<18;i++){
    mid = (lo + hi)/2;
    if(okDE(face(0.60, mid), grnd) < 18.0) lo = mid; else hi = mid;
  }
  /* the square-on face at f = 1 is m*1.14, so this is the most the
     lamp can be opened before the brightest channel runs out of room */
  var clip = 1.02/Math.max(Math.max(m[0], Math.max(m[1], m[2]))*1.14, 1e-6);
  return Math.max(1.0, Math.min((lo + hi)/2, clip, 2.0));
}

/* Every name both stylesheets know, given the pigment's hue and a part
   of its saturation. The two schemes land in the same place now: the
   plates stop being paper and take the same dark ground the rest of
   the site is already on, so moving between them is one room. */
function vars(h, s, c0){
  /* The room is cut to the pigment standing in it. A dark pigment can
     only be seen in a room darker than it is, so the stage drops; a
     pale one needs no help and keeps the depth the rest of the site
     is on. Without this a graphite table came out a shade darker than
     the floor it stood on, which is to say invisible. */
  var m = [c0[0]/255, c0[1]/255, c0[2]/255];
  var SL = 3.8 + 7.0*smooth(okL(m), 0.26, 0.72);
  var ink = toRGB(h, sat(s, 0.18), 93);
  var a = function(x){ return 'rgba(' + ink[0] + ',' + ink[1] + ',' + ink[2] + ',' + x + ')'; };
  var inkHex = '#' + hex2(ink[0]) + hex2(ink[1]) + hex2(ink[2]);
  var dark = toRGB(h, sat(s, 0.70), 6.5);
  var darkHex = '#' + hex2(dark[0]) + hex2(dark[1]) + hex2(dark[2]);
  var scrim = function(x){ return 'rgba(' + dark[0] + ',' + dark[1] + ',' + dark[2] + ',' + x + ')'; };
  return {
    /* the plates - the configurators */
    '--paper':    hex(h, sat(s, 0.62), 11.0),   // the stage the object stands on
    '--ink':      inkHex,                       // and every mark made on it
    '--chrome':   darkHex,
    '--chrome-2': hex(h, sat(s, 0.66), 11.5),
    '--chrome-3': hex(h, sat(s, 0.72), 16.5),
    '--rule':      a('.18'),
    '--rule-soft': a('.09'),
    '--t1':        a('.94'),
    '--t2':        a('.58'),
    '--t3':        a('.34'),
    '--guide':     a('.82'),
    '--sel':       inkHex,
    /* What the shader is handed, which is not the same pair: the page
       wants ink to be the mark, the render wants it to be the far end
       of the light. Keeping them apart is the whole reason a plate can
       go dark without the shadow under the table coming out pale. */
    '--render-paper': hex(h, sat(s, 0.55), SL),
    '--render-ink':   hex(h, sat(s, 0.90), SL*0.17),
    /* and what the lamp is turned up to: expose for the subject, the
       way the room would be lit for it. Found by asking how far a
       typical lit face lands from the floor and opening up until it
       is clearly apart, which is why a saturated blue stops early -
       its hue does the separating and it would only clip. */
    '--render-expose': expose(m, h, s, SL).toFixed(4),
    /* the dark pages - style.css */
    '--bg':     darkHex,
    '--bg-2':   hex(h, sat(s, 0.60), 11.5),
    '--panel':  hex(h, sat(s, 0.62),  8.0),
    '--border': hex(h, sat(s, 0.52), 20.0),
    '--faint':  hex(h, sat(s, 0.46), 29.0),
    '--text':   hex(h, sat(s, 0.28), 95.5),
    '--text-2': hex(h, sat(s, 0.24), 84.0),
    '--text-3': hex(h, sat(s, 0.22), 60.0),
    '--muted':  hex(h, sat(s, 0.22), 48.0),
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
