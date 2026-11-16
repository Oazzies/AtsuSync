import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chapterRefFromUrl,
  danke,
  parseChapterPages,
  parseSeriesJson,
  searchAllSeries,
  slugFromUrl,
  type DankeSeriesJson,
} from '../src/sources/adapters/danke.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://danke.moe/read/manga/xdress-underwear/';
const CHAPTER = 'https://danke.moe/read/manga/xdress-underwear/0/1/';

describe('danke adapter', () => {
  it('owns danke.moe urls and extracts slugs', () => {
    expect(matchesUrl(danke, SERIES)).toBe(true);
    expect(matchesUrl(danke, CHAPTER)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('xdress-underwear');
    expect(chapterRefFromUrl(CHAPTER)).toEqual({ slug: 'xdress-underwear', chapterKey: '0' });
  });

  it('filters all-series dictionary by query', () => {
    const hits = searchAllSeries(
      {
        '"When you\'re crossdressing, what do you do about your underwear?"': { slug: 'xdress-underwear' },
        'Other Series': { slug: 'other-series' },
      },
      'crossdressing',
    );
    expect(hits).toEqual([
      {
        title: '"When you\'re crossdressing, what do you do about your underwear?"',
        url: SERIES,
        cover: undefined,
      },
    ]);
  });

  it('parses series json and chapter pages', () => {
    const data = JSON.parse(fx('danke-series.json')) as DankeSeriesJson;
    const s = parseSeriesJson(data);
    expect(s.title).toContain('crossdressing');
    expect(s.chapters).toEqual([
      {
        number: 0,
        label: '0 — Oneshot',
        url: CHAPTER,
        title: 'Oneshot',
        date: '2021-11-28T18:39:50.000Z',
        locked: false,
      },
    ]);

    const pages = parseChapterPages(data, '0', CHAPTER);
    expect(pages).toEqual([
      {
        url: 'https://danke.moe/media/manga/xdress-underwear/chapters/0000_bm3f3e70/1/1_w.png?v3',
        name: '001.png',
        headers: { referer: CHAPTER },
      },
      {
        url: 'https://danke.moe/media/manga/xdress-underwear/chapters/0000_bm3f3e70/1/2.png?v3',
        name: '002.png',
        headers: { referer: CHAPTER },
      },
    ]);
  });
});
