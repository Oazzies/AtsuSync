import { describe, expect, it } from 'vitest';
import {
  parseBookId,
  parseChapters,
  parseNuxtChapterPages,
  parsePages,
  parseSearch,
  seriesUrl,
  webcomics,
  type WcBookInfo,
} from '../src/sources/adapters/webcomics.ts';
import { SourceHttp } from '../src/sources/http.ts';
import { matchesUrl } from '../src/sources/types.ts';

const BOOK: WcBookInfo = {
  book_id: '6af40a2b62661d28a328e482',
  name: 'Once I was reborn as the Prince of the North',
  cover: 'https://imgg.mangaina.com/28d2bb0d53c6175f13295dbffd50e72f.webp',
  category: ['Fantasy'],
  description: 'A princess-prince story.',
};

const CHAPTER_URL =
  'https://www.webcomicsapp.com/en/fantasy/once-i-was-reborn-as-the-prince-of-the-north/1/6af40a2b62661d28a328e482';
const SERIES_URL =
  'https://www.webcomicsapp.com/en/fantasy/once-i-was-reborn-as-the-prince-of-the-north/6af40a2b62661d28a328e482';

describe('webcomics adapter', () => {
  it('owns webcomicsapp.com urls and extracts book ids from series and chapter urls', () => {
    expect(matchesUrl(webcomics, CHAPTER_URL)).toBe(true);
    expect(matchesUrl(webcomics, SERIES_URL)).toBe(true);
    expect(parseBookId(CHAPTER_URL)).toBe('6af40a2b62661d28a328e482');
    expect(parseBookId(SERIES_URL)).toBe('6af40a2b62661d28a328e482');
    expect(parseBookId('https://www.webcomicsapp.com/en/comic/slug/6af40a2b62661d28a328e482')).toBe(
      '6af40a2b62661d28a328e482',
    );
    expect(parseBookId('https://www.webcomicsapp.com/en/search?q=prince')).toBeNull();
    expect(seriesUrl(BOOK)).toBe(SERIES_URL);
  });

  it('parses search hits', () => {
    const hits = parseSearch({ code: 1000, data: { list: [BOOK] } });
    expect(hits).toEqual([
      {
        title: 'Once I was reborn as the Prince of the North',
        url: SERIES_URL,
        cover: 'https://imgg.mangaina.com/28d2bb0d53c6175f13295dbffd50e72f.webp',
      },
    ]);
  });

  it('parses chapters and marks unpaid is_pay chapters as locked', () => {
    const chapters = parseChapters(
      [
        { index: 2, chapter_id: 'b'.repeat(24), name: 'Ch. 2', is_pay: true, is_paid: false, update_time: 1794393000000 },
        { index: 1, chapter_id: 'a'.repeat(24), name: 'Ch. 1', is_pay: false, is_paid: false, update_time: 1794306600000 },
        { index: 3, chapter_id: 'c'.repeat(24), name: 'Ch. 3', is_pay: true, is_paid: true },
      ],
      BOOK,
    );
    expect(chapters.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(chapters[0]).toMatchObject({
      number: 1,
      label: 'Ch. 1',
      locked: false,
      url: `${CHAPTER_URL}#${'a'.repeat(24)}`,
      date: '2026-11-10T10:30:00.000Z',
    });
    expect(chapters[1]!.locked).toBe(true);
    expect(chapters[2]!.locked).toBe(false);
  });

  it('parses chapter detail pages with referer and dimensions', () => {
    const pages = parsePages({
      base_url: 'https://imgg.mangaina.com/',
      images: [
        { url: 'abc_cpImg.webp', width: 1080, height: 900 },
        { url: 'https://imgg.mangaina.com/def_cpImg.png', width: 0, height: 0 },
      ],
    });
    expect(pages).toEqual([
      {
        url: 'https://imgg.mangaina.com/abc_cpImg.webp',
        name: '001.webp',
        headers: { referer: 'https://www.webcomicsapp.com/' },
        width: 1080,
        height: 900,
      },
      {
        url: 'https://imgg.mangaina.com/def_cpImg.png',
        name: '002.png',
        headers: { referer: 'https://www.webcomicsapp.com/' },
        width: undefined,
        height: undefined,
      },
    ]);
  });

  it('decodes __NUXT_DATA__ as a fallback for bare chapter URLs', () => {
    const payload = [
      ['ShallowReactive', 1],
      { data: 2 },
      ['ShallowReactive', 3],
      { 'reader-seo-chapter-6af40a2b62661d28a328e482-1-en': 4 },
      { detail: 5 },
      { base_url: 6, images: 7 },
      'https://imgg.mangaina.com/',
      [8],
      { url: 9, width: 10, height: 11 },
      'page1.webp',
      1080,
      900,
    ];
    const html = `<html><body><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
    expect(parseNuxtChapterPages(html)).toEqual([
      {
        url: 'https://imgg.mangaina.com/page1.webp',
        name: '001.webp',
        headers: { referer: 'https://www.webcomicsapp.com/' },
        width: 1080,
        height: 900,
      },
    ]);
  });

  it('paginates chapter list in getSeries and refuses locked chapters in getChapterPages', async () => {
    const http = new SourceHttp(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/book/info')) {
        return new Response(JSON.stringify({ code: 1000, data: BOOK }), { status: 200 });
      }
      if (url.endsWith('/book/chapter/list')) {
        const body = JSON.parse(String(init?.body)) as { page: number };
        if (body.page === 1) {
          return new Response(
            JSON.stringify({
              code: 1000,
              data: {
                list: [{ index: 1, chapter_id: 'a'.repeat(24), name: 'Ch. 1', is_pay: false, is_paid: false }],
                pagination: { total: 2, page: 1, size: 200, next: true },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            code: 1000,
            data: {
              list: [{ index: 2, chapter_id: 'b'.repeat(24), name: 'Ch. 2', is_pay: true, is_paid: false }],
              pagination: { total: 2, page: 2, size: 200, next: false },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/book/chapter/detail')) {
        return new Response(
          JSON.stringify({
            code: 1000,
            data: { base_url: 'https://imgg.mangaina.com/', images: [{ url: 'p1.webp', width: 1080, height: 900 }] },
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }, false);
    for (const h of webcomics.hosts) http.configureHost(h, { rpm: 6000, concurrency: 4 });

    const series = await webcomics.getSeries(CHAPTER_URL, http);
    expect(series.title).toBe('Once I was reborn as the Prince of the North');
    expect(series.url).toBe(SERIES_URL);
    expect(series.chapters).toHaveLength(2);
    expect(series.chapters[0]!.locked).toBe(false);
    expect(series.chapters[1]!.locked).toBe(true);

    const pages = await webcomics.getChapterPages(series.chapters[0]!, http);
    expect(pages).toHaveLength(1);
    await expect(webcomics.getChapterPages(series.chapters[1]!, http)).rejects.toThrow(/locked/);
  });
});
