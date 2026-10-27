import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mgeko, parseChapterList, parsePages, parseSearch, parseSeries, slugFromUrl } from '../src/sources/adapters/mgeko.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://www.mgeko.cc/manga/the-overachievers-black-tech-system-mang/';

describe('mgeko adapter', () => {
  it('owns mgeko.cc urls and extracts the slug', () => {
    expect(matchesUrl(mgeko, SERIES)).toBe(true);
    expect(matchesUrl(mgeko, 'https://www.mgeko.cc/reader/en/the-overachievers-black-tech-system-chapter-1-eng-li/')).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('the-overachievers-black-tech-system-mang');
    expect(slugFromUrl('https://www.mgeko.cc/')).toBeNull();
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('mgeko-search.html'));
    expect(hits).toEqual([
      {
        title: 'The Overachiever’s Black Tech System',
        url: SERIES,
        cover: 'https://www.mgeko.cc/media/manga_covers/2qie2ks5nl3q6k1yg9hzsxk6.jpg',
      },
    ]);
  });

  it('parses series info', () => {
    const s = parseSeries(fx('mgeko-series.html'), SERIES);
    expect(s).toMatchObject({ title: 'The Overachiever’s Black Tech System', url: SERIES });
    expect(s.cover).toBe('https://www.mgeko.cc/media/manga_covers/2qie2ks5nl3q6k1yg9hzsxk6.jpg');
    expect(s.description).toMatch(/^Using the Black Technology System/);
  });

  it('parses an ascending chapter list with dates from both page kinds', () => {
    for (const name of ['mgeko-series.html', 'mgeko-all-chapters.html']) {
      const chapters = parseChapterList(fx(name));
      expect(chapters.length).toBeGreaterThanOrEqual(4);
      const numbers = chapters.map((c) => c.number);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
      expect(chapters.at(-1)).toMatchObject({
        number: 174,
        url: 'https://www.mgeko.cc/reader/en/the-overachievers-black-tech-system-chapter-174-eng-li/',
        locked: false,
      });
    }
    expect(parseChapterList(fx('mgeko-all-chapters.html')).at(-1)!.date).toBe('2022-05-25T05:23:00.000Z');
  });

  it('reads decimal chapter numbers', () => {
    const html = `<ul class="chapter-list"><li><a href="/reader/en/x-chapter-12-5-eng-li/"></a></li><li><a href="/reader/en/x-chapter-12-eng-li/"></a></li></ul>`;
    expect(parseChapterList(html).map((c) => c.number)).toEqual([12, 12.5]);
  });

  it('collects reader images in order', () => {
    const pages = parsePages(fx('mgeko-chapter.html'), 'https://www.mgeko.cc/reader/en/x/');
    expect(pages.map((p) => p.name)).toEqual(['001.jpg', '002.jpg', '003.jpg', '004.jpg', '005.jpg']);
    expect(pages[0]!.url).toBe('https://imgsrv5.com/mg1/cdn_mangaraw/the-overachievers-black-tech-system/chapter-1/01.jpg');
    expect(pages[0]!.headers).toEqual({ referer: 'https://www.mgeko.cc/reader/en/x/' });
  });
});
