import * as THREE from 'three';
import type { P } from '../contracts';
import { BACK, FAR, NEAR, RIGHT, VIEW } from './camera';
import { EXACT_CLIP_VERTEX } from './exact';
import { FOG } from './fog';
import { groundAt, WATER_Y, type LandData } from './land-data';
import { BAYER } from './shaders';

// Marks on the field, the only "UI" in battle (docs/spec/02-look.md §7). Ground ribbons rebuilt every frame and
// draped over the land's heights (lifted 0.05 above land or water, long segments densified every 0.6 tiles);
// see-through only by the 4×4 Bayer dither (discard where alpha < bayer4, fixed to the world); depthWrite off,
// polygon offset −2/−4; drawn in the scene, so they are pixelated, depth-tested and outlined by what stands in
// front of them like everything else. Every coloured line sits over a darker ink line (α .55–.6).
//
// Two ways to draw:
// - **Immediate** (`pen`): the battle redraws its standing marks every frame (selection, capture rings, orders).
// - **Timed** (`ping`, `ring`, `cross`, `route`, `trail`, `effect`): an order given or refused leaves a mark that
//   closes in or fades by itself. Voice uses these too (or `BattleView.issue`, which draws the order-given marks).
//
// Pixel stability (02-look.md §9): every vertex goes through the exact clip (world → art pixels, rounded to 1/256
// px, minus the camera's whole-pixel origin) and the exact depth, and the dither is read at the world-fixed pixel,
// so a still mark is drawn the same picture a whole pixel over as the view pans. Nothing is thinner than one art
// pixel: widths grow as the zoom shrinks.

/** 02-look.md §4 "Mark colours", the teams' light colours and gold. */
export const MARK = {
  ink: 0x16120f,
  cream: 0xf1ead6,
  red: 0xe0533f,
  green: 0x9fd36a,
  withdraw: 0xf3a08a,
  gold: 0xe8c34a,
  goldDark: 0x9a7a2a,
  neutral: 0xd8cfb4,
  /** Team light colours [3]: ours, theirs. */
  ours: 0x78c5e6,
  foes: 0xef8e70,
  /** Team [2]: an order flag's cloth. */
  oursCloth: 0x3a8dbd,
  wood: 0x7a5634,
  /** A refused front's trail. */
  grey: 0x8a867c,
} as const;

/** 02-look.md §7: lifted this far above the land or the water. */
const LIFT = 0.05;
/** Long segments are densified every this many tiles so they follow the hills. */
const DENSE = 0.6;
/** The ink line under every coloured one, its dither alpha (02-look.md §7: α .55 to .6). */
export const INK_ALPHA = 0.58;
/** A ground ribbon is at least one art pixel tall on screen: across the screen it is foreshortened by sin 30°. */
const MIN_PX = 1;
/** The ink shows at least this many art pixels either side of its line. */
const INK_MARGIN_PX = 1;
/** A standing thing (an order flag's pole) is at least this many art pixels wide. */
const MIN_POLE_PX = 1.2;
/** How far an order flag's cream edge stands in front of its cloth, along the view (tiles). */
const EDGE_FORWARD = 0.03;

export interface Style {
  colour: number;
  /** Ground width in tiles (grown to one art pixel at low zooms). */
  width: number;
  /** Dither alpha 0..1. */
  alpha?: number;
  /** Dashes [on, off] in tiles. */
  dash?: readonly [number, number];
  /** The ink under it: its width in tiles, or false for none. Default: the line's width + a pixel each side. */
  ink?: number | false;
  inkAlpha?: number;
}

/** One layer's growing triangle soup: world xyz and rgba per vertex. */
class Layer {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(3 * 3 * 1024);
  private col = new Float32Array(4 * 3 * 1024);
  private n = 0;
  private readonly geom = new THREE.BufferGeometry();

  constructor(material: THREE.Material, order: number, name: string) {
    this.attach();
    this.mesh = new THREE.Mesh(this.geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.name = name;
    this.mesh.matrixAutoUpdate = false;
  }

  private attach(): void {
    const p = new THREE.BufferAttribute(this.pos, 3);
    const c = new THREE.BufferAttribute(this.col, 4);
    p.setUsage(THREE.DynamicDrawUsage);
    c.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('position', p);
    this.geom.setAttribute('aColor', c);
  }

  begin(): void {
    this.n = 0;
  }

  vertex(x: number, y: number, z: number, r: number, g: number, b: number, a: number): void {
    if (this.n * 3 >= this.pos.length) {
      const pos = new Float32Array(this.pos.length * 2);
      pos.set(this.pos);
      const col = new Float32Array(this.col.length * 2);
      col.set(this.col);
      this.pos = pos;
      this.col = col;
      this.attach();
    }
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
  }

  end(): void {
    const p = this.geom.attributes.position as THREE.BufferAttribute;
    const c = this.geom.attributes.aColor as THREE.BufferAttribute;
    p.clearUpdateRanges();
    c.clearUpdateRanges();
    p.addUpdateRange(0, this.n * 3);
    c.addUpdateRange(0, this.n * 4);
    p.needsUpdate = true;
    c.needsUpdate = true;
    this.geom.setDrawRange(0, this.n);
    this.mesh.visible = this.n > 0;
  }

  get vertices(): number {
    return this.n;
  }
}

const f8 = (v: number) => v.toFixed(8);

const MARK_VS = /* glsl */ `
uniform vec2 uOrigin;
uniform vec3 uPix;
attribute vec4 aColor;
flat varying vec4 vCol;
void main() {
  vec3 vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  ${EXACT_CLIP_VERTEX}
  float depth = (dot(vWorld, vec3(${f8(VIEW.x)}, ${f8(VIEW.y)}, ${f8(VIEW.z)})) + ${(BACK - NEAR).toFixed(1)}) / ${(FAR - NEAR).toFixed(1)};
  gl_Position.z = (2.0 * depth - 1.0) * gl_Position.w;
  vCol = aColor;
}`;

/**
 * Alpha 0 tags the pixel as a mark for the CELL pass: the pause greys the world but not its marks (01-flow.md §2
 * "The world greys and every company's order is drawn").
 */
const MARK_FS = /* glsl */ `
uniform vec2 uOrigin;
flat varying vec4 vCol;
${BAYER}
void main() {
  if (vCol.a < bayer4(floor(gl_FragCoord.xy) + uOrigin)) discard;
  gl_FragColor = vec4(vCol.rgb, 0.0);
}`;

function markMaterial(ground: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: MARK_VS,
    fragmentShader: MARK_FS,
    uniforms: { uOrigin: FOG.uOrigin, uPix: FOG.uPix },
    depthWrite: !ground,
    depthTest: true,
    polygonOffset: ground,
    polygonOffsetFactor: ground ? -2 : 0,
    polygonOffsetUnits: ground ? -4 : 0,
    side: THREE.DoubleSide,
  });
}

const rgbOf = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** The ground (or the water over it) under sim (x, y), lifted. */
type Height = (x: number, y: number) => number;

/** Screen-up on the ground, as a sim direction (x east, y south): north-east. Screen-right: south-east. */
const SCREEN_UP: P = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
const SCREEN_RIGHT: P = { x: Math.SQRT1_2, y: Math.SQRT1_2 };

/** Immediate-mode drawing for one frame (02-look.md §7 "Primitives"): line, head, ring, ellipse, disc, bar. */
export class Pen {
  /** Art pixels per tile this frame. */
  s = 16;
  constructor(
    private readonly ink: Layer,
    private readonly colour: Layer,
    private readonly solid: Layer,
    private readonly height: Height,
  ) {}

  /** A ground width grown to at least one art pixel on screen at this zoom. */
  w(width: number): number {
    return Math.max(width, (2 * MIN_PX) / this.s);
  }

  /** The ink's width under a coloured line of ground width `w` (already grown). */
  private inkW(w: number, ink: number | undefined): number {
    return Math.max(ink ?? 0, w + (2 * 2 * INK_MARGIN_PX) / this.s);
  }

  /** A polyline (sim points), optionally dashed, over its ink. */
  line(pts: readonly P[], st: Style): void {
    if (pts.length < 2) return;
    const dense = densify(pts);
    const w = this.w(st.width);
    const runs = st.dash ? dashes(dense, st.dash) : [dense];
    if (st.ink !== false) {
      const iw = this.inkW(w, st.ink === undefined ? undefined : st.ink);
      for (const r of runs) this.ribbon(this.ink, r, iw, MARK.ink, (st.inkAlpha ?? INK_ALPHA) * Math.min(1, (st.alpha ?? 1) * 1.6));
    }
    for (const r of runs) this.ribbon(this.colour, r, w, st.colour, st.alpha ?? 1);
  }

  /** An arrowhead `size` long at `at`, pointing along `dir` (a sim direction). */
  head(at: P, dir: P, size: number, st: Omit<Style, 'width' | 'dash'>): void {
    const d = Math.hypot(dir.x, dir.y);
    if (d < 1e-9) return;
    const fx = dir.x / d;
    const fy = dir.y / d;
    const tri = (len: number, half: number, back: number): P[] => [
      { x: at.x + fx * back, y: at.y + fy * back },
      { x: at.x - fx * len - fy * half + fx * back, y: at.y - fy * len + fx * half + fy * back },
      { x: at.x - fx * len + fy * half + fx * back, y: at.y - fy * len - fx * half + fy * back },
    ];
    const grow = Math.max(1, (2 * 3) / this.s / size);
    const len = size * grow;
    if (st.ink !== false) {
      const m = (2 * INK_MARGIN_PX) / this.s;
      this.tri(this.ink, tri(len + 2 * m, len * 0.45 + m, m), MARK.ink, (st.inkAlpha ?? INK_ALPHA) * Math.min(1, (st.alpha ?? 1) * 1.6));
    }
    this.tri(this.colour, tri(len, len * 0.45, 0), st.colour, st.alpha ?? 1);
  }

  /**
   * A ring of radius `r` about `c`: from the screen's top, clockwise (02-look.md §7), all of it or the arc
   * `from`..`to` (fractions of a turn).
   */
  ring(c: P, r: number, st: Style, from = 0, to = 1): void {
    this.line(arcPoints(c, r, r, 0, from, to, true), st);
  }

  /** An ellipse about `c` with half-axes `a` along `angle` (a sim facing) and `b` across it. */
  ellipse(c: P, a: number, b: number, angle: number, st: Style): void {
    this.line(arcPoints(c, a, b, angle, 0, 1, false), st);
  }

  /** A filled disc. */
  disc(c: P, r: number, colour: number, alpha = 1, ink = true): void {
    const rr = Math.max(r, (2 * 1.5) / this.s);
    const n = Math.max(12, Math.ceil((Math.PI * 2 * rr) / 0.3));
    const fan = (layer: Layer, rad: number, col: number, a: number) => {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        this.tri(layer, [c, { x: c.x + Math.cos(a0) * rad, y: c.y + Math.sin(a0) * rad }, { x: c.x + Math.cos(a1) * rad, y: c.y + Math.sin(a1) * rad }], col, a);
      }
    };
    if (ink) fan(this.ink, rr + (2 * INK_MARGIN_PX) / this.s, MARK.ink, INK_ALPHA * Math.min(1, alpha * 1.6));
    fan(this.colour, rr, colour, alpha);
  }

  /**
   * A bar `len` long across facing `face` (a sim angle), centred on `c`, `width` deep, with a nub `nub` long toward
   * the facing (02-look.md §7 "Front preview").
   */
  bar(c: P, face: number, len: number, st: Style, nub = 0): void {
    const fx = Math.cos(face);
    const fy = Math.sin(face);
    const half = len / 2;
    this.line(
      [
        { x: c.x + fy * half, y: c.y - fx * half },
        { x: c.x - fy * half, y: c.y + fx * half },
      ],
      st,
    );
    if (nub > 0) this.line([c, { x: c.x + fx * nub, y: c.y + fy * nub }], st);
  }

  /**
   * A cross (an order refused): two strokes `size` across, laid on the ground so that on screen they cross at 45°
   * (the ground's screen-up is foreshortened by half, so each stroke runs one screen-right to two screen-up).
   */
  cross(c: P, size: number, st: Style): void {
    const h = Math.max(size, (2 * 4) / this.s) / 2;
    for (const k of [1, -1]) {
      const dx = SCREEN_RIGHT.x + 2 * k * SCREEN_UP.x;
      const dy = SCREEN_RIGHT.y + 2 * k * SCREEN_UP.y;
      const l = Math.hypot(dx, dy);
      this.line([{ x: c.x - (dx / l) * h, y: c.y - (dy / l) * h }, { x: c.x + (dx / l) * h, y: c.y + (dy / l) * h }], st);
    }
  }

  /**
   * An order flag standing at `at` (01-flow.md §2): a pole and a pennant in `colour`, standing up out of the ground,
   * snapped to the art-pixel grid like a figure. It writes depth, so it is outlined like a figure.
   */
  flag(at: P, colour: number, alpha = 1, height = 1.15): void {
    const s = this.s;
    const h0 = this.height(at.x, at.y) - LIFT;
    // snap the foot to whole art pixels along the screen's axes, keeping its height (02-look.md §2)
    const across = (at.x + at.y) * Math.SQRT1_2;
    const up = (at.x - at.y) * Math.SQRT1_2 * 0.5 + h0 * (Math.sqrt(3) / 2);
    const sum = Math.round(across * s) / s / Math.SQRT1_2;
    const diff = (Math.round(up * s) / s - h0 * (Math.sqrt(3) / 2)) / (Math.SQRT1_2 * 0.5);
    const fx = (sum + diff) / 2;
    const fz = (sum - diff) / 2;
    const pole = Math.max(0.07, MIN_POLE_PX / s);
    const rx = RIGHT.x;
    const rz = RIGHT.z;
    const L = this.solid;
    const quad = (x0: number, x1: number, y0: number, y1: number, col: number) => {
      const [r, g, b] = rgbOf(col);
      const v = (u: number, y: number) => L.vertex(fx + rx * u, h0 + y, fz + rz * u, r, g, b, alpha);
      v(x0, y0); v(x1, y0); v(x1, y1);
      v(x0, y0); v(x1, y1); v(x0, y1);
    };
    quad(-pole / 2, pole / 2, 0, height, MARK.wood);
    // the pennant: a triangle off the pole's top, on the screen's right
    const [r, g, b] = rgbOf(colour);
    const top = height;
    const drop = 0.38;
    const reach = 0.55;
    const v = (u: number, y: number) => L.vertex(fx + rx * u, h0 + y, fz + rz * u, r, g, b, alpha);
    v(pole / 2, top); v(pole / 2 + reach, top - drop / 2); v(pole / 2, top - drop);
    const [cr, cg, cb] = rgbOf(MARK.cream);
    const m = Math.max(0.06, 1 / s);
    // the edge lies over the cloth: a little toward the camera (no change on screen), so it never z-fights it
    const tx = fx - VIEW.x * EDGE_FORWARD;
    const ty = h0 - VIEW.y * EDGE_FORWARD;
    const tz = fz - VIEW.z * EDGE_FORWARD;
    const c = (u: number, y: number) => L.vertex(tx + rx * u, ty + y, tz + rz * u, cr, cg, cb, alpha);
    // a cream edge along the pennant's top, so it reads on the blue team's own ground
    c(pole / 2, top); c(pole / 2 + reach, top - drop / 2); c(pole / 2 + reach - m * 2, top - drop / 2 + m * 0.2);
    c(pole / 2, top); c(pole / 2 + reach - m * 2, top - drop / 2 + m * 0.2); c(pole / 2, top - m);
  }

  // ------------------------------------------------------------------------------------------------ internals

  private tri(layer: Layer, p: readonly P[], hex: number, alpha: number): void {
    const [r, g, b] = rgbOf(hex);
    for (const q of p) layer.vertex(q.x, this.height(q.x, q.y), q.y, r, g, b, alpha);
  }

  /** A ribbon of ground width `w` along `pts` (already densified), mitred at its joints. */
  private ribbon(layer: Layer, pts: readonly P[], w: number, hex: number, alpha: number): void {
    const n = pts.length;
    if (n < 2) return;
    const [r, g, b] = rgbOf(hex);
    const half = w / 2;
    // per point: the left offset (the mitred normal)
    let lx0 = 0, ly0 = 0, px0 = 0, py0 = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const c = pts[Math.min(n - 1, i + 1)];
      let tx = c.x - a.x;
      let ty = c.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      // the miter: the normal of the mean tangent, lengthened by 1/cos of half the turn (capped)
      let k = 1;
      if (i > 0 && i < n - 1) {
        const ux = p.x - a.x, uy = p.y - a.y;
        const ul = Math.hypot(ux, uy) || 1;
        const nx1 = -uy / ul, ny1 = ux / ul;
        k = Math.min(2, 1 / Math.max(0.5, nx1 * -ty + ny1 * tx));
      }
      const lx = -ty * half * k;
      const ly = tx * half * k;
      if (i > 0) {
        const ax = px0 + lx0, ay = py0 + ly0;
        const bx = px0 - lx0, by = py0 - ly0;
        const cx = p.x + lx, cy = p.y + ly;
        const dx = p.x - lx, dy = p.y - ly;
        const H = this.height;
        const ha = H(ax, ay), hb = H(bx, by), hc = H(cx, cy), hd = H(dx, dy);
        layer.vertex(ax, ha, ay, r, g, b, alpha);
        layer.vertex(bx, hb, by, r, g, b, alpha);
        layer.vertex(dx, hd, dy, r, g, b, alpha);
        layer.vertex(ax, ha, ay, r, g, b, alpha);
        layer.vertex(dx, hd, dy, r, g, b, alpha);
        layer.vertex(cx, hc, cy, r, g, b, alpha);
      }
      lx0 = lx;
      ly0 = ly;
      px0 = p.x;
      py0 = p.y;
    }
  }
}

/** Densifies a polyline so no segment is longer than DENSE tiles (02-look.md §7). */
export function densify(pts: readonly P[]): P[] {
  const out: P[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(1, Math.ceil(d / DENSE));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  return out;
}

/** Splits a polyline into dashes [on, off] by arc length, from its start. */
function dashes(pts: readonly P[], [on, off]: readonly [number, number]): P[][] {
  const out: P[][] = [];
  let cur: P[] | null = [pts[0]];
  let left = on;
  let drawing = true;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let d = Math.hypot(b.x - a.x, b.y - a.y);
    while (d > 1e-9) {
      const step = Math.min(d, left);
      const t = step / d;
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (drawing) cur!.push(q);
      d -= step;
      left -= step;
      a = q;
      if (left <= 1e-9) {
        if (drawing) {
          if (cur!.length > 1) out.push(cur!);
          cur = null;
        } else cur = [q];
        drawing = !drawing;
        left = drawing ? on : off;
      }
    }
  }
  if (drawing && cur && cur.length > 1) out.push(cur);
  return out;
}

/**
 * Points round an ellipse (half-axes a along `angle`, b across) from `from` to `to` turns. A ring starts at the
 * screen's top and goes clockwise on screen (`screen`); an ellipse starts ahead of its facing.
 */
function arcPoints(c: P, a: number, b: number, angle: number, from: number, to: number, screen: boolean): P[] {
  const span = Math.max(0, Math.min(1, to) - Math.max(0, from));
  const n = Math.max(2, Math.ceil((Math.PI * 2 * Math.max(a, b) * span) / 0.35), Math.ceil(48 * span));
  const out: P[] = [];
  const ux = screen ? SCREEN_UP.x : Math.cos(angle);
  const uy = screen ? SCREEN_UP.y : Math.sin(angle);
  const vx = screen ? SCREEN_RIGHT.x : -Math.sin(angle);
  const vy = screen ? SCREEN_RIGHT.y : Math.cos(angle);
  for (let i = 0; i <= n; i++) {
    const t = (from + (span * i) / n) * Math.PI * 2;
    const ca = Math.cos(t) * a;
    const sb = Math.sin(t) * b;
    out.push({ x: c.x + ux * ca + vx * sb, y: c.y + uy * ca + vy * sb });
  }
  return out;
}

/** A timed mark: drawn every frame with `k` = its age over its life (0..1), until its life is spent. */
export interface Effect {
  life: number;
  age: number;
  draw(pen: Pen, k: number): void;
}

/** Real seconds the order-given marks last (chosen; 02-look.md §7 "lines that fade; rings that close in"). */
export const GIVEN_S = 1.3;
export const PING_S = 0.55;
export const CROSS_S = 1.6;
/** 01-flow.md §2: a good front leaves a cream trail for 2.6 s; a refused one a grey trail. */
export const TRAIL_S = 2.6;

/** The fading tail of a timed mark: full for the first part of its life, then dithered out. */
const fade = (k: number, hold = 0.35) => (k < hold ? 1 : Math.max(0, 1 - (k - hold) / (1 - hold)));

/**
 * The marks of a battle: three meshes in the scene (the ink under, the colour over, and standing order flags), the
 * timed marks, and the per-frame drawers. Call `tick(dt)` once per frame and `draw(s)` just before each render.
 */
export class Marks {
  readonly group = new THREE.Group();
  readonly pen: Pen;
  /** Per-frame drawers, called inside every `draw` after the timed marks: the battle's standing marks. */
  readonly drawers: ((pen: Pen) => void)[] = [];
  private readonly effects: Effect[] = [];
  private readonly ink: Layer;
  private readonly colour: Layer;
  private readonly solid: Layer;

  constructor(land: LandData) {
    this.ink = new Layer(markMaterial(true), 2, 'marks:ink');
    this.colour = new Layer(markMaterial(true), 3, 'marks:colour');
    this.solid = new Layer(markMaterial(false), 0, 'marks:flags');
    this.group.add(this.ink.mesh, this.colour.mesh, this.solid.mesh);
    this.group.name = 'marks';
    const height: Height = (x, y) => Math.max(groundAt(land, x, y), WATER_Y) + LIFT;
    this.pen = new Pen(this.ink, this.colour, this.solid, height);
  }

  /** Ages the timed marks by `dt` real seconds (they run on while paused: an order given in a pause shows). */
  tick(dt: number): void {
    for (const e of this.effects) e.age += dt;
    let j = 0;
    for (const e of this.effects) if (e.age < e.life) this.effects[j++] = e;
    this.effects.length = j;
  }

  /** Rebuilds every mark for a frame at zoom `s` (art px per tile). */
  draw(s: number): void {
    this.ink.begin();
    this.colour.begin();
    this.solid.begin();
    this.pen.s = s;
    for (const e of this.effects) e.draw(this.pen, Math.min(1, e.age / e.life));
    for (const d of this.drawers) d(this.pen);
    this.ink.end();
    this.colour.end();
    this.solid.end();
  }

  /** Vertices drawn last frame (ink, colour, flags). */
  stats(): { ink: number; colour: number; flags: number; timed: number } {
    return { ink: this.ink.vertices, colour: this.colour.vertices, flags: this.solid.vertices, timed: this.effects.length };
  }

  // ------------------------------------------------------------------------------------------- timed marks

  /** Any timed mark: `draw(pen, k)` every frame for `life` seconds, k = age/life. */
  effect(life: number, draw: (pen: Pen, k: number) => void): void {
    this.effects.push({ life, age: 0, draw });
  }

  /** A ring that closes in on `at` and is gone (an order given, 02-look.md §7 "pings"). */
  ping(at: P, colour: number = MARK.cream, r = 1.1): void {
    this.effect(PING_S, (pen, k) => {
      const e = 1 - (1 - k) * (1 - k);
      pen.ring(at, r * (1.9 - 0.9 * e), { colour, width: 0.12, alpha: fade(k, 0.6) });
    });
  }

  /**
   * A ring of radius `r` at `at` that holds, then fades over `life` seconds; `close` makes it close in from 1.35 r
   * first (the rally's big gold ring, an attack's red ring round its foe).
   */
  ring(at: P, r: number, colour: number, opts: { life?: number; close?: boolean; width?: number; dash?: readonly [number, number] } = {}): void {
    const life = opts.life ?? GIVEN_S;
    this.effect(life, (pen, k) => {
      const e = Math.min(1, k * 3);
      const rr = opts.close ? r * (1.35 - 0.35 * (1 - (1 - e) * (1 - e))) : r;
      pen.ring(at, rr, { colour, width: opts.width ?? 0.12, alpha: fade(k), dash: opts.dash });
    });
  }

  /** A red X at `at`: an order refused (01-flow.md §2; 08-orders.md §1). No words. */
  cross(at: P, size = 1.1): void {
    this.effect(CROSS_S, (pen, k) => {
      const pop = k < 0.08 ? 1.25 : 1;
      pen.cross(at, size * pop, { colour: MARK.red, width: 0.2, alpha: fade(k, 0.55) });
    });
  }

  /** A route that fades: dashed, with an arrowhead at its end (an order given: "lines that fade"). */
  route(pts: readonly P[], colour: number, opts: { life?: number; dash?: readonly [number, number] | null; head?: boolean; width?: number } = {}): void {
    if (pts.length < 2) return;
    const life = opts.life ?? GIVEN_S;
    const path = pts.slice();
    this.effect(life, (pen, k) => {
      const alpha = fade(k);
      pen.line(path, { colour, width: opts.width ?? 0.12, alpha, dash: opts.dash === null ? undefined : (opts.dash ?? [0.5, 0.3]), ink: 0.24 });
      if (opts.head !== false) {
        const a = path[path.length - 2];
        const b = path[path.length - 1];
        pen.head(b, { x: b.x - a.x, y: b.y - a.y }, 0.6, { colour, alpha });
      }
    });
  }

  /** A front's trail: the line as drawn, cream for a good one, grey for a refused one, fading over 2.6 s. */
  trail(pts: readonly P[], refused = false): void {
    if (pts.length < 2) return;
    const path = pts.slice();
    this.effect(TRAIL_S, (pen, k) => pen.line(path, { colour: refused ? MARK.grey : MARK.cream, width: 0.16, ink: 0.3, alpha: fade(k, 0.5) }));
  }
}
