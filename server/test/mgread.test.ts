import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mgread, parseChapterList, parsePages, parseSearch, parseSeries, slugFromUrl } from '../src/sources/adapters/mgread.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('mgread adapter', () => {
  it('owns mgread.io urls and extracts the slug', () => {
    expect(matchesUrl(mgread, 'https://mgread.io/manga/my-husbands-scandal/chapter-48/')).toBe(true);
    expect(slugFromUrl('https://mgread.io/manga/my-husbands-scandal/chapter-48/')).toBe('my-husbands-scandal');
    expect(slugFromUrl('https://mgread.io/')).toBeNull();
  });

  it('maps search results', () => {
    const hits = parseSearch(JSON.parse(fx('mgread-search.json')));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).not.toMatch(/<|&/);
    expect(hits[0]!.url).toMatch(/^https:\/\/mgread\.io\/manga\/[^/]+\/$/);
  });

  it('parses series info and chapter list with pagination', () => {
    const html = fx('mgread-series.html');
    expect(parseSeries(html, 'https://mgread.io/manga/my-husbands-scandal/')).toMatchObject({ title: 'My Husband’s Scandal' });
    const { chapters, lastPage } = parseChapterList(html);
    expect(chapters[0]).toMatchObject({ number: 48, url: 'https://mgread.io/manga/my-husbands-scandal/chapter-48/', locked: false });
    expect(chapters.length).toBe(6);
    expect(lastPage).toBe(2);
  });

  it('collects reader images from lazy-loaded and eager tags', () => {
    const pages = parsePages(fx('mgread-chapter.html'), 'https://mgread.io/manga/my-husbands-scandal/chapter-48/');
    expect(pages.map((p) => p.name)).toEqual(['001.jpg', '002.jpg', '003.jpg', '004.jpg', '005.jpg']);
    expect(pages[1]!.url).toBe('https://mg.mgread.io/332973/48/2.jpg');
  });
});
