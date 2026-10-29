import init, { Battle, version } from './sim-pkg/sim_wasm.js';
import { installDev } from './dev';
import { App } from './screens/app';
import { BattleScene, loadParts } from './screens/battle-scene';
import { defaultEnemy, Flow } from './screens/flow';
import { installPlay } from './screens/play';
import { loadPortraits } from './view/cards';
import { Figures } from './view/figures';
import { makeLandInline, makeLandInWorker } from './view/land';
import type { Tier } from './view/renderer';
import { View } from './view/view';

// The game page (docs/spec/01-flow.md §3): the title, the setup and play as scenes over one View, with no page
// reloads. URL flags (01-flow.md §5): ?seed= ?campaign= ?army=big ?px= ?tier=, ?land=inline|worker (where lands are
// made, the worker by default), ?perf to log frame times every 5 s. The day-4 dev path stays: ?kind=keep|town|ford|
// field goes straight into one battle (with ?map= its width, ?pilot=1 for the commander bot on our side, ?enemy= for
// the enemy's bot, ?brain= for voice), and the battle stays on the field when it is decided.

const params = new URLSearchParams(location.search);
const num = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);

async function main(): Promise<void> {
  const wasm = await init();
  console.log(`[sim] ${version()}`);
  // other parts' installers and the portraits, if they are there (each failing alone, not the page)
  await Promise.all([loadParts(), loadPortraits()]);
  const tier = (params.get('tier') ?? 'high') as Tier;
  const t0 = performance.now();

  if (params.has('kind')) {
    // the dev path: one battle, as on day 4
    const seed = num('seed') ?? 4;
    const kind = params.get('kind') ?? 'keep';
    const battle = Battle.muster(seed, JSON.stringify({ kind, width: num('map') ?? 48 }), params.get('army') ?? 'default');
    const land = params.get('land') === 'inline' ? makeLandInline(battle) : await makeLandInWorker(battle.map_json());
    console.log(`[land] ${land.where}: make ${land.ms.toFixed(1)} ms, ready after ${(performance.now() - t0).toFixed(1)} ms`);
    const view = new View(document.body, land, { px: num('px'), tier });
    const app = new App(view, new Figures(), wasm.memory, params);
    const flow = new Flow(app, tier);
    installPlay(flow);
    if (import.meta.env.DEV) installDev(app, flow);
    const t1 = performance.now();
    await app.go(() => () =>
      new BattleScene(app, {
        battle,
        land,
        tier,
        pilot: params.get('pilot') === '1',
        enemy: params.get('enemy') ?? defaultEnemy(kind),
        then: null,
        voice: 'always',
        name: 'battle',
      }),
    );
    console.log(`[battle] ${battle.soldier_count()} men in ${battle.squad_count()} companies, ready in ${(performance.now() - t1).toFixed(1)} ms`);
    app.run();
    perfLog(app);
    return;
  }

  // the title: its field's land first (the View is made over it), then the scenes
  const title = Battle.muster(num('seed') ?? 4, JSON.stringify({ kind: 'field', width: 48 }), 'default');
  const land = params.get('land') === 'inline' ? makeLandInline(title) : await makeLandInWorker(title.map_json());
  title.free();
  const view = new View(document.body, land, { px: num('px'), tier });
  const app = new App(view, new Figures(), wasm.memory, params);
  const flow = new Flow(app, tier);
  installPlay(flow);
  if (import.meta.env.DEV) installDev(app, flow);
  app.run();
  if (params.has('campaign')) await flow.startFromUrl(params.get('campaign') ?? '');
  else await flow.title();
  console.log(`[title] ready after ${(performance.now() - t0).toFixed(1)} ms`);
  perfLog(app);
}

function perfLog(app: App): void {
  if (!params.has('perf')) return;
  setInterval(() => {
    const r = app.scene?.play?.perf.report() ?? app.perf.report();
    const f = (k: keyof typeof r) => (k === 'frames' ? '' : `${k} ${r[k].p50}/${r[k].p90}`);
    console.log(`[perf] ${app.scene?.name}: ms p50/p90: ${(['step', 'records', 'figures', 'render', 'total', 'interval'] as const).map(f).join(', ')}`);
  }, 5000);
}

main();
