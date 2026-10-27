import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://mangapill.com';

/** "/manga/9454/si-land" → "9454/si-land". */
export const idFromUrl = (url: string): string | null => {
  try {
    const m = new URL(url).pathname.match(/^\/manga\/(\d+)(?:\/([^/]+))?/);
    return m ? (m[2] ? `${m[1]}/${m[2]}` : m[1]!) : null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href^="/manga/"]').each((_, el) => {
    const href = $(el).attr('href')!;
    const title = $(el).find('.line-clamp-2').first().text().trim();
    if (!title || seen.has(href)) return;
    seen.add(href);
    const cover = $(el).closest('div').parent().find('img').first().attr('data-src');
    hits.push({ title, url: abs(href), cover: cover || undefined });
  });
  return hits;
}

/** "…/si-land-chapter-4.2" → 4.2 */
const chapterNumber = (href: string): number | null => {
  const m = href.match(/-chapter-(\d+(?:\.\d+)?)\/?$/);
  return m ? Number(m[1]) : null;
};

export function parseChapterList(html: string): SourceChapter[] {
  const $ = cheerio.load(html);
  const byNumber = new Map<number, SourceChapter>();
  $('#chapters a[href^="/chapters/"]').each((_, el) => {
    const href = $(el).attr('href')!;
    const number = chapterNumber(href);
    if (number == null || byNumber.has(number)) return;
    byNumber.set(number, { number, label: $(el).text().trim() || `Chapter ${number}`, url: abs(href), locked: false });
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters' | 'altTitles'> {
  const $ = cheerio.load(html);
  const desc = $('p.text--secondary').first().clone();
  desc.find('br').replaceWith('\n');
  const description = desc
    .text()
    .replace(/\(Source:[^)]*\)\s*$/i, '')
    .trim();
  return {
    title: $('h1').first().text().trim() || idFromUrl(url) || url,
    url,
    cover: $('meta[property="og:image"]').attr('content') || undefined,
    description: description || undefined,
  };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('img.js-page').each((_, el) => {
    const src = $(el).attr('data-src') ?? $(el).attr('src');
    if (src && /^https?:\/\//.test(src) && !seen.has(src)) {
      seen.add(src);
      urls.push(src);
    }
  });
  return urls.map((u, i) => ({
    url: u,
    name: `${String(i + 1).padStart(3, '0')}.${new URL(u).pathname.split('.').pop() ?? 'jpg'}`,
    headers: { referer },
  }));
}

export const mangapill: SourceAdapter = {
  id: 'mangapill',
  name: 'MangaPill',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangapill.com'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const id = idFromUrl(url);
    if (!id) throw new Error(`Not a MangaPill series URL: ${url}`);
    const seriesUrl = `${BASE}/manga/${id}`;
    const html = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    return { ...parseSeries(html, seriesUrl), altTitles: [], chapters: parseChapterList(html) };
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
