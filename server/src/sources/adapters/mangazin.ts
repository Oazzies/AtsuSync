import { madaraSlugFromUrl, parseMadaraPages, parseMadaraSeries } from '../madara.ts';
import type { SourceAdapter } from '../types.ts';

const BASE = 'https://mangazin.org';

// Search is omitted because mangazin.org/robots.txt disallows /?s=*.
export const mangazin: SourceAdapter = {
  id: 'mangazin',
  name: 'Mangazin',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mangazin.org'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async getSeries(url, http) {
    const slug = madaraSlugFromUrl(url);
    if (!slug) throw new Error(`Not a Mangazin series URL: ${url}`);
    return parseMadaraSeries(await http.text(url, { cacheMs: 10 * 60_000 }), url, BASE);
  },

  async getChapterPages(chapter, http) {
    return parseMadaraPages(await http.text(chapter.url), chapter.url, BASE);
  },
};
