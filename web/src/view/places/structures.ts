import * as THREE from 'three';
import { unit } from '../figures/hash';
import { boxGeometry, bodyMaterial, Kit, mesh, ownedMaterial, tintedMaterial, type At, type Shingle } from './build';

// The medieval set (docs/spec/03-land.md §7): the keep, the tower, the shrine, the village of three houses, the town
// of five houses with their ruins, and the ford's wagons. Each place is one merged body mesh plus one owned mesh
// tinted by its holder, and its flag, which climbs the pole as the place is held. The town's houses each keep their
// own walls, roof and hidden ruin, so each can burn and fall on its own.

export const STONE = [0x4b443b, 0x6c6356, 0x8e8477, 0xb0a693, 0xd0c7b2] as const;
export const THATCH = [0x6f5829, 0x977b3c, 0xbf9e55] as const;
export const WOOD = [0x35231a, 0x56391f, 0x7a5634] as const;
const PLASTER = [0xe2d5b2, 0xd8c7a0] as const;
const BEAM = 0x3a2618;
const WINDOW = 0x2a2018;
const CANVAS = [0xe2d5b2, 0xcdbb91] as const;
const BELL = 0x8a6a2a;
const CHAR = [0x1c1612, 0x241c16] as const;
/** A burnt roof's colour, a fallen house's walls (03-land.md §7 "Burning and falling"). */
export const ROOF_BURNT = 0x2a221c;
export const WALLS_FALLEN = 0x3a332e;
/** The fort culture's neutral (a keep, a tower, a shrine), and the folk's (thatch). */
const FORT_NEUTRAL = 0x6b5a48;

/** Who holds a place, and how it shows (02-look.md §4; 03-land.md §7 "The owned mesh"). */
export const HOLDER = {
  /** Ours: the player's blue. */
  ours: 0x1f5a80,
  /** The blight's: corrupted, a dark flesh-brown with glowing ember bands (07-progression.md §8). */
  blight: 0x4f3330,
  ember: 0xc84a1c,
} as const;
/** The flag's cloth: neutral, ours (team [2]), the blight's (its ember). */
const FLAG = { neutral: 0xd8cfb4, ours: 0x3a8dbd, blight: 0xc84a1c } as const;

/** Site kinds as the sim packs them. */
export const SITE = { keep: 0, town: 1, village: 2, shrine: 3, tower: 4 } as const;

export interface Flag {
  pole: THREE.Mesh;
  cloth: THREE.Mesh;
  mat: THREE.MeshToonMaterial;
  /** The pole's foot (world) and height. */
  foot: THREE.Vector3;
  h: number;
}

/** One house of the town: its walls (tinted as it burns), its roof, and its ruin (shown once fallen). */
export interface HouseView {
  walls: THREE.Mesh;
  wallsMat: THREE.MeshToonMaterial;
  roof: THREE.Mesh;
  roofMat: THREE.MeshToonMaterial;
  ruin: THREE.Mesh;
  /** The roof's ridge, world, for the flames and smoke; its length along the ridge. */
  top: THREE.Vector3;
  ridge: number;
  alongZ: boolean;
}

/** A place drawn on the field. */
export interface PlaceView {
  site: number;
  kind: number;
  group: THREE.Group;
  owned: { mat: THREE.MeshToonMaterial; shingle: Shingle; neutral: number } | null;
  flag: Flag;
  /** A flame on top (the shrine's), world. */
  flame: THREE.Vector3 | null;
  houses: HouseView[];
}

const r01 = (seed: number, k: number) => unit(seed, k, 401);

/** A half-timbered house (03-land.md §7): plaster walls with beams on the two walls the camera sees, windows, a
 * door, an optional chimney, and an owned roof `(w+.18, d+.18, .52)`. Walls `0.58 + r·0.15` high. */
function house(kit: Kit, roof: Kit, at: At, w: number, d: number, seed: number, owned: boolean): { h: number } {
  const h = 0.58 + r01(seed, 1) * 0.15;
  const plaster = PLASTER[seed & 1];
  kit.box(w, h, d, at, plaster);
  const t = 0.035;
  const turn = at.turn ?? 0;
  // Offsets in the house's own frame, turned with it.
  const local = (x: number, z: number): At => {
    const c = Math.cos(turn), s = Math.sin(turn);
    return { x: at.x + x * c - z * s, y: at.y, z: at.z + x * s + z * c, turn };
  };
  const along = (x: number, y: number, len: number, south: boolean, vertical: boolean) => {
    // A beam on the south face (along x) or the west face (along z), proud of the wall by half its thickness.
    const p = south ? local(x, d / 2 + t / 2) : local(-w / 2 - t / 2, x);
    p.y = at.y + y;
    if (vertical) kit.box(t, len, t, p, BEAM);
    else if (south) kit.box(len, t, t, p, BEAM);
    else kit.box(t, t, len, p, BEAM);
  };
  for (const south of [true, false]) {
    const span = south ? w : d;
    for (const y of [0, 0.48 * h, h - t]) along(0, y, span + t, south, false);
    for (const k of [-0.5, 0, 0.5]) along(k * (span - t), 0, h, south, true);
    // Diagonal braces in the lower panels.
    for (const sgn of [-1, 1]) {
      const cx = sgn * span * 0.25;
      const len = Math.hypot(span / 2, 0.48 * h);
      const ang = Math.atan2(0.48 * h, span / 2) * sgn;
      const p = south ? local(cx, d / 2 + t / 2) : local(-w / 2 - t / 2, cx);
      p.y = at.y + 0.24 * h - t / 2;
      if (south) kit.beam(len, t, t, p, ang, BEAM);
      else kit.beam(len, t, t, { ...p, turn: turn + Math.PI / 2 }, -ang, BEAM);
    }
  }
  // Windows and a door on the south wall, a window on the west.
  const win = (p: At, sideways: boolean) => kit.box(sideways ? 0.02 : 0.12, 0.11, sideways ? 0.12 : 0.02, p, WINDOW);
  win({ ...local(-w * 0.25, d / 2 + 0.012), y: at.y + 0.62 * h }, false);
  win({ ...local(w * 0.25, d / 2 + 0.012), y: at.y + 0.62 * h }, false);
  win({ ...local(-w / 2 - 0.012, 0), y: at.y + 0.62 * h }, true);
  kit.box(0.16, 0.3, 0.02, { ...local(w * 0.12, d / 2 + 0.012), y: at.y }, WINDOW);
  if (r01(seed, 2) < 0.5) kit.box(0.12, h + 0.42, 0.12, { ...local(w * 0.3, -d * 0.2), y: at.y }, STONE[1]);
  // The roof, its ridge along the long side.
  const alongZ = d > w;
  roof.roof(w + 0.18, d + 0.18, 0.52, { ...at, y: at.y + h }, THATCH[1], owned, alongZ);
  return { h };
}

/** Paints a unit box's vertices one colour. */
function paintedBox(color: number): THREE.BufferGeometry {
  const g = boxGeometry().clone();
  g.userData = { shared: true };
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

let poleGeom: THREE.BufferGeometry | null = null;
let clothGeom: THREE.BufferGeometry | null = null;

/** A flag on its pole: pole `Box(.035, h, .035)` in WOOD[0], flag `Box(.34, .2, .025)` in the cloth's colour. */
function placeFlag(group: THREE.Group, foot: THREE.Vector3, h: number): Flag {
  poleGeom ??= paintedBox(WOOD[0]);
  clothGeom ??= paintedBox(0xffffff);
  const pole = mesh(poleGeom, bodyMaterial(), 'flag-pole');
  pole.scale.set(0.035, h, 0.035);
  pole.position.set(foot.x, foot.y + h / 2, foot.z);
  const mat = tintedMaterial();
  const cloth = mesh(clothGeom, mat, 'flag-cloth');
  cloth.scale.set(0.34, 0.2, 0.025);
  group.add(pole, cloth);
  return { pole, cloth, mat, foot, h };
}

/** Builds the place at site `kind` standing at world `base` (its centre on the ground). */
export function buildPlace(site: number, kind: number, base: THREE.Vector3, seed: number, houses: { x: number; z: number; w: number; d: number }[]): PlaceView {
  const group = new THREE.Group();
  group.name = `place-${site}`;
  const body = new Kit();
  const own = new Kit();
  const at = (x: number, y: number, z: number, turn = 0): At => ({ x: base.x + x, y: base.y + y, z: base.z + z, turn });
  let flagFoot = new THREE.Vector3(base.x, base.y, base.z);
  let flagH = 1.2;
  let flame: THREE.Vector3 | null = null;
  let neutral = FORT_NEUTRAL;
  const houseViews: HouseView[] = [];
  switch (kind) {
    case SITE.keep: {
      // Curtain walls round a 3×3 yard (R 1.5), 0.9 high, 0.28 thick, merlons; a gate in the south wall.
      const R = 1.5, H = 0.9, T = 0.28;
      body.box(2 * R + T, H, T, at(0, 0, -R), STONE[2]);
      body.box(T, H, 2 * R, at(-R, 0, 0), STONE[2]);
      body.box(T, H, 2 * R, at(R, 0, 0), STONE[2]);
      const gate = 0.6;
      const side = R - gate / 2;
      body.box(side, H, T, at(-R + side / 2 - T / 4, 0, R), STONE[2]);
      body.box(side, H, T, at(R - side / 2 + T / 4, 0, R), STONE[2]);
      body.box(gate, 0.25, T, at(0, H - 0.25, R), STONE[1]);
      body.box(gate * 0.9, H - 0.25, 0.05, at(0, 0, R - 0.08), WOOD[0]);
      body.merlons(-R, -R, R, -R, H, T, 0.14, STONE[3]);
      body.merlons(-R, -R, -R, R, H, T, 0.14, STONE[3]);
      body.merlons(R, -R, R, R, H, T, 0.14, STONE[3]);
      body.merlons(-R, R, -gate / 2 - 0.1, R, H, T, 0.14, STONE[3]);
      body.merlons(gate / 2 + 0.1, R, R, R, H, T, 0.14, STONE[3]);
      // Four corner towers under owned cones.
      for (const [x, z] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
        body.cyl(0.36, 1.35, at(x, 0, z), STONE[1]);
        own.cone(0.46, 0.6, at(x, 1.35, z), 0, true);
      }
      // The hall under an owned roof; cloth hangs by the gate in the holder's colour (the keeps' rule).
      body.box(1.3, 1.9, 1.1, at(0, 0, -0.2), STONE[3]);
      body.box(0.3, 0.4, 0.04, at(0, 0, 0.36), WINDOW);
      own.roof(1.45, 1.25, 0.6, at(0, 1.9, -0.2), 0, true);
      own.box(0.22, 0.5, 0.03, at(-gate / 2 - 0.2, 0.3, R + T / 2 + 0.02), 0, true);
      own.box(0.22, 0.5, 0.03, at(gate / 2 + 0.2, 0.3, R + T / 2 + 0.02), 0, true);
      flagFoot = new THREE.Vector3(base.x + 0.45, base.y + 2.3, base.z - 0.2);
      flagH = 0.9;
      break;
    }
    case SITE.tower: {
      body.box(0.95, 0.2, 0.95, at(0, 0, 0), STONE[1]);
      body.box(0.7, 2.0, 0.7, at(0, 0.2, 0), STONE[2]);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) body.box(0.14, 2.0, 0.14, at(x * 0.33, 0.2, z * 0.33), STONE[1]);
      // Corbel courses and a crenellated parapet.
      body.box(0.82, 0.08, 0.82, at(0, 2.05, 0), STONE[3]);
      body.box(0.9, 0.08, 0.9, at(0, 2.13, 0), STONE[3]);
      body.box(0.9, 0.22, 0.9, at(0, 2.21, 0), STONE[2]);
      body.merlons(-0.45, -0.45, 0.45, -0.45, 2.43, 0.1, 0.1, STONE[3]);
      body.merlons(-0.45, 0.45, 0.45, 0.45, 2.43, 0.1, 0.1, STONE[3]);
      body.merlons(-0.45, -0.45, -0.45, 0.45, 2.43, 0.1, 0.1, STONE[3]);
      body.merlons(0.45, -0.45, 0.45, 0.45, 2.43, 0.1, 0.1, STONE[3]);
      body.box(0.18, 0.3, 0.02, at(0, 0.2, 0.36), WINDOW);
      body.box(0.1, 0.18, 0.02, at(0, 1.4, 0.36), WINDOW);
      // The owned pyramid roof overhangs the parapet, on four posts.
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) body.box(0.05, 0.4, 0.05, at(x * 0.38, 2.43, z * 0.38), WOOD[1]);
      own.pyramid(1.2, 0.55, at(0, 2.83, 0), 0, true);
      flagFoot = new THREE.Vector3(base.x, base.y + 3.3, base.z);
      flagH = 0.8;
      break;
    }
    case SITE.shrine: {
      body.box(1.1, 0.12, 1.1, at(0, 0, 0), STONE[1]);
      body.box(0.8, 0.12, 0.8, at(0, 0.12, 0), STONE[2]);
      body.box(0.26, 1.2, 0.26, at(0, 0.24, 0), STONE[3]);
      body.box(0.36, 0.08, 0.36, at(0, 1.44, 0), STONE[4]);
      own.box(0.3, 0.05, 0.3, at(0, 1.52, 0), 0, true);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) body.box(0.07, 0.42, 0.07, at(x * 0.46, 0.12, z * 0.46), STONE[2]);
      flame = new THREE.Vector3(base.x, base.y + 1.57, base.z);
      flagFoot = new THREE.Vector3(base.x + 0.62, base.y, base.z + 0.3);
      flagH = 1.1;
      break;
    }
    case SITE.village: {
      neutral = THATCH[1];
      const spots: [number, number, number, number, number][] = [
        [-0.8, -0.45, 0.9, 0.7, 0],
        [0.55, -0.7, 0.7, 0.9, 0.35],
        [0.35, 0.75, 1.0, 0.65, 0],
      ];
      spots.forEach(([x, z, w, d, turn], k) => house(body, own, at(x, 0, z, turn), w, d, seed * 7 + k, true));
      // Barrels, a crate, a well (a stone cylinder, two posts and a beam) and a haystack.
      body.cyl(0.08, 0.16, at(-0.15, 0, 0.1), WOOD[2], 7).cyl(0.08, 0.16, at(-0.02, 0, 0.18), WOOD[1], 7);
      body.box(0.16, 0.14, 0.16, at(-0.3, 0, 0.28, 0.4), WOOD[2]);
      body.cyl(0.16, 0.2, at(-0.85, 0, 0.55), STONE[2], 8);
      body.box(0.04, 0.4, 0.04, at(-1.0, 0.2, 0.55), WOOD[0]).box(0.04, 0.4, 0.04, at(-0.7, 0.2, 0.55), WOOD[0]);
      body.box(0.36, 0.04, 0.04, at(-0.85, 0.58, 0.55), WOOD[1]);
      body.cone(0.22, 0.34, at(0.95, 0, 0.1), THATCH[2], false, 7);
      flagFoot = new THREE.Vector3(base.x - 0.2, base.y, base.z + 0.05);
      break;
    }
    case SITE.town: {
      // The chapel and its bell tower with a 4-post belfry, a bell and a spire; a well.
      body.box(0.95, 0.62, 0.66, at(-0.2, 0, -0.1), STONE[3]);
      body.box(0.14, 0.26, 0.02, at(-0.2, 0, 0.24), WOOD[0]);
      own.roof(1.08, 0.8, 0.42, at(-0.2, 0.62, -0.1), 0, true);
      body.box(0.42, 1.55, 0.42, at(0.48, 0, -0.1), STONE[2]);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) body.box(0.06, 0.34, 0.06, at(0.48 + x * 0.17, 1.55, -0.1 + z * 0.17), WOOD[0]);
      body.box(0.14, 0.16, 0.14, at(0.48, 1.62, -0.1), BELL);
      own.pyramid(0.52, 0.65, at(0.48, 1.89, -0.1), 0, true);
      body.cyl(0.16, 0.2, at(0.7, 0, 0.75), STONE[2], 8);
      body.box(0.04, 0.4, 0.04, at(0.55, 0.2, 0.75), WOOD[0]).box(0.04, 0.4, 0.04, at(0.85, 0.2, 0.75), WOOD[0]);
      flagFoot = new THREE.Vector3(base.x + 0.48, base.y + 2.5, base.z - 0.1);
      flagH = 0.7;
      neutral = FORT_NEUTRAL;
      // Five houses, each with its own walls, roof and hidden ruin.
      houses.forEach((hs, k) => {
        const walls = new Kit();
        const roof = new Kit();
        const x = hs.x - base.x, z = hs.z - base.z;
        const { h } = house(walls, roof, at(x, 0, z), hs.w, hs.d, seed * 11 + k, false);
        const ruin = new Kit();
        // The shell: its walls turned 0x3a332e and broken to stubs of uneven height round a charred floor, with
        // three charred beams fallen across it (03-land.md §7 "When the house is lost").
        const hw = hs.w / 2, hd = hs.d / 2, tw = 0.06;
        const stub = (j: number) => 0.12 + r01(seed * 11 + k, 10 + j) * 0.3 * h;
        ruin.box(hs.w, stub(0), tw, at(x, 0, z + hd - tw / 2), WALLS_FALLEN);
        ruin.box(hs.w * 0.6, stub(1), tw, at(x - hw * 0.4, 0, z - hd + tw / 2), WALLS_FALLEN);
        ruin.box(tw, stub(2), hs.d, at(x - hw + tw / 2, 0, z), WALLS_FALLEN);
        ruin.box(tw, stub(3), hs.d * 0.5, at(x + hw - tw / 2, 0, z + hd * 0.5), WALLS_FALLEN);
        ruin.box(0.07, h * 0.75, 0.07, at(x - hw + 0.04, 0, z + hd - 0.04), CHAR[1]);
        ruin.box(hs.w - 0.1, 0.03, hs.d - 0.1, at(x, 0, z), CHAR[1]);
        ruin.beam(hs.w * 1.05, 0.06, 0.06, at(x, 0.12, z - hs.d * 0.15), 0.35, CHAR[0]);
        ruin.beam(hs.w * 0.9, 0.06, 0.06, at(x + 0.05, 0.08, z + hs.d * 0.15), -0.45, CHAR[0]);
        ruin.beam(0.06, 0.06, hs.d * 1.1, at(x - hs.w * 0.2, 0.06, z), 0, CHAR[1], 0.5);
        const wg = walls.build().body!;
        const rg = roof.build().body!;
        const ug = ruin.build().body!;
        const wallsMat = tintedMaterial();
        const roofMat = tintedMaterial();
        const hv: HouseView = {
          walls: mesh(wg, wallsMat, `house-${k}-walls`),
          wallsMat,
          roof: mesh(rg, roofMat, `house-${k}-roof`),
          roofMat,
          ruin: mesh(ug, bodyMaterial(), `house-${k}-ruin`),
          top: new THREE.Vector3(hs.x, base.y + h + 0.52, hs.z),
          ridge: Math.max(hs.w, hs.d),
          alongZ: hs.d > hs.w,
        };
        hv.ruin.visible = false;
        group.add(hv.walls, hv.roof, hv.ruin);
        houseViews.push(hv);
      });
      break;
    }
  }
  const bg = body.build().body;
  if (bg) group.add(mesh(bg, bodyMaterial(), `place-${site}-body`));
  // The owned parts (roofs, caps, cloth), painted white, take the holder's colour.
  const og = own.build().owned;
  let owned: PlaceView['owned'] = null;
  if (og) {
    const o = ownedMaterial();
    group.add(mesh(og, o.mat, `place-${site}-owned`));
    owned = { ...o, neutral };
  }
  const f = placeFlag(group, flagFoot, flagH);
  return { site, kind, group, owned, flag: f, flame, houses: houseViews };
}

/** The ford's wagons (03-land.md §7): two covered wagons on four wheels each, turned ±0.3–0.4, a ring of 6 stones
 * round a fire, and crates. Returns the group and the fire's place. */
export function buildWagons(base: THREE.Vector3, seed: number): { group: THREE.Group; fire: THREE.Vector3 } {
  const kit = new Kit();
  const at = (x: number, y: number, z: number, turn = 0): At => ({ x: base.x + x, y: base.y + y, z: base.z + z, turn });
  for (const [k, sgn] of [[0, 1], [1, -1]] as const) {
    const turn = sgn * (0.3 + r01(seed, k) * 0.1);
    const cx = -0.7 + k * 1.3, cz = -0.15 + k * 0.35;
    const c = Math.cos(turn), s = Math.sin(turn);
    const loc = (x: number, z: number, y: number): At => ({ x: base.x + cx + x * c - z * s, y: base.y + y, z: base.z + cz + x * s + z * c, turn });
    kit.box(0.9, 0.16, 0.42, loc(0, 0, 0.13), WOOD[1]);
    for (const [wx, wz] of [[-0.3, -0.24], [0.3, -0.24], [-0.3, 0.24], [0.3, 0.24]]) {
      const p = loc(wx, wz, 0);
      kit.cyl(0.13, 0.05, { ...p, y: p.y + 0.13 - 0.025 }, WOOD[0], 8);
    }
    // The canvas: a long prism over hoops.
    kit.roof(0.8, 0.46, 0.3, loc(0, 0, 0.29), CANVAS[k], false, false);
    kit.box(0.8, 0.08, 0.46, loc(0, 0, 0.29), CANVAS[k]);
    kit.box(0.5, 0.03, 0.03, loc(-0.7, 0, 0.2), WOOD[1]);
  }
  // The fire's ring of 6 stones, and crates.
  const fx = 0.25, fz = 0.75;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    kit.box(0.08, 0.06, 0.08, at(fx + Math.cos(a) * 0.2, 0, fz + Math.sin(a) * 0.2, a), STONE[1 + (i % 2)]);
  }
  kit.box(0.04, 0.04, 0.24, at(fx, 0.02, fz, 0.7), WOOD[0]).box(0.04, 0.04, 0.24, at(fx, 0.02, fz, -0.7), WOOD[0]);
  kit.box(0.18, 0.16, 0.18, at(-0.2, 0, 0.75, 0.2), WOOD[2]).box(0.15, 0.13, 0.15, at(-0.4, 0, 0.62, -0.3), WOOD[1]);
  const group = new THREE.Group();
  group.name = 'wagons';
  group.add(mesh(kit.build().body!, bodyMaterial(), 'wagons-body'));
  return { group, fire: new THREE.Vector3(base.x + fx, base.y + 0.04, base.z + fz) };
}

const cTmp = new THREE.Color();

/** The holder's look on an owned material: ours blue, the blight's corrupted with ember bands, nobody's neutral. */
export function paintOwned(o: NonNullable<PlaceView['owned']>, owner: number): void {
  if (owner === 0) o.mat.color.setHex(HOLDER.ours);
  else if (owner === 1) o.mat.color.setHex(HOLDER.blight);
  else o.mat.color.setHex(o.neutral);
  o.shingle.uBandK.value = owner === 1 ? 1 : 0;
}

/** The flag (03-land.md §7): it climbs to `0.25 + 0.75·(0.35 + 0.65·|hold|)` of the pole and sways with
 * `rotation.y = sin(t·2.2 + x)·.35 − .6`. Its cloth is the holder's, or the capturer's on a neutral place. */
export function poseFlag(f: Flag, owner: number, progress: number, by: number, t: number): void {
  let hold: number;
  let colourOf = owner;
  if (owner >= 0) hold = by >= 0 && by !== owner ? 1 - progress : 1;
  else {
    hold = by >= 0 ? progress : 0;
    colourOf = by >= 0 && progress > 0 ? by : -1;
  }
  const k = 0.25 + 0.75 * (0.35 + 0.65 * Math.abs(hold));
  const y = f.foot.y + f.h * k - 0.1;
  const sway = Math.sin(t * 2.2 + f.foot.x) * 0.35 - 0.6;
  const c = Math.cos(sway), s = Math.sin(sway);
  // The cloth hangs from the pole on its own left edge.
  f.cloth.position.set(f.foot.x + c * 0.17, y, f.foot.z - s * 0.17);
  f.cloth.rotation.set(0, sway, 0);
  f.mat.color.copy(cTmp.setHex(colourOf === 0 ? FLAG.ours : colourOf === 1 ? FLAG.blight : FLAG.neutral));
}

// ------------------------------------------------------------------------------------------- the road's own

/** The camp (03-land.md §7): four ridge tents `roof(.78,.62,.55)` in canvas with poles, a ring of 7 stones, crossed
 * sticks, a cart, and a fire in the centre. Returns the group and the fire's place (camp fires are 0xffa040). */
export function buildCamp(base: THREE.Vector3, seed: number): { group: THREE.Group; fire: THREE.Vector3 } {
  const kit = new Kit();
  const at = (x: number, y: number, z: number, turn = 0): At => ({ x: base.x + x, y: base.y + y, z: base.z + z, turn });
  const tents: [number, number, number][] = [[-0.95, -0.7, 0.2], [0.85, -0.85, -0.3], [-0.9, 0.85, -0.15], [0.95, 0.75, 0.35]];
  tents.forEach(([x, z, turn], k) => {
    const t = turn + (r01(seed, 30 + k) - 0.5) * 0.3;
    kit.roof(0.78, 0.62, 0.55, at(x, 0, z, t), CANVAS[k & 1], false, false);
    // the poles at the ridge's ends
    const c = Math.cos(t), s = Math.sin(t);
    for (const e of [-0.42, 0.42]) kit.box(0.035, 0.62, 0.035, at(x + e * c, 0, z + e * s), WOOD[0]);
  });
  // a ring of 7 stones round the fire, and crossed sticks over it
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    kit.box(0.09, 0.06, 0.09, at(Math.cos(a) * 0.24, 0, Math.sin(a) * 0.24, a), STONE[1 + (i % 2)]);
  }
  kit.box(0.04, 0.04, 0.3, at(0, 0.02, 0, 0.7), WOOD[0]).box(0.04, 0.04, 0.3, at(0, 0.02, 0, -0.7), WOOD[0]);
  // a cart: a bed on two wheels, its shafts down
  kit.box(0.6, 0.12, 0.38, at(0.1, 0.16, 1.45, 0.15), WOOD[2]);
  kit.cyl(0.15, 0.05, { ...at(0.1, 0.01, 1.24, 0.15) }, WOOD[0], 8).cyl(0.15, 0.05, at(0.1, 0.01, 1.66, 0.15), WOOD[0], 8);
  kit.beam(0.5, 0.03, 0.03, at(-0.42, 0.06, 1.38, 0.15), 0.25, WOOD[1]);
  const group = new THREE.Group();
  group.name = 'camp';
  group.add(mesh(kit.build().body!, bodyMaterial(), 'camp-body'));
  return { group, fire: new THREE.Vector3(base.x, base.y + 0.04, base.z) };
}

/** The Hall of Banners (03-land.md §7): a long timbered house 2.5×1.05 with walls 0.8 high under an owned roof
 * `(2.75, 1.3, .95)`, door posts, and a stone brazier with a fire. Returns the place view and the brazier's fire. */
export function buildHall(base: THREE.Vector3, seed: number): { place: PlaceView; fire: THREE.Vector3 } {
  const body = new Kit();
  const own = new Kit();
  const at = (x: number, y: number, z: number, turn = 0): At => ({ x: base.x + x, y: base.y + y, z: base.z + z, turn });
  const W = 2.5, D = 1.05, H = 0.8;
  body.box(W, H, D, at(0, 0, 0), PLASTER[seed & 1]);
  const t = 0.04;
  // timbers on the two walls the camera sees: sills, a mid rail, the plate, posts every half metre or so
  for (const y of [0, 0.45 * H, H - t]) {
    body.box(W + t, t, t, at(0, y, D / 2 + t / 2), BEAM);
    body.box(t, t, D + t, at(-W / 2 - t / 2, y, 0), BEAM);
  }
  for (let i = 0; i <= 5; i++) body.box(t, H, t, at(-W / 2 + (i * W) / 5, 0, D / 2 + t / 2), BEAM);
  for (const z of [-D / 2, 0, D / 2]) body.box(t, H, t, at(-W / 2 - t / 2, 0, z), BEAM);
  // the door, its posts, and windows
  body.box(0.26, 0.5, 0.02, at(0.2, 0, D / 2 + 0.015), WINDOW);
  body.box(0.06, 0.62, 0.06, at(0.02, 0, D / 2 + 0.06), WOOD[0]).box(0.06, 0.62, 0.06, at(0.38, 0, D / 2 + 0.06), WOOD[0]);
  body.box(0.46, 0.06, 0.08, at(0.2, 0.62, D / 2 + 0.06), WOOD[1]);
  for (const x of [-0.85, -0.4, 0.8]) body.box(0.14, 0.12, 0.02, at(x, 0.5, D / 2 + 0.015), WINDOW);
  own.roof(2.75, 1.3, 0.95, at(0, H, 0), 0, true, false);
  // the brazier before the door
  body.cyl(0.14, 0.42, at(0.2, 0, D / 2 + 0.75), STONE[2], 8);
  body.cyl(0.2, 0.08, at(0.2, 0.42, D / 2 + 0.75), STONE[3], 8);
  const group = new THREE.Group();
  group.name = 'hall';
  group.add(mesh(body.build().body!, bodyMaterial(), 'hall-body'));
  const o = ownedMaterial();
  group.add(mesh(own.build().owned!, o.mat, 'hall-owned'));
  const flag = placeFlag(group, new THREE.Vector3(base.x - W / 2 - 0.3, base.y, base.z + D / 2 + 0.2), 1.6);
  const place: PlaceView = { site: -1, kind: -1, group, owned: { ...o, neutral: THATCH[1] }, flag, flame: null, houses: [] };
  return { place, fire: new THREE.Vector3(base.x + 0.2, base.y + 0.5, base.z + D / 2 + 0.75) };
}

/** Cairn stones (03-land.md §7 "Campaign props"): 3 stacked dodecahedra of scale 0.13 − 0.03k, the top one paler. */
export const CAIRN = [0x7d766b, 0x9a9384] as const;

/** A cairn at world `base` into `kit`. */
export function cairn(kit: Kit, base: THREE.Vector3, seed: number): void {
  let y = 0;
  for (let k = 0; k < 3; k++) {
    const s = 0.13 - 0.03 * k;
    const jx = (r01(seed, 50 + k) - 0.5) * 0.04;
    kit.cone(s, s * 1.4, { x: base.x + jx, y: base.y + y, z: base.z + jx, turn: r01(seed, 60 + k) * 3 }, k === 2 ? CAIRN[1] : CAIRN[0], false, 5);
    y += s * 1.1;
  }
}

/** Honour ribbons, cream and red in turn (02-look.md §4). */
const RIBBON = [0xf3ecd8, 0xd8463a] as const;

/**
 * A planted banner (03-land.md §7): a pole 1.3 tall carrying a 0.44 × 0.72 cloth and up to 6 honour ribbons, leaning
 * by `lean` (±0.15 rad). `cloth`: its colour (the warband's blue, or an enemy's colours). Into `kit`.
 */
export function plantedBanner(kit: Kit, base: THREE.Vector3, lean: number, cloth: number, ribbons: number, edge: number): void {
  const H = 1.3;
  // the pole leans in the plane facing the camera: a tilted beam, its foot at the base
  const dx = Math.sin(lean) * (H / 2), dy = Math.cos(lean) * (H / 2);
  kit.beam(0.04, H, 0.04, { x: base.x + dx * Math.SQRT1_2, y: base.y + dy - H / 2, z: base.z + dx * Math.SQRT1_2, turn: Math.PI / 4 }, -lean, WOOD[0]);
  const tx = base.x + Math.sin(lean) * H * Math.SQRT1_2, tz = base.z + Math.sin(lean) * H * Math.SQRT1_2, ty = base.y + Math.cos(lean) * H;
  // the crossbar and the cloth hanging from it, square to the camera
  kit.box(0.5, 0.04, 0.04, { x: tx, y: ty - 0.06, z: tz, turn: Math.PI / 4 }, WOOD[1]);
  kit.box(0.44, 0.72, 0.03, { x: tx + 0.02, y: ty - 0.8, z: tz + 0.02, turn: Math.PI / 4 }, cloth);
  kit.box(0.46, 0.05, 0.035, { x: tx + 0.02, y: ty - 0.1, z: tz + 0.02, turn: Math.PI / 4 }, edge);
  for (let i = 0; i < Math.min(6, ribbons); i++) {
    const side = i % 2 ? 1 : -1;
    const off = side * (0.25 + Math.floor(i / 2) * 0.05);
    kit.box(0.03, 0.34, 0.02, { x: tx + off * Math.SQRT1_2, y: ty - 0.42, z: tz + off * Math.SQRT1_2, turn: Math.PI / 4 }, RIBBON[i % 2]);
  }
}
