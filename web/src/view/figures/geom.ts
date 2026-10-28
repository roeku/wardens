import * as THREE from 'three';
import { rgb } from './palette';

// The procedural primitives of 02-look.md §5 — round, ball, rod, cone, shell, drape and strip — written into
// one merged geometry per body part. Every vertex is painted: `shade(k)` multiplies the instance's dye, a fixed
// hex ignores it (steel, wood). The paint is a vec4 `color` attribute: rgb, and alpha = how much dye applies.

export type Paint = readonly [number, number, number, number];
export const shade = (k: number): Paint => [k, k, k, 1];
export function fixed(hex: number): Paint {
  const [r, g, b] = rgb(hex);
  return [r, g, b, 0];
}

export type V3 = readonly [number, number, number];

/**
 * Accumulates triangles. `s` is the cloth parameter (0 at the attach line, 1 at the hem or fly), `axis` the
 * centreline point thin things are thickened about, `uv` the atlas coordinate.
 */
export class Builder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private cs: number[] = [];
  private ax: number[] = [];
  private uvs: number[] = [];
  private idx: number[] = [];
  paint: Paint = shade(1);
  /** Cloth parameter for the next vertices, as a function of the vertex position. */
  clothS: ((x: number, y: number, z: number) => number) | null = null;
  /** Centreline of the next vertices (thin parts); null = the vertex itself. */
  axisAt: ((x: number, y: number, z: number) => V3) | null = null;
  /** Local offset applied to every vertex written. */
  off: V3 = [0, 0, 0];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    x += this.off[0];
    y += this.off[1];
    z += this.off[2];
    const n = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / n, ny / n, nz / n);
    this.col.push(...this.paint);
    this.cs.push(this.clothS ? this.clothS(x, y, z) : 0);
    const a = this.axisAt ? this.axisAt(x, y, z) : ([x, y, z] as V3);
    this.ax.push(a[0], a[1], a[2]);
    this.uvs.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(this.cs, 1));
    g.setAttribute('aAxis', new THREE.Float32BufferAttribute(this.ax, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

export interface RoundOpts {
  /** Bottom and top radius. */
  r0: number;
  r1: number;
  /** From y0 to y0 + h along +y. */
  y0: number;
  h: number;
  seg?: number;
  /** Squeeze along x (front–back) and z (side to side). */
  sx?: number;
  sz?: number;
  /** Centre offset in x and z. */
  cx?: number;
  cz?: number;
  capTop?: boolean;
  capBottom?: boolean;
  /** Only part of the circle (radians, starting at +x and turning toward +z). */
  a0?: number;
  a1?: number;
}

/** `round`: a tapered, optionally squeezed cylinder along +y. Smooth sides, flat caps. */
export function round(b: Builder, o: RoundOpts): void {
  const seg = o.seg ?? 8;
  const sx = o.sx ?? 1, sz = o.sz ?? 1, cx = o.cx ?? 0, cz = o.cz ?? 0;
  const a0 = o.a0 ?? 0, a1 = o.a1 ?? Math.PI * 2;
  const full = o.a0 === undefined;
  const n = full ? seg : seg + 1;
  const slope = (o.r0 - o.r1) / o.h;
  const ring = (y: number, r: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      const c = Math.cos(a), s = Math.sin(a);
      out.push(b.vertex(cx + c * r * sx, y, cz + s * r * sz, c / sx, slope, s / sz));
    }
    return out;
  };
  const lo = ring(o.y0, o.r0);
  const hi = ring(o.y0 + o.h, o.r1);
  for (let i = 0; i < seg; i++) {
    const j = full ? (i + 1) % n : i + 1;
    b.quad(lo[i], hi[i], hi[j], lo[j]);
  }
  const cap = (y: number, r: number, up: boolean) => {
    const c = b.vertex(cx, y, cz, 0, up ? 1 : -1, 0);
    const rim: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      rim.push(b.vertex(cx + Math.cos(a) * r * sx, y, cz + Math.sin(a) * r * sz, 0, up ? 1 : -1, 0));
    }
    for (let i = 0; i < seg; i++) {
      const j = full ? (i + 1) % n : i + 1;
      if (up) b.tri(c, rim[j], rim[i]);
      else b.tri(c, rim[i], rim[j]);
    }
  };
  if (o.capTop) cap(o.y0 + o.h, o.r1, true);
  if (o.capBottom) cap(o.y0, o.r0, false);
}

export interface BallOpts {
  c: V3;
  r: V3;
  seg?: number;
  rings?: number;
  /** Latitude range in radians, −π/2 (bottom) to π/2 (top): a `shell` is a ball cut short. */
  lat0?: number;
  lat1?: number;
  /** Turn the normals inward (the inside of a shell). */
  inside?: boolean;
}

/** `ball`: an ellipsoid; with a latitude range it is a `shell` (a helmet dome, a hood). */
export function ball(b: Builder, o: BallOpts): void {
  const seg = o.seg ?? 8;
  const rings = o.rings ?? 5;
  const lat0 = o.lat0 ?? -Math.PI / 2, lat1 = o.lat1 ?? Math.PI / 2;
  const [cx, cy, cz] = o.c;
  const [rx, ry, rz] = o.r;
  const k = o.inside ? -1 : 1;
  const grid: number[][] = [];
  for (let j = 0; j <= rings; j++) {
    const lat = lat0 + ((lat1 - lat0) * j) / rings;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    const row: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (Math.PI * 2 * i) / seg;
      const x = Math.cos(a) * cl, z = Math.sin(a) * cl;
      row.push(b.vertex(cx + x * rx, cy + sl * ry, cz + z * rz, (k * x) / rx, (k * sl) / ry, (k * z) / rz));
    }
    grid.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const i2 = (i + 1) % seg;
      if (o.inside) b.quad(grid[j][i], grid[j][i2], grid[j + 1][i2], grid[j + 1][i]);
      else b.quad(grid[j][i], grid[j + 1][i], grid[j + 1][i2], grid[j][i2]);
    }
  }
}

/** `shell`: the outer and inner faces of a dome, so it reads from below as well (brims, hoods). */
export function shell(b: Builder, o: BallOpts, innerShade?: Paint): void {
  ball(b, o);
  const keep = b.paint;
  if (innerShade) b.paint = innerShade;
  ball(b, { ...o, r: [o.r[0] * 0.97, o.r[1] * 0.97, o.r[2] * 0.97], inside: true });
  b.paint = keep;
}

/** `rod`: a cylinder from a to b with radius r (r2 at b). */
export function rod(b: Builder, a: V3, c: V3, r: number, seg = 6, r2 = r, caps = true): void {
  const d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const ux = d[0] / len, uy = d[1] / len, uz = d[2] / len;
  // two perpendiculars
  let px = -uz, py = 0, pz = ux;
  if (Math.hypot(px, pz) < 1e-6) {
    px = 1;
    py = 0;
    pz = 0;
  }
  const pn = Math.hypot(px, py, pz);
  px /= pn; py /= pn; pz /= pn;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  const keepAxis = b.axisAt;
  if (!keepAxis) {
    // thin things thicken about their own centreline
    b.axisAt = (x, y, z) => {
      const t = Math.max(0, Math.min(len, (x - a[0] - b.off[0]) * ux + (y - a[1] - b.off[1]) * uy + (z - a[2] - b.off[2]) * uz));
      return [a[0] + b.off[0] + ux * t, a[1] + b.off[1] + uy * t, a[2] + b.off[2] + uz * t];
    };
  }
  const ring = (o: V3, rr: number) => {
    const out: number[] = [];
    for (let i = 0; i < seg; i++) {
      const t = (Math.PI * 2 * i) / seg;
      const cx = Math.cos(t), sx = Math.sin(t);
      const nx = px * cx + qx * sx, ny = py * cx + qy * sx, nz = pz * cx + qz * sx;
      out.push(b.vertex(o[0] + nx * rr, o[1] + ny * rr, o[2] + nz * rr, nx, ny, nz));
    }
    return out;
  };
  const lo = ring(a, r);
  const hi = ring(c, r2);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    b.quad(lo[i], lo[j], hi[j], hi[i]);
  }
  if (caps) {
    const ca = b.vertex(a[0], a[1], a[2], -ux, -uy, -uz);
    const cb = b.vertex(c[0], c[1], c[2], ux, uy, uz);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      b.tri(ca, lo[j], lo[i]);
      b.tri(cb, hi[i], hi[j]);
    }
  }
  b.axisAt = keepAxis;
}

/** `cone`: from a base circle at `a` (radius r) to the tip `c`. */
export function cone(b: Builder, a: V3, c: V3, r: number, seg = 6): void {
  rod(b, a, c, r, seg, 0.0001, true);
}

export interface DrapeOpts {
  /** Radius at the top and at the hem, behind the body. */
  rTop: number;
  rHem: number;
  /** Length down from y = 0. */
  len: number;
  /** Angle span round the back (radians), centred on −x. */
  span: number;
  folds: number;
  /** Fold depth at the hem. */
  depth: number;
  seg?: number;
  rows?: number;
  sx?: number;
  lining: Paint;
  hem?: Paint;
  hemFrom?: number;
}

/**
 * `drape`: cloth hanging from y = 0 down to −len, round the back of the body (−x), with folds deepening toward
 * the hem and a lining on the inside. The cloth parameter s runs 0 at the top to 1 at the hem.
 */
export function drape(b: Builder, o: DrapeOpts): void {
  const seg = o.seg ?? 14;
  const rows = o.rows ?? 6;
  const sx = o.sx ?? 1;
  const keepS = b.clothS;
  const keepPaint = b.paint;
  b.clothS = (_x, y) => Math.max(0, Math.min(1, -(y - b.off[1]) / o.len));
  const at = (i: number, j: number, inner: boolean) => {
    const s = j / rows;
    const a = Math.PI - o.span / 2 + (o.span * i) / seg;
    const fold = o.depth * s * Math.sin(((o.folds * 2 * Math.PI) * i) / seg) * Math.sin((Math.PI * i) / seg);
    const r = o.rTop + (o.rHem - o.rTop) * s + fold - (inner ? 0.006 : 0);
    const x = Math.cos(a) * r * sx, z = Math.sin(a) * r;
    // normal: outward from the axis, tilted by the flare
    const nx = Math.cos(a) / sx, nz = Math.sin(a), ny = -(o.rHem - o.rTop) / o.len;
    return { x, y: -s * o.len, z, nx: inner ? -nx : nx, ny: inner ? -ny : ny, nz: inner ? -nz : nz };
  };
  for (const inner of [false, true]) {
    const grid: number[][] = [];
    for (let j = 0; j <= rows; j++) {
      const s = j / rows;
      if (inner) b.paint = o.lining;
      else b.paint = o.hem && s >= (o.hemFrom ?? 0.86) ? o.hem : keepPaint;
      const row: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const p = at(i, j, inner);
        row.push(b.vertex(p.x, p.y, p.z, p.nx, p.ny, p.nz));
      }
      grid.push(row);
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < seg; i++) {
        if (inner) b.quad(grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]);
        else b.quad(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
      }
    }
  }
  b.paint = keepPaint;
  b.clothS = keepS;
}

/**
 * `strip`: a flat two-sided band in the x–y plane at z = 0, from y = 0 down to −len, `w` wide (centred on x0).
 * Used for flags, pennants, ribbons and the banner cloth; s (and v) run 0 at the top to 1 at the bottom.
 */
export function strip(b: Builder, len: number, w: number, rows = 6, cols = 1, x0 = 0, twoSided = true): void {
  const keepS = b.clothS;
  b.clothS = (_x, y) => Math.max(0, Math.min(1, -(y - b.off[1]) / len));
  for (const back of twoSided ? [false, true] : [false]) {
    const grid: number[][] = [];
    for (let j = 0; j <= rows; j++) {
      const row: number[] = [];
      for (let i = 0; i <= cols; i++) {
        const u = i / cols, v = j / rows;
        row.push(b.vertex(x0 - w / 2 + w * u, -v * len, back ? -0.0005 : 0.0005, 0, 0, back ? -1 : 1, u, 1 - v));
      }
      grid.push(row);
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (back) b.quad(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
        else b.quad(grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]);
      }
    }
  }
  b.clothS = keepS;
}

/** An extruded flat outline in the y–z plane (x is the thickness, front face toward +x). */
export function slab(b: Builder, shape: readonly (readonly [number, number])[], x0: number, x1: number, front = true): void {
  const n = shape.length;
  const area = shape.reduce((acc, [y, z], k) => acc + y * shape[(k + 1) % n][1] - shape[(k + 1) % n][0] * z, 0);
  const outline = area < 0 ? [...shape].reverse() : shape;
  // centroid for a fan
  let cy = 0, cz = 0;
  for (const [y, z] of outline) {
    cy += y / n;
    cz += z / n;
  }
  const face = (x: number, nx: number) => {
    const c = b.vertex(x, cy, cz, nx, 0, 0);
    const rim = outline.map(([y, z]) => b.vertex(x, y, z, nx, 0, 0));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (nx > 0) b.tri(c, rim[i], rim[j]);
      else b.tri(c, rim[j], rim[i]);
    }
  };
  if (front) face(x1, 1);
  face(x0, -1);
  for (let i = 0; i < n; i++) {
    const [ya, za] = outline[i];
    const [yb, zb] = outline[(i + 1) % n];
    // outward normal in the y–z plane (the outline runs counter-clockwise)
    const ny = zb - za, nz = -(yb - ya);
    const a0 = b.vertex(x0, ya, za, 0, ny, nz);
    const a1 = b.vertex(x1, ya, za, 0, ny, nz);
    const b1 = b.vertex(x1, yb, zb, 0, ny, nz);
    const b0 = b.vertex(x0, yb, zb, 0, ny, nz);
    b.quad(a0, b0, b1, a1);
  }
}

/**
 * `tube`: a tapering limb along a polyline (horns, antlers, tails, crooked poles), radius r0 at the first point to
 * r1 at the last, with a ball at each bend so it doesn't split; `tip` ends it in a point.
 */
export function tube(b: Builder, pts: readonly V3[], r0: number, r1: number, seg = 5, tip = false): void {
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const ra = r0 + ((r1 - r0) * i) / n;
    const rb = r0 + ((r1 - r0) * (i + 1)) / n;
    if (tip && i === n - 1) cone(b, pts[i], pts[i + 1], ra, seg);
    else rod(b, pts[i], pts[i + 1], ra, seg, rb, i === 0);
    if (i > 0) {
      const keep = b.axisAt;
      const c = pts[i];
      if (!keep) b.axisAt = () => c;
      ball(b, { c, r: [ra, ra, ra], seg, rings: 2 });
      b.axisAt = keep;
    }
  }
}

/**
 * `rags`: a ragged skirt of hide strips round the hips, hanging from y0 (radius r0) with each strip its own
 * length (`lens`, one per strip round from the front), flaring to r1; the inside in `inner`.
 */
export function rags(b: Builder, o: { r0: number; r1: number; y0: number; lens: readonly number[]; sx?: number; inner: Paint }): void {
  const n = o.lens.length;
  const sx = o.sx ?? 1;
  const keep = b.paint;
  for (const inside of [false, true]) {
    b.paint = inside ? o.inner : keep;
    for (let i = 0; i < n; i++) {
      const a0 = (Math.PI * 2 * i) / n, a1 = (Math.PI * 2 * (i + 1)) / n;
      const len = o.lens[i];
      const flare = o.r0 + (o.r1 - o.r0) * Math.min(1, len / 0.1);
      const p = (a: number, r: number, y: number) => {
        const c = Math.cos(a), s = Math.sin(a), k = inside ? -1 : 1;
        return b.vertex(c * r * sx, y, s * r, (k * c) / sx, 0.2 * k, k * s);
      };
      const t0 = p(a0, o.r0, o.y0), t1 = p(a1, o.r0, o.y0);
      const b0 = p(a0, flare, o.y0 - len), b1 = p(a1, flare, o.y0 - len);
      // `round`'s winding (bottom i, top i, top j, bottom j) faces out
      if (inside) b.quad(t0, b0, b1, t1);
      else b.quad(b0, t0, t1, b1);
    }
  }
  b.paint = keep;
}
