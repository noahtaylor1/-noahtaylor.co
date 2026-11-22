/* ════════════════════════════════════════════════════════════════════
   THE FINISH, AND WHAT IT DOES TO THE REST OF THE PAGE

   One list of colours for the whole site, kept where every page can
   read it, and a muted wash of whichever one is chosen laid over the
   chrome. The pigment itself only ever lands on the object; the page
   around it takes the same hue at a fraction of the saturation, so
   the plate still reads as paper and ink rather than as a poster.

   Two schemes, because the site runs in two: the dark pages that take
   style.css, and the light plates the configurators are drawn on.
   Both sets of names are written every time - a page simply ignores
   the ones it does not use.
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
/* Past a point more saturation in the pigment makes no difference to
   a wash this pale, so it is clamped before anything is taken off it. */
var sat = function(s, k){ return Math.min(s, 72)*k; };

/* every name both stylesheets know, given the pigment's hue and a
   small part of its saturation - enough that the page is plainly
   wearing the colour, never so much that it competes with the object */
function vars(h, s){
  var ink = toRGB(h, sat(s, 0.62), 12);
  var a = function(x){ return 'rgba(' + ink[0] + ',' + ink[1] + ',' + ink[2] + ',' + x + ')'; };
  var inkHex = '#' + hex2(ink[0]) + hex2(ink[1]) + hex2(ink[2]);
  var dark = toRGB(h, sat(s, 0.64), 6);
  var scrim = function(x){ return 'rgba(' + dark[0] + ',' + dark[1] + ',' + dark[2] + ',' + x + ')'; };
  return {
    /* the light plate - the configurators */
    '--paper':    hex(h, sat(s, 0.68), 94.6),
    '--ink':      inkHex,
    '--chrome':   hex(h, sat(s, 0.60), 96.6),
    '--chrome-2': hex(h, sat(s, 0.72), 91.0),
    '--chrome-3': hex(h, sat(s, 0.78), 86.2),
    '--rule':      a('.16'),
    '--rule-soft': a('.08'),
    '--t1':        a('.92'),
    '--t2':        a('.56'),
    '--t3':        a('.34'),
    '--guide':     a('.78'),
    '--sel':       inkHex,
    /* the dark pages - style.css */
    '--bg':     '#' + hex2(dark[0]) + hex2(dark[1]) + hex2(dark[2]),
    '--bg-2':   hex(h, sat(s, 0.60), 11.5),
    '--panel':  hex(h, sat(s, 0.62),  8.0),
    '--border': hex(h, sat(s, 0.52), 20.0),
    '--faint':  hex(h, sat(s, 0.46), 29.0),
    '--text':   hex(h, sat(s, 0.28), 95.5),
    '--text-2': hex(h, sat(s, 0.24), 84.0),
    '--text-3': hex(h, sat(s, 0.22), 60.0),
    '--muted':  hex(h, sat(s, 0.22), 48.0),
    '--scrim':      scrim('.86'),
    '--scrim-soft': scrim('.5')
  };
}

var NAMES = Object.keys(vars(0, 0));

function apply(tint){
  var root = document.documentElement, i;
  if(!tint){
    for(i=0;i<NAMES.length;i++) root.style.removeProperty(NAMES[i]);
  } else {
    var c = hsl(tint), v = vars(c[0], c[1]);
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
