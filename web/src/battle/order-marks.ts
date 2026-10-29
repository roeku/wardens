import type { Deed, P, When } from '../contracts';
import { MARK, type Marks, type Pen } from '../view/marks';
import type { BattleView } from './battle';
import { BLINK_S } from '../input/thresholds';
import type { OrderView, OrdersView, WaitView } from './ui';

// The standing marks of a battle, redrawn every frame (02-look.md §7 "What is drawn"; 01-flow.md §2; 08-orders.md
// §1, §6), and the marks an order leaves when it is given:
// - every site's capture ring, dashed in its holder's light colour (or neutral), a solid arc for the capture;
// - every waiting order as a faint dotted mark to where it points, a ring round a trigger's ground;
// - every detached company's faint dotted line to its order flag, and the flag;
// - the selected company's ellipse, breathing, blinking before it lapses, and its order;
// - paused: every company's order (dashed to move targets, red to attack targets, gold to sites);
// - the stroke being drawn: a front with its ghost bars, or a drag route coloured by what it would end on.

/** 02-look.md §7 "Place capture ring": dashed [0.4, 0.3], width 0.07 (0.12 on hover); the capture arc 0.16. */
const CAPTURE_DASH = [0.4, 0.3] as const;
const CAPTURE_W = 0.07;
const CAPTURE_W_HOVER = 0.12;
const CAPTURE_ARC_W = 0.16;
/** Selected company: ink 0.26 at α .55 under team [3] 0.12; the radius breathes ±2.5% at 5 rad/s. */
const SEL_INK = 0.26;
const SEL_INK_ALPHA = 0.55;
const SEL_W = 0.12;
const BREATHE = 0.025;
const BREATHE_RATE = 5;
/** Blinking before the lapse: on and off this many times a second (chosen). */
const BLINK_HZ = 4;
/** Drawing a front: ink 0.3 under cream 0.16. Ghost bars 0.22 wide, a 0.35 nub; the captain a gold disc r 0.3. */
const FRONT_INK = 0.3;
const FRONT_W = 0.16;
const BAR_W = 0.22;
const BAR_NUB = 0.35;
const CAPTAIN_DISC = 0.3;
/** Drag route: ink 0.24 under a dashed 0.12 line, an arrowhead of 0.6; an enemy end gets a red ring r 1.9. */
const ROUTE_INK = 0.24;
const ROUTE_W = 0.12;
export const ROUTE_DASH = [0.5, 0.3] as const;
const HEAD = 0.6;
const FOE_RING = 1.9;
/** Faint marks (chosen): a detached company's dotted line, a waiting order (brighter once signalled). */
const DOTS = [0.18, 0.3] as const;
const DETACHED_ALPHA = 0.5;
const WAIT_ALPHA = 0.45;
const WAIT_SIGNALLED_ALPHA = 0.7;
const WAIT_RING = 0.7;
/** The rally's big gold ring (chosen radius). */
const RALLY_RING = 4.2;
/** A ping on a company named by an order with nothing to draw (a change of way, a wait). */
const NAMED_PING = 1.3;

const pt = (p: [number, number]): P => ({ x: p[0], y: p[1] });
const near = (a: [number, number] | undefined, b: [number, number] | undefined) =>
  a === b || (!!a && !!b && Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05);

/** The colour a company's order is drawn in (02-look.md §7 "Route colour"). */
export function orderColour(o: Pick<OrderView, 'id' | 'order'>, captain: number | null): number {
  switch (o.order) {
    case 'attack':
    case 'charge':
      return MARK.red;
    case 'take':
      return MARK.gold;
    case 'recall':
    case 'withdraw':
    case 'regroup':
      return MARK.withdraw;
  }
  return o.id === captain ? MARK.gold : MARK.cream;
}

/** The colour of a deed's mark (a waiting order), from its verb. */
export function deedColour(d: Deed): number {
  switch (d.do) {
    case 'with':
    case 'wait':
      return deedColour(d.deed);
    case 'attack':
    case 'charge':
    case 'commit':
      return MARK.red;
    case 'take':
    case 'rally':
      return MARK.gold;
    case 'recall':
    case 'withdraw':
    case 'regroup':
      return MARK.withdraw;
  }
  return MARK.cream;
}

/** The deed under any `with` and `wait`. */
export function innerDeed(d: Deed): Deed {
  return d.do === 'with' || d.do === 'wait' ? innerDeed(d.deed) : d;
}

/** The companies a deed names (the captain for the army). */
export function named(d: Deed, captain: number | null): number[] {
  if (d.do === 'with' || d.do === 'wait') return named(d.deed, captain);
  if (d.do === 'recall') return [d.id];
  if (!('who' in d)) return captain === null ? [] : [captain];
  const w = d.who;
  return w.t === 'army' ? (captain === null ? [] : [captain]) : w.t === 'squad' ? [w.id] : w.ids;
}

export class OrderMarks {
  constructor(private readonly b: BattleView) {}

  /** The per-frame drawer the battle's `Marks` calls. */
  readonly draw = (pen: Pen): void => {
    const b = this.b;
    const ui = b.ui;
    const orders = b.orders;
    this.sites(pen);
    // waiting orders, always faint (08-orders.md §6)
    for (const o of orders.squads) for (const w of o.waits) this.wait(pen, this.start(o.id, o.c), w);
    const cap = orders.captain;
    const capAt = cap === null ? null : this.start(cap, orders.squads.find((o) => o.id === cap)?.c ?? null);
    for (const w of orders.army) this.wait(pen, capAt, w);
    const all = b.clock.paused;
    for (const o of orders.squads) {
      const full = all || o.id === ui.selected;
      if (o.flag) {
        if (!full) {
          const from = this.start(o.id, o.c);
          if (from) pen.line([from, pt(o.flag)], { colour: MARK.cream, width: ROUTE_W, alpha: DETACHED_ALPHA, dash: DOTS });
        }
        pen.flag(pt(o.flag), MARK.oursCloth);
      }
      if (full) this.order(pen, o, cap, 1);
    }
    if (ui.selected !== null) this.selection(pen, ui.selected);
    this.stroke(pen);
  };

  /** Where a company's lines start: its banner as drawn, else its centre. */
  private start(id: number, c: [number, number] | null): P | null {
    const bn = this.b.bannerOf(id);
    if (bn) return { x: bn.x, y: bn.y };
    return c ? pt(c) : null;
  }

  private sites(pen: Pen): void {
    const b = this.b;
    const r = b.sites.r;
    const light = (t: number | null) => (t === null ? MARK.neutral : t === b.team ? MARK.ours : MARK.foes);
    for (const s of b.sites.sites) {
      const c = { x: s.x, y: s.y };
      const hover = b.ui.hoverSite === s.id;
      pen.ring(c, r, { colour: light(s.owner), width: hover ? CAPTURE_W_HOVER : CAPTURE_W, dash: CAPTURE_DASH });
      if (s.by !== null && s.progress > 0) pen.ring(c, r, { colour: light(s.by), width: CAPTURE_ARC_W }, 0, s.progress);
    }
  }

  /** A waiting order's faint mark: a dotted line from who waits to where it points, a small ring there. */
  private wait(pen: Pen, from: P | null, w: WaitView): void {
    const colour = deedColour(w.deed);
    const alpha = w.signalled ? WAIT_SIGNALLED_ALPHA : WAIT_ALPHA;
    if (w.to) {
      const to = pt(w.to);
      if (from) pen.line([from, to], { colour, width: ROUTE_W, alpha, dash: DOTS });
      pen.ring(to, WAIT_RING, { colour, width: ROUTE_W, alpha });
    } else if (from) pen.ring(from, WAIT_RING, { colour, width: ROUTE_W, alpha, dash: DOTS });
    this.trigger(pen, w.when, alpha);
  }

  /** A condition's ground: the place an enemy must come near (08-orders.md §6 "Conditions"). */
  private trigger(pen: Pen, when: When, alpha: number): void {
    if (when.on === 'enemy_near') pen.ring(when.at, when.r, { colour: MARK.red, width: ROUTE_W, alpha: alpha * 0.8, dash: CAPTURE_DASH });
  }

  /** A company's current order in full: a dashed route to its target with an arrowhead (02-look.md §7). */
  order(pen: Pen, o: OrderView, captain: number | null, alpha: number): void {
    if (!o.to || o.order === 'follow' || o.order === 'ride') return;
    const from = this.start(o.id, o.c);
    if (!from) return;
    const to = pt(o.to);
    const pts = [from, ...o.via.map(pt), to];
    const colour = orderColour(o, captain);
    pen.line(pts, { colour, width: ROUTE_W, ink: ROUTE_INK, dash: ROUTE_DASH, alpha });
    const a = pts[pts.length - 2];
    if (Math.hypot(to.x - a.x, to.y - a.y) > 0.3) pen.head(to, { x: to.x - a.x, y: to.y - a.y }, HEAD, { colour, alpha });
    if (o.order === 'attack' || o.order === 'charge') pen.ring(to, FOE_RING, { colour: MARK.red, width: ROUTE_W, alpha });
  }

  /** The selected company's ellipse: fitted to its formation, breathing, blinking for the last 1.5 s. */
  private selection(pen: Pen, id: number): void {
    const b = this.b;
    if (b.ui.lapse < BLINK_S && Math.floor(b.uiTime * BLINK_HZ * 2) % 2 === 1) return;
    const oval = b.oval(id);
    if (!oval) return;
    const k = 1 + BREATHE * Math.sin(b.uiTime * BREATHE_RATE);
    pen.ellipse(oval.c, oval.a * k, oval.b * k, oval.face, { colour: MARK.ours, width: SEL_W, ink: SEL_INK, inkAlpha: SEL_INK_ALPHA });
  }

  private stroke(pen: Pen): void {
    const b = this.b;
    const st = b.ui.stroke;
    if (!st || st.points.length < 2) return;
    if (st.kind === 'front') {
      pen.line(st.points, { colour: MARK.cream, width: FRONT_W, ink: FRONT_INK });
      const p = st.preview;
      if (p && !p.tap) {
        for (const bar of p.bars) {
          const colour = bar.role === 'bows' ? MARK.green : bar.role === 'horse' ? MARK.gold : MARK.ours;
          pen.bar({ x: bar.x, y: bar.y }, bar.face, bar.len, { colour, width: BAR_W }, BAR_NUB);
        }
        if (p.captain) pen.disc(p.captain, CAPTAIN_DISC, MARK.gold);
      }
      return;
    }
    // a drag route, coloured by what it would end on (02-look.md §7 "Route colour")
    const end = st.end;
    let colour: number = st.kind === 'captain' ? MARK.gold : MARK.cream;
    if (end?.kind === 'enemy') colour = MARK.red;
    else if (end?.kind === 'ground' && end.site >= 0) colour = MARK.gold;
    const pts = st.points;
    pen.line(pts, { colour, width: ROUTE_W, ink: ROUTE_INK, dash: ROUTE_DASH });
    const a = pts[Math.max(0, pts.length - 4)];
    const z = pts[pts.length - 1];
    pen.head(z, { x: z.x - a.x, y: z.y - a.y }, HEAD, { colour });
    if (end?.kind === 'enemy') {
      const c = this.b.squadCentre(end.squad);
      if (c) pen.ring(c, FOE_RING, { colour: MARK.red, width: ROUTE_W });
    } else if (end?.kind === 'ground' && end.site >= 0) {
      const s = this.b.sites.sites.find((x) => x.id === end.site);
      if (s) pen.ring({ x: s.x, y: s.y }, this.b.sites.r, { colour: MARK.gold, width: CAPTURE_W_HOVER });
    }
  }
}

/**
 * The marks an order leaves when given (02-look.md §7 "Order given: lines that fade; rings that close in"): every
 * company whose order changed gets a fading route to its new target and a ring closing in there (an enemy's red
 * ring, a site's gold ring at its capture radius); a front leaves its trail (cream, or grey if refused); a rally a
 * big gold ring on the captain; an order that changed no route pings the companies it named. A refusal's red X
 * comes from the sim's Refused event.
 */
export function drawGiven(b: BattleView, marks: Marks, deed: Deed, before: OrdersView, after: OrdersView, refused: boolean): void {
  const d = innerDeed(deed);
  if (d.do === 'front') {
    marks.trail(d.line, refused);
    return;
  }
  if (refused && deed.do !== 'wait') return;
  if (d.do === 'rally' && deed.do !== 'wait') {
    const c = after.captain === null ? null : b.squadCentre(after.captain);
    if (c) marks.ring(c, RALLY_RING, MARK.gold, { close: true, width: 0.16 });
    return;
  }
  const drew = deed.do === 'wait' ? 0 : changed(b, marks, before, after, null);
  if (drew === 0) {
    for (const id of named(deed, after.captain)) {
      const c = b.squadCentre(id);
      if (c) marks.ping(c, deedColour(deed), NAMED_PING);
    }
  }
}

/**
 * Fading routes and closing rings for every company whose order changed between `before` and `after` (only those
 * in `only` when given). Returns how many were drawn.
 */
export function changed(b: BattleView, marks: Marks, before: OrdersView, after: OrdersView, only: Set<number> | null): number {
  const prev = new Map(before.squads.map((o) => [o.id, o]));
  let n = 0;
  for (const o of after.squads) {
    if (only && !only.has(o.id)) continue;
    const p = prev.get(o.id);
    const same = p && p.order === o.order && near(p.to, o.to) && p.target === o.target && p.site === o.site && p.via.length === o.via.length;
    if (same || !o.to || o.order === 'follow' || o.order === 'ride') continue;
    const colour = orderColour(o, after.captain);
    const bn = b.bannerOf(o.id);
    const from = bn ? { x: bn.x, y: bn.y } : pt(o.c);
    const to = pt(o.to);
    marks.route([from, ...o.via.map(pt), to], colour);
    if (o.order === 'attack' || o.order === 'charge') marks.ring(to, FOE_RING, MARK.red, { close: true });
    else if (o.order === 'take') marks.ring(to, b.sites.r, MARK.gold, { close: true, width: 0.16 });
    else marks.ping(to, colour);
    n++;
  }
  return n;
}
