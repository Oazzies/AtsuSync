import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';
import type { SourceHttp } from '../http.ts';

const BASE = 'https://mangadex.org';
const API = 'https://api.mangadex.org';
const LANG = 'en';
const FEED_PAGE = 500;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Include every content rating, otherwise suggestive/erotica/pornographic titles silently vanish.
const RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'].map((r) => `contentRating[]=${r}`).join('&');

type Localized = Record<string, string>;

export interface MdManga {
  id: string;
  attributes: { title: Localized; altTitles?: Localized[]; description?: Localized; availableTranslatedLanguages?: string[] };
  relationships?: { type: string; attributes?: { fileName?: string } }[];
}

export interface MdChapter {
  id: string;
  attributes: {
    chapter: string | null;
    title: string | null;
    translatedLanguage: string;
    externalUrl: string | null;
    isUnavailable?: boolean;
    publishAt: string;
    pages: number;
  };
}

export interface MdAtHome {
  baseUrl: string;
  chapter: { hash: string; data: string[] };
}

export const mangaIdFromUrl = (url: string): string | null => {
  const u = new URL(url);
  const m = u.pathname.match(new RegExp(`^/(?:title|manga)/(${UUID.source})`, 'i'));
  return m ? m[1]!.toLowerCase() : null;
};

export const chapterIdFromUrl = (url: string): string | null => {
  const m = new URL(url).pathname.match(new RegExp(`^/chapter/(${UUID.source})`, 'i'));
  return m ? m[1]!.toLowerCase() : null;
};

/** Titles in every language, preferring English for the display title. */
function titles(m: MdManga): { title: string; altTitles: string[] } {
  const { title, altTitles = [] } = m.attributes;
  const all = [...Object.values(title), ...altTitles.flatMap((t) => Object.values(t))];
  const display = title[LANG] ?? altTitles.find((t) => t[LANG])?.[LANG] ?? Object.values(title)[0] ?? all[0] ?? m.id;
  return { title: display, altTitles: [...new Set(all)].filter((t) => t !== display) };
}

const coverOf = (m: MdManga): string | undefined => {
  const file = m.relationships?.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  return file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.512.jpg` : undefined;
};

export function parseSearch(json: { data?: MdManga[] }): SourceSeriesHit[] {
  return (json.data ?? []).map((m) => ({ ...titles(m), url: `${BASE}/title/${m.id}`, cover: coverOf(m) }));
}

/**
 * English chapters only. Several groups often upload the same chapter number; Atsu tracks one
 * entry per number, so keep a single deterministic pick (most pages, then earliest upload).
 * External-link chapters (no hosted pages) and chapters without a number (oneshots) are skipped.
 */
export function parseFeed(chapters: MdChapter[]): SourceChapter[] {
  const best = new Map<number, MdChapter>();
  for (const c of chapters) {
    const a = c.attributes;
    if (a.translatedLanguage !== LANG || a.externalUrl || a.isUnavailable || a.pages <= 0) continue;
    const n = Number(a.chapter);
    if (a.chapter == null || a.chapter === '' || !Number.isFinite(n)) continue;
    const cur = best.get(n)?.attributes;
    if (!cur || a.pages > cur.pages || (a.pages === cur.pages && a.publishAt < cur.publishAt)) best.set(n, c);
  }
  return [...best.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, c]) => ({
      number,
      label: `Chapter ${number}${c.attributes.title ? ` — ${c.attributes.title}` : ''}`,
      url: `${BASE}/chapter/${c.id}`,
      title: c.attributes.title ?? undefined,
      date: c.attributes.publishAt,
      locked: false,
    }));
}

/** MangaDex lists a series under every language it has; only English chapters are usable here. */
export function emptyReason(m: MdManga): string {
  const langs = m.attributes.availableTranslatedLanguages ?? [];
  if (langs.includes(LANG)) return 'English chapters are only external links or unavailable';
  return langs.length ? `no English chapters (only ${langs.join(', ')})` : 'no English chapters';
}

export function parsePages(json: MdAtHome): PageRef[] {
  const { hash, data } = json.chapter;
  return data.map((file, i) => ({
    url: `${json.baseUrl}/data/${hash}/${file}`,
    name: `${String(i + 1).padStart(3, '0')}.${file.split('.').pop() ?? 'jpg'}`,
  }));
}

async function fetchFeed(id: string, http: SourceHttp): Promise<MdChapter[]> {
  const out: MdChapter[] = [];
  for (let offset = 0; ; offset += FEED_PAGE) {
    const url = `${API}/manga/${id}/feed?translatedLanguage[]=${LANG}&includeExternalUrl=0&${RATINGS}&order[chapter]=asc&limit=${FEED_PAGE}&offset=${offset}`;
    const page = await http.json<{ data: MdChapter[]; total: number }>(url, { cacheMs: 10 * 60_000 });
    out.push(...page.data);
    if (page.data.length === 0 || offset + FEED_PAGE >= page.total) return out;
  }
}

export const mangadex: SourceAdapter = {
  id: 'mangadex',
  name: 'MangaDex',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangadex.org'],
  rateLimit: { rpm: 60, concurrency: 2 },

  async search(title, http) {
    const url = `${API}/manga?title=${encodeURIComponent(title)}&limit=10&includes[]=cover_art&${RATINGS}&order[relevance]=desc`;
    return parseSearch(await http.json(url, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const id = mangaIdFromUrl(url);
    if (!id) throw new Error(`Not a MangaDex series URL: ${url}`);
    const [manga, feed] = await Promise.all([
      http.json<{ data: MdManga }>(`${API}/manga/${id}?includes[]=cover_art`, { cacheMs: 10 * 60_000 }),
      fetchFeed(id, http),
    ]);
    const chapters = parseFeed(feed);
    return {
      ...titles(manga.data),
      url: `${BASE}/title/${id}`,
      cover: coverOf(manga.data),
      description: manga.data.attributes.description?.[LANG],
      chapters,
      emptyReason: chapters.length ? undefined : emptyReason(manga.data),
    };
  },

  async getChapterPages(chapter, http) {
    const id = chapterIdFromUrl(chapter.url);
    if (!id) throw new Error(`Not a MangaDex chapter URL: ${chapter.url}`);
    // robots.txt on the API host disallows /at-home/, but this is the documented, only way for
    // API clients to obtain image hosts, so this single call opts out of the robots check.
    const json = await http.json<MdAtHome>(`${API}/at-home/server/${id}`, { ignoreRobots: true });
    const pages = parsePages(json);
    if (pages.length === 0) throw new Error('MangaDex returned no pages for this chapter');
    return pages;
  },
};
