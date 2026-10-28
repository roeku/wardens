import init, { Battle, version } from './sim-pkg/sim_wasm.js';
import { installDev } from './dev';
import { bindCameraControls } from './input/camera-controls';
import { makeLandInWorker, makeLandInline } from './view/land';
import type { Tier } from './view/renderer';
import { View } from './view/view';

// URL flags (docs/spec/01-flow.md §5): ?seed= ?map= (width) ?px= ?tier=, ?kind=keep|town|ford for now, and
// ?land=inline|worker to choose where the land is made (the worker by default, 03-land.md §10).
const params = new URLSearchParams(location.search);
const num = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);

async function main(): Promise<void> {
  await init();
  console.log(`[sim] ${version()}`);
  const seed = num('seed') ?? 4;
  const battle = new Battle(seed, JSON.stringify({ kind: params.get('kind') ?? 'keep', width: num('map') ?? 48 }));
  const tier = (params.get('tier') ?? 'high') as Tier;
  const t0 = performance.now();
  const land = params.get('land') === 'inline' ? makeLandInline(battle) : await makeLandInWorker(battle.map_json());
  console.log(`[land] ${land.where}: make ${land.ms.toFixed(1)} ms, ready after ${(performance.now() - t0).toFixed(1)} ms`);
  const view = new View(document.body, land, { px: num('px'), tier });
  if (import.meta.env.DEV) installDev(view);
  const controls = bindCameraControls(view);
  window.addEventListener('resize', () => view.resize());

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    view.time += dt;
    controls(dt);
    view.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
