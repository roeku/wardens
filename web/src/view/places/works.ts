import * as THREE from 'three';
import { WATER_Y } from '../land-data';
import { bodyMaterial, Kit, mesh, type At } from './build';
import { STONE, WOOD } from './structures';

// The field works (docs/spec/08-orders.md §7; DECISIONS.md D-16): stakes, a barricade, a bridge's deck over the water
// and a watchtower, drawn from the sim's works. Each rises piece by piece as `built` goes from 0 to 1 and tips over
// when razed. Pieces are merged per stage of the build, so a work is a handful of meshes; they move only when the sim
// or the view's clock does.

/** Work records as the sim packs them (places_api.rs `WORKS`). */
export const WORK = {
  ID: 0, KIND: 1, TEAM: 2, X: 3, Y: 4, FACE: 5, BUILT: 6, HP: 7, RAZED: 8, AX: 9, AY: 10, BX: 11, BY: 12, ACROSS: 13, ALONG: 14, AT_WORK: 15, FIELDS: 16,
} as const;
const STAKES = 0, BARRICADE = 1, BRIDGE = 2, TOWER = 3;

/** Seconds a razed work takes to tip over (chosen). */
const FALL_S = 0.8;
/** A bridge's deck stands this far above the water at least, and this thick (chosen). */
const DECK_ABOVE = 0.16;
const DECK = 0.06;

interface Stage {
  /** The share of `built` at which this piece starts and is done rising. */
  from: number;
  to: number;
  mesh: THREE.Mesh;
}

interface WorkView {
  id: number;
  kind: number;
  group: THREE.Group;
  stages: Stage[];
  /** The view time it was seen razed, NaN while it stands. */
  razedAt: number;
  /** The ground under its centre: a wreck settles toward it. */
  base: number;
  /** A bridge's deck: its landings (world x, z), top heights at each, half width; and how much is laid. */
  deck: { ax: number; az: number; bx: number; bz: number; ha: number; hb: number; half: number; built: number } | null;
}

export class Works {
  readonly group = new THREE.Group();
  private readonly views = new Map<number, WorkView>();

  constructor(private readonly ground: (x: number, y: number) => number) {
    this.group.name = 'works';
  }

  /** Brings the drawn works in line with the sim's records (`n` of them), at view time `t`. */
  update(w: Float32Array, n: number, t: number): void {
    for (let i = 0; i < n; i++) {
      const o = i * WORK.FIELDS;
      const id = w[o + WORK.ID];
      let v = this.views.get(id);
      if (!v) {
        v = this.make(w, o);
        this.views.set(id, v);
        this.group.add(v.group);
      }
      this.pose(v, w[o + WORK.BUILT], w[o + WORK.RAZED] > 0, t);
    }
  }

  /** The top of a bridge's deck under sim (x, y), if a laid part of one is there: men on it stand on it. */
  deckAt(x: number, y: number): number | null {
    for (const v of this.views.values()) {
      const d = v.deck;
      if (!d || !Number.isNaN(v.razedAt)) continue;
      const ux = d.bx - d.ax, uz = d.bz - d.az;
      const len2 = ux * ux + uz * uz;
      if (len2 <= 0) continue;
      const k = ((x - d.ax) * ux + (y - d.az) * uz) / len2;
      if (k < 0 || k > d.built) continue;
      const len = Math.sqrt(len2);
      const side = Math.abs((x - d.ax) * uz - (y - d.az) * ux) / len;
      if (side > d.half) continue;
      return d.ha + (d.hb - d.ha) * k;
    }
    return null;
  }

  private make(w: Float32Array, o: number): WorkView {
    const kind = w[o + WORK.KIND];
    const x = w[o + WORK.X], z = w[o + WORK.Y];
    const face = w[o + WORK.FACE];
    const across = w[o + WORK.ACROSS], along = w[o + WORK.ALONG];
    const f = { x: Math.cos(face), z: Math.sin(face) };
    // The work's frame: `a` ahead along its face, `l` to its left (the sim's offset: left = (f.y, −f.x)).
    const p = (a: number, l: number) => ({ x: x + f.x * a + f.z * l, z: z + f.z * a - f.x * l });
    const g = this.ground;
    const stages: Stage[] = [];
    const group = new THREE.Group();
    group.name = `work-${w[o + WORK.ID]}`;
    const stage = (from: number, to: number, build: (k: Kit) => void) => {
      const kit = new Kit();
      build(kit);
      const geom = kit.build().body;
      if (!geom) return;
      const m = mesh(geom, bodyMaterial(), `${group.name}-${stages.length}`);
      group.add(m);
      stages.push({ from, to, mesh: m });
    };
    const at = (a: number, l: number, lift = 0, turn = face): At => {
      const q = p(a, l);
      return { x: q.x, y: g(q.x, q.z) + lift, z: q.z, turn };
    };
    let deck: WorkView['deck'] = null;
    if (kind === STAKES) {
      // Two staggered rows of sharpened stakes leaning toward the enemy.
      const n = Math.max(2, Math.round(across / 0.32));
      for (let j = 0; j < n; j++) {
        const l = (j / (n - 1) - 0.5) * (across - 0.2);
        stage(j / n, (j + 1) / n, (k) => {
          for (const row of [0, 1]) {
            const a = row === 0 ? 0.15 : -0.18;
            const lo = l + (row === 0 ? 0 : 0.16);
            const q = at(a, lo, 0, face);
            k.beam(0.05, 0.55, 0.05, { ...q, turn: face + Math.PI / 2 }, 0, WOOD[1 + row], -0.55);
          }
        });
      }
    } else if (kind === BARRICADE) {
      // Posts, then logs stacked between them, then a capping beam.
      const posts = Math.max(2, Math.round(across / 0.7) + 1);
      stage(0, 0.3, (k) => {
        for (let j = 0; j < posts; j++) k.box(0.1, 0.8, 0.1, at(0, (j / (posts - 1) - 0.5) * across), WOOD[0]);
      });
      const logs = 4;
      for (let j = 0; j < logs; j++) {
        stage(0.3 + (0.6 * j) / logs, 0.3 + (0.6 * (j + 1)) / logs, (k) => {
          k.box(0.14, 0.15, across, { ...at(0.06, 0, j * 0.16), turn: face }, j % 2 ? WOOD[1] : WOOD[2]);
        });
      }
      stage(0.9, 1, (k) => k.box(0.08, 0.06, across + 0.1, { ...at(0.06, 0, 0.66), turn: face }, WOOD[0]));
    } else if (kind === BRIDGE) {
      // The deck runs from one landing to the other, laid plank by plank as it is built, on piles in the water.
      const ax = w[o + WORK.AX], az = w[o + WORK.AY], bx = w[o + WORK.BX], bz = w[o + WORK.BY];
      const ha = Math.max(g(ax, az), WATER_Y + DECK_ABOVE) + DECK;
      const hb = Math.max(g(bx, bz), WATER_Y + DECK_ABOVE) + DECK;
      const len = Math.hypot(bx - ax, bz - az);
      const turn = Math.atan2(bz - az, bx - ax);
      const half = across / 2;
      const planks = Math.max(4, Math.round(len / 0.22));
      const step = len / planks;
      for (let j = 0; j < planks; j++) {
        const k0 = (j + 0.5) / planks;
        const cx = ax + (bx - ax) * k0, cz = az + (bz - az) * k0;
        const top = ha + (hb - ha) * k0;
        stage(j / planks, (j + 1) / planks, (k) => {
          k.box(step * 0.92, DECK, across, { x: cx, y: top - DECK, z: cz, turn }, j % 3 === 0 ? WOOD[1] : WOOD[2]);
          // A pile and its rail posts every third plank.
          const nx = -Math.sin(turn), nz = Math.cos(turn);
          if (j % 3 === 1) {
            for (const sgn of [-1, 1]) {
              const px = cx + nx * sgn * (half - 0.05);
              const pz = cz + nz * sgn * (half - 0.05);
              const gy = Math.min(g(px, pz), top - DECK);
              k.box(0.08, top - DECK - gy + 0.001, 0.08, { x: px, y: gy, z: pz, turn }, WOOD[0]);
              k.box(0.05, 0.3, 0.05, { x: px, y: top, z: pz, turn }, WOOD[0]);
            }
          }
          // The rails, plank by plank.
          for (const sgn of [-1, 1]) {
            const px = cx + nx * sgn * (half - 0.05);
            const pz = cz + nz * sgn * (half - 0.05);
            k.box(step, 0.04, 0.04, { x: px, y: top + 0.26, z: pz, turn }, WOOD[0]);
          }
        });
      }
      deck = { ax, az, bx, bz, ha, hb, half, built: 0 };
    } else if (kind === TOWER) {
      // Four legs with braces rise first; then the platform, its parapet and a roof.
      const s = Math.min(across, along) * 0.36;
      const H = 2.0;
      stage(0, 0.55, (k) => {
        for (const [a, l] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(0.1, H, 0.1, at(a * s, l * s), WOOD[0]);
        for (const sgn of [-1, 1]) {
          k.beam(2 * s * 1.4, 0.05, 0.05, { ...at(0, sgn * s, 0.35), turn: face }, 0.62, WOOD[1]);
          k.beam(2 * s * 1.4, 0.05, 0.05, { ...at(sgn * s, 0, 0.35), turn: face + Math.PI / 2 }, -0.62, WOOD[1]);
        }
      });
      stage(0.55, 0.8, (k) => {
        k.box(2 * s + 0.3, 0.08, 2 * s + 0.3, { ...at(0, 0, H), turn: face }, WOOD[2]);
        k.box(0.3, 0.25, 0.2, { ...at(0, -s * 0.4, 0), turn: face }, STONE[1]);
      });
      stage(0.8, 1, (k) => {
        for (const sgn of [-1, 1]) {
          k.box(2 * s + 0.3, 0.32, 0.05, { ...at(sgn * (s + 0.13), 0, H + 0.08), turn: face }, WOOD[1]);
          k.box(0.05, 0.32, 2 * s + 0.3, { ...at(0, sgn * (s + 0.13), H + 0.08), turn: face }, WOOD[1]);
        }
        k.pyramid(2 * s + 0.35, 0.45, { ...at(0, 0, H + 0.62), turn: face }, WOOD[1]);
        for (const [a, l] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(0.05, 0.3, 0.05, at(a * s, l * s, H + 0.32), WOOD[0]);
      });
    }
    return { id: w[o + WORK.ID], kind, group, stages, razedAt: NaN, base: g(x, z), deck };
  }

  /** Each piece shown as far as `built` has reached it, rising from the ground; razed, the work tips over. */
  private pose(v: WorkView, built: number, razed: boolean, t: number): void {
    for (const s of v.stages) {
      const k = Math.max(0, Math.min(1, (built - s.from) / Math.max(1e-6, s.to - s.from)));
      s.mesh.visible = k > 0;
      // A piece rises out of the ground (sinking its base below it) as it is built.
      s.mesh.position.y = -(1 - k) * 0.35;
    }
    if (v.deck) v.deck.built = Math.max(0, Math.min(1, built));
    if (razed && Number.isNaN(v.razedAt)) v.razedAt = t;
    if (!razed) v.razedAt = NaN;
    if (!Number.isNaN(v.razedAt)) {
      const k = Math.min(1, Math.max(0, t - v.razedAt) / FALL_S);
      // The wreck: broken down to a third of its height over the ground it stood on, and sunk a little. The pieces
      // are in world space, so the squash is about the work's base: y' = base + (y − base)·sc − sink.
      const sc = 1 - 0.65 * k;
      for (const s of v.stages) {
        s.mesh.scale.y = sc;
        s.mesh.position.y = v.base * (1 - sc) - 0.12 * k;
      }
    } else {
      for (const s of v.stages) s.mesh.scale.y = 1;
    }
  }
}
