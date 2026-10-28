import * as THREE from 'three';
import { BACK, FAR, NEAR, RIGHT, UP, VIEW } from './camera';

// Exact surface points (out/decisions-land.md, "Pixel-stable land"). The camera only ever moves by whole art pixels,
// so the pixel W = floor(gl_FragCoord) + uOrigin always looks down the same world ray. A fragment rebuilt from W and
// its own triangle's plane (the terrain's corner heights, or an instanced face's world corners) has the same
// position, normal, depth, texel and shadow lookup in every frame, where interpolated varyings differ in their last
// bits as the camera's translation changes and flip pixels that sit on a threshold.

const f8 = (v: number) => v.toFixed(8);

/** Sub-pixel steps the rasterizer is assumed to snap vertices to (8 bits, as WebGL implementations do). */
const SUBPIXEL = 256;

/**
 * Vertex: the clip position rebuilt from the vertex's world-fixed screen coordinates (art pixels along RIGHT and UP,
 * which never depend on the camera), rounded to 1/256 px, minus the camera's whole-pixel origin. The subtraction is
 * exact, so every vertex lands on the same sub-pixel spot of the pixel grid in every frame and the rasterizer covers
 * and interpolates identically. Needs \`vWorld\` set and uniforms uOrigin and uPix.
 */
export const EXACT_CLIP_VERTEX = /* glsl */ `
{
  vec2 screen = vec2(dot(vWorld, vec3(${f8(RIGHT.x)}, ${f8(RIGHT.y)}, ${f8(RIGHT.z)})), dot(vWorld, vec3(${f8(UP.x)}, ${f8(UP.y)}, ${f8(UP.z)}))) * uPix.x;
  screen = floor(screen * ${SUBPIXEL.toFixed(1)} + 0.5) / ${SUBPIXEL.toFixed(1)};
  gl_Position.xy = (screen - uOrigin) / uPix.yz * gl_Position.w;
}`;

/** Fragment helpers. Needs uniforms uOrigin, uPix, uHeights and uExt (fog.ts). */
export const EXACT_PARS_FRAGMENT = /* glsl */ `
const float SQRT2 = 1.41421356;
const float SQRT6_2 = 1.22474487;
const float SQRT3_2 = 0.86602540;
const vec3 VIEW_DIR = vec3(${f8(VIEW.x)}, ${f8(VIEW.y)}, ${f8(VIEW.z)});
/** The screen's across and up coordinates (tiles) of this pixel's ray. */
vec2 pixelRay() {
  vec2 W = floor(gl_FragCoord.xy) + uOrigin;
  return (W + 0.5 - uPix.yz) / uPix.x;
}
/** The point on this pixel's ray at height y. */
vec3 rayAtHeight(vec2 au, float y) {
  float s = SQRT2 * au.x;
  float d = 2.0 * SQRT2 * (au.y - SQRT3_2 * y);
  return vec3((s + d) * 0.5, y, (s - d) * 0.5);
}
/**
 * The depth of world point p, exactly as the orthographic camera stores it: the camera stands on a fixed plane BACK
 * behind the origin along VIEW (DECISIONS.md D-06), so depth is (p·VIEW + BACK − NEAR)/(FAR − NEAR) in every frame.
 */
float exactDepth(vec3 p) {
  return (dot(p, VIEW_DIR) + ${(BACK - NEAR).toFixed(1)}) / ${(FAR - NEAR).toFixed(1)};
}
float heightAt(ivec2 ij) { return texelFetch(uHeights, ij, 0).r; }
/** The terrain cell under (x, z): its corner sample, and the position (x, z) inside it in half-tile units. */
ivec2 groundCell(vec2 p, out vec2 f) {
  ivec2 hs = textureSize(uHeights, 0);
  vec2 g = clamp((p - uExt.xy) * 2.0, vec2(0.0), vec2(hs - 1));
  ivec2 ij = min(ivec2(floor(g)), hs - 2);
  f = g - vec2(ij);
  return ij;
}
/** The plane (h0, gx, gz) of the cell's triangle (abd if f.x + f.y ≤ 1, else bcd), as height at the cell's corner a. */
vec3 groundPlane(ivec2 ij, vec2 f) {
  float a = heightAt(ij), b = heightAt(ij + ivec2(0, 1)), c = heightAt(ij + ivec2(1, 1)), d = heightAt(ij + ivec2(1, 0));
  return f.x + f.y <= 1.0 ? vec3(a, (d - a) * 2.0, (b - a) * 2.0) : vec3(b + d - c, (c - b) * 2.0, (c - d) * 2.0);
}
/** The ground's height at (x, z), on the mesh's triangles. */
float groundHeight(vec2 p) {
  vec2 f;
  ivec2 ij = groundCell(p, f);
  vec3 plane = groundPlane(ij, f);
  vec2 corner = uExt.xy + vec2(ij) * 0.5;
  return plane.x + plane.y * (p.x - corner.x) + plane.z * (p.y - corner.y);
}
`;

/** The terrain: where this pixel's ray meets the triangle under the approximate point vWorld, and its normal. */
export const EXACT_GROUND = /* glsl */ `
uniform sampler2D uNormals;
vec3 groundNormal(ivec2 ij) { return texelFetch(uNormals, ij, 0).xyz; }
void exactGround(vec3 near, out vec3 P, out vec3 N) {
  vec2 f;
  ivec2 ij = groundCell(near.xz, f);
  vec3 plane = groundPlane(ij, f);
  vec2 corner = uExt.xy + vec2(ij) * 0.5;
  vec2 au = pixelRay();
  float s = SQRT2 * au.x;
  float g = plane.y - plane.z;
  float k = plane.x + plane.y * (s * 0.5 - corner.x) + plane.z * (s * 0.5 - corner.y);
  P = rayAtHeight(au, (k + SQRT2 * g * au.y) / (1.0 + SQRT6_2 * g));
  // The vertex normals, interpolated on the same triangle at the exact point.
  vec2 u = (P.xz - corner) * 2.0;
  vec3 na = groundNormal(ij), nb = groundNormal(ij + ivec2(0, 1));
  vec3 nc = groundNormal(ij + ivec2(1, 1)), nd = groundNormal(ij + ivec2(1, 0));
  N = f.x + f.y <= 1.0
    ? na * (1.0 - u.x - u.y) + nd * u.x + nb * u.y
    : nc * (u.x + u.y - 1.0) + nb * (1.0 - u.x) + nd * (1.0 - u.y);
  N = normalize(N);
}`;

/** Instanced faces: every vertex carries its whole triangle (model space), so all three agree on the face exactly. */
export const EXACT_FACE_PARS_VERTEX = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aP1;
attribute vec3 aP2;
attribute vec3 aN0;
attribute vec3 aN1;
attribute vec3 aN2;
flat varying vec3 vF0;
flat varying vec3 vF1;
flat varying vec3 vF2;
flat varying vec3 vFN0;
flat varying vec3 vFN1;
flat varying vec3 vFN2;`;

export const EXACT_FACE_VERTEX = /* glsl */ `
{
  mat4 fm = modelMatrix;
  #ifdef USE_INSTANCING
    fm = modelMatrix * instanceMatrix;
  #endif
  vF0 = (fm * vec4(aP0, 1.0)).xyz;
  vF1 = (fm * vec4(aP1, 1.0)).xyz;
  vF2 = (fm * vec4(aP2, 1.0)).xyz;
  mat3 fn = transpose(inverse(mat3(fm)));
  vFN0 = fn * aN0;
  vFN1 = fn * aN1;
  vFN2 = fn * aN2;
}`;

/** Where this pixel's ray meets the face, and the vertex normals interpolated there (edge-on faces fall back). */
export const EXACT_FACE = /* glsl */ `
flat varying vec3 vF0;
flat varying vec3 vF1;
flat varying vec3 vF2;
flat varying vec3 vFN0;
flat varying vec3 vFN1;
flat varying vec3 vFN2;
void exactFace(out vec3 P, out vec3 N) {
  vec3 e1 = vF1 - vF0;
  vec3 e2 = vF2 - vF0;
  vec3 n = cross(e1, e2);
  float dn = dot(n, VIEW_DIR);
  if (abs(dn) < 0.02 * length(n)) {
    P = vWorld;
    N = normalize(vFN0 + vFN1 + vFN2);
    return;
  }
  vec3 A = rayAtHeight(pixelRay(), 0.0);
  P = A + (dot(n, vF0 - A) / dn) * VIEW_DIR;
  vec3 q = P - vF0;
  float d00 = dot(e1, e1), d01 = dot(e1, e2), d11 = dot(e2, e2), d20 = dot(q, e1), d21 = dot(q, e2);
  float den = d00 * d11 - d01 * d01;
  float b1 = (d11 * d20 - d01 * d21) / den;
  float b2 = (d00 * d21 - d01 * d20) / den;
  N = normalize((1.0 - b1 - b2) * vFN0 + b1 * vFN1 + b2 * vFN2);
}`;

/** three's normal_fragment_begin, with the exact world normal brought into view space. */
export const EXACT_NORMAL = /* glsl */ `
float faceDirection = 1.0;
vec3 normal = normalize(mat3(viewMatrix) * exactN);
vec3 nonPerturbedNormal = normal;`;

/**
 * three's lights_fragment_begin, with each directional shadow looked up at the exact point (offset along the exact
 * normal by the light's normal bias, as three's vertex shader would) instead of the interpolated shadow coordinate.
 */
/**
 * three's lights_pars_begin with the hemisphere light's weight rounded to 1/1024 (an irradiance step far below one
 * colour step of 255). On a pixel that lies on the edge shared by two smooth-shaded faces, the two faces' normals
 * differ in their last bit; unrounded, the continuous hemisphere term can land either side of a colour step.
 */
export const EXACT_LIGHTS_PARS = THREE.ShaderChunk.lights_pars_begin.replace(
  'float hemiDiffuseWeight = 0.5 * dotNL + 0.5;',
  'float hemiDiffuseWeight = floor( ( 0.5 * dotNL + 0.5 ) * 1024.0 + 0.5 ) / 1024.0;',
);

/** The uniform EXACT_LIGHTS needs, for the fragment's preamble (three declares it only in the vertex shader). */
export const EXACT_SHADOW_PARS = '#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0\nuniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];\n#endif';

export const EXACT_LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replaceAll(
  'vDirectionalShadowCoord[ i ]',
  '( directionalShadowMatrix[ i ] * vec4( exactP + exactN * directionalLightShadow.shadowNormalBias, 1.0 ) )',
);

/**
 * A copy of `g` with one vertex per triangle corner and, on every vertex, its whole triangle: corners aP0–aP2 and
 * their normals aN0–aN2, for the exact face lookup.
 */
export function faceGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const pos = ng.attributes.position as THREE.BufferAttribute;
  const nor = ng.attributes.normal as THREE.BufferAttribute;
  const n = pos.count;
  const corners = [0, 1, 2].map(() => new Float32Array(n * 3));
  const normals = [0, 1, 2].map(() => new Float32Array(n * 3));
  for (let v = 0; v < n; v++) {
    const f = v - (v % 3);
    for (let c = 0; c < 3; c++) {
      corners[c].set([pos.getX(f + c), pos.getY(f + c), pos.getZ(f + c)], v * 3);
      normals[c].set([nor.getX(f + c), nor.getY(f + c), nor.getZ(f + c)], v * 3);
    }
  }
  for (let c = 0; c < 3; c++) {
    ng.setAttribute(`aP${c}`, new THREE.BufferAttribute(corners[c], 3));
    ng.setAttribute(`aN${c}`, new THREE.BufferAttribute(normals[c], 3));
  }
  return ng;
}

/** The terrain's vertex normals as a float texture on the height grid, for the exact ground normal. */
export function normalTexture(normals: THREE.BufferAttribute, w: number, h: number): THREE.DataTexture {
  const data = new Float32Array(w * h * 4);
  for (let k = 0; k < w * h; k++) data.set([normals.getX(k), normals.getY(k), normals.getZ(k), 0], k * 4);
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
