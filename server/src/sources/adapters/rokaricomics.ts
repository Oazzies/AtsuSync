import * as cheerio from 'cheerio';
import { parseChapterList, parsePages, parseSeries } from './kingofshojo.ts';
import type { SourceAdapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://rokaricomics.com';

export { parseChapterList, parsePages, parseSeries };

export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/manga\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const hits: SourceSeriesHit[] = [];
  $('.listupd .bsx > a').each((_, el) => {
    const slug = slugFromUrl($(el).attr('href') ?? '');
    if (!slug) return;
    hits.push({
      title: $(el).find('.tt').text().trim() || ($(el).attr('title') ?? '').trim() || slug,
      url: `${BASE}/manga/${slug}/`,
      cover: $(el).find('img').first().attr('src') || undefined,
    });
  });
  return hits;
}

// Search is omitted because rokaricomics.com/robots.txt disallows /?s= and /search/.
export const rokaricomics: SourceAdapter = {
  id: 'rokaricomics',
  name: 'Rokari Comics',
  baseUrl: BASE,
  kind: 'scanlation',
  hosts: ['rokaricomics.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async getSeries(url, http): Promise<SourceSeries> {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a Rokari Comics series URL: ${url}`);
    const seriesUrl = `${BASE}/manga/${slug}/`;
    const html = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    return { ...parseSeries(html, seriesUrl), chapters: parseChapterList(html) };
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
