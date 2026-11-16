import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://webtoonclub.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('a[href^="/webtoon/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^\/webtoon\/[^/]+\//.test(href)) return;
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
    const rawCover = (img.attr('src') ?? img.attr('data-src'))?.trim();
    hits.push({ title, url, cover: rawCover ? new URL(rawCover, BASE).href : undefined });
  });
  return hits;
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const slugPath = new URL(url, BASE).pathname.replace(/\/$/, '');
  const byNumber = new Map<number, SourceChapter>();

  const totalMatch = html.match(/\\?"total\\?":(\d+),\\?"webtoonSlug\\?":\\?"([^"\\]+)\\?"/);
  if (totalMatch) {
    const total = Number(totalMatch[1]);
    const slug = totalMatch[2]!;
    for (let n = 1; n <= total; n++) {
      byNumber.set(n, { number: n, label: `Chapter ${n}`, url: `${BASE}/webtoon/${slug}/chapter/${n}` });
    }
  } else {
    $(`a[href^="${slugPath}/chapter/"]`).each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const m = href.match(/\/chapter\/(\d+(?:\.\d+)?)/);
      const number = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(number) || byNumber.has(number)) return;
      const label = $(el).text().replace(/\s+/g, ' ').trim() || `Chapter ${number}`;
      byNumber.set(number, { number, label, url: new URL(href, BASE).href });
    });
    // If the page shows latest chapter N (e.g. /chapter/200) and chapter 0/1, fill 0/1..max when list is truncated.
    const nums = [...byNumber.keys()];
    const minNum = nums.length ? Math.min(...nums) : 0;
    const maxNum = nums.length ? Math.max(...nums) : 0;
    if (maxNum > byNumber.size && minNum <= 1) {
      for (let n = minNum; n <= maxNum; n++) {
        if (!byNumber.has(n)) byNumber.set(n, { number: n, label: `Chapter ${n}`, url: `${BASE}${slugPath}/chapter/${n}` });
      }
    }
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

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('img[src*="/uploads/chapters/"], img[data-src*="/uploads/chapters/"]').each((_, el) => {
    const raw = ($(el).attr('data-src') ?? $(el).attr('src'))?.trim();
    if (!raw || raw.startsWith('data:')) return;
    const abs = new URL(raw, BASE).href;
    if (!seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'webp';
    return { url: u, name: `${String(i + 1).padStart(3, '0')}.${ext}`, headers: { referer } };
  });
}

export const webtoonclub: SourceAdapter = {
  id: 'webtoonclub',
  name: 'WebtoonClub',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['webtoonclub.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    return parseSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url);
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
