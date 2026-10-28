import * as THREE from 'three';

/** The 4-step toon ramp every solid shares (02-look.md §3). */
export const RAMP = [96, 150, 205, 255];

export const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array(RAMP), RAMP.length, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

/** A toon material on the shared ramp. Materials are made once and never disposed (01-flow.md §8). */
export function toon(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap });
}
