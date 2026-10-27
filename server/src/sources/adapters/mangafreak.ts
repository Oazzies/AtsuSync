import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://ww3.mangafreak.me';

/** "/Manga/Majo_To_Ryouken" or "/Read1_Majo_To_Ryouken_1" → "Majo_To_Ryouken". */
export const idFromUrl = (url: string): string | null => {
  try {
    const path = new URL(url).pathname;
    const series = path.match(/^\/Manga\/([^/]+)/);
    if (series) return series[1]!;
    const chapter = path.match(/^\/Read\d+_(.+)_\d+(?:\.\d+)?e?$/);
    return chapter ? chapter[1]! : null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const hits: SourceSeriesHit[] = [];
  $('.manga_search_item').each((_, el) => {
    const link = $(el).find('h3 a[href^="/Manga/"]').first();
    const title = link.text().trim();
    if (!title) return;
    hits.push({
      title,
      url: abs(link.attr('href')!),
      cover: $(el).find('img').first().attr('src') || undefined,
    });
  });
  return hits;
}

/** "/Read1_Majo_To_Ryouken_4.5" → 4.5. Suffixed variants like "_7e" are not main chapters. */
const chapterNumber = (href: string): number | null => {
  const m = href.match(/_(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
};

export function parseChapterList(html: string): SourceChapter[] {
  const $ = cheerio.load(html);
  const byNumber = new Map<number, SourceChapter>();
  $('.manga_series_list a.chapter-link').each((_, el) => {
    const href = $(el).attr('href')!;
    const number = chapterNumber(href);
    if (number == null || byNumber.has(number)) return;
    byNumber.set(number, { number, label: $(el).text().trim() || `Chapter ${number}`, url: abs(href), locked: false });
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters'> {
  const $ = cheerio.load(html);
  const altText = $('.manga_series_data > div')
    .filter((_, el) => $(el).text().startsWith('Alternative Title:'))
    .first()
    .text()
    .replace(/^Alternative Title:/, '');
  const altTitles = altText
    .split(/[,|]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    title: $('.manga_series_data h1').first().text().trim() || idFromUrl(url) || url,
    url,
    cover: $('meta[property="og:image"]').attr('content') || undefined,
    description: $('.manga_series_description p').first().text().trim() || undefined,
    altTitles,
  };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('.slideshow-container img').each((_, el) => {
    const src = $(el).attr('src');
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

export const mangafreak: SourceAdapter = {
  id: 'mangafreak',
  name: 'MangaFreak',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangafreak.me'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/Find/${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const id = idFromUrl(url);
    if (!id) throw new Error(`Not a MangaFreak series URL: ${url}`);
    const seriesUrl = `${BASE}/Manga/${id}`;
    const html = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    return { ...parseSeries(html, seriesUrl), chapters: parseChapterList(html) };
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
