import * as THREE from 'three';
import {
  EXACT_FACE,
  EXACT_FACE_PARS_VERTEX,
  EXACT_CLIP_VERTEX,
  EXACT_FACE_VERTEX,
  EXACT_GROUND,
  EXACT_LIGHTS,
  EXACT_LIGHTS_PARS,
  EXACT_NORMAL,
  EXACT_PARS_FRAGMENT,
  EXACT_SHADOW_PARS,
} from './exact';
import { BAYER } from './shaders';

// Fog of war, baked into every material (docs/spec/02-look.md §3, 03-land.md §8). A one-texel-per-tile fog texture
// holds 255 in sight, 128 seen before, 0 never seen, linearly filtered; each material's last step maps its colour
// through three Bayer-dithered levels. Past the map's edge the land takes the dusk colour ×1.04 and fades to the
// haze by far² (far = dist/17 tiles) in 4 dithered steps.

/** Fog levels per tile, as the sim keeps them. */
export const FOG_NEVER = 0;
export const FOG_SEEN = 1;
export const FOG_SIGHT = 2;
const LEVEL_BYTE = [0, 128, 255];
/** Past the edge the haze is full at this distance, in tiles. */
const HAZE_TILES = 17;

function fogTexture(w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(w * h).fill(255), w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function floatTexture(data: Float32Array, w: number, h: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, format, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * The uniforms every patched material shares. The objects live as long as the page; a new battle only changes
 * their values, so no material is ever rebuilt (docs/spec/01-flow.md §8).
 */
export const FOG = {
  uFogTex: { value: fogTexture(1, 1) },
  /** The map's size in tiles. */
  uMapSize: { value: new THREE.Vector2(1, 1) },
  uHaze: { value: new THREE.Color() },
  /** The camera's whole-art-pixel position, so every dither stays fixed to the world while the view pans. */
  uOrigin: { value: new THREE.Vector2() },
  /** Art pixels per tile, and the scene target's centre in pixels ((aw+2)/2, (ah+2)/2). */
  uPix: { value: new THREE.Vector3(1, 0, 0) },
  /** The extended heights, one texel per half-tile sample, read exactly with texelFetch. */
  uHeights: { value: floatTexture(new Float32Array(4), 2, 2, THREE.RedFormat) },
  /** The terrain's vertex normals on the same grid. */
  uNormals: { value: floatTexture(new Float32Array(16), 2, 2, THREE.RGBAFormat) },
  /** The extended grid's north-west corner (x, z) and its size in tiles. */
  uExt: { value: new THREE.Vector4(0, 0, 1, 1) },
};

/** A new map: a fog texture of one texel per tile, all in sight, and the land's heights and normals. */
export function resetFog(w: number, h: number, land: { heights: Float32Array; border: number; ew: number; eh: number }, normals: THREE.DataTexture): void {
  FOG.uFogTex.value.dispose();
  FOG.uFogTex.value = fogTexture(w, h);
  FOG.uMapSize.value.set(w, h);
  FOG.uHeights.value.dispose();
  FOG.uHeights.value = floatTexture(land.heights, land.ew * 2 + 1, land.eh * 2 + 1, THREE.RedFormat);
  FOG.uNormals.value.dispose();
  FOG.uNormals.value = normals;
  FOG.uExt.value.set(-land.border, -land.border, land.ew, land.eh);
}

/** Sets the fog from one byte per tile, row-major from the north: 0 never seen, 1 seen before, 2 in sight. */
export function setFog(levels: Uint8Array): void {
  const tex = FOG.uFogTex.value;
  const data = tex.image.data as Uint8Array;
  for (let k = 0; k < data.length; k++) data[k] = LEVEL_BYTE[levels[k] ?? FOG_SIGHT] ?? 255;
  tex.needsUpdate = true;
}

export const FOG_PARS_VERTEX = /* glsl */ `
uniform vec2 uOrigin;
uniform vec3 uPix;
varying vec3 vWorld;`;

/** World position of the vertex in `transformed`, through the instance matrix when there is one. */
export const FOG_VERTEX = /* glsl */ `
{
  vec4 fogWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    fogWp = instanceMatrix * fogWp;
  #endif
  vWorld = (modelMatrix * fogWp).xyz;
}`;

/** The three levels and the haze: `fogApply(c, p)` is colour c seen at world (x, z) p. Needs uOrigin declared. */
const FOG_LEVELS = /* glsl */ `
${BAYER}
float fogBayer() { return bayer4(floor(gl_FragCoord.xy) + uOrigin); }
vec3 fogGreyed(vec3 c, float k) { return mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))), k); }
vec3 fogDusk(vec3 c) { return fogGreyed(c, 0.18) * 0.8 + vec3(0.0, 0.008, 0.03); }
vec3 fogNight(vec3 c) { return fogGreyed(c, 0.3) * 0.58 + vec3(0.01, 0.016, 0.045); }
/** Colour c seen at world (x, z) p, through the fog and the haze past the map's edge. */
vec3 fogApply(vec3 c, vec2 p) {
  float b = fogBayer();
  vec2 past = max(max(-p, p - uMapSize), vec2(0.0));
  float dist = length(past);
  if (dist > 0.0) {
    float far = dist / ${HAZE_TILES.toFixed(1)};
    float q = clamp(floor(min(far * far, 1.0) * 4.0 + b) / 4.0, 0.0, 1.0);
    return mix(fogDusk(c) * 1.04, uHaze, q);
  }
  float level = floor(texture2D(uFogTex, p / uMapSize).r * 2.0 + b);
  if (level >= 2.0) return c;
  if (level >= 1.0) return fogDusk(c);
  return fogNight(c);
}`;

export const FOG_PARS_FRAGMENT = /* glsl */ `
uniform sampler2D uFogTex;
uniform vec2 uMapSize;
uniform vec3 uHaze;
uniform vec2 uOrigin;
uniform vec3 uPix;
uniform sampler2D uHeights;
uniform vec4 uExt;
varying vec3 vWorld;
${EXACT_PARS_FRAGMENT}
${FOG_LEVELS}`;

/**
 * Only the fog's colour step, for materials with their own surface work (the figures): the fog uniforms and
 * `fogApply`. The material declares `uniform vec2 uOrigin` itself.
 */
export const FOG_COLOUR_FRAGMENT = /* glsl */ `
uniform sampler2D uFogTex;
uniform vec2 uMapSize;
uniform vec3 uHaze;
${FOG_LEVELS}`;

/** The material's final colour through the fog, at world (x, z) `p`. */
export const fogFragment = (p: string) => /* glsl */ `
gl_FragColor.rgb = fogApply(gl_FragColor.rgb, ${p});`;

/**
 * How a patched material finds its surface point. `ground`: the terrain, rebuilt exactly from the pixel's ray and
 * the height grid (texel, normal, depth and shadow lookup). `face`: an instanced shape, rebuilt from its face's
 * world corners (needs `faceGeometry`). `plain`: the interpolated world position.
 */
export type Surface = 'ground' | 'face' | 'plain';

export interface FogOpts {
  surface?: Surface;
  /** Foliage: a world-fixed speckle from a `floor(worldPos·11)` hash: above 0.82 ×1.22, below 0.18 ×0.84. */
  speckle?: boolean;
  /** Stones: faces pointing up take the land's coat colour by `smoothstep(.5, .85, up)·.85`. */
  coat?: boolean;
}

const SPECKLE = /* glsl */ `
{
  uvec3 q = uvec3(ivec3(floor(exactP * 11.0)) + 65536);
  uint h = q.x * 73856093u ^ q.y * 19349663u ^ q.z * 83492791u;
  h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15;
  float sp = float(h & 0xffffu) / 65535.0;
  diffuseColor.rgb *= sp > 0.82 ? 1.22 : (sp < 0.18 ? 0.84 : 1.0);
}`;

const COAT = /* glsl */ `
diffuseColor.rgb = mix(diffuseColor.rgb, uCoat, smoothstep(0.5, 0.85, exactN.y) * 0.85);`;

/** The land's coat colour (moss in the meadow). */
export const COAT_UNIFORM = { uCoat: { value: new THREE.Color(0x5c8038) } };

/** Where each surface computes `exactP` and `exactN` (world space), at the top of the fragment's colour work. */
const SURFACE_POINT: Record<Surface, string> = {
  ground: /* glsl */ `
vec3 exactP, exactN;
exactGround(vWorld, exactP, exactN);
gl_FragDepth = exactDepth(exactP);
{
  ivec2 tsz = textureSize(map, 0);
  ivec2 tc = clamp(ivec2(floor((exactP.xz - uExt.xy) * (vec2(tsz) / uExt.zw))), ivec2(0), tsz - 1);
  diffuseColor *= texelFetch(map, tc, 0);
}`,
  face: /* glsl */ `
vec3 exactP, exactN;
exactFace(exactP, exactN);
gl_FragDepth = exactDepth(exactP);`,
  plain: /* glsl */ `
vec3 exactP = vWorld;
vec3 exactN = normalize(vWorld);`,
};

/**
 * Patches a built-in material (toon) so its final colour goes through the fog, its surface point is rebuilt exactly
 * (`ground`, `face`), and optionally speckled or coated. Each variant gets its own program cache key, since the
 * patch closures share their source text.
 */
export function patchFog<M extends THREE.Material>(material: M, opts: FogOpts = {}): M {
  const surface = opts.surface ?? 'plain';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, FOG, opts.coat ? COAT_UNIFORM : {});
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${FOG_PARS_VERTEX}`);
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>\n${FOG_VERTEX}\n${EXACT_CLIP_VERTEX}`);
    // One preamble after three's common chunk, in order: fog and exact helpers, then the surface's own.
    const pre = [FOG_PARS_FRAGMENT, EXACT_SHADOW_PARS];
    if (surface === 'ground') pre.push(EXACT_GROUND);
    if (surface === 'face') {
      vs = vs.replace('#include <common>', `#include <common>\n${EXACT_FACE_PARS_VERTEX}`);
      vs = vs.replace('#include <project_vertex>', `#include <project_vertex>\n${EXACT_FACE_VERTEX}`);
      pre.push(EXACT_FACE);
    }
    if (opts.coat) pre.push('uniform vec3 uCoat;');
    let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\n${pre.join('\n')}`);
    // The surface point replaces the map lookup (the ground) or comes just before the colour work (the rest).
    const point = SURFACE_POINT[surface];
    fs = surface === 'ground' ? fs.replace('#include <map_fragment>', point) : fs.replace('#include <map_fragment>', `${point}\n#include <map_fragment>`);
    const after = `${opts.speckle ? SPECKLE : ''}${opts.coat ? COAT : ''}`;
    fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n${after}`);
    if (surface !== 'plain') {
      fs = fs.replace('#include <normal_fragment_begin>', EXACT_NORMAL);
      fs = fs.replace('#include <lights_fragment_begin>', EXACT_LIGHTS);
      fs = fs.replace('#include <lights_pars_begin>', EXACT_LIGHTS_PARS);
    }
    fs = fs.replace('#include <dithering_fragment>', `${fogFragment(surface === 'plain' ? 'vWorld.xz' : 'exactP.xz')}\n#include <dithering_fragment>`);
    // A colour constant over an instance is passed flat, so interpolation can't nudge its last bit.
    vs = vs.replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\n#define vColor vColorFlat\nflat varying vec3 vColorFlat;');
    fs = fs.replace('#include <color_pars_fragment>', '#define vColor vColorFlat\nflat varying vec3 vColorFlat;');
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => `fog:${surface}:${opts.speckle ? 's' : ''}${opts.coat ? 'c' : ''}`;
  return material;
}
