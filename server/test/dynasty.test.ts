import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chapterSlugFromUrl,
  dynasty,
  parseChapterJson,
  parseSearch,
  parseSeriesJson,
  slugFromUrl,
  type DynastyChapterJson,
  type DynastySeriesJson,
} from '../src/sources/adapters/dynasty.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://dynasty-scans.com/series/bloom_into_you';
const CHAPTER = 'https://dynasty-scans.com/chapters/bloom_into_you_ch01';

describe('dynasty adapter', () => {
  it('owns dynasty-scans.com urls and extracts slugs', () => {
    expect(matchesUrl(dynasty, SERIES)).toBe(true);
    expect(matchesUrl(dynasty, CHAPTER)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('bloom_into_you');
    expect(chapterSlugFromUrl(CHAPTER)).toBe('bloom_into_you_ch01');
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('dynasty-search.html'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      title: 'Bloom Into You Comic Anthology',
      url: 'https://dynasty-scans.com/series/bloom_into_you_comic_anthology',
    });
  });

  it('parses series json and ascending chapters', () => {
    const data = JSON.parse(fx('dynasty-series.json')) as DynastySeriesJson;
    const s = parseSeriesJson(data, SERIES);
    expect(s.title).toBe('Bloom Into You');
    expect(s.cover).toMatch(/^https:\/\/dynasty-scans\.com\/system\//);
    expect(s.chapters.length).toBeGreaterThan(40);
    const numbers = s.chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(s.chapters.find((c) => c.number === 1)).toMatchObject({
      number: 1,
      url: CHAPTER,
      date: '2015-05-10T00:00:00.000Z',
      locked: false,
    });
  });

  it('parses chapter pages json', () => {
    const data = JSON.parse(fx('dynasty-chapter.json')) as DynastyChapterJson;
    const pages = parseChapterJson(data, CHAPTER);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages[0]).toEqual({
      url: 'https://dynasty-scans.com/system/releases/000/013/404/000.webp',
      name: '001.webp',
      headers: { referer: CHAPTER },
    });
  });
});
