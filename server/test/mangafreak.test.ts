import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idFromUrl, mangafreak, parseChapterList, parsePages, parseSearch, parseSeries } from '../src/sources/adapters/mangafreak.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://ww3.mangafreak.me/Manga/Majo_To_Ryouken';

describe('mangafreak adapter', () => {
  it('owns mangafreak.me urls and extracts the id', () => {
    expect(matchesUrl(mangafreak, SERIES)).toBe(true);
    expect(idFromUrl(SERIES)).toBe('Majo_To_Ryouken');
    expect(idFromUrl('https://ww3.mangafreak.me/Read1_Majo_To_Ryouken_1')).toBe('Majo_To_Ryouken');
    expect(idFromUrl('https://ww3.mangafreak.me/')).toBeNull();
  });

  it('maps search results', () => {
    expect(parseSearch(fx('mangafreak-search.html'))).toEqual([
      { title: 'Majo to Ryouken', url: SERIES, cover: 'https://images.mangafreak.me/manga_images/majo_to_ryouken.jpg' },
    ]);
  });

  it('parses series info', () => {
    const s = parseSeries(fx('mangafreak-series.html'), SERIES);
    expect(s).toMatchObject({ title: 'Majo to Ryouken', url: SERIES });
    expect(s.cover).toMatch(/majo_to_ryouken\.jpg/);
    expect(s.description).toMatch(/^The Oguni Campus Fellows/);
    expect(s.altTitles).toContain('Witch and Hound');
  });

  it('parses an ascending chapter list, skipping suffixed variants', () => {
    const chapters = parseChapterList(fx('mangafreak-series.html'));
    expect(chapters.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(chapters[0]).toMatchObject({
      number: 1,
      url: 'https://ww3.mangafreak.me/Read1_Majo_To_Ryouken_1',
      locked: false,
    });
  });

  it('collects reader images in order', () => {
    const pages = parsePages(fx('mangafreak-chapter.html'), 'https://ww3.mangafreak.me/Read1_Majo_To_Ryouken_1');
    expect(pages).toHaveLength(30);
    expect(pages[0]!.name).toBe('001.jpg');
    expect(pages[0]!.url).toBe('https://images.mangafreak.me/mangas/majo_to_ryouken/majo_to_ryouken_1/majo_to_ryouken_1_1.jpg');
    expect(pages[0]!.headers).toEqual({ referer: 'https://ww3.mangafreak.me/Read1_Majo_To_Ryouken_1' });
  });
});
