import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parsePages,
  parseSearch,
  parseSeries,
  readmanga,
  slugFromUrl,
} from '../src/sources/adapters/readmanga.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://readmanga.cc/manga/blue-lock-3';
const CHAPTER = 'https://readmanga.cc/read/blue-lock-3/chapter-1';

describe('readmanga adapter', () => {
  it('owns readmanga.cc urls and extracts slug', () => {
    expect(matchesUrl(readmanga, SERIES)).toBe(true);
    expect(matchesUrl(readmanga, CHAPTER)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('blue-lock-3');
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('readmanga-search.html'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.url).toMatch(/^https:\/\/readmanga\.cc\/manga\//);
  });

  it('parses series info and ascending chapters', () => {
    const s = parseSeries(fx('readmanga-series.html'), SERIES);
    expect(s.title.toLowerCase()).toContain('blue lock');
    expect(s.chapters.length).toBeGreaterThan(100);
    const numbers = s.chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(s.chapters[0]).toMatchObject({
      number: 1,
      url: CHAPTER,
      locked: false,
    });
  });

  it('collects reader images in order', () => {
    const pages = parsePages(fx('readmanga-chapter.html'), CHAPTER);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages[0]).toEqual({
      url: 'https://bcdn.readmanga.cc/comic/blue-lock-3/1/1.jpg',
      name: '001.jpg',
      headers: { referer: CHAPTER },
    });
  });
});
