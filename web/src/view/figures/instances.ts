import * as THREE from 'three';
import type { M4 } from './mat';
import { figureDepthMaterial, figureMaterial } from './material';
import { PARTS, partGeometry, type PartDef, type PartId } from './parts';

// docs/spec/02-look.md §5 "Approach" and "Performance": ONE InstancedMesh per part, shared by every figure.
// Parts are created lazily on first use; their buffers grow by doubling; each frame only the instance ranges
// whose values actually changed are uploaded.

const START = 32;

class Attr {
  data: Float32Array;
  lo = Infinity;
  hi = -1;
  constructor(public attr: THREE.InstancedBufferAttribute) {
    this.data = attr.array as Float32Array;
  }
  /** Writes `n` floats at instance `i`, remembering the changed range. */
  write(i: number, src: ArrayLike<number>, n: number, off = 0): void {
    const d = this.data;
    const o = i * n;
    let changed = false;
    for (let k = 0; k < n; k++) {
      const v = src[off + k];
      if (d[o + k] !== Math.fround(v)) {
        d[o + k] = v;
        changed = true;
      }
    }
    if (changed) {
      if (i < this.lo) this.lo = i;
      if (i > this.hi) this.hi = i;
    }
  }
  flush(): void {
    if (this.hi < this.lo) return;
    const n = this.attr.itemSize;
    this.attr.clearUpdateRanges();
    this.attr.addUpdateRange(this.lo * n, (this.hi - this.lo + 1) * n);
    this.attr.needsUpdate = true;
    this.lo = Infinity;
    this.hi = -1;
  }
}

class PartMesh {
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.BufferGeometry;
  cap = START;
  n = 0;
  matrix: Attr;
  color: Attr;
  extra: Attr;
  root: Attr;
  tile: Attr | null = null;

  constructor(readonly id: PartId, def: PartDef, atlas: THREE.Texture | undefined, receiveShadow: boolean) {
    // each part owns its geometry (it carries the per-instance attributes)
    this.geometry = partGeometry(id).clone();
    const opts = { cloth: def.cloth, thin: !!def.thin, atlas, glow: !!def.glow, flame: !!def.flame };
    const mat = figureMaterial(opts);
    this.mesh = new THREE.InstancedMesh(this.geometry, mat, this.cap);
    this.mesh.name = `fig:${id}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = def.shadow !== false;
    this.mesh.receiveShadow = receiveShadow;
    this.mesh.customDepthMaterial = figureDepthMaterial(opts);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.matrix = new Attr(this.mesh.instanceMatrix);
    this.color = new Attr(this.mesh.instanceColor);
    this.extra = new Attr(this.addAttr('aExtra', 4));
    this.root = new Attr(this.addAttr('aRoot', 3));
    if (atlas) this.tile = new Attr(this.addAttr('aTile', 4));
    this.mesh.count = 0;
  }

  private addAttr(name: string, size: number, from?: Float32Array): THREE.InstancedBufferAttribute {
    const data = new Float32Array(this.cap * size);
    if (from) data.set(from.subarray(0, Math.min(from.length, data.length)));
    const a = new THREE.InstancedBufferAttribute(data, size);
    a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute(name, a);
    return a;
  }

  /** Doubles every buffer, keeping what is written. */
  grow(): void {
    this.cap *= 2;
    const remake = (a: Attr, size: number, set: (b: THREE.InstancedBufferAttribute) => void) => {
      const data = new Float32Array(this.cap * size);
      data.set(a.data);
      const b = new THREE.InstancedBufferAttribute(data, size);
      b.setUsage(THREE.DynamicDrawUsage);
      set(b);
      const fresh = new Attr(b);
      fresh.lo = 0;
      fresh.hi = this.cap - 1;
      return fresh;
    };
    this.matrix = remake(this.matrix, 16, (b) => (this.mesh.instanceMatrix = b));
    this.color = remake(this.color, 3, (b) => (this.mesh.instanceColor = b));
    this.extra = remake(this.extra, 4, (b) => this.geometry.setAttribute('aExtra', b));
    this.root = remake(this.root, 3, (b) => this.geometry.setAttribute('aRoot', b));
    if (this.tile) this.tile = remake(this.tile, 4, (b) => this.geometry.setAttribute('aTile', b));
  }
}

const m32 = new Float32Array(16);

/**
 * Collects one frame of part instances. `begin()`, then `add()` per part per figure, then `end()`. Instance
 * order is the order of `add()` calls, so a stable record order keeps uploads small.
 */
export class PartPool {
  readonly group = new THREE.Group();
  private readonly parts = new Map<PartId, PartMesh>();
  private readonly ex = [1, 0, 0, 0];

  constructor(private readonly atlases: { banner: THREE.Texture; bannerFar: THREE.Texture; shield: THREE.Texture }, private readonly receiveShadow = false) {
    this.group.name = 'figures';
  }

  private part(id: PartId): PartMesh {
    let p = this.parts.get(id);
    if (!p) {
      const def = PARTS[id] as PartDef;
      p = new PartMesh(id, def, def.atlas ? this.atlases[def.atlas] : undefined, this.receiveShadow);
      this.parts.set(id, p);
      this.group.add(p.mesh);
    }
    return p;
  }

  begin(): void {
    for (const p of this.parts.values()) p.n = 0;
  }

  /**
   * One instance: its matrix relative to the figure's root, the root's snapped world position, the dye (0..1
   * rgb; white for fixed-colour parts), the extra vec4 (cloth: wind, phase, length; thin: swell factor) and, for
   * atlas cards, the tile.
   */
  add(id: PartId, m: M4, root: ArrayLike<number>, r: number, g: number, b: number, e0 = 1, e1 = 0, e2 = 0, e3 = 0, tile?: ArrayLike<number>): void {
    const p = this.part(id);
    if (p.n >= p.cap) p.grow();
    const i = p.n++;
    for (let k = 0; k < 16; k++) m32[k] = m[k];
    p.matrix.write(i, m32, 16);
    this.ex[0] = r;
    this.ex[1] = g;
    this.ex[2] = b;
    p.color.write(i, this.ex, 3);
    this.ex[0] = e0;
    this.ex[1] = e1;
    this.ex[2] = e2;
    this.ex[3] = e3;
    p.extra.write(i, this.ex, 4);
    p.root.write(i, root, 3);
    if (p.tile && tile) p.tile.write(i, tile, 4);
  }

  end(): void {
    for (const p of this.parts.values()) {
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;
      p.matrix.flush();
      p.color.flush();
      p.extra.flush();
      p.root.flush();
      p.tile?.flush();
    }
  }

  /** Counts for the lab: parts made, instances drawn, triangles drawn. */
  stats(): { parts: number; instances: number; triangles: number } {
    let instances = 0;
    let triangles = 0;
    for (const p of this.parts.values()) {
      instances += p.n;
      triangles += p.n * ((p.geometry.index?.count ?? 0) / 3);
    }
    return { parts: this.parts.size, instances, triangles };
  }
}
