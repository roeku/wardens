import type { Kind, P, Unit } from '../contracts';
import { thresholds } from '../input/thresholds';
import { Screen } from '../input/screen';
import { kindIcon, wayIcon, type CardSpec } from '../view/cards';
import { Figures, type BannerRecord, type ManRecord } from '../view/figures';
import { FOG_SIGHT, setFog } from '../view/fog';
import { groundAt, type LandData } from '../view/land-data';
import { Marks, MARK } from '../view/marks';
import { RoadSites } from '../view/places/road';
import type { App, Scene } from './app';
import { readState, type BandState, type Campaign, type CampaignState, type CommanderState } from './campaign';
import { drawPlaceNames, fitCamera, clearNames, glowPlaces, placeHit } from './road-common';
import { sceneInput, type SceneInput } from './gestures';
import { thud } from './sounds';

// The muster, the parade ground (docs/spec/01-flow.md §3.4). Bands of men wait in the meadows across the road from
// the commanders, each under the plain linen banner of its village; the commanders stand before the hall, a veteran
// with a plume. The verb is lift, hover and drop:
// - lift (rises 0.55 tiles in 0.14 s): the bands this commander's way suits are ringed in gold, with the chevron they
//   would gain pulsing;
// - hover: the band wheels to face the commander;
// - drop (a 0.09 s thud and dust): the linen gives way to the hall's banner and the men leap in a ripple (0.07 s per
//   tile); a suited band hops twice in a gold flash and keeps its gold chevron.
// Lifting a commander off a company stands it down; dropping one on a company swaps them. When every banner has its
// company the road's first places glow, and a tap on one sets out. Drawn with the same figure layer as a battle, from
// records built here (out/decisions-d5-screens.md "The muster draws its own records").

/** 01-flow.md §3.4. */
export const LIFT_H = 0.55;
export const LIFT_S = 0.14;
export const DROP_S = 0.09;
export const RIPPLE_S_PER_TILE = 0.07;
/** A leap and a hop (chosen): their height in tiles and how long each takes. */
const LEAP_H = 0.22;
const LEAP_S = 0.26;
const HOP_H = 0.3;
const HOP_S = 0.22;
/** 01-flow.md §2 "Carrying on a phone": an item carried at the muster is drawn 44 px above the thumb. */
const CARRY_ABOVE_PX = 44;
/** The chevron's pulse while a rank is previewed (chosen: 4 Hz, on half the time). */
const PULSE_HZ = 4;
/** Ground spacing of a band's men (chosen), foot and horse. */
const FILE = 0.62;
const FILE_HORSE = 0.95;
/** A man's height for the hit segment, tiles (input/hit.ts HEAD: commanders ×1.16). */
const MAN_H = 0.76 * 1.16;
const HORSE_H = 1.04 * 1.16;
/** How far from a band's middle a carried commander still hovers it, tiles (chosen). */
const HOVER_R = 2.6;
/** The muster's zoom step (ZOOMS[4] = 16 art px per tile; chosen: a band's men read at 16). */
const MUSTER_ZOOM = 4;

const KIND_OF: Record<string, Kind> = { spear: 'spear', shield: 'shield', bow: 'archer', archer: 'archer', horse: 'horse' };

interface Man {
  rec: ManRecord;
  /** His place in the band (sim tiles). */
  hx: number;
  hy: number;
}

interface BandView {
  s: BandState;
  men: Man[];
  banner: BannerRecord;
  /** The band's middle and its front (where its commander stands), sim tiles. */
  cx: number;
  cy: number;
  fx: number;
  fy: number;
  /** The way it faces: toward the commanders' line. */
  face: number;
  kind: Kind;
  /** Seconds since its last drop (the ripple), since its hops began, and its gold flash; −1 none. */
  leap: number;
  hop: number;
  /** Turned to face the carried commander. */
  facing: number | null;
}

interface CommanderView {
  s: CommanderState;
  rec: ManRecord;
  /** Where he stands when not carried: his place in the row, or before his band. */
  home: P;
  /** The way he faces standing still. */
  rest: number;
  /** Drawn now. */
  x: number;
  y: number;
  lift: number;
  /** Seconds into his drop (−1 none). */
  drop: number;
}

export class MusterScene implements Scene {
  readonly name = 'muster';
  readonly top = 'play' as const;
  readonly play = null;
  private readonly figures: Figures;
  private readonly marks: Marks;
  private readonly sites: RoadSites;
  private readonly screen: Screen;
  private readonly input: SceneInput;
  state: CampaignState;
  private bands: BandView[] = [];
  private commanders: CommanderView[] = [];
  private carried: CommanderView | null = null;
  private hover: BandView | null = null;
  private time = 0;
  /** Every banner has its company: the road's first places glow. */
  ready = false;
  private card = -1;
  private readonly men: ManRecord[] = [];
  private readonly banners: BannerRecord[] = [];
  private pendingDt = 0;
  /** Where the camera is easing to, if anywhere. */
  private camGoal: P | null = null;

  constructor(
    private readonly app: App,
    land: LandData,
    readonly campaign: Campaign,
    private readonly onSetOut: (place: number) => void,
  ) {
    const view = app.view;
    view.setLand(land);
    setFog(new Uint8Array(land.w * land.h).fill(FOG_SIGHT));
    this.figures = app.figures;
    if (this.figures.group.parent !== view.scene) view.scene.add(this.figures.group);
    this.marks = new Marks(land);
    view.scene.add(this.marks.group);
    this.marks.drawers.push((pen) => this.drawMarks(pen));
    this.screen = new Screen(view);
    this.state = readState(campaign);
    const road = this.state.road;
    this.sites = new RoadSites(view, road.places.map((p) => ({ id: p.id, kind: p.kind, at: p.at, houses: p.houses, done: p.done })), road.hall, this.state.seed);
    this.layout();
    // the camera over the parade ground: the hall, the commanders and every band
    // on a phone the commanders and the nearest bands first (the rest a pan away)
    fitCamera(view, [road.hall, ...this.bands.map((b) => ({ x: b.cx, y: b.cy })), ...this.commanders.map((c) => c.home)], MUSTER_ZOOM, 3, 0, MUSTER_ZOOM);
    view.dayT = 0.35;
    view.beforeDraw = () => this.draw();
    this.input = sceneInput(view, {
      press: (x, y, touchish) => this.press(x, y, touchish),
      tap: (x, y, touchish) => this.tap(x, y, touchish),
      dragStart: () => this.lift(),
      dragMove: (x, y) => this.carry(x, y),
      dragEnd: (x, y) => this.drop(x, y),
      cancel: () => this.drop(null, null),
      panned: () => (this.camGoal = null),
    }, { pan: true, zoom: true });
  }

  // ------------------------------------------------------------------------------------------- the layout

  /**
   * Where everyone stands: the campaign's own spots when it gives them (commanders in a line before the hall, bands
   * in the meadows across the road), else two rows of bands. Each band faces the commanders, its files across that
   * way; a planted commander stands at its front, under its banner.
   */
  private layout(): void {
    const st = this.state;
    const road = st.road;
    const m = road.muster;
    const hall = road.hall;
    const ground = (x: number, y: number) => groundAt(this.app.view.land, x, y);
    const bands = st.muster.bands;
    const perRow = Math.ceil(bands.length / 2);
    const span = Math.min(m.x1 - m.x0 - 3, perRow * 4.2);
    const old = new Map(this.bands.map((b) => [b.s.id, b]));
    this.bands = bands.map((b, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const cx = b.at?.x ?? m.x0 + 2.5 + (perRow > 1 ? (col * span) / (perRow - 1) : span / 2) + row * 1.6;
      const cy = b.at?.y ?? hall.y + 5 + row * 5.6;
      // the way to the commanders' line, snapped to a quarter turn so the blocks stand square
      const toward = Math.round(Math.atan2(hall.y - cy, hall.x - cx) / (Math.PI / 2)) * (Math.PI / 2) + FACE_NUDGE;
      const fx0 = Math.cos(toward), fy0 = Math.sin(toward);
      const px0 = -fy0, py0 = fx0;
      const horse = b.unit === 'horse';
      const sp = horse ? FILE_HORSE : FILE;
      const cols = horse ? Math.min(3, b.men) : Math.min(4, b.men);
      const rows = Math.ceil(b.men / cols);
      const prev = old.get(b.id);
      const kind = KIND_OF[b.unit] ?? 'spear';
      const planted = b.commander !== null;
      const men: Man[] = [];
      for (let k = 0; k < b.men; k++) {
        const f = (k % cols) - (cols - 1) / 2;
        const r = Math.floor(k / cols) - (rows - 1) / 2;
        const hx = cx + f * sp * px0 - r * sp * fx0;
        const hy = cy + f * sp * py0 - r * sp * fy0;
        const rec = prev?.men[k]?.rec ?? newMan(1000 + b.id * 48 + k);
        // raw bands stand in their own clothes until a commander gives them the hall's colours (the levy's smock);
        // riders keep their horses
        const raw = !b.seasoned && !planted;
        rec.kind = raw && kind !== 'horse' ? 'levy' : kind;
        rec.unit = rec.kind as Unit;
        rec.rank = b.rank;
        rec.recruit = raw;
        rec.x = hx;
        rec.y = hy;
        rec.h = ground(hx, hy);
        men.push({ rec, hx, hy });
      }
      const depth = ((rows - 1) / 2) * sp + 0.9;
      const fx = cx + fx0 * depth;
      const fy = cy + fy0 * depth;
      const banner = prev?.banner ?? newBanner(b.id);
      const side = ((cols - 1) / 2) * sp + 0.5;
      banner.x = fx - px0 * side;
      banner.y = fy - py0 * side;
      banner.h = ground(banner.x, banner.y);
      banner.face = toward;
      banner.kind = kind;
      banner.unit = kind as Unit;
      banner.linen = !planted;
      banner.rank = b.rank;
      banner.size = b.men;
      const v: BandView = { s: b, men, banner, cx, cy, fx, fy, face: toward, kind, leap: prev?.leap ?? -1, hop: prev?.hop ?? -1, facing: null };
      return v;
    });
    const cmd = st.muster.commanders;
    const oldC = new Map(this.commanders.map((c) => [c.s.id, c]));
    let rowI = 0;
    this.commanders = cmd.map((c) => {
      const band = c.band !== null ? this.bands.find((b) => b.s.id === c.band) : undefined;
      const spot = c.at ?? { x: m.x0 + 0.5 + rowI * 1.7, y: hall.y - 2.2 };
      rowI++;
      const home = band ? { x: band.fx, y: band.fy } : spot;
      const prev = oldC.get(c.id);
      const rec = prev?.rec ?? newMan(5000 + c.id);
      rec.commander = true;
      rec.kind = KIND_OF[c.suits] ?? 'spear';
      rec.unit = rec.kind as Unit;
      rec.rank = c.veteran ? 1 : 0;
      rec.faceSeed = c.face;
      // in the row he faces the bands across the road; before his band he faces the way it does
      const rest = band ? band.face : settle(Math.atan2(this.bandsMid().y - spot.y, this.bandsMid().x - spot.x));
      const v: CommanderView = { s: c, rec, home, rest, x: prev?.x ?? home.x, y: prev?.y ?? home.y, lift: prev?.lift ?? 0, drop: prev?.drop ?? -1 };
      if (!prev) rec.face = rest;
      return v;
    });
    const planted = st.muster.bands.filter((b) => b.commander !== null).length;
    this.ready = st.muster.ready ?? planted >= st.muster.banners;
  }

  /** The middle of the bands, sim tiles. */
  private bandsMid(): P {
    let x = 0, y = 0;
    for (const b of this.bands) {
      x += b.cx;
      y += b.cy;
    }
    const n = Math.max(1, this.bands.length);
    return { x: x / n, y: y / n };
  }

  /** Sets out for a reachable place (a tap on its glow does this once every banner has its company). */
  setOut(place: number): void {
    if (this.ready) this.onSetOut(place);
  }

  /** 01-flow.md §5 `autoMuster()`: every banner given its best company, and the scene re-read. */
  autoMuster(): void {
    this.campaign.auto_muster();
    const was = this.ready;
    this.refresh();
    for (const b of this.bands) if (b.s.commander !== null) b.leap = 0;
    if (this.ready && !was) this.focusOnRoad();
  }

  /** Re-reads the campaign after a change (the dev hooks' autoMuster too). */
  refresh(): void {
    this.state = readState(this.campaign);
    const wasCarried = this.carried?.s.id;
    this.layout();
    if (wasCarried !== undefined) this.carried = this.commanders.find((c) => c.s.id === wasCarried) ?? null;
  }

  // ------------------------------------------------------------------------------------------- the marks

  private commanderAt(x: number, y: number, touchish: boolean): CommanderView | null {
    const reach = thresholds(touchish).companyReach;
    let best: CommanderView | null = null;
    let bd = reach;
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    for (const c of this.commanders) {
      const h = groundAt(this.app.view.land, c.x, c.y) + c.lift;
      this.screen.project(c.x, h, c.y, a);
      this.screen.project(c.x, h + (c.rec.kind === 'horse' ? HORSE_H : MAN_H), c.y, b);
      const d = segDist(x, y, a, b);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private bandAt(g: P): BandView | null {
    let best: BandView | null = null;
    let bd = HOVER_R;
    for (const b of this.bands) {
      const d = Math.hypot(g.x - b.cx, g.y - b.cy);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private press(x: number, y: number, touchish: boolean): { becomes: 'drag' | 'pan'; handle: boolean } {
    const c = this.commanderAt(x, y, touchish);
    this.carried = c;
    return c ? { becomes: 'drag', handle: true } : { becomes: 'pan', handle: false };
  }

  private tap(x: number, y: number, touchish: boolean): void {
    this.carried = null;
    if (this.ready) {
      const place = placeHit(this.screen, this.sites, this.state, x, y, touchish);
      if (place !== null) {
        this.onSetOut(place);
        return;
      }
    }
    const c = this.commanderAt(x, y, touchish);
    if (c) return this.showCard(this.commanderCard(c.s), x, y);
    const band = this.bandAt(this.screen.ground(x, y));
    if (band) return this.showCard(this.bandCard(band.s), x, y);
    this.app.cards.hide(this.card);
  }

  private showCard(spec: CardSpec, x: number, y: number): void {
    this.app.cards.hide(this.card);
    const right = x < this.screen.size().w / 2;
    this.card = this.app.cards.show(spec, { x, y, r: this.screen.tilePx * 0.6 }, right ? 'right' : 'left', { life: 4 });
  }

  /** 01-flow.md §3 "Commander card": the sign of their way, and the suited kind's mark with a gold chevron. */
  commanderCard(c: CommanderState): CardSpec {
    return {
      face: { face: c.face, side: 'warden' },
      name: c.name,
      picto: [{ icon: wayIcon(c.way), colour: 'cream' }, { icon: kindIcon(c.suits) }, { icon: 'chevron', colour: 'gold' }],
      frame: c.veteran ? 'gold' : undefined,
    };
  }

  /** 01-flow.md §3 "Band card": its people, its number of men, its rank. */
  bandCard(b: BandState): CardSpec {
    const picto: CardSpec['picto'] = [{ icon: kindIcon(b.unit) }, { icon: 'man', n: b.men }];
    if (b.rank > 0) picto.push({ icon: 'chevron', n: b.rank, colour: 'gold' });
    return { name: b.village, picto };
  }

  /** Lift (0.55 tiles in 0.14 s); lifting a commander off a company stands it down. */
  private lift(): void {
    const c = this.carried;
    if (!c) return;
    this.app.cards.hide(this.card);
    if (c.s.band !== null) {
      this.campaign.stand_down(c.s.id);
      this.refresh();
    }
  }

  private carry(x: number, y: number): void {
    const c = this.carried;
    if (!c) return;
    const g = this.screen.ground(x, y - (this.input.touchish ? CARRY_ABOVE_PX : 0));
    c.x = g.x;
    c.y = g.y;
    const over = this.bandAt(g);
    if (over !== this.hover) {
      if (this.hover) this.hover.facing = null;
      this.hover = over;
    }
    if (over) over.facing = Math.atan2(g.y - over.cy, g.x - over.cx);
  }

  /** Drop: on a band, plant (a swap if it had one); anywhere else, he walks back to the row. */
  private drop(x: number | null, y: number | null): void {
    const c = this.carried;
    this.carried = null;
    if (this.hover) this.hover.facing = null;
    const over = this.hover;
    this.hover = null;
    if (!c) return;
    if (x === null || y === null || !over) {
      this.refresh();
      return;
    }
    const suited = c.s.suits === over.s.unit;
    const wasReady = this.ready;
    this.campaign.plant(c.s.id, over.s.id);
    this.refresh();
    if (this.ready && !wasReady) this.focusOnRoad();
    const cv = this.commanders.find((k) => k.s.id === c.s.id);
    if (cv) {
      cv.x = cv.home.x;
      cv.y = cv.home.y;
      cv.drop = 0;
    }
    const band = this.bands.find((b) => b.s.id === over.s.id);
    if (band) {
      band.leap = 0;
      band.hop = suited ? 0 : -1;
    }
    this.marks.ring({ x: over.fx, y: over.fy }, 0.9, 0xa07f50, { life: 0.35, close: false, width: 0.14 });
    if (suited) this.marks.ring({ x: over.cx, y: over.cy }, 2.6, MARK.gold, { life: 0.6, close: true, width: 0.2 });
    thud();
  }

  // ------------------------------------------------------------------------------------------- each frame

  frame(dt: number): void {
    this.time += dt;
    if (this.camGoal) {
      this.app.view.camera.easeTo(this.camGoal.x, this.camGoal.y, dt, 3);
      if (Math.hypot(this.camGoal.x - this.app.view.camera.focus.x, this.camGoal.y - this.app.view.camera.focus.y) < 0.05) this.camGoal = null;
    }
    this.app.view.time += dt;
    this.marks.tick(dt);
    const ground = (x: number, y: number) => groundAt(this.app.view.land, x, y);
    for (const c of this.commanders) {
      const carried = c === this.carried && this.input.pointer.mode === 'drag';
      if (carried) c.lift = Math.min(LIFT_H, c.lift + (LIFT_H / LIFT_S) * dt);
      else if (c.drop >= 0) {
        c.drop += dt;
        c.lift = Math.max(0, LIFT_H * (1 - c.drop / DROP_S));
        if (c.drop >= DROP_S) c.drop = -1;
      } else {
        c.lift = Math.max(0, c.lift - (LIFT_H / DROP_S) * dt);
        // walk home
        const dx = c.home.x - c.x, dy = c.home.y - c.y;
        const d = Math.hypot(dx, dy);
        const step = Math.min(d, 3.2 * dt);
        if (d > 0.01) {
          c.x += (dx / d) * step;
          c.y += (dy / d) * step;
          c.rec.face = Math.atan2(dy, dx);
          c.rec.speed = 1.6;
        } else {
          c.rec.speed = 0;
          c.rec.face = c.rest;
        }
      }
      if (carried) c.rec.speed = 0;
      c.rec.x = c.x;
      c.rec.y = c.y;
      c.rec.h = ground(c.x, c.y) + c.lift;
    }
    const lifting = this.carried && this.input.pointer.mode === 'drag' ? this.carried : null;
    const pulse = Math.floor(this.time * PULSE_HZ * 2) % 2 === 0;
    for (const b of this.bands) {
      if (b.leap >= 0) b.leap += dt;
      if (b.hop >= 0) b.hop += dt;
      const suited = lifting !== null && lifting.s.suits === b.s.unit && b.s.commander === null;
      b.banner.rank = b.s.rank + (suited && pulse ? 1 : 0);
      for (const m of b.men) {
        // the ripple: each man leaps when it reaches him, 0.07 s per tile from his commander
        let up = 0;
        if (b.leap >= 0) {
          const d = Math.hypot(m.hx - b.fx, m.hy - b.fy);
          const t = b.leap - d * RIPPLE_S_PER_TILE;
          if (t > 0 && t < LEAP_S) up = Math.sin((t / LEAP_S) * Math.PI) * LEAP_H;
        }
        // a suited band hops twice, after the ripple has passed
        if (b.hop >= 0) {
          const t = b.hop - 0.45;
          const k = Math.floor(t / HOP_S);
          if (t > 0 && k < 2) up = Math.max(up, Math.sin(((t - k * HOP_S) / HOP_S) * Math.PI) * HOP_H);
        }
        m.rec.h = ground(m.hx, m.hy) + up;
        m.rec.face = b.facing ?? b.face;
      }
      if (b.leap > 3) b.leap = -1;
      if (b.hop > 2) b.hop = -1;
    }
    this.sites.update();
    this.pendingDt = dt;
  }

  /** Called by the view just before it draws: the records into the figure layer, and the marks. */
  private draw(): void {
    const view = this.app.view;
    this.men.length = 0;
    this.banners.length = 0;
    for (const b of this.bands) {
      for (const m of b.men) this.men.push(m.rec);
      this.banners.push(b.banner);
    }
    for (const c of this.commanders) this.men.push(c.rec);
    const { aw, ah } = view.renderer.size;
    const sc = view.sun.light.shadow.camera;
    const cam = view.camera;
    this.figures.update({
      men: this.men,
      banners: this.banners,
      dt: this.pendingDt,
      time: view.time,
      zoom: cam.s,
      screen: { origin: cam.origin, halfW: (aw + 2) / 2, halfH: (ah + 2) / 2 },
      shadowTexel: (sc.right - sc.left) / view.sun.light.shadow.mapSize.x,
    });
    this.pendingDt = 0;
    this.marks.draw(cam.s);
  }

  private drawMarks(pen: Marks['pen']): void {
    const lifting = this.carried && this.input.pointer.mode === 'drag' ? this.carried : null;
    if (lifting) {
      const breathe = 1 + 0.025 * Math.sin(this.time * 5);
      for (const b of this.bands) {
        if (b.s.commander !== null || lifting.s.suits !== b.s.unit) continue;
        pen.ellipse({ x: b.cx, y: b.cy }, 2.0 * breathe, 1.7 * breathe, 0, { colour: MARK.gold, width: 0.14 });
      }
      if (this.hover) pen.ellipse({ x: this.hover.cx, y: this.hover.cy }, 2.2, 1.9, 0, { colour: MARK.cream, width: 0.08, dash: [0.4, 0.3] });
    }
    if (this.ready) glowPlaces(pen, this.state, this.time);
  }

  rendered(): void {
    const L = this.app.ui;
    if (this.ready) drawPlaceNames(L, this.screen, this.sites, this.state, false, this.app.view);
    else clearNames(L);
  }

  /** For the dev hooks: where each commander and band stands on screen, CSS pixels. */
  onScreen(): {
    commanders: { id: number; x: number; y: number }[];
    bands: { id: number; unit: string; x: number; y: number }[];
    places: { id: number; name: string; reachable: boolean; x: number; y: number }[];
  } {
    const p = { x: 0, y: 0 };
    const r = this.app.view.canvas.getBoundingClientRect();
    const at = (x: number, h: number, y: number) => {
      this.screen.project(x, h, y, p);
      return { x: p.x + r.left, y: p.y + r.top };
    };
    return {
      commanders: this.commanders.map((c) => ({ id: c.s.id, ...at(c.x, groundAt(this.app.view.land, c.x, c.y) + 0.5, c.y) })),
      bands: this.bands.map((b) => ({ id: b.s.id, unit: b.s.unit, ...at(b.cx, groundAt(this.app.view.land, b.cx, b.cy), b.cy) })),
      places: this.state.road.places.map((pl) => {
        const top = this.sites.placeTop(pl.id)!;
        return { id: pl.id, name: pl.name, reachable: pl.reachable, ...at(top.x, (top.y + this.sites.footY(pl.id)) / 2, top.z) };
      }),
    };
  }

  /** The camera eases over the parade ground and the road's first places (once every banner has its company). */
  focusOnRoad(): void {
    const cam = this.app.view.camera;
    const from = { x: cam.focus.x, y: cam.focus.y };
    const first = this.state.road.places.filter((p) => p.reachable).map((p) => p.at);
    fitCamera(this.app.view, [this.state.road.hall, ...this.bands.map((b) => ({ x: b.cx, y: b.cy })), ...first], MUSTER_ZOOM, 4);
    this.camGoal = { x: cam.focus.x, y: cam.focus.y };
    cam.focus.set(from.x, from.y);
  }

  dispose(): void {
    this.input.dispose();
    this.app.cards.hide(this.card);
    this.app.view.scene.remove(this.marks.group);
    this.marks.group.traverse((o) => (o as { geometry?: { dispose(): void } }).geometry?.dispose());
    this.sites.dispose();
    this.figures.update({ men: [], banners: [], dt: 0, time: this.app.view.time, zoom: this.app.view.camera.s });
    this.app.view.beforeDraw = null;
  }
}

/**
 * A standing figure's facing, settled to one of 16 ways and nudged off it by FACE_NUDGE: measured, a commander standing
 * at some angles kept one pixel of his shoulder flipping while the view panned (the shimmer check: 3 bad frames in 60
 * at 16 px/tile); at these angles none did (0 in 14 runs, zooms 9–28, both directions).
 */
const FACE_NUDGE = 0.02;
function settle(face: number): number {
  return Math.round(face / (Math.PI / 8)) * (Math.PI / 8) + FACE_NUDGE;
}

function newMan(id: number): ManRecord {
  return {
    id, x: 0, y: 0, h: 0, face: -Math.PI / 2, speed: 0, kind: 'spear', unit: 'spear', team: 0, rank: 0, commander: false, captain: false,
    faceSeed: 0, routing: false, alive: true, recruit: false, strikes: 0, hitAge: Infinity, deathAge: 0, engaged: false, breathAge: Infinity,
    backing: false,
  };
}

function newBanner(id: number): BannerRecord {
  return {
    id, x: 0, y: 0, h: 0, face: -Math.PI / 2, speed: 0, heart: 1, lost: 0, size: 12, rank: 0, honours: 0, kind: 'spear', unit: 'spear',
    team: 0, linen: true, captain: false, routing: false, selected: false, hover: false, unfurl: 1,
  };
}

function segDist(x: number, y: number, a: P, b: P): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

