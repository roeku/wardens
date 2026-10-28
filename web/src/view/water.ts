import * as THREE from 'three';
import { EXACT_CLIP_VERTEX } from './exact';
import { FOG, FOG_PARS_FRAGMENT, FOG_PARS_VERTEX, fogFragment } from './fog';
import { WATER_Y, type LandData } from './land-data';

// Water (docs/spec/03-land.md §5): one flat quad per cell within 2 tiles of water, at y = WATER_Y, under a shader
// that reads the ground's depth below the surface and paints dithered depth bands, a foam line and drifting
// glints. Opaque: the shallows show the bed by mixing the painted ground in, never by alpha blending.

/** The meadow's water (03-land.md §6): shallow RGB, and how far the deep colour leans pale. */
const SHALLOW = new THREE.Vector3(0.3, 0.52, 0.58);
const DEEP_PARAM = 0;
const MID_K = new THREE.Vector3(0.57, 0.65, 0.81);
const DEEP_DARK = new THREE.Vector3(0.59, 0.59, 0.68);
const DEEP_PALE = new THREE.Vector3(0.86, 0.88, 0.92);
const FOAM = new THREE.Color(0.74, 0.83, 0.84);
const GLINT = new THREE.Color(0.85, 0.93, 0.97);
/** Depth bands and their dithered edges, in tiles of depth. */
const BAND_BED = 0.1;
const BAND_SHALLOW = 0.28;
const BAND_MID = 0.5;
const BAND_DITHER = 0.06;
const BED_MIX = 0.72;
const FOAM_DEPTH = 0.022;
const DRY_DEPTH = -0.02;
/** Glints: hashed 1/6-tile cells drifting with time; a cell glints at this rate, only past the bed band. */
const GLINT_CELLS = 6;
const GLINT_RATE = 0.008;
const GLINT_DRIFT = new THREE.Vector2(0.11, 0.05);

const VS = /* glsl */ `
${FOG_PARS_VERTEX}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${EXACT_CLIP_VERTEX}
}`;

const FS = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uGround;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uGlint;
${FOG_PARS_FRAGMENT}

uint glintHash(ivec2 c) {
  uint h = uint(c.x + 65536) * 73856093u ^ uint(c.y + 65536) * 19349663u;
  h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15;
  return h;
}

void main() {
  // The surface point is rebuilt from the world-fixed pixel, so the bands, foam and glints hold still while panning.
  vec3 surface = rayAtHeight(pixelRay(), ${WATER_Y.toFixed(2)});
  vec2 p = surface.xz;
  gl_FragDepth = exactDepth(surface);
  float depth = ${WATER_Y.toFixed(2)} - groundHeight(p);
  if (depth < ${DRY_DEPTH.toFixed(2)}) discard;
  float b = fogBayer();
  float dz = depth + (b - 0.5) * ${BAND_DITHER.toFixed(3)};
  vec3 col;
  if (dz < ${BAND_BED.toFixed(2)}) {
    ivec2 tsz = textureSize(uGround, 0);
    ivec2 tc = clamp(ivec2(floor((p - uExt.xy) * (vec2(tsz) / uExt.zw))), ivec2(0), tsz - 1);
    col = mix(texelFetch(uGround, tc, 0).rgb, uShallow, ${BED_MIX.toFixed(2)});
  } else if (dz < ${BAND_SHALLOW.toFixed(2)}) col = uShallow;
  else if (dz < ${BAND_MID.toFixed(2)}) col = uMid;
  else col = uDeep;
  if (depth < ${FOAM_DEPTH.toFixed(3)}) col = uFoam;
  ivec2 gc = ivec2(floor((p + uTime * vec2(${GLINT_DRIFT.x.toFixed(3)}, ${GLINT_DRIFT.y.toFixed(3)})) * ${GLINT_CELLS.toFixed(1)}));
  if (dz >= ${BAND_BED.toFixed(2)} && float(glintHash(gc) & 0xffffu) < ${(GLINT_RATE * 65536).toFixed(1)}) col = uGlint;
  gl_FragColor = vec4(col, 1.0);
  ${fogFragment('p')}
}`;

const shallow = SHALLOW.clone();
const mid = shallow.clone().multiply(MID_K);
const deep = mid.clone().multiply(DEEP_DARK.clone().lerp(DEEP_PALE, DEEP_PARAM));

/** The water's own uniforms; the ground texture changes per battle (the heights are the fog's, shared). */
export const WATER = {
  uGround: { value: null as THREE.Texture | null },
  uTime: { value: 0 },
  uShallow: { value: new THREE.Color(shallow.x, shallow.y, shallow.z) },
  uMid: { value: new THREE.Color(mid.x, mid.y, mid.z) },
  uDeep: { value: new THREE.Color(deep.x, deep.y, deep.z) },
  uFoam: { value: FOAM },
  uGlint: { value: GLINT },
};

let material: THREE.ShaderMaterial | null = null;

/** The water material, made once (materials are never disposed, docs/spec/01-flow.md §8). */
function waterMaterial(): THREE.ShaderMaterial {
  material ??= new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { ...FOG, ...WATER } });
  return material;
}

/** One quad per extended tile flagged in `land.water`, merged into one mesh at the water's height. */
export function waterMesh(land: LandData, ground: THREE.Texture): THREE.Mesh {
  WATER.uGround.value = ground;
  let n = 0;
  for (const v of land.water) n += v;
  const pos = new Float32Array(n * 12);
  const index = new Uint32Array(n * 6);
  let q = 0;
  for (let ey = 0; ey < land.eh; ey++) {
    for (let ex = 0; ex < land.ew; ex++) {
      if (!land.water[ey * land.ew + ex]) continue;
      const [x, z] = [ex - land.border, ey - land.border];
      pos.set([x, WATER_Y, z, x, WATER_Y, z + 1, x + 1, WATER_Y, z + 1, x + 1, WATER_Y, z], q * 12);
      index.set([q * 4, q * 4 + 1, q * 4 + 3, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
      q++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  const mesh = new THREE.Mesh(g, waterMaterial());
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  return mesh;
}
