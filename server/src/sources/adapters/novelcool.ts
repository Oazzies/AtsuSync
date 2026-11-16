import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://www.novelcool.com';

/** NovelCool hosts manga too (".book-type-novel" marks novels); only novels are returned. */
export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('.book-item').each((_, el) => {
    if (!$(el).find('.book-type-novel').length) return;
    const href = $(el).find('a[href*="/novel/"]').first().attr('href');
    if (!href) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    const title = ($(el).find('a[title]').first().attr('title') ?? $(el).find('[itemprop=name]').first().text()).trim();
    if (!title) return;
    seen.add(url);
    const img = $(el).find('img').first();
    hits.push({ title, url, cover: (img.attr('cover_url') ?? img.attr('src'))?.trim() || undefined });
  });
  return hits;
}

/** "Emperor of Solo Play Chapter 5" becomes "Chapter 5". */
const stripSeriesPrefix = (label: string, title: string) =>
  label.toLowerCase().startsWith(title.toLowerCase()) ? label.slice(title.length).trim() : label;

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1.bookinfo-title').first().text().trim() || $('h1').first().text().trim();
  const altTitles = $('[itemprop=alternateName]')
    .map((_, el) => $(el).text())
    .get()
    .flatMap((t) => t.split(/[;,]/))
    .map((t) => t.trim())
    .filter((t) => t && t !== title);
  const byNumber = new Map<number, SourceChapter>();
  $('.chp-item a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = ($(el).find('.chapter-item-headtitle').text() || $(el).attr('title') || '').replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(label, decodeURIComponent(href)) ?? (/\bprologue\b/i.test(label) ? 0 : null);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    byNumber.set(number, { number, label: stripSeriesPrefix(label, title) || `Chapter ${number}`, url: new URL(href, BASE).href });
  });
  return {
    title,
    url,
    altTitles,
    cover: $('meta[property="og:image"]').attr('content')?.trim() || undefined,
    description: $('meta[property="og:description"]').attr('content')?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('.overflow-hidden')
    .filter((_, el) => $(el).children('p').length > 3)
    .first();
  const title = $('.chapter-title').first().text().replace(/\s+/g, ' ').trim() || fallbackTitle;
  box.find('.chapter-start-mark, .chapter-end-mark, .bookinfo-share, .chapter-section-report, .chapter-title, script').remove();
  return { title, html: chapterXhtml($, box) };
}

export const novelcool: SourceAdapter = {
  id: 'novelcool',
  name: 'NovelCool',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['novelcool.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search/?wd=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    if (!/\/novel\/[^/]+\.html/.test(url)) throw new Error(`Not a NovelCool novel URL: ${url}`);
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
  },

  async getChapterPages() {
    throw new Error('NovelCool chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
