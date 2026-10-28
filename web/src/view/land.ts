import * as THREE from 'three';
import type { Battle } from '../sim-pkg/sim_wasm.js';
import { patchFog } from './fog';
import { HEIGHT_STEP, takeLand, type LandData } from './land-data';
import { gradientMap } from './toon';

// The land (docs/spec/03-land.md §4–§5, §10): the sim paints the ground and places the scatter; the view draws the
// painted texture on a height mesh over the map and 18 tiles of country past every edge.

/** Makes the land on this thread. */
export function makeLandInline(battle: Battle): LandData {
  const t0 = performance.now();
  const l = battle.land();
  return takeLand(l, performance.now() - t0, 'inline');
}

let worker: Worker | null = null;
let nextId = 0;

/** Makes the land in the land worker, which runs the same WASM and transfers the buffers back (03-land.md §10). */
export function makeLandInWorker(mapJson: string): Promise<LandData> {
  worker ??= new Worker(new URL('./land-worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = nextId++;
  return new Promise((ok, fail) => {
    const onMessage = (e: MessageEvent<{ id: number; land?: LandData; error?: string }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (e.data.land) ok(e.data.land);
      else fail(new Error(e.data.error ?? 'land worker failed'));
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, mapJson });
  });
}

/** The painted ground: 12 texels per tile, NearestFilter, no mipmaps; its colours pass through unconverted. */
export function groundTexture(land: LandData): THREE.DataTexture {
  const t = new THREE.DataTexture(land.rgba, land.ew * land.tex, land.eh * land.tex, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let groundMaterial: THREE.MeshToonMaterial | null = null;

/**
 * The terrain: a vertex per half-tile height sample over the extended grid, UV on the painted texture, under the
 * one toon ground material (made once; only its map changes per battle).
 */
export function terrainMesh(land: LandData, tex: THREE.Texture): THREE.Mesh {
  const hw = land.ew * 2 + 1;
  const hh = land.eh * 2 + 1;
  const pos = new Float32Array(hw * hh * 3);
  const uv = new Float32Array(hw * hh * 2);
  for (let j = 0; j < hh; j++) {
    for (let i = 0; i < hw; i++) {
      const k = j * hw + i;
      pos[k * 3] = i * HEIGHT_STEP - land.border;
      pos[k * 3 + 1] = land.heights[k];
      pos[k * 3 + 2] = j * HEIGHT_STEP - land.border;
      uv[k * 2] = (i * HEIGHT_STEP) / land.ew;
      uv[k * 2 + 1] = (j * HEIGHT_STEP) / land.eh;
    }
  }
  const index = new Uint32Array((hw - 1) * (hh - 1) * 6);
  let q = 0;
  for (let j = 0; j < hh - 1; j++) {
    for (let i = 0; i < hw - 1; i++) {
      const a = j * hw + i;
      const b = a + hw;
      const c = b + 1;
      const d = a + 1;
      index.set([a, b, d, b, c, d], q);
      q += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  groundMaterial ??= patchFog(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap }), { surface: 'ground' });
  groundMaterial.map = tex;
  const mesh = new THREE.Mesh(g, groundMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}
