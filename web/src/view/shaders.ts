// The two full-screen passes of docs/spec/02-look.md §1. three compiles ShaderMaterial as GLSL ES 3.00, so
// texelFetch reads exact art pixels.

export const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** The 4×4 Bayer matrix used everywhere: fog, marks, ground paint and night. */
export const BAYER = /* glsl */ `
const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
float bayer4(vec2 c) {
  ivec2 i = ivec2(mod(c, 4.0));
  return (float(BAYER[i.x + i.y * 4]) + 0.5) / 16.0;
}`;

export const MAX_LIGHTS = 48;

/**
 * Pass 2, once per art pixel: outlines drawn on the farther pixel and coloured from the nearer neighbour,
 * the night's moonlight and banded torch pools, and the pause grey. `uOrigin` is the camera's whole-art-pixel
 * position, so the night's dither stays fixed to the world while the view pans (DECISIONS.md D-06).
 */
export const CELL_FS = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uArt;
uniform vec2 uOrigin;
uniform float uRange;
uniform float uEdge;
uniform vec3 uInk;
uniform vec4 uLights[${MAX_LIGHTS}];
uniform int uLightN;
uniform float uNightK;
uniform float uGrey;
${BAYER}
vec3 tCol(vec2 c) { return texelFetch(tColor, ivec2(clamp(c, vec2(0.0), uArt - 1.0)), 0).rgb; }
float tDep(vec2 c) { return texelFetch(tDepth, ivec2(clamp(c, vec2(0.0), uArt - 1.0)), 0).r; }

void main() {
  vec2 c = floor(gl_FragCoord.xy);
  vec3 col = tCol(c);
  float d = tDep(c);
  float best = 0.0;
  vec3 near = col;
  vec2 offs[4] = vec2[4](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));
  for (int k = 0; k < 4; k++) {
    float dn = tDep(c + offs[k]);
    float gap = (min(d, 0.9999) - dn) * uRange;
    if (gap > uEdge && gap > best && d < 0.9999) { best = gap; near = tCol(c + offs[k]); }
  }
  if (best > 0.0) col = mix(near * 0.42, uInk, 0.25);

  if (uNightK > 0.0) {
    float lit = 0.0;
    for (int k = 0; k < ${MAX_LIGHTS}; k++) {
      if (k >= uLightN) break;
      vec4 L = uLights[k];
      vec2 dd = (c - L.xy) * vec2(1.0, 1.7);
      lit = max(lit, L.w * clamp((1.0 - length(dd) / L.z) * 1.3, 0.0, 1.0));
    }
    float q = clamp(floor(clamp(lit, 0.0, 1.0) * 3.0 + bayer4(c + uOrigin)) / 3.0, 0.0, 1.0);
    vec3 tint = mix(vec3(0.34, 0.40, 0.62), vec3(1.12, 0.92, 0.68), q);
    col = mix(col, col * tint + vec3(0.0, 0.004, 0.018) * (1.0 - q), uNightK);
  }

  if (uGrey > 0.0) {
    float l = dot(col, vec3(0.3, 0.55, 0.15));
    col = mix(col, vec3(l) * vec3(0.92, 0.90, 1.0), 0.55 * uGrey);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * Pass 3: scales the cell image up with nearest sampling. `uSub` adds back the camera's leftover fraction of
 * an art pixel, which keeps panning smooth while the art stays on its grid. The hurt captain's red vignette is
 * the only effect at screen resolution.
 */
export const POST_FS = /* glsl */ `
precision highp float;
uniform sampler2D tCell;
uniform vec2 uOut;
uniform vec2 uArt;
uniform vec2 uSub;
uniform float uScale;
uniform float uDanger;
varying vec2 vUv;

void main() {
  vec2 dev = vUv * uOut;
  vec2 a = dev / uScale + 1.0 + uSub;
  vec2 c = clamp(floor(a), vec2(0.0), uArt - 1.0);
  vec3 col = texelFetch(tCell, ivec2(c), 0).rgb;
  if (uDanger > 0.0) {
    float v = smoothstep(0.28, 0.72, length((vUv - 0.5) * vec2(1.0, 0.8)));
    col = mix(col, vec3(0.55, 0.05, 0.04), v * uDanger * 0.55);
  }
  gl_FragColor = vec4(col, 1.0);
}`;
