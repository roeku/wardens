import * as THREE from 'three';

// docs/spec/02-look.md §2. World axes: x east, z south (= sim y), y up; 1 unit = 1 tile.

/** Art pixels per tile along the screen. */
export const ZOOMS = [7, 9, 11, 13, 16, 19, 23, 28, 34];
export const PITCH = Math.PI / 6;
const SIN_PITCH = Math.sin(PITCH);
const R = Math.SQRT1_2;
/** Screen right on the ground, and the way the camera faces (north-east), both flat. */
export const RIGHT = new THREE.Vector3(R, 0, R);
export const FWD = new THREE.Vector3(R, 0, -R);
/** The screen's up and the view direction, 30° down from the horizon. */
export const UP = FWD.clone().multiplyScalar(SIN_PITCH).add(new THREE.Vector3(0, Math.cos(PITCH), 0));
export const VIEW = FWD.clone().multiplyScalar(Math.cos(PITCH)).add(new THREE.Vector3(0, -SIN_PITCH, 0));
export const NEAR = 1;
export const FAR = 320;
const BACK = 150;
const EDGE_SLACK = 2;
const FOLLOW_RATE = 3;

export function startZoom(mapW: number): number {
  return mapW >= 80 ? 4 : mapW >= 64 ? 5 : 6;
}

export interface Bounds {
  w: number;
  h: number;
}

/**
 * The orthographic camera, snapped to the art-pixel grid: the focus is projected onto the screen's right and
 * up axes, both rounded to multiples of 1/s, and the remainder goes to POST as `uSub`.
 */
export class ViewCamera {
  readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, NEAR, FAR);
  /** The focus in sim tiles (x east, y south). */
  readonly focus = new THREE.Vector2();
  /** The leftover fraction of an art pixel, for POST. */
  readonly sub = new THREE.Vector2();
  /** The camera's position in whole art pixels, so dithers stay fixed to the world. */
  readonly origin = new THREE.Vector2();
  /** The snapped focus point in the world, for the sun's shadow camera. */
  readonly snapped = new THREE.Vector3();
  zi: number;

  constructor(
    private readonly ground: (x: number, y: number) => number,
    private readonly bounds: Bounds,
  ) {
    this.zi = startZoom(bounds.w);
    this.focus.set(bounds.w / 2, bounds.h / 2);
  }

  /** Art pixels per tile at the current zoom. */
  get s(): number {
    return ZOOMS[this.zi];
  }

  apply(aw: number, ah: number): void {
    const s = this.s;
    const f = new THREE.Vector3(this.focus.x, this.ground(this.focus.x, this.focus.y), this.focus.y);
    const r = f.dot(RIGHT);
    const u = f.dot(UP);
    const rs = Math.round(r * s) / s;
    const us = Math.round(u * s) / s;
    this.snapped.copy(f).addScaledVector(RIGHT, rs - r).addScaledVector(UP, us - u);
    // The camera stands on a fixed plane 150 back along the view, not 150 back from the focus: an ortho picture
    // is the same either way, and every world point keeps the exact same depth while the view pans, so depth
    // outlines can't flicker as the focus crosses hills (DECISIONS.md D-06).
    this.cam.position.copy(this.snapped).addScaledVector(VIEW, -this.snapped.dot(VIEW) - BACK);
    this.cam.up.copy(UP);
    this.cam.lookAt(this.snapped);
    const hw = (aw + 2) / 2 / s;
    const hh = (ah + 2) / 2 / s;
    this.cam.left = -hw;
    this.cam.right = hw;
    this.cam.top = hh;
    this.cam.bottom = -hh;
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld();
    this.sub.set((r - rs) * s, (u - us) * s);
    this.origin.set(Math.round(r * s), Math.round(u * s));
  }

  /** The ground follows the finger: `dx, dy` in CSS pixels; vertical drags are divided by sin(pitch). */
  panBy(dx: number, dy: number, px: number): void {
    const k = 1 / (px * this.s);
    this.move(-dx * k, (dy * k) / SIN_PITCH);
  }

  /** Steps the zoom and keeps the ground under the cursor fixed; `sx, sy` are CSS pixels from the centre. */
  zoomAt(step: number, sx: number, sy: number, px: number): void {
    const zi = Math.max(0, Math.min(ZOOMS.length - 1, this.zi + step));
    if (zi === this.zi) return;
    const before = 1 / (px * this.s);
    this.zi = zi;
    const after = 1 / (px * this.s);
    this.move(sx * (before - after), (-sy * (before - after)) / SIN_PITCH);
  }

  /** Exponential follow toward (x, y). */
  easeTo(x: number, y: number, dt: number, rate = FOLLOW_RATE): void {
    const k = 1 - Math.exp(-rate * dt);
    this.focus.x += (x - this.focus.x) * k;
    this.focus.y += (y - this.focus.y) * k;
    this.clamp();
  }

  /** Moves the focus `across` tiles along screen right and `ahead` tiles along the ground's forward. */
  private move(across: number, ahead: number): void {
    this.focus.x += (across + ahead) * R;
    this.focus.y += (across - ahead) * R;
    this.clamp();
  }

  private clamp(): void {
    this.focus.x = Math.max(-EDGE_SLACK, Math.min(this.bounds.w + EDGE_SLACK, this.focus.x));
    this.focus.y = Math.max(-EDGE_SLACK, Math.min(this.bounds.h + EDGE_SLACK, this.focus.y));
  }
}
