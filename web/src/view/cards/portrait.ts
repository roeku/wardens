// Faces on cards (docs/engine/contracts/campaign.md §6): `portrait(face, side, opts)` from web/src/view/portraits
// draws an 80×96 face, cached. That module is another part's and may not exist yet: it is looked for with a glob, so
// the screens build and run without it, and until it lands a card shows a flat tile in the side's colour.

type PortraitFn = (face: number, side: 'warden' | 'blight', opts?: { grey?: boolean; unit?: string }) => HTMLCanvasElement;

// Lazy, so a portraits module half-written (or failing) leaves the cards on flat tiles instead of breaking the page.
const mods = import.meta.glob<{ portrait?: PortraitFn }>('../portraits/index.ts');
let loaded: PortraitFn | null = null;
let loading: Promise<void> | null = null;

/** Loads the portraits part if it is there (once); the cards use it from then on. */
export function loadPortraits(): Promise<void> {
  loading ??= Promise.all(
    Object.values(mods).map((load) =>
      load()
        .then((m) => {
          if (typeof m.portrait === 'function') loaded = m.portrait;
        })
        .catch((e) => console.warn('[cards] the portraits did not load; flat tiles instead', e)),
    ),
  ).then(() => {});
  return loading;
}

/** The portraits part's `portrait`, if it has loaded. */
export function portraitFn(): PortraitFn | null {
  return loaded;
}

/** 02-look.md §4: team [1] (capes, roofs) for each side, and a grey. */
const TILE = { warden: '#1f5a80', blight: '#86281f', grey: '#6e6a62' } as const;
const tiles = new Map<string, HTMLCanvasElement>();

/** An 80×96 face: the portrait, or a flat side-coloured tile (grey for the fallen). */
export function faceTile(face: number, side: 'warden' | 'blight', opts: { grey?: boolean; unit?: string } = {}): HTMLCanvasElement {
  const fn = portraitFn();
  if (fn) {
    try {
      return fn(face, side, opts);
    } catch (e) {
      console.warn('[cards] portrait failed, a flat tile instead', e);
    }
  }
  const key = opts.grey ? 'grey' : side;
  let c = tiles.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = 80;
    c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = opts.grey ? TILE.grey : TILE[side];
    g.fillRect(0, 0, 80, 96);
    tiles.set(key, c);
  }
  return c;
}
