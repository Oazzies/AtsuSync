import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mangacherri,
  parsePages,
  parseSearch,
  parseSeries,
  slugFromUrl,
} from '../src/sources/adapters/mangacherri.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://mangacherri.com/title/too-soon-to-fall-in-love-with-a-god';
const CHAPTER = 'https://mangacherri.com/read/26488';

describe('mangacherri adapter', () => {
  it('owns mangacherri.com urls and extracts slug', () => {
    expect(matchesUrl(mangacherri, SERIES)).toBe(true);
    expect(matchesUrl(mangacherri, CHAPTER)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('too-soon-to-fall-in-love-with-a-god');
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('mangacherri-search.html'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.url).toMatch(/^https:\/\/mangacherri\.com\/title\//);
    expect(hits[0]!.title.length).toBeGreaterThan(0);
  });

  it('parses series info and ascending chapters', () => {
    const s = parseSeries(fx('mangacherri-series.html'), SERIES);
    expect(s.title).toBe('Too Soon to Fall in Love With a God');
    expect(s.chapters.length).toBeGreaterThan(5);
    const numbers = s.chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(s.chapters[0]).toMatchObject({
      number: 1,
      url: CHAPTER,
      locked: false,
    });
  });

  it('collects reader images in order', () => {
    const pages = parsePages(fx('mangacherri-chapter.html'), CHAPTER);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages[0]).toEqual({
      url: 'https://mangacherri.com/mangas/26488/p0001.webp',
      name: '001.webp',
      headers: { referer: CHAPTER },
    });
  });
});
