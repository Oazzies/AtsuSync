import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lewdmanhwa, parseChapterList, parsePages, parseSearch, parseSeries, slugFromUrl } from '../src/sources/adapters/lewdmanhwa.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://lewdmanhwa.com/webtoon/autumn-chili';

describe('lewdmanhwa adapter', () => {
  it('owns lewdmanhwa.com urls and extracts the slug', () => {
    expect(matchesUrl(lewdmanhwa, SERIES)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('autumn-chili');
    expect(slugFromUrl(`${SERIES}/chapter/1`)).toBe('autumn-chili');
    expect(slugFromUrl('https://lewdmanhwa.com/home')).toBeNull();
  });

  it('maps search results with covers', () => {
    const hits = parseSearch(fx('lewdmanhwa-search.html'));
    expect(hits.map((h) => h.url)).toEqual(expect.arrayContaining([SERIES, 'https://lewdmanhwa.com/webtoon/before-autumn-comes']));
    expect(hits.find((h) => h.url === SERIES)).toEqual({
      title: 'Autumn Chili',
      url: SERIES,
      cover: 'https://lewdmanhwa.com/uploads/covers/autumn-chili_thumb.webp',
    });
  });

  it('parses series info', () => {
    const s = parseSeries(fx('lewdmanhwa-series.html'), SERIES);
    expect(s).toMatchObject({ title: 'Autumn Chili', url: SERIES, altTitles: ['어텀, 칠리!'] });
    expect(s.cover).toBe('https://lewdmanhwa.com/uploads/covers/autumn-chili.webp');
    expect(s.description).toMatch(/^Woo Kang-jun/);
  });

  it('lists each chapter once, ascending, including chapter 0', () => {
    const chapters = parseChapterList(fx('lewdmanhwa-series.html'), 'autumn-chili');
    expect(chapters.map((c) => c.number)).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(chapters[1]).toEqual({ number: 1, label: 'Chapter 1', url: `${SERIES}/chapter/1`, locked: false });
  });

  it('collects every page from the RSC payload, not just the 5 server-rendered images', () => {
    const pages = parsePages(fx('lewdmanhwa-chapter.html'), `${SERIES}/chapter/1`);
    expect(pages).toHaveLength(18);
    expect(pages[0]).toMatchObject({ url: 'https://lewdmanhwa.com/uploads/chapters/1023103/10821380/001-01.webp', name: '001.webp', width: 720, height: 1499 });
    expect(pages[17]!.name).toBe('018.webp'); // upload names are renumbered
    // Filenames aren't uniform within a chapter; reading order comes from sortOrder.
    expect(pages.map((p) => p.url.split('/').pop())).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `001-${String(i + 1).padStart(2, '0')}.webp`),
      ...Array.from({ length: 8 }, (_, i) => `${String(i + 2).padStart(3, '0')}.webp`),
    ]);
  });

  it('falls back to rendered <img> tags when the payload is missing', () => {
    const html = '<img src="/uploads/chapters/1/2/001.webp"><img src="/uploads/chapters/1/2/002.webp"><img src="/uploads/chapters/1/2/001.webp">';
    expect(parsePages(html, SERIES).map((p) => p.name)).toEqual(['001.webp', '002.webp']);
  });
});
