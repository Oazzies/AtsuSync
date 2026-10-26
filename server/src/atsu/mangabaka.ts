import { USER_AGENT } from '../polite.ts';

// MangaBaka is the preferred tracker on Atsumaru; its API gives us alt titles for matching.
const API = 'https://api.mangabaka.org/v1';

export interface MangaBakaSeries {
  id: number;
  title: string;
  titles: string[];
  cover: string | null;
  type: string | null;
}

const cache = new Map<string, { at: number; value: MangaBakaSeries | null }>();
const TTL = 24 * 60 * 60 * 1000;

export async function getMangaBakaSeries(id: string, fetchImpl: typeof fetch = fetch): Promise<MangaBakaSeries | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const res = await fetchImpl(`${API}/series/${encodeURIComponent(id)}`, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  const value = res.ok ? parseMangaBaka(((await res.json()) as { data?: unknown }).data) : null;
  cache.set(id, { at: Date.now(), value });
  return value;
}

export function parseMangaBaka(data: any): MangaBakaSeries | null {
  if (!data || typeof data !== 'object') return null;
  const titles = new Set<string>();
  for (const t of [data.title, data.romanized_title, data.native_title]) if (typeof t === 'string' && t) titles.add(t);
  for (const group of Object.values<any>(data.secondary_titles ?? {})) {
    if (Array.isArray(group)) for (const t of group) if (typeof t?.title === 'string') titles.add(t.title);
  }
  return {
    id: Number(data.id),
    title: data.title ?? [...titles][0] ?? '',
    titles: [...titles],
    cover: data.cover?.x250?.x1 ?? data.cover?.raw?.url ?? null,
    type: data.type ?? null,
  };
}
