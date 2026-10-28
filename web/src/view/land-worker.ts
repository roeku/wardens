// The land worker (docs/spec/03-land.md §10): a module worker that loads the same WASM as the page, makes the land
// for a map and transfers its buffers back instead of copying them. The result is bit-identical to making it inline.

import init, { Land } from '../sim-pkg/sim_wasm.js';
import { takeLand } from './land-data';

const ready = init();

self.onmessage = async (e: MessageEvent<{ id: number; mapJson: string }>) => {
  const { id, mapJson } = e.data;
  try {
    await ready;
    const t0 = performance.now();
    const l = new Land(mapJson);
    const land = takeLand(l, performance.now() - t0, 'worker');
    const buffers: Transferable[] = [land.heights.buffer, land.rgba.buffer, land.water.buffer];
    for (const p of Object.values(land.parts)) buffers.push(p.mat.buffer, p.col.buffer);
    (self as unknown as Worker).postMessage({ id, land }, buffers);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
