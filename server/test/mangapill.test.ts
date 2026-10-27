import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idFromUrl, mangapill, parseChapterList, parsePages, parseSearch, parseSeries } from '../src/sources/adapters/mangapill.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://mangapill.com/manga/9454/si-land';

describe('mangapill adapter', () => {
  it('owns mangapill.com urls and extracts the id', () => {
    expect(matchesUrl(mangapill, SERIES)).toBe(true);
    expect(matchesUrl(mangapill, 'https://mangapill.com/chapters/9454-10001000/si-land-chapter-1')).toBe(true);
    expect(idFromUrl(SERIES)).toBe('9454/si-land');
    expect(idFromUrl('https://mangapill.com/manga/9454')).toBe('9454');
    expect(idFromUrl('https://mangapill.com/')).toBeNull();
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('mangapill-search.html'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.find((h) => h.url === SERIES)).toEqual({
      title: 'Si Land',
      url: SERIES,
      cover: 'https://cdn.readdetectiveconan.com/file/mangapill/i/9454.jpeg?h=019b9262-9eb1-7cce-82b3-0e66d669452e',
    });
  });

  it('parses series info', () => {
    const s = parseSeries(fx('mangapill-series.html'), SERIES);
    expect(s).toMatchObject({ title: 'Si Land', url: SERIES });
    expect(s.cover).toMatch(/9454\.jpeg/);
    expect(s.description).toMatch(/^In a world where only dogs and cats exist/);
    expect(s.description).not.toMatch(/Source:/);
  });

  it('parses an ascending chapter list including decimals', () => {
    const chapters = parseChapterList(fx('mangapill-series.html'));
    const numbers = chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toContain(4.1);
    expect(numbers).toContain(4.2);
    expect(chapters[0]).toMatchObject({
      number: 1,
      url: 'https://mangapill.com/chapters/9454-10001000/si-land-chapter-1',
      locked: false,
    });
  });

  it('collects reader images in order', () => {
    const pages = parsePages(fx('mangapill-chapter.html'), 'https://mangapill.com/chapters/x');
    expect(pages.map((p) => p.name)).toEqual(['001.jpeg', '002.jpeg', '003.jpeg', '004.jpeg', '005.jpeg']);
    expect(pages[0]!.url).toBe('https://cdn.readdetectiveconan.com/file/mangap/9454/10001000/019b926c-cbcc-733e-aaad-89bac160a3f9/1.jpeg');
    expect(pages[0]!.headers).toEqual({ referer: 'https://mangapill.com/chapters/x' });
  });
});
