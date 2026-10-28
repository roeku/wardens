import * as THREE from 'three';
import { BannerAtlas, ShieldAtlas } from './atlas';
import { PartPool } from './instances';
import { figureUniforms } from './material';
import { lookKey, outfit } from './outfit';
import { advance, poseBanner, poseMan, RIGS, type FigState, type RigCtx } from './rig';
import type { FigureFrame, ManRecord } from './types';

export interface FiguresOpts {
  /** Figures receive shadows (off by default: see out/decisions-figures.md "Figures cast but do not receive"). */
  receiveShadow?: boolean;
}

/**
 * The men and banners of a battle (02-look.md §5–§6). Feed it every frame with the records of everyone to draw;
 * it keeps each man's drawn state (eased position, facing, walk phase, blows) by id, poses him procedurally and
 * writes the joint matrices straight into one InstancedMesh per part. Deterministic: looks come from hash32 of
 * the id, timing from the frame's dt and the sim's strike counters.
 */
export class Figures {
  readonly group: THREE.Group;
  private readonly pool: PartPool;
  private readonly bannerAtlas = new BannerAtlas();
  private readonly shieldAtlas = new ShieldAtlas();
  private readonly states = new Map<number, FigState>();
  private frameNo = 0;
  private readonly ctx: RigCtx;
  private warned = new Set<string>();

  constructor(opts: FiguresOpts = {}) {
    this.pool = new PartPool({ banner: this.bannerAtlas.texture, bannerFar: this.bannerAtlas.farTexture, shield: this.shieldAtlas.texture }, opts.receiveShadow ?? false);
    this.group = this.pool.group;
    this.ctx = { pool: this.pool, zoom: 16, time: 0, shields: this.shieldAtlas, banners: this.bannerAtlas };
  }

  update(f: FigureFrame): void {
    this.frameNo++;
    figureUniforms.uTime.value = f.time;
    if (f.screen) {
      figureUniforms.uPix.value.set(f.zoom, f.screen.halfW, f.screen.halfH);
      figureUniforms.uOrigin.value.set(f.screen.origin.x, f.screen.origin.y);
    } else figureUniforms.uPix.value.x = 0;
    figureUniforms.uShadowR.value = f.shadowTexel ?? 0;
    const c = this.ctx;
    c.zoom = f.zoom;
    c.time = f.time;
    this.pool.begin();
    for (const rec of f.men) {
      const st = this.state(rec);
      st.seen = this.frameNo;
      const rig = rec.kind === 'beast' ? RIGS.beast : undefined;
      if (rec.kind === 'beast' && !rig) {
        this.warnOnce('beast', 'figures: no rig registered for beasts yet; they are not drawn');
        continue;
      }
      advance(st, rec, f.dt, rig);
      if (rig) rig.pose(c, st, rec);
      else poseMan(c, st, rec);
    }
    for (const b of f.banners ?? []) poseBanner(c, b);
    this.pool.end();
    for (const [id, st] of this.states) if (st.seen !== this.frameNo) this.states.delete(id);
  }

  /** Where a man was drawn this frame (world x, ground y, world z = sim y), snapped; null if not drawn. */
  drawnAt(id: number): { x: number; y: number; z: number; px: number; py: number } | null {
    const st = this.states.get(id);
    return st ? { ...st.at } : null;
  }

  /** Turns every part's shadow casting on or off (the lab's check). */
  setCastShadow(on: boolean): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.castShadow = on && !o.name.match(/face|shieldFace|pennant|string|rein|chevron|ribbon/);
    });
  }

  stats(): { men: number; parts: number; instances: number; triangles: number } {
    return { men: this.states.size, ...this.pool.stats() };
  }

  private state(rec: ManRecord): FigState {
    const key = lookKey(rec);
    let st = this.states.get(rec.id);
    if (!st) {
      st = {
        id: rec.id,
        seen: 0,
        x: rec.x,
        y: rec.y,
        h: rec.h,
        speed: rec.speed,
        face: rec.face,
        phase: 0,
        strikes: rec.strikes,
        strikeT: Infinity,
        look: outfit(rec),
        lookKey: key,
        at: { x: 0, y: 0, z: 0, px: 0, py: 0 },
      };
      this.states.set(rec.id, st);
    } else if (st.lookKey !== key) {
      st.look = outfit(rec);
      st.lookKey = key;
    }
    return st;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(msg);
  }
}
