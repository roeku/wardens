// Persistence (docs/spec/01-flow.md §5): localStorage, every access wrapped in try/catch. The campaign is kept only
// between battles (`Campaign.save()`), so a battle left unfinished is refought from its start; a version mismatch
// discards it. Other keys: the Hall per campaign, the last campaign chosen, the last custom setup, the settings and
// mute. The screens' own memory of the road (cairns and planted banners, the land remembers) rides with the
// campaign's save, written at the same moments.

const KEY = {
  campaign: 'wardens.campaign',
  hall: (c: string) => `wardens.hall.${c}`,
  last: 'wardens.campaign.last',
  custom: 'wardens.custom',
  settings: 'wardens.settings',
  mute: 'wardens.mute',
};

/** The screens' wrapper's version; the campaign's own `v` is the sim's (Campaign.load throws on a mismatch). */
export const SAVE_V = 1;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readJson<T>(key: string): T | null {
  const s = read(key);
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** A cairn or a planted banner on the road: where, and what it remembers. */
export interface RoadProp {
  kind: 'cairn' | 'banner';
  place: number;
  x: number;
  y: number;
  /** A banner's company name and face (tapping it shows the grey face), and its honours. */
  name?: string;
  face?: number;
  ribbons?: number;
}

/** What the screens keep beside the campaign's own save. */
export interface ScreensMemory {
  props: RoadProp[];
  /** Men fallen at each place, by place id (one cairn per 3). */
  dead: Record<string, number>;
}

export interface KeptCampaign {
  v: number;
  /** `Campaign.save()`. */
  save: string;
  campaign: string;
  memory: ScreensMemory;
}

export const emptyMemory = (): ScreensMemory => ({ props: [], dead: {} });

/** The Hall of one campaign: the fallen commanders' banners and the enemy colours taken, across campaigns. */
export interface HallBanner {
  name: string;
  face: number;
  way?: string;
  rank?: number;
  unit?: string;
}
export interface Hall {
  fallen: HallBanner[];
  colours: HallBanner[];
}

/** 01-flow.md §3.10, 03-land.md §7: at most 24 fallen and 12 enemy colours. */
export const HALL_FALLEN = 24;
export const HALL_COLOURS = 12;

export interface CustomSetup {
  kind: 'field' | 'night' | 'keep' | 'hold' | 'village' | 'ford';
  size: 4 | 6 | 9;
  strength: 'easy' | 'fair' | 'hard';
  land: string;
}

export const DEFAULT_CUSTOM: CustomSetup = { kind: 'field', size: 4, strength: 'fair', land: 'any' };

export const saves = {
  campaign(): KeptCampaign | null {
    const k = readJson<KeptCampaign>(KEY.campaign);
    if (!k || k.v !== SAVE_V || typeof k.save !== 'string') return null;
    k.memory ??= emptyMemory();
    return k;
  },
  keepCampaign(save: string, campaign: string, memory: ScreensMemory): boolean {
    return write(KEY.campaign, JSON.stringify({ v: SAVE_V, save, campaign, memory } satisfies KeptCampaign));
  },
  /** Discards the kept campaign (it ended, or its version no longer loads). */
  dropCampaign(): void {
    write(KEY.campaign, null);
  },
  hall(campaign: string): Hall {
    const h = readJson<Hall>(KEY.hall(campaign));
    return { fallen: h?.fallen ?? [], colours: h?.colours ?? [] };
  },
  /** Adds a campaign's fallen and colours to its Hall, keeping the newest up to the limits. */
  addToHall(campaign: string, add: Hall): Hall {
    const h = saves.hall(campaign);
    const out: Hall = {
      fallen: [...h.fallen, ...add.fallen].slice(-HALL_FALLEN),
      colours: [...h.colours, ...add.colours].slice(-HALL_COLOURS),
    };
    write(KEY.hall(campaign), JSON.stringify(out));
    return out;
  },
  lastCampaign(): string | null {
    return read(KEY.last);
  },
  setLastCampaign(c: string): void {
    write(KEY.last, c);
  },
  custom(): CustomSetup {
    return { ...DEFAULT_CUSTOM, ...(readJson<Partial<CustomSetup>>(KEY.custom) ?? {}) };
  },
  setCustom(c: CustomSetup): void {
    write(KEY.custom, JSON.stringify(c));
  },
  settings(): Record<string, unknown> {
    return readJson<Record<string, unknown>>(KEY.settings) ?? {};
  },
  setSettings(s: Record<string, unknown>): void {
    write(KEY.settings, JSON.stringify(s));
  },
  muted(): boolean {
    return read(KEY.mute) === '1';
  },
  setMuted(on: boolean): void {
    write(KEY.mute, on ? '1' : '0');
  },
};
