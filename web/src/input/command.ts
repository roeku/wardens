import type { BattleView } from '../battle/battle';
import type { FrontPreview, StrokeKind } from '../battle/ui';
import { squadBits, type Deed, type P, type Who } from '../contracts';
import type { View } from '../view/view';
import { type Hit, HitTester } from './hit';
import { inputHooks } from './hooks';
import type { Gestures, Pressed } from './pointer';
import type { Screen } from './screen';
import { lengthOf, simplify } from './simplify';
import {
  FRONT_SIMPLIFY,
  FRONT_TAP,
  LAPSE_S,
  ROUTE_KEEP,
  ROUTE_SIMPLIFY,
  STROKE_STEP,
} from './thresholds';

// What each mark means in battle (docs/spec/01-flow.md §2 "What a tap does", "Strokes"): every tap and stroke
// becomes a Command through `BattleView.issue` (src tap, drag or line). If a company is selected the order goes to
// it alone and deselects it; otherwise it goes to the whole army.

const ST_ROUTING = 3;
const ST_FLED = 4;
/** Under a still mouse, what it is over is tested again every this many frames (the men move under it). */
const HOVER_EVERY = 8;

export class BattleInput implements Gestures {
  /** The press being settled: what it hit, the selection before it, and whether it selected a company itself. */
  private pressHit: Hit | null = null;
  private prevSel: number | null = null;
  private selectedNow = false;
  private touchish = false;
  /** The last stroke point's CSS position, for the end hit and the preview (recomputed once a frame). */
  private strokeAt: { x: number; y: number } | null = null;
  private strokeDirty = false;
  private hoverAt: { x: number; y: number } | null = null;
  /** The mouse moved since the hover was last tested; under a still mouse it is tested every HOVER_EVERY frames. */
  private hoverDirty = false;
  private hoverAge = 0;
  readonly hits: HitTester;

  constructor(
    private readonly b: BattleView,
    private readonly view: View,
    private readonly screen: Screen,
  ) {
    this.hits = new HitTester(b, screen);
  }

  // ------------------------------------------------------------------------------------------ the gestures

  press(x: number, y: number, touchish: boolean): Pressed {
    this.touchish = touchish;
    const hit = this.hits.test(x, y, touchish);
    const ui = this.b.ui;
    this.pressHit = hit;
    this.prevSel = ui.selected;
    this.selectedNow = false;
    // pressing a company selects it at once
    if (hit.kind === 'company' && !hit.routing && ui.selected !== hit.squad) {
      this.select(hit.squad);
      this.selectedNow = true;
    }
    return { handle: hit.kind === 'company' || hit.kind === 'captain', captain: hit.kind === 'captain' };
  }

  strokeStart(): void {
    const hit = this.pressHit;
    if (!hit) return;
    const kind: StrokeKind = hit.kind === 'captain' ? 'captain' : hit.kind === 'company' && !hit.routing ? 'squad' : 'front';
    this.b.ui.stroke = { kind, squad: kind === 'squad' ? hit.squad : -1, points: [hit.ground], end: null, preview: null };
    // while a front is drawn, time runs at 0.3 (04-battle.md §1)
    if (kind === 'front') this.b.clock.drawing = true;
  }

  strokeMove(x: number, y: number): void {
    const st = this.b.ui.stroke;
    if (!st) return;
    const g = this.screen.ground(x, y);
    const last = st.points[st.points.length - 1];
    if (Math.hypot(g.x - last.x, g.y - last.y) >= STROKE_STEP) st.points.push(g);
    this.strokeAt = { x, y };
    this.strokeDirty = true;
  }

  release(x: number, y: number, tap: boolean): void {
    const st = this.b.ui.stroke;
    const hit = this.pressHit;
    this.b.ui.stroke = null;
    this.b.clock.drawing = false;
    this.strokeAt = null;
    this.pressHit = null;
    if (!hit) return;
    if (tap || !st) this.tap(hit);
    else this.finish(st.kind, st.squad, st.points, x, y, hit);
  }

  cancel(): void {
    const ui = this.b.ui;
    ui.stroke = null;
    this.b.clock.drawing = false;
    this.strokeAt = null;
    if (this.pressHit) {
      ui.selected = this.prevSel;
      if (this.prevSel !== null) ui.lapse = LAPSE_S;
    }
    this.pressHit = null;
  }

  hold(phase: 'start' | 'end'): void {
    inputHooks.onCaptainHold(phase);
  }

  pan(dx: number, dy: number): void {
    this.view.camera.panBy(dx, dy, this.view.renderer.size.px);
    this.b.follow = false;
  }

  zoom(step: number, x: number, y: number): void {
    const { w, h } = this.screen.size();
    this.view.camera.zoomAt(step, x - w / 2, y - h / 2, this.view.renderer.size.px);
  }

  twoFingerTap(): void {
    this.b.follow = true;
    this.deselect();
  }

  hover(x: number, y: number): void {
    this.hoverAt = { x, y };
    this.hoverDirty = true;
  }

  leave(): void {
    this.hoverAt = null;
    this.b.ui.hoverSquad = null;
    this.b.ui.hoverSite = null;
  }

  // ------------------------------------------------------------------------------------------ the orders

  /** 01-flow.md §2 "What a tap does". */
  tap(hit: Hit): void {
    const ui = this.b.ui;
    const sel = ui.selected;
    const who: Who = sel !== null ? { t: 'squad', id: sel } : { t: 'army' };
    switch (hit.kind) {
      case 'company':
        // a routing company takes no orders (tapping it would show its face); a second tap deselects
        if (hit.routing) return;
        if (this.selectedNow) ui.lapse = LAPSE_S;
        else if (sel === hit.squad) this.deselect();
        else this.select(hit.squad);
        return;
      case 'captain':
        // rally, or the selected company is called back
        if (sel !== null) this.order({ do: 'recall', id: sel }, 'tap');
        else this.order({ do: 'rally' }, 'tap');
        return;
      case 'flag':
        this.order({ do: 'recall', id: hit.squad }, 'tap');
        return;
      case 'enemy':
        this.order({ do: 'attack', who, target: hit.squad }, 'tap');
        return;
      case 'ground':
        if (hit.site >= 0) this.order({ do: 'take', who, site: hit.site }, 'tap');
        else this.order({ do: 'move', who, to: hit.ground, fight: false }, 'tap');
        return;
    }
  }

  /** 01-flow.md §2 "Strokes": a front from open ground, a drag from a company, a drag from the captain. */
  private finish(kind: StrokeKind, squad: number, points: P[], x: number, y: number, pressed: Hit): void {
    if (kind === 'front') {
      const line = simplify(points, FRONT_SIMPLIFY);
      if (lengthOf(line) < FRONT_TAP) this.tap(pressed);
      else this.order({ do: 'front', line }, 'line');
      return;
    }
    const end = this.hits.test(x, y, this.touchish);
    const route = simplify([...points, end.ground], ROUTE_SIMPLIFY);
    const via = route.slice(1, -1).slice(-ROUTE_KEEP);
    if (kind === 'captain') {
      this.order({ do: 'move', who: { t: 'army' }, to: end.ground, via, fight: false }, 'drag');
      return;
    }
    // what a company's drag ends on decides its order; the company leaves the army until called back
    const who: Who = { t: 'squad', id: squad };
    let deed: Deed;
    if (end.kind === 'enemy') deed = { do: 'attack', who, target: end.squad, via };
    else if (end.kind === 'captain') deed = { do: 'recall', id: squad };
    else if (end.kind === 'ground' && end.site >= 0) deed = { do: 'take', who, site: end.site, via };
    else deed = { do: 'move', who, to: end.ground, via, fight: false };
    this.order(deed, 'drag');
  }

  /** Gives an order; any order given uses up the selection. */
  private order(deed: Deed, src: 'tap' | 'drag' | 'line'): void {
    this.b.issue(deed, src);
    this.deselect();
  }

  select(id: number): void {
    this.b.ui.selected = id;
    this.b.ui.lapse = LAPSE_S;
  }

  deselect(): void {
    this.b.ui.selected = null;
  }

  // ------------------------------------------------------------------------------------------ every frame

  /** The selection's lapse, the stroke's end and ghost bars, and the mouse's hover, once a frame. */
  frame(dt: number): void {
    const b = this.b;
    const ui = b.ui;
    if (ui.selected !== null) {
      const state = squadBits.state(b.views.squadU32[ui.selected]);
      // an unused selection lapses (not while paused: the pause is for thinking); a broken company is let go
      if (!b.clock.paused) ui.lapse -= dt;
      if (ui.lapse <= 0 || state === ST_ROUTING || state >= ST_FLED) this.deselect();
    }
    const st = ui.stroke;
    if (st && this.strokeDirty && this.strokeAt) {
      this.strokeDirty = false;
      if (st.kind === 'front') st.preview = this.preview(st.points);
      else st.end = this.hits.test(this.strokeAt.x, this.strokeAt.y, this.touchish);
    }
    if (this.hoverAt && (this.hoverDirty || ++this.hoverAge >= HOVER_EVERY)) {
      this.hoverDirty = false;
      this.hoverAge = 0;
      const h = this.hits.test(this.hoverAt.x, this.hoverAt.y, false);
      ui.hoverSquad = h.kind === 'ground' ? null : h.squad;
      ui.hoverSite = h.kind === 'ground' && h.site >= 0 ? h.site : null;
    }
  }

  /** A front's ghost bars as the sim would plan it now (04-battle.md §4 "Preview while drawing"). */
  private preview(points: P[]): FrontPreview | null {
    const line = simplify(points, FRONT_SIMPLIFY);
    if (line.length < 2) return null;
    const json = this.b.sim.plan_front_preview(this.b.team, JSON.stringify(line));
    return json ? (JSON.parse(json) as FrontPreview) : null;
  }
}
