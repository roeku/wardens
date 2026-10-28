// say (docs/spec/06-voice.md §7, 08-orders.md §9): any sentence through normalise → fast path → brain → resolve
// against a field, printing the reply, the resolved deeds as JSON and the timing, so anyone can try their own
// phrasings.
//
//   npm run say -- "<words>" [--field docs/voice-eval/fixture-08.json] [--live] [--offline] [--reply '<json>']
//                            [--url http://127.0.0.1:8080] [--mode prefill|chat] [--state] [--json]
//
// Without --live a reply cached for these words, this field and this prompt is replayed (out/voice-cache.json),
// and the brain is asked only on a miss; --live always asks it and refreshes the cache; --offline never does.
// --reply skips the brain and resolves a reply you write yourself, e.g. '[{"who":["BORS"],"do":"take","to":"MILL"}]'.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { warm, type BrainMode, type BrainOpts } from '../../web/src/voice/brain.ts';
import { stateText, type Field } from '../../web/src/voice/field.ts';
import { replyOf } from '../../web/src/voice/orders.ts';
import { understand, type BrainAnswer } from '../../web/src/voice/pipeline.ts';
import { ReplyCache, brainFor } from '../voice-cache.ts';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    field: { type: 'string', default: 'docs/voice-eval/fixture-08.json' },
    live: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    reply: { type: 'string' },
    url: { type: 'string', default: process.env.BRAIN_URL ?? 'http://127.0.0.1:8080' },
    mode: { type: 'string', default: 'prefill' },
    state: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

async function main(): Promise<void> {
  const words = positionals.join(' ');
  if (!words && !args.state) throw new Error('usage: npm run say -- "<words>" [--field file] [--live] [--offline] [--reply json]');
  const field = JSON.parse(readFileSync(resolvePath(process.cwd(), args.field!), 'utf8')) as Field;
  if (args.state) console.log(`${stateText(field)}\n`);
  if (!words) return;
  const opts: BrainOpts = { url: args.url!, mode: args.mode as BrainMode, temperature: 0, slot: 0, timeoutMs: 120_000 };
  const cache = new ReplyCache();
  const given = args.reply;
  const brain = given
    ? async (): Promise<BrainAnswer> => ({ reply: replyOf(JSON.parse(given)), raw: given, ms: 0, from: 'given' })
    : brainFor(opts, field, cache, args.live ? 'live' : args.offline ? 'cached' : 'prefer-cache');
  // A live call reads the field first, as the game does when the captain starts to speak.
  if (args.live && !given) await warm(opts, field);
  const u = await understand(field, words, brain);
  cache.save();
  const r = u.resolution;
  if (args.json) {
    console.log(JSON.stringify({ heard: u.heard, path: u.path, reply: u.brain?.raw ?? u.reply, deeds: r.deeds, refused: r.refused, groups: r.groups, ms: u.ms }, null, 2));
    return;
  }
  console.log(`said:   ${words}\nheard:  ${u.heard}\npath:   ${u.path}${u.brain ? ` (${u.brain.from})` : ''}`);
  console.log(`reply:  ${u.brain?.raw ?? JSON.stringify(u.reply.orders)}`);
  if (u.reply.unclear && !r.orders.length) console.log('        unclear: no orders (query horn)');
  for (const o of r.orders) {
    console.log(`order:  ${o.who === 'ARMY' ? 'ARMY' : o.who.join(' ')} ${o.do}${o.group ? ` → group ${o.group.name} = ${o.group.members.join(' ')}` : ''}`);
    for (const a of o.acts) {
      const bits = [
        a.target && `target ${a.target}`, a.to && `to (${a.to.x},${a.to.y})`, a.via?.length && `via ${a.via.map((p) => `(${p.x},${p.y})`).join(' ')}`,
        a.fight !== undefined && `fight ${a.fight}`, a.how && `with ${JSON.stringify(a.how)}`, a.when && `wait ${JSON.stringify(a.when)}`,
        a.work && `work ${a.work}`, a.face !== undefined && `face ${a.face}`, a.n !== undefined && `signal ${a.n}`, a.from && `from ${a.from}`,
      ].filter(Boolean);
      console.log(`  ${a.who.padEnd(6)} ${a.do.padEnd(8)} ${bits.join(', ')}`);
    }
  }
  for (const x of r.refused) console.log(`refused: ${JSON.stringify(x.order)} — ${x.why}`);
  console.log(`deeds:  ${JSON.stringify(r.deeds, null, 2).replace(/\n/g, '\n        ')}`);
  const t = u.brain;
  console.log(
    `timing: ${u.ms.toFixed(1)} ms end to end` +
      (t ? `; brain ${Math.round(t.ms)} ms${t.from === 'cache' ? ' (when it was cached)' : ''}, ${t.genTokens ?? '?'} tokens written, ${t.promptTokens ?? '?'} new prompt tokens` : '') +
      `; resolve ${u.resolveMs.toFixed(2)} ms`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
