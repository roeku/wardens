// The brain's cached prefix (docs/spec/06-voice.md §4a), byte for byte the same on every call, then the
// dynamic field state and the words. The 8 examples use another field and other wording than the eval set.

import { stateText, type Field } from './field.ts';

const RULES = `You are the voice of a warden-captain's will. You turn the captain's spoken words into orders
for the companies on the field. Reply only with JSON in the given schema.

RULES
- Use only the names listed in the field state. Company names, place names, feature names
  and enemy ids are the only targets that exist.
- "Left" and "right" are the ARMY's left and right as it faces the enemy (given as FACING),
  never the screen's.
- Kind words name every company of that kind: riders/horse/cavalry = HORSE, archers/bows = ARCHER,
  spears/pikes = SPEAR, shields = SHIELD. "Everyone", "all", "the army" = ARMY.
  "Everyone else" / "the rest" = OTHERS (every company not named earlier in the same words).
- "take", "free", "save" a village or place = take. "Go", "march", "move", "scout" = move with
  fight=false. "Hold", "stand", "block", "guard" a place = move to it with fight=true, then it holds.
  "Attack", "charge", "kill", "hit", "shoot" = attack. "Form a line", "line up along" = front.
  "Come back", "back", "return", "to me" for a company = recall. "Rally" = rally.
  "Fall back", "retreat" to a place = move with fight=false.
- One sentence may hold several orders. At most 4.
- If the words do not say who or what, set unclear=true and give no orders. Never guess a target
  that was not said.
- "dragon", "drake", "wyrm" all mean drakes; "troll", "giant" mean trolls; "them", "the enemy"
  means the nearest seen foe to the named company.
`;

const EXAMPLE_FIELD = `EXAMPLES, on another field:
FACING north. Army left = west.
OURS: KAEL spear 12/12 (20,30) idle | MAREK shield 10/10 (24,30) idle | HUGH archer 10/10 (22,34) idle |
      TAMSIN horse 6/6 (29,31) idle | CAPTAIN (22,32) hp 100%
FOES SEEN: E4 drakes 3 (18,12) idle | E7 blight-men 12 (25,15) marching south
PLACES: CHAPEL village (31,14) foe-held | WEIR road (16,20)
GROUND: BARROW hill (26,24) r3 | ASHWOOD wood (8-13,22-27) | BROOK river y 18-19, fords at x 16 and 30`;

const EXAMPLES: [string, string][] = [
  ['tamsin swing wide on the right and save the chapel', '{"orders":[{"who":["TAMSIN"],"do":"take","target":"CHAPEL","side":"right","fight":true}],"unclear":false}'],
  ['bowmen guard the weir and the rest of you up onto the barrow', '{"orders":[{"who":["ARCHER"],"do":"move","target":"WEIR","side":"none","fight":true},{"who":["OTHERS"],"do":"move","target":"BARROW","side":"none","fight":false}],"unclear":false}'],
  ['line up behind the brook', '{"orders":[{"who":["ARMY"],"do":"front","target":"BROOK","side":"none","fight":false}],"unclear":false}'],
  ['all of you go for the wyrms', '{"orders":[{"who":["ARMY"],"do":"attack","target":"E4","side":"none","fight":true}],"unclear":false}'],
  ['pikes roll up the blight-men from their flank', '{"orders":[{"who":["SPEAR"],"do":"attack","target":"E7","side":"left","fight":true}],"unclear":false}'],
  ['retreat into ashwood', '{"orders":[{"who":["ARMY"],"do":"move","target":"ASHWOOD","side":"none","fight":false}],"unclear":false}'],
  ['marek stand fast where you are', '{"orders":[{"who":["MAREK"],"do":"hold","target":"HERE","side":"none","fight":true}],"unclear":false}'],
  ['hugh er no the', '{"orders":[],"unclear":true}'],
];

/** The static prefix: rules, then the examples. Identical on every call, so the server caches it. */
export const PREFIX = `${RULES}\n${EXAMPLE_FIELD}\n${EXAMPLES.map(([said, reply]) => `SAID: ${said}\n${reply}`).join('\n')}`;

/** The user turn: the field as the captain sees it, then the words. Everything before `SAID:` can be cached. */
export function userTurn(field: Field, said: string): string {
  return `${stateText(field)}\n\nSAID: ${said}`;
}
