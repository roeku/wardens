import { BACK, FAR, NEAR, VIEW } from '../view/camera';
import { figureShaderHooks } from '../view/figures';
import { FOG, FOG_COLOUR_FRAGMENT } from '../view/fog';

// The fog of war on the figures (02-look.md §3, DECISIONS.md D-08 "Open"): every figure part's final colour goes
// through the same three dithered levels and the haze past the map's edge as the land, read at the figure's root
// so a man is never split across two levels. Enemies and the dead outside sight are not drawn at all; that is
// decided per figure on the CPU (records.ts), so this only tints what is drawn, e.g. our men stepping into ground
// seen before, and a company leaving the map into the haze.
//
// The figures' instance matrices are relative to their snapped root (`aRoot`, out/decisions-figures.md "Exact
// clip"), and the hook leaves their clip x and y alone: it adds one flat varying and the colour step, and gives
// each vertex its exact depth, as the land's fragments have (out/decisions-land.md "Pixel-stable land"). The camera
// stands on a fixed plane, so a world point's depth is (p·VIEW + BACK − NEAR)/(FAR − NEAR) in every frame; through
// the camera's matrices it wobbled in its last bits as the view panned, and where a foot or a hoof meets a slope the
// land and the figure then took turns at a pixel.

const f8 = (v: number) => v.toFixed(8);
const EXACT_DEPTH = /* glsl */ `
if (uPix.x > 0.0) {
  vec3 depthP = (modelMatrix * vec4(relP.xyz + aRoot, 1.0)).xyz;
  float depth = (dot(depthP, vec3(${f8(VIEW.x)}, ${f8(VIEW.y)}, ${f8(VIEW.z)})) + ${(BACK - NEAR).toFixed(1)}) / ${(FAR - NEAR).toFixed(1)};
  gl_Position.z = (2.0 * depth - 1.0) * gl_Position.w;
}`;

let installed = false;

export function installFigureFog(): void {
  if (installed) return;
  installed = true;
  figureShaderHooks.push((shader) => {
    Object.assign(shader.uniforms, { uFogTex: FOG.uFogTex, uMapSize: FOG.uMapSize, uHaze: FOG.uHaze });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nflat varying vec2 vFogRoot;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>\nvFogRoot = aRoot.xz;\n${EXACT_DEPTH}`);
    shader.fragmentShader = shader.fragmentShader
      // uOrigin is the figures' own uniform (the camera's whole-pixel position), declared again for the fragment
      .replace('#include <common>', `#include <common>\nflat varying vec2 vFogRoot;\nuniform vec2 uOrigin;\n${FOG_COLOUR_FRAGMENT}`)
      .replace('#include <dithering_fragment>', 'gl_FragColor.rgb = fogApply(gl_FragColor.rgb, vFogRoot);\n#include <dithering_fragment>');
  });
}
