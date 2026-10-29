import * as THREE from 'three';
import { FAR, NEAR, UP, VIEW, ViewCamera } from './camera';
import { normalTexture } from './exact';
import { FOG, resetFog } from './fog';
import { groundTexture, terrainMesh } from './land';
import { groundAt, type LandData } from './land-data';
import { Sun } from './light';
import { PixelRenderer, SHADOW_MAP, type Tier } from './renderer';
import { scatterMeshes } from './scatter';
import { MAX_LIGHTS } from './shaders';
import { WATER, waterMesh } from './water';

/**
 * The camera's rotation, made once. `lookAt` rebuilds it every frame from the snapped position, and its last bits
 * wobble with the translation; a view-space normal or light direction then rounds differently and the hemisphere
 * light flips single pixels by one step of 255 while panning. A constant rotation keeps every frame bit-identical.
 */
const CAMERA_TURN = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(new THREE.Vector3(), VIEW, UP),
);

export interface ViewOpts {
  px?: number;
  tier: Tier;
}

/** The battle seen from above: scene, camera, sun and the pixel passes. It never writes to the sim. */
export class View {
  readonly canvas = document.createElement('canvas');
  readonly renderer: PixelRenderer;
  /** Made anew for each land (its bounds and ground are the land's); the renderer and scene persist. */
  camera: ViewCamera;
  readonly scene = new THREE.Scene();
  readonly sun: Sun;
  /** Time of day, 0..1 of the battle's time limit. */
  dayT = 0;
  /** Seconds of view time, for water glints. The frame loop advances it; `render` never does. */
  time = 0;
  nightK = 0;
  grey = 0;
  danger = 0;
  /** Called after the camera and the sun are set for a frame, just before drawing (the figures pose here). */
  beforeDraw: (() => void) | null = null;
  /** The night's lights for the CELL pass: (x, y) in cell pixels, reach in art pixels, strength; `lightN` used. */
  readonly lights = new Float32Array(MAX_LIGHTS * 4);
  lightN = 0;

  /** The land on show; `setLand` swaps it (the scene changes, the renderer and the materials stay). */
  land: LandData;
  /** The meshes of the land on show, and its painted ground. */
  private landMeshes: THREE.Mesh[] = [];
  private groundTex: THREE.Texture | null = null;

  constructor(parent: HTMLElement, land: LandData, opts: ViewOpts) {
    this.canvas.style.display = 'block';
    parent.appendChild(this.canvas);
    this.renderer = new PixelRenderer(this.canvas, { px: opts.px, tier: opts.tier, range: FAR - NEAR });
    this.sun = new Sun(this.scene, SHADOW_MAP[opts.tier]);
    this.land = land;
    this.camera = new ViewCamera((x, y) => groundAt(land, x, y), land);
    this.setLand(land);
    this.resize();
  }

  /**
   * Shows another land (a scene change, without a page reload): the old terrain, water and scatter leave the scene and
   * their geometries and ground texture are freed; the materials are kept (01-flow.md §8 Performance 1). The camera
   * is made anew over the new land, at its middle.
   */
  setLand(land: LandData): void {
    if (land === this.land && this.landMeshes.length) {
      // the same land again (the road after the muster): only the camera and the light start afresh
      this.camera = new ViewCamera((x, y) => groundAt(land, x, y), land);
      this.dayT = 0;
      this.nightK = 0;
      this.grey = 0;
      this.danger = 0;
      this.lightN = 0;
      return;
    }
    for (const m of this.landMeshes) {
      this.scene.remove(m);
      // the scatter's shapes are shared by every land: only its instance buffers go; the terrain's and the water's
      // geometries are this land's own
      if (m instanceof THREE.InstancedMesh) m.dispose();
      else m.geometry.dispose();
    }
    this.groundTex?.dispose();
    this.land = land;
    this.camera = new ViewCamera((x, y) => groundAt(land, x, y), land);
    const ground = groundTexture(land);
    const terrain = terrainMesh(land, ground);
    const normals = terrain.geometry.attributes.normal as THREE.BufferAttribute;
    resetFog(land.w, land.h, land, normalTexture(normals, land.ew * 2 + 1, land.eh * 2 + 1));
    this.landMeshes = [terrain, waterMesh(land, ground), ...scatterMeshes(land.parts)];
    this.groundTex = ground;
    this.scene.add(...this.landMeshes);
    this.dayT = 0;
    this.nightK = 0;
    this.grey = 0;
    this.danger = 0;
    this.lightN = 0;
  }

  resize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    const { aw, ah } = this.renderer.size;
    this.camera.apply(aw, ah);
    this.camera.cam.quaternion.copy(CAMERA_TURN);
    this.camera.cam.updateMatrixWorld(true);
    this.sun.update(this.dayT, this.camera.snapped, aw, ah, this.camera.s);
    this.beforeDraw?.();
    FOG.uOrigin.value.copy(this.camera.origin);
    FOG.uPix.value.set(this.camera.s, (aw + 2) / 2, (ah + 2) / 2);
    FOG.uHaze.value.copy(this.sun.haze);
    WATER.uTime.value = this.time;
    this.renderer.render(this.scene, this.camera.cam, {
      sub: this.camera.sub,
      origin: this.camera.origin,
      haze: this.sun.haze,
      nightK: this.nightK,
      grey: this.grey,
      danger: this.danger,
      lights: this.lights,
      lightN: this.lightN,
    });
  }
}
