import * as THREE from 'three';
import { faceGeometry } from '../exact';
import { patchFog } from '../fog';
import { gradientMap } from '../toon';

// The construction primitives of docs/spec/03-land.md §7 "Construction": box, roof (a gabled prism), pyramid, cone,
// cyl, frustum and a crenellated ring, each painted with its colour into its vertices. A `Kit` gathers the pieces of
// one building into two merged meshes: the body, drawn with one toon vertex-colour material, and the owned parts
// (roofs, caps, cloth), painted white and drawn with a material whose colour is the holder's. Every merged mesh is
// a `faceGeometry` drawn through the fog patch's exact faces, so it holds still to the pixel while the view pans.

/** Local axes: x east, y up, z south (= sim y); 1 unit = 1 tile. */
export interface At {
  x: number;
  y: number;
  z: number;
  /** Turn about the up axis, radians (clockwise seen from above, as the sim's facing). */
  turn?: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** A geometry's triangles, non-indexed, with one colour on every vertex. */
interface Piece {
  pos: number[];
  nor: number[];
  col: number[];
}

function piece(g: THREE.BufferGeometry, m: THREE.Matrix4, color: number): Piece {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.applyMatrix4(m);
  if (!ng.attributes.normal) ng.computeVertexNormals();
  const pos = Array.from(ng.attributes.position.array as Float32Array);
  const nor = Array.from(ng.attributes.normal.array as Float32Array);
  const c = new THREE.Color(color);
  const col: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) col.push(c.r, c.g, c.b);
  return { pos, nor, col };
}

function matrix(at: At, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(UP, -(at.turn ?? 0));
  return tmpM.compose(new THREE.Vector3(at.x, at.y, at.z), tmpQ, new THREE.Vector3(sx, sy, sz)).clone();
}

/** A gabled prism over a `w × d` rectangle, `h` high, its ridge along x (or z); base at y = 0, centred. */
function prism(w: number, d: number, h: number, alongZ: boolean): THREE.BufferGeometry {
  const [a, b] = alongZ ? [d / 2, w / 2] : [w / 2, d / 2];
  // In ridge-along-x terms: ends at x = ±a, eaves at z = ±b.
  const v = (x: number, y: number, z: number) => (alongZ ? [z, y, x] : [x, y, z]);
  const tri = (p: number[][]) => p.flat();
  const e0 = v(-a, 0, -b), e1 = v(a, 0, -b), e2 = v(a, 0, b), e3 = v(-a, 0, b);
  const r0 = v(-a, h, 0), r1 = v(a, h, 0);
  const quads = [
    [e0, r0, r1], [e0, r1, e1], // the north slope
    [e3, e2, r1], [e3, r1, r0], // the south slope
    [e0, e3, r0], // the west gable
    [e1, r1, e2], // the east gable
    [e0, e1, e2], [e0, e2, e3], // the underside
  ];
  const pos = new Float32Array(quads.flatMap((q) => tri(q)));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // A ridge along z mirrors the winding: flip it back so the faces look outward.
  if (alongZ) {
    const p = g.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) [p[i + 3 + k], p[i + 6 + k]] = [p[i + 6 + k], p[i + 3 + k]];
    }
    g.computeVertexNormals();
  }
  return g;
}

/** Turns a smooth geometry flat-shaded (every face its own normal), for crisp toon steps on stone and timber. */
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('normal');
  ng.computeVertexNormals();
  return ng;
}

export class Kit {
  private readonly body: Piece[] = [];
  private readonly owned: Piece[] = [];

  private add(g: THREE.BufferGeometry, m: THREE.Matrix4, color: number, owned: boolean): void {
    (owned ? this.owned : this.body).push(piece(g, m, owned ? 0xffffff : color));
  }

  /** A box `w × h × d` standing on `at` (its base at at.y). */
  box(w: number, h: number, d: number, at: At, color: number, owned = false): this {
    this.add(new THREE.BoxGeometry(w, h, d), matrix({ ...at, y: at.y + h / 2 }), color, owned);
    return this;
  }

  /** A box tilted about its own long (x) axis by `tilt` and about z by `roll` (beams, braces, fallen timbers). */
  beam(w: number, h: number, d: number, at: At, tiltZ: number, color: number, tiltX = 0): this {
    const m = matrix({ ...at, y: at.y + h / 2 }).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tiltX, 0, tiltZ)));
    this.add(new THREE.BoxGeometry(w, h, d), m, color, false);
    return this;
  }

  /** `roof(w, d, h)`: a gabled prism, its ridge along x (or z with `alongZ`), eaves at at.y. */
  roof(w: number, d: number, h: number, at: At, color: number, owned = false, alongZ = false): this {
    this.add(prism(w, d, h, alongZ), matrix(at), color, owned);
    return this;
  }

  /** A four-sided pyramid `w` across, `h` high. */
  pyramid(w: number, h: number, at: At, color: number, owned = false): this {
    const g = flat(new THREE.ConeGeometry(w / Math.SQRT2, h, 4, 1));
    g.rotateY(Math.PI / 4);
    this.add(g, matrix({ ...at, y: at.y + h / 2 }), color, owned);
    return this;
  }

  cone(r: number, h: number, at: At, color: number, owned = false, segs = 8): this {
    this.add(flat(new THREE.ConeGeometry(r, h, segs, 1)), matrix({ ...at, y: at.y + h / 2 }), color, owned);
    return this;
  }

  cyl(r: number, h: number, at: At, color: number, segs = 8, owned = false): this {
    this.add(flat(new THREE.CylinderGeometry(r, r, h, segs, 1)), matrix({ ...at, y: at.y + h / 2 }), color, owned);
    return this;
  }

  frustum(r0: number, r1: number, h: number, at: At, color: number, segs = 8): this {
    this.add(flat(new THREE.CylinderGeometry(r1, r0, h, segs, 1)), matrix({ ...at, y: at.y + h / 2 }), color, false);
    return this;
  }

  /** Merlons along a wall from (x0, z0) to (x1, z1) on top of it at height y: teeth `t` wide, `t` apart. */
  merlons(x0: number, z0: number, x1: number, z1: number, y: number, thick: number, t: number, color: number): this {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.floor(len / (2 * t)));
    const turn = Math.atan2(z1 - z0, x1 - x0);
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      this.box(t, t * 0.9, thick, { x: x0 + (x1 - x0) * k, y, z: z0 + (z1 - z0) * k, turn }, color);
    }
    return this;
  }

  /** The merged body and owned geometries (null where there are no pieces). */
  build(): { body: THREE.BufferGeometry | null; owned: THREE.BufferGeometry | null } {
    return { body: merge(this.body), owned: merge(this.owned) };
  }
}

function merge(pieces: Piece[]): THREE.BufferGeometry | null {
  if (pieces.length === 0) return null;
  const pos = new Float32Array(pieces.reduce((n, p) => n + p.pos.length, 0));
  const nor = new Float32Array(pos.length);
  const col = new Float32Array(pos.length);
  let o = 0;
  for (const p of pieces) {
    pos.set(p.pos, o);
    nor.set(p.nor, o);
    col.set(p.col, o);
    o += p.pos.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return faceGeometry(g);
}

// ------------------------------------------------------------------------------------------------- materials

/** The shared body material: toon on the ramp, colours from the vertices, through the fog's exact faces. */
let bodyMat: THREE.MeshToonMaterial | null = null;
export function bodyMaterial(): THREE.MeshToonMaterial {
  bodyMat ??= patchFog(new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap }), { surface: 'face' });
  return bodyMat;
}

/** A body material of its own (a house's walls, tinted as it burns): vertex colours times `color`. */
export function tintedMaterial(): THREE.MeshToonMaterial {
  return patchFog(new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap }), { surface: 'face' });
}

/** The owned parts' uniforms: the band's colour and how far the band takes it (0: the spec's ×0.8 shingles). */
export interface Shingle {
  uBand: { value: THREE.Color };
  uBandK: { value: number };
}

/**
 * An owned material (03-land.md §7 "The owned mesh"): its colour is the holder's; sloped faces get ×0.8 bands where
 * `fract(worldY·8) < .28`. The blight's places are corrupted: the bands glow ember instead (`uBandK` 1).
 */
export function ownedMaterial(): { mat: THREE.MeshToonMaterial; shingle: Shingle } {
  const mat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap });
  patchFog(mat, { surface: 'face' });
  const shingle: Shingle = { uBand: { value: new THREE.Color(0xc84a1c) }, uBandK: { value: 0 } };
  const fogCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    fogCompile.call(mat, shader, r);
    Object.assign(shader.uniforms, shingle);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uBand;\nuniform float uBandK;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float slope = abs(exactN.y);
  if (slope > 0.12 && slope < 0.97 && fract(exactP.y * 8.0) < 0.28) {
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.8, uBand, uBandK);
  }
}`,
      );
  };
  mat.customProgramCacheKey = () => 'places-owned';
  return { mat, shingle };
}

/** An unlit material for flames and embers' boxes, through the fog's exact faces (instance colours). */
let flameMat: THREE.MeshBasicMaterial | null = null;
export function flameMaterial(): THREE.MeshBasicMaterial {
  flameMat ??= patchFog(new THREE.MeshBasicMaterial({ color: 0xffffff }), { surface: 'face' });
  return flameMat;
}

/** A merged mesh for a kit's geometry, casting and receiving shadows. */
export function mesh(g: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = name;
  return m;
}

/** A unit box as an exact-face geometry, for pieces moved one by one (flags, works). */
let unitBox: THREE.BufferGeometry | null = null;
export function boxGeometry(): THREE.BufferGeometry {
  unitBox ??= faceGeometry(new THREE.BoxGeometry(1, 1, 1));
  return unitBox;
}
