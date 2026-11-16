// Pen & Paper Translations (WordPress block theme + List Category Posts plugin):
// search hits are .wp-block-post-template > li (filtered to series pages, not dated chapter posts),
// series pages list chapters in .lcp_catlist, and chapter text sits in .entry-content.
import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://penandpapertranslations.com';
const DATED_POST_PATH = /^\/\d{4}\/\d{2}\/\d{2}\//;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('.wp-block-post-template > li').each((_, el) => {
    const a = $(el).find('.wp-block-post-title a').first();
    const href = a.attr('href');
    const title = a.text().replace(/\s+/g, ' ').trim();
    if (!href || !title) return;
    const resolved = new URL(href, BASE);
    if (DATED_POST_PATH.test(resolved.pathname)) return;
    const url = resolved.href;
    if (seen.has(url)) return;
    seen.add(url);
    const img = $(el).find('img').first();
    hits.push({ title, url, cover: (img.attr('src') ?? img.attr('data-src'))?.trim() || undefined });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title =
    $('.wp-block-post-title').first().text().replace(/\s+/g, ' ').trim() ||
    $('h1.entry-title').first().text().replace(/\s+/g, ' ').trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    '';

  const rawLinks: { href: string; label: string; mainNum: number | null; sideNum: number | null }[] = [];
  const list = $('.lcp_catlist li a').length ? $('.lcp_catlist li a') : $('.entry-content a').filter((_, el) => {
    const href = $(el).attr('href');
    if (!href) return false;
    try {
      return DATED_POST_PATH.test(new URL(href, BASE).pathname);
    } catch {
      return false;
    }
  });

  list.each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    const decodedHref = decodeURIComponent(href);
    const mainNum = chapterNumberFrom(label, decodedHref);
    const sideMatch = mainNum == null ? (label.match(/\bside\s*story\s*#?(\d+(?:\.\d+)?)/i) ?? decodedHref.match(/side[- ]?story[- ]*#?(\d+(?:[._-]\d+)?)/i)) : null;
    const sideNum = sideMatch ? Number(sideMatch[1]!.replace(/[_-]/, '.')) : null;
    rawLinks.push({ href, label, mainNum, sideNum });
  });

  const maxMain = rawLinks.reduce((max, item) => (item.mainNum != null && item.mainNum > max ? item.mainNum : max), 0);
  const byNumber = new Map<number, SourceChapter>();
  for (const item of rawLinks) {
    const number = item.mainNum ?? (item.sideNum != null ? maxMain + item.sideNum : null);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) continue;
    byNumber.set(number, {
      number,
      label: item.label || `Chapter ${number}`,
      url: new URL(item.href, BASE).href,
    });
  }

  return {
    title,
    url,
    altTitles: [],
    cover:
      $('meta[property="og:image"]').attr('content')?.trim() ||
      $('.wp-block-post-featured-image img').first().attr('src')?.trim() ||
      undefined,
    description: $('meta[property="og:description"]').attr('content')?.trim() || undefined,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('.entry-content, .wp-block-post-content').first();
  box.find('.sharedaddy, .jp-relatedposts, .code-block, .ads, .adsbygoogle, .wp-block-buttons').remove();
  const title =
    $('.wp-block-post-title').first().text().replace(/\s+/g, ' ').trim() ||
    $('h1.entry-title').first().text().replace(/\s+/g, ' ').trim() ||
    fallbackTitle;
  return { title, html: chapterXhtml($, box) };
}

export const penandpaper: SourceAdapter = {
  id: 'penandpaper',
  name: 'Pen & Paper Translations',
  baseUrl: BASE,
  kind: 'scanlation',
  medium: 'novel',
  hosts: ['penandpapertranslations.com'],
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
    throw new Error('Pen & Paper Translations chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
