import type { PageRef, SourceAdapter, SourceChapter, SourceChapterAlt, SourceSeries, SourceSeriesHit } from '../types.ts';
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
  relationships?: { id?: string; type: string; attributes?: { name?: string; username?: string } }[];
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

const groupOf = (c: MdChapter): string | undefined => {
  const groups = (c.relationships ?? [])
    .filter((r) => r.type === 'scanlation_group' && r.attributes?.name)
    .map((r) => r.attributes!.name!);
  if (groups.length) return groups.join(', ');
  return c.relationships?.find((r) => r.type === 'user' && r.attributes?.username)?.attributes?.username;
};

/**
 * English chapters only. Several groups often upload the same chapter number; Atsu tracks one
 * primary entry per number (most pages, non-external on ties, then earliest upload) and keeps
 * other groups' uploads as `alternatives` so the user can see or switch sources.
 * External-link stubs (e.g. MangaPlus with 0–1 placeholder page) are skipped, while official
 * archives that still host all pages on MangaDex (e.g. Bilibili Comics, pages > 1) are kept.
 * Unnumbered chapters are skipped too, except in a series with no numbered chapters at all (a
 * oneshot), where they count as chapter 1.
 */
export function parseFeed(chapters: MdChapter[]): SourceChapter[] {
  const usable = chapters.filter((c) => {
    const a = c.attributes;
    const hosted = !a.externalUrl || a.pages > 1;
    return a.translatedLanguage === LANG && hosted && !a.isUnavailable && a.pages > 0;
  });
  const numberOf = (c: MdChapter): number | null => {
    const raw = c.attributes.chapter;
    const n = Number(raw);
    return raw == null || raw === '' || !Number.isFinite(n) ? null : n;
  };
  const oneshot = usable.every((c) => numberOf(c) === null);
  const byNumber = new Map<number, MdChapter[]>();
  for (const c of usable) {
    const n = numberOf(c) ?? (oneshot ? 1 : null);
    if (n === null) continue;
    const list = byNumber.get(n);
    if (list) list.push(c);
    else byNumber.set(n, [c]);
  }
  const byQuality = (a: MdChapter, b: MdChapter) => {
    if (b.attributes.pages !== a.attributes.pages) return b.attributes.pages - a.attributes.pages;
    const extDiff = Number(!!a.attributes.externalUrl) - Number(!!b.attributes.externalUrl);
    if (extDiff !== 0) return extDiff;
    return a.attributes.publishAt < b.attributes.publishAt ? -1 : a.attributes.publishAt > b.attributes.publishAt ? 1 : 0;
  };
  const labelOf = (c: MdChapter, number: number) => `Chapter ${number}${c.attributes.title ? ` — ${c.attributes.title}` : ''}`;

  return [...byNumber.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, list]) => {
      const sorted = [...list].sort(byQuality);
      const primary = sorted[0]!;
      const alternatives: SourceChapterAlt[] = sorted.slice(1).map((alt) => ({
        group: groupOf(alt) ?? 'Unknown group',
        url: `${BASE}/chapter/${alt.id}`,
        label: labelOf(alt, number),
        title: alt.attributes.title ?? undefined,
        date: alt.attributes.publishAt,
      }));
      return {
        number,
        label: labelOf(primary, number),
        url: `${BASE}/chapter/${primary.id}`,
        title: primary.attributes.title ?? undefined,
        date: primary.attributes.publishAt,
        locked: false,
        group: groupOf(primary),
        alternatives: alternatives.length ? alternatives : undefined,
      };
    });
}

/** MangaDex lists a series under every language it has; only English chapters are usable here. */
export function emptyReason(m: MdManga): string {
  const langs = m.attributes.availableTranslatedLanguages ?? [];
  if (langs.includes(LANG)) return 'English chapters have no hosted pages or are unavailable';
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
    const url = `${API}/manga/${id}/feed?translatedLanguage[]=${LANG}&includes[]=scanlation_group&includes[]=user&${RATINGS}&order[chapter]=asc&limit=${FEED_PAGE}&offset=${offset}`;
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
