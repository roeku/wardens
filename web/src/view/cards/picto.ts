// Pictograms (docs/spec/01-flow.md §3 "Diegetic UI rules"; 07-progression.md §7): ASCII bitmaps drawn at the 5×7
// font's scale, in whole pixels, scaled by integers only. Seven rows each, up to seven columns, '#' lit. The kind
// marks are the banners' own (figures/atlas.ts `NEAR.marks`: spear, shield, bow, horseshoe) and the blight's are its
// standards' sigils (claw, crack, flame, eye), redrawn on seven rows. The four ways have a sign each (a commander's
// card, the place card's broodlord).

export type Icon =
  | 'man' | 'chevron' | 'swords' | 'banner' | 'pennant' | 'heart' | 'heart-empty' | 'broken-sword' | 'hall'
  | 'ribbon' | 'coin' | 'spear' | 'shield' | 'bow' | 'horse' | 'blightman' | 'troll' | 'drake' | 'broodlord'
  | 'stubborn' | 'reckless' | 'steady' | 'veteran' | 'cairn' | 'tent';

export const PICTO_H = 7;

const ART: Record<Icon, string[]> = {
  man: ['..#..', '.###.', '..#..', '#####', '..#..', '.#.#.', '#...#'],
  chevron: ['.......', '...#...', '..###..', '.##.##.', '##...##', '#.....#', '.......'],
  swords: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '##...##', '##...##'],
  banner: ['#....', '#####', '#####', '#####', '##.##', '#...#', '#....'],
  pennant: ['#....', '###..', '#####', '###..', '#....', '#....', '#....'],
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...', '.......'],
  'heart-empty': ['.##.##.', '#..#..#', '#.....#', '.#...#.', '..#.#..', '...#...', '.......'],
  'broken-sword': ['.....##', '....##.', '.......', '..##...', '.##....', '###....', '.#.....'],
  hall: ['...#...', '..###..', '.#####.', '#######', '.#...#.', '.#.#.#.', '.#.#.#.'],
  ribbon: ['.###.', '.#.#.', '.###.', '.#.#.', '#...#', '#...#', '.....'],
  coin: ['.###.', '#...#', '#.#.#', '#.#.#', '#.#.#', '#...#', '.###.'],
  spear: ['..#..', '.###.', '.###.', '..#..', '..#..', '..#..', '..#..'],
  shield: ['#####', '#####', '#####', '#####', '.###.', '..#..', '.....'],
  bow: ['.......', '.#.....', '..#..#.', '#######', '..#..#.', '.#.....', '.......'],
  horse: ['.###.', '#...#', '#...#', '#...#', '#...#', '##.##', '.....'],
  blightman: ['#.#.#..', '#.#.#..', '.#.#.#.', '.#.#.#.', '..#.#.#', '..#.#.#', '.......'],
  troll: ['....#..', '...##..', '...#...', '..##...', '.####..', '...##..', '....#..'],
  drake: ['...#...', '..##...', '..###..', '.####..', '.#####.', '###.###', '.#####.'],
  broodlord: ['#.....#', '.#...#.', '..###..', '.##.##.', '#.#.#.#', '.##.##.', '..###..'],
  stubborn: ['#######', '.#####.', '..###..', '..###..', '.#####.', '#######', '.......'],
  reckless: ['....##.', '...##..', '..##...', '.#####.', '...##..', '..##...', '.##....'],
  steady: ['#######', '.#...#.', '.#...#.', '.#...#.', '.#...#.', '.#...#.', '#######'],
  veteran: ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'],
  cairn: ['.......', '..##...', '.####..', '..###..', '.#####.', '#######', '.......'],
  tent: ['...#...', '..###..', '.##.##.', '.#...#.', '##...##', '#.....#', '.......'],
};

/** Each icon's rows as bit masks (bit w−1 is the left column), and its width. */
const BITS = new Map<Icon, { w: number; rows: number[] }>();
for (const [k, rows] of Object.entries(ART) as [Icon, string[]][]) {
  const w = Math.max(...rows.map((r) => r.length));
  BITS.set(k, { w, rows: rows.map((r) => [...r].reduce((b, c, i) => b | (c === '#' ? 1 << (w - 1 - i) : 0), 0)) });
}

/** The width of an icon in font pixels at scale 1. */
export function pictoWidth(icon: Icon): number {
  return BITS.get(icon)?.w ?? 0;
}

/** Draws `icon` with its top-left at (x, y), each lit pixel a `scale`² square of `colour`. Whole pixels only. */
export function drawPicto(ctx: CanvasRenderingContext2D, icon: Icon, x: number, y: number, colour: string, scale = 1): void {
  const b = BITS.get(icon);
  if (!b) return;
  const s = Math.max(1, Math.round(scale));
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  ctx.fillStyle = colour;
  for (let r = 0; r < b.rows.length; r++) {
    const bits = b.rows[r];
    for (let c = 0; c < b.w; c++) if (bits & (1 << (b.w - 1 - c))) ctx.fillRect(x0 + c * s, y0 + r * s, s, s);
  }
}

/** The kind mark of a unit (07-progression.md §7: the garrison as kind × count). */
export function kindIcon(unit: string): Icon {
  switch (unit) {
    case 'shield':
      return 'shield';
    case 'archer':
    case 'bow':
      return 'bow';
    case 'horse':
      return 'horse';
    case 'blightman':
    case 'troll':
    case 'drake':
    case 'broodlord':
      return unit;
    default:
      return 'spear';
  }
}

/** A way's sign. */
export function wayIcon(way: string): Icon {
  return way === 'stubborn' || way === 'reckless' || way === 'steady' || way === 'veteran' ? way : 'steady';
}
