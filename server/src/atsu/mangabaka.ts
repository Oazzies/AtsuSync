import type { ContentRequest, MangaBaka } from '@atsusync/shared';
import { USER_AGENT } from '../polite.ts';
import { bestScore, searchQueries } from '../sources/match.ts';
import { wantsNovel } from './presence.ts';

// MangaBaka is the preferred tracker on Atsumaru; its API gives us alt titles and chapter totals.
const API = 'https://api.mangabaka.org/v1';

export type MangaBakaSeries = MangaBaka;

const cache = new Map<string, { at: number; value: MangaBakaSeries | null }>();
const TTL = 24 * 60 * 60 * 1000;
const MIN_SEARCH_SCORE = 0.65;

export const isNovelType = (type: string | null | undefined): boolean => (type ?? '').toLowerCase() === 'novel';

export function matchesMedium(type: string | null | undefined, medium: 'comic' | 'novel'): boolean {
  if (!type) return true;
  return medium === 'novel' ? isNovelType(type) : !isNovelType(type);
}

export async function getMangaBakaSeries(
  id: string,
  fetchImpl: typeof fetch = fetch,
  force = false,
): Promise<MangaBakaSeries | null> {
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.value;
  const res = await fetchImpl(`${API}/series/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  const value = res.ok ? parseMangaBaka(((await res.json()) as { data?: unknown }).data) : null;
  cache.set(id, { at: Date.now(), value });
  return value;
}

export async function searchMangaBakaSeries(
  titles: string[],
  medium: 'comic' | 'novel',
  fetchImpl: typeof fetch = fetch,
): Promise<MangaBakaSeries | null> {
  const queries = searchQueries(titles);
  if (!queries.length) return null;

  let best: { series: MangaBakaSeries; score: number } | null = null;
  for (const q of queries) {
    const res = await fetchImpl(`${API}/series/search?q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) continue;
    const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
    if (!Array.isArray(body?.data)) continue;

    for (const raw of body.data) {
      const parsed = parseMangaBaka(raw);
      if (!parsed || !matchesMedium(parsed.type, medium)) continue;
      const score = bestScore(titles, [parsed.title, ...parsed.titles]);
      if (score >= MIN_SEARCH_SCORE && (!best || score > best.score)) {
        best = { series: parsed, score };
      }
    }
    if (best && best.score >= 0.95) break;
  }

  if (best) {
    cache.set(String(best.series.id), { at: Date.now(), value: best.series });
  }
  return best?.series ?? null;
}

export async function checkMangaBakaForRequest(
  req: Pick<ContentRequest, 'mangabakaId' | 'title' | 'altTitles' | 'tags'>,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ mangabaka: MangaBakaSeries | null; mediumMismatch: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const medium: 'comic' | 'novel' = wantsNovel(req) ? 'novel' : 'comic';
  const titles = [req.title, ...req.altTitles].filter(Boolean);

  if (req.mangabakaId) {
    const mb = await getMangaBakaSeries(req.mangabakaId, fetchImpl, opts.force);
    if (mb && matchesMedium(mb.type, medium)) {
      return { mangabaka: mb, mediumMismatch: false };
    }
    if (mb && !matchesMedium(mb.type, medium)) {
      const matched = await searchMangaBakaSeries(titles, medium, fetchImpl).catch(() => null);
      if (matched) return { mangabaka: matched, mediumMismatch: false };
      return { mangabaka: mb, mediumMismatch: true };
    }
  }

  const found = await searchMangaBakaSeries(titles, medium, fetchImpl);
  return { mangabaka: found, mediumMismatch: false };
}

function parseTotalChapters(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseMangaBaka(data: any): MangaBakaSeries | null {
  if (!data || typeof data !== 'object') return null;
  const titles = new Set<string>();
  for (const t of [data.title, data.romanized_title, data.native_title]) if (typeof t === 'string' && t) titles.add(t);
  for (const group of Object.values<any>(data.secondary_titles ?? {})) {
    if (Array.isArray(group)) for (const t of group) if (typeof t?.title === 'string') titles.add(t.title);
  }
  const id = Number(data.id);
  const canonical = typeof data.canonical_url === 'string' && data.canonical_url ? data.canonical_url : null;
  return {
    id,
    title: data.title ?? [...titles][0] ?? '',
    titles: [...titles],
    cover: data.cover?.x250?.x1 ?? data.cover?.raw?.url ?? null,
    type: typeof data.type === 'string' && data.type ? data.type : null,
    status: typeof data.status === 'string' && data.status ? data.status : null,
    totalChapters: parseTotalChapters(data.total_chapters),
    url: canonical ?? (Number.isFinite(id) && id > 0 ? `https://mangabaka.org/${id}` : null),
  };
}
