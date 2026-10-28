import * as THREE from 'three';
import { FAR, NEAR, ViewCamera } from './camera';
import { heightAt, terrainMesh, type LandData } from './land';
import { Sun } from './light';
import { PixelRenderer, SHADOW_MAP, type Tier } from './renderer';
import { MAX_LIGHTS } from './shaders';

export interface ViewOpts {
  px?: number;
  tier: Tier;
}

/** The battle seen from above: scene, camera, sun and the pixel passes. It never writes to the sim. */
export class View {
  readonly canvas = document.createElement('canvas');
  readonly renderer: PixelRenderer;
  readonly camera: ViewCamera;
  readonly scene = new THREE.Scene();
  readonly sun: Sun;
  /** Time of day, 0..1 of the battle's time limit. */
  dayT = 0;
  nightK = 0;
  grey = 0;
  danger = 0;
  private readonly lights = new Float32Array(MAX_LIGHTS * 4);

  constructor(parent: HTMLElement, readonly land: LandData, opts: ViewOpts) {
    this.canvas.style.display = 'block';
    parent.appendChild(this.canvas);
    this.renderer = new PixelRenderer(this.canvas, { px: opts.px, tier: opts.tier, range: FAR - NEAR });
    this.camera = new ViewCamera((x, y) => heightAt(land, x, y), land);
    this.sun = new Sun(this.scene, SHADOW_MAP[opts.tier]);
    this.scene.add(terrainMesh(land));
    this.resize();
  }

  resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    const { aw, ah } = this.renderer.size;
    this.camera.apply(aw, ah);
    this.sun.update(this.dayT, this.camera.snapped, aw, ah, this.camera.s);
    this.renderer.render(this.scene, this.camera.cam, {
      sub: this.camera.sub,
      origin: this.camera.origin,
      haze: this.sun.haze,
      nightK: this.nightK,
      grey: this.grey,
      danger: this.danger,
      lights: this.lights,
      lightN: 0,
    });
  }
}
