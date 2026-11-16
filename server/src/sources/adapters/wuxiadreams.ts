import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://wuxiadreams.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href^="/novel/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^\/novel\/[^/]+\//.test(href)) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = (
      $(el).find('h2, h3, h4').first().text()
      || $(el).find('img').first().attr('alt')
      || $(el).attr('title')
      || $(el).text()
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return;
    seen.add(url);
    const img = $(el).find('img').first();
    const cover = (img.attr('src') ?? img.attr('data-src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseChaptersPage(html: string, baseUrl = BASE): { chapters: SourceChapter[]; maxPage: number } {
  const $ = cheerio.load(html);
  const chapters: SourceChapter[] = [];
  $('a[href*="/chapter-"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(href, text);
    if (number == null || !Number.isFinite(number)) return;
    chapters.push({ number, label: text || `Chapter ${number}`, url: new URL(href, baseUrl).href });
  });
  let maxPage = 1;
  $('a[href*="page="]').each((_, el) => {
    const m = $(el).attr('href')?.match(/[?&]page=(\d+)/);
    if (m) maxPage = Math.max(maxPage, Number(m[1]));
  });
  return { chapters, maxPage };
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const { chapters } = parseChaptersPage(html);
  const byNumber = new Map<number, SourceChapter>();
  for (const c of chapters) {
    if (!byNumber.has(c.number)) byNumber.set(c.number, c);
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
  const box = $('article.chapter-content-container').first().length
    ? $('article.chapter-content-container').first()
    : $('article').first();
  box.find('script, style, .ads, .adsbygoogle').remove();
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() || fallbackTitle;
  return { title, html: chapterXhtml($, box) };
}

export const wuxiadreams: SourceAdapter = {
  id: 'wuxiadreams',
  name: 'Wuxia Dreams',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['wuxiadreams.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/novels?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const clean = url.split('?')[0]!;
    const firstHtml = await http.text(`${clean}?page=1&sort=asc`, { cacheMs: 10 * 60_000 });
    const series = parseSeries(firstHtml, clean);
    const { maxPage } = parseChaptersPage(firstHtml);
    const byNumber = new Map(series.chapters.map((c) => [c.number, c]));
    for (let page = 2; page <= maxPage; page++) {
      const pageHtml = await http.text(`${clean}?page=${page}&sort=asc`, { cacheMs: 10 * 60_000 });
      for (const c of parseChaptersPage(pageHtml).chapters) {
        if (!byNumber.has(c.number)) byNumber.set(c.number, c);
      }
    }
    series.chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('Wuxia Dreams chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
