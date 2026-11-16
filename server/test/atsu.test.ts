import { describe, expect, it } from 'vitest';
import { parseSeriesState } from '../src/atsu/client.ts';
import { checkMangaBakaForRequest, parseMangaBaka, searchMangaBakaSeries } from '../src/atsu/mangabaka.ts';
import { isUploadable, parseTrackers, statusFromTags, uploadMangaBakaId } from '../src/atsu/requests.ts';
import { bestScore, searchQueries } from '../src/sources/match.ts';

describe('content request parsing', () => {
  it('finds tracker links', () => {
    const t = parseTrackers('tracker:\nhttps://mangabaka.org/manhwa/36039/The-Sound-of-Your-Voice\nalso https://anilist.co/manga/110791/x');
    expect(t[0]).toEqual({ kind: 'mangabaka', url: 'https://mangabaka.org/manhwa/36039/The-Sound-of-Your-Voice', id: '36039' });
    expect(t[1]).toMatchObject({ kind: 'anilist', id: '110791' });
  });

  it('maps status tags', () => {
    expect(statusFromTags([{ name: 'Manhwa' }])).toBe('open');
    expect(statusFromTags([{ name: 'New series' }, { name: "Can't add" }])).toBe('cant_add');
    expect(statusFromTags([{ name: 'Added' }])).toBe('added');
  });

  it('parses MangaBaka alt titles, chapter count, status, and url', () => {
    const mb = parseMangaBaka({
      id: 36039,
      title: 'The Sound of Your Voice',
      native_title: '목소리를 들려주세요',
      romanized_title: 'Moksorireul Deullyeojuseyo',
      secondary_titles: { unknown: [{ title: '恋上你的声音' }] },
      type: 'manhwa',
      status: 'completed',
      total_chapters: '125',
      canonical_url: 'https://mangabaka.org/manhwa/36039/The-Sound-of-Your-Voice',
      description: 'A story about voice actors.',
      year: 2018,
      authors: ['HANA'],
      genres: ['drama', 'romance'],
      rating: 76.8,
      content_rating: 'safe',
    })!;
    expect(mb.titles).toEqual(['The Sound of Your Voice', 'Moksorireul Deullyeojuseyo', '恋上你的声音', '목소리를 들려주세요']);
    expect(mb.totalChapters).toBe(125);
    expect(mb.status).toBe('completed');
    expect(mb.type).toBe('manhwa');
    expect(mb.url).toBe('https://mangabaka.org/manhwa/36039/The-Sound-of-Your-Voice');
    expect(mb.description).toBe('A story about voice actors.');
    expect(mb.year).toBe(2018);
    expect(mb.authors).toEqual(['HANA']);
    expect(mb.genres).toEqual(['drama', 'romance']);
    expect(mb.rating).toBe(76.8);
    expect(mb.contentRating).toBe('safe');
  });

  it('filters MangaBaka search results by comic vs novel medium', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 85266, title: 'Solo Leveling', type: 'novel', status: 'completed', total_chapters: '270' },
            { id: 3397, title: 'Solo Leveling', type: 'manhwa', status: 'completed', total_chapters: '201' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const comic = await searchMangaBakaSeries(['Solo Leveling'], 'comic', fakeFetch);
    expect(comic?.id).toBe(3397);
    expect(comic?.totalChapters).toBe(201);

    const novel = await searchMangaBakaSeries(['Solo Leveling'], 'novel', fakeFetch);
    expect(novel?.id).toBe(85266);
    expect(novel?.totalChapters).toBe(270);
  });

  it('detects medium mismatch on checkMangaBakaForRequest and falls back to matching medium', async () => {
    const fakeFetch = (async (url: string) => {
      if (url.includes('/series/85266')) {
        return new Response(
          JSON.stringify({ data: { id: 85266, title: 'Solo Leveling', type: 'novel', status: 'completed', total_chapters: '270' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [{ id: 3397, title: 'Solo Leveling', type: 'manhwa', status: 'completed', total_chapters: '201' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const res = await checkMangaBakaForRequest(
      { mangabakaId: '85266', title: 'Solo Leveling', altTitles: [], tags: [] },
      { force: true, fetchImpl: fakeFetch },
    );
    expect(res.mediumMismatch).toBe(false);
    expect(res.mangabaka?.id).toBe(3397);
    expect(res.mangabaka?.totalChapters).toBe(201);
  });
});

describe('upload button rule', () => {
  it('takes the first non-novel mangabaka link with a type segment, like atsu.moe', () => {
    expect(uploadMangaBakaId('see https://mangabaka.org/manhwa/123/some-title')).toBe('123');
    expect(uploadMangaBakaId('https://mangabaka.org/novel/9/x and https://mangabaka.dev/manga/42')).toBe('42');
    expect(uploadMangaBakaId('https://mangabaka.org/novel/9/x')).toBeNull();
    expect(uploadMangaBakaId('https://mangabaka.org/123')).toBeNull(); // no type segment → no button
    expect(uploadMangaBakaId('https://anilist.co/manga/1')).toBeNull();
  });

  it('is off for resolved posts and posts without a usable tracker link', () => {
    const body = 'https://mangabaka.org/manga/5';
    expect(isUploadable('open', body)).toBe(true);
    expect(isUploadable('queued', body)).toBe(true);
    expect(isUploadable('looking', body)).toBe(true);
    for (const s of ['added', 'cant_add', 'duplicate'] as const) expect(isUploadable(s, body)).toBe(false);
    expect(isUploadable('open', 'no links here')).toBe(false);
  });
});

describe('series state parsing', () => {
  it('reads coverage ranges and other sources from /api/uploads/series', () => {
    const s = parseSeriesState({
      series: { mangaId: 'F1ue', mangaBakaId: '36039', title: 'The Sound of Your Voice' },
      coverage: { out: [[1, 64]], waiting: [[65, 65]], total: 64 },
      sources: [],
      elsewhere: [{ id: 'x', manual: true, label: 'Koroshi', chapters: 65, first: 0, latest: 64, pending: 0 }],
    });
    expect(s).toMatchObject({ found: true, mangaId: 'F1ue', ranges: [[1, 64]], waiting: [[65, 65]], latest: 64 });
    expect(s.others[0]).toMatchObject({ label: 'Koroshi', chapters: 65 });
    expect(parseSeriesState({ series: { mangaId: null, mangaBakaId: '1' }, coverage: { out: [] } }).found).toBe(false);
    expect(parseSeriesState(null).found).toBe(false);
  });
});

describe('title matching', () => {
  it('scores close titles high and unrelated ones low', () => {
    expect(bestScore(['Heart Aching'], ['Heart-Aching'])).toBe(1);
    expect(bestScore(['The Sound of Your Voice'], ['Sound of Your Voice'])).toBe(1);
    expect(bestScore(['Solo Leveling (Official)'], ['Solo Leveling'])).toBe(1);
    expect(bestScore(['Heart Aching'], ['Solo Leveling'])).toBeLessThan(0.3);
    expect(bestScore(['The Villainess Turns the Hourglass'], ['The Villainess Lives Again'])).toBeLessThan(0.62);
    expect(bestScore(['Dandadan'], ['Dandadan 2'])).toBeLessThan(0.85);
  });

  it('dedupes search queries, strips release tags, and prefers latin titles', () => {
    expect(searchQueries(['아리도록', 'Heart-Aching (Official)', 'heart aching', 'Aching'])).toEqual([
      'Heart-Aching',
      'Aching',
      '아리도록',
    ]);
  });
});
