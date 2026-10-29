import { Battle } from '../sim-pkg/sim_wasm.js';
import { hash32 } from '../view/figures/hash';
import type { Tier } from '../view/renderer';
import type { App } from './app';
import { BattleScene } from './battle-scene';
import { campaignApi, customBattle, readState, type Campaign } from './campaign';
import { emptyMemory, saves, type CustomSetup } from './saves';
import { TitleScene, WarTable } from './title';

// How the scenes follow one another (docs/spec/01-flow.md §3): title → setup (the campaign cards, or the war table)
// → play. The campaign's own scenes (muster, road, battle, camp, the chronicle and the Hall) are in play.ts.

/** The enemy's bot when the battle gives none: the garrison on its own ground, else the general at skill 1. */
export function defaultEnemy(kind: string): string {
  return kind === 'keep' || kind === 'town' || kind === 'village' ? 'garrison' : 'general1';
}

/** The fallback when `Battle.custom` is not in the bindings yet: the nearest muster map. */
const MUSTER_KIND: Record<CustomSetup['kind'], string> = { field: 'field', night: 'field', keep: 'keep', hold: 'field', village: 'town', ford: 'ford' };
const MUSTER_WIDTH: Record<CustomSetup['size'], number> = { 4: 48, 6: 64, 9: 80 };

export class Flow {
  /** The title's field: its seed and the battle kind it stands on. */
  readonly titleSeed: number;
  /** Campaign scenes, registered by play.ts (kept apart so the title builds before the campaign exists). */
  play: {
    cards(): Promise<void>;
    resume(c: Campaign): Promise<void>;
  } | null = null;
  /** The campaign's scenes themselves (the dev hooks drive them). */
  playScenes: import('./play').Play | null = null;

  constructor(
    readonly app: App,
    readonly tier: Tier,
  ) {
    this.titleSeed = Number(app.params.get('seed') ?? 4);
  }

  /** The title's two armies at dusk: a field muster, never stepped. */
  private titleBattle(): Battle {
    return Battle.muster(this.titleSeed, JSON.stringify({ kind: 'field', width: 48 }), 'default');
  }

  async title(): Promise<void> {
    const app = this.app;
    await app.go(async () => {
      const battle = this.titleBattle();
      const land = await app.lands.of(battle);
      return () =>
        new TitleScene(app, battle, land, {
          continue: saves.campaign() !== null && campaignApi() !== null,
          onContinue: () => void this.continueCampaign(),
          onCampaign: () => void this.campaignCards(),
          onBattle: () => void this.table(),
        });
    });
  }

  async table(): Promise<void> {
    const app = this.app;
    await app.go(async () => {
      const battle = this.titleBattle();
      const land = await app.lands.of(battle);
      return () =>
        new WarTable(app, battle, land, saves.custom(), {
          fight: (s) => void this.custom(s),
          back: () => void this.title(),
          changed: (s) => saves.setCustom(s),
        });
    });
  }

  async campaignCards(): Promise<void> {
    if (this.play && campaignApi()) await this.play.cards();
    else console.warn('[flow] the campaign is not in the bindings yet');
  }

  async continueCampaign(): Promise<void> {
    const api = campaignApi();
    const kept = saves.campaign();
    if (!api || !kept || !this.play) return void this.title();
    let c: Campaign;
    try {
      c = api.load(kept.save);
      readState(c);
    } catch (e) {
      // a version mismatch discards the save (01-flow.md §5)
      console.warn('[flow] the kept campaign does not load; discarded', e);
      saves.dropCampaign();
      return void this.title();
    }
    this.app.campaign?.free();
    this.app.campaign = c;
    this.app.memory = kept.memory ?? emptyMemory();
    await this.play.resume(c);
  }

  /**
   * `?campaign=<name>` (01-flow.md §5): straight into that campaign, past the title: the kept one if it is that
   * campaign, else a new one (seeded by `?seed=`).
   */
  async startFromUrl(name: string): Promise<void> {
    const kept = saves.campaign();
    if (kept && (kept.campaign === name || name === '')) return this.continueCampaign();
    if (this.play && campaignApi()) return this.play.cards();
    return this.title();
  }

  /** A seed for each custom battle: the count of fights so far, hashed (no Math.random in the view). */
  private fightSeed(): number {
    const s = saves.settings();
    const n = (typeof s.fights === 'number' ? s.fights : 0) + 1;
    saves.setSettings({ ...s, fights: n });
    return hash32(n, 77, 5) % 100000;
  }

  /** FIGHT: straight to a custom battle (`Battle.custom`, contract §2); after it, back to the war table. */
  async custom(setup: CustomSetup): Promise<void> {
    const app = this.app;
    saves.setCustom(setup);
    const seed = this.fightSeed();
    await app.go(async () => {
      const own = customBattle(seed, setup);
      const battle = own ?? Battle.muster(seed, JSON.stringify({ kind: MUSTER_KIND[setup.kind], width: MUSTER_WIDTH[setup.size] }), setup.size === 9 ? 'big' : 'default');
      const land = await app.lands.of(battle);
      const kind = (JSON.parse(battle.map_json()) as { kind?: string }).kind?.toLowerCase() ?? setup.kind;
      return () =>
        new BattleScene(app, {
          battle,
          land,
          tier: this.tier,
          pilot: app.pilot,
          // Battle.custom comes with the enemy's bot playing; the muster fallback needs one
          enemy: own ? '' : defaultEnemy(kind),
          then: () => void this.table(),
          voice: 'if-disposable',
          name: 'custom',
        });
    });
  }
}
