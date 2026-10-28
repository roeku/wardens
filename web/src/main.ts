import init, { Battle, version } from './sim-pkg/sim_wasm.js';
import { installDev } from './dev';
import { bindCameraControls } from './input/camera-controls';
import type { Tier } from './view/renderer';
import { View } from './view/view';

// URL flags (docs/spec/01-flow.md §5): ?seed= ?map= (width) ?px= ?tier=, and ?kind=keep|town|ford for now.
const params = new URLSearchParams(location.search);
const num = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);

async function main(): Promise<void> {
  await init();
  console.log(`[sim] ${version()}`);
  const seed = num('seed') ?? 4;
  const battle = new Battle(seed, JSON.stringify({ kind: params.get('kind') ?? 'keep', width: num('map') ?? 48 }));
  const tier = (params.get('tier') ?? 'high') as Tier;
  const view = new View(document.body, { w: battle.map_w, h: battle.map_h, heights: battle.heights() }, { px: num('px'), tier });
  if (import.meta.env.DEV) installDev(view);
  const controls = bindCameraControls(view);
  window.addEventListener('resize', () => view.resize());

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    controls(dt);
    view.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
