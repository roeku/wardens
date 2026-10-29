import { BattleView } from '../battle/battle';
import { Screen } from '../input/screen';
import { thresholds } from '../input/thresholds';
import { armyHorn, callFor, companyHorn } from '../sound/horns';
import { kindIcon, wayIcon, type CardSpec, type PictoColour } from '../view/cards';
import { FOG_SIGHT } from '../view/fog';
import type { LandData } from '../view/land-data';
import { MARK } from '../view/marks';
import { RoadSites } from '../view/places/road';
import type { App, Scene } from './app';
import { readState, type Campaign, type CampaignState, type CompanyState, type PlaceState, type Tally } from './campaign';
import { sceneInput, type SceneInput } from './gestures';
import { drawPlaceNames, fitCamera, clearNames, glowPlaces, placeHit, segDist } from './road-common';
import type { Hall } from './saves';
import { cheer } from './sounds';

// The road (docs/spec/01-flow.md §3.5, §3.8, §3.10; 03-land.md §9): the same 3D view on the road's map, as the
// campaign's peaceful battle (`road_battle()`), its places drawn as buildings of their kind. Reachable places glow
// with their name beside them; a tap on a place shows its card (who holds it, the garrison as kind × count, the
// broodlord's way), and a tap on a reachable place whose card is up sets out: the real column marches the road and
// arriving starts the battle. After a battle each banner tallies (losses count down in red at 0.11 s a man, joiners
// up in green, a new chevron pops on). At a camp a tap honours one company (+1 rank; its commander steps out to a
// horn and a cheer); a tap on a glowing place breaks camp. At the end the Hall of Banners is a place in this world.

/** 01-flow.md §3.5: the tally counts a man every 0.11 s. */
export const TALLY_S_PER_MAN = 0.11;
/** The tally's cards stay this long after the last count (chosen). */
const TALLY_HOLD_S = 1.6;
/** Arrived: the captain within this of the place, tiles (chosen: inside its glow). */
const ARRIVE_R = 2.6;
/** The march gives up walking and arrives after this many real seconds (chosen: a column stuck on the road). */
const MARCH_CAP_S = 24;
/** With no men on the road (no column to walk), the camera alone travels the road this long (chosen). */
const MARCH_EMPTY_S = 2.2;
/** The road's zoom (ZOOMS[3] = 13 art px per tile; chosen: a row of places and the column read together). */
const ROAD_ZOOM = 3;
/** How far a honoured commander steps out of his company's line, tiles (chosen). */
const STEP_OUT = 1.6;

export type RoadMode = 'map' | 'march' | 'camp' | 'hall';

export interface RoadHooks {
  /** The column arrived and the campaign is in 'battle'. */
  battle(): void;
  /** The campaign is over (won or lost): the chronicle. */
  end(): void;
  /** Saves between battles. */
  save(): void;
  /** The Hall: a tap away from its banners goes on (to the title). */
  leave(): void;
}

interface TallyCard {
  company: CompanyState;
  card: number;
  from: number;
  lost: number;
  joined: number;
  rankUp: boolean;
  /** Seconds since the tally began. */
  t: number;
  shown: string;
}

export class RoadScene implements Scene {
  readonly name: string;
  readonly top = 'play' as const;
  readonly play: BattleView;
  readonly sites: RoadSites;
  private readonly screen: Screen;
  private readonly input: SceneInput;
  state: CampaignState;
  mode: RoadMode;
  /** The march in progress: toward which place, for how long. */
  march: { place: PlaceState; t: number; empty: boolean } | null = null;
  private tally: TallyCard[] = [];
  private time = 0;
  /** The place whose card is up (a second tap on it sets out). */
  private picked: number | null = null;
  private card = -1;
  /** Honoured at this camp already. */
  honoured: number | null = null;
  private hall: Hall | null = null;

  constructor(
    private readonly app: App,
    land: LandData,
    readonly campaign: Campaign,
    private readonly hooks: RoadHooks,
    opts: { tally?: Tally | null; hall?: Hall | null } = {},
  ) {
    const view = app.view;
    view.setLand(land);
    this.state = roadState(campaign);
    this.mode = opts.hall ? 'hall' : this.state.phase === 'camp' ? 'camp' : this.state.phase === 'march' ? 'march' : 'map';
    this.honoured = this.state.honoured ?? null;
    this.name = this.mode === 'hall' ? 'hall' : this.mode === 'camp' ? 'camp' : 'road';
    this.play = new BattleView(view, campaign.road_battle(), app.memoryWasm, { pilot: false, enemy: '', figures: app.figures });
    this.play.overrideFog(new Uint8Array(land.w * land.h).fill(FOG_SIGHT));
    this.play.showSites = false;
    this.faces();
    this.screen = new Screen(view);
    const road = this.state.road;
    this.sites = new RoadSites(view, road.places.map((p) => ({ id: p.id, kind: p.kind, at: p.at, houses: p.houses, done: p.done })), road.hall, this.state.seed);
    this.sites.setProps(app.memory.props, this.state.seed);
    if (opts.hall) {
      this.hall = opts.hall;
      this.sites.setHall(opts.hall.fallen, opts.hall.colours);
    }
    this.play.marks.drawers.push((pen) => {
      if (this.mode === 'map' || this.mode === 'camp') glowPlaces(pen, this.state, this.time);
      if (this.picked !== null) {
        const p = this.place(this.picked);
        if (p) pen.ring(p.at, 2.9, { colour: p.reachable ? MARK.gold : MARK.cream, width: 0.1, dash: [0.5, 0.3] });
      }
    });
    view.dayT = this.mode === 'hall' ? 0.85 : 0.3;
    this.frameCamera();
    this.input = sceneInput(view, {
      tap: (x, y, touchish) => this.tap(x, y, touchish),
      panned: () => (this.play.follow = false),
    }, { pan: true, zoom: true });
    if (opts.tally) this.startTally(opts.tally);
    if (this.mode === 'march') this.resumeMarch();
  }

  /** Every commander's figure looks as on his card (the campaign's `face`, by squad). */
  private faces(): void {
    const faces: number[] = [];
    for (const c of this.state.warband.companies) {
      const sq = c.squad ?? c.id + 1;
      faces[sq] = c.face;
    }
    faces[0] = this.state.warband.captain.face;
    this.play.records.faces = faces;
  }

  private place(id: number | null): PlaceState | undefined {
    return this.state.road.places.find((p) => p.id === id);
  }

  /** The camera: over the Hall at the end, else over the warband and the places it can reach. */
  private frameCamera(): void {
    const st = this.state;
    const here = this.place(st.at)?.at ?? st.road.hall;
    if (this.mode === 'hall') {
      const h = st.road.hall;
      fitCamera(this.app.view, [{ x: h.x - 3, y: h.y - 4 }, { x: h.x + 4, y: h.y + 5 }], 6, 2);
      this.play.follow = false;
      return;
    }
    const pts = [here, ...st.road.places.filter((p) => p.reachable).map((p) => p.at)];
    fitCamera(this.app.view, pts, ROAD_ZOOM, 6);
    this.play.follow = false;
  }

  refresh(): void {
    this.state = roadState(this.campaign);
    for (const p of this.state.road.places) this.sites.paint({ id: p.id, kind: p.kind, at: p.at, houses: p.houses, done: p.done });
  }

  // ------------------------------------------------------------------------------------------- taps

  private tap(x: number, y: number, touchish: boolean): void {
    if (this.mode === 'march') return;
    if (this.mode === 'hall') return this.tapHall(x, y, touchish);
    // a company's banner: its card, or at a camp its honour
    const squad = this.bannerAt(x, y, touchish);
    if (squad !== null) {
      if (squad === 0) return this.showCard(this.kingCard(), x, y);
      const c = this.companyOfSquad(squad);
      if (!c) return;
      if (this.mode === 'camp' && this.honoured === null) return this.honour(c);
      return this.showCard(companyCard(c), x, y);
    }
    // a fallen company's banner planted on the road: its grey face
    const planted = this.plantedAt(x, y, touchish);
    if (planted) return this.showCard(planted, x, y);
    const id = placeHit(this.screen, this.sites, this.state, x, y, touchish, false);
    if (id === null) {
      this.picked = null;
      this.app.cards.hide(this.card);
      return;
    }
    const p = this.place(id)!;
    if (p.reachable && this.picked === id) return this.setOut(id);
    this.picked = id;
    this.showCard(this.placeCard(p), x, y);
  }

  private showCard(spec: CardSpec, x: number, y: number, life = 5): void {
    this.app.cards.hide(this.card);
    const right = x < this.screen.size().w / 2;
    this.card = this.app.cards.show(spec, { x, y, r: this.screen.tilePx * 1.2 }, right ? 'right' : 'left', { life });
  }

  /** Our company's banner under a CSS point (squad id; 0 the captain's), at the company reach. */
  private bannerAt(x: number, y: number, touchish: boolean): number | null {
    const reach = thresholds(touchish).companyReach;
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    let best: number | null = null;
    let bd = reach;
    for (const r of this.play.records.banners) {
      this.screen.project(r.x, r.h, r.y, a);
      this.screen.project(r.x, r.h + (r.captain ? 1.95 : 1.6), r.y, b);
      const d = segDist(x, y, a, b);
      if (d < bd) {
        bd = d;
        best = r.id;
      }
    }
    const cap = this.play.captain();
    if (cap) {
      const h = this.play.groundH(cap.x, cap.y);
      this.screen.project(cap.x, h, cap.y, a);
      this.screen.project(cap.x, h + 1.12, cap.y, b);
      if (segDist(x, y, a, b) < Math.min(bd, thresholds(touchish).kingReach)) best = 0;
    }
    return best;
  }

  private plantedAt(x: number, y: number, touchish: boolean): CardSpec | null {
    const reach = thresholds(touchish).reach;
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    for (const s of this.sites.standing) {
      if (s.side !== 'road') continue;
      const h = this.play.groundH(s.x, s.y);
      this.screen.project(s.x, h, s.y, a);
      this.screen.project(s.x, h + 1.3, s.y, b);
      if (segDist(x, y, a, b) > reach) continue;
      const prop = this.app.memory.props[s.i];
      if (!prop) continue;
      return { face: { face: prop.face ?? 1, side: 'warden', grey: true }, name: prop.name, picto: [{ icon: 'broken-sword', colour: 'grey' }, { icon: 'ribbon', n: prop.ribbons ?? 0, colour: 'grey' }], frame: 'grey' };
    }
    return null;
  }

  private companyOfSquad(squad: number): CompanyState | undefined {
    return this.state.warband.companies.find((c) => (c.squad ?? c.id + 1) === squad);
  }

  /** 07-progression.md §7: the place card — who holds it (face and way), the garrison as kind × count. */
  placeCard(p: PlaceState): CardSpec {
    const foe = p.foe !== null ? this.state.foes.find((f) => f.id === p.foe) : undefined;
    const picto: CardSpec['picto'] = [];
    if (p.kind === 'camp') picto.push({ icon: 'tent', colour: 'cream' });
    if (p.kind === 'village') picto.push({ icon: 'hall', n: p.houses ?? 0, colour: (p.houses ?? 0) > 0 ? 'cream' : 'grey' });
    if (!p.done) {
      if (foe) picto.push({ icon: wayIcon(foe.way), colour: 'red' });
      for (const g of p.garrison) picto.push({ icon: kindIcon(g.unit), n: g.n, colour: 'red' });
    }
    return {
      face: foe && !p.done ? { face: foe.face, side: 'blight', grey: foe.state === 'down' } : undefined,
      name: p.name,
      word: foe && !p.done ? foe.name : undefined,
      picto,
      frame: p.reachable ? 'gold' : undefined,
    };
  }

  /** 01-flow.md §3: the king card — hearts, battles, companies, men. */
  kingCard(): CardSpec {
    const st = this.state;
    const cap = st.warband.captain;
    const hearts = 5;
    const full = Math.round((cap.hp / Math.max(1, cap.hp_max)) * hearts);
    const picto: CardSpec['picto'] = [];
    for (let i = 0; i < hearts; i++) picto.push({ icon: i < full ? 'heart' : 'heart-empty', colour: 'red' });
    const battles = st.warband.companies.reduce((a, c) => Math.max(a, c.battles), 0);
    picto.push({ icon: 'swords', n: battles }, { icon: 'banner', n: st.warband.companies.length, colour: 'cream' }, { icon: 'man', n: st.warband.companies.reduce((a, c) => a + c.men, 0) });
    return { face: { face: cap.face, side: 'warden' }, name: cap.name, picto, frame: 'gold' };
  }

  // ------------------------------------------------------------------------------------------- the march

  /** Sets out for a reachable place (breaking camp first): the column marches the road. */
  setOut(id: number): void {
    const p = this.place(id);
    if (!p || !p.reachable) return;
    this.app.cards.hide(this.card);
    this.picked = null;
    if (this.state.phase === 'camp') this.campaign.break_camp();
    this.campaign.set_out(id);
    this.hooks.save();
    this.refresh();
    this.mode = 'march';
    this.startMarch(p);
  }

  private resumeMarch(): void {
    // a march kept in a save: its place is the one the column was bound for, if the campaign says; else go on
    const p = this.place(this.state.to ?? this.state.at) ?? null;
    if (p) this.startMarch(p);
    else this.arrive();
  }

  private startMarch(p: PlaceState): void {
    const empty = this.play.sim.soldier_count() === 0;
    console.log(`[road] marching to ${p.name} (${p.kind})${empty ? ', no column' : ''}`);
    this.march = { place: p, t: 0, empty };
    if (!empty) {
      this.play.clock.fast = true;
      this.play.issue({ do: 'with', how: { pace: 'quick' }, deed: { do: 'move', who: { t: 'army' }, to: p.at, fight: false } }, 'tap');
      this.play.follow = true;
    }
    armyHorn();
  }

  private arrive(): void {
    const m = this.march;
    this.march = null;
    this.play.clock.fast = false;
    this.campaign.arrive();
    this.refresh();
    console.log(`[road] arrived at ${this.place(this.state.at)?.name ?? '?'} after ${m ? m.t.toFixed(1) : 0} s: ${this.state.phase}`);
    if (this.state.phase === 'battle') return this.hooks.battle();
    if (this.state.phase === 'camp') {
      this.mode = 'camp';
      this.honoured = null;
      this.hooks.save();
      this.frameCamera();
      return;
    }
    this.mode = 'map';
  }

  // ------------------------------------------------------------------------------------------- camp

  /** 01-flow.md §3.8: +1 rank; the commander steps out to a horn and a cheer. */
  honour(c: CompanyState): void {
    if (this.honoured !== null || this.state.phase !== 'camp') return;
    this.campaign.honour(c.id);
    this.honoured = c.id;
    this.hooks.save();
    this.refresh();
    const squad = c.squad ?? c.id + 1;
    const at = this.play.squadCentre(squad);
    if (at) {
      // a step out toward the camera (south-west), with a gold ring where he stood
      this.play.issue({ do: 'move', who: { t: 'squad', id: squad }, to: { x: at.x - STEP_OUT * Math.SQRT1_2, y: at.y + STEP_OUT * Math.SQRT1_2 }, fight: false }, 'tap');
      this.play.marks.ring(at, 1.6, MARK.gold, { life: 1.2, close: true, width: 0.2 });
      const ear = { x: this.app.view.camera.focus.x, y: this.app.view.camera.focus.y, half: 12 };
      companyHorn(callFor(c.name, this.state.warband.companies.map((k) => k.name)), false, at.x, at.y, ear);
    }
    cheer(0.35, 0.6);
    const now = readState(this.campaign).warband.companies.find((k) => k.id === c.id) ?? c;
    const b = squad !== null ? this.play.bannerOf(squad) : null;
    const p = b ? this.screen.project(b.x, b.h + 1.6, b.y, { x: 0, y: 0 }) : { x: this.screen.size().w / 2, y: this.screen.size().h / 2 };
    this.showCard({ ...companyCard(now), frame: 'gold' }, p.x, p.y, 3.5);
  }

  // ------------------------------------------------------------------------------------------- the tally

  /** 01-flow.md §3.5: each banner tallies its losses and joiners, and a new chevron pops on. */
  private startTally(t: Tally): void {
    for (const k of t.companies) {
      if (k.fell) continue;
      const c = this.state.warband.companies.find((x) => x.id === k.id);
      if (!c) continue;
      const from = c.men + k.lost - k.joined;
      this.tally.push({ company: c, card: -1, from, lost: k.lost, joined: k.joined, rankUp: k.rank_up, t: -0.6, shown: '' });
    }
  }

  private tallySpec(k: TallyCard): CardSpec {
    const down = Math.min(k.lost, Math.max(0, Math.floor(k.t / TALLY_S_PER_MAN)));
    const tUp = k.t - k.lost * TALLY_S_PER_MAN;
    const up = Math.min(k.joined, Math.max(0, Math.floor(tUp / TALLY_S_PER_MAN)));
    const n = k.from - down + up;
    const colour: PictoColour = up > 0 ? 'green' : down > 0 ? 'red' : 'cream';
    const picto: CardSpec['picto'] = [{ icon: 'man', n, colour }];
    const counted = k.t >= (k.lost + k.joined) * TALLY_S_PER_MAN;
    const rank = k.company.rank - (k.rankUp && !counted ? 1 : 0);
    if (rank > 0) picto.push({ icon: 'chevron', n: rank, colour: 'gold' });
    return { name: k.company.name, picto, frame: k.rankUp && counted ? 'gold' : undefined };
  }

  private stepTally(dt: number): void {
    if (this.tally.length === 0) return;
    let done = true;
    for (const k of this.tally) {
      k.t += dt;
      if (k.t < 0) {
        done = false;
        continue;
      }
      const spec = this.tallySpec(k);
      const key = JSON.stringify(spec);
      const squad = k.company.squad ?? k.company.id + 1;
      const b = this.play.bannerOf(squad);
      const at = b ? this.screen.project(b.x, b.h + 1.7, b.y, { x: 0, y: 0 }) : null;
      if (k.card < 0) {
        const p = at ?? { x: 40 + this.tally.indexOf(k) * 90, y: 60 };
        k.card = this.app.cards.show(spec, p, 'right');
        k.shown = key;
      } else {
        if (key !== k.shown) {
          this.app.cards.update(k.card, spec);
          k.shown = key;
        }
        if (at) this.app.cards.move(k.card, at);
      }
      if (k.t < (k.lost + k.joined) * TALLY_S_PER_MAN + TALLY_HOLD_S) done = false;
    }
    if (done) {
      for (const k of this.tally) this.app.cards.hide(k.card);
      this.tally = [];
    }
  }

  /** Whether a tally is still counting (the dev hooks wait for it). */
  get tallying(): boolean {
    return this.tally.length > 0;
  }

  // ------------------------------------------------------------------------------------------- the Hall

  private tapHall(x: number, y: number, touchish: boolean): void {
    const reach = thresholds(touchish).reach;
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    let best: { side: string; i: number } | null = null;
    let bd = reach;
    for (const s of this.sites.standing) {
      if (s.side === 'road') continue;
      const h = this.play.groundH(s.x, s.y);
      this.screen.project(s.x, h, s.y, a);
      this.screen.project(s.x, h + 1.3, s.y, b);
      const d = segDist(x, y, a, b);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best || !this.hall) {
      this.app.cards.hide(this.card);
      this.hooks.leave();
      return;
    }
    const f = best.side === 'fallen' ? this.hall.fallen[best.i] : this.hall.colours[best.i];
    if (!f) return;
    const spec: CardSpec =
      best.side === 'fallen'
        ? { face: { face: f.face, side: 'warden', grey: true }, name: f.name, picto: [{ icon: wayIcon(f.way ?? 'steady') }, { icon: 'chevron', n: f.rank ?? 0, colour: 'gold' }], frame: 'grey' }
        : { face: { face: f.face, side: 'blight', grey: true }, name: f.name, picto: [{ icon: 'pennant', colour: 'red' }] };
    this.showCard(spec, x, y, 6);
  }

  // ------------------------------------------------------------------------------------------- each frame

  frame(dt: number): void {
    this.time += dt;
    const play = this.play;
    play.frame(dt);
    if (!play.clock.paused) this.app.view.time += dt;
    if (this.mode !== 'hall') this.app.view.dayT = 0.3;
    else this.app.view.dayT = 0.85;
    this.sites.update();
    this.stepTally(dt);
    const m = this.march;
    if (m) {
      m.t += dt;
      if (m.empty) {
        // no column to walk: the camera travels the road alone
        this.app.view.camera.easeTo(m.place.at.x, m.place.at.y, dt, 2.5);
        if (m.t >= MARCH_EMPTY_S) this.arrive();
      } else {
        const cap = play.captain();
        const near = cap && Math.hypot(cap.x - m.place.at.x, cap.y - m.place.at.y) < ARRIVE_R;
        if (near || m.t >= MARCH_CAP_S) this.arrive();
      }
    }
  }

  rendered(): void {
    const L = this.app.ui;
    if (this.mode === 'map' || this.mode === 'camp') drawPlaceNames(L, this.screen, this.sites, this.state, false, this.app.view);
    else clearNames(L);
  }

  /** For the dev hooks: where each place, banner and the captain stand on screen (client pixels). */
  onScreen(): {
    places: { id: number; name: string; reachable: boolean; x: number; y: number }[];
    banners: { squad: number; x: number; y: number }[];
    standing: { side: string; i: number; x: number; y: number }[];
  } {
    const r = this.app.view.canvas.getBoundingClientRect();
    const p = { x: 0, y: 0 };
    return {
      standing: this.sites.standing.map((b) => {
        this.screen.project(b.x, this.play.groundH(b.x, b.y) + 0.9, b.y, p);
        return { side: b.side, i: b.i, x: p.x + r.left, y: p.y + r.top };
      }),
      places: this.state.road.places.map((pl) => {
        const top = this.sites.placeTop(pl.id)!;
        this.screen.project(top.x, (top.y + this.sites.footY(pl.id)) / 2, top.z, p);
        return { id: pl.id, name: pl.name, reachable: pl.reachable, x: p.x + r.left, y: p.y + r.top };
      }),
      banners: this.play.records.banners.map((b) => {
        this.screen.project(b.x, b.h + 1.2, b.y, p);
        return { squad: b.id, x: p.x + r.left, y: p.y + r.top };
      }),
    };
  }

  dispose(): void {
    this.input.dispose();
    this.app.cards.hide();
    this.sites.dispose();
    this.play.dispose();
  }
}

/**
 * The campaign's state as the road shows it: at a camp no place is reachable until camp is broken, so the places the
 * camp links to are shown as the next ones (they glow, and a tap on one breaks camp and sets out).
 */
function roadState(c: Campaign): CampaignState {
  const st = readState(c);
  if (st.phase === 'camp') {
    const here = st.road.places.find((p) => p.id === st.at);
    for (const p of st.road.places) p.reachable = !!here && here.links.includes(p.id);
  }
  return st;
}

/** 01-flow.md §3 "Company card": rank chevrons, battle ribbons, last battle's losses (red) and joiners (green), the
 * enemy commanders taken (pennants), and its men. */
export function companyCard(c: CompanyState, grey = false): CardSpec {
  const picto: CardSpec['picto'] = [{ icon: kindIcon(c.unit) }, { icon: 'man', n: c.men }];
  if (c.rank > 0) picto.push({ icon: 'chevron', n: c.rank, colour: 'gold' });
  if (c.battles > 0) picto.push({ icon: 'ribbon', n: c.battles, colour: 'cream' });
  if (c.last && c.last.lost > 0) picto.push({ icon: 'man', n: c.last.lost, colour: 'red' });
  if (c.last && c.last.joined > 0) picto.push({ icon: 'man', n: c.last.joined, colour: 'green' });
  if (c.colours.length > 0) picto.push({ icon: 'pennant', n: c.colours.length, colour: 'red' });
  return { face: { face: c.face, side: 'warden', grey, unit: c.unit }, name: c.name, picto, frame: grey ? 'grey' : c.rank >= 3 ? 'gold' : undefined };
}
