import * as THREE from 'three';
import { BACK, FAR, NEAR, RIGHT, UP, VIEW } from '../camera';
import { hash32 } from '../figures/hash';
import { FOG, FOG_COLOUR_FRAGMENT } from '../fog';
import { boxGeometry, flameMaterial } from './build';

// The fire (docs/spec/03-land.md §7 "Burning and falling"; 02-look.md §3 "Torches"): flames are unlit boxes that
// flicker in height and cycle through the flame ramp; smoke and embers are typed-array particles drawn as square
// points snapped to the art-pixel grid, seen through the fog, fading by the Bayer dither (no alpha blending).
// Everything moves with the view's clock only, so a frozen clock draws the same frame while the view pans.

/** The flame ramp, dark → light (02-look.md §3). */
export const FLAME = [0xd84a1c, 0xf07a22, 0xffb23a, 0xffe07a] as const;

const MAX_FLAMES = 512;
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);

/** Every flame on the field this frame, as one instanced mesh of unlit boxes. */
export class Flames {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;

  constructor() {
    this.mesh = new THREE.InstancedMesh(boxGeometry(), flameMaterial(), MAX_FLAMES);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLAMES * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = 'flames';
  }

  begin(): void {
    this.n = 0;
  }

  /** A box `w × h × d` standing on (x, y, z), turned `turn` about the up axis. */
  add(x: number, y: number, z: number, w: number, h: number, d: number, color: number, turn = 0): void {
    if (this.n >= MAX_FLAMES || h <= 0) return;
    tmpQ.setFromAxisAngle(Y, -turn);
    tmpM.compose(tmpP.set(x, y + h / 2, z), tmpQ, tmpS.set(w, h, d));
    this.mesh.setMatrixAt(this.n, tmpM);
    this.mesh.setColorAt(this.n, tmpC.setHex(color));
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * A burning roof's flames (03-land.md §7): 8 boxes `0.17 × 0.5·fl` along the ridge, cycling the flame ramp, each
 * flickering by `fl = (0.5 + 0.7|sin(t(6+0.7i) + 1.3i)|)·k`, where k ramps up over 6 s of fire.
 */
export function roofFlames(f: Flames, top: THREE.Vector3, ridge: number, alongZ: boolean, k: number, t: number, seed: number): void {
  for (let i = 0; i < 8; i++) {
    const fl = (0.5 + 0.7 * Math.abs(Math.sin(t * (6 + 0.7 * i) + 1.3 * i))) * k;
    const u = ((i + 0.5) / 8 - 0.5) * ridge * 0.9;
    const v = ((hash32(seed, i, 501) / 4294967296) - 0.5) * 0.3;
    const x = top.x + (alongZ ? v : u);
    const z = top.z + (alongZ ? u : v);
    const c = FLAME[(i + Math.floor(t * 7 + i * 0.37)) & 3];
    // Rooted just under the ridge, leaning out of the thatch.
    f.add(x, top.y - 0.14 - Math.abs(v) * 0.4, z, 0.17, 0.5 * fl, 0.17, c);
  }
}

/**
 * A fire's flame (a shrine's, a camp's, a torch's): one box whose height flickers as `0.8 + 0.4|sin(9t + y)|`
 * (03-land.md §7 "Flames"), in its holder's colour, or cycling the ramp when `color` is null.
 */
export function fireFlame(f: Flames, at: THREE.Vector3, w: number, h: number, t: number, color: number | null, phase = 0): void {
  const k = 0.8 + 0.4 * Math.abs(Math.sin(9 * t + at.y + phase));
  f.add(at.x, at.y, at.z, w, h * k, w, color ?? FLAME[Math.floor(t * 7 + phase) & 3]);
  if (color === null) f.add(at.x, at.y + h * k * 0.55, at.z, w * 0.55, h * k * 0.55, w * 0.55, FLAME[(Math.floor(t * 7 + phase) + 2) & 3]);
}

// ---------------------------------------------------------------------------------------------- particles

const f8 = (v: number) => v.toFixed(8);

const PARTICLE_VS = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aFade;
uniform vec2 uOrigin;
uniform vec3 uPix;
varying vec3 vCol;
varying float vFade;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  vWorld = p;
  // The point covers whole art pixels: its window position is snapped so its square lands on the grid, from the
  // world-fixed screen coordinate less the camera's whole-pixel origin (exact.ts's rule for vertices).
  vec2 screen = vec2(dot(p, vec3(${f8(RIGHT.x)}, ${f8(RIGHT.y)}, ${f8(RIGHT.z)})), dot(p, vec3(${f8(UP.x)}, ${f8(UP.y)}, ${f8(UP.z)}))) * uPix.x;
  float s = aSize;
  vec2 win = floor(screen) - uOrigin + uPix.yz;
  vec2 lo = floor(win - s * 0.5 + 0.5);
  win = lo + s * 0.5;
  float depth = (dot(p, vec3(${f8(VIEW.x)}, ${f8(VIEW.y)}, ${f8(VIEW.z)})) + ${(BACK - NEAR).toFixed(1)}) / ${(FAR - NEAR).toFixed(1)};
  gl_Position = vec4((win - uPix.yz) / uPix.yz, depth * 2.0 - 1.0, 1.0);
  gl_PointSize = s;
  vCol = aColor;
  vFade = aFade;
}`;

const PARTICLE_FS = /* glsl */ `
precision highp float;
uniform vec2 uOrigin;
${FOG_COLOUR_FRAGMENT}
varying vec3 vCol;
varying float vFade;
varying vec3 vWorld;
void main() {
  // See-through by the 4×4 Bayer dither, fixed to the world (02-look.md §9: no alpha blending).
  if (fogBayer() >= vFade) discard;
  gl_FragColor = vec4(fogApply(vCol, vWorld.xz), 1.0);
}`;

const MAX_PARTICLES = 4096;

/** How a particle looks and moves: smoke rises grey and drifts with the wind; embers rise bright and die fast. */
export const Kind = { Smoke: 0, Ember: 1 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** 03-land.md §7: smoke every 0.1 s, grey 0.26–0.46, rising 0.42–0.77, living 3.4–5.2 s, 2–4 art pixels, drifting
 * with a wind of {x: .28, z: −.12}. Embers rise too (chosen: 0.9–1.6 a second, 0.8–1.6 s, 1 pixel, the flame ramp). */
const WIND = { x: 0.28, z: -0.12 };

export class Particles {
  readonly points: THREE.Points;
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly color = new Float32Array(MAX_PARTICLES * 3);
  private readonly fade = new Float32Array(MAX_PARTICLES);
  private readonly vel = new Float32Array(MAX_PARTICLES * 3);
  private readonly age = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly kind = new Uint8Array(MAX_PARTICLES);
  private n = 0;
  /** Particles made so far: every random draw is hash32 of it, so the same clock makes the same smoke. */
  private made = 0;
  /** Each emitter's time since it last emitted. */
  private readonly due = new Map<number, number>();
  private readonly attrs: THREE.BufferAttribute[];

  constructor() {
    const g = new THREE.BufferGeometry();
    const a = (arr: Float32Array, k: number) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [a(this.pos, 3), a(this.size, 1), a(this.color, 3), a(this.fade, 1)];
    g.setAttribute('position', this.attrs[0]);
    g.setAttribute('aSize', this.attrs[1]);
    g.setAttribute('aColor', this.attrs[2]);
    g.setAttribute('aFade', this.attrs[3]);
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      uniforms: { uOrigin: FOG.uOrigin, uPix: FOG.uPix, uFogTex: FOG.uFogTex, uMapSize: FOG.uMapSize, uHaze: FOG.uHaze },
      depthWrite: false,
      depthTest: true,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = 'smoke';
  }

  private r(salt: number): number {
    return hash32(this.made, salt, 601) / 4294967296;
  }

  /** Emits from emitter `id` at (x, y, z) every `every` seconds of `dt`, `count` at a time, spread `spread`. */
  emit(id: number, kind: Kind, x: number, y: number, z: number, every: number, dt: number, spread = 0.25): void {
    let t = (this.due.get(id) ?? every * this.r(id)) + dt;
    while (t >= every) {
      t -= every;
      this.spawn(kind, x, y, z, spread);
    }
    this.due.set(id, t);
  }

  /** Forgets emitters that stopped (so a new fire starts fresh). */
  forget(keep: (id: number) => boolean): void {
    for (const id of this.due.keys()) if (!keep(id)) this.due.delete(id);
  }

  private spawn(kind: Kind, x: number, y: number, z: number, spread: number): void {
    if (this.n >= MAX_PARTICLES) return;
    const i = this.n++;
    this.made++;
    const o = i * 3;
    this.pos[o] = x + (this.r(1) - 0.5) * spread * 2;
    this.pos[o + 1] = y + this.r(2) * 0.1;
    this.pos[o + 2] = z + (this.r(3) - 0.5) * spread * 2;
    this.kind[i] = kind;
    this.age[i] = 0;
    if (kind === Kind.Smoke) {
      const grey = 0.26 + this.r(4) * 0.2;
      this.color[o] = grey;
      this.color[o + 1] = grey;
      this.color[o + 2] = grey * 1.04;
      this.size[i] = 2 + Math.floor(this.r(5) * 3);
      this.vel[o] = WIND.x * (0.6 + this.r(6) * 0.4);
      this.vel[o + 1] = 0.42 + this.r(7) * 0.35;
      this.vel[o + 2] = WIND.z * (0.6 + this.r(6) * 0.4);
      this.life[i] = 3.4 + this.r(8) * 1.8;
    } else {
      tmpC.setHex(FLAME[1 + Math.floor(this.r(4) * 3)]);
      this.color[o] = tmpC.r;
      this.color[o + 1] = tmpC.g;
      this.color[o + 2] = tmpC.b;
      this.size[i] = 1;
      this.vel[o] = (this.r(6) - 0.5) * 0.6 + WIND.x * 0.5;
      this.vel[o + 1] = 0.9 + this.r(7) * 0.7;
      this.vel[o + 2] = (this.r(9) - 0.5) * 0.6 + WIND.z * 0.5;
      this.life[i] = 0.8 + this.r(8) * 0.8;
    }
  }

  /** Moves every particle on by `dt` seconds of the view's clock and retires the old (none move when dt is 0). */
  step(dt: number): void {
    if (dt > 0) {
      let w = 0;
      for (let i = 0; i < this.n; i++) {
        const age = this.age[i] + dt;
        if (age >= this.life[i]) continue;
        const o = i * 3, q = w * 3;
        // Smoke slows as it rises and spreads; embers flutter.
        const slow = this.kind[i] === Kind.Smoke ? 1 - 0.12 * age : 1;
        this.pos[q] = this.pos[o] + this.vel[o] * dt;
        this.pos[q + 1] = this.pos[o + 1] + this.vel[o + 1] * dt * slow;
        this.pos[q + 2] = this.pos[o + 2] + this.vel[o + 2] * dt;
        this.vel[q] = this.vel[o];
        this.vel[q + 1] = this.vel[o + 1];
        this.vel[q + 2] = this.vel[o + 2];
        this.color[q] = this.color[o];
        this.color[q + 1] = this.color[o + 1];
        this.color[q + 2] = this.color[o + 2];
        this.size[w] = this.size[i];
        this.kind[w] = this.kind[i];
        this.life[w] = this.life[i];
        this.age[w] = age;
        w++;
      }
      this.n = w;
    }
    for (let i = 0; i < this.n; i++) {
      const k = this.age[i] / this.life[i];
      // Thick at first, thinning out: coverage by the dither.
      this.fade[i] = this.kind[i] === Kind.Smoke ? Math.max(0.12, Math.min(1, 1.6 - 1.5 * k)) : 1 - k * 0.5;
    }
    this.points.geometry.setDrawRange(0, this.n);
    for (const a of this.attrs) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
    }
  }

  get count(): number {
    return this.n;
  }
}
