// Title matching between a request (title + tracker alt titles) and source search hits.

export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient over character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  const x = normalizeTitle(a).replace(/ /g, '');
  const y = normalizeTitle(b).replace(/ /g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      overlap++;
      grams.set(g, n - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/** Best similarity between any wanted title and any of the candidate's titles. */
export function bestScore(wanted: string[], candidate: string[]): number {
  let best = 0;
  for (const w of wanted) for (const c of candidate) best = Math.max(best, similarity(w, c));
  return Math.round(best * 100) / 100;
}

/** Titles worth searching with: dedupe by normalized form, prefer Latin-script titles first. */
export function searchQueries(titles: string[], max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const latinFirst = [...titles].sort((a, b) => Number(isLatin(b)) - Number(isLatin(a)));
  for (const t of latinFirst) {
    const n = normalizeTitle(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const isLatin = (s: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(s);
