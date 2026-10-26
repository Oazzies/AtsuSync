// Starter for a new source site. Copy to `<site>.ts`, fill in the three methods,
// then add it to the list in ../registry.ts. Keep parsing in exported pure functions
// so they can be tested against saved HTML fixtures (see test/nuviatoon.test.ts).
import * as cheerio from 'cheerio';
import type { SourceAdapter, SourceSeriesHit } from '../types.ts';

const BASE = 'https://example-scans.com';

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  return $('a.series-card')
    .map((_, el) => ({ title: $(el).attr('title') ?? '', url: new URL($(el).attr('href')!, BASE).href }))
    .get();
}

export const template: SourceAdapter = {
  id: 'example',
  name: 'Example Scans',
  baseUrl: BASE,
  kind: 'scanlation',
  hosts: ['example-scans.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const $ = cheerio.load(await http.text(url, { cacheMs: 10 * 60_000 }));
    return {
      title: $('h1').first().text().trim(),
      url,
      altTitles: [],
      chapters: $('a.chapter')
        .map((_, el) => {
          const href = new URL($(el).attr('href')!, BASE).href;
          const number = Number(href.match(/chapter[-/](\d+(?:\.\d+)?)/)?.[1]);
          return { number, label: `Chapter ${number}`, url: href };
        })
        .get()
        .filter((c) => Number.isFinite(c.number)),
    };
  },

  async getChapterPages(chapter, http) {
    const $ = cheerio.load(await http.text(chapter.url));
    return $('.reader img')
      .map((i, el) => {
        const url = new URL($(el).attr('data-src') ?? $(el).attr('src')!, BASE).href;
        return { url, name: `${String(i + 1).padStart(3, '0')}.${url.split('.').pop()}`, headers: { referer: chapter.url } };
      })
      .get();
  },
};
