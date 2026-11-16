import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://weebcentral.com';

/** "/series/01J76XYEZWRB4MRT7EHVVPEDXV/Reformation-of-the-Deadbeat-Noble" → "01J76XYEZWRB4MRT7EHVVPEDXV". */
export const idFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/series\/([A-Za-z0-9]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

/** "/chapters/01M7DX7VHA3NK9QCF1Y0Z8AGQ6" → "01M7DX7VHA3NK9QCF1Y0Z8AGQ6". */
export const chapterIdFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/chapters\/([A-Za-z0-9]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('article a[href*="/series/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = abs(href);
    if (seen.has(url)) return;
    const title = ($(el).find('h2').first().text() || $(el).attr('data-tip') || $(el).text()).trim();
    if (!title) return;
    seen.add(url);
    hits.push({ title, url });
  });
  return hits;
}

/** "Episode 168" / "Chapter 12.5" / "Vol. 2 Chapter 15" → 168 / 12.5 / 15. */
const chapterNumber = (label: string): number | null => {
  const explicit = label.match(/(?:chapter|ch\.?|episode|ep\.?)\s*#?(\d+(?:\.\d+)?)/i);
  if (explicit) return Number(explicit[1]);
  const fallback = label.match(/(\d+(?:\.\d+)?)/);
  if (fallback) return Number(fallback[1]);
  if (/\b(prologue|oneshot|one-shot)\b/i.test(label)) return 0;
  return null;
};

export function parseChapterList(html: string): SourceChapter[] {
  const $ = cheerio.load(html);
  const byNumber = new Map<number, SourceChapter>();
  $('a[href*="/chapters/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).find('span.grow > span').first().text().trim() || $(el).text().trim();
    const number = chapterNumber(label);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    const rawDate = $(el).find('time').attr('datetime');
    const date = rawDate && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : undefined;
    byNumber.set(number, {
      number,
      label: label || `Chapter ${number}`,
      url: abs(href),
      date,
      locked: false,
    });
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters'> {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || idFromUrl(url) || url;
  const cover = $('meta[property="og:image"]').attr('content') || undefined;

  let description: string | undefined;
  let altTitles: string[] = [];
  $('strong').each((_, el) => {
    const heading = $(el).text().trim();
    if (heading === 'Description' && !description) {
      description = $(el).parent().find('p').first().text().trim() || undefined;
    } else if (heading === 'Associated Name(s)' && altTitles.length === 0) {
      altTitles = $(el)
        .parent()
        .find('li')
        .map((_, li) => $(li).text().trim())
        .get()
        .filter((t) => t && t !== title);
    }
  });

  return { title, url, altTitles, cover, description };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('#chapter-images img').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('data-src');
    if (src && /^https?:\/\//.test(src) && !src.includes('/broken_image') && !seen.has(src)) {
      seen.add(src);
      urls.push(src);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'png';
    return {
      url: u,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
    };
  });
}

export const weebcentral: SourceAdapter = {
  id: 'weebcentral',
  name: 'Weeb Central',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['weebcentral.com'],
  // robots.txt specifies Crawl-delay: 10
  rateLimit: { rpm: 6, concurrency: 1 },

  async search(title, http) {
    const url = `${BASE}/search/data?text=${encodeURIComponent(title)}&display_mode=Minimal+Display`;
    return parseSearch(await http.text(url, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const id = idFromUrl(url);
    if (!id) throw new Error(`Not a Weeb Central series URL: ${url}`);
    const seriesHtml = await http.text(url, { cacheMs: 10 * 60_000 });
    const chaptersHtml = await http.text(`${BASE}/series/${id}/full-chapter-list`, { cacheMs: 10 * 60_000 });
    const meta = parseSeries(seriesHtml, url);
    return { ...meta, chapters: parseChapterList(chaptersHtml) };
  },

  async getChapterPages(chapter, http): Promise<PageRef[]> {
    const id = chapterIdFromUrl(chapter.url);
    if (!id) throw new Error(`Not a Weeb Central chapter URL: ${chapter.url}`);
    const imagesUrl = `${BASE}/chapters/${id}/images?is_prev=False&current_page=1&reading_style=long_strip`;
    return parsePages(await http.text(imagesUrl), chapter.url);
  },
};
