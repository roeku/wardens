import init, { Battle, version } from './sim-pkg/sim_wasm.js';
import { BattleView } from './battle/battle';
import { installDev } from './dev';
import { bindBattleKeys } from './input/battle-keys';
import { bindCameraControls } from './input/camera-controls';
import { makeLandInWorker, makeLandInline } from './view/land';
import type { Tier } from './view/renderer';
import { View } from './view/view';

// URL flags (docs/spec/01-flow.md §5): ?seed= ?map= (width) ?army=big ?px= ?tier=, ?kind=keep|town|ford for now,
// ?land=inline|worker to choose where the land is made (the worker by default, 03-land.md §10), ?pilot=1 for the
// commander bot to play our side, ?enemy=garrison|general0|general1|general2|charge|idle|none for the enemy's bot,
// ?perf to log the frame-time stats every 5 s.
const params = new URLSearchParams(location.search);
const num = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);

/** The enemy's bot when ?enemy is not given: the garrison on its own ground, else the general at skill 1. */
function defaultEnemy(kind: string): string {
  return kind === 'keep' || kind === 'town' ? 'garrison' : 'general1';
}

async function main(): Promise<void> {
  const wasm = await init();
  console.log(`[sim] ${version()}`);
  const seed = num('seed') ?? 4;
  const kind = params.get('kind') ?? 'keep';
  const battle = Battle.muster(seed, JSON.stringify({ kind, width: num('map') ?? 48 }), params.get('army') ?? 'default');
  const tier = (params.get('tier') ?? 'high') as Tier;
  const t0 = performance.now();
  const land = params.get('land') === 'inline' ? makeLandInline(battle) : await makeLandInWorker(battle.map_json());
  console.log(`[land] ${land.where}: make ${land.ms.toFixed(1)} ms, ready after ${(performance.now() - t0).toFixed(1)} ms`);
  const view = new View(document.body, land, { px: num('px'), tier });
  const t1 = performance.now();
  const play = new BattleView(view, battle, wasm.memory, {
    pilot: params.get('pilot') === '1',
    enemy: params.get('enemy') ?? defaultEnemy(kind),
  });
  console.log(`[battle] ${battle.soldier_count()} men in ${battle.squad_count()} companies, ready in ${(performance.now() - t1).toFixed(1)} ms`);
  if (import.meta.env.DEV) installDev(view, play);
  const controls = bindCameraControls(view, () => (play.follow = false));
  bindBattleKeys(play);
  window.addEventListener('resize', () => view.resize());

  if (params.has('perf')) {
    setInterval(() => {
      const r = play.perf.report();
      const f = (k: keyof typeof r) => (k === 'frames' ? '' : `${k} ${r[k].p50}/${r[k].p90}`);
      console.log(`[perf] ms p50/p90: ${(['step', 'records', 'figures', 'render', 'total', 'interval'] as const).map(f).join(', ')}`);
    }, 5000);
  }

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    play.frame(dt);
    if (!play.clock.paused) view.time += dt;
    controls(dt);
    view.render();
    play.perf.mark('render');
    play.perf.end();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
