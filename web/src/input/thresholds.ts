// docs/spec/01-flow.md §2 "Thresholds" (`touchish = pointerType !== 'mouse'`), in CSS pixels, and the gesture
// constants of "Pointer state machine" and "Strokes". Every number here is the spec's.

export interface Thresholds {
  /** Movement before a press becomes a stroke or drag. */
  slop: number;
  /** A press on a company or the captain that never strays further than this is a tap, however much it slid. */
  tapRadius: number;
  /** Hit distance to your own company. */
  companyReach: number;
  /** Hit distance to the captain; ×1.3 while a company is selected. */
  kingReach: number;
  /** Hit distance to enemies and order flags. */
  reach: number;
}

export const TOUCH: Thresholds = { slop: 12, tapRadius: 26, companyReach: 24, kingReach: 36, reach: 34 };
export const MOUSE: Thresholds = { slop: 7, tapRadius: 14, companyReach: 14, kingReach: 24, reach: 20 };

export const thresholds = (touchish: boolean): Thresholds => (touchish ? TOUCH : MOUSE);

/** An unused selection deselects itself after this, blinking for its last BLINK_S. */
export const LAPSE_S = 7;
export const BLINK_S = 1.5;
/** "Score, and the nearest wins": the captain ×0.65 (×0.45 while a company is selected), order flags ×0.7. */
export const CAPTAIN_SCORE = 0.65;
export const CAPTAIN_SCORE_SELECTED = 0.45;
export const KING_REACH_SELECTED = 1.3;
export const FLAG_SCORE = 0.7;
/** The ground hit takes the nearest site within capture radius + this, tiles. */
export const SITE_EXTRA = 0.4;
/** Holding the captain still this long starts voice command (06-voice.md §3); releasing after is not a tap. */
export const HOLD_S = 0.4;
/** Stroke points are ground points at least this far apart, tiles. */
export const STROKE_STEP = 0.3;
/** A front is simplified at this, tiles; under FRONT_TAP it counts as a tap. */
export const FRONT_SIMPLIFY = 0.12;
export const FRONT_TAP = 1.5;
/** A drag route is simplified at this, tiles, and keeps its last ROUTE_KEEP points as `via`. */
export const ROUTE_SIMPLIFY = 0.35;
export const ROUTE_KEEP = 12;
/** Pinch: the zoom steps once each time log(d/d0) passes ±this. */
export const PINCH_STEP = 0.22;
/** A two-finger tap: both fingers down and up within this, travelling less than TWO_TAP_PX. */
export const TWO_TAP_MS = 320;
export const TWO_TAP_PX = 14;
/** The wheel: one zoom step per this much deltaY. */
export const WHEEL_STEP = 90;
/** Arrows / WASD pan at this many CSS px per second. */
export const KEY_PAN = 520;
