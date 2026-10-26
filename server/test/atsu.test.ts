import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtsuClient, parseSeriesState, type AtsuPostsPage } from '../src/atsu/client.ts';
import { parseMangaBaka } from '../src/atsu/mangabaka.ts';
import { RequestsRepo, parseTrackers, statusFromTags, syncRequests } from '../src/atsu/requests.ts';
import { openDb } from '../src/db/client.ts';
import { bestScore, searchQueries } from '../src/sources/match.ts';

const page0 = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'atsu-posts.json'), 'utf8')) as AtsuPostsPage;

/** Fake fetch serving forum pages: page 0 is the fixture, later pages are synthetic. */
function forumFetch(pages: AtsuPostsPage[]) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page] ?? { posts: [], hasMore: false }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

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

  it('parses MangaBaka alt titles', () => {
    const mb = parseMangaBaka({
      id: 36039,
      title: 'The Sound of Your Voice',
      native_title: '목소리를 들려주세요',
      romanized_title: 'Moksorireul Deullyeojuseyo',
      secondary_titles: { unknown: [{ title: '恋上你的声音' }] },
    })!;
    expect(mb.titles).toEqual(['The Sound of Your Voice', 'Moksorireul Deullyeojuseyo', '목소리를 들려주세요', '恋上你的声音']);
  });
});

describe('request sync', () => {
  it('stores request posts, skips the pinned guideline post, and stops quick sync on a known page', async () => {
    const db = openDb(':memory:');
    const repo = new RequestsRepo(db);
    const { impl, calls } = forumFetch([page0, { posts: [], hasMore: false }]);
    const client = new AtsuClient(() => '', impl);

    const first = await syncRequests(client, repo, db, { pageDelayMs: 0 });
    expect(first.added).toBe(19);
    expect(repo.has('RKkdDcky')).toBe(false);
    const req = repo.get('9EenD1PY')!;
    expect(req.mangabakaId).toBe('36039');
    expect(req.url).toBe('https://atsu.moe/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests/9EenD1PY');

    calls.length = 0;
    const second = await syncRequests(client, repo, db, { pageDelayMs: 0 });
    expect(second.added).toBe(0);
    expect(calls).toHaveLength(1); // page 0 fully known → no page 1
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
    expect(bestScore(['Heart Aching'], ['Solo Leveling'])).toBeLessThan(0.3);
  });

  it('dedupes search queries and prefers latin titles', () => {
    expect(searchQueries(['아리도록', 'Heart-Aching', 'heart aching', 'Aching'])).toEqual(['Heart-Aching', 'Aching', '아리도록']);
  });
});
