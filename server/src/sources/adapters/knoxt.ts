// KnoxT runs the Themesia "lightnovel" WordPress theme: search results are <article class="maindet">,
// the series page lists chapters in .eplister and a chapter's text sits in .epcontent.
import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://knoxt.space';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('article.maindet').each((_, el) => {
    const a = $(el).find('.mdthumb a').first();
    const href = a.attr('href');
    const title = (a.attr('title') ?? $(el).find('h2, h3').first().text()).trim();
    if (!href || !title) return;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) return;
    seen.add(url);
    const img = $(el).find('img').first();
    hits.push({ title, url, cover: (img.attr('src') ?? img.attr('data-src'))?.trim() || undefined });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1.entry-title').first().text().trim() || $('h1').first().text().trim();
  const altTitles = $('.alter')
    .first()
    .text()
    .split(/\s*[/;,]\s*/)
    .map((t) => t.trim())
    .filter((t) => t && t !== title);
  const byNumber = new Map<number, SourceChapter>();
  $('.eplister li a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const num = $(el).find('.epl-num').text().replace(/\s+/g, ' ').trim();
    const name = $(el).find('.epl-title').text().replace(/\s+/g, ' ').trim();
    const number = chapterNumberFrom(num, decodeURIComponent(href));
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    const locked = $(el).closest('li').find('.fa-lock, .lock').length > 0;
    byNumber.set(number, { number, label: name ? `${num} ${name}`.trim() : num || `Chapter ${number}`, url: new URL(href, BASE).href, locked });
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
  const box = $('.epcontent').first();
  box.find('.code-block, .ads, .adsbygoogle, .ts-ad, .sharedaddy, .chdesc').remove();
  return { title: $('h1.entry-title').first().text().replace(/\s+/g, ' ').trim() || fallbackTitle, html: chapterXhtml($, box) };
}

export const knoxt: SourceAdapter = {
  id: 'knoxt',
  name: 'KnoxT',
  baseUrl: BASE,
  kind: 'scanlation',
  medium: 'novel',
  hosts: ['knoxt.space'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/?s=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const series = parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found (is this a series page?)';
    return series;
  },

  async getChapterPages() {
    throw new Error('KnoxT chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
