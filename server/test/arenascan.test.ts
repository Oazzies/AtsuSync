import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arenascan, parseChapterList, parsePages, parseSearch, parseSeries, slugFromUrl } from '../src/sources/adapters/arenascan.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://arenascan.com/manga/i-am-selling-the-main-characters-shares/';
const CHAPTER = 'https://arenascan.com/i-am-selling-the-main-characters-shares-1/';

describe('arenascan adapter', () => {
  it('owns arenascan.com urls and extracts the slug', () => {
    expect(matchesUrl(arenascan, CHAPTER)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('i-am-selling-the-main-characters-shares');
    expect(slugFromUrl(CHAPTER)).toBeNull();
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('arenascan-search.html'));
    expect(hits[0]).toMatchObject({ url: SERIES, title: 'I Am Selling the Main Character’s Shares' });
    expect(hits[0]!.cover).toMatch(/^https:\/\//);
  });

  it('parses series info', () => {
    expect(parseSeries(fx('arenascan-series.html'), SERIES).title).toBe('I Am Selling the Main Character’s Shares');
  });

  it('builds an ascending chapter list using data-num', () => {
    const chapters = parseChapterList(fx('arenascan-series.html'));
    expect(chapters.length).toBeGreaterThan(90);
    const numbers = chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(chapters[0]).toMatchObject({ number: 1, url: CHAPTER });
    expect(chapters.at(-1)).toMatchObject({ number: 98, url: 'https://arenascan.com/i-am-selling-the-main-characters-shares-98/' });
  });

  it('extracts reader pages in order', () => {
    const pages = parsePages(fx('arenascan-chapter.html'), CHAPTER);
    expect(pages).toHaveLength(14);
    expect(pages[0]).toMatchObject({ name: '001.webp', url: 'https://cdn.arenascan.com/arena-bucket/137474/1/01.webp' });
  });
});
