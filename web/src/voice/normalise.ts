// Normalising the words and matching names (docs/spec/06-voice.md §5). Pure.

const FILLERS = new Set(['uh', 'um', 'er', 'okay', 'ok', 'now', 'please']);
const NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

/**
 * Lowercase, punctuation stripped, number words as digits, fillers dropped. "go on" and "right" count as fillers
 * only at the start ("right, everyone hold"), because elsewhere "right" is a side (DECISIONS.md D-07).
 */
export function normalise(text: string): string {
  let words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBERS[w] ?? w)
    .filter((w) => !FILLERS.has(w));
  for (;;) {
    if (words[0] === 'right') words = words.slice(1);
    else if (words[0] === 'go' && words[1] === 'on') words = words.slice(2);
    else break;
  }
  return words.join(' ');
}

export function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/**
 * A small phonetic key standing in for Double Metaphone: the first letter, then consonant sounds only, with
 * look-alike spellings folded and doubles collapsed. "boris" and "bors" both give "BRS".
 */
export function soundKey(word: string): string {
  const w = word
    .toLowerCase()
    .replace(/ph/g, 'f')
    .replace(/ck|q/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/dg/g, 'j')
    .replace(/wh/g, 'w');
  let key = w[0] ?? '';
  for (const ch of w.slice(1)) {
    if ('aeiouyhw'.includes(ch)) continue;
    if (key[key.length - 1] !== ch) key += ch;
  }
  return key.toUpperCase();
}

/** True if a spoken word is close enough to a name: Levenshtein ≤ 1, or the same sound key. */
export function sounds(word: string, name: string): boolean {
  const w = word.toLowerCase();
  const n = name.toLowerCase();
  if (w === n) return true;
  if (Math.min(w.length, n.length) >= 3 && levenshtein(w, n) <= 1) return true;
  return w.length >= 3 && soundKey(w) === soundKey(n);
}
