import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kingofshojo, parseChapterList, parsePages, parseSearch, parseSeries, slugFromUrl } from '../src/sources/adapters/kingofshojo.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://kingofshojo.com/manga/author-in-this-life-im-the-protagonist/';
const CHAPTER = 'https://kingofshojo.com/author-in-this-life-im-the-protagonist-chapter-1/';

describe('kingofshojo adapter', () => {
  it('owns kingofshojo.com urls and extracts the slug', () => {
    expect(matchesUrl(kingofshojo, CHAPTER)).toBe(true);
    expect(slugFromUrl(SERIES)).toBe('author-in-this-life-im-the-protagonist');
    expect(slugFromUrl(CHAPTER)).toBeNull();
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('kingofshojo-search.html'));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ url: SERIES });
    expect(hits[0]!.title).toMatch(/^Author, In This Life I.m The Protagonist$/);
    expect(hits[0]!.cover).toMatch(/^https:\/\/.+\.jpg$/);
  });

  it('parses series info', () => {
    const s = parseSeries(fx('kingofshojo-series.html'), SERIES);
    expect(s.title).toBe('Author, In This Life I’m The Protagonist');
    expect(s.cover).toMatch(/^https:\/\/.+\.jpg$/);
    expect(s.description).toMatch(/writer seems to have a hard time/);
    expect(s.description).not.toMatch(/^Read manhwa/);
    expect(s.altTitles).toContain('작가님, 이번 생은 여주인공입니다');
  });

  it('builds an ascending chapter list with dates', () => {
    const chapters = parseChapterList(fx('kingofshojo-series.html'));
    expect(chapters.length).toBeGreaterThan(70);
    const numbers = chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(chapters.at(-1)).toMatchObject({ number: 74, url: 'https://kingofshojo.com/author-in-this-life-im-the-protagonist-chapter-74/', date: '2025-07-11T00:00:00.000Z', locked: false });
  });

  it('extracts reader pages in order', () => {
    const pages = parsePages(fx('kingofshojo-chapter.html'), CHAPTER);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages[0]).toMatchObject({ name: '001.jpg', headers: { referer: CHAPTER } });
    expect(pages.map((p) => p.url)).toContain('https://cdn.kingofshojo.com/king-bucket/284013/1/1.jpg');
    expect(new Set(pages.map((p) => p.url)).size).toBe(pages.length);
  });

  it('falls back to the DOM when the reader script is missing', () => {
    const pages = parsePages('<div id="readerarea"><img src="https://x.test/a.png"><img src="https://x.test/b.png"></div>', CHAPTER);
    expect(pages.map((p) => p.name)).toEqual(['001.png', '002.png']);
  });
});
