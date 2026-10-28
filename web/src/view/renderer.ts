import * as THREE from 'three';
import { CELL_FS, MAX_LIGHTS, POST_FS, QUAD_VS } from './shaders';

// The palette is exactly the colours that reach the screen: hex values pass through unconverted (02-look.md §1).
THREE.ColorManagement.enabled = false;

/** Art pixels on the short side of the screen. */
const ART_SHORT_SIDE = 380;
const INK = 0x16120f;
const EDGE_TILES = 0.32;

export type Tier = 'high' | 'mid' | 'low';
export const SHADOW_MAP: Record<Tier, number> = { high: 2048, mid: 1024, low: 512 };

/** One frame's inputs to the CELL and POST passes. */
export interface PassInputs {
  sub: THREE.Vector2;
  origin: THREE.Vector2;
  haze: THREE.Color;
  nightK: number;
  grey: number;
  danger: number;
  lights: Float32Array;
  lightN: number;
}

export interface ArtSize {
  /** CSS pixels per art pixel. */
  px: number;
  dpr: number;
  /** The visible picture in art pixels; the scene target adds a 1-pixel margin each side. */
  aw: number;
  ah: number;
}

function quad(material: THREE.ShaderMaterial): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return scene;
}

/**
 * The three passes of 02-look.md §1: the scene into a small art-pixel target with a float depth texture, CELL
 * once per art pixel, then POST scaling up to the canvas. The canvas has no depth buffer of its own.
 */
export class PixelRenderer {
  readonly gl: THREE.WebGLRenderer;
  size: ArtSize = { px: 1, dpr: 1, aw: 1, ah: 1 };
  private rt: THREE.WebGLRenderTarget | null = null;
  private cellRt: THREE.WebGLRenderTarget | null = null;
  private readonly cell: THREE.ShaderMaterial;
  private readonly post: THREE.ShaderMaterial;
  private readonly cellScene: THREE.Scene;
  private readonly postScene: THREE.Scene;
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly opts: { px?: number; tier: Tier; range: number },
  ) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, depth: false });
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.setPixelRatio(1);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.BasicShadowMap;

    this.cell = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS,
      fragmentShader: CELL_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uArt: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() },
        uRange: { value: opts.range },
        uEdge: { value: EDGE_TILES },
        uInk: { value: new THREE.Color(INK) },
        uLights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
        uLightN: { value: 0 },
        uNightK: { value: 0 },
        uGrey: { value: 0 },
      },
    });
    this.post = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS,
      fragmentShader: POST_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tCell: { value: null },
        uOut: { value: new THREE.Vector2() },
        uArt: { value: new THREE.Vector2() },
        uSub: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uDanger: { value: 0 },
      },
    });
    this.cellScene = quad(this.cell);
    this.postScene = quad(this.post);
  }

  /** Sizes the canvas and targets for a window of `w × h` CSS pixels. */
  resize(w: number, h: number): ArtSize {
    const px = this.opts.px ?? Math.max(1, Math.round(Math.min(w, h) / ART_SHORT_SIDE));
    const dpr = this.opts.tier === 'low' ? 1 : Math.min(3, window.devicePixelRatio || 1);
    const aw = Math.floor(w / px);
    const ah = Math.floor(h / px);
    this.size = { px, dpr, aw, ah };
    this.canvas.style.width = `${aw * px}px`;
    this.canvas.style.height = `${ah * px}px`;
    this.gl.setSize(Math.round(aw * px * dpr), Math.round(ah * px * dpr), false);

    this.rt?.dispose();
    this.cellRt?.dispose();
    const [tw, th] = [aw + 2, ah + 2];
    const depthTexture = new THREE.DepthTexture(tw, th, THREE.FloatType);
    depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
    const nearest = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
    this.rt = new THREE.WebGLRenderTarget(tw, th, { ...nearest, depthBuffer: true, stencilBuffer: false, depthTexture });
    this.cellRt = new THREE.WebGLRenderTarget(tw, th, { ...nearest, depthBuffer: false, stencilBuffer: false });

    const u = this.cell.uniforms;
    u.tColor.value = this.rt.texture;
    u.tDepth.value = depthTexture;
    u.uArt.value.set(tw, th);
    const p = this.post.uniforms;
    p.tCell.value = this.cellRt.texture;
    p.uArt.value.set(tw, th);
    p.uOut.value.set(this.canvas.width, this.canvas.height);
    p.uScale.value = px * dpr;
    return this.size;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, f: PassInputs): void {
    const { gl } = this;
    gl.setClearColor(f.haze);
    gl.setRenderTarget(this.rt);
    gl.render(scene, camera);

    const u = this.cell.uniforms;
    u.uOrigin.value.copy(f.origin);
    u.uNightK.value = f.nightK;
    u.uGrey.value = f.grey;
    u.uLightN.value = f.lightN;
    const lights = u.uLights.value as THREE.Vector4[];
    for (let i = 0; i < f.lightN; i++) lights[i].fromArray(f.lights, i * 4);
    gl.setRenderTarget(this.cellRt);
    gl.render(this.cellScene, this.quadCam);

    const p = this.post.uniforms;
    p.uSub.value.copy(f.sub);
    p.uDanger.value = f.danger;
    gl.setRenderTarget(null);
    gl.render(this.postScene, this.quadCam);
  }

  /** The cell image (art resolution, RGBA), for the shimmer check. */
  readCell(): { data: Uint8Array; w: number; h: number } {
    const t = this.cellRt!;
    const data = new Uint8Array(t.width * t.height * 4);
    this.gl.readRenderTargetPixels(t, 0, 0, t.width, t.height, data);
    return { data, w: t.width, h: t.height };
  }
}
