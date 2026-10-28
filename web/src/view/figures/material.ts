import * as THREE from 'three';
import { gradientMap } from '../toon';
import { FLAME, rgb } from './palette';

// Every figure part is a MeshToonMaterial on the shared 4-step ramp (02-look.md §5 "Materials"), patched so:
// - the paint attribute mixes the instance dye in (`color.a` = how much dye applies);
// - cloth bends in the vertex shader with the per-instance `aExtra = (wind, phase, length)`;
// - thin things (shafts, blades, strings, reins, poles) swell about their centreline by `aExtra.x`, so they are
//   never under 1 art pixel across;
// - atlas cards (banner cloth, shield faces) remap their UVs per instance with `aTile = (u0, v0, du, dv)`; a texel
//   whose alpha is under 0.9 (but over the 0.5 cut) glows: it is drawn its own colour, unlit (the blight's sigils);
// - glowing parts (the blight's eyes and cracks) are drawn their paint, unlit;
// - the flame (a drake's breath) is unlit and dithered: no alpha blending (out/decisions-blight-view.md "Flame").

export type ClothKind = 'hang' | 'flag';
export interface MatOpts {
  cloth?: ClothKind;
  thin?: boolean;
  atlas?: THREE.Texture;
  glow?: boolean;
  flame?: boolean;
}

/**
 * Shared by every figure material: the cloth clock (s), and the camera's pixel grid for the exact clip: uPix =
 * (art px per tile, half the target's width and height in art px; x = 0 turns the exact clip off), uOrigin = the
 * camera's position in whole art pixels.
 */
export const figureUniforms = {
  uTime: { value: 0 },
  uPix: { value: new THREE.Vector3(0, 1, 1) },
  uOrigin: { value: new THREE.Vector2() },
  /** The least radius (tiles) of a thin thing's shadow: one shadow-map texel, so it casts a solid line. */
  uShadowR: { value: 0 },
};

/**
 * Patches other modules add to every figure material (the fog of war will hook in here). Register before the
 * first frame is drawn; a patch receives the shader in onBeforeCompile. Note the instance matrix is relative to
 * the figure's root: the world point is `relP.xyz + aRoot` (three's worldPosition already includes it).
 */
export const figureShaderHooks: ((shader: THREE.WebGLProgramParametersWithUniforms) => void)[] = [];

const R = Math.SQRT1_2;
const f8 = (v: number) => v.toFixed(8);

const PARS = /* glsl */ `
attribute float aS;
attribute vec3 aAxis;
attribute vec4 aExtra;
attribute vec3 aRoot;
uniform float uTime;
uniform vec3 uPix;
uniform vec2 uOrigin;
uniform float uShadowR;
const vec3 FIG_RIGHT = vec3(${f8(R)}, 0.0, ${f8(R)});
const vec3 FIG_UP = vec3(${f8(R * 0.5)}, ${f8(Math.sqrt(3) / 2)}, ${f8(-R * 0.5)});
float clothBend(float s, float z, float flow, float ph) {
  float gust = 0.5 + 0.5 * sin(uTime * 0.83 + ph * 0.37);
  return -flow * (0.3 + 0.95 * s) - 0.05 * s
    + (0.07 + 0.2 * flow + 0.05 * gust) * s * sin(uTime * (2.4 + 3.6 * flow) - 4.6 * s + 13.0 * z + ph);
}
`;

const HANG = /* glsl */ `
{
  float L = aExtra.z;
  float flow = aExtra.x;
  float ph = aExtra.y;
  float s = aS;
  vec2 C = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    float s0 = float(i) / 6.0;
    float seg = clamp(s - s0, 0.0, 1.0 / 6.0);
    float a = clothBend(s0 + seg * 0.5, position.z, flow, ph);
    C += seg * L * vec2(sin(a), -cos(a));
  }
  float a = clothBend(s, position.z, flow, ph);
  float ca = cos(a), sa = sin(a);
  vec2 off = vec2(position.x, position.y + s * L);
  clothP = vec3(C.x + off.x * ca - off.y * sa, C.y + off.x * sa + off.y * ca, position.z);
  objectNormal = vec3(objectNormal.x * ca - objectNormal.y * sa, objectNormal.x * sa + objectNormal.y * ca, objectNormal.z);
}
`;

const FLAG = /* glsl */ `
{
  float w = aExtra.x;
  float ph = aExtra.y;
  float len = max(aExtra.z, 1e-3);
  float u = aS;
  float arg = uTime * (5.0 + 4.0 * w) - 6.5 * u + ph;
  float A = (0.22 + 0.4 * w) * len * 0.35;
  clothP.z += A * u * sin(arg);
  // the light follows the wave only a little, so the device stays flat-lit and the cloth doesn't band
  float dzdy = -0.3 * A * (sin(arg) - 6.5 * u * cos(arg)) / len;
  objectNormal = normalize(vec3(objectNormal.x, objectNormal.y - dzdy * objectNormal.z, objectNormal.z));
}
`;

const THIN = /* glsl */ `
clothP = aAxis + (position - aAxis) * max(aExtra.x, 1.0);
`;
/** In the shadow pass a thin thing is at least one shadow texel in radius, so its shadow is a line, not dashes. */
const THIN_SHADOW = /* glsl */ `
clothP = aAxis + (position - aAxis) * max(max(aExtra.x, 1.0), uShadowR / max(aExtra.y, 1e-4));
`;

/**
 * Instance matrices are relative to the figure's root; aRoot is the root's snapped world position. These replace
 * three's project_vertex and worldpos_vertex so the world point is root + relative everywhere (light, depth,
 * shadows), and then put the clip position exactly on the art-pixel grid: the root's whole pixel plus the
 * relative offset rounded to 1/256 px (the rasterizer's sub-pixel step), minus the camera's whole-pixel origin.
 * A pose draws the same picture wherever the figure stands and wherever the camera is, a whole pixel over.
 */
const PROJECT = /* glsl */ `
vec4 relP = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  relP = instanceMatrix * relP;
#endif
vec4 mvPosition = modelViewMatrix * vec4(relP.xyz + aRoot, 1.0);
gl_Position = projectionMatrix * mvPosition;
if (uPix.x > 0.0) {
  vec2 pix = floor(vec2(dot(aRoot, FIG_RIGHT), dot(aRoot, FIG_UP)) * uPix.x + 0.5);
  vec2 off = floor(vec2(dot(relP.xyz, FIG_RIGHT), dot(relP.xyz, FIG_UP)) * uPix.x * 256.0 + 0.5) / 256.0;
  // The window position is (pix + off - uOrigin) + half the target. When the target's width or height is odd,
  // that half ends in .5 and a whole-pixel point would sit exactly on a pixel centre (a 1:1 banner texel edge on
  // every sample, vertices on the rasterizer's rounding boundaries): float noise of 1e-5 then picks the side.
  // Cancel the half pixel, and add a quarter of a 1/256 step so every vertex sits strictly inside a sub-pixel
  // cell, whatever the target's size and however the GPU snaps (truncating or rounding, 4 to 8 sub-pixel bits).
  vec2 bias = 1.0 / 1024.0 - fract(uPix.yz);
  gl_Position.xy = (pix + off - uOrigin + bias) / uPix.yz * gl_Position.w;
}
`;
/**
 * The hemisphere light's weight rounded to 1/1024 (far below one colour step): interpolated normals can differ in
 * their last bits between two whole-pixel positions of the same pose, and the continuous hemisphere term must not
 * land either side of a step (the land does the same, out/decisions-land.md).
 */
const LIGHTS_PARS = THREE.ShaderChunk.lights_pars_begin.replace(
  'float hemiDiffuseWeight = 0.5 * dotNL + 0.5;',
  'float hemiDiffuseWeight = floor( ( 0.5 * dotNL + 0.5 ) * 1024.0 + 0.5 ) / 1024.0;',
);
/** An atlas texel with alpha under 0.9 glows (drawn as painted, unlit); every drawn texel is opaque. */
const ATLAS_GLOW = /* glsl */ `
#include <opaque_fragment>
if (diffuseColor.a < 0.9) gl_FragColor.rgb = diffuseColor.rgb;
gl_FragColor.a = 1.0;`;
const GLOW = /* glsl */ `
#include <opaque_fragment>
gl_FragColor.rgb = diffuseColor.rgb;`;

const hex3 = (h: number) => {
  const [r, g, b] = rgb(h);
  return `vec3(${f8(r)}, ${f8(g)}, ${f8(b)})`;
};
/**
 * The flame's varyings: its geometry is a unit cone along +x whose `aAxis.x` carries u along the jet (0..1);
 * `aExtra` = (how far the jet has reached 0..1, how far it has faded 0..1, phase, the near end eaten away 0..1).
 * The rim (0 at the jet's core, 1 at its silhouette) is read from the view-space normal. The dither is anchored at the figure's root pixel, so a whole-pixel move of the camera or the drake
 * moves the flame's pixels with it (pixel stability).
 */
const FLAME_VS = /* glsl */ `
varying vec2 vFlame;
flat varying vec4 vFlameP;
flat varying vec2 vRootWin;
`;
const FLAME_VS_MAIN = /* glsl */ `
vFlame = aAxis.xy;
vFlameP = aExtra;
vRootWin = uPix.x > 0.0 ? floor(vec2(dot(aRoot, FIG_RIGHT), dot(aRoot, FIG_UP)) * uPix.x + 0.5) - uOrigin + floor(uPix.yz) : vec2(0.0);
`;
const FLAME_FS = /* glsl */ `
varying vec2 vFlame;
flat varying vec4 vFlameP;
flat varying vec2 vRootWin;
uniform float uTime;
const int FLAME_BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
float flameBayer(vec2 c) {
  ivec2 i = ivec2(mod(c, 4.0));
  return (float(FLAME_BAYER[i.x + i.y * 4]) + 0.5) / 16.0;
}
`;
const FLAME_MAIN = /* glsl */ `
#include <opaque_fragment>
{
  // u along the jet; r: 0 where the surface faces the camera (the jet's core), 1 at its silhouette
  float u = vFlame.x, r = 1.0 - abs(normalize(normal).z);
  float ext = vFlameP.x, fade = vFlameP.y, ph = vFlameP.z, eaten = vFlameP.w;
  if (u > ext || u < eaten) discard;
  float th = flameBayer(floor(gl_FragCoord.xy) - vRootWin);
  float uu = u / max(ext, 1e-3);
  // tongues: the rim and the far end break up and lick as the clock runs; the core near the mouth stays solid
  float lick = sin(uTime * 21.0 - u * 15.0 + ph) * sin(uTime * 11.0 + r * 7.0 + u * 4.0 + ph * 1.7);
  float dens = (1.0 - fade) * (1.75 - 1.1 * uu * uu - 0.9 * r * r * r + 0.3 * lick) - fade * 0.4;
  if (dens < th) discard;
  float heat = 1.12 - 0.72 * uu - 0.5 * r * r + 0.16 * lick - 0.45 * fade;
  float k = clamp(heat + (th - 0.5) * 0.12, 0.0, 0.999);
  gl_FragColor = vec4(k < 0.3 ? ${hex3(FLAME[0])} : k < 0.55 ? ${hex3(FLAME[1])} : k < 0.8 ? ${hex3(FLAME[2])} : ${hex3(FLAME[3])}, 1.0);
}`;

const WORLDPOS = THREE.ShaderChunk.worldpos_vertex.replace(
  'worldPosition = instanceMatrix * worldPosition;',
  'worldPosition = instanceMatrix * worldPosition;\n\t\tworldPosition.xyz += aRoot;',
);

function patch(opts: MatOpts) {
  return (shader: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, figureUniforms);
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${PARS}${opts.atlas ? 'attribute vec4 aTile;\n' : ''}${opts.flame ? FLAME_VS : ''}`);
    vs = vs.replace(
      '#include <color_vertex>',
      /* glsl */ `
#if defined( USE_COLOR_ALPHA ) && defined( USE_INSTANCING_COLOR )
  vColor = vec4(color.rgb * mix(vec3(1.0), instanceColor.rgb, color.a), 1.0);
#else
  #include <color_vertex>
#endif`,
    );
    const body = (opts.thin ? THIN : '') + (opts.cloth === 'hang' ? HANG : opts.cloth === 'flag' ? FLAG : '');
    vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\nvec3 clothP = position;\n${body}`);
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = clothP;');
    if (opts.atlas) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * aTile.zw + aTile.xy;');
    vs = vs.replace('#include <project_vertex>', PROJECT + (opts.flame ? FLAME_VS_MAIN : ''));
    vs = vs.replace('#include <worldpos_vertex>', WORLDPOS);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader.replace('#include <lights_pars_begin>', LIGHTS_PARS);
    if (opts.flame) fs = fs.replace('#include <common>', `#include <common>\n${FLAME_FS}`).replace('#include <opaque_fragment>', FLAME_MAIN);
    else if (opts.glow) fs = fs.replace('#include <opaque_fragment>', GLOW);
    else if (opts.atlas) fs = fs.replace('#include <opaque_fragment>', ATLAS_GLOW);
    shader.fragmentShader = fs;
    for (const hook of figureShaderHooks) hook(shader);
  };
}

const keyOf = (o: MatOpts) => `fig:${o.cloth ?? '-'}:${o.thin ? 't' : '-'}:${o.atlas ? `a${o.atlas.id}` : '-'}:${o.glow ? 'g' : '-'}:${o.flame ? 'f' : '-'}`;
const cache = new Map<string, THREE.MeshToonMaterial>();

/** The figure material for these options; one per variant, made once and never disposed (01-flow.md §8). */
export function figureMaterial(opts: MatOpts): THREE.MeshToonMaterial {
  const key = keyOf(opts);
  let m = cache.get(key);
  if (m) return m;
  m = new THREE.MeshToonMaterial({ gradientMap, vertexColors: true });
  if (opts.atlas) {
    m.map = opts.atlas;
    m.alphaTest = 0.5;
    m.side = THREE.DoubleSide;
  }
  if (opts.flame) m.side = THREE.DoubleSide;
  m.onBeforeCompile = patch(opts);
  m.customProgramCacheKey = () => key;
  cache.set(key, m);
  return m;
}

const depthCache = new Map<string, THREE.MeshDepthMaterial>();

/**
 * The shadow pass for a part: the same root offset, swelling, cloth and atlas cut-out as its colour pass, so the
 * shadow is where the figure is, a spear casts a solid line (not dashes), and notches and tatters cast nothing.
 */
export function figureDepthMaterial(opts: MatOpts): THREE.MeshDepthMaterial {
  const key = `figdepth:${keyOf(opts)}`;
  let m = depthCache.get(key);
  if (m) return m;
  m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (opts.atlas) {
    m.map = opts.atlas;
    m.alphaTest = 0.5;
    m.side = THREE.DoubleSide;
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, figureUniforms);
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${PARS}${opts.atlas ? 'attribute vec4 aTile;\n' : ''}`);
    if (opts.atlas) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * aTile.zw + aTile.xy;');
    const body = (opts.thin ? THIN_SHADOW : '') + (opts.cloth === 'hang' ? HANG : opts.cloth === 'flag' ? FLAG : '');
    vs = vs.replace('#include <begin_vertex>', `vec3 objectNormal = normal;\nvec3 clothP = position;\n${body}\nvec3 transformed = clothP;`);
    // the shadow camera is not the view: plain projection of root + relative, no exact clip
    vs = vs.replace('#include <project_vertex>', PROJECT.replace('if (uPix.x > 0.0)', 'if (false)'));
    vs = vs.replace('#include <worldpos_vertex>', WORLDPOS);
    shader.vertexShader = vs;
  };
  m.customProgramCacheKey = () => key;
  depthCache.set(key, m);
  return m;
}
