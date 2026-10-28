import * as THREE from 'three';
import { PITCH } from './camera';

// docs/spec/02-look.md §3: the light is the clock. t = battle time / time limit.

type RGB = [number, number, number];
interface Key {
  t: number;
  elev: number;
  sun: RGB;
  sunI: number;
  sky: RGB;
  ground: RGB;
  hemiI: number;
  haze: RGB;
}

const KEYS: Key[] = [
  { t: 0, elev: 52, sun: [1, 0.95, 0.84], sunI: 2.45, sky: [0.8, 0.86, 0.98], ground: [0.56, 0.5, 0.4], hemiI: 1.62, haze: [0.42, 0.5, 0.56] },
  { t: 0.55, elev: 42, sun: [1, 0.92, 0.76], sunI: 2.42, sky: [0.8, 0.84, 0.93], ground: [0.58, 0.5, 0.38], hemiI: 1.56, haze: [0.44, 0.48, 0.52] },
  { t: 0.8, elev: 26, sun: [1, 0.78, 0.5], sunI: 2.5, sky: [0.8, 0.72, 0.8], ground: [0.54, 0.43, 0.34], hemiI: 1.4, haze: [0.42, 0.34, 0.38] },
  { t: 1, elev: 13, sun: [0.98, 0.52, 0.34], sunI: 1.9, sky: [0.48, 0.48, 0.68], ground: [0.36, 0.3, 0.28], hemiI: 1.1, haze: [0.2, 0.18, 0.28] },
];

export interface Daylight {
  elev: number;
  sun: THREE.Color;
  sunI: number;
  sky: THREE.Color;
  ground: THREE.Color;
  hemiI: number;
  haze: THREE.Color;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const mixRGB = (a: RGB, b: RGB, k: number) => new THREE.Color(lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k));

export function daylight(t: number): Daylight {
  const tc = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < KEYS.length - 2 && tc > KEYS[i + 1].t) i++;
  const [a, b] = [KEYS[i], KEYS[i + 1]];
  const k = (tc - a.t) / (b.t - a.t);
  return {
    elev: lerp(a.elev, b.elev, k),
    sun: mixRGB(a.sun, b.sun, k),
    sunI: lerp(a.sunI, b.sunI, k),
    sky: mixRGB(a.sky, b.sky, k),
    ground: mixRGB(a.ground, b.ground, k),
    hemiI: lerp(a.hemiI, b.hemiI, k),
    haze: mixRGB(a.haze, b.haze, k),
  };
}

const SHADOW_BIAS = -0.0008;
const SHADOW_NORMAL_BIAS = 0.02;
const SHADOW_MARGIN = 6;
/** Re-centre the shadow square once the focus has drifted this share of the margin. */
const RECENTRE_SHARE = 0.75;
const SUN_BACK = 100;
/** Covers the map and 18 tiles of country past it at the lowest evening sun. */
const SHADOW_FAR = 220;

/**
 * The sun and the sky. The shadow camera is a square round the focus; it is snapped to its own texel grid so
 * shadows hold still while the view pans (DECISIONS.md D-06).
 */
export class Sun {
  readonly light = new THREE.DirectionalLight();
  readonly hemi = new THREE.HemisphereLight();
  haze = new THREE.Color();
  private readonly dir = new THREE.Vector3();
  private half = 0;
  private t = -1;

  constructor(scene: THREE.Scene, private readonly mapSize: number) {
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(mapSize, mapSize);
    this.light.shadow.bias = SHADOW_BIAS;
    this.light.shadow.normalBias = SHADOW_NORMAL_BIAS;
    scene.add(this.light, this.light.target, this.hemi);
  }

  /** Sets the light for time `t` and fits the shadow camera round `focus` for an `aw × ah` view at zoom `s`. */
  update(t: number, focus: THREE.Vector3, aw: number, ah: number, s: number): void {
    const L = daylight(t);
    this.light.color.copy(L.sun);
    this.light.intensity = L.sunI;
    this.hemi.color.copy(L.sky);
    this.hemi.groundColor.copy(L.ground);
    this.hemi.intensity = L.hemiI;
    this.haze.copy(L.haze);

    const el = THREE.MathUtils.degToRad(L.elev);
    const az = -0.35 - 0.25 * t;
    this.dir.set(-Math.sin(az) * Math.cos(el), -Math.sin(el), Math.cos(az) * Math.cos(el));

    const half = Math.hypot((aw + 2) / s, (ah + 2) / (s * Math.sin(PITCH))) / 2 + SHADOW_MARGIN;
    const back = this.dir.clone().negate();
    const xAxis = new THREE.Vector3(0, 1, 0).cross(back).normalize();
    const yAxis = back.clone().cross(xAxis);
    // The square stays put until the focus has used most of its margin, then re-centres snapped to whole shadow
    // texels and on a fixed plane along the light. Between re-centres the shadow map does not change at all,
    // so a slow pan shows no shadow flicker (DECISIONS.md D-06).
    const drift = focus.clone().sub(this.light.target.position);
    const stale = half !== this.half || t !== this.t || Math.hypot(drift.dot(xAxis), drift.dot(yAxis)) > SHADOW_MARGIN * RECENTRE_SHARE;
    if (!stale) return;
    this.half = half;
    this.t = t;
    const texel = (2 * half) / this.mapSize;
    const snap = (v: number) => Math.round(v / texel) * texel - v;
    const target = focus.clone().addScaledVector(xAxis, snap(focus.dot(xAxis))).addScaledVector(yAxis, snap(focus.dot(yAxis)));
    target.addScaledVector(this.dir, -target.dot(this.dir));
    this.light.target.position.copy(target);
    this.light.position.copy(target).addScaledVector(this.dir, -SUN_BACK);
    const c = this.light.shadow.camera;
    c.left = -half;
    c.right = half;
    c.top = half;
    c.bottom = -half;
    c.near = 1;
    c.far = SHADOW_FAR;
    c.updateProjectionMatrix();
    this.light.target.updateMatrixWorld();
    this.light.updateMatrixWorld();
  }
}
