// Coordinate system:
//   Chaser satellite is the camera (origin of LVLH / Hill frame).
//   Default camera looks toward -V (aft / retrograde from the laser satellite).
//   Screen +x = +H (orbit normal, cross-track)     right
//   Screen +y = -R (nadir, toward Earth)           down
//   View depth = -V (retrograde)                   into screen
//   Earth sits below the horizon line; orbit map (top-right) shows the
//   inertial picture with Earth, the orbit, and the Sun direction.

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const ui = {
  phase: document.getElementById("phaseLabel"),
  energyText: document.getElementById("energyText"),
  energyBar: document.getElementById("energyBar"),
  heatText: document.getElementById("heatText"),
  heatBar: document.getElementById("heatBar"),
  stableText: document.getElementById("stableText"),
  stableBar: document.getElementById("stableBar"),
  spinText: document.getElementById("spinText"),
  dvText: document.getElementById("dvText"),
  daText: document.getElementById("daText"),
  perigeeText: document.getElementById("perigeeText"),
  fuelText: document.getElementById("fuelText"),
  fuelBar: document.getElementById("fuelBar"),
  removeText: document.getElementById("removeText"),
  scoreText: document.getElementById("scoreText"),
  orbitText: document.getElementById("orbitText"),
  sunText: document.getElementById("sunText"),
  guidanceText: document.getElementById("guidanceText"),
  pauseButton: document.getElementById("pauseButton"),
  resetButton: document.getElementById("resetButton"),
  targetButton: document.getElementById("targetButton"),
  difficultyButton: document.getElementById("difficultyButton"),
  modeButton: document.getElementById("modeButton"),
  stepDespin: document.getElementById("stepDespin"),
  stepStabilize: document.getElementById("stepStabilize"),
  stepRemove: document.getElementById("stepRemove"),
  introOverlay: document.getElementById("introOverlay"),
  startButton: document.getElementById("startButton"),
  winOverlay: document.getElementById("winOverlay"),
  winScore: document.getElementById("winScore"),
  winEnergy: document.getElementById("winEnergy"),
  winDv: document.getElementById("winDv"),
  winPerigee: document.getElementById("winPerigee"),
  retryButton: document.getElementById("retryButton"),
  failOverlay: document.getElementById("failOverlay"),
  failReason: document.getElementById("failReason"),
  failRetryButton: document.getElementById("failRetryButton")
};

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrap01 = (value) => ((value % 1) + 1) % 1;
const lerp = (a, b, t) => a + (b - a) * t;
const length = (x, y) => Math.hypot(x, y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const normalize3 = (v) => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

let width = 0;
let height = 0;
let dpr = 1;
let last = 0;
let stars = [];
let particles = [];
let messages = [];
let state;
// Sun-synchronous LEO parameters (scaled for game pacing).
// Real SSO: ~600 km altitude, i ≈ 97.8°, period ≈ 97 min.
// Game scale: orbit period ≈ 90 s so the eclipse rhythm is playable.
const ORBIT = {
  altitudeKm: 600,
  inclinationDeg: 97.8,
  ltanHours: 10.5,         // local time of ascending node (10:30 → mid-morning SSO)
  periodSec: 90,           // game-time period
  betaDeg: 22,             // sun-orbit-plane angle, fixed for an SSO
  earthRotPerOrbit: 0.06   // visible Earth rotation (game stylization, not real)
};
const VIEW_FLOW = -1;       // Camera looks aft along -V, so ground/track cues run in reverse.

// --- Real-unit physics core (Sprint 1) ---
// Relative translation lives in the Hill/LVLH frame of a reference circular
// orbit, in SI units: rel = { x: radial (+zenith), y: along-track (+prograde),
// z: cross-track } [m], velocities [m/s]. Pixel positions for rendering are
// derived from rel each frame, so the dynamics no longer depend on screen size.
const PHYS = (() => {
  const mu = 3.986004418e14;                 // m^3/s^2
  const Re = 6371e3;                         // m
  const a = Re + ORBIT.altitudeKm * 1e3;
  const n = Math.sqrt(mu / (a * a * a));     // mean motion ≈ 1.085e-3 rad/s
  return { mu, Re, a, n, periodSec: TAU / n };
})();
// Wall-clock → physical seconds. One real orbit (~96.5 min) plays in ~90 s.
const TIME_WARP = 64;
// Ablation thrust on the target (cosine-of-incidence law applies on top).
// Literature estimates for pulsed-laser ablation are mN-class; scaled ~100x so
// a single pass fits in minutes of play. Masses and dynamics are real.
const LASER_THRUST_N = 0.12;
// Chaser station-keeping: PD follower in the Hill frame (physical time). The
// chaser pays real Δv to hold formation — that consumption is the fuel meter.
const CHASER = { kp: 1.6e-3, kd: 0.08, uMax: 3e-3, standoffFrac: 0.58 };

const MODE_TYPES = ["realism", "arcade"];
const MODE_LABELS = { realism: "REALISM", arcade: "ARCADE" };
// realism: lossless orbit dynamics + finite station-keeping fuel.
// arcade:  gentle artificial damping + unlimited fuel (assist mode).
const MODES = {
  realism: { damping: false, fuelBudget: 8 },
  arcade:  { damping: true,  fuelBudget: Infinity }
};
let currentMode = "realism";

// Closed-form Clohessy-Wiltshire propagation (state transition matrix).
// Exact for the linearized dynamics — no integration error at any dt. Also
// generates the one-orbit-ahead ghost prediction in the Hill-frame map.
function cwPropagate(s, t, n = PHYS.n) {
  const c = Math.cos(n * t);
  const si = Math.sin(n * t);
  return {
    x: (4 - 3 * c) * s.x + (si / n) * s.vx + (2 / n) * (1 - c) * s.vy,
    y: 6 * (si - n * t) * s.x + s.y + (2 / n) * (c - 1) * s.vx + ((4 * si) / n - 3 * t) * s.vy,
    z: c * s.z + (si / n) * s.vz,
    vx: 3 * n * si * s.x + c * s.vx + 2 * si * s.vy,
    vy: 6 * n * (c - 1) * s.x - 2 * si * s.vx + (4 * c - 3) * s.vy,
    vz: -n * si * s.z + c * s.vz
  };
}

// Orbit-element readouts from the relative state (linearized):
//   δa   = 4x + 2ẏ/n                  semi-major-axis offset vs reference
//   A    = √((ẋ/n)² + (3x + 2ẏ/n)²)   radial oscillation amplitude (≈ a·e)
//   δr_p = δa − A                      perigee change = min radial over 1 orbit
// Radial velocity never enters δa: pushing the debris "down" does not lower
// its orbit — only along-track (retrograde) Δv does. That is the lesson.
function orbitReadouts(s, n = PHYS.n) {
  const da = 4 * s.x + (2 * s.vy) / n;
  const amp = Math.hypot(s.vx / n, 3 * s.x + (2 * s.vy) / n);
  return { da, amp, perigeeDelta: da - amp };
}

function fmtMeters(m) {
  const a = Math.abs(m);
  if (a >= 1000) return `${(m / 1000).toFixed(a >= 10000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const r = raw / p;
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * p;
}

// Earth texture (NASA Blue Marble equirectangular). The image is sampled per-pixel
// against a ray-traced sphere so the surface curves correctly under the LEO horizon view.
const earthTexture = new Image();
earthTexture.crossOrigin = "anonymous";
let earthTextureData = null;
let earthRender = null;        // offscreen sphere render: { canvas, ctx, imageData, uvMap, w, h }
let earthRenderDirty = true;   // forces UV recompute on resize
earthTexture.onload = () => {
  const tc = document.createElement("canvas");
  tc.width = earthTexture.naturalWidth;
  tc.height = earthTexture.naturalHeight;
  const tx = tc.getContext("2d");
  tx.drawImage(earthTexture, 0, 0);
  try {
    earthTextureData = tx.getImageData(0, 0, tc.width, tc.height);
  } catch (err) {
    // file:// usually trips CORS for getImageData — caller falls back to procedural.
    earthTextureData = null;
    console.warn("Earth texture sampling blocked (CORS). Falling back to procedural surface.", err);
  }
};
earthTexture.onerror = () => {
  earthTextureData = null;
};
earthTexture.src = "earth_texture.jpg?v=8k";

const pointer = {
  x: 0,
  y: 0,
  active: false,
  firing: false
};

const viewControl = {
  yaw: 0,
  pitch: 0,
  dragging: false,
  pointerId: null,
  lastX: 0,
  lastY: 0
};

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = Math.max(320, rect.width);
  height = Math.max(420, rect.height);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pointer.x = pointer.x || width * 0.5;
  pointer.y = pointer.y || height * 0.44;
  earthRenderDirty = true;
  buildStars();
  if (state) {
    state.emitter = satelliteEmitter();
    state.orbit.centerX = width * 0.5;
    state.orbit.centerY = height * 0.43;
    syncDebrisRender();
  }
}

function buildStars() {
  const rand = seededRandom(4721);
  const count = Math.floor((width * height) / 5600);
  stars = Array.from({ length: count }, () => ({
    x: rand() * width,
    y: rand() * height,
    r: 0.45 + rand() * 1.6,
    a: 0.25 + rand() * 0.75,
    drift: 0.05 + rand() * 0.18,
    z: 0.25 + rand() * 1.1
  }));
}

function satelliteEmitter() {
  return { x: width * 1.08, y: height * 0.43 };
}

function vanishingPoint() {
  return { x: width * 0.5, y: height * 0.42 };
}

const TARGET_TYPES = ["debris", "boxwing", "rocket"];
const TARGET_LABELS = { debris: "DEBRIS", boxwing: "BOX-WING", rocket: "ROCKET" };
let currentTargetType = "debris";

// Difficulty scales the target's initial tumble (angular rates) and relative
// drift speed, plus a score multiplier. The main lever is the spin rate, so a
// HARD target arrives spinning ~3x faster than an EASY one.
const DIFFICULTY_TYPES = ["easy", "normal", "hard"];
const DIFFICULTY_LABELS = { easy: "EASY", normal: "NORMAL", hard: "HARD" };
const DIFFICULTY = {
  easy:   { spin: 0.55, drift: 0.65, scoreMul: 0.7 },
  normal: { spin: 1.0,  drift: 1.0,  scoreMul: 1.0 },
  hard:   { spin: 1.7,  drift: 1.4,  scoreMul: 1.6 }
};
let currentDifficulty = "normal";

// Per-target baseline (at NORMAL difficulty). Translation is SI: massKg [kg],
// radiusM [m] (sets the px-per-meter render scale), v0 = initial relative
// drift { r: radial, v: along-track, h: cross-track } [m/s]. Attitude keeps
// the stylized game-time tuning (omega, inertia) because real despin and
// deorbit timescales differ by orders of magnitude — hit geometry and torque
// signs stay honest. goalDp = per-pass perigee-lowering target [m]; heavier
// objects move less per pass, as in real laser-ADR campaign studies.
// Difficulty multiplies the spin (omega*) and drift (v0) fields.
const TARGET_BASE = {
  debris:  { massKg: 220,  radiusM: 1.6, goalDp: 2000, v0: { r: -0.008, v: -0.020, h: 0 },
             angle: -0.42, pitch: 0.36, roll: -0.22, omega: 1.72, omegaPitch: 0.34, omegaRoll: -0.28, inertia: 240000 },
  boxwing: { massKg: 700,  radiusM: 3.4, goalDp: 800,  v0: { r: -0.005, v: -0.012, h: 0 },
             angle: -0.18, pitch: 0.12, roll: -0.05, omega: 0.95, omegaPitch: 0.18, omegaRoll: -0.12, inertia: 165000 },
  rocket:  { massKg: 2600, radiusM: 4.6, goalDp: 400,  v0: { r: -0.004, v: -0.008, h: 0 },
             angle: -0.30, pitch: 0.06, roll: 0.42,  omega: 1.05, omegaPitch: 0.07, omegaRoll: 0.34,  inertia: 300000 }
};

function makeBoxWingShape(scale) {
  // Top-down outline used for laser ray-polygon intersection.
  const bx = 0.30 * scale;   // bus half-X (along wing axis)
  const by = 0.27 * scale;   // bus half-Y (perpendicular)
  const wx = scale;           // wing tip distance from origin
  const wy = 0.21 * scale;    // wing half-Y (slightly thinner than bus)
  return [
    { x:  wx, y: -wy },
    { x:  wx, y:  wy },
    { x:  bx, y:  wy },
    { x:  bx, y:  by },
    { x: -bx, y:  by },
    { x: -bx, y:  wy },
    { x: -wx, y:  wy },
    { x: -wx, y: -wy },
    { x: -bx, y: -wy },
    { x: -bx, y: -by },
    { x:  bx, y: -by },
    { x:  bx, y: -wy }
  ];
}

function makeBoxWingMesh(scale) {
  const bx = 0.30 * scale;
  const by = 0.27 * scale;
  const bz = 0.27 * scale;
  const wx = scale;
  const wy = 0.21 * scale;
  const wz = 0.010 * scale;
  const verts = [];
  const faces = [];
  const push = (x, y, z) => { verts.push({ x, y, z }); return verts.length - 1; };
  const cube = (x0, x1, y0, y1, z0, z1, kindFront, kindSide, kindBack, kindTop, kindBottom, options = {}) => {
    const v = [
      push(x0, y0, z0), push(x1, y0, z0), push(x1, y1, z0), push(x0, y1, z0),
      push(x0, y0, z1), push(x1, y0, z1), push(x1, y1, z1), push(x0, y1, z1)
    ];
    const detail = options.detail;
    faces.push({ indices: [v[4], v[5], v[6], v[7]], shade: options.frontShade ?? 1.00, kind: kindFront, detail });
    faces.push({ indices: [v[3], v[2], v[1], v[0]], shade: options.backShade ?? 0.40, kind: kindBack, detail });
    faces.push({ indices: [v[1], v[5], v[6], v[2]], shade: options.sideShade ?? 0.78, kind: kindSide, detail });
    faces.push({ indices: [v[3], v[7], v[4], v[0]], shade: options.sideShade ?? 0.78, kind: kindSide, detail });
    faces.push({ indices: [v[2], v[6], v[7], v[3]], shade: options.topShade ?? 0.92, kind: kindTop, detail });
    faces.push({ indices: [v[0], v[4], v[5], v[1]], shade: options.bottomShade ?? 0.55, kind: kindBottom, detail });
  };
  const panelModule = (x0, x1, y0, y1, z0, z1, detail) => {
    cube(x0, x1, y0, y1, z0, z1, "panel", "panel-edge", "panel-back", "panel-edge", "panel-edge", {
      frontShade: 1.05,
      sideShade: 0.68,
      backShade: 0.38,
      detail
    });
  };
  const dish = (cx, cy, z, rOuter, rInner, depth, segments, kind) => {
    const front = [];
    const back = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      front.push(push(cx + Math.cos(a) * rOuter, cy + Math.sin(a) * rOuter, z));
      back.push(push(cx + Math.cos(a) * rInner, cy + Math.sin(a) * rInner, z + depth));
    }
    for (let i = 0; i < segments; i++) {
      const n = (i + 1) % segments;
      faces.push({ indices: [front[i], front[n], back[n], back[i]], shade: 0.92, kind });
    }
    faces.push({ indices: [...back].reverse(), shade: 1.08, kind: "antenna-feed" });
  };
  const solarArray = (side) => {
    const root = side > 0 ? bx + 0.06 * scale : -bx - 0.06 * scale;
    const tip = side > 0 ? wx : -wx;
    const inner = Math.min(root, tip);
    const outer = Math.max(root, tip);
    const length = outer - inner;
    const cols = 8;
    const rows = 4;
    const gapX = 0.004 * scale;
    const gapY = 0.004 * scale;
    const rail = 0.010 * scale;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x0 = inner + (length * c) / cols + gapX * 0.5;
        const x1 = inner + (length * (c + 1)) / cols - gapX * 0.5;
        const y0 = -wy + ((wy * 2) * r) / rows + gapY * 0.5;
        const y1 = -wy + ((wy * 2) * (r + 1)) / rows - gapY * 0.5;
        panelModule(x0, x1, y0, y1, -wz, wz, { col: c, row: r, side });
      }
    }
    cube(inner, outer, wy, wy + rail, -wz * 1.3, wz * 1.3, "panel-edge", "panel-edge", "panel-back", "panel-edge", "panel-edge", { frontShade: 0.62, sideShade: 0.5 });
    cube(inner, outer, -wy - rail, -wy, -wz * 1.3, wz * 1.3, "panel-edge", "panel-edge", "panel-back", "panel-edge", "panel-edge", { frontShade: 0.62, sideShade: 0.5 });
    cube(inner - rail, inner, -wy, wy, -wz * 1.3, wz * 1.3, "panel-edge", "panel-edge", "panel-back", "panel-edge", "panel-edge", { frontShade: 0.62, sideShade: 0.5 });
    cube(outer, outer + rail, -wy, wy, -wz * 1.3, wz * 1.3, "panel-edge", "panel-edge", "panel-back", "panel-edge", "panel-edge", { frontShade: 0.62, sideShade: 0.5 });
    const boomY = wy + 0.035 * scale;
    cube(side > 0 ? bx * 0.68 : -wx, side > 0 ? wx : -bx * 0.68, boomY, boomY + 0.025 * scale, -0.018 * scale, 0.018 * scale, "boom", "boom", "boom", "boom", "boom");
    cube(side > 0 ? bx * 0.68 : -wx, side > 0 ? wx : -bx * 0.68, -boomY - 0.025 * scale, -boomY, -0.018 * scale, 0.018 * scale, "boom", "boom", "boom", "boom", "boom");
  };
  // Multi-layer spacecraft bus with thermal-blanket faces, radiator panels, optics, and antenna hardware.
  cube(-bx, bx, -by, by, -bz, bz, "bus", "bus-side", "bus-back", "bus-top", "bus-bottom");
  cube(-bx * 0.74, bx * 0.74, -by * 0.78, by * 0.78, bz * 0.96, bz + 0.055 * scale, "bus-blanket", "bus-rim", "bus", "bus-rim", "bus-rim", { frontShade: 1.05 });
  cube(-bx * 0.23, bx * 0.28, -by * 0.24, by * 0.23, bz + 0.052 * scale, bz + 0.105 * scale, "instrument-lens", "instrument-ring", "instrument-ring", "instrument-ring", "instrument-ring", { frontShade: 1.12, sideShade: 0.58 });
  cube(-bx * 0.86, -bx * 0.47, by * 0.33, by * 0.72, bz + 0.046 * scale, bz + 0.075 * scale, "radiator", "bus-rim", "bus-rim", "bus-rim", "bus-rim", { frontShade: 0.86, sideShade: 0.52 });
  cube(bx * 0.48, bx * 0.84, -by * 0.72, -by * 0.34, bz + 0.046 * scale, bz + 0.075 * scale, "radiator", "bus-rim", "bus-rim", "bus-rim", "bus-rim", { frontShade: 0.82, sideShade: 0.52 });
  cube(-0.018 * scale, 0.018 * scale, -by * 1.16, -by * 0.72, bz * 0.34, bz * 0.46, "antenna-mast", "antenna-mast", "antenna-mast", "antenna-mast", "antenna-mast");
  dish(0, -by * 1.28, bz * 0.44, 0.095 * scale, 0.035 * scale, 0.05 * scale, 12, "antenna-dish");
  cube(-bx * 1.16, -bx, -0.026 * scale, 0.026 * scale, -0.028 * scale, 0.028 * scale, "boom", "boom", "boom", "boom", "boom");
  cube(bx, bx * 1.16, -0.026 * scale, 0.026 * scale, -0.028 * scale, 0.028 * scale, "boom", "boom", "boom", "boom", "boom");
  solarArray(1);
  solarArray(-1);
  return { verts, faces };
}

function makeRocketShape(scale) {
  // Top-down silhouette of a spent upper stage: long cylindrical hull tapering to
  // a forward dome, with a flared engine bell at the aft end.
  const r = scale * 0.30;
  const fwd = scale * 0.74;
  const aft = -scale * 0.72;
  const nozzle = -scale * 1.0;
  const rBell = r * 0.66;
  return [
    { x: scale * 0.98, y:  r * 0.38 },  // forward dome tip (top)
    { x: fwd,          y:  r },          // hull forward (top)
    { x: aft,          y:  r },          // hull aft (top)
    { x: nozzle,       y:  rBell },      // nozzle lip (top)
    { x: nozzle,       y: -rBell },      // nozzle lip (bottom)
    { x: aft,          y: -r },          // hull aft (bottom)
    { x: fwd,          y: -r },          // hull forward (bottom)
    { x: scale * 0.98, y: -r * 0.38 }    // forward dome tip (bottom)
  ];
}

function makeRocketMesh(scale) {
  // Body of revolution about the local X axis (the long axis), assembled from
  // rings of vertices joined by quad "tubes". No backface culling is needed —
  // drawDebris paints faces back-to-front.
  const verts = [];
  const faces = [];
  const seg = 16;
  const push = (x, y, z) => { verts.push({ x, y, z }); return verts.length - 1; };
  const ring = (x, r) => {
    const idx = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      idx.push(push(x, Math.cos(a) * r, Math.sin(a) * r));
    }
    return idx;
  };
  const tube = (a, b, kind, shade = 0.95) => {
    for (let i = 0; i < seg; i++) {
      const n = (i + 1) % seg;
      faces.push({ indices: [a[i], a[n], b[n], b[i]], shade, kind });
    }
  };

  const r = scale * 0.30;          // hull radius
  const rThroat = r * 0.42;        // engine throat radius
  const rBell = r * 0.66;          // engine bell lip radius

  // X stations, forward (+) to aft (-).
  const domeTip = ring(scale * 0.98, r * 0.38);
  const fwd     = ring(scale * 0.74, r);
  const bandF   = ring(scale * 0.12, r * 1.06);
  const bandA   = ring(-scale * 0.06, r * 1.06);
  const aft     = ring(-scale * 0.72, r);
  const throat  = ring(-scale * 0.72, rThroat);
  const bell    = ring(-scale * 1.0, rBell);

  faces.push({ indices: [...domeTip], shade: 1.0, kind: "rocket-dome" });   // forward cap
  tube(domeTip, fwd, "rocket-hull", 0.92);                                  // forward taper
  tube(fwd, bandF, "rocket-hull");                                          // forward hull
  tube(bandF, bandA, "rocket-band", 0.82);                                  // interstage band
  tube(bandA, aft, "rocket-hull");                                          // aft hull
  tube(aft, throat, "rocket-mount", 0.7);                                   // engine mounting plate (annulus)
  faces.push({ indices: [...throat].reverse(), shade: 0.36, kind: "rocket-mount" }); // close the throat
  tube(throat, bell, "nozzle", 0.78);                                       // flared engine bell
  return { verts, faces };
}

function buildTarget(type, radius) {
  if (type === "boxwing") {
    const scale = radius * 1.1;
    return {
      shape: makeBoxWingShape(scale),
      mesh: makeBoxWingMesh(scale),
      kind: "boxwing"
    };
  }
  if (type === "rocket") {
    const scale = radius;
    return {
      shape: makeRocketShape(scale),
      mesh: makeRocketMesh(scale),
      kind: "rocket"
    };
  }
  const shape = makeDebrisShape().map((p) => ({ x: (p.x * radius) / 78, y: (p.y * radius) / 78 }));
  return {
    shape,
    mesh: makeDebrisMesh(shape, radius),
    kind: "debris"
  };
}

function makeDebrisShape() {
  const rand = seededRandom(817);
  const verts = [];
  const n = 13;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (rand() - 0.5) * 0.16;
    const r = 46 + rand() * 43;
    verts.push({
      x: Math.cos(a) * r * (1.2 + rand() * 0.22),
      y: Math.sin(a) * r * (0.76 + rand() * 0.28)
    });
  }
  return verts;
}

function makeDebrisMesh(shape, radius) {
  const depth = radius * 0.82;
  const verts = [];
  for (const p of shape) verts.push({ x: p.x, y: p.y, z: depth * 0.5 });
  for (const p of shape) verts.push({ x: p.x * 0.86, y: p.y * 0.9, z: -depth * 0.5 });

  const n = shape.length;
  const faces = [];
  faces.push({ indices: [...Array(n).keys()], shade: 1.0, kind: "front" });
  faces.push({ indices: [...Array(n).keys()].map((i) => i + n).reverse(), shade: 0.34, kind: "back" });
  for (let i = 0; i < n; i++) {
    faces.push({
      indices: [i, (i + 1) % n, ((i + 1) % n) + n, i + n],
      shade: 0.56 + (i % 3) * 0.08,
      kind: "side"
    });
  }
  return { verts, faces };
}

function resetGame() {
  particles = [];
  messages = [];
  const radius = Math.min(width, height) * 0.12;
  const target = buildTarget(currentTargetType, radius);
  const base = TARGET_BASE[currentTargetType] || TARGET_BASE.debris;
  const diff = DIFFICULTY[currentDifficulty] || DIFFICULTY.normal;
  const mode = MODES[currentMode] || MODES.realism;
  const pxPerM = radius / base.radiusM;
  // Chaser leads the debris along +V; the camera looks aft at it. The standoff
  // is whatever distance puts the debris at the usual screen anchor.
  const standoffM = (width * CHASER.standoffFrac) / pxPerM;
  state = {
    paused: false,
    won: false,
    failed: false,
    failReason: "",
    overheated: false,
    phase: "DESPIN",
    time: 0,
    energy: 1,
    heat: 0,
    score: 0,
    scoreMul: diff.scoreMul,
    stableHold: 0,
    removalProgress: 0,
    lastHit: null,
    emitter: satelliteEmitter(),
    pxPerM,
    standoffM,
    goalDp: base.goalDp,
    fuel: mode.fuelBudget,
    fuelBudget: mode.fuelBudget,
    deltaA: 0,
    oscAmp: 0,
    perigeeDelta: 0,
    // Debris relative state in the Hill frame of the reference orbit [m, m/s].
    rel: {
      x: 0,
      y: -standoffM,
      z: 0,
      vx: base.v0.r * diff.drift,
      vy: base.v0.v * diff.drift,
      vz: base.v0.h * diff.drift
    },
    // Chaser starts on the reference orbit origin and station-keeps from there.
    chaser: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, dvUsed: 0 },
    trailRel: [],
    trailTimer: 0,
    orbit: {
      centerX: width * 0.5,
      centerY: height * 0.43,
      meanMotion: PHYS.n,
      phase: 0.18,
      phaseRate: PHYS.n,
      trail: []
    },
    sun: {
      beta: ORBIT.betaDeg * Math.PI / 180,
      dir: { x: 0, y: -1, z: 0 },
      illumination: 1,
      eclipseDepth: 0,
      inEclipse: false,
      timeToEvent: 0,
      nextEvent: "ECLIPSE"
    },
    earth: makeEarthSurface(),
    debris: {
      x: width * 0.5,
      y: height * 0.43,
      z: 0,
      angle: base.angle,
      pitch: base.pitch,
      roll: base.roll,
      omega: base.omega * diff.spin,
      omegaPitch: base.omegaPitch * diff.spin,
      omegaRoll: base.omegaRoll * diff.spin,
      massKg: base.massKg,
      inertia: base.inertia,
      radius,
      shape: target.shape,
      mesh: target.mesh,
      kind: target.kind,
      dv: 0
    }
  };
  syncDebrisRender();
}

// Derive the debris' pixel-space render position from the SI relative states.
// World px axes: +x = +V (depth toward camera), +y = -R (nadir, screen down),
// +z = +H (cross-track). The camera sits at the chaser (emitter).
function syncDebrisRender() {
  const d = state.debris;
  const rel = state.rel;
  const ch = state.chaser;
  const ppm = state.pxPerM;
  d.x = state.emitter.x + (rel.y - ch.y) * ppm;
  d.y = state.orbit.centerY - (rel.x - ch.x) * ppm;
  d.z = (rel.z - ch.z) * ppm;
}

function worldPoint(local, debris = state.debris) {
  const c = Math.cos(debris.angle);
  const s = Math.sin(debris.angle);
  return {
    x: debris.x + local.x * c - local.y * s,
    y: debris.y + local.x * s + local.y * c
  };
}

function localVector(world, debris = state.debris) {
  const c = Math.cos(-debris.angle);
  const s = Math.sin(-debris.angle);
  return {
    x: world.x * c - world.y * s,
    y: world.x * s + world.y * c
  };
}

function debrisPolygon() {
  return state.debris.shape.map((p) => worldPoint(p));
}

function rotateAroundAxis(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(v, axis);
  return normalize3({
    x: v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d * (1 - c),
    y: v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d * (1 - c),
    z: v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d * (1 - c)
  });
}

function cameraAxes() {
  const baseForward = { x: -1, y: 0, z: 0 }; // Laser satellite looks toward -V by default.
  const baseUp = { x: 0, y: -1, z: 0 };      // +R / zenith is screen-up.
  let forward = rotateAroundAxis(baseForward, baseUp, viewControl.yaw);
  let right = normalize3({
    x: forward.y * baseUp.z - forward.z * baseUp.y,
    y: forward.z * baseUp.x - forward.x * baseUp.z,
    z: forward.x * baseUp.y - forward.y * baseUp.x
  });
  forward = rotateAroundAxis(forward, right, viewControl.pitch);
  const up = normalize3({
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x
  });
  right = normalize3({
    x: forward.y * up.z - forward.z * up.y,
    y: forward.z * up.x - forward.x * up.z,
    z: forward.x * up.y - forward.y * up.x
  });
  return { forward, right, up };
}

function cameraOrigin() {
  return { x: state.emitter.x, y: state.emitter.y, z: 0 };
}

function cameraFocal() {
  return Math.max(320, Math.min(width, height) * 0.64);
}

function viewCenter() {
  return { x: width * 0.5, y: height * 0.43 };
}

function worldToCamera(point) {
  const origin = cameraOrigin();
  const axes = cameraAxes();
  const rel = {
    x: point.x - origin.x,
    y: point.y - origin.y,
    z: point.z - origin.z
  };
  return {
    x: dot3(rel, axes.right),
    y: dot3(rel, axes.up),
    z: dot3(rel, axes.forward),
    axes
  };
}

function projectWorldPoint(point) {
  const camera = worldToCamera(point);
  const focal = cameraFocal();
  const center = viewCenter();
  const depth = Math.max(18, camera.z);
  const scale = focal / depth;
  return {
    x: center.x + camera.x * scale,
    y: center.y - camera.y * scale,
    z: point.z,
    depth: camera.z,
    scale
  };
}

function cameraRayFromScreen(x, y) {
  const axes = cameraAxes();
  const center = viewCenter();
  const focal = cameraFocal();
  const sx = (x - center.x) / focal;
  const sy = -(y - center.y) / focal;
  return normalize3({
    x: axes.forward.x + axes.right.x * sx + axes.up.x * sy,
    y: axes.forward.y + axes.right.y * sx + axes.up.y * sy,
    z: axes.forward.z + axes.right.z * sx + axes.up.z * sy
  });
}

function screenNormalFromWorld(normal) {
  const axes = cameraAxes();
  const nx = dot3(normal, axes.right);
  const ny = -dot3(normal, axes.up);
  const nlen = Math.hypot(nx, ny);
  if (nlen < 0.05) return null;
  return { x: nx / nlen, y: ny / nlen };
}

function rayPolygonIntersect3D(origin, dir, verts) {
  // Plane from the first three vertices (faces are flat by construction).
  const v0 = verts[0];
  const v1 = verts[1];
  const v2 = verts[2];
  const e1x = v1.x - v0.x, e1y = v1.y - v0.y, e1z = v1.z - v0.z;
  const e2x = v2.x - v0.x, e2y = v2.y - v0.y, e2z = v2.z - v0.z;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const denom = nx * dir.x + ny * dir.y + nz * dir.z;
  if (Math.abs(denom) < 1e-6) return null;
  const ox = v0.x - origin.x;
  const oy = v0.y - origin.y;
  const oz = v0.z - origin.z;
  const t = (nx * ox + ny * oy + nz * oz) / denom;
  if (t <= 0) return null;
  const px = origin.x + dir.x * t;
  const py = origin.y + dir.y * t;
  const pz = origin.z + dir.z * t;
  // Project onto the plane axis with the smallest normal component, then
  // run a 2-D point-in-polygon test on the surviving axes.
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let pu, pv;
  let polyU, polyV;
  if (ax >= ay && ax >= az) {
    polyU = (q) => q.y; polyV = (q) => q.z; pu = py; pv = pz;
  } else if (ay >= az) {
    polyU = (q) => q.x; polyV = (q) => q.z; pu = px; pv = pz;
  } else {
    polyU = (q) => q.x; polyV = (q) => q.y; pu = px; pv = py;
  }
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const aU = polyU(verts[i]), aV = polyV(verts[i]);
    const bU = polyU(verts[j]), bV = polyV(verts[j]);
    if (((aV > pv) !== (bV > pv)) &&
        (pu < (bU - aU) * (pv - aV) / (bV - aV) + aU)) {
      inside = !inside;
    }
  }
  if (!inside) return null;
  const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return {
    t,
    point: { x: px, y: py, z: pz },
    normal: { x: nx / nlen, y: ny / nlen, z: nz / nlen }
  };
}

function findLaserHit() {
  const debris = state.debris;
  const rayOriginWorld = cameraOrigin();
  const rayDir = cameraRayFromScreen(pointer.x, pointer.y);
  const rayOrigin = {
    x: rayOriginWorld.x - debris.x,
    y: rayOriginWorld.y - debris.y,
    z: rayOriginWorld.z - debris.z
  };
  const rotated = debris.mesh.verts.map((v) => rotateDebrisVertex(v, debris));
  let best = null;
  for (const face of debris.mesh.faces) {
    const verts = face.indices.map((i) => rotated[i]);
    const result = rayPolygonIntersect3D(rayOrigin, rayDir, verts);
    if (!result) continue;
    if (best && result.t >= best.t) continue;
    // Make the surface normal face the camera (and the laser).
    let n3 = result.normal;
    if (n3.x * rayDir.x + n3.y * rayDir.y + n3.z * rayDir.z > 0) {
      n3 = { x: -n3.x, y: -n3.y, z: -n3.z };
    }
    best = {
      t: result.t,
      point3D: result.point,
      normal3D: n3,
      face
    };
  }
  if (!best) return null;
  const hitWorld = {
    x: debris.x + best.point3D.x,
    y: debris.y + best.point3D.y,
    z: debris.z + best.point3D.z
  };
  const screenPoint = projectWorldPoint(hitWorld);
  let normal2D = screenNormalFromWorld(best.normal3D);
  if (!normal2D) {
    const centerPoint = projectWorldPoint({ x: debris.x, y: debris.y, z: debris.z });
    const rx = screenPoint.x - centerPoint.x;
    const ry = screenPoint.y - centerPoint.y;
    const rl = Math.hypot(rx, ry) || 1;
    normal2D = { x: rx / rl, y: ry / rl };
  }
  const center = viewCenter();
  const aimDX = pointer.x - center.x;
  const aimDY = pointer.y - center.y;
  const aimLen = Math.hypot(aimDX, aimDY) || 1;
  return {
    t: best.t,
    point: screenPoint,
    point3D: best.point3D,
    normal: normal2D,
    normal3D: best.normal3D,
    rayDir3D: rayDir,
    dir: { x: aimDX / aimLen, y: aimDY / aimLen },
    face: best.face,
    faceKind: best.face.kind
  };
}

function addParticles(hit, forceDir, intensity) {
  for (let i = 0; i < 9; i++) {
    const spread = (Math.random() - 0.5) * 0.9;
    const c = Math.cos(spread);
    const s = Math.sin(spread);
    const dx = forceDir.x * c - forceDir.y * s;
    const dy = forceDir.x * s + forceDir.y * c;
    const speed = 50 + Math.random() * 190 * intensity;
    particles.push({
      x: hit.point.x,
      y: hit.point.y,
      vx: dx * speed + (Math.random() - 0.5) * 18,
      vy: dy * speed + (Math.random() - 0.5) * 18,
      life: 0.35 + Math.random() * 0.38,
      maxLife: 0.7,
      size: 1.2 + Math.random() * 2.7,
      color: Math.random() > 0.35 ? "#48f3ff" : "#ffd166"
    });
  }
}

function applyLaser(dtGame, dtPhys) {
  const canFire = pointer.firing && state.energy > 0.02 && state.heat < 0.99 && !state.won && !state.failed;
  if (!canFire) {
    state.lastHit = null;
    return;
  }

  state.energy = clamp(state.energy - dtGame * 0.058, 0, 1);
  state.heat = clamp(state.heat + dtGame * 0.22, 0, 1.05);
  const hit = findLaserHit();
  if (!hit) {
    state.lastHit = { miss: true, dir: null, point: { x: pointer.x, y: pointer.y } };
    return;
  }

  const debris = state.debris;
  // outwardScore: how square the beam strikes the surface (0 = grazing, 1 = perpendicular).
  // The beam ray and the hit normal are both in the laser-satellite camera frame.
  const outwardScore = clamp(-dot3(hit.rayDir3D, hit.normal3D), 0.15, 1);

  // Translation: real ablation impulse in SI, applied over physical time. The
  // jet ejects material along +normal; by Newton's third law the reaction Δv
  // on the debris is along −normal (away from the laser).
  // World px axes: +x = +V (along-track), +y = -R (nadir), +z = +H.
  const dvSI = (LASER_THRUST_N * outwardScore / debris.massKg) * dtPhys;
  state.rel.vy -= hit.normal3D.x * dvSI;   // along-track (+prograde)
  state.rel.vx += hit.normal3D.y * dvSI;   // radial (+zenith); world +y is nadir
  state.rel.vz -= hit.normal3D.z * dvSI;   // cross-track
  debris.dv += dvSI;

  // Attitude: stylized impulse magnitude (game-time pacing — real despin and
  // deorbit timescales are orders of magnitude apart), honest geometry/signs.
  const impulse = (4600 * outwardScore) * dtGame;

  // 3-D torque  τ = r × F  with F = −n̂ · |impulse|  (inward thrust at hit point).
  const Fx = -hit.normal3D.x * impulse;
  const Fy = -hit.normal3D.y * impulse;
  const Fz = -hit.normal3D.z * impulse;
  const rx = hit.point3D.x;
  const ry = hit.point3D.y;
  const rz = hit.point3D.z;
  const tauX = ry * Fz - rz * Fy;
  const tauY = rz * Fx - rx * Fz;
  const tauZ = rx * Fy - ry * Fx;
  debris.omega      += tauZ / debris.inertia;
  debris.omegaPitch += tauX / debris.inertia;
  debris.omegaRoll  += tauY / debris.inertia;

  const spinBefore = Math.abs(debris.omega);
  const brakeBias = -Math.sign(debris.omega || 1) * Math.sign(tauZ || 1);
  const quality = brakeBias > 0 ? 1.0 : -0.35;
  state.score = Math.max(0, state.score + Math.floor((60 * outwardScore * quality + 18) * dtGame * 60 * (state.scoreMul || 1)));
  state.lastHit = { ...hit, forceDir: hit.normal, quality };

  if (Math.abs(debris.omega) < spinBefore || quality > 0) {
    addParticles(hit, hit.normal, outwardScore);
  }
}

function updateSunModel(dt) {
  const orbit = state.orbit;
  const sun = state.sun;
  orbit.phase = (orbit.phase + orbit.phaseRate * dt) % TAU;

  const phase = orbit.phase;
  const beta = sun.beta;
  const cosBeta = Math.cos(beta);

  // Sun direction in inertial frame: pinned at +x_inertial, with beta out of plane.
  // In LVLH the sun rotates with orbit phase. With phase=0 = noon, the sun is in +R (zenith).
  //   sun_LVLH = ( cos(beta)cos(phase),  -cos(beta)sin(phase),  sin(beta) )  [R, V, H]
  // Screen mapping: x_s = +V, y_s = -R, z_s = +H.
  const sunR = cosBeta * Math.cos(phase);
  const sunV = -cosBeta * Math.sin(phase);
  const sunH = Math.sin(beta);
  sun.dir = normalize3({
    x: sunV,
    y: -sunR,
    z: sunH
  });

  // Eclipse half-angle from circular-orbit geometry:
  //   cos(η) = √(1 − (Re/Rorb)²) / cos(β)
  // For SSO (Rorb≈6971 km, β≈22°) this gives ~32 s of eclipse per 90 s orbit.
  // When |cos(β)| ≤ √(1 − (Re/Rorb)²), the orbit clears Earth's shadow entirely
  // (e.g. dawn–dusk SSO) and there is no eclipse.
  const Re = 6371;
  const Rorb = Re + ORBIT.altitudeKm;
  const horizonCos = Math.sqrt(Math.max(0, 1 - (Re / Rorb) * (Re / Rorb)));
  let eclipseHalf = 0;
  if (Math.cos(beta) > horizonCos + 1e-3) {
    eclipseHalf = Math.acos(horizonCos / Math.cos(beta));
  }
  sun.eclipseHalfAngle = eclipseHalf;
  const distToMidnight = Math.abs(phase - Math.PI);
  const penumbraWidth = 0.06;
  sun.eclipseDepth = eclipseHalf > 0
    ? clamp((eclipseHalf - distToMidnight) / penumbraWidth + 0.5, 0, 1)
    : 0;
  sun.illumination = 1 - sun.eclipseDepth;
  sun.inEclipse = sun.illumination < 0.18;

  if (eclipseHalf > 0) {
    if (sun.inEclipse) {
      sun.nextEvent = "SUNRISE";
      const exit = (Math.PI + eclipseHalf - phase + TAU) % TAU;
      sun.timeToEvent = exit / orbit.phaseRate;
    } else {
      sun.nextEvent = "ECLIPSE";
      const enter = (Math.PI - eclipseHalf - phase + TAU) % TAU;
      sun.timeToEvent = enter / orbit.phaseRate;
    }
  } else {
    sun.nextEvent = "SUNLIT";
    sun.timeToEvent = 0;
  }
}

function update(dtWall) {
  if (state.paused) return;
  const dtGame = dtWall * TIME_SCALE;   // stylized clock: attitude, heat, FX
  const dtPhys = dtWall * TIME_WARP;    // physical seconds: orbit dynamics, sun
  state.time += dtGame;
  const debris = state.debris;
  const mode = MODES[currentMode] || MODES.realism;

  updateSunModel(dtPhys);
  applyLaser(dtGame, dtPhys);

  const solarFactor = 0.18 + 0.82 * state.sun.illumination;
  state.energy = clamp(state.energy + dtGame * 0.021 * solarFactor, 0, 1);
  state.heat = clamp(state.heat - dtGame * 0.105, 0, 1);
  state.overheated = state.heat > 0.94;

  // --- Relative orbital motion: exact closed-form CW propagation (SI). ---
  const rel = cwPropagate(state.rel, dtPhys);
  if (mode.damping) {
    // ARCADE assist only — the real vacuum dynamics are lossless.
    const k = Math.pow(0.9995, dtGame * 60);
    rel.vx *= k;
    rel.vy *= k;
    rel.vz *= k;
  }
  state.rel = rel;

  // --- Chaser station-keeping: PD follower paying real Δv to hold formation.
  // Drift you let build up is fuel the chaser must spend chasing it.
  const ch = state.chaser;
  const chNext = cwPropagate(ch, dtPhys);
  chNext.dvUsed = ch.dvUsed || 0;
  if (!state.won && !state.failed) {
    const ux = clamp(CHASER.kp * (rel.x - ch.x) + CHASER.kd * (rel.vx - ch.vx), -CHASER.uMax, CHASER.uMax);
    const uy = clamp(CHASER.kp * (rel.y + state.standoffM - ch.y) + CHASER.kd * (rel.vy - ch.vy), -CHASER.uMax, CHASER.uMax);
    const uz = clamp(CHASER.kp * (rel.z - ch.z) + CHASER.kd * (rel.vz - ch.vz), -CHASER.uMax, CHASER.uMax);
    chNext.vx += ux * dtPhys;
    chNext.vy += uy * dtPhys;
    chNext.vz += uz * dtPhys;
    const used = Math.hypot(ux, uy, uz) * dtPhys;
    chNext.dvUsed += used;
    if (Number.isFinite(state.fuel)) {
      state.fuel = Math.max(0, state.fuel - used);
      if (state.fuel <= 0) {
        state.failed = true;
        state.phase = "FAILED";
        state.failReason = "チェイサーの軌道維持燃料が枯渇 — 相対ドリフトを追い切れずデブリをロスト。大きな振動を起こす前にドリフトを抑えること。";
        messages.push({ text: "STATION-KEEPING FUEL DEPLETED", life: 4.2, color: "#ff5268" });
      }
    }
  }
  state.chaser = chNext;

  syncDebrisRender();

  debris.angle += debris.omega * dtGame;
  debris.pitch += debris.omegaPitch * dtGame;
  debris.roll += debris.omegaRoll * dtGame;

  if (mode.damping) {
    // Attitude assist (ARCADE only): tumble decays a little on its own.
    debris.omega *= Math.pow(0.999, dtGame * 60);
    debris.omegaPitch *= Math.pow(0.998, dtGame * 60);
    debris.omegaRoll *= Math.pow(0.998, dtGame * 60);
  }

  const orbit = state.orbit;
  orbit.trail.push({ x: debris.x, y: debris.y, life: 7 });
  orbit.trail = orbit.trail.filter((p) => {
    p.life -= dtGame;
    return p.life > 0;
  }).slice(-170);

  // Hill-frame trail for the R-V map (sampled in wall time).
  state.trailTimer -= dtWall;
  if (state.trailTimer <= 0) {
    state.trailTimer = 0.3;
    state.trailRel.push({ x: rel.x, y: rel.y });
    if (state.trailRel.length > 420) state.trailRel.shift();
  }

  const spin = Math.hypot(debris.omega, debris.omegaPitch, debris.omegaRoll);
  if (spin < 0.16) {
    state.stableHold += dtGame;
  } else {
    state.stableHold = Math.max(0, state.stableHold - dtGame * 1.3);
  }
  const stability = clamp(state.stableHold / 2.2, 0, 1);
  if (!state.won && !state.failed) {
    if (stability >= 1 && state.phase !== "REMOVE") {
      state.phase = "REMOVE";
      messages.push({ text: "ATTITUDE LOCK", life: 1.4, color: "#68ffa6" });
      state.score += 1600 * (state.scoreMul || 1);
    } else if (stability > 0.25 && state.phase === "DESPIN") {
      state.phase = "STABILIZE";
    } else if (stability <= 0.03 && state.phase === "STABILIZE") {
      state.phase = "DESPIN";
    }
  }

  // Deorbit progress: only along-track (retrograde) Δv lowers the orbit. The
  // win condition is the predicted perigee drop δr_p = δa − A reaching the
  // per-pass disposal target — equivalently, the one-orbit ghost trajectory
  // dipping below the disposal line in the Hill-frame map.
  const ro = orbitReadouts(rel);
  state.deltaA = ro.da;
  state.oscAmp = ro.amp;
  state.perigeeDelta = ro.perigeeDelta;
  state.removalProgress = clamp(-ro.perigeeDelta / state.goalDp, 0, 1);
  const reachedGoal = ro.perigeeDelta <= -state.goalDp;
  if (!state.won && !state.failed && reachedGoal) {
    if (state.phase === "REMOVE" && spin < 0.16 && stability >= 0.95) {
      state.won = true;
      state.phase = "CLEARED";
      state.score += (4200 + Math.floor(state.energy * 1600)) * (state.scoreMul || 1);
      messages.push({ text: "DEBRIS TRANSFER CONFIRMED", life: 4.2, color: "#48f3ff" });
    } else {
      // Orbit lowered to the disposal target while still tumbling → uncontrolled reentry.
      state.failed = true;
      state.phase = "FAILED";
      state.failReason = spin >= 0.16
        ? `回転を止め切れていません (${spin.toFixed(2)} rad/s)。タンブリングしたまま軌道を下げた — 制御不能な再突入でデブリは回収不能。`
        : "姿勢が安定する前に軌道を下げ過ぎました — デブリは回収不能。";
      messages.push({ text: "UNCONTROLLED REENTRY", life: 4.2, color: "#ff5268" });
    }
  }

  particles = particles.filter((p) => {
    p.life -= dtGame;
    p.x += p.vx * dtGame;
    p.y += p.vy * dtGame;
    p.vx *= Math.pow(0.94, dtGame * 60);
    p.vy *= Math.pow(0.94, dtGame * 60);
    return p.life > 0;
  });

  messages = messages.filter((m) => {
    m.life -= dtGame;
    return m.life > 0;
  });
}

function drawBackground() {
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#020608");
  gradient.addColorStop(0.48, "#061417");
  gradient.addColorStop(1, "#000204");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  drawEarth();

  const vp = vanishingPoint();
  ctx.save();
  for (const star of stars) {
    const push = VIEW_FLOW * state.time * 8 * star.z;
    const sx = vp.x + (star.x - vp.x) * (1 + push / Math.max(width, height));
    const sy = vp.y + (star.y - vp.y) * (1 + push / Math.max(width, height));
    const pulse = 0.75 + Math.sin(state.time * star.drift + star.x) * 0.25;
    ctx.globalAlpha = star.a * pulse;
    ctx.fillStyle = "#e8fbff";
    ctx.fillRect(((sx % width) + width) % width, ((sy % height) + height) % height, star.r * star.z, star.r * star.z);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(104, 255, 230, 0.08)";
  ctx.lineWidth = 1;
  const orbitalDrift = wrap01(VIEW_FLOW * state.time * 0.035);
  for (let i = 0; i < 9; i++) {
    const t = wrap01(i / 8 + orbitalDrift * 0.12);
    const x = lerp(width * 0.08, width * 0.92, t);
    ctx.beginPath();
    ctx.moveTo(vp.x, vp.y);
    ctx.lineTo(x, height * 0.98);
    ctx.stroke();
  }
  for (let i = 0; i < 7; i++) {
    const scale = 0.18 + (((i + orbitalDrift) % 7) + 7) % 7 * 0.16;
    ctx.beginPath();
    ctx.ellipse(vp.x, vp.y + height * scale * 0.44, width * scale, height * scale * 0.2, 0, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
  drawOrbitalMotionCues();
  drawRelativeOrbitTrail();
}

function drawEarth() {
  // Earth sits in the nadir direction (-R), screen-down. Center is far below the
  // viewport so only the planet's near limb (the horizon) is visible.
  const cx = width * 0.5;
  const horizonY = height * 0.68;
  const r = Math.max(width, height) * 1.3;
  const cy = horizonY + r;
  ctx.save();
  const glow = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.55, r * 0.15, cx, cy, r * 1.12);
  glow.addColorStop(0, "rgba(120, 218, 255, 0.22)");
  glow.addColorStop(0.5, "rgba(37, 101, 124, 0.28)");
  glow.addColorStop(0.84, "rgba(7, 34, 49, 0.2)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.08, 0, TAU);
  ctx.fill();

  const earth = ctx.createRadialGradient(cx - r * 0.22, cy - r * 0.68, r * 0.1, cx, cy, r);
  earth.addColorStop(0, "#a8e8ff");
  earth.addColorStop(0.22, "#2c90b4");
  earth.addColorStop(0.48, "#115170");
  earth.addColorStop(0.78, "#082132");
  earth.addColorStop(1, "#02070b");
  ctx.fillStyle = earth;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  drawEarthSurfaceTexture(cx, cy, r);
  ctx.restore();

  const sd = state.sun.dir;
  const sLen = Math.hypot(sd.z, sd.y) || 1;
  const sxN = sd.z / sLen;
  const syN = sd.y / sLen;
  const terminator = ctx.createLinearGradient(
    cx + sxN * r * 1.05,
    cy + syN * r * 1.05,
    cx - sxN * r * 1.05,
    cy - syN * r * 1.05
  );
  terminator.addColorStop(0, "rgba(0, 0, 0, 0)");
  terminator.addColorStop(0.5, "rgba(0, 0, 0, 0.18)");
  terminator.addColorStop(0.62, "rgba(0, 0, 0, 0.42)");
  terminator.addColorStop(1, "rgba(0, 0, 0, 0.78)");
  ctx.fillStyle = terminator;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  const limbGlow = ctx.createRadialGradient(
    cx + sxN * r * 0.6,
    cy + syN * r * 0.6,
    r * 0.05,
    cx + sxN * r * 0.6,
    cy + syN * r * 0.6,
    r * 0.7
  );
  limbGlow.addColorStop(0, `rgba(180, 230, 255, ${0.18 * state.sun.illumination})`);
  limbGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = limbGlow;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = 0.7 * (0.35 + 0.65 * state.sun.illumination);
  ctx.strokeStyle = "rgba(158, 232, 255, 0.42)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 1.02, Math.PI * 1.98);
  ctx.stroke();

  ctx.globalAlpha = 0.26 * state.sun.illumination;
  ctx.strokeStyle = "#d8fbff";
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const bandY = horizonY + 10 + i * 12 + Math.sin(state.time * 0.12 + i) * 1.5;
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.sin(state.time * 0.06 + i) * 18,
      bandY,
      r * (0.22 - i * 0.018),
      3,
      0,
      0,
      TAU
    );
    ctx.stroke();
  }
  ctx.restore();
}

// --- Earth sphere render (per-pixel ray cast against a real sphere) ---

function ensureEarthRender(viewW, viewH) {
  if (!earthTextureData) return null;
  const downsample = 3;
  const w = Math.max(2, Math.floor(viewW / downsample));
  const h = Math.max(2, Math.floor(viewH / downsample));
  const yaw = viewControl.yaw || 0;
  const pitch = viewControl.pitch || 0;
  if (
    earthRender && !earthRenderDirty &&
    earthRender.w === w && earthRender.h === h &&
    earthRender.viewW === viewW && earthRender.viewH === viewH &&
    earthRender.yaw === yaw && earthRender.pitch === pitch
  ) {
    return earthRender;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d");
  const imageData = c.createImageData(w, h);
  for (let i = 3; i < imageData.data.length; i += 4) imageData.data[i] = 0;

  // Camera intrinsics chosen so Earth's geometric horizon lands at horizonY ≈ viewH*0.68.
  // Sat sits at world (Rorb, 0, 0). World axes: +x = zenith, +y = prograde,
  // +z = cross-track. The laser satellite camera looks aft along -y (-V).
  const FOV_v = (60 * Math.PI) / 180;
  const FOV_h = 2 * Math.atan(Math.tan(FOV_v / 2) * (viewW / viewH));
  const tanHalfV = Math.tan(FOV_v / 2);
  const tanHalfH = Math.tan(FOV_h / 2);
  const tilt = (12.7 * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const Re = 6371;
  const Rorb = Re + ORBIT.altitudeKm;

  // Base camera frame in world (aft-looking, slight nadir tilt).
  let camFwd   = { x: -sinT, y: -cosT, z: 0 };
  let camUp    = { x:  cosT, y: -sinT, z: 0 };
  let camRight = { x: 0,     y: 0,     z: 1 };
  // Right-click drag: yaw around camera up, pitch around camera right (after yaw).
  if (yaw !== 0) {
    camFwd   = rotateAroundAxis(camFwd,   camUp, yaw);
    camRight = rotateAroundAxis(camRight, camUp, yaw);
  }
  if (pitch !== 0) {
    camFwd = rotateAroundAxis(camFwd, camRight, pitch);
    camUp  = rotateAroundAxis(camUp,  camRight, pitch);
  }

  // Per-pixel cache: [lat, lon, nx, ny, nz]. Sentinel lat = -10 marks "no hit".
  const uvMap = new Float32Array(w * h * 5);
  const horizonNdxLimit = -Math.sqrt(1 - (Re / Rorb) * (Re / Rorb)) + 1e-4;
  const c0 = Rorb * Rorb - Re * Re;

  for (let py = 0; py < h; py++) {
    const fy = (py + 0.5) / h;
    const ry = (0.5 - fy) * 2 * tanHalfV;
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 5;
      const fx = (px + 0.5) / w;
      const rx = (fx - 0.5) * 2 * tanHalfH;
      const dwx = rx * camRight.x + ry * camUp.x + camFwd.x;
      const dwy = rx * camRight.y + ry * camUp.y + camFwd.y;
      const dwz = rx * camRight.z + ry * camUp.z + camFwd.z;
      const len = Math.sqrt(dwx * dwx + dwy * dwy + dwz * dwz);
      const ndx = dwx / len;
      const ndy = dwy / len;
      const ndz = dwz / len;
      if (ndx >= horizonNdxLimit) {
        uvMap[idx] = -10;
        continue;
      }
      const b = 2 * Rorb * ndx;
      const disc = b * b - 4 * c0;
      if (disc < 0) {
        uvMap[idx] = -10;
        continue;
      }
      const t = (-b - Math.sqrt(disc)) * 0.5;
      const hx = Rorb + t * ndx;
      const hy = t * ndy;
      const hz = t * ndz;
      const nx = hx / Re;
      const ny = hy / Re;
      const nz = hz / Re;
      uvMap[idx]     = Math.asin(nz);
      uvMap[idx + 1] = Math.atan2(hy, hx);
      uvMap[idx + 2] = nx;
      uvMap[idx + 3] = ny;
      uvMap[idx + 4] = nz;
    }
  }

  earthRender = { canvas, ctx: c, imageData, uvMap, w, h, viewW, viewH, yaw, pitch };
  earthRenderDirty = false;
  return earthRender;
}

function renderEarthSphere() {
  const er = ensureEarthRender(width, height);
  if (!er || !earthTextureData) return null;
  const { imageData, uvMap, w, h } = er;
  const data = imageData.data;
  const td = earthTextureData.data;
  const tw = earthTextureData.width;
  const th = earthTextureData.height;
  // Earth-fixed longitude at the nadir in LVLH: sat's inertial longitude (orbit phase)
  // minus Earth's inertial rotation angle. Net ground-track sweep ≈ 1 rev per orbit.
  const lonOffset = wrap01(
    state.orbit.phase / TAU - state.time * (ORBIT.earthRotPerOrbit / ORBIT.periodSec)
  );
  // Latitude bias from orbit phase — SSO sub-sat point sweeps high latitudes.
  const subSatLat = Math.sin(state.orbit.phase) * (ORBIT.inclinationDeg < 90
    ? ORBIT.inclinationDeg
    : 180 - ORBIT.inclinationDeg) * Math.PI / 180;
  // Sun direction in the same world frame the UV map uses (sat at (Rorb,0,0)).
  // At orbit phase = 0 (noon), sun lies in +x_world (zenith). Phase advances → sun rotates around +z.
  const sunWX = Math.cos(state.orbit.phase) * Math.cos(state.sun.beta);
  const sunWY = -Math.sin(state.orbit.phase) * Math.cos(state.sun.beta);
  const sunWZ = Math.sin(state.sun.beta);

  const halfPi = Math.PI / 2;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 5;
      const lat = uvMap[i];
      const di = (py * w + px) * 4;
      if (lat < -5) {
        data[di + 3] = 0;
        continue;
      }
      const lon = uvMap[i + 1];
      const nx = uvMap[i + 2];
      const ny = uvMap[i + 3];
      const nz = uvMap[i + 4];
      const latShifted = lat + subSatLat;
      const latClamped = latShifted > halfPi - 0.001
        ? halfPi - 0.001
        : (latShifted < -halfPi + 0.001 ? -halfPi + 0.001 : latShifted);
      let u = lon / TAU + 0.5 + lonOffset;
      u = u - Math.floor(u);
      const v = 0.5 - latClamped / Math.PI;
      // Bilinear sampling: 4 neighbours weighted by sub-pixel offsets — eliminates
      // the blocky nearest-neighbour aliasing that dominated at 2K texture scale.
      const fx = u * tw - 0.5;
      const fy = v * th - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const wx = fx - x0;
      const wy = fy - y0;
      const x0w = ((x0 % tw) + tw) % tw;
      const x1w = ((x0 + 1) % tw + tw) % tw;
      const y0c = y0 < 0 ? 0 : (y0 > th - 1 ? th - 1 : y0);
      const y1c = (y0 + 1) < 0 ? 0 : ((y0 + 1) > th - 1 ? th - 1 : (y0 + 1));
      const i00 = (y0c * tw + x0w) * 4;
      const i10 = (y0c * tw + x1w) * 4;
      const i01 = (y1c * tw + x0w) * 4;
      const i11 = (y1c * tw + x1w) * 4;
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      const r = td[i00] * w00 + td[i10] * w10 + td[i01] * w01 + td[i11] * w11;
      const g = td[i00 + 1] * w00 + td[i10 + 1] * w10 + td[i01 + 1] * w01 + td[i11 + 1] * w11;
      const bl = td[i00 + 2] * w00 + td[i10 + 2] * w10 + td[i01 + 2] * w01 + td[i11 + 2] * w11;
      const sunDot = nx * sunWX + ny * sunWY + nz * sunWZ;
      const lit = sunDot * 1.05 + 0.08;
      const litClamp = lit > 1 ? 1 : (lit < 0.06 ? 0.06 : lit);
      data[di]     = r * litClamp;
      data[di + 1] = g * litClamp;
      data[di + 2] = bl * litClamp;
      data[di + 3] = 255;
    }
  }
  er.ctx.putImageData(er.imageData, 0, 0);
  return er.canvas;
}

function makeEarthSurface() {
  const rand = seededRandom(91733);
  // Continents: distributed by longitude (0..1) and latitude band (0..1, where 0=horizon, 1=down).
  const continents = Array.from({ length: 14 }, () => ({
    lon: rand(),
    lat: 0.18 + rand() * 0.7,
    sizeX: 0.06 + rand() * 0.16,
    sizeY: 0.012 + rand() * 0.025,
    tone: 0.55 + rand() * 0.4,
    hue: rand() > 0.55 ? "land-warm" : "land-cool"
  }));
  const clouds = Array.from({ length: 18 }, () => ({
    lon: rand(),
    lat: 0.05 + rand() * 0.55,
    sizeX: 0.05 + rand() * 0.11,
    drift: 0.4 + rand() * 0.6
  }));
  return { continents, clouds };
}

function drawEarthSurfaceTexture(cx, cy, r) {
  const horizonY = cy - r;
  const visibleH = Math.max(80, height - horizonY);
  const lit = state.sun.illumination;

  // If the NASA texture is loaded and CORS-readable, use the ray-traced sphere.
  const sphereCanvas = renderEarthSphere();
  if (sphereCanvas) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sphereCanvas, 0, 0, width, height);
    // Atmospheric haze fading the horizon line.
    const haze = ctx.createLinearGradient(0, horizonY - 22, 0, horizonY + 30);
    haze.addColorStop(0, "rgba(140, 210, 240, 0)");
    haze.addColorStop(0.5, `rgba(150, 215, 245, ${0.32 * lit})`);
    haze.addColorStop(1, "rgba(140, 210, 240, 0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, horizonY - 22, width, 52);
    ctx.restore();
    return;
  }

  // Vertical ocean gradient: lighter (atmospheric haze) at horizon, deeper below.
  const ocean = ctx.createLinearGradient(0, horizonY - 4, 0, horizonY + visibleH);
  ocean.addColorStop(0, `rgba(118, 192, 220, ${0.42 * lit + 0.08})`);
  ocean.addColorStop(0.18, `rgba(48, 130, 168, ${0.6 * lit + 0.12})`);
  ocean.addColorStop(0.55, `rgba(16, 72, 104, ${0.78 * lit + 0.16})`);
  ocean.addColorStop(1, `rgba(4, 26, 44, ${0.82 * lit + 0.18})`);
  ctx.fillStyle = ocean;
  ctx.fillRect(0, horizonY - 6, width, visibleH + 12);

  // Continents — pre-generated patches, scrolled by orbital ground track (~1 rev/orbit)
  // minus Earth's inertial rotation. Matches the sphere renderer's lonOffset.
  const earth = state.earth;
  if (earth) {
    const lonShift = wrap01(
      state.orbit.phase / TAU - state.time * ORBIT.earthRotPerOrbit / ORBIT.periodSec
    );
    const surfaceW = width * 1.6;
    const surfaceX0 = cx - surfaceW * 0.5;
    ctx.save();
    for (const c of earth.continents) {
      const u = wrap01(c.lon + lonShift);
      const x = surfaceX0 + u * surfaceW;
      const y = horizonY + visibleH * c.lat;
      // Foreshortening: things higher up (closer to horizon) get squashed vertically.
      const foreshorten = clamp(0.25 + c.lat * 1.4, 0.25, 1.2);
      const w = width * c.sizeX;
      const h = visibleH * c.sizeY * foreshorten;
      if (x + w < -20 || x - w > width + 20) continue;
      const base = c.hue === "land-warm"
        ? `rgba(${Math.round(86 * c.tone * lit + 18)}, ${Math.round(74 * c.tone * lit + 18)}, ${Math.round(46 * c.tone * lit + 14)}, 0.78)`
        : `rgba(${Math.round(46 * c.tone * lit + 14)}, ${Math.round(72 * c.tone * lit + 22)}, ${Math.round(54 * c.tone * lit + 20)}, 0.78)`;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.ellipse(x, y, w, h, 0, 0, TAU);
      ctx.fill();
    }
    // Clouds — drift independently of Earth rotation.
    ctx.globalAlpha = 0.42 * lit + 0.06;
    ctx.fillStyle = "#dff4ff";
    for (const cl of earth.clouds) {
      const u = wrap01(cl.lon + lonShift * cl.drift * 1.6);
      const x = surfaceX0 + u * surfaceW;
      const y = horizonY + visibleH * cl.lat;
      const w = width * cl.sizeX;
      const foreshorten = clamp(0.3 + cl.lat * 1.4, 0.3, 1.2);
      ctx.beginPath();
      ctx.ellipse(x, y, w, 2.6 * foreshorten, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Atmospheric haze fading the horizon line.
  const haze = ctx.createLinearGradient(0, horizonY - 18, 0, horizonY + 28);
  haze.addColorStop(0, "rgba(140, 210, 240, 0)");
  haze.addColorStop(0.5, `rgba(140, 210, 240, ${0.18 * lit})`);
  haze.addColorStop(1, "rgba(140, 210, 240, 0)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizonY - 18, width, 46);
}

function drawOrbitMap() {
  const size = Math.min(210, Math.min(width, height) * 0.32);
  const pad = 14;
  const x0 = pad;
  const y0 = Math.min(height * 0.46, height * 0.82 - size - pad);
  const cx = x0 + size * 0.5;
  const cy = y0 + size * 0.5;
  const r = size * 0.42;
  const earthR = r * 0.22;

  ctx.save();
  ctx.fillStyle = "rgba(3, 14, 18, 0.78)";
  ctx.strokeStyle = "rgba(72, 243, 255, 0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x0, y0, size, size);
  ctx.fill();
  ctx.stroke();

  const scale = size / 140;
  const titleFont = Math.round(10 * scale);
  const subFont = Math.round(9 * scale);
  ctx.fillStyle = "rgba(140, 169, 173, 0.9)";
  ctx.font = `800 ${titleFont}px ui-sans-serif, system-ui`;
  ctx.textAlign = "left";
  ctx.fillText(`SSO ${ORBIT.altitudeKm} km · i=${ORBIT.inclinationDeg.toFixed(1)}°`, x0 + 8, y0 + titleFont + 4);
  ctx.fillStyle = "rgba(140, 169, 173, 0.7)";
  ctx.font = `700 ${subFont}px ui-sans-serif, system-ui`;
  ctx.fillText(`LTAN ${ORBIT.ltanHours.toFixed(1)}h · β=${ORBIT.betaDeg}°`, x0 + 8, y0 + size - 8);

  // Sun direction in inertial — fixed at +x_inertial, drawn to the right of Earth.
  const sunX = cx + r * 1.18;
  const sunY = cy;

  // Earth's shadow cylinder — width matches the geometric eclipse extent.
  const shadowHalfW = Math.max(earthR, Math.sin(state.sun.eclipseHalfAngle || 0) * r);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - shadowHalfW);
  ctx.lineTo(x0 - 4, cy - shadowHalfW);
  ctx.lineTo(x0 - 4, cy + shadowHalfW);
  ctx.lineTo(cx, cy + shadowHalfW);
  ctx.closePath();
  ctx.fill();

  // Orbit circle.
  ctx.strokeStyle = "rgba(232, 251, 255, 0.22)";
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  // Eclipse arc — the section of orbit inside Earth's shadow.
  // In our orbit-map convention sat-angle on screen = -phase (canvas y flipped),
  // so midnight (phase = π) sits on the left side of Earth: screen angle = π.
  const eHalf = state.sun.eclipseHalfAngle || 0;
  if (eHalf > 0) {
    ctx.strokeStyle = "rgba(255, 82, 104, 0.65)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI - eHalf, Math.PI + eHalf);
    ctx.stroke();
  }

  // Earth.
  const earthGrad = ctx.createRadialGradient(cx + earthR * 0.4, cy - earthR * 0.4, 0, cx, cy, earthR);
  earthGrad.addColorStop(0, "#2c90b4");
  earthGrad.addColorStop(0.7, "#0d3a52");
  earthGrad.addColorStop(1, "#03101a");
  ctx.fillStyle = earthGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, earthR, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.beginPath();
  ctx.arc(cx, cy, earthR, -Math.PI / 2, Math.PI / 2);
  ctx.fill();

  // Satellite on orbit (phase=0 puts it on the sun side).
  const phase = state.orbit.phase;
  const sx = cx + Math.cos(phase) * r;
  const sy = cy - Math.sin(phase) * r;
  ctx.fillStyle = state.sun.inEclipse ? "#ff5268" : "#68ffa6";
  ctx.beginPath();
  ctx.arc(sx, sy, 5 * scale, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(232, 251, 255, 0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(sx, sy, 9 * scale, 0, TAU);
  ctx.stroke();

  // Sun.
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(sunX, sunY, 6 * scale, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 209, 102, 0.6)";
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    ctx.moveTo(sunX + Math.cos(a) * 9 * scale, sunY + Math.sin(a) * 9 * scale);
    ctx.lineTo(sunX + Math.cos(a) * 14 * scale, sunY + Math.sin(a) * 14 * scale);
  }
  ctx.stroke();

  // Frame labels around the orbit.
  const labelFont = Math.round(9 * scale);
  ctx.fillStyle = "rgba(140, 169, 173, 0.9)";
  ctx.font = `700 ${labelFont}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.fillText("NOON", cx + r + 16 * scale, cy - 3);
  ctx.fillText("MIDNT", cx - r - 16 * scale, cy + 3);
  ctx.fillText("DUSK", cx, cy - r - 6);
  ctx.fillText("DAWN", cx, cy + r + 12);

  ctx.restore();
}

// Hill-frame (R-V plane) map: the canonical chief-deputy relative-motion
// picture. The origin is the unforced "chief" — the debris' original slot on
// the reference circular orbit — NOT the physical chaser: the chaser thrusts
// to station-keep, and a thrusting body is not a valid CW frame origin (and
// debris-minus-chaser would collapse to the ~1 m tracking error anyway).
// Shows the debris trail, the exact one-orbit-ahead CW prediction (ghost),
// the reference orbit line, and the disposal target line. The prediction's
// lowest radial point IS δr_p, so "ghost dips below the disposal line" = win.
function drawHillMap() {
  if (!state) return;
  const size = Math.min(230, Math.min(width, height) * 0.34);
  const pad = 14;
  const x0 = width - size - pad;
  // Anchor above the deck, but never under the right-hand HUD column.
  const y0 = Math.max(height * 0.46, height * 0.82 - size - pad);
  const rel = state.rel;

  // Ghost prediction: one orbit ahead via the closed-form CW solution.
  const N = 72;
  const pred = [];
  for (let i = 0; i <= N; i++) {
    pred.push(cwPropagate(rel, (PHYS.periodSec * i) / N));
  }

  // Auto-fit bounds [m]: prediction + trail + chaser + origin (+ goal line
  // once the player is getting close, so early epicycles stay readable).
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  const include = (mx, my) => {
    if (mx < minX) minX = mx;
    if (mx > maxX) maxX = mx;
    if (my < minY) minY = my;
    if (my > maxY) maxY = my;
  };
  for (const p of pred) include(p.x, p.y);
  for (const t of state.trailRel) include(t.x, t.y);
  include(rel.x, rel.y);
  const goalX = -state.goalDp;
  const showGoal = state.phase === "REMOVE" || state.won ||
    state.perigeeDelta <= -0.3 * state.goalDp;
  if (showGoal) include(goalX, 0);
  let rangeX = Math.max(maxX - minX, 40);
  let rangeY = Math.max(maxY - minY, 40);
  minX -= rangeX * 0.14; maxX += rangeX * 0.14;
  minY -= rangeY * 0.12; maxY += rangeY * 0.12;
  rangeX = maxX - minX;
  rangeY = maxY - minY;
  const plotX = x0 + 8;
  const plotY = y0 + 24;
  const plotW = size - 16;
  const plotH = size - 44;
  // One shared scale → true shapes (the 2:1 CW ellipse really looks 2:1).
  const s = Math.min(plotW / rangeY, plotH / rangeX);
  const cmx = (minX + maxX) / 2;
  const cmy = (minY + maxY) / 2;
  const px = (my) => plotX + plotW / 2 + (my - cmy) * s;   // along-track → screen x
  const py = (mx) => plotY + plotH / 2 - (mx - cmx) * s;   // radial → screen y (up = zenith)

  ctx.save();
  ctx.fillStyle = "rgba(3, 14, 18, 0.78)";
  ctx.strokeStyle = "rgba(72, 243, 255, 0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(x0, y0, size, size);
  ctx.fill();
  ctx.stroke();

  const scale = size / 140;
  const titleFont = Math.round(10 * scale);
  const tinyFont = Math.round(8.5 * scale);
  ctx.fillStyle = "rgba(140, 169, 173, 0.9)";
  ctx.font = `800 ${titleFont}px ui-sans-serif, system-ui`;
  ctx.textAlign = "left";
  ctx.fillText("HILL FRAME R–V", x0 + 8, y0 + titleFont + 4);
  ctx.fillStyle = "rgba(140, 169, 173, 0.7)";
  ctx.font = `700 ${tinyFont}px ui-sans-serif, system-ui`;
  ctx.textAlign = "right";
  ctx.fillText("+V → / ↑ +R", x0 + size - 8, y0 + titleFont + 4);

  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();

  // Grid at round meter steps.
  const step = niceStep(Math.max(rangeX, rangeY) / 4);
  ctx.strokeStyle = "rgba(104, 255, 230, 0.07)";
  ctx.lineWidth = 1;
  for (let gx = Math.ceil(minX / step) * step; gx <= maxX; gx += step) {
    ctx.beginPath();
    ctx.moveTo(plotX, py(gx));
    ctx.lineTo(plotX + plotW, py(gx));
    ctx.stroke();
  }
  for (let gy = Math.ceil(minY / step) * step; gy <= maxY; gy += step) {
    ctx.beginPath();
    ctx.moveTo(px(gy), plotY);
    ctx.lineTo(px(gy), plotY + plotH);
    ctx.stroke();
  }

  // Reference orbit altitude (radial = 0).
  ctx.strokeStyle = "rgba(232, 251, 255, 0.28)";
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(plotX, py(0));
  ctx.lineTo(plotX + plotW, py(0));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(232, 251, 255, 0.45)";
  ctx.font = `700 ${tinyFont}px ui-sans-serif, system-ui`;
  ctx.textAlign = "left";
  ctx.fillText("REF ORBIT", plotX + 3, py(0) - 3);

  // Disposal target line: the ghost trajectory must dip below it.
  if (showGoal) {
    const reached = state.perigeeDelta <= -state.goalDp;
    ctx.strokeStyle = reached ? "rgba(104, 255, 166, 0.85)" : "rgba(255, 209, 102, 0.7)";
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(plotX, py(goalX));
    ctx.lineTo(plotX + plotW, py(goalX));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = reached ? "rgba(104, 255, 166, 0.95)" : "rgba(255, 209, 102, 0.9)";
    ctx.fillText(`DISPOSAL −${fmtMeters(state.goalDp)}`, plotX + 3, py(goalX) - 3);
  }

  // Debris trail (history).
  const trail = state.trailRel;
  if (trail.length > 1) {
    ctx.strokeStyle = "rgba(104, 255, 166, 0.5)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i];
      if (i === 0) ctx.moveTo(px(p.y), py(p.x));
      else ctx.lineTo(px(p.y), py(p.x));
    }
    ctx.lineTo(px(rel.y), py(rel.x));
    ctx.stroke();
  }

  // Ghost prediction (one orbit ahead, exact CW).
  ctx.strokeStyle = "rgba(72, 243, 255, 0.75)";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < pred.length; i++) {
    const p = pred[i];
    if (i === 0) ctx.moveTo(px(p.y), py(p.x));
    else ctx.lineTo(px(p.y), py(p.x));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Chief (origin cross: the debris' original orbit slot) and debris (amber dot).
  ctx.strokeStyle = "rgba(232, 251, 255, 0.85)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(px(0) - 4, py(0));
  ctx.lineTo(px(0) + 4, py(0));
  ctx.moveTo(px(0), py(0) - 4);
  ctx.lineTo(px(0), py(0) + 4);
  ctx.stroke();
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.arc(px(rel.y), py(rel.x), 3.4, 0, TAU);
  ctx.fill();

  ctx.restore();

  // Scale bar + legend (outside the clip).
  ctx.save();
  ctx.font = `700 ${tinyFont}px ui-sans-serif, system-ui`;
  ctx.fillStyle = "rgba(140, 169, 173, 0.8)";
  ctx.textAlign = "left";
  const barLen = step * s;
  const barY = y0 + size - 8;
  ctx.strokeStyle = "rgba(140, 169, 173, 0.8)";
  ctx.beginPath();
  ctx.moveTo(x0 + 8, barY);
  ctx.lineTo(x0 + 8 + barLen, barY);
  ctx.stroke();
  ctx.fillText(fmtMeters(step), x0 + 12 + barLen, barY + 3);
  ctx.textAlign = "right";
  ctx.strokeStyle = "rgba(72, 243, 255, 0.75)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x0 + size - 64 * scale, barY);
  ctx.lineTo(x0 + size - 44 * scale, barY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(140, 169, 173, 0.8)";
  ctx.fillText("1 ORBIT PRED", x0 + size - 8, barY + 3);
  ctx.restore();
}

function drawAxisLabels() {
  ctx.save();
  ctx.font = "800 10px ui-sans-serif, system-ui";
  ctx.fillStyle = "rgba(140, 169, 173, 0.7)";
  ctx.textAlign = "center";
  ctx.fillText("↑ +R  ZENITH", width * 0.5, 14);
  ctx.save();
  ctx.translate(width - 14, height * 0.46);
  ctx.rotate(Math.PI / 2);
  ctx.fillText("→ +H  CROSS-TRACK", 0, 0);
  ctx.restore();
  ctx.save();
  ctx.translate(14, height * 0.46);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("← -H  CROSS-TRACK", 0, 0);
  ctx.restore();
  ctx.fillText("LOOK -V  RETROGRADE", width * 0.5, height * 0.74);
  ctx.restore();
}

function drawSunIndicator() {
  const sun = state.sun;
  const cx = width * 0.5;
  const cy = height * 0.43;
  // -V camera view: screen horizontal is +H, screen vertical is -R, and V is depth.
  const len = Math.hypot(sun.dir.z, sun.dir.y) || 1;
  const dist = Math.min(width, height) * 0.46;
  const sx = cx + (sun.dir.z / len) * dist;
  const sy = cy + (sun.dir.y / len) * dist;
  // Visible only when above the horizon (sun.dir.y < 0 ≈ +R direction).
  const aboveHorizon = clamp(-sun.dir.y * 0.9 + 0.5, 0, 1);
  const visible = sun.illumination * aboveHorizon;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.min(width, height) * 0.5);
  halo.addColorStop(0, `rgba(255, 240, 196, ${0.42 * visible})`);
  halo.addColorStop(0.22, `rgba(255, 214, 140, ${0.18 * visible})`);
  halo.addColorStop(0.6, `rgba(255, 170, 110, ${0.06 * visible})`);
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  if (visible > 0.15) {
    ctx.fillStyle = `rgba(255, 248, 220, ${0.85 * visible})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 14 + visible * 6, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 224, 180, ${0.55 * visible})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(sx, sy, 22 + visible * 8, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEclipseTint() {
  if (state.sun.eclipseDepth < 0.04) return;
  ctx.save();
  ctx.fillStyle = `rgba(2, 5, 12, ${state.sun.eclipseDepth * 0.45})`;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function drawOrbitalMotionCues() {
  const speed = VIEW_FLOW * state.time * 22;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.strokeStyle = "rgba(72, 243, 255, 0.16)";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 10; i++) {
    const period = height * 0.92;
    const y = (((height * 0.14 + i * height * 0.085 + speed) % period) + period) % period + height * 0.02;
    const x = width * (0.1 + (i % 5) * 0.19);
    ctx.globalAlpha = 0.18 + (i % 3) * 0.06;
    ctx.beginPath();
    ctx.moveTo(x - 38, y - 14);
    ctx.lineTo(x + 34, y + 10);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRelativeOrbitTrail() {
  const trail = state.orbit.trail;
  if (trail.length < 2) return;
  ctx.save();
  ctx.lineWidth = 2;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    ctx.globalAlpha = clamp(b.life / 7, 0, 0.55);
    ctx.strokeStyle = "rgba(104, 255, 166, 0.55)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSatelliteFrame() {
  const center = viewCenter();
  const deckY = height * 0.82;
  const muzzleY = height * 0.75;
  ctx.save();

  const hull = ctx.createLinearGradient(0, deckY - 70, 0, height);
  hull.addColorStop(0, "rgba(28, 52, 58, 0.08)");
  hull.addColorStop(0.45, "rgba(8, 20, 24, 0.82)");
  hull.addColorStop(1, "rgba(1, 5, 7, 0.98)");
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(width * 0.18, height);
  ctx.lineTo(width * 0.32, deckY);
  ctx.quadraticCurveTo(width * 0.5, deckY - 22, width * 0.68, deckY);
  ctx.lineTo(width * 0.82, height);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(72, 243, 255, 0.24)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(width * 0.32, deckY);
  ctx.lineTo(width * 0.42, height);
  ctx.moveTo(width * 0.68, deckY);
  ctx.lineTo(width * 0.58, height);
  ctx.moveTo(center.x, deckY - 14);
  ctx.lineTo(center.x, height);
  ctx.stroke();

  const barrel = ctx.createLinearGradient(center.x - 42, muzzleY, center.x + 42, muzzleY);
  barrel.addColorStop(0, "#091317");
  barrel.addColorStop(0.5, "#5b777d");
  barrel.addColorStop(1, "#091317");
  ctx.fillStyle = barrel;
  ctx.strokeStyle = "rgba(232, 251, 255, 0.42)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(center.x - 36, height);
  ctx.lineTo(center.x - 15, muzzleY);
  ctx.lineTo(center.x + 15, muzzleY);
  ctx.lineTo(center.x + 36, height);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = "rgba(72, 243, 255, 0.88)";
  ctx.fillStyle = "rgba(72, 243, 255, 0.14)";
  ctx.beginPath();
  ctx.ellipse(center.x, muzzleY, 24, 9, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawLaser() {
  const hit = state.lastHit;
  const firing = pointer.firing && state.energy > 0.02 && state.heat < 0.99 && !state.won && !state.failed;
  if (!firing) return;
  const end = hit && !hit.miss ? hit.point : { x: pointer.x, y: pointer.y };
  const origin = { x: width * 0.5, y: height * 0.75 };

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const hot = state.heat > 0.82;
  ctx.strokeStyle = hot ? "rgba(255, 82, 104, 0.84)" : "rgba(72, 243, 255, 0.82)";
  ctx.lineWidth = hot ? 3.8 : 2.4;
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.strokeStyle = hot ? "rgba(255, 209, 102, 0.28)" : "rgba(232, 251, 255, 0.22)";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  if (hit && !hit.miss) {
    ctx.fillStyle = hot ? "#ffd166" : "#ffffff";
    ctx.beginPath();
    ctx.arc(hit.point.x, hit.point.y, 4.5 + Math.sin(state.time * 42) * 1.2, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function rotateDebrisVertex(v, debris = state.debris) {
  let x = v.x;
  let y = v.y;
  let z = v.z;
  let c = Math.cos(debris.pitch);
  let s = Math.sin(debris.pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(debris.roll);
  s = Math.sin(debris.roll);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(debris.angle);
  s = Math.sin(debris.angle);
  [x, y] = [x * c - y * s, x * s + y * c];
  return { x, y, z };
}

function projectDebrisVertex(v, debris = state.debris) {
  return projectWorldPoint({
    x: debris.x + v.x,
    y: debris.y + v.y,
    z: debris.z + v.z
  });
}

function faceNormal(a, b, c) {
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return normalize3({
    x: u.y * v.z - u.z * v.y,
    y: u.z * v.x - u.x * v.z,
    z: u.x * v.y - u.y * v.x
  });
}

function targetFaceColor(kind, lightLevel) {
  // lightLevel range: 0..1, with face.shade already folded in.
  const v = lightLevel;
  let r;
  let g;
  let b;
  if (kind === "panel") {
    r = 8 + v * 30;
    g = 24 + v * 82;
    b = 70 + v * 166;
  } else if (kind === "panel-frame") {
    r = 52 + v * 82;
    g = 57 + v * 88;
    b = 66 + v * 92;
  } else if (kind === "panel-back") {
    r = 94 + v * 68;
    g = 98 + v * 68;
    b = 106 + v * 72;
  } else if (kind === "panel-edge") {
    r = 66 + v * 68;
    g = 70 + v * 70;
    b = 78 + v * 76;
  } else if (kind === "bus-blanket") {
    r = 188 + v * 66;
    g = 162 + v * 80;
    b = 92 + v * 72;
  } else if (kind === "bus" || kind === "bus-side" || kind === "bus-top" || kind === "bus-bottom" || kind === "bus-back") {
    r = 142 + v * 86;
    g = 136 + v * 82;
    b = 126 + v * 86;
  } else if (kind === "bus-rim") {
    r = 86 + v * 76;
    g = 82 + v * 74;
    b = 76 + v * 72;
  } else if (kind === "radiator") {
    r = 24 + v * 68;
    g = 31 + v * 76;
    b = 40 + v * 88;
  } else if (kind === "instrument-lens") {
    r = 10 + v * 42;
    g = 38 + v * 104;
    b = 52 + v * 150;
  } else if (kind === "instrument-ring") {
    r = 62 + v * 84;
    g = 66 + v * 82;
    b = 70 + v * 82;
  } else if (kind === "antenna-dish" || kind === "antenna-feed" || kind === "antenna-mast" || kind === "boom") {
    r = 154 + v * 76;
    g = 150 + v * 76;
    b = 142 + v * 80;
  } else if (kind === "rocket-hull" || kind === "rocket-dome") {
    // Aged off-white / metallic upper-stage skin.
    r = 150 + v * 92;
    g = 148 + v * 90;
    b = 140 + v * 88;
  } else if (kind === "rocket-band") {
    // Dark thermal interstage band.
    r = 54 + v * 56;
    g = 50 + v * 52;
    b = 48 + v * 50;
  } else if (kind === "rocket-mount") {
    // Shadowed engine mounting plate.
    r = 60 + v * 60;
    g = 56 + v * 56;
    b = 54 + v * 54;
  } else if (kind === "nozzle") {
    // Coppery engine bell.
    r = 118 + v * 96;
    g = 84 + v * 66;
    b = 62 + v * 52;
  } else if (kind === "front") {
    r = 70 + v * 120;
    g = 67 + v * 112;
    b = 62 + v * 96;
  } else {
    r = (70 + v * 120) * 0.58;
    g = (67 + v * 112) * 0.62;
    b = (62 + v * 96) * 0.68;
  }
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

function targetFaceStroke(kind) {
  if (kind === "panel") return "rgba(137, 170, 214, 0.78)";
  if (kind === "panel-frame") return "rgba(230, 234, 236, 0.55)";
  if (kind === "panel-back") return "rgba(232, 240, 255, 0.36)";
  if (kind === "panel-edge") return "rgba(180, 190, 200, 0.5)";
  if (kind === "radiator") return "rgba(170, 204, 218, 0.5)";
  if (kind === "instrument-lens") return "rgba(178, 236, 255, 0.78)";
  if (kind === "instrument-ring") return "rgba(220, 224, 218, 0.62)";
  if (kind === "antenna-dish" || kind === "antenna-feed" || kind === "antenna-mast" || kind === "boom") return "rgba(236, 236, 222, 0.58)";
  if (kind === "rocket-hull" || kind === "rocket-dome") return "rgba(232, 238, 244, 0.5)";
  if (kind === "rocket-band") return "rgba(28, 30, 34, 0.62)";
  if (kind === "rocket-mount") return "rgba(150, 150, 150, 0.4)";
  if (kind === "nozzle") return "rgba(214, 152, 110, 0.55)";
  if (kind === "bus-blanket") return "rgba(255, 230, 150, 0.58)";
  if (kind === "bus-rim") return "rgba(215, 212, 196, 0.42)";
  if (kind && kind.startsWith("bus")) return "rgba(255, 232, 188, 0.68)";
  if (kind === "front") return "rgba(232, 251, 255, 0.74)";
  return "rgba(232, 251, 255, 0.22)";
}

function mixPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  };
}

function quadPoint(points, u, v) {
  const top = mixPoint(points[0], points[1], u);
  const bottom = mixPoint(points[3], points[2], u);
  return mixPoint(top, bottom, v);
}

function drawQuadLine(points, u0, v0, u1, v1) {
  const a = quadPoint(points, u0, v0);
  const b = quadPoint(points, u1, v1);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawDebris() {
  // In eclipse the spacecraft has no sunlight on it — skip rendering entirely.
  if (state.sun.inEclipse) return;

  const debris = state.debris;
  const rotated = debris.mesh.verts.map((v) => rotateDebrisVertex(v, debris));
  const projected = rotated.map((v) => projectDebrisVertex(v, debris));
  const light = state.sun.dir;
  const litLevel = 0.18 + 0.82 * state.sun.illumination;
  const faces = debris.mesh.faces.map((face) => {
    const verts = face.indices.map((i) => rotated[i]);
    const normal = faceNormal(verts[0], verts[1], verts[2]);
    const avgDepth = face.indices.reduce((sum, i) => sum + projected[i].depth, 0) / face.indices.length;
    return { ...face, normal, avgDepth };
  }).sort((a, b) => b.avgDepth - a.avgDepth);

  ctx.save();

  // Halo: rock gets an organic ellipse, elongated craft get a rectangular range frame.
  ctx.strokeStyle = "rgba(72, 243, 255, 0.16)";
  ctx.lineWidth = 1.5;
  if (debris.kind === "boxwing" || debris.kind === "rocket") {
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const x0 = Math.min(...xs) - 12;
    const y0 = Math.min(...ys) - 12;
    const x1 = Math.max(...xs) + 12;
    const y1 = Math.max(...ys) + 12;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  } else {
    const center = projectWorldPoint({ x: debris.x, y: debris.y, z: debris.z });
    ctx.beginPath();
    ctx.ellipse(center.x, center.y + debris.radius * 0.1 * center.scale, debris.radius * 1.55 * center.scale, debris.radius * 1.05 * center.scale, 0, 0, TAU);
    ctx.stroke();
  }

  for (const face of faces) {
    if (face.avgDepth <= 12) continue;
    const lightLevel = clamp(0.28 + dot3(face.normal, light) * 0.58 * litLevel, 0.1, 1);
    const shade = face.shade * lightLevel;
    ctx.fillStyle = targetFaceColor(face.kind, shade);
    ctx.strokeStyle = targetFaceStroke(face.kind);
    ctx.lineWidth = (face.kind === "front" || (face.kind && face.kind.startsWith("bus"))) ? 1.8 : 1;
    ctx.beginPath();
    face.indices.forEach((index, i) => {
      const p = projected[index];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const facePoints = face.indices.map((index) => projected[index]);
    if (facePoints.length === 4 && debris.kind === "boxwing") {
      if (face.kind === "panel" && face.normal.z > -0.4) {
        ctx.save();
        ctx.beginPath();
        facePoints.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.clip();
        const sheenA = quadPoint(facePoints, 0.08, 0.08);
        const sheenB = quadPoint(facePoints, 0.92, 0.92);
        const panelSheen = ctx.createLinearGradient(sheenA.x, sheenA.y, sheenB.x, sheenB.y);
        panelSheen.addColorStop(0, "rgba(20, 38, 88, 0.0)");
        panelSheen.addColorStop(0.42, "rgba(120, 196, 255, 0.22)");
        panelSheen.addColorStop(0.55, "rgba(255, 255, 255, 0.16)");
        panelSheen.addColorStop(1, "rgba(7, 14, 35, 0.34)");
        ctx.fillStyle = panelSheen;
        ctx.fillRect(
          Math.min(...facePoints.map((p) => p.x)) - 2,
          Math.min(...facePoints.map((p) => p.y)) - 2,
          Math.max(...facePoints.map((p) => p.x)) - Math.min(...facePoints.map((p) => p.x)) + 4,
          Math.max(...facePoints.map((p) => p.y)) - Math.min(...facePoints.map((p) => p.y)) + 4
        );
        ctx.strokeStyle = "rgba(2, 8, 22, 0.52)";
        ctx.lineWidth = 0.7;
        for (let s = 1; s < 4; s++) drawQuadLine(facePoints, s / 4, 0.03, s / 4, 0.97);
        for (let s = 1; s < 3; s++) drawQuadLine(facePoints, 0.03, s / 3, 0.97, s / 3);
        ctx.strokeStyle = "rgba(175, 225, 255, 0.32)";
        ctx.lineWidth = 0.55;
        drawQuadLine(facePoints, 0.08, 0.1, 0.9, 0.1);
        drawQuadLine(facePoints, 0.08, 0.9, 0.9, 0.9);
        ctx.restore();
      } else if (face.kind === "bus-blanket" && face.normal.z > -0.35) {
        ctx.save();
        ctx.strokeStyle = "rgba(94, 70, 22, 0.28)";
        ctx.lineWidth = 0.7;
        for (let s = 1; s < 5; s++) drawQuadLine(facePoints, s / 5, 0.08, s / 5, 0.92);
        for (let s = 1; s < 4; s++) drawQuadLine(facePoints, 0.08, s / 4, 0.92, s / 4);
        ctx.strokeStyle = "rgba(255, 245, 184, 0.42)";
        ctx.lineWidth = 0.8;
        drawQuadLine(facePoints, 0.12, 0.18, 0.88, 0.12);
        drawQuadLine(facePoints, 0.1, 0.76, 0.86, 0.84);
        ctx.restore();
      } else if (face.kind === "radiator" && face.normal.z > -0.35) {
        ctx.save();
        ctx.strokeStyle = "rgba(192, 225, 236, 0.32)";
        ctx.lineWidth = 0.8;
        for (let s = 1; s < 5; s++) drawQuadLine(facePoints, 0.08, s / 5, 0.92, s / 5);
        ctx.restore();
      } else if (face.kind === "instrument-lens" && face.normal.z > -0.35) {
        const center = quadPoint(facePoints, 0.5, 0.5);
        const edge = quadPoint(facePoints, 0.85, 0.5);
        const r = Math.max(3, Math.hypot(edge.x - center.x, edge.y - center.y));
        const lens = ctx.createRadialGradient(center.x - r * 0.22, center.y - r * 0.25, 0, center.x, center.y, r);
        lens.addColorStop(0, "rgba(245, 255, 255, 0.78)");
        lens.addColorStop(0.22, "rgba(58, 184, 226, 0.62)");
        lens.addColorStop(0.7, "rgba(3, 28, 48, 0.28)");
        lens.addColorStop(1, "rgba(0, 0, 0, 0.38)");
        ctx.fillStyle = lens;
        ctx.beginPath();
        ctx.ellipse(center.x, center.y, r * 0.72, r * 0.45, 0, 0, TAU);
        ctx.fill();
      }
    }
  }

  // Internal "veins" — rock only.
  if (debris.kind === "debris") {
    ctx.strokeStyle = "rgba(255, 209, 102, 0.36)";
    ctx.lineWidth = 1.8;
    for (let i = 1; i < projected.length / 2; i += 3) {
      const b = projected[i];
      ctx.beginPath();
      ctx.moveTo(debris.x, debris.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  const totalSpin = Math.hypot(debris.omega, debris.omegaPitch, debris.omegaRoll);
  ctx.strokeStyle = totalSpin < 0.16 ? "rgba(104, 255, 166, 0.92)" : "rgba(255, 209, 102, 0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const axisX1 = projectDebrisVertex(rotateDebrisVertex({ x: -debris.radius * 0.55, y: 0, z: 0 }, debris), debris);
  const axisX2 = projectDebrisVertex(rotateDebrisVertex({ x: debris.radius * 0.55, y: 0, z: 0 }, debris), debris);
  const axisY1 = projectDebrisVertex(rotateDebrisVertex({ x: 0, y: -debris.radius * 0.42, z: 0 }, debris), debris);
  const axisY2 = projectDebrisVertex(rotateDebrisVertex({ x: 0, y: debris.radius * 0.42, z: 0 }, debris), debris);
  ctx.moveTo(axisX1.x, axisX1.y);
  ctx.lineTo(axisX2.x, axisX2.y);
  ctx.moveTo(axisY1.x, axisY1.y);
  ctx.lineTo(axisY2.x, axisY2.y);
  ctx.stroke();
  ctx.restore();

  const hit = state.lastHit;
  if (hit && !hit.miss) {
    ctx.save();
    // Thin outward arrow: surface normal direction = ablation jet (where the
    // ejected material flies). Drawn faint so it doesn't dominate the view.
    ctx.strokeStyle = "rgba(255, 232, 188, 0.55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hit.point.x, hit.point.y);
    ctx.lineTo(hit.point.x + hit.normal.x * 28, hit.point.y + hit.normal.y * 28);
    ctx.stroke();
    ctx.setLineDash([]);
    // Bold inward arrow: ablation reaction thrust on the spacecraft.
    // Color indicates whether the resulting torque brakes the spin (green) or excites it (red).
    ctx.strokeStyle = hit.quality >= 0 ? "rgba(104, 255, 166, 0.92)" : "rgba(255, 82, 104, 0.92)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(hit.point.x, hit.point.y);
    ctx.lineTo(hit.point.x - hit.normal.x * 44, hit.point.y - hit.normal.y * 44);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(hit.point.x - hit.normal.x * 44, hit.point.y - hit.normal.y * 44, 3.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

function drawParticles() {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const p of particles) {
    const alpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * alpha, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawReticle() {
  ctx.save();
  ctx.translate(pointer.x, pointer.y);
  ctx.strokeStyle = state.overheated ? "rgba(255, 82, 104, 0.9)" : "rgba(72, 243, 255, 0.82)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 16, 0, TAU);
  ctx.arc(0, 0, 38, -0.25 * Math.PI, 0.25 * Math.PI);
  ctx.arc(0, 0, 38, 0.75 * Math.PI, 1.25 * Math.PI);
  ctx.moveTo(-28, 0);
  ctx.lineTo(-10, 0);
  ctx.moveTo(10, 0);
  ctx.lineTo(28, 0);
  ctx.moveTo(0, -28);
  ctx.lineTo(0, -10);
  ctx.moveTo(0, 10);
  ctx.lineTo(0, 28);
  ctx.stroke();

  ctx.strokeStyle = "rgba(232, 251, 255, 0.26)";
  ctx.strokeRect(-54, -34, 108, 68);
  ctx.fillStyle = state.overheated ? "#ff5268" : "#68ffa6";
  ctx.fillRect(-3, -3, 6, 6);
  ctx.restore();
}

function drawMessages() {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "800 24px ui-sans-serif, system-ui";
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    ctx.globalAlpha = clamp(m.life, 0, 1);
    ctx.fillStyle = m.color;
    ctx.fillText(m.text, width * 0.5, height * 0.22 + i * 30);
  }
  if (state.paused) {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "#e8fbff";
    ctx.fillText("PAUSED", width * 0.5, height * 0.5);
  }
  ctx.restore();
}

function draw() {
  drawBackground();
  drawSunIndicator();
  drawLaser();
  drawDebris();
  drawParticles();
  drawEclipseTint();
  drawSatelliteFrame();
  drawOrbitMap();
  drawHillMap();
  drawReticle();
  drawMessages();
}

function updateHud() {
  const debris = state.debris;
  const stability = clamp(state.stableHold / 2.2, 0, 1);
  const totalSpin = Math.hypot(debris.omega, debris.omegaPitch, debris.omegaRoll);
  ui.phase.textContent = state.won ? "CLEARED" : state.failed ? "FAILED" : state.overheated ? "THERMAL" : state.phase;
  ui.energyText.textContent = `${Math.round(state.energy * 100)}%`;
  ui.energyBar.style.width = `${state.energy * 100}%`;
  ui.heatText.textContent = `${Math.round(state.heat * 100)}%`;
  ui.heatBar.style.width = `${state.heat * 100}%`;
  ui.stableText.textContent = `${Math.round(stability * 100)}%`;
  ui.stableBar.style.width = `${stability * 100}%`;
  ui.spinText.textContent = `${totalSpin.toFixed(2)} rad/s`;
  ui.dvText.textContent = `${debris.dv.toFixed(2)} m/s`;
  if (ui.daText) ui.daText.textContent = fmtMeters(state.deltaA);
  if (ui.perigeeText) {
    ui.perigeeText.textContent = `${fmtMeters(state.perigeeDelta)} / −${fmtMeters(state.goalDp)}`;
    ui.perigeeText.style.color = state.perigeeDelta <= -state.goalDp ? "#68ffa6" : "";
  }
  if (ui.fuelText && ui.fuelBar) {
    if (Number.isFinite(state.fuelBudget)) {
      ui.fuelText.textContent = `${state.fuel.toFixed(1)} m/s`;
      ui.fuelBar.style.width = `${clamp(state.fuel / state.fuelBudget, 0, 1) * 100}%`;
      ui.fuelText.style.color = state.fuel < state.fuelBudget * 0.25 ? "#ff5268" : "";
    } else {
      ui.fuelText.textContent = "∞ (ARCADE)";
      ui.fuelBar.style.width = "100%";
      ui.fuelText.style.color = "";
    }
  }
  ui.removeText.textContent = `${Math.round(state.removalProgress * 100)}%`;
  ui.scoreText.textContent = String(Math.floor(state.score)).padStart(6, "0");

  const phaseDeg = Math.round((state.orbit.phase * 180 / Math.PI)) % 360;
  let phaseLabel;
  if (state.sun.inEclipse) phaseLabel = "ECL";
  else if (phaseDeg < 60 || phaseDeg > 300) phaseLabel = "DAY";
  else if (phaseDeg < 120) phaseLabel = "DSK";
  else if (phaseDeg < 240) phaseLabel = "NGT";
  else phaseLabel = "DWN";
  ui.orbitText.textContent = `${phaseLabel} ${String(phaseDeg).padStart(3, "0")}°`;
  const sunPct = Math.round(state.sun.illumination * 100);
  if (state.sun.timeToEvent > 0) {
    // timeToEvent is physical seconds; show the wall-clock countdown.
    const tag = state.sun.nextEvent === "ECLIPSE" ? "ECL" : "SUN";
    ui.sunText.textContent = `${sunPct}% ${tag}-${Math.ceil(state.sun.timeToEvent / TIME_WARP)}s`;
  } else {
    ui.sunText.textContent = `${sunPct}%`;
  }

  const lowFuel = Number.isFinite(state.fuelBudget) && state.fuel < state.fuelBudget * 0.25 && !state.won && !state.failed;
  ui.guidanceText.textContent = state.won
    ? "クリア:  R で再挑戦"
    : state.failed
      ? "ミッション失敗 — R で再挑戦"
      : state.overheated
      ? "THERMAL LIMIT — 冷却まで待機"
      : lowFuel
        ? `⚠ 燃料残少 (${state.fuel.toFixed(1)} m/s) — ドリフトを抑えて無駄な振動を起こすな`
        : state.sun.inEclipse
        ? "ECLIPSE — エネルギー再生停止中"
        : state.phase === "DESPIN"
          ? `回転中: デブリの端を撃って減速 (${totalSpin.toFixed(2)} → < 0.16 rad/s)`
          : state.phase === "STABILIZE"
            ? `ホールド: 撃たずに姿勢維持 (STABILITY ${Math.round(stability * 100)}%)`
            : state.phase === "REMOVE"
              ? `正面(手前向き)の面を撃って後方(−V)へ押せ — PERIGEE ${fmtMeters(state.perigeeDelta)} → 目標 −${fmtMeters(state.goalDp)}`
              : "HCW RELATIVE MODE";

  ui.stepDespin.classList.toggle("active", state.phase === "DESPIN");
  ui.stepStabilize.classList.toggle("active", state.phase === "STABILIZE");
  ui.stepRemove.classList.toggle("active", state.phase === "REMOVE" || state.phase === "CLEARED");
  ui.pauseButton.textContent = state.paused ? ">" : "II";
  ui.targetButton.textContent = TARGET_LABELS[currentTargetType] || currentTargetType.toUpperCase();
  if (ui.difficultyButton) {
    ui.difficultyButton.textContent = DIFFICULTY_LABELS[currentDifficulty] || currentDifficulty.toUpperCase();
  }
  if (ui.modeButton) {
    ui.modeButton.textContent = MODE_LABELS[currentMode] || currentMode.toUpperCase();
  }
}

function cycleTarget() {
  const i = TARGET_TYPES.indexOf(currentTargetType);
  currentTargetType = TARGET_TYPES[(i + 1) % TARGET_TYPES.length];
  resetGame();
  messages.push({ text: `TARGET: ${TARGET_LABELS[currentTargetType]}`, life: 1.6, color: "#48f3ff" });
}

function cycleDifficulty() {
  const i = DIFFICULTY_TYPES.indexOf(currentDifficulty);
  currentDifficulty = DIFFICULTY_TYPES[(i + 1) % DIFFICULTY_TYPES.length];
  resetGame();
  messages.push({ text: `DIFFICULTY: ${DIFFICULTY_LABELS[currentDifficulty]}`, life: 1.6, color: "#ffd166" });
}

function cycleMode() {
  const i = MODE_TYPES.indexOf(currentMode);
  currentMode = MODE_TYPES[(i + 1) % MODE_TYPES.length];
  resetGame();
  messages.push({
    text: `MODE: ${MODE_LABELS[currentMode]}`,
    life: 1.8,
    color: currentMode === "realism" ? "#48f3ff" : "#ffd166"
  });
}

const TIME_SCALE = 1.3;  // stylized clock rate (attitude, heat, FX)
function frame(now) {
  const realDt = Math.min(0.033, (now - last) / 1000 || 0);
  last = now;
  update(realDt);
  draw();
  updateHud();
  checkResultOverlays();
  requestAnimationFrame(frame);
}

function setPointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const client = event.touches ? event.touches[0] : event;
  if (!client) return;
  pointer.x = clamp(client.clientX - rect.left, 0, width);
  pointer.y = clamp(client.clientY - rect.top, 0, height);
  pointer.active = true;
}

function updateViewDrag(event) {
  const dx = event.clientX - viewControl.lastX;
  const dy = event.clientY - viewControl.lastY;
  viewControl.lastX = event.clientX;
  viewControl.lastY = event.clientY;
  const sensitivity = 0.006;
  viewControl.yaw = clamp(viewControl.yaw - dx * sensitivity, -0.72, 0.72);
  viewControl.pitch = clamp(viewControl.pitch - dy * sensitivity, -0.46, 0.46);
}

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("pointermove", (event) => {
  setPointerFromEvent(event);
  if (viewControl.dragging && event.pointerId === viewControl.pointerId) {
    updateViewDrag(event);
  }
});
canvas.addEventListener("pointerdown", (event) => {
  setPointerFromEvent(event);
  if (event.button === 2) {
    event.preventDefault();
    viewControl.dragging = true;
    viewControl.pointerId = event.pointerId;
    viewControl.lastX = event.clientX;
    viewControl.lastY = event.clientY;
    pointer.firing = false;
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  pointer.firing = true;
  // Tap burst: one short pulse (dtGame, matching dtPhys for the same wall time).
  applyLaser(0.045, (0.045 / TIME_SCALE) * TIME_WARP);
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointerup", (event) => {
  if (viewControl.dragging && event.pointerId === viewControl.pointerId) {
    viewControl.dragging = false;
    viewControl.pointerId = null;
  }
  pointer.firing = false;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});
canvas.addEventListener("pointercancel", () => {
  viewControl.dragging = false;
  viewControl.pointerId = null;
  pointer.firing = false;
});

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "p" || event.key === " ") {
    state.paused = !state.paused;
  }
  if (event.key.toLowerCase() === "r") {
    resetGame();
  }
  if (event.key.toLowerCase() === "t") {
    cycleTarget();
  }
  if (event.key.toLowerCase() === "d") {
    cycleDifficulty();
  }
  if (event.key.toLowerCase() === "m") {
    cycleMode();
  }
});

ui.pauseButton.addEventListener("click", () => {
  state.paused = !state.paused;
});
ui.resetButton.addEventListener("click", () => {
  hideWinOverlay();
  hideFailOverlay();
  resetGame();
});
ui.targetButton.addEventListener("click", cycleTarget);
if (ui.difficultyButton) ui.difficultyButton.addEventListener("click", cycleDifficulty);
if (ui.modeButton) ui.modeButton.addEventListener("click", cycleMode);

function showIntroOverlay() {
  if (ui.introOverlay) ui.introOverlay.hidden = false;
  if (state) state.paused = true;
}

function hideIntroOverlay() {
  if (ui.introOverlay) ui.introOverlay.hidden = true;
  if (state) state.paused = false;
}

function showWinOverlay() {
  if (!ui.winOverlay) return;
  ui.winScore.textContent = String(Math.floor(state.score)).padStart(6, "0");
  ui.winEnergy.textContent = `${Math.round(state.energy * 100)}%`;
  if (ui.winDv) ui.winDv.textContent = `${state.debris.dv.toFixed(2)} m/s`;
  if (ui.winPerigee) ui.winPerigee.textContent = fmtMeters(state.perigeeDelta);
  ui.winOverlay.hidden = false;
}

function hideWinOverlay() {
  if (ui.winOverlay) ui.winOverlay.hidden = true;
}

function showFailOverlay() {
  if (!ui.failOverlay) return;
  if (ui.failReason && state.failReason) ui.failReason.textContent = state.failReason;
  ui.failOverlay.hidden = false;
}

function hideFailOverlay() {
  if (ui.failOverlay) ui.failOverlay.hidden = true;
}

let winOverlayShown = false;
let failOverlayShown = false;
function checkResultOverlays() {
  if (state && state.won && !winOverlayShown) {
    winOverlayShown = true;
    setTimeout(showWinOverlay, 900);
  } else if (state && !state.won && winOverlayShown) {
    winOverlayShown = false;
    hideWinOverlay();
  }
  if (state && state.failed && !failOverlayShown) {
    failOverlayShown = true;
    setTimeout(showFailOverlay, 900);
  } else if (state && !state.failed && failOverlayShown) {
    failOverlayShown = false;
    hideFailOverlay();
  }
}

if (ui.startButton) {
  ui.startButton.addEventListener("click", hideIntroOverlay);
}
if (ui.retryButton) {
  ui.retryButton.addEventListener("click", () => {
    hideWinOverlay();
    resetGame();
  });
}
if (ui.failRetryButton) {
  ui.failRetryButton.addEventListener("click", () => {
    hideFailOverlay();
    resetGame();
  });
}

window.addEventListener("resize", resize);

// Inspection hook for tests/debugging (the game itself never reads this).
// step(dt) advances one frame manually — rAF is suspended in hidden tabs.
window.LABS = {
  get state() { return state; },
  get mode() { return currentMode; },
  step(dtWall = 1 / 60) {
    update(dtWall);
    draw();
    updateHud();
    checkResultOverlays();
  },
  cwPropagate,
  orbitReadouts,
  PHYS,
  TIME_WARP
};

resize();
resetGame();
showIntroOverlay();
requestAnimationFrame(frame);
