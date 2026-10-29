import { drawText } from '../../view/font5x7';
import { hash32 } from '../../view/figures/hash';
import init, { Campaign } from '../../sim-pkg/sim_wasm.js';
import { BG, palette, paletteInputs, portrait, portraitCheck, portraitImage, type Side } from '../../view/portraits';
import { H, lab, W, toCanvas, type Img } from '../../view/portraits/post';
import { brute } from '../../view/figures/person';

// The faces lab (dev only): http://localhost:5182/labs/faces.html?seed=7&scale=2&compare=1. A seed's cast of
// commanders, both sides, in colour and in the grey of the fallen, at an integer scale; with ?compare=1 a row of the
// kit's fallback (a), the figure's own head close up, for the comparison in out/decisions-d5-faces.md. Driven from
// window.__faces: cast(seed), gate(), shot(name).

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);

/** Synthetic commanders' units: every kind, the captain last. */
const UNITS = ['spear', 'shield', 'archer', 'horse', 'spear', 'shield', 'archer', 'horse', 'levy', 'spear', 'shield', 'captain'] as const;
/** A commander's `suits` (contract campaign §3) as the unit whose headgear he wears before he is given a company. */
const SUITS: Record<string, string> = { spear: 'spear', shield: 'shield', bow: 'archer', archer: 'archer', horse: 'horse' };

export interface Member {
  face: number;
  side: Side;
  unit: string;
  rank: number;
  /** The campaign's name, when the member is one of its people. */
  name?: string;
}

interface CampaignState {
  warband: { captain: { name: string; face: number } };
  muster: { commanders: { name: string; face: number; suits: string; veteran: boolean }[] };
  foes: { name: string; face: number; rank: number }[];
}

let campaignOf: ((seed: number) => CampaignState | null) | null = null;

/**
 * A campaign's cast for a seed: its captain, the commanders at its muster and its foes (eight captains and the lord
 * of the keep), from the campaign's own WASM object (contract campaign §2–§3) with their `face` seeds; then, for the
 * budget's "about 12 wardens", commanders the road would add later, from stable synthetic seeds (unnamed).
 */
export function castOf(seed: number): Member[] {
  const st = campaignOf?.(seed) ?? null;
  const wardens: Member[] = [];
  const foes: Member[] = [];
  if (st) {
    wardens.push({ face: st.warband.captain.face, side: 'warden', unit: 'captain', rank: 0, name: st.warband.captain.name });
    for (const c of st.muster.commanders) wardens.push({ face: c.face, side: 'warden', unit: SUITS[c.suits] ?? 'spear', rank: c.veteran ? 1 : 0, name: c.name });
    for (const f of st.foes) foes.push({ face: f.face, side: 'blight', unit: 'broodlord', rank: 0, name: f.name });
  }
  for (let i = 0; wardens.length < 12; i++) {
    const unit = UNITS[i % UNITS.length];
    if (st && unit === 'captain') continue;
    wardens.push({ face: hash32(seed, i, 0xca57) || 1, side: 'warden', unit, rank: unit === 'captain' ? 0 : hash32(seed, i, 0x4a4b) % 4 });
  }
  for (let i = 0; foes.length < 9; i++) foes.push({ face: hash32(seed, 100 + i, 0xca57) || 1, side: 'blight', unit: 'broodlord', rank: 0 });
  return [...wardens, ...foes];
}

const S = Math.max(1, Math.round(num('scale', 2)));
const GAP = 4;
const PAD = 8;
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const g = canvas.getContext('2d')!;

const INK = '#16120f';
const CREAM = '#f1ead6';

let compareImgs: Img[] | null = null;

function draw(seed: number, compare: boolean): void {
  const cast = castOf(seed);
  const wardens = cast.filter((m) => m.side === 'warden');
  const foes = cast.filter((m) => m.side === 'blight');
  const rows = compare ? 5 : 4;
  const colW = W + GAP;
  const rowH = H + GAP + 10;
  canvas.width = (PAD * 2 + 12 * colW) * S;
  canvas.height = (PAD * 2 + 12 + rows * rowH) * S;
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  g.imageSmoothingEnabled = false;
  g.fillStyle = INK;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.save();
  g.scale(S, S);
  drawText(g, `FACES  SEED ${seed}`, PAD, PAD, CREAM);
  const put = (c: HTMLCanvasElement, col: number, row: number, label?: string) => {
    const x = PAD + col * colW, y = PAD + 12 + row * rowH;
    g.drawImage(c, x, y);
    if (label) drawText(g, label, x, y + H + 2, CREAM);
  };
  wardens.forEach((m, i) => put(portrait(m.face, 'warden', { unit: m.unit, rank: m.rank }), i, 0, m.name ?? `${m.unit.toUpperCase().slice(0, 6)} ${m.rank}`));
  wardens.forEach((m, i) => put(portrait(m.face, 'warden', { unit: m.unit, rank: m.rank, grey: true }), i, 1));
  foes.forEach((m, i) => put(portrait(m.face, 'blight', {}), i, 2, m.name ?? `LORD ${i + 1}`));
  foes.forEach((m, i) => put(portrait(m.face, 'blight', { grey: true }), i, 3));
  if (compare && compareImgs) compareImgs.forEach((img, i) => put(toCanvas(img), i, 4, i < 6 ? 'A WARDEN' : 'A LORD'));
  g.restore();
}

/** Fallback (a), the figure's head close up, for the first 6 wardens and 3 broodlords of the cast. */
async function makeCompare(seed: number): Promise<{ ms: number }> {
  const { closeUp } = await import('../../view/portraits/close');
  const cast = castOf(seed);
  const pick = [...cast.filter((m) => m.side === 'warden').slice(0, 6), ...cast.filter((m) => m.side === 'blight').slice(0, 3)];
  const t0 = performance.now();
  compareImgs = pick.map((m) => {
    const unit = m.side === 'blight' ? 'broodlord' : m.unit;
    const kind = m.side === 'blight' || m.unit === 'captain' ? 'captain' : (m.unit as 'spear');
    return closeUp(m.face, { side: m.side, kind, unit: unit as 'spear', rank: m.rank, captain: m.side === 'blight' || m.unit === 'captain', bg: BG[m.side] });
  });
  return { ms: performance.now() - t0 };
}

let seed = num('seed', 7);
let compare = params.get('compare') === '1';

const fnv = (img: Img) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < img.length; i++) h = Math.imul(h ^ img[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};

/** The gate's numbers (out/decisions-d5-faces.md "Gate"). */
function gate(seeds = [7, 11, 2026]) {
  const rows: Record<string, unknown>[] = [];
  // timing: whole casts (the palettes are made by the page's first, cold, cast: window.__facesCold)
  const timing = seeds.map((s) => {
    const cast = castOf(s);
    const t0 = performance.now();
    for (const m of cast) portraitImage(m.face, m.side, { unit: m.unit, rank: m.rank });
    const t1 = performance.now();
    for (const m of cast) portraitImage(m.face, m.side, { unit: m.unit, rank: m.rank, grey: true });
    const t2 = performance.now();
    return { seed: s, n: cast.length, colourMs: +(t1 - t0).toFixed(1), perPortraitMs: +((t1 - t0) / cast.length).toFixed(2), greyMs: +(t2 - t1).toFixed(1) };
  });
  const colours: Record<Side, Set<number>> = { warden: new Set(), blight: new Set() };
  const greys: Record<Side, Set<number>> = { warden: new Set(), blight: new Set() };
  let worstEye = 0, worstMid = 0, misses = 0, nondet = 0, shifted = 0;
  const hashes: number[] = [];
  for (const s of seeds) {
    for (const m of castOf(s)) {
      const a = portraitCheck(m.face, m.side, { unit: m.unit, rank: m.rank });
      const b = portraitImage(m.face, m.side, { unit: m.unit, rank: m.rank });
      const gr = portraitImage(m.face, m.side, { unit: m.unit, rank: m.rank, grey: true });
      if (a.img.some((v, i) => v !== b[i])) nondet++;
      hashes.push(parseInt(fnv(a.img), 16));
      a.img.forEach((v) => colours[m.side].add(v));
      gr.forEach((v) => greys[m.side].add(v));
      if (a.shiftX || a.shiftY) shifted++;
      if (!Number.isFinite(a.eyeY) || !Number.isFinite(a.midX)) {
        misses++;
        continue;
      }
      worstEye = Math.max(worstEye, Math.abs(a.eyeY - 40));
      worstMid = Math.max(worstMid, Math.abs(a.midX - 40));
      rows.push({ seed: s, side: m.side, unit: m.unit, face: m.face, eyes: a.eyes, eyeY: +a.eyeY.toFixed(2), midX: a.midX, shift: [a.shiftX, a.shiftY] });
    }
  }
  // how far apart a cast's faces are (the coordinator's check: nine foes must differ at a glance)
  const labMemo = new Map<number, [number, number, number]>();
  const L = (hex: number) => {
    let v = labMemo.get(hex);
    if (!v) labMemo.set(hex, (v = lab(hex)));
    return v;
  };
  const apart = (imgs: Img[]) => {
    let minDE = Infinity, minShare = 1;
    for (let i = 0; i < imgs.length; i++) {
      for (let j = i + 1; j < imgs.length; j++) {
        let de = 0, n = 0;
        for (let k = 0; k < imgs[i].length; k++) {
          if (imgs[i][k] === imgs[j][k]) continue;
          const p = L(imgs[i][k]), q = L(imgs[j][k]);
          de += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          n++;
        }
        minDE = Math.min(minDE, de / imgs[i].length);
        minShare = Math.min(minShare, n / imgs[i].length);
      }
    }
    return { minMeanDE: +minDE.toFixed(1), minDifferingShare: +minShare.toFixed(3) };
  };
  const distinct = seeds.map((s) => {
    const cast = castOf(s);
    const foes = cast.filter((m) => m.side === 'blight');
    const looks = foes.map((m) => brute(m.face || 1));
    let hideHorns = 0, lookalikes = 0, silhouettes = 0, maxShared = 0;
    for (let i = 0; i < looks.length; i++) {
      for (let j = i + 1; j < looks.length; j++) {
        const a = looks[i], b = looks[j];
        const same = [a.flesh === b.flesh, a.horns === b.horns, a.maneShape === b.maneShape, a.mane === b.mane, a.eyes === b.eyes, a.muzzle === b.muzzle, a.paint === b.paint, a.hornColour === b.hornColour, a.pattern === b.pattern];
        if (same[0] && same[1]) hideHorns++;
        // alike at a glance: the same hide, horns (shape and colour), mane and muzzle
        if (same[0] && same[1] && same[7] && same[2] && (a.maneShape === 0 || same[3]) && same[5] && same[8]) lookalikes++;
        // the silhouette and hide alone (hide, horn shape, mane shape), colours of horn and mane aside
        if (same[0] && same[1] && same[2]) silhouettes++;
        maxShared = Math.max(maxShared, same.filter(Boolean).length);
      }
    }
    const wardens = cast.filter((m) => m.side === 'warden');
    return {
      seed: s,
      foes: { pairs: (looks.length * (looks.length - 1)) / 2, hideAndHorns: hideHorns, hideHornsMane: silhouettes, alikeAtAGlance: lookalikes, mostTraitsShared: `${maxShared}/9`, ...apart(foes.map((m) => portraitImage(m.face, 'blight', {}))) },
      wardens: apart(wardens.map((m) => portraitImage(m.face, 'warden', { unit: m.unit, rank: m.rank }))),
      hides: looks.map((l) => l.flesh.toString(16)).join(' '),
    };
  });
  return {
    timing,
    distinct,
    palette: { warden: palette('warden').length, blight: palette('blight').length, inputs: { ...paletteInputs } },
    coloursUsed: { warden: colours.warden.size, blight: colours.blight.size },
    greysUsed: { warden: greys.warden.size, blight: greys.blight.size },
    align: { faces: rows.length, misses, shifted, worstEyeOff: worstEye, worstMidOff: worstMid },
    deterministic: nondet === 0,
    castHash: fnv(new Uint32Array(hashes)),
    rows,
  };
}

const api = {
  castOf,
  /** Draws seed `s`'s cast (and the (a) row when compare is on). */
  async cast(s: number, cmp = compare): Promise<number> {
    seed = s;
    compare = cmp;
    if (compare) await makeCompare(seed);
    draw(seed, compare);
    return seed;
  },
  gate,
  compareMs: (s = seed) => makeCompare(s),
  /** Saves the lab's picture to out/shots/<name>.png. */
  async shot(name: string): Promise<string> {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('no picture');
    const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    return ((await res.json()) as { path: string }).path;
  },
};
(window as unknown as { __faces: typeof api }).__faces = api;

// the campaign's people when its WASM object loads (else the synthetic cast alone)
try {
  await init();
  campaignOf = (s: number) => {
    const c = Campaign.create(s, JSON.stringify({ campaign: 'warden', banners: 4 }));
    try {
      return JSON.parse(c.state_json()) as CampaignState;
    } finally {
      c.free();
    }
  };
  campaignOf(seed);
} catch (e) {
  console.warn('[faces] no campaign: the synthetic cast only', e);
  campaignOf = null;
}

// the first draw is timed cold: the palettes and every portrait made from nothing, in colour, then the grey of the
// fallen (made from the colour pictures)
const coldCast = castOf(seed);
const t0 = performance.now();
const cold = coldCast.map((m) => portrait(m.face, m.side, { unit: m.unit, rank: m.rank }));
const t1 = performance.now();
coldCast.forEach((m) => portrait(m.face, m.side, { unit: m.unit, rank: m.rank, grey: true }));
const t2 = performance.now();
(window as unknown as { __facesCold: unknown }).__facesCold = { seed, portraits: cold.length, campaign: !!campaignOf, colourMs: +(t1 - t0).toFixed(1), greyMs: +(t2 - t1).toFixed(1), totalMs: +(t2 - t0).toFixed(1) };
console.log(`[faces] cold cast of ${cold.length}: colour ${(t1 - t0).toFixed(1)} ms, grey ${(t2 - t1).toFixed(1)} ms`);
void api.cast(seed, compare);
