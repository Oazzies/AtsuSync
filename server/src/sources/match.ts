// Title matching between a request (title + tracker alt titles) and source search hits.

const TAG_SUFFIX = /\s*[\[(](?:official|colored|full color|uncensored|raw|manga|manhwa|manhua|webtoon|novel|light novel|ln|wn|digital)[\])]\s*/gi;

export function stripReleaseTags(s: string): string {
  return s.replace(TAG_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeTitle(s: string): string {
  return stripReleaseTags(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigramDice(x: string, y: string): number {
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

function tokenJaccard(na: string, nb: string): number {
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

function extractNumbers(s: string): string {
  return (s.match(/\d+/g) ?? []).join(',');
}

/** Blended bigram Dice + token Jaccard similarity, 0..1, with sequel-number mismatch penalty. */
export function similarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const x = na.replace(/ /g, '');
  const y = nb.replace(/ /g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;

  const dice = bigramDice(x, y);
  const jaccard = tokenJaccard(na, nb);
  let score = 0.6 * dice + 0.4 * jaccard;

  if (extractNumbers(na) !== extractNumbers(nb)) {
    score *= 0.75;
  }
  return score;
}

/** Best similarity between any wanted title and any of the candidate's titles. */
export function bestScore(wanted: string[], candidate: string[]): number {
  let best = 0;
  for (const w of wanted) for (const c of candidate) best = Math.max(best, similarity(w, c));
  return Math.round(best * 100) / 100;
}

/** Titles worth searching with: dedupe by normalized form, strip release tags, prefer Latin-script titles first. */
export function searchQueries(titles: string[], max = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const latinFirst = [...titles].sort((a, b) => Number(isLatin(b)) - Number(isLatin(a)));
  for (const raw of latinFirst) {
    const cleaned = stripReleaseTags(raw);
    const n = normalizeTitle(cleaned);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

const isLatin = (s: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(s);
