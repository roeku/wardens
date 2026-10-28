import * as THREE from 'three';
import { toon } from './toon';

/** Heights are sampled every half tile (03-land.md §1). */
export const HEIGHT_STEP = 0.5;
/** Day 1: the land is one flat grass colour; the painted ground comes on day 2 (03-land.md §4–§5). */
const GRASS = 0x5d8a33;

export interface LandData {
  w: number;
  h: number;
  /** `(2w+1) × (2h+1)` samples, row-major from the north. */
  heights: Float32Array;
}

/** Bilinear height at sim (x, y), as the sim reads it. */
export function heightAt(land: LandData, x: number, y: number): number {
  const hw = land.w * 2 + 1;
  const hh = land.h * 2 + 1;
  const u = Math.max(0, Math.min(hw - 1, x / HEIGHT_STEP));
  const v = Math.max(0, Math.min(hh - 1, y / HEIGHT_STEP));
  const i = Math.min(Math.floor(u), hw - 2);
  const j = Math.min(Math.floor(v), hh - 2);
  const tx = u - i;
  const ty = v - j;
  const at = (i: number, j: number) => land.heights[j * hw + i];
  const top = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
  const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
  return top + (bottom - top) * ty;
}

/** The terrain: a plane with a vertex per height sample, rotated flat so world z = sim y. */
export function terrainMesh(land: LandData): THREE.Mesh {
  const g = new THREE.PlaneGeometry(land.w, land.h, land.w * 2, land.h * 2);
  g.rotateX(-Math.PI / 2);
  g.translate(land.w / 2, 0, land.h / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < pos.count; k++) pos.setY(k, land.heights[k]);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, toon(GRASS));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
