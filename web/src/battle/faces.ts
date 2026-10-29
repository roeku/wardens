import { EventCode, SOLDIER_F32, SQUAD_F32, soldierBits, squadBits, KIND_ORDER, squadUnit, type SimEvent } from '../contracts';
import { Screen } from '../input/screen';
import { Cards, type CardSpec } from '../view/cards';
import { Figures, type BannerRecord } from '../view/figures';
import { hash32 } from '../view/figures/hash';
import { FOG_NEVER } from '../view/fog';
import type { View } from '../view/view';
import type { BattleView } from './battle';
import { FALL_FOES_S, FALL_OURS_S } from './clock';

// The battle's face moments (docs/spec/01-flow.md §3.6; contract campaign §6):
// - every commander's figure takes its looks from the company's `face` (Records.faces), as the portraits do;
// - the enemy commander's face card shows the first time their company comes into sight;
// - when a commander falls: the slow-motion moment (the clock's fall hold, battle.ts), their grey face where they fell,
//   and their banner planted at the spot for the rest of the battle.
// Chosen numbers: out/decisions-d5-faces.md "Face moments".

/** Real seconds a first-sight card stays (then it fades in 1/6 s, cards.ts). */
const SIGHT_CARD_S = 3;
/** Real seconds the grey face stays where a commander fell, past the clock's slow hold. */
const FALL_CARD_S = 1.8;
/** The planted banner stands this far to the fallen's left (tiles), as a bearer's does (records.ts). */
const PLANT_LEFT = 0.3;
/** The cards' layer sits over the scene's own cards (screens' App.cards, z 20). */
const CARD_Z = 21;

type Side = 'warden' | 'blight';
interface Info {
  id: number;
  team: number;
  kind: string;
  unit: string;
  name: string;
  captain: boolean;
  /** Contract campaign §3 `face`: the commander's look, 0 to derive it from the id. */
  face?: number;
}

/**
 * The face seed of a company's commander: the campaign's `face`, or for a company without one (0, or a sim without
 * the field) a seed from the squad id, so the figure and the portrait still agree.
 */
export function faceSeed(info: { id: number; face?: number }): number {
  return info.face && info.face > 0 ? info.face >>> 0 : hash32(info.id, 0xfa, 0xce) || 1;
}

/** Whether a company's commander has a face to show: ours named or the captain; the enemy's with a face, or its lord. */
function hasFace(i: Info): boolean {
  if (i.team === 0) return i.captain || i.name.length > 0;
  return (i.face ?? 0) > 0 || i.captain;
}

/** The planted banners (one figure layer for every battle, kept like the materials). */
let plantedFigures: Figures | null = null;

export function installFaces(play: BattleView, view: View): { dispose(): void } {
  const screen = new Screen(view);
  const cards = new Cards(view, CARD_Z);
  const planted = (plantedFigures ??= new Figures());
  view.scene.add(planted.group);
  const banners: BannerRecord[] = [];
  const seen = new Set<number>();
  /** Shown cards: id → the world point they stand beside. */
  const anchored = new Map<number, { x: number; y: number; h: number; squad: number | null }>();
  const pending: { squad: number; x: number; y: number }[] = [];
  let infos: Info[] = [];
  /** The view's clock (real seconds, standing still while paused): the cards keep time with the game's frames. */
  let last = view.time;
  const out = { x: 0, y: 0 };

  const sideOf = (i: Info): Side => (i.team === 0 ? 'warden' : 'blight');
  const spec = (i: Info, grey: boolean): CardSpec => ({
    face: { face: faceSeed(i), side: sideOf(i), grey, unit: i.team === 0 ? i.unit : undefined },
    name: i.name || undefined,
    frame: grey ? 'grey' : undefined,
  });

  /** Every company's face seed, for the figures (records.ts), whenever the companies change. */
  const syncInfo = () => {
    if (infos === (play.squadInfo as unknown as Info[])) return;
    infos = play.squadInfo as unknown as Info[];
    play.records.faces = infos.map((i) => faceSeed(i));
  };

  const at = (x: number, h: number, y: number) => screen.project(x, h, y, out);
  const onScreen = (p: { x: number; y: number }) => {
    const { w, h } = screen.size();
    return p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
  };

  /** The enemy commanders' first sight: their banner drawn (so in sight) and on screen. */
  const firstSight = () => {
    for (const i of infos) {
      if (i.team === 0 || seen.has(i.id) || !hasFace(i)) continue;
      const b = play.bannerOf(i.id);
      if (!b) continue;
      const p = at(b.x, b.h + 1, b.y);
      if (!onScreen(p)) continue;
      seen.add(i.id);
      const id = cards.show(spec(i, false), { ...p, r: screen.tilePx * 0.8 }, p.x < screen.size().w / 2 ? 'right' : 'left', { life: SIGHT_CARD_S });
      anchored.set(id, { x: b.x, y: b.y, h: b.h + 1, squad: i.id });
    }
  };

  /** Where a company's commander lies: his soldier's spot (the sim's buffers, whatever the fog), else the event's. */
  const fallSpot = (squad: number, ex: number, ey: number): { x: number; y: number; face: number } => {
    const v = play.views;
    v.refresh();
    const n = play.sim.soldier_count();
    for (let k = 0; k < n; k++) {
      const w = v.u32[k];
      if (soldierBits.squad(w) !== squad || !(soldierBits.commander(w) || soldierBits.captain(w))) continue;
      const o = k * SOLDIER_F32.FIELDS;
      return { x: v.f32[o + SOLDIER_F32.X], y: v.f32[o + SOLDIER_F32.Y], face: v.f32[o + SOLDIER_F32.FACE] };
    }
    return { x: ex, y: ey, face: v.squadF32[squad * SQUAD_F32.FIELDS + SQUAD_F32.FACE] };
  };

  /** A commander fell: his grey face where he fell, his banner planted there. */
  const fall = (squad: number, ex: number, ey: number) => {
    const i = infos[squad];
    if (!i || !hasFace(i)) return;
    const s = fallSpot(squad, ex, ey);
    const v = play.views;
    const bits = v.squadU32[squad];
    const team = squadBits.team(bits);
    const kind = KIND_ORDER[squadBits.kind(bits)];
    const size = squadBits.full(bits);
    const px = s.x + Math.sin(s.face) * PLANT_LEFT;
    const py = s.y - Math.cos(s.face) * PLANT_LEFT;
    const h = play.groundH(px, py);
    banners.push({
      id: squad, x: px, y: py, h, face: s.face, speed: 0, heart: 1, lost: Math.max(0, size - squadBits.alive(bits)), size,
      rank: squadBits.rank(bits), honours: 0, kind, unit: squadUnit(v.squadUnit[squad]), team, linen: kind === 'levy' && team === 0 && squadBits.rank(bits) < 2,
      captain: kind === 'captain', routing: false, selected: false, hover: false, unfurl: 1,
    });
    const p = at(s.x, play.groundH(s.x, s.y) + 0.6, s.y);
    const life = play.clock.fallHold + FALL_CARD_S;
    const id = cards.show(spec(i, true), { ...p, r: screen.tilePx * 0.6 }, p.x < screen.size().w / 2 ? 'right' : 'left', { life });
    anchored.set(id, { x: s.x, y: s.y, h: play.groundH(s.x, s.y) + 0.6, squad: null });
  };

  const listener = (e: SimEvent) => {
    if (e.code === EventCode.CommanderFall || e.code === EventCode.FoeCommanderFall) pending.push({ squad: e.a, x: e.x, y: e.y });
  };
  play.listeners.push(listener);

  // Called just before the view draws, after the battle's own figures: the cards and the planted banners follow the
  // camera as it is now.
  const before = view.beforeDraw;
  const hook = () => {
    before?.();
    const dt = Math.max(0, Math.min(0.1, view.time - last));
    last = view.time;
    syncInfo();
    // the fall events arrive during the step; the moment is shown once the frame's records are built
    while (pending.length) {
      const f = pending.shift()!;
      fall(f.squad, f.x, f.y);
    }
    firstSight();
    for (const [id, a] of anchored) {
      if (!cards.has(id)) {
        anchored.delete(id);
        continue;
      }
      const b = a.squad !== null ? play.bannerOf(a.squad) : null;
      cards.move(id, b ? at(b.x, b.h + 1, b.y) : at(a.x, a.h, a.y));
    }
    const { aw, ah } = view.renderer.size;
    const sc = view.sun.light.shadow.camera;
    const cam = view.camera;
    // a planted banner of the enemy's stands where the ground has been seen (the fog tints it like any figure)
    const fog = play.fogOverride ?? play.views.fog;
    const shown = banners.filter((b) => b.team === 0 || fog[Math.floor(b.y) * view.land.w + Math.floor(b.x)] !== FOG_NEVER);
    planted.update({
      men: [],
      banners: shown,
      dt,
      time: view.time,
      zoom: cam.s,
      screen: { origin: cam.origin, halfW: (aw + 2) / 2, halfH: (ah + 2) / 2 },
      shadowTexel: (sc.right - sc.left) / view.sun.light.shadow.mapSize.x,
    });
    cards.frame(dt);
  };
  view.beforeDraw = hook;
  syncInfo();

  const api = {
    /** Dev: the planted banners and the commanders whose card has shown. */
    state: () => ({ planted: banners.map((b) => ({ squad: b.id, x: +b.x.toFixed(2), y: +b.y.toFixed(2) })), sighted: [...seen], cards: cards.count, faces: [...play.records.faces] }),
    /** Dev: fades every face card out now (for a look at the planted banners). */
    hideCards: () => cards.hide(),
    /** Dev: plays a commander's fall moment now, as the event would (no rule changes: the sim is not touched). */
    fall: (squad: number) => {
      const c = play.squadCentre(squad);
      pending.push({ squad, x: c?.x ?? 0, y: c?.y ?? 0 });
      play.clock.holdSlow(infos[squad]?.team === 0 ? FALL_OURS_S : FALL_FOES_S);
    },
  };
  const w = window as unknown as { __v?: Record<string, unknown> };
  if (import.meta.env.DEV && w.__v) w.__v.faces = api;

  return {
    dispose() {
      const i = play.listeners.indexOf(listener);
      if (i >= 0) play.listeners.splice(i, 1);
      if (view.beforeDraw === hook) view.beforeDraw = before;
      cards.dispose();
      banners.length = 0;
      planted.update({ men: [], banners: [], dt: 0, time: view.time, zoom: view.camera.s });
      view.scene.remove(planted.group);
      play.records.faces = [];
      if (w.__v?.faces === api) delete w.__v.faces;
    },
  };
}
