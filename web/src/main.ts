import init, { version } from './sim-pkg/sim_wasm.js';

async function main(): Promise<void> {
  await init();
  console.log(`[sim] ${version()}`);
}

main();
