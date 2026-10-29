import * as THREE from 'three';
import type { BattleView } from '../../battle/battle';
import { SOLDIER_F32 } from '../../contracts';
import { FIG } from '../figures';
import { groundAt } from '../land-data';
import type { Tier } from '../renderer';
import type { View } from '../view';
import { Flames, fireFlame, FLAME, Kind, Particles, roofFlames } from './fire';
import { LIGHT, LIGHT_CAP, LIGHT_KIND, NightLights } from './night';
import { disposeGeometries } from './build';
import { buildPlace, buildWagons, paintOwned, poseFlag, ROOF_BURNT, SITE, THATCH, WOOD, type PlaceView } from './structures';
import { Works } from './works';

// The places on the field (docs/spec/03-land.md §7; 04-battle.md §8; 02-look.md §3; 08-orders.md §7): the sites'
// buildings and flags, the town's houses burning and falling, smoke and embers, the ford's wagons, the field works,
// and the night's lights fed to the CELL pass. It reads the sim's places buffers (places_api.rs) once a frame, just
// before the scene is drawn, and never writes to the sim.

/** Buffers as places_api.rs numbers them. */
const BUF = { sites: 0, houses: 1, groups: 2, lights: 3, works: 4 } as const;
const SITE_F = { ID: 0, KIND: 1, X: 2, Y: 3, OWNER: 4, PROGRESS: 5, BY: 6, FIELDS: 8 } as const;
const HOUSE_F = { X: 0, Y: 1, W: 2, D: 3, STATE: 4, BURNT: 5, AGE: 6, PEOPLE: 7, FIELDS: 8 } as const;
const STANDING = 0, BURNING = 1, FALLEN = 2, DOUSED = 3;
/** 03-land.md §7 "Flames": a shrine's fire shows its holder. Camp, hall and wagon fires are always 0xffa040. */
const SHRINE_FLAME = [0x9fe3ff, 0xff7a4a] as const;
const NEUTRAL_FLAME = 0xffc860;
const CAMP_FLAME = 0xffa040;

interface Info {
  kind: string;
  town: number | null;
  houses: { at: [number, number]; w: number; d: number }[];
  burn_s: number;
  smoulder_s: number;
  doused_s: number;
  ford: { entry: [number, number]; exit: [number, number]; crossing: [number, number][]; wagons: [number, number] } | null;
}

/** A typed-array view over one places buffer, re-made only when the memory, the address or the count changes. */
class Buf {
  data = new Float32Array(0);
  n = 0;
  private buf: ArrayBuffer | null = null;
  private ptr = -1;

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly which: number,
    readonly stride: number,
  ) {}

  read(sim: BattleView['sim']): void {
    const ptr = sim.places_ptr(this.which);
    const n = sim.places_len(this.which);
    if (this.memory.buffer !== this.buf || ptr !== this.ptr || n !== this.n) {
      this.buf = this.memory.buffer;
      this.ptr = ptr;
      this.n = n;
      this.data = new Float32Array(this.buf, ptr, n * this.stride);
    }
  }
}

const tint = new THREE.Color();
const thatch = new THREE.Color(THATCH[1]);
const burnt = new THREE.Color(ROOF_BURNT);
const V = new THREE.Vector3();

export class Places {
  readonly group = new THREE.Group();
  readonly info: Info;
  readonly works: Works;
  private readonly places: PlaceView[] = [];
  private readonly flames = new Flames();
  private readonly smoke = new Particles();
  private readonly night: NightLights;
  private readonly bufs: Record<keyof typeof BUF, Buf>;
  private wagonFire: THREE.Vector3 | null = null;
  private last = NaN;
  private readonly ground: (x: number, y: number) => number;

  constructor(
    private readonly view: View,
    private readonly play: BattleView,
    memory: WebAssembly.Memory,
    tier: Tier,
  ) {
    const sim = play.sim;
    this.info = JSON.parse(sim.places_info()) as Info;
    this.ground = (x, y) => groundAt(view.land, x, y);
    this.works = new Works(this.ground);
    this.night = new NightLights(view, LIGHT_CAP[tier]);
    this.bufs = {
      sites: new Buf(memory, BUF.sites, sim.places_stride(BUF.sites)),
      houses: new Buf(memory, BUF.houses, sim.places_stride(BUF.houses)),
      groups: new Buf(memory, BUF.groups, sim.places_stride(BUF.groups)),
      lights: new Buf(memory, BUF.lights, sim.places_stride(BUF.lights)),
      works: new Buf(memory, BUF.works, sim.places_stride(BUF.works)),
    };
    this.group.name = 'places';
    this.read();
    const s = this.bufs.sites;
    for (let i = 0; i < s.n; i++) {
      const o = i * s.stride;
      const id = s.data[o + SITE_F.ID];
      const kind = s.data[o + SITE_F.KIND];
      const x = s.data[o + SITE_F.X];
      const z = s.data[o + SITE_F.Y];
      const base = new THREE.Vector3(x, this.ground(x, z), z);
      const houses = kind === SITE.town ? this.info.houses.map((h) => ({ x: h.at[0], z: h.at[1], w: h.w, d: h.d })) : [];
      const p = buildPlace(id, kind, base, id + 1, houses);
      this.places.push(p);
      this.group.add(p.group);
    }
    if (this.info.ford) {
      const [x, z] = this.info.ford.wagons;
      const w = buildWagons(new THREE.Vector3(x, this.ground(x, z), z), 7);
      this.group.add(w.group);
      this.wagonFire = w.fire;
    }
    this.group.add(this.flames.mesh, this.smoke.points, this.works.group);
    view.scene.add(this.group);
  }

  private read(): void {
    const sim = this.play.sim;
    sim.places_sync();
    for (const b of Object.values(this.bufs)) b.read(sim);
  }

  /** One frame: read the sim's places and pose everything for the camera as it is now. */
  update(): void {
    this.read();
    const t = this.view.time;
    const dt = Number.isNaN(this.last) ? 0 : Math.max(0, t - this.last);
    this.last = t;
    const f = this.flames;
    f.begin();
    this.poseSites(t);
    this.poseHouses(t, dt);
    if (this.wagonFire) {
      fireFlame(f, this.wagonFire, 0.12, 0.2, t, CAMP_FLAME);
      fireFlame(f, V.copy(this.wagonFire).setY(this.wagonFire.y + 0.02), 0.07, 0.16, t, null, 1.3);
      this.smoke.emit(9000, Kind.Smoke, this.wagonFire.x, this.wagonFire.y + 0.3, this.wagonFire.z, 0.6, dt, 0.05);
    }
    const w = this.bufs.works;
    this.works.update(w.data, w.n, t);
    const l = this.bufs.lights;
    this.torches(l.data, l.n, t);
    f.end();
    this.smoke.step(dt);
    // The pools stand where the sim has the lights (world-fixed, whatever the figures' easing does).
    this.night.update(this.play.sim.night_level(), l.data, l.n, this.ground, () => null);
  }

  private poseSites(t: number): void {
    const s = this.bufs.sites;
    for (const p of this.places) {
      const i = p.site;
      if (i >= s.n) continue;
      const o = i * s.stride;
      const owner = s.data[o + SITE_F.OWNER];
      if (p.owned) paintOwned(p.owned, owner);
      poseFlag(p.flag, owner, s.data[o + SITE_F.PROGRESS], s.data[o + SITE_F.BY], t);
      if (p.flame) fireFlame(this.flames, p.flame, 0.1, 0.22, t, owner === 0 || owner === 1 ? SHRINE_FLAME[owner] : NEUTRAL_FLAME, i);
    }
  }

  /** The town's houses (03-land.md §7 "Burning and falling"): the roof chars, the walls darken, flames over the roof,
   * smoke and embers; fallen, the roof goes, the ruin's beams show and the walls turn dark; smoke lingers after. */
  private poseHouses(t: number, dt: number): void {
    const h = this.bufs.houses;
    const town = this.places.find((p) => p.kind === SITE.town);
    if (!town) return;
    const info = this.info;
    for (let k = 0; k < Math.min(h.n, town.houses.length); k++) {
      const o = k * h.stride;
      const state = h.data[o + HOUSE_F.STATE];
      const b = h.data[o + HOUSE_F.BURNT];
      const age = h.data[o + HOUSE_F.AGE];
      const v = town.houses[k];
      // Lost: the roof and the standing walls go; the ruin shows (its walls turned 0x3a332e, its beams charred).
      const fallen = state === FALLEN;
      v.roof.visible = !fallen;
      v.walls.visible = !fallen;
      v.ruin.visible = fallen;
      v.wallsMat.color.setRGB(1 - 0.35 * b, 1 - 0.4 * b, 1 - 0.42 * b);
      // The roof lerps from its thatch toward 0x2a221c at burnt·1.2 (a multiplier on its thatch vertex colour).
      const rk = Math.min(1, b * 1.2);
      tint.copy(thatch).lerp(burnt, rk);
      v.roofMat.color.setRGB(tint.r / thatch.r, tint.g / thatch.g, tint.b / thatch.b);
      const base = this.ground(v.top.x, v.top.z);
      const id = 100 + k;
      if (state === BURNING) {
        const ramp = Math.min(1, age / 6);
        roofFlames(this.flames, v.top, v.ridge, v.alongZ, ramp, t, k + 1);
        this.smoke.emit(id, Kind.Smoke, v.top.x, v.top.y + 0.25, v.top.z, 0.1, dt);
        this.smoke.emit(id + 50, Kind.Ember, v.top.x, v.top.y + 0.1, v.top.z, 0.12, dt, 0.35);
      } else if (fallen && age < info.smoulder_s) {
        // Smouldering: a few low embers and a thinner smoke.
        const low = V.set(v.top.x, base + 0.08, v.top.z);
        fireFlame(this.flames, low, 0.08, 0.08 * Math.max(0, 1 - age / info.smoulder_s), t, FLAME[0], k);
        this.smoke.emit(id, Kind.Smoke, v.top.x, base + 0.25, v.top.z, 0.3, dt, 0.3);
      } else if (state === DOUSED && age < info.doused_s) {
        this.smoke.emit(id, Kind.Smoke, v.top.x, v.top.y - 0.2, v.top.z, 0.2, dt);
      }
    }
  }

  /** Each lit torch (02-look.md §3 "Torches"): in its bearer's left hand, a box 0.07×0.11×0.07 × FIG flickering
   * `0.8 + 0.35|sin(13t + id·1.7)|`, cycling the flame ramp, on a short dark stick. */
  private torches(l: Float32Array, n: number, t: number): void {
    const v = this.play.views;
    for (let i = 0; i < n; i++) {
      const o = i * LIGHT.FIELDS;
      if (l[o + LIGHT.KIND] !== LIGHT_KIND.torch) continue;
      const k = l[o + LIGHT.OF];
      const d = this.play.figures.drawnAt(k);
      if (!d) continue;
      const face = v.f32[k * SOLDIER_F32.FIELDS + SOLDIER_F32.FACE];
      const fx = Math.cos(face), fz = Math.sin(face);
      // His left hand, held out before him (the company's banner stands 0.3 to his left, records.ts): his left is
      // (f.y, −f.x) in sim terms, so (fz, −fx) on the ground.
      const x = d.x + fz * 0.08 + fx * 0.16;
      const z = d.z - fx * 0.08 + fz * 0.16;
      const y = d.y + 0.4 * FIG;
      const fl = 0.8 + 0.35 * Math.abs(Math.sin(13 * t + k * 1.7));
      this.flames.add(x, y - 0.2, z, 0.03, 0.22, 0.03, WOOD[0]);
      this.flames.add(x, y, z, 0.07 * FIG, 0.11 * FIG * fl, 0.07 * FIG, FLAME[(Math.floor(t * 9) + k) & 3]);
    }
  }

  /** Takes the places off the field and frees their geometries (the battle's scene ends; materials are kept). */
  dispose(): void {
    this.view.scene.remove(this.group);
    disposeGeometries(this.group);
    this.view.lightN = 0;
    const w = window as unknown as { __v?: Record<string, unknown> };
    if ((w.__v?.places as { of?: Places } | undefined)?.of === this) delete w.__v!.places;
  }

  /** Counts for the dev hooks and the shots' checks. */
  counts(): Record<string, number> {
    this.read();
    const h = this.bufs.houses;
    const st = [0, 0, 0, 0];
    for (let k = 0; k < h.n; k++) st[h.data[k * h.stride + HOUSE_F.STATE]]++;
    let torches = 0;
    const l = this.bufs.lights;
    for (let i = 0; i < l.n; i++) torches += l.data[i * l.stride + LIGHT.KIND] === LIGHT_KIND.torch ? 1 : 0;
    const g = this.bufs.groups;
    let came = 0, saved = 0;
    for (let i = 0; i < g.n; i++) {
      came += g.data[i * g.stride] >= 0 ? 1 : 0;
      saved += g.data[i * g.stride + 3];
    }
    return {
      places: this.places.length,
      standing: st[STANDING],
      burning: st[BURNING],
      fallen: st[FALLEN],
      doused: st[DOUSED],
      groups: g.n,
      came,
      saved,
      lights: l.n,
      torches,
      drawnLights: this.view.lightN,
      nightK: this.view.nightK,
      flames: this.flames.mesh.count,
      particles: this.smoke.count,
      works: this.bufs.works.n,
    };
  }

  /** Where a work, house or site is, for the dev hooks: the sim's records as plain numbers. */
  records(which: keyof typeof BUF): number[][] {
    this.read();
    const b = this.bufs[which];
    const out: number[][] = [];
    for (let i = 0; i < b.n; i++) out.push(Array.from(b.data.subarray(i * b.stride, (i + 1) * b.stride)));
    return out;
  }
}

/**
 * Puts the places on the field and hooks them into the frame: they pose just before the scene is drawn (after the
 * figures, whose drawn torch-bearers they read). Men on a bridge's deck stand on it. At the ford the enemy is the
 * raiders unless `?enemy=` says otherwise.
 */
export function installPlaces(view: View, play: BattleView, memory: WebAssembly.Memory, tier: Tier): Places {
  const places = new Places(view, play, memory, tier);
  const before = view.beforeDraw;
  view.beforeDraw = () => {
    before?.();
    places.update();
  };
  // The figures stand on the ground the battle view gives them; on a bridge, that is its deck. (BattleView keeps its
  // ground function private; this wraps it in place until it offers a hook.)
  const host = play as unknown as { ground?: (x: number, y: number) => number };
  const ground = host.ground;
  if (typeof ground === 'function') host.ground = (x, y) => places.works.deckAt(x, y) ?? ground(x, y);
  if (places.info.kind === 'ford' && !new URLSearchParams(location.search).has('enemy')) play.bot('raiders');
  const w = window as unknown as { __v?: Record<string, unknown> };
  if (import.meta.env.DEV && w.__v) {
    w.__v.places = {
      of: places,
      counts: () => places.counts(),
      records: (which: keyof typeof BUF) => places.records(which),
      info: () => places.info,
      /** The battle again from tick 0 under a tuning override, e.g. `{outcome: {battle_s: 100}}` (shots only). */
      retune: (over: unknown) => {
        play.sim.retune(JSON.stringify(over));
        play.fastForward(0);
        play.settle();
        view.render();
        return play.sim.tick();
      },
    };
  }
  return places;
}
