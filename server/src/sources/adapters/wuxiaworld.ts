// Wuxiaworld (official). Pages embed their data as `window.__REACT_QUERY_STATE__ = {...}`, so the novel
// page and every chapter page carry what they need without calling the private gRPC API. The site's
// sitemap lists every novel, which stands in for search. Advance/Karma-locked chapters are listed but
// fail at download time with a clear message instead of producing an empty book.
import * as cheerio from 'cheerio';
import { matchBracket } from '../nextjs.ts';
import { chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://www.wuxiaworld.com';

interface Query {
  queryKey: unknown[];
  state: { data?: any };
}

/** The dehydrated react-query cache embedded in the page. */
export function queryState(html: string): Query[] {
  const m = /window\.__REACT_QUERY_STATE__\s*=\s*/.exec(html);
  if (!m) return [];
  const start = m.index + m[0].length;
  const end = matchBracket(html, start);
  if (end === -1) return [];
  try {
    return (JSON.parse(html.slice(start, end + 1)) as { queries?: Query[] }).queries ?? [];
  } catch {
    return [];
  }
}

const find = (html: string, key: string) => queryState(html).find((q) => q.queryKey[0] === key)?.state.data?.item;

export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/novel\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
const titleCase = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Rank sitemap novel URLs by how many of the query's words their slug contains. */
export function searchSitemap(xml: string, query: string): SourceSeriesHit[] {
  const q = words(query);
  if (q.length === 0) return [];
  const hits: { hit: SourceSeriesHit; score: number }[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+\/novel\/([^/<\s]+))\s*<\/loc>/g)) {
    const slug = m[2]!;
    const have = new Set(words(slug));
    const score = q.filter((w) => have.has(w)).length / q.length;
    if (score >= 0.6) hits.push({ hit: { title: titleCase(slug), url: m[1]! }, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8).map((h) => h.hit);
}

export function parseSeries(html: string, url: string): SourceSeries {
  const novel = find(html, 'novel');
  if (!novel) throw new Error(`Not a Wuxiaworld novel page: ${url}`);
  const abbr = String(novel.abbreviation ?? '').toLowerCase();
  const first = Number(novel.chapterInfo?.firstChapter?.number?.units ?? 1);
  const latest = Number(novel.chapterInfo?.latestChapter?.number?.units ?? 0);
  const slug = novel.slug as string;
  const chapters: SourceChapter[] = [];
  // Slugs are "<abbr>-chapter-<n>". Numbers the site skips fail at download time ("no text").
  if (abbr && latest >= first) {
    for (let n = first; n <= latest; n++) chapters.push({ number: n, label: `Chapter ${n}`, url: `${BASE}/novel/${slug}/${abbr}-chapter-${n}` });
  }
  const description = typeof novel.synopsis === 'string' ? cheerio.load(novel.synopsis).text().trim() : undefined;
  return {
    title: novel.name,
    url: `${BASE}/novel/${slug}`,
    altTitles: [],
    cover: novel.coverUrl?.value ?? undefined,
    description: description || undefined,
    chapters,
    emptyReason: chapters.length ? undefined : 'no published chapters',
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const ch = find(html, 'chapter');
  if (!ch) throw new Error('Chapter page has no chapter data (wrong slug, or the site changed)');
  const content: string = ch.content?.value ?? '';
  const free = ch.pricingInfo?.isFree !== false && !ch.karmaInfo?.isKarmaRequired && !ch.sponsorInfo?.advanceChapter;
  const $ = cheerio.load(`<div id="c">${content}</div>`);
  const body = chapterXhtml($, $('#c'));
  if (!free && body.replace(/<[^>]+>/g, '').trim().length < 200) throw new Error(`${ch.name ?? fallbackTitle} is locked (paid or Karma-gated) on Wuxiaworld`);
  return { title: ch.name ?? fallbackTitle, html: body };
}

export const wuxiaworld: SourceAdapter = {
  id: 'wuxiaworld',
  name: 'Wuxiaworld',
  baseUrl: BASE,
  kind: 'official',
  medium: 'novel',
  hosts: ['wuxiaworld.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return searchSitemap(await http.text(`${BASE}/sitemap-novels.xml`, { cacheMs: 6 * 60 * 60_000 }), title);
  },

  async getSeries(url, http) {
    if (!slugFromUrl(url)) throw new Error(`Not a Wuxiaworld novel URL: ${url}`);
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
  },

  async getChapterPages() {
    throw new Error('Wuxiaworld chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
