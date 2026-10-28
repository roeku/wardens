// What the voice brain is told about the battle (docs/spec/06-voice.md §4b, §4c): a fog-limited field, its
// compact text, and the per-battle schema whose enums hold every name the model may use. Pure; no DOM.

import type { P } from '../contracts.ts';

export type CompanyKind = 'spear' | 'shield' | 'archer' | 'horse' | 'levy';

export interface FieldCompany {
  id: number;
  name: string;
  kind: CompanyKind;
  men: number;
  full: number;
  x: number;
  y: number;
  state: string;
  /** Detached from the army by an order of its own. */
  detached?: boolean;
}

export interface FieldFoe {
  /** Shown to the model as `E<id>`. */
  id: string;
  kind: string;
  men: number;
  x: number;
  y: number;
  state: string;
}

export interface FieldPlace {
  name: string;
  type: string;
  x: number;
  y: number;
  holder: 'ours' | 'foe' | 'none';
  burning?: string;
}

export type FieldGround =
  | { name: string; type: 'hill'; x: number; y: number; r: number }
  | { name: string; type: 'wood'; x0: number; y0: number; x1: number; y1: number }
  | { name: string; type: 'river'; x0: number; x1: number; fords: number[] };

export interface Field {
  facing: string;
  armyLeft: string;
  threatPoint: P;
  ours: FieldCompany[];
  captain: { x: number; y: number; hp: number };
  foesSeen: FieldFoe[];
  places: FieldPlace[];
  ground: FieldGround[];
}

/** Kind words the model may use in `who`, and the company kinds they name. */
export const KIND_WORDS: Record<string, CompanyKind> = { HORSE: 'horse', SPEAR: 'spear', SHIELD: 'shield', ARCHER: 'archer' };

const OURS_PER_LINE = 3;

/** The dynamic field state, about 250 tokens (§4b). */
export function stateText(f: Field): string {
  const ours = f.ours.map((c) => `${c.name} ${c.kind} ${c.men}/${c.full} (${c.x},${c.y}) ${c.state}`);
  ours.push(`CAPTAIN (${f.captain.x},${f.captain.y}) hp ${Math.round(f.captain.hp * 100)}%`);
  const lines: string[] = [];
  for (let i = 0; i < ours.length; i += OURS_PER_LINE) lines.push(ours.slice(i, i + OURS_PER_LINE).join(' | '));
  const foes = f.foesSeen.map((e) => `${e.id} ${e.kind} ${e.men} (${e.x},${e.y}) ${e.state}`);
  const places = f.places.map((p) => {
    // Only a village changes hands, so only a village says who holds it (as in docs/voice-eval/fixture.json).
    const held = p.type === 'village' && p.holder !== 'none' ? ` ${p.holder}-held` : '';
    const burning = p.burning ? ` burning ${p.burning}` : '';
    return `${p.name} ${p.type} (${p.x},${p.y})${held}${burning}`;
  });
  const ground = f.ground.map((g) => {
    if (g.type === 'hill') return `${g.name} hill (${g.x},${g.y}) r${g.r}`;
    if (g.type === 'wood') return `${g.name} wood (${g.x0}-${g.x1},${g.y0}-${g.y1})`;
    return `${g.name} x ${g.x0}-${g.x1}, fords at y ${g.fords.join(' and ')}`;
  });
  return [
    `FACING ${f.facing}. Army left = ${f.armyLeft}.`,
    `OURS: ${lines.join(' |\n      ')}`,
    `FOES SEEN: ${foes.join(' | ')}`,
    `PLACES: ${places.join(' | ')}`,
    `GROUND: ${ground.join(' | ')}`,
  ].join('\n');
}

/** The output schema built per battle, so every name is an enum the model cannot invent (§4c). */
export function orderSchema(f: Field): object {
  const who = ['ARMY', 'OTHERS', ...Object.keys(KIND_WORDS), ...f.ours.map((c) => c.name)];
  const target = ['NONE', 'HERE', ...f.places.map((p) => p.name), ...f.ground.map((g) => g.name), ...f.foesSeen.map((e) => e.id)];
  return {
    type: 'object',
    properties: {
      orders: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            who: { type: 'array', minItems: 1, items: { enum: who } },
            do: { enum: ['move', 'attack', 'take', 'front', 'hold', 'recall', 'rally'] },
            target: { enum: target },
            side: { enum: ['none', 'left', 'right', 'front', 'back'] },
            fight: { type: 'boolean' },
          },
          required: ['who', 'do', 'target', 'side', 'fight'],
        },
      },
      unclear: { type: 'boolean' },
    },
    required: ['orders', 'unclear'],
  };
}

/** The same schema as a GBNF grammar with no whitespace, so the reply is as few tokens as it can be. */
export function orderGrammar(f: Field): string {
  const schema = orderSchema(f) as { properties: { orders: { items: { properties: Record<string, { items?: { enum: string[] }; enum?: string[] }> } } } };
  const props = schema.properties.orders.items.properties;
  const alt = (xs: string[]) => xs.map((x) => `"\\"${x}\\""`).join(' | ');
  return [
    `root ::= "{\\"orders\\":[" (order ("," order)? ("," order)? ("," order)?)? "],\\"unclear\\":" bool "}"`,
    `order ::= "{\\"who\\":[" who ("," who)* "],\\"do\\":" do ",\\"target\\":" target ",\\"side\\":" side ",\\"fight\\":" bool "}"`,
    `who ::= ${alt(props.who.items!.enum)}`,
    `do ::= ${alt(props.do.enum!)}`,
    `target ::= ${alt(props.target.enum!)}`,
    `side ::= ${alt(props.side.enum!)}`,
    `bool ::= "true" | "false"`,
  ].join('\n');
}
