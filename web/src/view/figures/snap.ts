// docs/spec/02-look.md §2 "Figures are snapped too": round each figure's position to the art-pixel grid along the
// screen axes, across = (x+z)·√½ and up = (x−z)·√½·0.5 + h·(√3/2), and slide along the ground (keeping h) to
// get there, so the feet stay planted and a standing figure is drawn the same picture a whole pixel over.

const R = Math.SQRT1_2;
const COS_PITCH = Math.sqrt(3) / 2;

export interface Snapped {
  /** World x (east), y (up = the ground height kept), z (south = sim y). */
  x: number;
  y: number;
  z: number;
  /** The snapped screen position in whole art pixels from the world origin. */
  px: number;
  py: number;
}

/** Snaps sim position (x, y) at ground height h for zoom s (art px per tile). */
export function snapFigure(x: number, y: number, h: number, s: number, out: Snapped): Snapped {
  const across = (x + y) * R;
  const up = (x - y) * R * 0.5 + h * COS_PITCH;
  const pa = Math.round(across * s);
  const pu = Math.round(up * s);
  const sum = pa / s / R; // x + z
  const diff = (pu / s - h * COS_PITCH) / (R * 0.5); // x − z
  out.x = (sum + diff) / 2;
  out.z = (sum - diff) / 2;
  out.y = h;
  out.px = pa;
  out.py = pu;
  return out;
}
