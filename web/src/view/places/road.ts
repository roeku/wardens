import * as THREE from 'three';
import { hash32 } from '../figures/hash';
import { groundAt } from '../land-data';
import type { View } from '../view';
import { disposeGeometries, Kit, bodyMaterial, mesh } from './build';
import { fireFlame, Flames, Kind, Particles } from './fire';
import { buildCamp, buildHall, buildPlace, buildWagons, cairn, paintOwned, plantedBanner, poseFlag, SITE, type PlaceView } from './structures';

// The road's places (docs/spec/01-flow.md §3.5; 03-land.md §7, §9): each place a building of its kind (a holdfast's
// tower, a village under the torch with its smoke, the ford's wagons by a fire, camp tents, the keep) and the Hall of
// Banners at the road's start. The land remembers: cairns, one per 3 fallen men, and the planted banners of companies
// that died there; at the Hall, the fallen commanders' banners in rows and the enemy colours taken. Places the blight
// holds wear its corrupted colours; freed ones the warband's blue.

export type RoadKind = 'holdfast' | 'village' | 'ford' | 'camp' | 'keep';

export interface RoadPlaceIn {
  id: number;
  kind: RoadKind;
  at: { x: number; y: number };
  /** Villages: houses still standing (0 burnt out). */
  houses?: number;
  /** Freed (done): ours; else the blight's. */
  done: boolean;
}

/** 03-land.md §7 "Town": the five houses' offsets from the site and their sizes. */
const TOWN_HOUSES: [number, number, number, number][] = [
  [-1.75, -1.0, 0.95, 0.7],
  [0.95, -1.8, 0.75, 0.95],
  [2.0, 0.35, 0.7, 1.0],
  [0.2, 1.85, 1.05, 0.7],
  [-1.9, 1.1, 0.8, 0.75],
];
/** 03-land.md §7 "Flames": camp, hall and wagon fires are always 0xffa040. */
const CAMP_FLAME = 0xffa040;
/** 02-look.md §4: the warband's blue (team [1]) and its banner's edge; the blight's hide and its ember. */
const OUR_CLOTH = 0x1f5a8e;
const OUR_EDGE = 0x153a5c;
const FOE_CLOTH = 0x86281f;
const FOE_EDGE = 0xc84a1c;
/** 03-land.md §7: banners at the Hall in rows of 6, 0.8 apart; planted banners on the road 0.9 apart, 1.1 between rows. */
const HALL_ROW = 6;
const HALL_GAP = 0.8;
const ROAD_GAP = 0.9;
const ROAD_ROW_GAP = 1.1;

export interface PropIn {
  kind: 'cairn' | 'banner';
  x: number;
  y: number;
  ribbons?: number;
}

/** A banner standing on the road or at the Hall, for taps: its foot (sim tiles) and what it remembers. */
export interface StandingBanner {
  x: number;
  y: number;
  /** Its index in the list it came from. */
  i: number;
  side: 'fallen' | 'colours' | 'road';
}

interface Site {
  id: number;
  kind: RoadKind;
  view: PlaceView | null;
  base: THREE.Vector3;
  fire: THREE.Vector3 | null;
  group: THREE.Group;
  /** 0 ours (freed), 1 the blight's. */
  owner: number;
}

export class RoadSites {
  readonly group = new THREE.Group();
  private readonly sites = new Map<number, Site>();
  private readonly flames = new Flames();
  private readonly smoke = new Particles();
  private readonly hall: { place: PlaceView; fire: THREE.Vector3 };
  readonly hallAt: THREE.Vector3;
  private props: THREE.Group | null = null;
  private hallBanners: THREE.Group | null = null;
  /** Banners standing now, for taps. */
  standing: StandingBanner[] = [];
  private last = NaN;
  private readonly ground: (x: number, y: number) => number;

  constructor(
    private readonly view: View,
    places: RoadPlaceIn[],
    hall: { x: number; y: number },
    seed: number,
  ) {
    this.ground = (x, y) => groundAt(view.land, x, y);
    this.group.name = 'road-sites';
    for (const p of places) this.build(p, seed);
    this.hallAt = new THREE.Vector3(hall.x, this.ground(hall.x, hall.y), hall.y);
    this.hall = buildHall(this.hallAt, seed);
    paintOwned(this.hall.place.owned!, 0);
    this.group.add(this.hall.place.group, this.flames.mesh, this.smoke.points);
    view.scene.add(this.group);
  }

  private build(p: RoadPlaceIn, seed: number): void {
    const base = new THREE.Vector3(p.at.x, this.ground(p.at.x, p.at.y), p.at.y);
    const s: Site = { id: p.id, kind: p.kind, view: null, base, fire: null, group: new THREE.Group(), owner: 1 };
    const sd = seed * 31 + p.id + 1;
    switch (p.kind) {
      case 'holdfast':
        s.view = buildPlace(p.id, SITE.tower, base, sd, []);
        break;
      case 'keep':
        s.view = buildPlace(p.id, SITE.keep, base, sd, []);
        break;
      case 'village': {
        const houses = TOWN_HOUSES.map(([x, z, w, d]) => ({ x: base.x + x, z: base.z + z, w, d }));
        s.view = buildPlace(p.id, SITE.town, base, sd, houses);
        break;
      }
      case 'ford': {
        const w = buildWagons(base, sd);
        s.group.add(w.group);
        s.fire = w.fire;
        break;
      }
      case 'camp': {
        const c = buildCamp(base, sd);
        s.group.add(c.group);
        s.fire = c.fire;
        break;
      }
    }
    if (s.view) s.group.add(s.view.group);
    this.group.add(s.group);
    this.sites.set(p.id, s);
    this.paint(p);
  }

  /** A place's holder and its village's houses as the campaign has them now. */
  paint(p: RoadPlaceIn): void {
    const s = this.sites.get(p.id);
    if (!s) return;
    const owner = p.done ? 0 : 1;
    s.owner = owner;
    if (!s.view) return;
    if (s.view.owned) paintOwned(s.view.owned, owner);
    const standing = p.houses ?? 5;
    s.view.houses.forEach((h, k) => {
      const fallen = k >= standing;
      h.roof.visible = !fallen;
      h.walls.visible = !fallen;
      h.ruin.visible = fallen;
      h.wallsMat.color.setRGB(1, 1, 1);
      h.roofMat.color.setRGB(1, 1, 1);
    });
    s.owner = owner;
  }

  /** The ground's height at a place's middle. */
  footY(id: number): number {
    return this.sites.get(id)?.base.y ?? 0;
  }

  /** The top of a place's building, world. */
  placeTop(id: number): THREE.Vector3 | null {
    const s = this.sites.get(id);
    if (!s) return null;
    const h = s.kind === 'holdfast' ? 3.2 : s.kind === 'keep' ? 2.6 : s.kind === 'village' ? 2.2 : 1.0;
    return new THREE.Vector3(s.base.x, s.base.y + h, s.base.z);
  }

  /** One frame: fires, smoke, flags. */
  update(): void {
    const t = this.view.time;
    const dt = Number.isNaN(this.last) ? 0 : Math.max(0, t - this.last);
    this.last = t;
    const f = this.flames;
    f.begin();
    for (const s of this.sites.values()) {
      if (s.view) poseFlag(s.view.flag, s.owner, 0, -1, t);
      if (s.fire) {
        fireFlame(f, s.fire, 0.12, 0.2, t, CAMP_FLAME);
        this.smoke.emit(7000 + s.id, Kind.Smoke, s.fire.x, s.fire.y + 0.3, s.fire.z, 0.6, dt, 0.05);
      }
      // a village under the torch smokes from its fallen houses; a standing one from its chimneys
      if (s.kind === 'village' && s.view) {
        s.view.houses.forEach((h, k) => {
          const id = 7100 + s.id * 8 + k;
          if (h.ruin.visible) this.smoke.emit(id, Kind.Smoke, h.top.x, s.base.y + 0.3, h.top.z, 0.35, dt, 0.25);
          else if (k % 2 === 0) this.smoke.emit(id, Kind.Smoke, h.top.x, h.top.y, h.top.z, 1.2, dt, 0.1);
        });
      }
    }
    poseFlag(this.hall.place.flag, 0, 0, -1, t);
    fireFlame(f, this.hall.fire, 0.1, 0.18, t, CAMP_FLAME);
    this.smoke.emit(7999, Kind.Smoke, this.hall.fire.x, this.hall.fire.y + 0.25, this.hall.fire.z, 0.7, dt, 0.05);
    f.end();
    this.smoke.step(dt);
  }

  /** The land remembers (03-land.md §7 "Campaign props"): cairns and the planted banners of companies that died. */
  setProps(props: PropIn[], seed: number): void {
    if (this.props) {
      this.group.remove(this.props);
      disposeGeometries(this.props);
    }
    this.standing = this.standing.filter((b) => b.side !== 'road');
    if (props.length === 0) {
      this.props = null;
      return;
    }
    const kit = new Kit();
    props.forEach((p, i) => {
      const base = new THREE.Vector3(p.x, this.ground(p.x, p.y), p.y);
      if (p.kind === 'cairn') cairn(kit, base, seed + i);
      else {
        const lean = ((i * 7919) % 31) / 31 * 0.3 - 0.15;
        plantedBanner(kit, base, lean, OUR_CLOTH, p.ribbons ?? 0, OUR_EDGE);
        this.standing.push({ x: p.x, y: p.y, i, side: 'road' });
      }
    });
    const g = new THREE.Group();
    g.name = 'road-props';
    const geo = kit.build().body;
    if (geo) g.add(mesh(geo, bodyMaterial(), 'road-props'));
    this.props = g;
    this.group.add(g);
  }

  /**
   * The Hall of Banners (01-flow.md §3.10): the fallen commanders' banners in rows of 6 north of the hall (up to 24),
   * the enemy colours taken south of it (up to 12), 0.8 apart.
   */
  setHall(fallen: { ribbons?: number; rank?: number }[], colours: unknown[]): void {
    if (this.hallBanners) {
      this.group.remove(this.hallBanners);
      disposeGeometries(this.hallBanners);
    }
    this.standing = this.standing.filter((b) => b.side === 'road');
    const kit = new Kit();
    const h = this.hallAt;
    const row = (n: number, i: number, north: boolean): { x: number; y: number } => {
      const r = Math.floor(i / HALL_ROW);
      const c = i % HALL_ROW;
      const x = h.x - ((HALL_ROW - 1) * HALL_GAP) / 2 + c * HALL_GAP + 0.4;
      const y = north ? h.z - 1.6 - r * 1.0 : h.z + 2.3 + r * 1.0;
      void n;
      return { x, y };
    };
    fallen.slice(0, 24).forEach((f, i) => {
      const p = row(fallen.length, i, true);
      plantedBanner(kit, new THREE.Vector3(p.x, this.ground(p.x, p.y), p.y), 0, OUR_CLOTH, f.ribbons ?? f.rank ?? 0, OUR_EDGE);
      this.standing.push({ ...p, i, side: 'fallen' });
    });
    colours.slice(0, 12).forEach((_, i) => {
      const p = row(colours.length, i, false);
      plantedBanner(kit, new THREE.Vector3(p.x, this.ground(p.x, p.y), p.y), 0, FOE_CLOTH, 0, FOE_EDGE);
      this.standing.push({ ...p, i, side: 'colours' });
    });
    const geo = kit.build().body;
    if (!geo) {
      this.hallBanners = null;
      return;
    }
    const g = new THREE.Group();
    g.name = 'hall-banners';
    g.add(mesh(geo, bodyMaterial(), 'hall-banners'));
    this.hallBanners = g;
    this.group.add(g);
  }

  dispose(): void {
    this.view.scene.remove(this.group);
    disposeGeometries(this.group);
  }
}

/** Where a place's new props go (03-land.md §7): cairns 2.5–5.5 tiles from it, banners in rows of 6 beside it. */
export function propSpots(at: { x: number; y: number }, cairns: number, banners: number, seed: number, already: number): PropIn[] {
  const out: PropIn[] = [];
  for (let k = 0; k < cairns; k++) {
    const n = already + k;
    const a = ((hash32(seed, n, 1) % 1000) / 1000) * Math.PI * 2;
    const d = 2.5 + ((hash32(seed, n, 2) % 1000) / 1000) * 3;
    out.push({ kind: 'cairn', x: at.x + Math.cos(a) * d, y: at.y + Math.sin(a) * d });
  }
  for (let k = 0; k < banners; k++) {
    const n = already + k;
    const r = Math.floor(n / 6);
    out.push({ kind: 'banner', x: at.x - 2.4 + (n % 6) * ROAD_GAP, y: at.y + 2.6 + r * ROAD_ROW_GAP });
  }
  return out;
}
