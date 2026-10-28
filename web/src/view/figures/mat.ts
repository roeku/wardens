// Small column-major 4×4 helpers for posing. Every local op post-multiplies in place (o = o · op), so a joint
// chain reads in the order it is built. Float64 for the maths; the instance buffers take the result as float32.

export type M4 = Float64Array;

export function m4(): M4 {
  const o = new Float64Array(16);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

export function ident(o: M4): M4 {
  o.fill(0);
  o[0] = o[5] = o[10] = o[15] = 1;
  return o;
}

export function copy(o: M4, a: M4): M4 {
  o.set(a);
  return o;
}

const T = new Float64Array(16);
/** o = a · b (o may alias a or b). */
export function mul(o: M4, a: M4, b: M4): M4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    T[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    T[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    T[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    T[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  o.set(T);
  return o;
}

export function translate(o: M4, x: number, y: number, z: number): M4 {
  o[12] += o[0] * x + o[4] * y + o[8] * z;
  o[13] += o[1] * x + o[5] * y + o[9] * z;
  o[14] += o[2] * x + o[6] * y + o[10] * z;
  return o;
}

/** Rotation about local x: +y turns toward +z. */
export function rotX(o: M4, a: number): M4 {
  if (a === 0) return o;
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 3; r++) {
    const y = o[4 + r], z = o[8 + r];
    o[4 + r] = y * c + z * s;
    o[8 + r] = z * c - y * s;
  }
  return o;
}

/** Rotation about local y: +x turns toward −z. */
export function rotY(o: M4, a: number): M4 {
  if (a === 0) return o;
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 3; r++) {
    const x = o[r], z = o[8 + r];
    o[r] = x * c - z * s;
    o[8 + r] = x * s + z * c;
  }
  return o;
}

/** Rotation about local z: −y (down) turns toward +x (forward). A limb at angle a points (sin a, −cos a). */
export function rotZ(o: M4, a: number): M4 {
  if (a === 0) return o;
  const c = Math.cos(a), s = Math.sin(a);
  for (let r = 0; r < 3; r++) {
    const x = o[r], y = o[4 + r];
    o[r] = x * c + y * s;
    o[4 + r] = y * c - x * s;
  }
  return o;
}

export function scale(o: M4, x: number, y: number, z: number): M4 {
  for (let r = 0; r < 3; r++) {
    o[r] *= x;
    o[4 + r] *= y;
    o[8 + r] *= z;
  }
  return o;
}

/** Transforms the point (x, y, z) by m into out[0..2]. */
export function point(out: Float64Array | number[], m: M4, x: number, y: number, z: number): void {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/**
 * o = base · F, where F puts the origin at `from` (in base's frame) and turns local −y along `dir` (unit),
 * keeping local +z as close to `side` as it can. For limbs built hanging down −y and rods between two points.
 */
export function alongDown(o: M4, base: M4, from: ArrayLike<number>, dir: ArrayLike<number>, side: ArrayLike<number>): M4 {
  // y axis = −dir
  const yx = -dir[0], yy = -dir[1], yz = -dir[2];
  // x = y × side, normalised; z = x × y
  let xx = yy * side[2] - yz * side[1];
  let xy = yz * side[0] - yx * side[2];
  let xz = yx * side[1] - yy * side[0];
  let n = Math.hypot(xx, xy, xz);
  if (n < 1e-6) {
    // side is parallel to the limb: any perpendicular will do
    xx = yy; xy = -yx; xz = 0;
    n = Math.hypot(xx, xy, xz) || 1;
    if (Math.hypot(xx, xy) < 1e-6) { xx = 1; xy = 0; xz = 0; n = 1; }
  }
  xx /= n; xy /= n; xz /= n;
  const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
  const F = FR;
  F[0] = xx; F[1] = xy; F[2] = xz; F[3] = 0;
  F[4] = yx; F[5] = yy; F[6] = yz; F[7] = 0;
  F[8] = zx; F[9] = zy; F[10] = zz; F[11] = 0;
  F[12] = from[0]; F[13] = from[1]; F[14] = from[2]; F[15] = 1;
  return mul(o, base, F);
}
const FR = new Float64Array(16);

/**
 * o = base · F, where F has its origin at `at` and its x axis along `xAxis`; y is `yHint` made perpendicular to
 * x, and z = x × y. All in base's frame.
 */
export function frame(o: M4, base: M4, at: ArrayLike<number>, xAxis: ArrayLike<number>, yHint: ArrayLike<number>): M4 {
  let n = Math.hypot(xAxis[0], xAxis[1], xAxis[2]) || 1;
  const xx = xAxis[0] / n, xy = xAxis[1] / n, xz = xAxis[2] / n;
  const d = yHint[0] * xx + yHint[1] * xy + yHint[2] * xz;
  let yx = yHint[0] - d * xx, yy = yHint[1] - d * xy, yz = yHint[2] - d * xz;
  n = Math.hypot(yx, yy, yz) || 1;
  yx /= n; yy /= n; yz /= n;
  const F = FR;
  F[0] = xx; F[1] = xy; F[2] = xz; F[3] = 0;
  F[4] = yx; F[5] = yy; F[6] = yz; F[7] = 0;
  F[8] = xy * yz - xz * yy; F[9] = xz * yx - xx * yz; F[10] = xx * yy - xy * yx; F[11] = 0;
  F[12] = at[0]; F[13] = at[1]; F[14] = at[2]; F[15] = 1;
  return mul(o, base, F);
}

/** The x, y and z axes and origin of m (columns). */
export function axis(out: Float64Array | number[], m: M4, col: 0 | 1 | 2 | 3): void {
  out[0] = m[col * 4];
  out[1] = m[col * 4 + 1];
  out[2] = m[col * 4 + 2];
}
