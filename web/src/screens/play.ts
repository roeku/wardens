import { BattleView } from '../battle/battle';
import { Screen } from '../input/screen';
import { rect } from '../view/cards';
import { hash32 } from '../view/figures/hash';
import { drawText, GLYPH_H, measure } from '../view/font5x7';
import { FOG_SIGHT } from '../view/fog';
import type { LandData } from '../view/land-data';
import { RoadSites } from '../view/places/road';
import type { App, Scene } from './app';
import { BattleScene } from './battle-scene';
import { campaignApi, readState, type Campaign, type Chronicle, type HallAdds, type Tally } from './campaign';
import { ChronicleScene } from './chronicle';
import { darkCloth, GOLD, gonfalon, inside, type Box } from './cloth';
import type { Flow } from './flow';
import { sceneInput, type SceneInput } from './gestures';
import { MusterScene } from './muster';
import { RoadScene, companyCard } from './road';
import { fitCamera } from './road-common';
import { emptyMemory, saves, type Hall } from './saves';
import { propSpots } from '../view/places/road';

// The campaign's scenes and how they follow (docs/spec/01-flow.md §3.2, §3.4–§3.10, §5): the campaign card over the
// hall → the muster → the road (march) → the battle → the road again with the tally (or camp) → … → the chronicle →
// the Hall of Banners → the title. The campaign is saved between battles only.

/** 01-flow.md §3.2: one card per campaign. The Wardens' title, year and one-line blurb (out/decisions-d5-screens.md). */
export const CAMPAIGNS = [{ key: 'warden', title: 'THE WARDENS', year: '1123', blurb: 'FREE THE VALE OF THE BLIGHT' }] as const;
/** 01-flow.md §1: 4 companies, 9 in big-army mode (`?army=big`). */
const BANNERS = { default: 4, big: 9 } as const;
/** 03-land.md §7 "Campaign props": one cairn per 3 fallen men. */
const MEN_PER_CAIRN = 3;

export class Play {
  constructor(readonly flow: Flow) {}

  get app(): App {
    return this.flow.app;
  }

  private campaign(): Campaign {
    const c = this.app.campaign;
    if (!c) throw new Error('no campaign');
    return c;
  }

  /** The road's land, made from its peaceful battle (in the worker, kept by key). */
  private roadLand(c: Campaign): Promise<LandData> {
    const rb = c.road_battle();
    const p = this.app.lands.of(rb);
    rb.free();
    return p;
  }

  /** Saves the campaign (only between battles) with the screens' memory of its road. */
  save(): void {
    const c = this.app.campaign;
    if (!c) return;
    try {
      const st = readState(c);
      if (st.phase === 'battle') return;
      saves.keepCampaign(c.save(), st.campaign, this.app.memory);
      saves.setLastCampaign(st.campaign);
    } catch (e) {
      console.warn('[play] the campaign could not be saved', e);
    }
  }

  /** A new campaign's seed: `?seed=`, else the count of campaigns begun, hashed. */
  private newSeed(): number {
    const q = this.app.params.get('seed');
    if (q !== null) return Number(q);
    const s = saves.settings();
    const n = (typeof s.campaigns === 'number' ? s.campaigns : 0) + 1;
    saves.setSettings({ ...s, campaigns: n });
    return hash32(n, 91, 7) % 100000;
  }

  // ------------------------------------------------------------------------------------------- the scenes

  /** 01-flow.md §3.2: the campaign card standing over the hall; a tap on it begins the muster. */
  async cards(): Promise<void> {
    const api = campaignApi();
    if (!api) return;
    const banners = this.app.params.get('army') === 'big' ? BANNERS.big : BANNERS.default;
    const c = api.create(this.newSeed(), JSON.stringify({ campaign: CAMPAIGNS[0].key, banners }));
    this.app.campaign?.free();
    this.app.campaign = c;
    this.app.memory = emptyMemory();
    await this.app.go(async () => {
      const land = await this.roadLand(c);
      return () => new CardsScene(this.app, land, c, { begin: () => void this.muster(), back: () => void this.flow.title() });
    });
  }

  /** Resumes a kept campaign at its phase. */
  async resume(c: Campaign): Promise<void> {
    const st = readState(c);
    switch (st.phase) {
      case 'muster':
        return this.muster();
      case 'battle':
        return this.battle();
      case 'won':
      case 'lost':
        return this.chronicle();
      default:
        return this.road(null);
    }
  }

  async muster(): Promise<void> {
    const c = this.campaign();
    await this.app.go(async () => {
      const land = await this.roadLand(c);
      return () =>
        new MusterScene(this.app, land, c, (place) => {
          c.set_out(place);
          this.save();
          void this.road(null);
        });
    });
  }

  async road(tally: Tally | null): Promise<void> {
    const c = this.campaign();
    await this.app.go(async () => {
      const land = await this.roadLand(c);
      return () =>
        new RoadScene(this.app, land, c, {
          battle: () => void this.battle(),
          end: () => void this.chronicle(),
          save: () => this.save(),
          leave: () => void this.flow.title(),
        }, { tally });
    });
  }

  /** The battle at the current place (refought from its start if it was left unfinished). */
  async battle(): Promise<void> {
    const c = this.campaign();
    const st = readState(c);
    const place = st.road.places.find((p) => p.id === st.at);
    const foe = place?.foe != null ? st.foes.find((f) => f.id === place.foe) : undefined;
    await this.app.go(async () => {
      const t0 = performance.now();
      const battle = c.battle();
      const t1 = performance.now();
      const land = await this.app.lands.of(battle);
      console.log(`[campaign] the battle at ${place?.name} (${place?.kind}): made in ${(t1 - t0).toFixed(0)} ms, its land ${(performance.now() - t1).toFixed(0)} ms`);
      return () => {
        const scene = new BattleScene(this.app, {
          battle,
          land,
          tier: this.flow.tier,
          pilot: this.app.pilot,
          enemy: '',
          then: (s) => this.finish(s),
          foe: foe && foe.state !== 'down' ? { way: foe.way, name: foe.name } : null,
          companyCard: (squad) => {
            const k = st.warband.companies.find((x) => (x.squad ?? x.id + 1) === squad);
            return k ? companyCard(k) : null;
          },
          voice: 'if-disposable',
          name: 'battle',
        });
        // every commander's figure as on his card
        const faces: number[] = [];
        for (const k of st.warband.companies) faces[k.squad ?? k.id + 1] = k.face;
        faces[0] = st.warband.captain.face;
        if (scene.play.records.faces.length === 0) scene.play.records.faces = faces;
        return scene;
      };
    });
  }

  /** The battle is over: its outcome applied, the land remembers, the campaign saved, and on to the road. */
  private finish(scene: BattleScene): void {
    const c = this.campaign();
    const before = readState(c);
    const tally = JSON.parse(c.finish(scene.play.sim)) as Tally;
    const st = readState(c);
    this.remember(before, tally);
    this.save();
    console.log(`[campaign] ${tally.won ? 'won' : 'lost'} (${tally.reason}) at ${before.road.places.find((p) => p.id === before.at)?.name}; phase ${st.phase}`);
    if (st.phase === 'won' || st.phase === 'lost') void this.chronicle();
    else void this.road(tally);
  }

  /** 03-land.md §7 "Campaign props": a cairn per 3 men fallen at a place, a planted banner per company destroyed. */
  private remember(before: ReturnType<typeof readState>, tally: Tally): void {
    const at = before.road.places.find((p) => p.id === before.at);
    if (!at) return;
    const m = this.app.memory;
    const key = String(at.id);
    const was = m.dead[key] ?? 0;
    const lost = tally.companies.reduce((a, k) => a + k.lost, 0);
    m.dead[key] = was + lost;
    const cairns = Math.floor(m.dead[key] / MEN_PER_CAIRN) - Math.floor(was / MEN_PER_CAIRN);
    const fell = tally.companies.filter((k) => k.fell).map((k) => before.warband.companies.find((x) => x.id === k.id)).filter((x) => !!x);
    const already = m.props.filter((p) => p.place === at.id).length;
    const spots = propSpots(at.at, cairns, fell.length, before.seed + at.id, already);
    let b = 0;
    for (const s of spots) {
      if (s.kind === 'banner') {
        const k = fell[b++]!;
        m.props.push({ ...s, kind: 'banner', place: at.id, name: k.name, face: k.face, ribbons: k.battles + 1 });
      } else m.props.push({ ...s, kind: 'cairn', place: at.id });
    }
  }

  async chronicle(): Promise<void> {
    const c = this.campaign();
    const chron = JSON.parse(c.chronicle_json()) as Chronicle;
    await this.app.go(async () => {
      const land = await this.roadLand(c);
      return () => new ChronicleScene(this.app, land, c, chron, () => void this.hall());
    });
  }

  /** The Hall of Banners: this campaign's fallen and colours added to the Hall kept for the campaign. */
  async hall(): Promise<void> {
    const c = this.campaign();
    const adds = JSON.parse(c.hall_json()) as HallAdds;
    const key = adds.campaign || 'warden';
    const kept = this.app.params.has('nohall') ? saves.hall(key) : saves.addToHall(key, { fallen: adds.fallen, colours: adds.colours });
    // the campaign is over: its save goes
    saves.dropCampaign();
    await this.app.go(async () => {
      const land = await this.roadLand(c);
      return () =>
        new RoadScene(this.app, land, c, {
          battle: () => {},
          end: () => {},
          save: () => {},
          leave: () => void this.flow.title(),
        }, { hall: kept as Hall });
    });
  }
}

// ------------------------------------------------------------------------------------------------ the card

/** The campaign card over the road's hall (01-flow.md §3.2): a title, a year and a one-line blurb. */
class CardsScene implements Scene {
  readonly name = 'cards';
  readonly top = 'setup' as const;
  readonly play: BattleView;
  private readonly sites: RoadSites;
  private readonly input: SceneInput;
  private card: Box = { x: 0, y: 0, w: 0, h: 0 };
  private back: Box = { x: 0, y: 0, w: 0, h: 0 };
  private pressed = '';
  private hallTop = { x: 0, y: 0, z: 0 };
  private readonly screen: Screen;

  constructor(
    private readonly app: App,
    land: LandData,
    c: Campaign,
    private readonly on: { begin(): void; back(): void },
  ) {
    const view = app.view;
    view.setLand(land);
    const st = readState(c);
    this.screen = new Screen(view);
    this.play = new BattleView(view, c.road_battle(), app.memoryWasm, { pilot: false, enemy: '', figures: app.figures });
    this.play.overrideFog(new Uint8Array(land.w * land.h).fill(FOG_SIGHT));
    this.play.showSites = false;
    this.play.follow = false;
    this.sites = new RoadSites(view, st.road.places.map((p) => ({ id: p.id, kind: p.kind, at: p.at, houses: p.houses, done: p.done })), st.road.hall, st.seed);
    const h = st.road.hall;
    this.hallTop = { x: h.x, y: this.play.groundH(h.x, h.y) + 1.8, z: h.y };
    fitCamera(view, [{ x: h.x - 4, y: h.y - 4 }, { x: h.x + 6, y: h.y + 5 }], 5, 2, -0.12);
    const hit = (x: number, y: number) => {
      const p = app.ui.toUi(x, y);
      return inside(this.card, p.x, p.y, 2) ? 'card' : inside(this.back, p.x, p.y, 2) ? 'back' : '';
    };
    this.input = sceneInput(view, {
      press: (x, y) => void (this.pressed = hit(x, y)),
      tap: (x, y) => {
        const what = hit(x, y);
        this.pressed = '';
        if (what === 'card') this.on.begin();
        else if (what === 'back') this.on.back();
      },
      cancel: () => void (this.pressed = ''),
      dragEnd: () => void (this.pressed = ''),
    }, { pan: false, zoom: false });
  }

  frame(dt: number): void {
    this.play.frame(dt);
    this.app.view.time += dt;
    this.app.view.dayT = 0.55;
    this.sites.update();
  }

  /** The card and FIGHT-like back banner's middles, client pixels (the dev hooks). */
  targets(): { card: { x: number; y: number }; back: { x: number; y: number } } {
    const k = this.app.ui.k;
    const r = this.app.view.canvas.getBoundingClientRect();
    const mid = (b: Box) => ({ x: (b.x + b.w / 2) * k + r.left, y: (b.y + b.h / 2) * k + r.top });
    return { card: mid(this.card), back: mid(this.back) };
  }

  rendered(): void {
    const L = this.app.ui;
    L.clear();
    const g = L.ctx;
    const k = CAMPAIGNS[0];
    // the card stands over the hall: its foot just above the roof
    const p = this.screen.project(this.hallTop.x, this.hallTop.y, this.hallTop.z, { x: 0, y: 0 });
    const foot = L.toUi(p.x, p.y);
    const tw = Math.max(measure(k.title) * 2, measure(k.blurb)) + 16;
    const th = 7 * 2 + 4 + GLYPH_H + 4 + GLYPH_H + 14;
    const box: Box = { x: Math.round(Math.max(2, Math.min(L.w - tw - 2, foot.x - tw / 2))), y: Math.max(2, foot.y - th - 6), w: tw, h: th };
    const down = this.pressed === 'card' ? 1 : 0;
    darkCloth(g, { ...box, y: box.y + down }, 'gold');
    let y = box.y + 7 + down;
    drawText(g, k.title, box.x + Math.round((tw - measure(k.title) * 2) / 2), y, '#f1ead6', 2);
    y += GLYPH_H * 2 + 4;
    drawText(g, k.year, box.x + Math.round((tw - measure(k.year)) / 2), y, GOLD);
    y += GLYPH_H + 4;
    drawText(g, k.blurb, box.x + Math.round((tw - measure(k.blurb)) / 2), y, '#d8cfb4');
    // the card's string down to the hall's roof
    rect(g, foot.x, box.y + box.h + down, 1, Math.max(0, foot.y - box.y - box.h - down), '#7a5634');
    this.card = box;
    const bw = Math.max(Math.ceil(24 / L.u), 16);
    this.back = gonfalon(g, 4, 6, bw, Math.max(24, Math.ceil(24 / L.u)), '<', { ramp: 'linen', device: '#6b5a40', down: this.pressed === 'back' });
  }

  dispose(): void {
    this.input.dispose();
    this.sites.dispose();
    this.play.dispose();
  }
}

/** Puts the campaign's scenes into the flow; returns them for the dev hooks. */
export function installPlay(flow: Flow): Play {
  const p = new Play(flow);
  flow.play = { cards: () => p.cards(), resume: (c) => p.resume(c) };
  flow.playScenes = p;
  return p;
}

