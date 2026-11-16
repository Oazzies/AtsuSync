import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chapterIdFromUrl, emptyReason, mangadex, mangaIdFromUrl, parseFeed, parsePages, parseSearch, type MdChapter } from '../src/sources/adapters/mangadex.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));

const ch = (
  id: string,
  chapter: string | null,
  over: Partial<MdChapter['attributes']> = {},
  relationships?: MdChapter['relationships'],
): MdChapter => ({
  id,
  attributes: { chapter, title: null, translatedLanguage: 'en', externalUrl: null, publishAt: '2020-01-01T00:00:00+00:00', pages: 20, ...over },
  relationships,
});

describe('mangadex adapter', () => {
  it('owns mangadex.org urls and extracts ids', () => {
    expect(matchesUrl(mangadex, 'https://mangadex.org/title/7a9d76c3-42b9-4bcf-81d7-ad307d2ea971/jojo-no-kimyou-na-bouken-part-8-jojolion-color-ban')).toBe(true);
    expect(mangaIdFromUrl('https://mangadex.org/title/7a9d76c3-42b9-4bcf-81d7-ad307d2ea971/slug')).toBe('7a9d76c3-42b9-4bcf-81d7-ad307d2ea971');
    expect(chapterIdFromUrl('https://mangadex.org/chapter/10580a56-8038-4b1a-b3d2-2590a6977ff7')).toBe('10580a56-8038-4b1a-b3d2-2590a6977ff7');
    expect(mangaIdFromUrl('https://mangadex.org/')).toBeNull();
  });

  it('maps search results with english title, alt titles and cover', () => {
    const hits = parseSearch(fx('mangadex-search.json'));
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0]!;
    expect(h.url).toMatch(/^https:\/\/mangadex\.org\/title\/[0-9a-f-]{36}$/);
    expect(h.title).toBe("JoJo's Bizarre Adventure Part 8 - JoJolion");
    expect(h.altTitles).toContain('JoJo no Kimyou na Bouken: Part 8 - JoJolion');
    expect(h.cover).toMatch(/^https:\/\/uploads\.mangadex\.org\/covers\/.+\.512\.jpg$/);
  });

  it('builds an ordered, unique english chapter list from the feed', () => {
    const chapters = parseFeed(fx('mangadex-feed.json').data);
    expect(chapters.length).toBeGreaterThan(50);
    const numbers = chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(chapters[0]).toMatchObject({ number: 1, url: 'https://mangadex.org/chapter/85bf3bb4-b467-4613-bdb4-55c15d0b215e', locked: false });
  });

  it('keeps english chapters, includes hosted external archives, skips external stubs/empty/unnumbered, and tracks group alternatives', () => {
    const grp = (name: string) => [{ type: 'scanlation_group', attributes: { name } }];
    const out = parseFeed([
      ch('a', '1', { pages: 10 }, grp('Group A')),
      ch('b', '1', { pages: 30 }, grp('Group B')), // more pages wins
      ch('c', '2', { translatedLanguage: 'fr' }),
      ch('d', '3', { externalUrl: 'https://mangaplus.shueisha.co.jp/viewer/1', pages: 1 }), // external-only stub → skipped
      ch('d2', '4', { externalUrl: 'https://www.bilibilicomics.com/mc1894/184719', pages: 50 }, grp('Bilibili Comics')), // hosted archive → kept
      ch('e', '5', { pages: 0 }),
      ch('f', null),
      ch('g', '5.5', { title: 'Extra' }, grp('Group C')),
      ch('h', '5.5', { pages: 20, publishAt: '2019-01-01T00:00:00+00:00' }, grp('Group D')), // tie → earliest
    ]);
    expect(out.map((c) => [c.number, c.url.split('/').pop(), c.group])).toEqual([
      [1, 'b', 'Group B'],
      [4, 'd2', 'Bilibili Comics'],
      [5.5, 'h', 'Group D'],
    ]);
    expect(out[0]!.alternatives).toEqual([
      { group: 'Group A', url: 'https://mangadex.org/chapter/a', label: 'Chapter 1', title: undefined, date: '2020-01-01T00:00:00+00:00' },
    ]);
    expect(out[1]!.alternatives).toBeUndefined();
    expect(out[2]!.alternatives?.map((a) => a.group)).toEqual(['Group C']);
  });

  it('treats unnumbered chapters as chapter 1 only for oneshots', () => {
    const out = parseFeed([ch('a', null, { pages: 10 }), ch('b', null, { pages: 51 })]);
    expect(out.map((c) => [c.number, c.url.split('/').pop()])).toEqual([[1, 'b']]);
  });

  it('explains why a series with no english chapters is empty', () => {
    const manga = (langs?: string[]) => ({ id: 'x', attributes: { title: { en: 'X' }, availableTranslatedLanguages: langs } });
    expect(emptyReason(manga(['id', 'es']))).toBe('no English chapters (only id, es)');
    expect(emptyReason(manga(['en']))).toMatch(/no hosted pages or are unavailable/);
    expect(emptyReason(manga())).toBe('no English chapters');
  });

  it('builds ordered page urls from the at-home response', () => {
    const json = fx('mangadex-athome.json');
    const pages = parsePages(json);
    expect(pages.length).toBe(json.chapter.data.length);
    expect(pages[0]!.name).toBe('001.jpg');
    expect(pages[0]!.url).toBe(`${json.baseUrl}/data/${json.chapter.hash}/${json.chapter.data[0]}`);
  });
});
