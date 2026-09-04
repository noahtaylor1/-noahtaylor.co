/* Ginger Web Slicer -- UI + preview (three.js r128) */
(function () {
  "use strict";

  // ------------------------------------------------------------ settings
  // Defaults mirror rhino_curve_to_gcode_ginger_g1.py (8mm nozzle,
  // Generic PETG GF standards: bed 65, zones 190, retraction 100@50,
  // PA 0.3/0.5, rotation 456/8000, flat 11mm/s, accel 500).
  // Mirrors NOZZLE_PROFILES in rhino_curve_to_gcode_ginger_g1.py. Widths are
  // nozzle_diameter x 1.2 (EXTRUSION_WIDTH_MULTIPLIER) except 8mm, which has a
  // confirmed override (9.5) from a real OrcaSlicer process profile. Max layer
  // height is that script's per-nozzle physical clamp on LAYER_HEIGHT/spacing.
  var NOZZLE_WIDTHS = { "8": 9.5, "5": 6.0, "3": 3.6, "1.8": 2.16, "1": 1.2 };
  var NOZZLE_MAX_LAYER_HEIGHT = { "8": 5.0, "5": 3.5, "3": 2.5, "1.8": 2.5, "1": 1.8 };

  var SCHEMA = [
    { group: "Model" },
    { key: "units", label: "Model units", type: "select", options: ["mm", "cm", "m", "inches"], value: "inches" },
    { key: "upAxis", label: "Up axis", type: "select", options: ["auto", "Y up", "Z up"], value: "auto" },
    { key: "scalePct", label: "Scale (%)", type: "num", value: 100, step: 5, min: 1 },

    // Position / clipping. Z reference: the model's own base normalizes to
    // Z=0, so every number below reads as a height above that base. Two
    // independent horizontal planes cut the part, and either can be dragged
    // in the viewport: the BOTTOM plane throws away everything under it (the
    // classic way to give a rounded or ragged bottom a real flat footprint)
    // and the TOP plane throws away everything over it (for a rim that came
    // out of Gravity Sketch a few mm off level). Both cuts are left OPEN
    // (uncapped) because an open planar rim is exactly the boundary the
    // spiral slicer keys off. Whatever survives between the planes is what
    // prints, dropped back onto the plate at "Height off build plate".
    { group: "Position / clipping" },
    { key: "clipBotOn", label: "Bottom clipping plane (flatten the bottom)", type: "check", value: true },
    { key: "clipBotZ", label: "Bottom plane height (mm above base)", type: "num", value: 0, step: 1 },
    { key: "clipTopOn", label: "Top clipping plane (flatten the top)", type: "check", value: false },
    { key: "clipTopZ", label: "Top plane height (mm above base)", type: "num", value: 100, step: 1 },
    { key: "showClipPlanes", label: "Show clip planes in preview", type: "check", value: true },

    { group: "Toolpath" },
    { key: "spacing", label: "Distance between revolutions (mm)", type: "num", value: 2, step: 0.5, min: 0.2 },
    { key: "baseOn", label: "Close the bottom (flat base spiral)", type: "check", value: true },
    { key: "baseSpacing", label: "Base spiral pass spacing (mm)", type: "num", value: 9.5, step: 0.5, min: 0.5 },
    { key: "ptsPerRev", label: "Points per revolution", type: "num", value: 256, step: 16, min: 32 },
    { key: "seamAtLowest", label: "Seam at bottom edge (lowest point)", type: "check", value: false },
    { key: "seamDeg", label: "Seam angle (deg)", type: "num", value: 0, step: 15, min: -360 },
    { key: "traceTopRim", label: "Trace top rim (finish loop)", type: "check", value: true },
    { key: "removeTopRevs", label: "Remove top revolutions (taper fix)", type: "num", value: 1, step: 1, min: 0 },
    { key: "smoothingOn", label: "Curve smoothing (de-jag)", type: "check", value: true },
    { key: "smoothing", label: "Smoothing strength (iterations)", type: "num", value: 3, step: 1, min: 1 },
    { key: "heightOffPlate", label: "Height off build plate (mm)", type: "num", value: 4.1, step: 0.1, min: 0 },

    { group: "Preview bead" },
    { key: "visualBeadWidth", label: "Visual bead width (mm)", type: "num", value: 9, step: 0.5, min: 0.2 },
    { key: "visualBeadHeight", label: "Visual bead height (mm)", type: "num", value: 3, step: 0.5, min: 0.2 },

    { group: "Nozzle / Extrusion" },
    { key: "nozzle", label: "Nozzle size (mm)", type: "select", options: ["8", "5", "3", "1.8", "1"], value: "8" },
    { key: "extrusionWidth", label: "Extrusion width (mm)", type: "num", value: 9.5, step: 0.1, min: 0.2 },
    { key: "extrusionMultiplier", label: "Extrusion rate (flow multiplier)", type: "num", value: 1.0, step: 0.01, min: 0 },
    { key: "maxVolumetricSpeed", label: "Max volumetric speed (mm^3/s)", type: "num", value: 200, step: 5, min: 1 },

    { group: "Speed" },
    { key: "printSpeed", label: "Print speed (mm/s) -- flat rate", type: "num", value: 11, step: 1, min: 0.5 },
    { key: "travelSpeed", label: "Travel speed (mm/s)", type: "num", value: 11, step: 1, min: 0.5 },
    { key: "zTravelSpeed", label: "Z travel speed (mm/s)", type: "num", value: 33.3, step: 1, min: 0.5 },

    { group: "Acceleration" },
    { key: "accelPrint", label: "Print accel (mm/s^2)", type: "num", value: 500, step: 50, min: 10 },
    { key: "accelTravel", label: "Travel accel (mm/s^2)", type: "num", value: 1000, step: 50, min: 10 },
    { key: "squareCornerVelocity", label: "Square corner velocity (mm/s)", type: "num", value: 3, step: 1, min: 0 },

    { group: "Retraction (end of print)" },
    { key: "retractLength", label: "Retraction length (mm)", type: "num", value: 100, step: 5, min: 0 },
    { key: "retractSpeed", label: "Retraction speed (mm/s)", type: "num", value: 50, step: 5, min: 1 },

    { group: "Pressure advance / rotation" },
    { key: "pressureAdvance", label: "Pressure advance", type: "num", value: 0.3, step: 0.01, min: 0 },
    { key: "pressureAdvanceSmoothTime", label: "PA smooth time", type: "num", value: 0.5, step: 0.01, min: 0 },
    { key: "extruderRotationVolume", label: "Extruder rotation volume", type: "num", value: 456, step: 1, min: 1 },
    { key: "mixingStepperRotationVolume", label: "Mixing stepper rotation volume", type: "num", value: 8000, step: 10, min: 1 },

    { group: "Temperatures" },
    { key: "zone1Temp", label: "Extruder 0 / Zone 1 (C)", type: "num", value: 190, step: 5, min: 0 },
    { key: "zone2Temp", label: "Extruder 1 / Zone 2 (C)", type: "num", value: 190, step: 5, min: 0 },
    { key: "zone3Temp", label: "Extruder 2 / Zone 3 (C)", type: "num", value: 190, step: 5, min: 0 },
    { key: "bedTemp", label: "Bed temp (C)", type: "num", value: 65, step: 5, min: 0 },

    { group: "Machine / bed" },
    { key: "leveling", label: "Bed leveling at print start", type: "check", value: false },
    { key: "autoCenter", label: "Auto-center on bed", type: "check", value: true },
    { key: "bedCenterX", label: "Bed center X (mm)", type: "num", value: 400, step: 10, min: 0 },
    { key: "bedCenterY", label: "Bed center Y (mm)", type: "num", value: 400, step: 10, min: 0 },
    { key: "bedRotationDeg", label: "Rotation on bed (deg)", type: "num", value: 0, step: 5, min: -360 },
    { key: "purgeQuantity", label: "Purge quantity", type: "num", value: 5000, step: 500, min: 0 },

    { group: "Printer" },
    { key: "relayUrl", label: "Relay URL", type: "text", value: "https://applemachine.local:9876" },
    { key: "relayToken", label: "Relay token", type: "text", value: "" },
    { key: "sendStart", label: "Start print after send", type: "check", value: false }
  ];

  // Printer settings persist per-device (the token never ships in this file)
  var PERSIST_KEYS = ["relayUrl", "relayToken", "sendStart"];

  // Settings whose change requires RE-SLICING (geometry changes); everything
  // else only needs the preview/gcode rebuilt. Any button press updates the
  // model automatically -- no need to hit Slice again by hand.
  var RESLICE_KEYS = ["units", "upAxis", "scalePct", "spacing", "baseOn", "baseSpacing",
                      "ptsPerRev", "seamDeg", "seamAtLowest", "traceTopRim",
                      "removeTopRevs", "smoothingOn", "smoothing",
                      "clipBotOn", "clipBotZ", "clipTopOn", "clipTopZ"];

  // Settings that change the MESH itself, so the ghost has to be rebuilt (not
  // just re-placed) before the re-slice runs.
  var GHOST_KEYS = ["units", "upAxis", "scalePct",
                    "clipBotOn", "clipBotZ", "clipTopOn", "clipTopZ"];

  var S = {};                 // live settings values
  var inputs = {};
  var viewMode = "model";     // "model" | "slice" | "curve" | "heat"

  // ------------------------------------------------------------ app state
  var rawSoup = null;         // Float64Array soup in file coordinates
  var rawName = "model";
  var fileKind = "";          // fbx/obj/stl
  var lastSliced = null;      // slicePath() result (model coords, mm, Z-up)
  var lastGcode = null;

  // ------------------------------------------------------------- 3D scene
  THREE.Object3D.DefaultUp = new THREE.Vector3(0, 0, 1);
  var viewport = document.getElementById("viewport");
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  viewport.appendChild(renderer.domElement);
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171c);
  var camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  camera.position.set(700, -500, 500);
  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(400, 400, 100);

  // Lighting tuned so bead relief reads at EVERY angle: low ambient for
  // contrast, hemisphere fill so undersides never go black, a fixed key for
  // consistent shape shading, and a HEADLIGHT that follows the camera at a
  // slight offset (offset so it always grazes the bead ridges -- a dead-on
  // light would flatten them).
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  var hemi = new THREE.HemisphereLight(0xcdd6e4, 0x3a332b, 0.45);
  scene.add(hemi);
  var keyLight = new THREE.DirectionalLight(0xffffff, 0.5);
  keyLight.position.set(300, -400, 600);
  scene.add(keyLight);
  var headLight = new THREE.DirectionalLight(0xffffff, 0.55);
  scene.add(headLight);
  scene.add(headLight.target);

  // bed grid 800x800 centered at (400,400)
  var grid = new THREE.GridHelper(800, 40, 0x3a4250, 0x242a33);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(400, 400, 0);
  scene.add(grid);
  var axes = new THREE.AxesHelper(60);
  scene.add(axes);

  // bedGroup carries the on-bed placement (position + Z rotation about the
  // part's pivot); previewGroup inside holds path + ghost in model coords,
  // offset by -pivot so the rotation spins the part about its own center.
  var bedGroup = new THREE.Group();
  scene.add(bedGroup);
  var previewGroup = new THREE.Group();
  bedGroup.add(previewGroup);
  var ghostMesh = null, pathObj = null;

  function resize() {
    var w = viewport.clientWidth, h = viewport.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  var _hl = new THREE.Vector3();
  (function animate(t) {
    requestAnimationFrame(animate);
    animTick(t || 0);
    controls.update();
    // headlight follows the camera, offset up+right so bead ridges stay lit
    // with grazing shadows from any viewing angle
    _hl.copy(camera.position).sub(controls.target);
    var up = camera.up;
    _hl.applyAxisAngle(up, 0.5);            // swing ~30 deg to the side
    _hl.addScaledVector(up, _hl.length() * 0.35);
    headLight.position.copy(controls.target).add(_hl);
    headLight.target.position.copy(controls.target);
    renderer.render(scene, camera);
  })(0);

  // ------------------------------------------------------------- UI build
  var panel = document.getElementById("settings");
  SCHEMA.forEach(function (item) {
    if (item.group) {
      var det = document.createElement("details");
      det.open = ["Model", "Position / clipping", "Toolpath", "Preview bead",
                  "Nozzle / Extrusion"].indexOf(item.group) >= 0;
      var sum = document.createElement("summary");
      sum.textContent = item.group;
      det.appendChild(sum);
      panel.appendChild(det);
      panel._cur = det;
      return;
    }
    S[item.key] = item.value;
    var row = document.createElement("label");
    row.className = "row";
    var span = document.createElement("span");
    span.textContent = item.label;
    row.appendChild(span);
    var inp;
    if (item.type === "select") {
      inp = document.createElement("select");
      item.options.forEach(function (o) {
        var op = document.createElement("option");
        op.value = o; op.textContent = o;
        inp.appendChild(op);
      });
      inp.value = item.value;
    } else if (item.type === "check") {
      inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = item.value;
    } else if (item.type === "text") {
      inp = document.createElement("input");
      inp.type = "text";
      inp.value = item.value;
      inp.spellcheck = false;
    } else {
      inp = document.createElement("input");
      inp.type = "number";
      inp.step = item.step || 1;
      if (item.min !== undefined) inp.min = item.min;
      inp.value = item.value;
    }
    inp.addEventListener("change", function () { onSettingChange(item); });
    row.appendChild(inp);
    panel._cur.appendChild(row);
    inputs[item.key] = inp;
  });

  function readSettings() {
    SCHEMA.forEach(function (item) {
      if (item.group) return;
      var inp = inputs[item.key];
      if (item.type === "check") S[item.key] = inp.checked;
      else if (item.type === "select" || item.type === "text") S[item.key] = inp.value;
      else S[item.key] = parseFloat(inp.value) || 0;
    });
  }

  // restore persisted printer settings for this device
  PERSIST_KEYS.forEach(function (k) {
    var v = null;
    try { v = localStorage.getItem("ginger_" + k); } catch (e) {}
    if (v === null) return;
    var inp = inputs[k];
    if (!inp) return;
    if (inp.type === "checkbox") { inp.checked = (v === "true"); S[k] = inp.checked; }
    else { inp.value = v; S[k] = v; }
  });

  var resliceTimer = null;
  function onSettingChange(item) {
    readSettings();
    if (PERSIST_KEYS.indexOf(item.key) >= 0) {
      try { localStorage.setItem("ginger_" + item.key, String(S[item.key])); } catch (e) {}
      return;   // printer settings never touch the slice/preview
    }
    var clampMsg = "";
    if (item.key === "nozzle") {
      // nozzle picks a default extrusion width + visual bead width (editable afterward)
      var w = NOZZLE_WIDTHS[S.nozzle];
      inputs.extrusionWidth.value = w;
      S.extrusionWidth = w;
      inputs.visualBeadWidth.value = w;
      S.visualBeadWidth = w;
      // clamp spacing to this nozzle's max layer height, same as LAYER_HEIGHT
      // clamping in rhino_curve_to_gcode_ginger_g1.py's apply_nozzle_profile()
      var maxLH = NOZZLE_MAX_LAYER_HEIGHT[S.nozzle];
      if (maxLH && S.spacing > maxLH) {
        clampMsg = "Spacing " + S.spacing.toFixed(2) + "mm exceeds " + S.nozzle +
          "mm nozzle max (" + maxLH.toFixed(2) + "mm) -- clamped.";
        inputs.spacing.value = maxLH;
        S.spacing = maxLH;
      }
    }
    updateModelInfo();
    if (!rawSoup) return;

    if (RESLICE_KEYS.indexOf(item.key) >= 0 || item.key === "nozzle") {
      // geometry changed -- re-slice automatically (debounced so typing a
      // number doesn't fire once per keystroke)
      if (resliceTimer) clearTimeout(resliceTimer);
      status("Settings changed -- updating slice ..." + (clampMsg ? " " + clampMsg : ""));
      resliceTimer = setTimeout(function () {
        resliceTimer = null;
        if (GHOST_KEYS.indexOf(item.key) >= 0) buildGhost();
        runSlice();
      }, 350);
    } else {
      // preview / gcode only -- instant update, no re-slice needed
      if (lastSliced) { buildPathPreview(); buildGcode(); }
      updatePlacement();
    }
  }

  // ---------------------------------------------------------- view toggle
  var toggleEl = document.getElementById("viewtoggle");
  Array.prototype.forEach.call(toggleEl.querySelectorAll("button"), function (btn) {
    btn.addEventListener("click", function () { setViewMode(btn.getAttribute("data-mode")); });
  });

  function setViewMode(mode) {
    if (mode !== "model" && !lastSliced) return;
    viewMode = mode;
    Array.prototype.forEach.call(toggleEl.querySelectorAll("button"), function (b) {
      b.className = b.getAttribute("data-mode") === mode ? "active" : "";
    });
    if (ghostMesh) ghostMesh.visible = (mode === "model") || zEditing;
    if (mode !== "model" && lastSliced) buildPathPreview();
    else if (pathObj) pathObj.visible = false;
    document.getElementById("legend").style.display = (mode === "heat" && lastSliced) ? "block" : "none";
    document.getElementById("animbar").style.display = (mode !== "model" && lastSliced) ? "flex" : "none";
  }

  // ------------------------------------------------------- move on bed
  // Toggle: drag the part around the bed in the viewport. Orbit is paused
  // while active. Dragging updates Bed center X/Y (auto-center placement),
  // so the preview, gcode, and settings panel all stay in sync.
  var moveMode = false;
  var rotateMode = false;
  var botClipMode = false;    // drag up/down -> S.clipBotZ
  var topClipMode = false;    // drag up/down -> S.clipTopZ
  var zEditing = false;       // either Z mode on -> force the ghost visible
  var moveBtn = document.getElementById("movebtn");
  var rotateBtn = document.getElementById("rotatebtn");
  var botClipBtn = document.getElementById("botclipbtn");
  var topClipBtn = document.getElementById("topclipbtn");
  var _ray = new THREE.Raycaster();
  var _ndc = new THREE.Vector2();
  var _bedPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  var _hit = new THREE.Vector3();
  var _dragLast = null;
  var _rotDragX = null;
  var _zDragLast = null;
  var _zPlane = new THREE.Plane();
  var _zHit = new THREE.Vector3();
  var _zNormal = new THREE.Vector3();

  function applyBedModes() {
    moveBtn.className = moveMode ? "active" : "";
    rotateBtn.className = rotateMode ? "active" : "";
    botClipBtn.className = botClipMode ? "active" : "";
    topClipBtn.className = topClipMode ? "active" : "";
    controls.enabled = !(moveMode || rotateMode || botClipMode || topClipMode);
    renderer.domElement.style.cursor =
      moveMode ? "move" : (rotateMode ? "ew-resize" :
      ((botClipMode || topClipMode) ? "ns-resize" : ""));
    // while dragging in Z you need to SEE the solid being cut, whatever view
    // mode is selected -- the toolpath is stale until the drag ends anyway
    var wantGhost = botClipMode || topClipMode;
    if (wantGhost !== zEditing) {
      zEditing = wantGhost;
      if (ghostMesh) ghostMesh.visible = (viewMode === "model") || zEditing;
    }
  }

  // Screen drag -> world Z, 1:1. Ray-hit a VERTICAL plane through the part
  // that faces the camera, and read the hit's Z: dragging the mouse a given
  // distance up the screen moves the part that same distance up in the world,
  // at any zoom or orbit angle.
  function zFromEvent(ev) {
    _zNormal.copy(camera.position).sub(controls.target);
    _zNormal.z = 0;
    if (_zNormal.lengthSq() < 1e-9) _zNormal.set(1, 0, 0);
    _zNormal.normalize();
    _zPlane.setFromNormalAndCoplanarPoint(_zNormal, bedGroup.position);
    var rect = renderer.domElement.getBoundingClientRect();
    _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);
    return _ray.ray.intersectPlane(_zPlane, _zHit) ? _zHit.z : null;
  }

  moveBtn.addEventListener("click", function () {
    moveMode = !moveMode;
    if (moveMode) { rotateMode = false; botClipMode = false; topClipMode = false; }
    applyBedModes();
    if (moveMode && !S.autoCenter) {
      // bed-center placement is what dragging edits -- switch it on
      inputs.autoCenter.checked = true; S.autoCenter = true;
      updatePlacement();
    }
  });

  rotateBtn.addEventListener("click", function () {
    rotateMode = !rotateMode;
    if (rotateMode) { moveMode = false; botClipMode = false; topClipMode = false; }
    applyBedModes();
  });

  botClipBtn.addEventListener("click", function () {
    botClipMode = !botClipMode;
    if (botClipMode) {
      moveMode = false; rotateMode = false; topClipMode = false;
      var wasOff = !S.clipBotOn;
      if (wasOff) { inputs.clipBotOn.checked = true; S.clipBotOn = true; }
      status("Bottom plane " + (wasOff ? "on " : "") + "at " +
             (S.clipBotZ || 0).toFixed(1) + "mm above the base -- drag up or down to " +
             "move it. Everything below it is cut off.");
      applyBedModes();
      buildGhost();     // the cut is live as soon as the plane switches on
      if (lastSliced) scheduleZReslice();
      return;
    }
    applyBedModes();
    buildGhost();
  });

  topClipBtn.addEventListener("click", function () {
    topClipMode = !topClipMode;
    if (topClipMode) {
      moveMode = false; rotateMode = false; botClipMode = false;
      var wasOff = !S.clipTopOn;
      if (wasOff) { inputs.clipTopOn.checked = true; S.clipTopOn = true; }
      status("Top plane " + (wasOff ? "on " : "") + "at " +
             (S.clipTopZ || 0).toFixed(1) + "mm above the base -- drag up or down to " +
             "move it. Everything above it is cut off.");
      applyBedModes();
      buildGhost();     // the cut is live as soon as the plane switches on
      if (lastSliced) scheduleZReslice();
      return;
    }
    applyBedModes();
    buildGhost();
  });

  // The planes must never cross: a drag stops 0.1mm short of the other one,
  // so you can push them together into a thin slab but never inside out.
  function clampBotZ(z) {
    if (S.clipTopOn) z = Math.min(z, (S.clipTopZ || 0) - 0.1);
    return z;
  }
  function clampTopZ(z) {
    if (S.clipBotOn) z = Math.max(z, (S.clipBotZ || 0) + 0.1);
    return z;
  }

  // Re-slicing is far too slow to run per drag frame, so a Z drag rebuilds
  // only the ghost mesh and the real slice follows once the drag settles.
  var zResliceTimer = null;
  function scheduleZReslice() {
    if (zResliceTimer) clearTimeout(zResliceTimer);
    zResliceTimer = setTimeout(function () {
      zResliceTimer = null;
      if (rawSoup) runSlice();
    }, 250);
  }

  function bedPointFromEvent(ev) {
    var rect = renderer.domElement.getBoundingClientRect();
    _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);
    return _ray.ray.intersectPlane(_bedPlane, _hit) ? _hit : null;
  }

  renderer.domElement.addEventListener("pointerdown", function (ev) {
    if (!rawSoup) return;
    if (moveMode) {
      var p = bedPointFromEvent(ev);
      if (p) { _dragLast = { x: p.x, y: p.y }; try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) {} }
    } else if (rotateMode) {
      _rotDragX = ev.clientX;
      try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) {}
    } else if (botClipMode || topClipMode) {
      var z = zFromEvent(ev);
      if (z !== null) { _zDragLast = z; try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (e) {} }
    }
  });
  renderer.domElement.addEventListener("pointermove", function (ev) {
    if (moveMode && _dragLast) {
      var p = bedPointFromEvent(ev);
      if (!p) return;
      S.bedCenterX += p.x - _dragLast.x;
      S.bedCenterY += p.y - _dragLast.y;
      _dragLast = { x: p.x, y: p.y };
      inputs.bedCenterX.value = S.bedCenterX.toFixed(1);
      inputs.bedCenterY.value = S.bedCenterY.toFixed(1);
      updatePlacement();
    } else if (rotateMode && _rotDragX !== null) {
      // horizontal drag spins the part about its own center
      S.bedRotationDeg = (S.bedRotationDeg || 0) + (ev.clientX - _rotDragX) * 0.4;
      _rotDragX = ev.clientX;
      inputs.bedRotationDeg.value = S.bedRotationDeg.toFixed(1);
      updatePlacement();
    } else if (_zDragLast !== null) {
      var z = zFromEvent(ev);
      if (z === null) return;
      var dz = z - _zDragLast;
      _zDragLast = z;
      var bb = scaledBBox(), h = bb.max[2] - bb.min[2];
      if (botClipMode) {
        S.clipBotZ = clampBotZ((S.clipBotZ || 0) + dz);
        inputs.clipBotZ.value = S.clipBotZ.toFixed(2);
        status("Bottom plane at " + S.clipBotZ.toFixed(1) + "mm above the base" +
               (S.clipBotZ > 0 ? " (bottom " + Math.min(S.clipBotZ, h).toFixed(1) + "mm cut off)" : ""));
      } else {
        S.clipTopZ = clampTopZ((S.clipTopZ || 0) + dz);
        inputs.clipTopZ.value = S.clipTopZ.toFixed(2);
        status("Top plane at " + S.clipTopZ.toFixed(1) + "mm above the base" +
               (S.clipTopZ < h ? " (top " + (h - S.clipTopZ).toFixed(1) + "mm cut off)" : ""));
      }
      buildGhost();   // live cut preview; the re-slice waits for pointerup
    }
  });
  renderer.domElement.addEventListener("pointerup", function () {
    if (_dragLast === null && _rotDragX === null && _zDragLast === null) return;
    var wasZ = (_zDragLast !== null);
    _dragLast = null;
    _rotDragX = null;
    _zDragLast = null;
    // a Z drag changed the MESH, so the toolpath itself has to be recomputed;
    // move/rotate only relocate an unchanged path, which gcode alone absorbs
    if (wasZ) scheduleZReslice();
    else if (lastSliced) buildGcode();
  });

  // ------------------------------------------------------ print animation
  // Scrub through the print (slider) or hit play to watch it lay down.
  // Implemented with setDrawRange so nothing is rebuilt while animating.
  var animFrac = 1;         // 0..1 fraction of the path shown
  var animPlaying = false;
  var animPrevT = 0;
  var animSlider = null, animBtn = null;

  function applyAnimRange() {
    if (!pathObj || !lastSliced) return;
    var n = lastSliced.path.length / 4;
    if (pathObj.userData.kind === "pipe") {
      var sides = pathObj.userData.sides;
      var segs = Math.max(0, Math.floor((n - 1) * animFrac));
      pathObj.geometry.setDrawRange(0, segs * sides * 6);
    } else {
      pathObj.geometry.setDrawRange(0, Math.max(2, Math.floor(n * animFrac)));
    }
  }

  function setAnimFrac(f, fromSlider) {
    animFrac = Math.min(1, Math.max(0, f));
    if (!fromSlider && animSlider) animSlider.value = Math.round(animFrac * 1000);
    applyAnimRange();
  }

  function animTick(t) {
    if (animPlaying && lastSliced) {
      var dt = (t - animPrevT) / 1000;
      // full print plays in ~25s regardless of size
      var f = animFrac + dt / 25;
      if (f >= 1) { f = 1; animPlaying = false; animBtn.textContent = "▶"; }
      setAnimFrac(f);
    }
    animPrevT = t;
  }

  function wireAnimBar() {
    animSlider = document.getElementById("animslider");
    animBtn = document.getElementById("animplay");
    animSlider.addEventListener("input", function () {
      animPlaying = false;
      animBtn.textContent = "▶";
      setAnimFrac(animSlider.value / 1000, true);
    });
    animBtn.addEventListener("click", function () {
      if (animPlaying) {
        animPlaying = false;
        animBtn.textContent = "▶";
      } else {
        if (animFrac >= 1) setAnimFrac(0);
        animPlaying = true;
        animBtn.textContent = "❚❚";
      }
    });
  }

  // ------------------------------------------------------------ file load
  var dropzone = document.getElementById("dropzone");
  ["dragenter", "dragover"].forEach(function (ev) {
    document.body.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("active"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    document.body.addEventListener(ev, function (e) { e.preventDefault(); if (ev === "drop") return; dropzone.classList.remove("active"); });
  });
  document.body.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("active");
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });
  document.getElementById("filein").addEventListener("change", function (e) {
    if (e.target.files.length) loadFile(e.target.files[0]);
  });

  var loadNote = "";          // extra info from the loader (e.g. "40 NURBS patches")
  var weldTolScale = 1;       // loaders may widen the weld (3dm face borders)
  var firstSliceAfterLoad = true;  // only the initial import resets camera + view

  function loadFile(file) {
    var name = file.name;
    var ext = name.split(".").pop().toLowerCase();
    rawName = name.replace(/\.[^.]+$/, "");
    fileKind = ext;
    loadNote = "";
    weldTolScale = 1;
    status("Loading " + name + " ...");
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        if (ext === "fbx") {
          finishLoad(soupFromFbx(e.target.result), name);
        } else if (ext === "obj") {
          var txt = new TextDecoder().decode(new Uint8Array(e.target.result));
          finishLoad(soupFromObject(new THREE.OBJLoader().parse(txt)), name);
        } else if (ext === "stl") {
          finishLoad(soupFromGeometry(new THREE.STLLoader().parse(e.target.result), null), name);
        } else if (ext === "3dm") {
          status("Loading " + name + " (starting rhino3dm) ...");
          ensureRhino().then(function (rhino) {
            try { finishLoad(soupFrom3dm(rhino, e.target.result), name); }
            catch (err) { status("ERROR: " + err.message, true); }
          }).catch(function (err) {
            status("ERROR: rhino3dm failed to start -- " + err, true);
          });
        } else {
          throw new Error("Unsupported file type ." + ext + " -- use FBX (Gravity Sketch NURBS or Mesh), 3DM (Rhino), OBJ, or STL.");
        }
      } catch (err) {
        status("ERROR: " + err.message, true);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function finishLoad(soup, name) {
    if (!soup || soup.length < 9) throw new Error("No triangle geometry found in the file.");
    rawSoup = soup;
    lastSliced = null; lastGcode = null;
    firstSliceAfterLoad = true;
    clearPath();
    document.getElementById("viewtoggle").style.display = "block";
    document.getElementById("movetoggle").style.display = "flex";
    setViewMode("model");

    // a new part starts uncut, with each plane parked level with the end of
    // the model it cuts, so the first drag inward starts cutting immediately
    // instead of travelling through empty air
    S.clipBotOn = true; inputs.clipBotOn.checked = true;
    S.clipBotZ = 0; inputs.clipBotZ.value = 0;
    S.clipTopOn = false; inputs.clipTopOn.checked = false;
    botClipMode = topClipMode = false;
    applyBedModes();
    _scaledBBKey = "";                    // new model -> drop the cached bbox
    // round UP, so the parked plane starts a hair CLEAR of the model and the
    // first drag downward is what begins the cut
    var _bb = scaledBBox();
    S.clipTopZ = Math.ceil((_bb.max[2] - _bb.min[2]) * 10) / 10;
    inputs.clipTopZ.value = S.clipTopZ;

    buildGhost(true);
    updateModelInfo();
    document.getElementById("slicebtn").disabled = false;
    // slice immediately on drop -- the Slice button stays for manual re-runs
    status("Loaded " + name + " -- " + (soup.length / 9).toFixed(0) + " triangles" +
      (loadNote ? " (" + loadNote + ")" : "") + ". Slicing ...");
    readSettings();
    setTimeout(runSlice, 30);
  }

  // FBX: prefer real NURBS surface patches when the file has them (Gravity
  // Sketch NURBS export) -- evaluated on a dense UV grid for smooth,
  // facet-free geometry. Falls back to the file's meshes otherwise.
  function soupFromFbx(buffer) {
    var obj = new THREE.FBXLoader().parse(buffer, "");
    var res = null;
    try { res = FBXNurbs.extract(buffer); }
    catch (err) { console.warn("FBXNurbs extract failed:", err); }
    if (!res || !res.patches.length) return soupFromObject(obj);

    // Use the patches' RAW control-point space, NO scene transforms: adjacent
    // patches share boundary control points exactly in raw space, so the
    // tessellations weld seamlessly. Baking each patch's (slightly different)
    // node matrix broke the welds -- thousands of hairline boundary edges --
    // and the raw space is simply Gravity Sketch's authoring space (meters,
    // Y-up; the up-axis auto handling already covers Y-up FBX).
    var chunks = [], total = 0;
    for (var i = 0; i < res.patches.length; i++) {
      var s = FBXNurbs.tessellate(res.patches[i], 12, true);
      chunks.push(s); total += s.length;
    }
    var out = new Float64Array(total), off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });

    // GS authors at real-world VR scale in meters -- if the raw model is
    // meter-sized, preset the units dropdown to meters (still editable).
    var maxAbs = 0;
    for (var p = 0; p < out.length; p++) { var a = Math.abs(out[p]); if (a > maxAbs) maxAbs = a; }
    if (maxAbs > 0.01 && maxAbs < 10) {
      inputs.units.value = "m"; S.units = "m";
      loadNote = res.patches.length + " NURBS patches, meters assumed -- meshes ignored";
    } else {
      loadNote = res.patches.length + " NURBS patches -- meshes ignored";
    }
    return out;
  }

  // Rhino .3dm via rhino3dm WASM: uses the render meshes saved in the file
  // (they respect trims). Units + up-axis come from the file itself.
  var _rhinoPromise = null;
  function ensureRhino() {
    if (_rhinoPromise) return _rhinoPromise;
    var b = atob(RHINO3DM_WASM_B64);
    var bin = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) bin[i] = b.charCodeAt(i);
    _rhinoPromise = rhino3dm({ wasmBinary: bin.buffer });
    return _rhinoPromise;
  }

  function soupFromRhinoMesh(m) {
    var vl = m.vertices(), fl = m.faces();
    var vc = vl.count;
    var vs = new Float64Array(vc * 3);
    for (var i = 0; i < vc; i++) {
      var p = vl.get(i);
      vs[i * 3] = p[0]; vs[i * 3 + 1] = p[1]; vs[i * 3 + 2] = p[2];
    }
    var soup = [];
    for (var i = 0; i < fl.count; i++) {
      var f = fl.get(i);
      var a = f[0], b = f[1], c = f[2], d = f[3];
      soup.push(vs[a * 3], vs[a * 3 + 1], vs[a * 3 + 2],
                vs[b * 3], vs[b * 3 + 1], vs[b * 3 + 2],
                vs[c * 3], vs[c * 3 + 1], vs[c * 3 + 2]);
      if (d !== c) {
        soup.push(vs[a * 3], vs[a * 3 + 1], vs[a * 3 + 2],
                  vs[c * 3], vs[c * 3 + 1], vs[c * 3 + 2],
                  vs[d * 3], vs[d * 3 + 1], vs[d * 3 + 2]);
      }
    }
    return soup;
  }

  // Dense tessellation of one Rhino surface via direct evaluation --
  // smooth geometry straight from the NURBS, none of the render mesh's
  // coarse faceting (which showed up as jagged toolpath edges).
  function soupFromRhinoSurface(srf) {
    var domU = srf.domain(0), domV = srf.domain(1);
    var divsU = Math.min(144, Math.max(48, (srf.spanCount(0) || 1) * 16));
    var divsV = Math.min(144, Math.max(48, (srf.spanCount(1) || 1) * 16));
    var grid = [];
    for (var j = 0; j <= divsV; j++) {
      var v = domV[0] + (domV[1] - domV[0]) * (j / divsV);
      for (var i = 0; i <= divsU; i++) {
        var u = domU[0] + (domU[1] - domU[0]) * (i / divsU);
        grid.push(srf.pointAt(u, v));
      }
    }
    var soup = new Float64Array(divsU * divsV * 2 * 9);
    var o = 0, W = divsU + 1;
    for (var j = 0; j < divsV; j++) {
      for (var i = 0; i < divsU; i++) {
        var a = grid[j * W + i], b = grid[j * W + i + 1];
        var c = grid[(j + 1) * W + i + 1], d = grid[(j + 1) * W + i];
        soup[o++] = a[0]; soup[o++] = a[1]; soup[o++] = a[2];
        soup[o++] = b[0]; soup[o++] = b[1]; soup[o++] = b[2];
        soup[o++] = c[0]; soup[o++] = c[1]; soup[o++] = c[2];
        soup[o++] = a[0]; soup[o++] = a[1]; soup[o++] = a[2];
        soup[o++] = c[0]; soup[o++] = c[1]; soup[o++] = c[2];
        soup[o++] = d[0]; soup[o++] = d[1]; soup[o++] = d[2];
      }
    }
    return soup;
  }

  function soupBBoxOf(arr) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < arr.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        if (arr[i + a] < mn[a]) mn[a] = arr[i + a];
        if (arr[i + a] > mx[a]) mx[a] = arr[i + a];
      }
    }
    return { min: mn, max: mx };
  }

  function soupFrom3dm(rhino, buffer) {
    var doc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
    if (!doc) throw new Error("Could not read the .3dm file.");
    var enumVal = function (e) { return (e && e.value !== undefined) ? e.value : e; };
    var chunks = [], totalLen = 0, skipped = 0, meshedFaces = 0, nurbsFaces = 0;
    var objs = doc.objects();
    for (var i = 0; i < objs.count; i++) {
      var geom = objs.get(i).geometry();
      if (!geom) continue;
      var ot = enumVal(geom.objectType);
      var meshes = [];
      if (ot === enumVal(rhino.ObjectType.Mesh)) meshes.push(geom);
      else if (ot === enumVal(rhino.ObjectType.Brep)) {
        var faces = geom.faces();
        for (var f = 0; f < faces.count; f++) {
          var face = faces.get(f);
          var renderMesh = face.getMesh(rhino.MeshType.Any);
          var used = false;
          // Prefer evaluating the REAL surface (smooth). Trim safety: if the
          // face is trimmed, the full underlying surface overshoots -- detect
          // via bbox blowup vs the render mesh (which respects trims) and
          // fall back to the mesh for that face.
          try {
            var srf = face.underlyingSurface();
            var s = soupFromRhinoSurface(srf);
            var ok = true;
            if (renderMesh) {
              var ms = soupFromRhinoMesh(renderMesh);
              if (ms.length) {
                var sb = soupBBoxOf(s), mb = soupBBoxOf(ms);
                var diag = Math.sqrt(
                  Math.pow(mb.max[0] - mb.min[0], 2) +
                  Math.pow(mb.max[1] - mb.min[1], 2) +
                  Math.pow(mb.max[2] - mb.min[2], 2)) || 1;
                for (var a2 = 0; a2 < 3; a2++) {
                  if (Math.abs(sb.min[a2] - mb.min[a2]) > diag * 0.03 ||
                      Math.abs(sb.max[a2] - mb.max[a2]) > diag * 0.03) ok = false;
                }
              }
            }
            if (ok && s.length) {
              nurbsFaces++; chunks.push(s); totalLen += s.length; used = true;
            }
          } catch (err2) { /* fall through to render mesh */ }
          if (!used && renderMesh) meshes.push(renderMesh);
        }
      } else if (ot === enumVal(rhino.ObjectType.Extrusion)) {
        var m2 = geom.getMesh ? geom.getMesh(rhino.MeshType.Any) : null;
        if (m2) meshes.push(m2);
      } else skipped++;
      for (var mi = 0; mi < meshes.length; mi++) {
        var s2 = soupFromRhinoMesh(meshes[mi]);
        if (s2.length) { meshedFaces++; chunks.push(s2); totalLen += s2.length; }
      }
    }
    if (!totalLen) {
      throw new Error("No meshable geometry in the .3dm -- in Rhino, save the file " +
        "after viewing it SHADED (so render meshes are embedded), or Mesh the object first.");
    }
    // units + up axis straight from the file
    var us = enumVal(doc.settings().modelUnitSystem);
    var unitName = { 2: "mm", 3: "cm", 4: "m", 8: "inches" }[us];
    if (unitName) {
      inputs.units.value = unitName; S.units = unitName;
    }
    inputs.upAxis.value = "Z up"; S.upAxis = "Z up";   // Rhino is Z-up
    // Brep face borders match only to the file's tolerance -- widen the weld
    // so NURBS-evaluated neighboring faces fuse into one shell.
    weldTolScale = 10;
    loadNote = (nurbsFaces ? nurbsFaces + " NURBS-evaluated face(s), " : "") +
      meshedFaces + " render mesh(es), units=" + (unitName || ("code " + us)) +
      (skipped ? ", " + skipped + " unsupported object(s) skipped" : "");
    var out = new Float64Array(totalLen), off3 = 0;
    chunks.forEach(function (c) { out.set(c, off3); off3 += c.length; });
    return out;
  }

  function soupFromObject(root) {
    var chunks = [];
    root.updateMatrixWorld(true);
    root.traverse(function (node) {
      if (node.isMesh && node.geometry) {
        var s = soupFromGeometry(node.geometry, node.matrixWorld);
        if (s.length) chunks.push(s);
      }
    });
    var total = 0;
    chunks.forEach(function (c) { total += c.length; });
    var out = new Float64Array(total);
    var off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });
    return out;
  }

  function soupFromGeometry(geometry, matrixWorld) {
    var geo = geometry.index ? geometry.toNonIndexed() : geometry;
    var pos = geo.getAttribute("position");
    if (!pos) return new Float64Array(0);
    var v = new THREE.Vector3();
    var out = new Float64Array(pos.count * 3);
    for (var i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (matrixWorld) v.applyMatrix4(matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  }

  // -------------------------------------------------- transform raw -> mm Z-up
  function unitScale() {
    var u = { mm: 1, cm: 10, m: 1000, inches: 25.4 }[S.units] || 1;
    return u * ((S.scalePct > 0 ? S.scalePct : 100) / 100);
  }
  function effectiveUpAxis() {
    if (S.upAxis === "Y up") return "y";
    if (S.upAxis === "Z up") return "z";
    // auto: FBX/OBJ default Y-up, STL default Z-up
    return (fileKind === "stl") ? "z" : "y";
  }
  // Units/axis/scale only -- the mesh STAYS in its own coordinates. Nothing
  // here translates the geometry, because weld() hashes vertices into a grid
  // and shifting everything by a constant silently reshuffles which
  // near-coincident vertices merge, which changes the slice. So the clip
  // planes move through a stationary model rather than the model moving
  // through stationary planes -- same result on screen, and a part with no
  // active cut goes through the exact byte-for-byte pipeline it always did.
  function scaledSoup() {
    var sc = unitScale();
    var up = effectiveUpAxis();
    var n = rawSoup.length / 3;
    var out = new Float64Array(rawSoup.length);
    for (var i = 0; i < n; i++) {
      var x = rawSoup[i * 3], y = rawSoup[i * 3 + 1], z = rawSoup[i * 3 + 2];
      if (up === "y") { var t = y; y = -z; z = t; }   // rotate +90 about X: Y-up -> Z-up
      out[i * 3] = x * sc; out[i * 3 + 1] = y * sc; out[i * 3 + 2] = z * sc;
    }
    return out;
  }

  // bbox of the uncut, unmoved mesh. Cached: a drag re-reads it every frame
  // and it only depends on units/axis/scale.
  var _scaledBBCache = null, _scaledBBKey = "";
  function scaledBBox() {
    var key = [S.units, S.upAxis, S.scalePct, rawName, rawSoup && rawSoup.length].join("|");
    if (_scaledBBKey !== key || !_scaledBBCache) {
      _scaledBBCache = soupBBox(scaledSoup());
      _scaledBBKey = key;
    }
    return _scaledBBCache;
  }

  // Where the two planes sit IN MODEL COORDINATES. Both heights are measured
  // up from the model's own base (its lowest point), which is the Z=0 the
  // whole panel reads against.
  function clipLevels() {
    var base = scaledBBox().min[2];
    return { bot: base + (S.clipBotZ || 0), top: base + (S.clipTopZ || 0) };
  }

  var clipNote = "";   // shown in the model-info line

  function transformedSoup() {
    return clipSoup(scaledSoup());
  }

  function clipSoup(soup) {
    clipNote = "";
    if (!S.clipBotOn && !S.clipTopOn) return soup;
    var bb = scaledBBox(), lv = clipLevels();
    if (S.clipBotOn && S.clipTopOn && lv.top <= lv.bot) {
      clipNote = " -- TOP PLANE IS AT OR BELOW THE BOTTOM PLANE, cut ignored";
      return soup;
    }
    // A plane clear of the model is armed, not cutting -- pass null so clipZ
    // leaves the soup strictly alone rather than re-fanning every triangle.
    var zMin = (S.clipBotOn && bb.min[2] < lv.bot - 1e-9) ? lv.bot : null;
    var zMax = (S.clipTopOn && bb.max[2] > lv.top + 1e-9) ? lv.top : null;
    if (zMin === null && zMax === null) return soup;

    var cut = GingerSlicer.clipZ(soup, zMin, zMax);
    if (cut.length < 9) {
      clipNote = " -- clip planes removed the whole model, cut ignored";
      return soup;
    }
    var parts = [];
    if (zMin !== null) parts.push("bottom @ " + (S.clipBotZ || 0).toFixed(1) + "mm");
    if (zMax !== null) parts.push("top @ " + (S.clipTopZ || 0).toFixed(1) + "mm");
    clipNote = " -- clipped (" + parts.join(" + ") + ")";
    return cut;
  }

  function soupBBox(soup) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        if (soup[i + a] < mn[a]) mn[a] = soup[i + a];
        if (soup[i + a] > mx[a]) mx[a] = soup[i + a];
      }
    }
    return { min: mn, max: mx };
  }

  function updateModelInfo(soup) {
    var el = document.getElementById("modelinfo");
    if (!rawSoup) { el.textContent = "No model loaded."; return; }
    var bb = soupBBox(soup || transformedSoup());
    el.textContent = "Size: " +
      (bb.max[0] - bb.min[0]).toFixed(1) + " x " +
      (bb.max[1] - bb.min[1]).toFixed(1) + " x " +
      (bb.max[2] - bb.min[2]).toFixed(1) + " mm (X Y Z, after units/axis/scale)" +
      clipNote;
    el.style.color = clipNote.indexOf("ignored") >= 0 ? "#ff7b72" : "";
  }

  // ------------------------------------------------------------ ghost mesh
  function buildGhost(fit) {
    if (ghostMesh) { previewGroup.remove(ghostMesh); ghostMesh.geometry.dispose(); ghostMesh = null; }
    if (!rawSoup) return;
    var soup = transformedSoup();
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(soup), 3));
    geo.computeVertexNormals();
    ghostMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x8a94a6, transparent: true, opacity: 0.28, side: THREE.DoubleSide,
      depthWrite: false, roughness: 0.9
    }));
    ghostMesh.visible = (viewMode === "model") || zEditing;
    previewGroup.add(ghostMesh);
    updateModelInfo(soup);
    if (fit) fitView(soup);   // only the initial import moves the camera
    updatePlacement();
  }

  // ------------------------------------------------------- clip plane gizmos
  // Two translucent quads drawn in MODEL space (inside previewGroup) so they
  // stay glued to the part as it moves/rotates on the bed. Sized off the
  // UNCLIPPED footprint so the plane never shrinks to nothing as it eats into
  // the model -- you always see how much is being cut.
  var clipPlanes = { bottom: null, top: null };

  function makeClipPlane(color) {
    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.07, side: THREE.DoubleSide,
      depthWrite: false
    });
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    g.add(quad);
    var edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.85 }));
    g.add(edge);
    g.userData.quad = quad;
    g.userData.edge = edge;
    previewGroup.add(g);
    return g;
  }

  function updateClipPlanes() {
    var show = S.showClipPlanes && !!rawSoup;
    if (!show) {
      if (clipPlanes.bottom) clipPlanes.bottom.visible = false;
      if (clipPlanes.top) clipPlanes.top.visible = false;
      return;
    }
    var bb = scaledBBox(), lv = clipLevels();
    var cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
    var sx = Math.max((bb.max[0] - bb.min[0]) * 1.12, 30);
    var sy = Math.max((bb.max[1] - bb.min[1]) * 1.12, 30);

    // the plane you are actively dragging lights up, so there is never any
    // doubt which of the two a drag is about to move
    function place(g, z, on, active) {
      g.visible = on;
      if (!on) return;
      g.position.set(cx, cy, z);
      g.scale.set(sx, sy, 1);
      g.userData.quad.material.opacity = active ? 0.16 : 0.07;
      g.userData.edge.material.opacity = active ? 1.0 : 0.85;
    }
    if (!clipPlanes.bottom) clipPlanes.bottom = makeClipPlane(0x2f81f7);
    if (!clipPlanes.top) clipPlanes.top = makeClipPlane(0xd29922);
    place(clipPlanes.bottom, lv.bot, !!S.clipBotOn || botClipMode, botClipMode);
    place(clipPlanes.top, lv.top, !!S.clipTopOn || topClipMode, topClipMode);
  }

  function fitView(soup) {
    var bb = soupBBox(soup);
    var cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
    var d = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    var off = placementOffset(bb);
    controls.target.set(cx + off.x, cy + off.y, cz + off.z);
    camera.position.set(cx + off.x + d * 1.6, cy + off.y - d * 1.6, cz + off.z + d * 1.1);
  }

  function placementOffset(bb) {
    var ox = 0, oy = 0;
    if (S.autoCenter) {
      ox = S.bedCenterX - (bb.min[0] + bb.max[0]) / 2;
      oy = S.bedCenterY - (bb.min[1] + bb.max[1]) / 2;
    }
    return { x: ox, y: oy, z: S.heightOffPlate - bb.min[2] };
  }

  function updatePlacement() {
    if (!rawSoup) return;
    var arr, stride;
    if (lastSliced) { arr = lastSliced.path; stride = 4; }
    else { arr = transformedSoup(); stride = 3; }
    var n = arr.length / stride;
    // pivot = model bbox center (matches makeGcode's rotation pivot)
    var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity;
    for (var i = 0; i < n; i++) {
      var x = arr[i * stride], y = arr[i * stride + 1], z = arr[i * stride + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z;
    }
    var cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    var th = (S.bedRotationDeg || 0) * Math.PI / 180;
    var ca = Math.cos(th), sa = Math.sin(th);
    // bbox of the ROTATED part (about the pivot) -- what auto-center centers,
    // exactly as makeGcode does
    var rmnx = Infinity, rmxx = -Infinity, rmny = Infinity, rmxy = -Infinity;
    for (var i = 0; i < n; i++) {
      var rx = arr[i * stride] - cx, ry = arr[i * stride + 1] - cy;
      var qx = rx * ca - ry * sa, qy = rx * sa + ry * ca;
      if (qx < rmnx) rmnx = qx; if (qx > rmxx) rmxx = qx;
      if (qy < rmny) rmny = qy; if (qy > rmxy) rmxy = qy;
    }
    previewGroup.position.set(-cx, -cy, 0);
    bedGroup.rotation.z = th;
    var px, py;
    if (S.autoCenter) {
      px = S.bedCenterX - (rmnx + rmxx) / 2;
      py = S.bedCenterY - (rmny + rmxy) / 2;
    } else {
      px = cx; py = cy;   // rotate in place, no re-centering
    }
    bedGroup.position.set(px, py, S.heightOffPlate - mnz);
    updateClipPlanes();
  }

  function pathBBox(path) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    var n = path.length / 4;
    for (var i = 0; i < n; i++) {
      for (var a = 0; a < 3; a++) {
        var v = path[i * 4 + a];
        if (v < mn[a]) mn[a] = v;
        if (v > mx[a]) mx[a] = v;
      }
    }
    return { min: mn, max: mx };
  }

  // ---------------------------------------------------------------- slice
  document.getElementById("slicebtn").addEventListener("click", function () {
    if (!rawSoup) return;
    readSettings();
    status("Slicing ...");
    document.getElementById("slicebtn").disabled = true;
    setTimeout(runSlice, 30);   // let the status paint first
  });

  function runSlice() {
    try {
      var t0 = performance.now();
      var soup = transformedSoup();
      var welded = GingerSlicer.weld(soup, weldTolScale);
      var an = GingerSlicer.analyze(welded);
      if (an.components > 1) {
        status("Note: " + an.components + " disconnected shells -- using the largest (" + an.keptTriCount + " tris).");
      }
      lastSliced = GingerSlicer.slicePath(an, {
        spacing: S.spacing,
        ptsPerRev: Math.round(S.ptsPerRev),
        ringsPerRev: 3,
        seamDeg: S.seamDeg,
        seamAtLowest: S.seamAtLowest,
        baseOn: S.baseOn,
        baseSpacing: S.baseSpacing,
        traceTopRim: S.traceTopRim,
        removeTopRevs: Math.round(S.removeTopRevs),
        smoothing: S.smoothingOn ? Math.round(S.smoothing) : 0
      });
      var dt = ((performance.now() - t0) / 1000).toFixed(1);
      var w = lastSliced.warnings.length ? (" | " + lastSliced.warnings.join(" ")) : "";

      // Coverage check. Ring extraction can quietly give up partway up a mesh
      // (pinched rims, stray hole loops), and the result is a spiral that
      // stops short while everything still LOOKS fine -- you would only find
      // out on the printer. Moving the clip planes changes where that happens,
      // so say it out loud whenever the toolpath misses a real slice of the
      // part it was given.
      var mbb = soupBBox(soup), pbb = pathBBox(lastSliced.path);
      var meshH = mbb.max[2] - mbb.min[2], pathH = pbb.max[2] - pbb.min[2];
      if (meshH > 1e-6 && pathH < meshH * 0.9) {
        w = " | WARNING: toolpath covers only " + pathH.toFixed(0) + "mm of the " +
            meshH.toFixed(0) + "mm part (" + Math.round(pathH / meshH * 100) +
            "%) -- the spiral stopped early. Try a top clipping plane just below" +
            " where it stops, or a coarser 'points per revolution'." + w;
      }
      buildGcode();
      if (firstSliceAfterLoad) {
        // initial import: jump to the 3D layer view (matte-white Slice pipes),
        // full path shown
        firstSliceAfterLoad = false;
        setAnimFrac(1);
        animPlaying = false;
        if (animBtn) animBtn.textContent = "▶";
        setViewMode("slice");
      } else {
        // settings tweak: refresh the geometry but KEEP the current view,
        // camera, and animation scrub position
        setViewMode(viewMode);
      }
      updatePlacement();
      status("Sliced in " + dt + "s -- " + lastSliced.revs + " revolutions, " +
        (lastSliced.base ? lastSliced.base.passes + " base passes, " : "") +
        (lastSliced.path.length / 4).toFixed(0) + " points." + w);
      document.getElementById("exportbtn").disabled = false;
      document.getElementById("sendbtn").disabled = false;
    } catch (err) {
      status("SLICE ERROR: " + err.message, true);
    }
    document.getElementById("slicebtn").disabled = false;
  }

  function currentFeedMmS() {
    var beadArea = GingerSlicer.beadArea(S.extrusionWidth, S.spacing);
    return Math.min(S.printSpeed, S.maxVolumetricSpeed / beadArea);
  }

  // ------------------------------------------------------------- preview
  function clearPath() {
    if (pathObj) {
      previewGroup.remove(pathObj);
      pathObj.geometry.dispose();
      pathObj = null;
    }
    document.getElementById("legend").style.display = "none";
  }

  function heatColor(t) {
    // t: 0 = hottest (short lap) -> red, 1 = coolest -> blue
    var h = t * 0.66;   // hue 0(red)..0.66(blue)
    var c = new THREE.Color();
    c.setHSL(h, 1.0, 0.5);
    return c;
  }

  function buildPathPreview() {
    clearPath();
    if (!lastSliced) return;
    var path = lastSliced.path;
    var n = path.length / 4;
    var heat = (viewMode === "heat");

    // local radius of curvature per point (mm), from the 3-point circumradius
    // through each point's immediate neighbors -- small radius = tight turn,
    // where adjacent passes crowd close together with little room to cool;
    // log-scaled color, same as the old lap-time metric.
    var RADIUS_CAP = 5000;   // mm -- straight/near-straight runs clamp here
    var radii = new Float64Array(n);
    var minR = Infinity, maxR = -Infinity;
    for (var i = 0; i < n; i++) {
      var i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      var ax = path[i0 * 4], ay = path[i0 * 4 + 1], az = path[i0 * 4 + 2];
      var bx = path[i * 4], by = path[i * 4 + 1], bz = path[i * 4 + 2];
      var cx = path[i1 * 4], cy = path[i1 * 4 + 1], cz = path[i1 * 4 + 2];
      var a = Math.hypot(bx - cx, by - cy, bz - cz);
      var b = Math.hypot(ax - cx, ay - cy, az - cz);
      var c = Math.hypot(ax - bx, ay - by, az - bz);
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var crx = uy * vz - uz * vy, cry = uz * vx - ux * vz, crz = ux * vy - uy * vx;
      var area2 = Math.hypot(crx, cry, crz);   // 2x triangle area
      var r = area2 > 1e-9 ? (a * b * c) / (2 * area2) : RADIUS_CAP;
      if (r > RADIUS_CAP || !isFinite(r)) r = RADIUS_CAP;
      radii[i] = r;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    var lmin = Math.log(Math.max(minR, 1e-3)), lmax = Math.log(Math.max(maxR, 1e-3));
    var lspan = Math.max(lmax - lmin, 1e-9);

    var tmp = new THREE.Color();
    function colorAt(i, target) {
      if (!heat) { target.setHex(0xffffff); return; }
      // hot (red, t=0) = small radius; cool (blue, t=1) = large radius
      target.copy(heatColor((Math.log(radii[i]) - lmin) / lspan));
    }

    // ---- CURVE mode: just the toolpath line ----------------------------
    if (viewMode === "curve") {
      var lverts = new Float32Array(n * 3);
      var lcols = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) {
        lverts[i * 3] = path[i * 4]; lverts[i * 3 + 1] = path[i * 4 + 1]; lverts[i * 3 + 2] = path[i * 4 + 2];
        colorAt(i, tmp);
        lcols[i * 3] = tmp.r; lcols[i * 3 + 1] = tmp.g; lcols[i * 3 + 2] = tmp.b;
      }
      var lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute("position", new THREE.BufferAttribute(lverts, 3));
      lgeo.setAttribute("color", new THREE.BufferAttribute(lcols, 3));
      pathObj = new THREE.Line(lgeo, new THREE.LineBasicMaterial({ vertexColors: true }));
      pathObj.userData.kind = "line";
      previewGroup.add(pathObj);
      applyAnimRange();
      return;
    }

    // ---- actual PIPE: swept elliptical bead cross-section --------------
    // width = extrusion width (horizontal), height = distance between
    // revolutions (vertical) -- what the bead really occupies.
    var SIDES = n > 60000 ? 6 : 10;
    var w2 = S.visualBeadWidth / 2;    // preview-only bead size, set in "Preview bead"
    var h2 = S.visualBeadHeight / 2;
    var ringDirs = [];   // precomputed unit circle
    for (var s = 0; s < SIDES; s++) {
      var a = (s / SIDES) * Math.PI * 2;
      ringDirs.push([Math.cos(a), Math.sin(a)]);
    }

    var verts = new Float32Array(n * SIDES * 3);
    var cols = new Float32Array(n * SIDES * 3);
    var norms = new Float32Array(n * SIDES * 3);
    for (var i = 0; i < n; i++) {
      var i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      var dx = path[i1 * 4] - path[i0 * 4];
      var dy = path[i1 * 4 + 1] - path[i0 * 4 + 1];
      var dl = Math.sqrt(dx * dx + dy * dy);
      var sx, sy;                                  // horizontal side vector
      if (dl < 1e-9) { sx = 1; sy = 0; } else { sx = -dy / dl; sy = dx / dl; }
      var x = path[i * 4], y = path[i * 4 + 1], z = path[i * 4 + 2];
      colorAt(i, tmp);
      for (var s = 0; s < SIDES; s++) {
        var cw = ringDirs[s][0], sv = ringDirs[s][1];
        var o = (i * SIDES + s) * 3;
        verts[o] = x + sx * cw * w2;
        verts[o + 1] = y + sy * cw * w2;
        verts[o + 2] = z + sv * h2;
        // normal of the ellipse surface (approx: scaled circle normal)
        var nx = sx * cw / w2, ny = sy * cw / w2, nz = sv / h2;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        norms[o] = nx / nl; norms[o + 1] = ny / nl; norms[o + 2] = nz / nl;
        cols[o] = tmp.r; cols[o + 1] = tmp.g; cols[o + 2] = tmp.b;
      }
    }
    var idx = new Uint32Array((n - 1) * SIDES * 6);
    var p = 0;
    for (var i = 0; i < n - 1; i++) {
      for (var s = 0; s < SIDES; s++) {
        var s2 = (s + 1) % SIDES;
        var a = i * SIDES + s, b = i * SIDES + s2;
        var c = (i + 1) * SIDES + s, d = (i + 1) * SIDES + s2;
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(norms, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    pathObj = new THREE.Mesh(geo, heat
      ? new THREE.MeshBasicMaterial({ vertexColors: true })
      : new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 1.0, metalness: 0.0 }));  // matte white
    pathObj.userData.kind = "pipe";
    pathObj.userData.sides = SIDES;
    pathObj.visible = (viewMode !== "model");
    previewGroup.add(pathObj);
    applyAnimRange();

    // legend (heat view only)
    if (heat) {
      document.getElementById("legend").style.display = "block";
      document.getElementById("legendmin").textContent = minR.toFixed(1) + "mm radius (HOT - tight turn)";
      document.getElementById("legendmax").textContent =
        (maxR >= RADIUS_CAP ? "≥" + RADIUS_CAP : maxR.toFixed(1)) + "mm radius (cool)";
    }
  }

  // ------------------------------------------------------------- gcode
  function buildGcode() {
    if (!lastSliced) return;
    lastGcode = GingerSlicer.makeGcode(lastSliced, {
      nozzle: S.nozzle,
      extrusionWidth: S.extrusionWidth,
      layerHeight: S.spacing,          // spiral: bead height == rise per rev
      extrusionMultiplier: S.extrusionMultiplier,
      printSpeed: S.printSpeed,
      travelSpeed: S.travelSpeed,
      zTravelSpeed: S.zTravelSpeed,
      maxVolumetricSpeed: S.maxVolumetricSpeed,
      accelPrint: S.accelPrint,
      accelTravel: S.accelTravel,
      squareCornerVelocity: S.squareCornerVelocity,
      retractLength: S.retractLength,
      retractSpeed: S.retractSpeed,
      pressureAdvance: S.pressureAdvance,
      pressureAdvanceSmoothTime: S.pressureAdvanceSmoothTime,
      extruderRotationVolume: Math.round(S.extruderRotationVolume),
      mixingStepperRotationVolume: Math.round(S.mixingStepperRotationVolume),
      zone1Temp: Math.round(S.zone1Temp),
      zone2Temp: Math.round(S.zone2Temp),
      zone3Temp: Math.round(S.zone3Temp),
      bedTemp: Math.round(S.bedTemp),
      purgeQuantity: Math.round(S.purgeQuantity),
      leveling: S.leveling,
      autoCenter: S.autoCenter,
      bedCenterX: S.bedCenterX,
      bedCenterY: S.bedCenterY,
      bedRotationDeg: S.bedRotationDeg,
      heightOffPlate: S.heightOffPlate
    });
    var st = document.getElementById("stats");
    st.innerHTML =
      "Est. time: <b>" + lastGcode.timeString + "</b><br>" +
      "Path: " + (lastGcode.totalLengthMm / 1000).toFixed(1) + " m | " +
      (lastGcode.totalVolumeMm3 / 1000).toFixed(0) + " cm&sup3;<br>" +
      "Feed: " + lastGcode.feedMmS.toFixed(1) + " mm/s" +
      (lastGcode.feedCapped ? " (volumetric-capped)" : "") + "<br>" +
      "Revolutions: " + lastSliced.revs +
      (lastSliced.base ? " | Base passes: " + lastSliced.base.passes : "");
  }

  // ------------------------------------------------- send to printer
  document.getElementById("sendbtn").addEventListener("click", function () {
    if (!lastSliced) return;
    readSettings();
    var url = (S.relayUrl || "").replace(/\/+$/, "");
    if (!url) { status("Set the Relay URL in the Printer panel first.", true); return; }
    if (!S.relayToken) { status("Set the Relay token in the Printer panel first (it lives on the relay Mac, not in this page).", true); return; }
    buildGcode();
    var btn = document.getElementById("sendbtn");
    btn.disabled = true;
    var fname = rawName + "_ginger.gcode";
    status("Sending " + fname + " to the printer via " + url + " ...");
    fetch(url + "/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: S.relayToken, filename: fname, gcode: lastGcode.text, start: !!S.sendStart })
    }).then(function (r) { return r.json(); }).then(function (res) {
      btn.disabled = false;
      if (res.ok) {
        status("Sent " + res.filename + (res.started
          ? " -- PRINT STARTED on the G1."
          : " -- uploaded to the printer (start it from the touchscreen / Mainsail)."));
      } else {
        status("Printer send failed: " + (res.error || JSON.stringify(res)), true);
      }
    }).catch(function (err) {
      btn.disabled = false;
      status("Could not reach the relay at " + url + ". First time on this device? Open " +
        url + "/health in a new tab, accept the certificate warning, then retry. (" + err + ")", true);
    });
  });

  document.getElementById("exportbtn").addEventListener("click", function () {
    if (!lastSliced) return;
    readSettings();
    buildGcode();   // rebuild with the freshest settings
    var blob = new Blob([lastGcode.text], { type: "text/plain" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = rawName + "_ginger.gcode";
    a.click();
    URL.revokeObjectURL(a.href);
    status("Exported " + a.download + " (" + lastGcode.timeString + ")");
  });

  // -------------------------------------------------------------- status
  function status(msg, isError) {
    var el = document.getElementById("status");
    el.textContent = msg;
    el.className = isError ? "err" : "";
  }

  wireAnimBar();
  resize();
  status("Drop an FBX (Gravity Sketch: export as Mesh), OBJ, or STL to begin.");
})();
