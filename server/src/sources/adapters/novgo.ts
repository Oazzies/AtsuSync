import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://novgo.net';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href$=".html"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.includes('/chapter-')) return;
    const url = new URL(href, BASE).href;
    if (new URL(url).pathname.split('/').filter(Boolean).length !== 1) return;
    if (seen.has(url)) return;
    const row = $(el).closest('.row, .list-novel > div, .novel-item, li, div');
    const title = (
      $(el).attr('title')
      || $(el).text()
      || row.find('h3, h2, .novel-title').first().text()
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return;
    seen.add(url);
    const img = row.find('img').first();
    const rawCover = (img.attr('data-src') ?? img.attr('src'))?.trim();
    const cover = rawCover ? new URL(rawCover, BASE).href : undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

export function parseChaptersPage(html: string, slug: string): { chapters: SourceChapter[]; maxPage: number } {
  const $ = cheerio.load(html);
  const chapters: SourceChapter[] = [];
  $(`a[href*="/${slug}/"]`).each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !href.includes('chapter')) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(href, label);
    if (number == null || !Number.isFinite(number)) return;
    chapters.push({ number, label: label || `Chapter ${number}`, url: new URL(href, BASE).href });
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
  const title = ($('h3.title').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim();
  const slug = new URL(url, BASE).pathname.replace(/^\/|\.html$/g, '');
  const { chapters } = parseChaptersPage(html, slug);
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
  const box = $('#chapter-content').first().length ? $('#chapter-content').first() : $('.chapter-c').first();
  box.find('script, style, .ads, .adsbygoogle').remove();
  const title = ($('.chr-text').first().text() || $('h1, h2').first().text()).replace(/\s+/g, ' ').trim() || fallbackTitle;
  return { title, html: chapterXhtml($, box) };
}

export const novgo: SourceAdapter = {
  id: 'novgo',
  name: 'Novgo',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['novgo.net'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?keyword=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const clean = url.split('?')[0]!;
    const slug = new URL(clean, BASE).pathname.replace(/^\/|\.html$/g, '');
    const firstHtml = await http.text(clean, { cacheMs: 10 * 60_000 });
    const series = parseSeries(firstHtml, clean);
    const { maxPage } = parseChaptersPage(firstHtml, slug);
    const byNumber = new Map(series.chapters.map((c) => [c.number, c]));
    for (let page = 2; page <= maxPage; page++) {
      const pageHtml = await http.text(`${clean}?page=${page}`, { cacheMs: 10 * 60_000 });
      for (const c of parseChaptersPage(pageHtml, slug).chapters) {
        if (!byNumber.has(c.number)) byNumber.set(c.number, c);
      }
    }
    series.chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('Novgo chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
