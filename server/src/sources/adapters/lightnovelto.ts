import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://lightnovel.to';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href^="/novel/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^\/novel\/[^/]+\//.test(href)) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const img = $(el).find('img').first();
    const title = (
      $(el).find('h2, h3, h4, .title').first().text()
      || img.attr('alt')
      || $(el).attr('title')
      || $(el).text()
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return;
    seen.add(url);
    const cover = (img.attr('src') ?? img.attr('data-src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const byNumber = new Map<number, SourceChapter>();

  const m = html.match(/\\?"total\\?":(\d+),\\?"novelSlug\\?":\\?"([^"\\]+)\\?"/);
  if (m) {
    const total = Number(m[1]);
    const slug = m[2]!;
    for (let n = 1; n <= total; n++) {
      byNumber.set(n, { number: n, label: `Chapter ${n}`, url: `${BASE}/novel/${slug}/chapter-${n}` });
    }
  } else {
    $('a[href*="/chapter-"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const label = $(el).text().replace(/\s+/g, ' ').trim();
      const number = chapterNumberFrom(href, label);
      if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
      byNumber.set(number, { number, label: label || `Chapter ${number}`, url: new URL(href, BASE).href });
    });
  }

  return {
    title,
    url,
    altTitles: [],
    cover: $('meta[property="og:image"]').attr('content')?.trim() || undefined,
    description: $('meta[property="og:description"]').attr('content')?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('.ln-prose').first().length ? $('.ln-prose').first() : $('#chapter-content').first();
  box.find('script, style, .ads, .adsbygoogle').remove();
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() || fallbackTitle;
  return { title, html: chapterXhtml($, box) };
}

export const lightnovelto: SourceAdapter = {
  id: 'lightnovelto',
  name: 'lightnovel.to',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['lightnovel.to'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const series = parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('lightnovel.to chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
