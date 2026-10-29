import { thresholds } from '../input/thresholds';
import { ZOOMS } from '../view/camera';
import type { View } from '../view/view';
import type { Screen } from '../input/screen';
import type { PixelLayer } from '../view/cards';
import { drawText, GLYPH_H, measure } from '../view/font5x7';
import { MARK, type Pen } from '../view/marks';
import type { RoadSites } from '../view/places/road';
import type { CampaignState } from './campaign';

// What the muster and the road share (docs/spec/01-flow.md §3.4–§3.5): the reachable places glow, with their name
// beside them (a place name is a word that exists in the world), and a tap on one is found by the place's building
// on screen, at the touch or mouse reach.

/** Narrower than this many art px (a phone upright at px 1), fitting stops at ZOOMS[3] = 13 px/tile (chosen). */
const NARROW_AW = 480;
const PHONE_MIN_ZI = 3;

/** The glow's ring round a reachable place, tiles (chosen: past the building's footprint), and its breath. */
const GLOW_R = 2.3;
const GLOW_BREATH = 0.04;

/** Gold rings breathing round every reachable place (gold means choice, 02-look.md §4). */
export function glowPlaces(pen: Pen, st: CampaignState, time: number): void {
  const k = 1 + GLOW_BREATH * Math.sin(time * 4);
  for (const p of st.road.places) {
    if (!p.reachable) continue;
    pen.ring(p.at, GLOW_R * k, { colour: MARK.gold, width: 0.16 });
    pen.ring(p.at, GLOW_R * k + 0.45, { colour: MARK.gold, width: 0.07, dash: [0.4, 0.3], alpha: 0.5 + 0.5 * Math.abs(Math.sin(time * 2)) });
  }
}

/** The place under a CSS point: its building (foot to top) within reach, or a point inside its glow on the ground. */
export function placeHit(screen: Screen, sites: RoadSites, st: CampaignState, x: number, y: number, touchish: boolean, reachableOnly = true): number | null {
  const reach = thresholds(touchish).reach;
  const a = { x: 0, y: 0 };
  const b = { x: 0, y: 0 };
  let best: number | null = null;
  let bd = Infinity;
  const g = screen.ground(x, y);
  for (const p of st.road.places) {
    if (reachableOnly && !p.reachable) continue;
    const top = sites.placeTop(p.id);
    if (!top) continue;
    screen.project(top.x, top.y, top.z, a);
    screen.project(top.x, sites.footY(p.id), top.z, b);
    const d = Math.hypot(g.x - p.at.x, g.y - p.at.y) < GLOW_R ? 0 : segDist(x, y, a, b);
    if (d <= reach && d < bd) {
      bd = d;
      best = p.id;
    }
  }
  return best;
}

/** The names as last drawn on each layer: redrawn only when the view, the layer or the places change. */
const drawnKey = new WeakMap<PixelLayer, string>();

/** Each reachable place's name beside its building, in cream over an ink shadow, at the ui scale. */
export function drawPlaceNames(L: PixelLayer, screen: Screen, sites: RoadSites, st: CampaignState, all = false, view?: View): void {
  if (view) {
    const c = view.camera;
    const key = `${L.gen}|${c.origin.x},${c.origin.y},${c.sub.x.toFixed(2)},${c.sub.y.toFixed(2)},${c.s}|${all}|${st.road.places.filter((q) => q.reachable).map((q) => q.id).join(',')}`;
    if (drawnKey.get(L) === key) return;
    drawnKey.set(L, key);
  } else drawnKey.delete(L);
  L.clear();
  const p = { x: 0, y: 0 };
  for (const pl of st.road.places) {
    if (!all && !pl.reachable) continue;
    const top = sites.placeTop(pl.id);
    if (!top) continue;
    screen.project(top.x, top.y, top.z, p);
    const u = L.toUi(p.x, p.y);
    const x = u.x + 6;
    const y = u.y - Math.floor(GLYPH_H / 2);
    if (x + measure(pl.name) >= L.w || y < 0 || y + GLYPH_H >= L.h) continue;
    drawText(L.ctx, pl.name, x + 1, y + 1, '#16120f');
    drawText(L.ctx, pl.name, x, y, pl.reachable ? '#f1ead6' : '#b0a693');
  }
}

export function segDist(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

/**
 * Stands the camera over `pts` (sim tiles): the largest zoom step up to `maxZi` at which they fit with a margin,
 * centred on them (a fraction `down` of the screen below its middle). On a narrow screen it stops at `minZi` (at least
 * ZOOMS[3]) and the player pans.
 */
export function fitCamera(view: View, pts: { x: number; y: number }[], maxZi: number, margin = 4, down = 0, minZi = 0): void {
  const cam = view.camera;
  const { aw, ah } = view.renderer.size;
  if (pts.length === 0) return;
  let la = Infinity, ha = -Infinity, lu = Infinity, hu = -Infinity, cx = 0, cy = 0;
  for (const p of pts) {
    const a = (p.x + p.y) * Math.SQRT1_2;
    const u = (p.x - p.y) * Math.SQRT1_2 * 0.5;
    la = Math.min(la, a);
    ha = Math.max(ha, a);
    lu = Math.min(lu, u);
    hu = Math.max(hu, u);
    cx += p.x;
    cy += p.y;
  }
  // a narrow screen (a phone held upright) keeps men and banners legible and pans instead of shrinking past `minZi`
  const floor = view.renderer.size.aw < NARROW_AW ? Math.min(maxZi, Math.max(minZi, PHONE_MIN_ZI)) : 0;
  let zi = maxZi;
  while (zi > floor && ((ha - la + margin) * ZOOMS[zi] > aw || (hu - lu + margin) * ZOOMS[zi] > ah * (1 - Math.abs(down) * 2))) zi--;
  cam.zi = zi;
  // the middle of the box (not of the points), nudged up the screen so it stands `down` below the screen's middle
  const ma = (la + ha) / 2, mu = (lu + hu) / 2;
  const mx = ma * Math.SQRT1_2 + mu * Math.SQRT2;
  const my = ma * Math.SQRT1_2 - mu * Math.SQRT2;
  void cx;
  void cy;
  const up = (ah * down) / ZOOMS[zi] / Math.sin(Math.PI / 6);
  cam.focus.set(mx + up * Math.SQRT1_2, my - up * Math.SQRT1_2);
}

/** Takes the names off a layer, if they are on it. */
export function clearNames(L: PixelLayer): void {
  if (drawnKey.delete(L)) L.clear();
}
