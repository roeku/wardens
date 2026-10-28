import * as THREE from 'three';
import type { Team } from '../../contracts';
import { FWD, RIGHT, ViewCamera, ZOOMS } from '../../view/camera';
import { Figures } from '../../view/figures';
import { Sun } from '../../view/light';
import { PixelRenderer, SHADOW_MAP, type Tier } from '../../view/renderer';
import { MAX_LIGHTS } from '../../view/shaders';
import { gradientMap } from '../../view/toon';
import { coverage, figureMismatch, lastDelta, same, shiftMismatch, type Img } from './flicker';
import { buildRecords, firstId, POSES, type Cast, type Pose, type RosterName } from './roster';

// The units lab (02-look.md §10): every kind for both teams at the game's own pixel size and light, on a plain
// ground. Dev only: http://localhost:5173/labs/units.html. Driven from window.__lab.

const params = new URLSearchParams(location.search);
const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);

const MAP = 64;
/** The meadow's mid grass (02-look.md §4), flat and plain. */
const GRASS = 0x5d8a33;
// off the lattice on purpose: an exact .5 tie would let float noise round neighbours different ways
const FOCUS = { x: MAP / 2 + 0.0137, y: MAP / 2 - 0.0219 };

/**
 * The plain ground: flat toon grass whose shadow lookup uses the exact point on this pixel's ray (as the game's
 * land does), so a pan shows no shadow-edge flicker that isn't the figures' own.
 */
const groundUniforms = { uPix: { value: new THREE.Vector3(1, 1, 1) }, uOrigin: { value: new THREE.Vector2() } };
function plainGround(): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: GRASS, gradientMap });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, groundUniforms);
    const pars = `
uniform vec3 uPix;
uniform vec2 uOrigin;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif
vec3 exactGround() {
  vec2 au = (floor(gl_FragCoord.xy) + uOrigin + 0.5 - uPix.yz) / uPix.x;
  float s = 1.41421356 * au.x;
  float d = 2.0 * 1.41421356 * au.y;
  return vec3((s + d) * 0.5, 0.0, (s - d) * 0.5);
}`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replaceAll(
          'vDirectionalShadowCoord[ i ]',
          '( directionalShadowMatrix[ i ] * vec4( exactGround() + vec3( 0.0, 1.0, 0.0 ) * directionalLightShadow.shadowNormalBias, 1.0 ) )',
        ),
      );
  };
  m.customProgramCacheKey = () => 'lab-plain-ground';
  return m;
}

const tier = (params.get('tier') ?? 'high') as Tier;
const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);
const renderer = new PixelRenderer(canvas, { px: num('px'), tier, range: 319 });
const scene = new THREE.Scene();
const camera = new ViewCamera(() => 0, { w: MAP, h: MAP });
camera.zi = num('zoom') ?? 4;
camera.focus.set(FOCUS.x, FOCUS.y);
const sun = new Sun(scene, SHADOW_MAP[tier]);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP + 40, MAP + 40).rotateX(-Math.PI / 2).translate(MAP / 2, 0, MAP / 2), plainGround());
ground.receiveShadow = true;
scene.add(ground);
const figures = new Figures();
scene.add(figures.group);

const ROSTERS: RosterName[] = ['warband', 'blight', 'both'];
const cast: Cast = {
  roster: ROSTERS.includes(params.get('roster') as RosterName) ? (params.get('roster') as RosterName) : 'both',
  teams: [0, 1],
  rank: 0,
  pose: 'stand',
  face: Math.PI,
  poseT: 0,
  driftX: 0,
  driftY: 0,
  hitAge: Infinity,
  banners: true,
  heart: 1,
  lost: 0,
  honours: 0,
  breath: null,
};
let clock = 0;
let running = true;
/** The exact clip (figures on the art-pixel grid to the sub-pixel); off to compare with three's own projection. */
let exact = params.get('exact') !== '0';
/** Continuous drift per second, in art pixels along the screen: figures and camera. */
const drift = { fig: [0, 0], cam: [0, 0] };
const lights = new Float32Array(MAX_LIGHTS * 4);

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight);
}
resize();
window.addEventListener('resize', resize);

/** One frame: records for the figures, then the three passes. dt = 0 freezes every easing and timer. */
function frame(dt: number): void {
  const { aw, ah } = renderer.size;
  camera.apply(aw, ah);
  groundUniforms.uPix.value.set(camera.s, (aw + 2) / 2, (ah + 2) / 2);
  groundUniforms.uOrigin.value.copy(camera.origin);
  sun.update(0, camera.snapped, aw, ah, camera.s);
  const sc = sun.light.shadow.camera;
  const recs = buildRecords(cast, FOCUS, camera.s);
  figures.update({
    men: recs.men,
    banners: recs.banners,
    dt,
    time: clock,
    zoom: camera.s,
    screen: exact ? { origin: camera.origin, halfW: (aw + 2) / 2, halfH: (ah + 2) / 2 } : undefined,
    shadowTexel: (sc.right - sc.left) / sun.light.shadow.mapSize.x,
  });
  renderer.render(scene, camera.cam, {
    sub: camera.sub,
    origin: camera.origin,
    haze: sun.haze,
    nightK: 0,
    grey: 0,
    danger: 0,
    lights,
    lightN: 0,
  });
}

/** Screen-axis steps (art px) → sim tiles at zoom s: across along RIGHT, up along the ground's forward. */
function screenToSim(ax: number, ay: number, s: number): [number, number] {
  const across = ax / s;
  const fwd = (2 * ay) / s; // 1 px up the screen is 2 px of ground forward (sin 30°)
  return [RIGHT.x * across + FWD.x * fwd, RIGHT.z * across + FWD.z * fwd];
}

const DIRS: Record<string, [number, number]> = { right: [1, 0], up: [0, 1], diag: [1, 0.5], left: [-1, 0], down: [0, -1] };

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (running) {
    clock += dt;
    cast.poseT += dt;
    const [fx, fy] = screenToSim(drift.fig[0] * dt, drift.fig[1] * dt, camera.s);
    cast.driftX += fx;
    cast.driftY += fy;
    const [cx, cy] = screenToSim(drift.cam[0] * dt, drift.cam[1] * dt, camera.s);
    camera.focus.x += cx;
    camera.focus.y += cy;
    frame(dt);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function read(): Img {
  return renderer.readCell();
}

/** Renders the empty field (figures hidden): what the figure layer draws over. */
function readEmpty(): Img {
  figures.group.visible = false;
  frame(0);
  const img = read();
  figures.group.visible = true;
  return img;
}

interface FlickerOpts {
  /** 'camera': the camera drifts over still figures; 'figures': the figures drift under a still camera; 'both'. */
  mode?: 'camera' | 'figures' | 'both';
  dir?: keyof typeof DIRS;
  /** Art pixels per step, and how many steps. */
  step?: number;
  steps?: number;
  zoom?: number;
  pose?: Pose;
  /** Figures cast shadows during the check (default true). */
  shadows?: boolean;
  /** Seconds the cloth clock runs per step (default 0: frozen, so only the drift can change the picture). */
  clock?: number;
  /** Draw the banners during the check (default: as the lab shows them). */
  banners?: boolean;
}

interface FlickerReport {
  mode: string;
  zoom: number;
  pose: Pose;
  frames: number;
  changed: number;
  /** Frames with any pixel not explained by whole-pixel shifts, and the worst and total such pixels. */
  badFrames: number;
  maxBad: number;
  totalBad: number;
  /** The largest colour-channel difference of any bad pixel (1 = a 1/255 rounding, invisible). */
  maxDelta: number;
  /** Pixels the figures and banners cover (so a count of bad pixels can be read against it). */
  figurePixels: number;
}

/**
 * Moves in sub-art-pixel steps and counts frames whose change is not whole-pixel shifts of the frame before
 * (like __v.shimmer). The clock is frozen, so only the drift can change the picture.
 */
function flicker(o: FlickerOpts = {}): FlickerReport {
  const mode = o.mode ?? 'camera';
  const [ux, uy] = DIRS[o.dir ?? 'diag'];
  const step = o.step ?? 0.1;
  const steps = o.steps ?? 60;
  const wasRunning = running;
  running = false;
  if (o.zoom !== undefined) camera.zi = o.zoom;
  if (o.pose) setPose(o.pose);
  figures.setCastShadow(o.shadows ?? true);
  const bannersWere = cast.banners;
  if (o.banners !== undefined) cast.banners = o.banners;
  const tick = o.clock ?? 0;
  camera.focus.set(FOCUS.x, FOCUS.y);
  cast.driftX = cast.driftY = 0;
  const s = camera.s;
  // settle: the drawn state reaches the records (a long dt), then freeze
  frame(10);
  frame(10);
  let empty = readEmpty();
  frame(0);
  let prev = read();
  const figurePixels = coverage(prev, empty);
  let prevOrigin = camera.origin.clone();
  const anchor = () => figures.drawnAt(firstId(cast))!;
  let prevAt = anchor();
  lastBad = null;
  const rep: FlickerReport = { mode, zoom: s, pose: cast.pose, frames: steps, changed: 0, badFrames: 0, maxBad: 0, totalBad: 0, maxDelta: 0, figurePixels };
  for (let i = 0; i < steps; i++) {
    const [dx, dy] = screenToSim(ux * step, uy * step, s);
    if (mode !== 'figures') {
      camera.focus.x += dx;
      camera.focus.y += dy;
    }
    if (mode !== 'camera') {
      cast.driftX += dx;
      cast.driftY += dy;
    }
    // figures move: let their drawn position reach the record (dt large); the clock runs only if asked
    clock += tick;
    frame(mode === 'camera' ? tick : 10);
    const cur = read();
    if (same(cur, prev)) {
      prev = cur;
      continue;
    }
    rep.changed++;
    let bad: number;
    if (mode === 'camera') {
      const ox = camera.origin.x - prevOrigin.x;
      const oy = camera.origin.y - prevOrigin.y;
      bad = shiftMismatch(cur, prev, ox, oy);
      rep.maxDelta = Math.max(rep.maxDelta, lastDelta);
    } else {
      const at = anchor();
      const ex = readEmpty();
      frame(0);
      // the figures' step on screen, relative to the camera's
      const fx = at.px - prevAt.px - (camera.origin.x - prevOrigin.x);
      const fy = at.py - prevAt.py - (camera.origin.y - prevOrigin.y);
      const ox = camera.origin.x - prevOrigin.x;
      const oy = camera.origin.y - prevOrigin.y;
      // the empty field itself must only shift with the camera
      const fieldBad = shiftMismatch(ex, empty, ox, oy);
      rep.maxDelta = Math.max(rep.maxDelta, lastDelta);
      bad = figureMismatch(cur, prev, empty, ex, fx, fy) + fieldBad;
      rep.maxDelta = Math.max(rep.maxDelta, lastDelta);
      empty = ex;
      prevAt = at;
    }
    prevOrigin = camera.origin.clone();
    if (bad > 0 && !lastBad) lastBad = { prev, cur, empty: mode === 'camera' ? prev : readEmptyKeep(), step: i };
    if (bad > 0) {
      rep.badFrames++;
      rep.maxBad = Math.max(rep.maxBad, bad);
      rep.totalBad += bad;
    }
    prev = cur;
  }
  camera.focus.set(FOCUS.x, FOCUS.y);
  cast.driftX = cast.driftY = 0;
  cast.banners = bannersWere;
  figures.setCastShadow(true);
  running = wasRunning;
  frame(0);
  return rep;
}

/** The first bad frame of the last flicker() run, for a look. */
let lastBad: { prev: Img; cur: Img; empty: Img; step: number } | null = null;
function readEmptyKeep(): Img {
  const e = readEmpty();
  frame(0);
  return e;
}

/** After a layout change: the drawn figures reach their records at once (positions, facing), the clock still. */
function settle(): void {
  frame(10);
  frame(0);
}

function setPose(p: Pose): void {
  if (!POSES.includes(p)) throw new Error(`pose: one of ${POSES.join(', ')}`);
  cast.pose = p;
  cast.poseT = 0;
}

const lab = {
  figures,
  camera,
  renderer,
  cast,
  /** stand | march | fight | rout | death | back */
  pose(p: Pose): Pose {
    setPose(p);
    frame(0);
    return p;
  },
  /** Which rows: 'warband' (both teams' kinds, day 2's lab), 'blight' (the blight's roster) or 'both' (ours over it). */
  roster(r: RosterName): RosterName {
    if (!ROSTERS.includes(r)) throw new Error(`roster: one of ${ROSTERS.join(', ')}`);
    cast.roster = r;
    settle();
    return r;
  },
  /** Holds the drakes at `e` seconds into their breath cycle (rear 0–0.4, jet 0.4–1.6, tail to 2.15, bite 2.3), or null. */
  breath(e: number | null): number | null {
    cast.breath = e;
    frame(0);
    return e;
  },
  /** 0 (player), 1 (enemy) or 'both': the warband roster's teams. */
  team(t: Team | 'both'): Team[] {
    cast.teams = t === 'both' ? [0, 1] : [t];
    settle();
    return cast.teams;
  },
  rank(r: number): number {
    cast.rank = Math.max(0, Math.min(3, r | 0));
    frame(0);
    return cast.rank;
  },
  /** Zoom index 0..8 (ZOOMS = 7…34 art px per tile). */
  zoom(i: number): number {
    camera.zi = Math.max(0, Math.min(ZOOMS.length - 1, i | 0));
    settle();
    return camera.s;
  },
  /** Everyone's facing, radians in sim coordinates (π = west, toward the viewer's lower left; π/2 = south, lower right). */
  face(a: number): number {
    cast.face = a;
    settle();
    return a;
  },
  /** Continuous drift in art px per second: { fig: [x, y], cam: [x, y] } along the screen. */
  drift(d: { fig?: [number, number]; cam?: [number, number] }): typeof drift {
    if (d.fig) drift.fig = d.fig;
    if (d.cam) drift.cam = d.cam;
    return drift;
  },
  /** The exact clip on or off (to compare). */
  exact(on: boolean): boolean {
    exact = on;
    frame(0);
    return exact;
  },
  /** Run or stop the clock (cloth, blows, deaths). */
  clock(run: boolean): boolean {
    running = run;
    return running;
  },
  /** Advances the lab by n frames of dt seconds (clock stopped or not). */
  step(n = 1, dt = 1 / 60): void {
    for (let i = 0; i < n; i++) {
      clock += dt;
      cast.poseT += dt;
      frame(dt);
    }
  },
  banners(on: boolean): boolean {
    cast.banners = on;
    frame(0);
    return on;
  },
  /** Banner state: heart (0..1), men lost of 12, honours. */
  banner(b: { heart?: number; lost?: number; honours?: number }): object {
    Object.assign(cast, b);
    frame(0);
    return { heart: cast.heart, lost: cast.lost, honours: cast.honours };
  },
  /** Seconds since a hit (0 → white this frame), Infinity to clear. */
  hit(age: number): void {
    cast.hitAge = age;
    frame(0);
  },
  /** Renders a frame and saves it to out/shots/<name>.png through the dev server. */
  async shot(name: string): Promise<string> {
    frame(0);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('no frame');
    const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return ((await res.json()) as { path: string }).path;
  },
  flicker,
  lastBad: () => lastBad,
  /** One frame without moving the clock (dt only eases the drawn state). */
  render(dt = 0): void {
    frame(dt);
  },
  /** The art-pixel image (cell pass), for checks. */
  cell(): Img {
    return read();
  },
  /** The cell image with the figures hidden. */
  empty(): Img {
    return readEmpty();
  },
  /** Saves an art-pixel image (rows bottom-up, as read) to out/shots/<name>.png. */
  async save(name: string, img: Img): Promise<string> {
    const c = document.createElement('canvas');
    c.width = img.w;
    c.height = img.h;
    const ctx = c.getContext('2d')!;
    const data = ctx.createImageData(img.w, img.h);
    for (let y = 0; y < img.h; y++) data.data.set(img.data.subarray((img.h - 1 - y) * img.w * 4, (img.h - y) * img.w * 4), y * img.w * 4);
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
    const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return ((await res.json()) as { path: string }).path;
  },
  /** flicker() at every zoom; returns one row per zoom. */
  flickerAll(o: FlickerOpts = {}): FlickerReport[] {
    const zi = camera.zi;
    const out = ZOOMS.map((_, i) => flicker({ ...o, zoom: i }));
    camera.zi = zi;
    frame(0);
    return out;
  },
  state() {
    const { px, dpr, aw, ah } = renderer.size;
    return { px, dpr, aw, ah, zoom: camera.s, focus: [camera.focus.x, camera.focus.y], cast: { ...cast }, clock, running, ...figures.stats() };
  },
};
(window as unknown as { __lab: typeof lab }).__lab = lab;
frame(0);
