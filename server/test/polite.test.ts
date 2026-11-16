import { describe, expect, it } from 'vitest';
import type { AtsuComment } from '../src/atsu/client.ts';
import { claimsFrom, isClaim } from '../src/atsu/presence.ts';
import { USER_AGENT } from '../src/polite.ts';
import { SourceHttp } from '../src/sources/http.ts';
import { isAllowed, parseRobots } from '../src/sources/robots.ts';

const NUVIA_ROBOTS = `User-Agent: *
Allow: /
Disallow: /profile
Disallow: /search
`;

describe('robots.txt', () => {
  it('applies longest-match rules from the * group', () => {
    const r = parseRobots(NUVIA_ROBOTS, 'atsusync');
    expect(isAllowed(r, '/search?q=x')).toBe(false);
    expect(isAllowed(r, '/comics/heart-aching')).toBe(true);
  });

  it('prefers a group naming AtsuSync and reads Crawl-delay', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: AtsuSync\nAllow: /comics/\nDisallow: /\nCrawl-delay: 5\n', 'atsusync');
    expect(isAllowed(r, '/comics/x')).toBe(true);
    expect(isAllowed(r, '/other')).toBe(false);
    expect(r.crawlDelaySec).toBe(5);
  });

  it('supports * and $ wildcards', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.json$\n', 'atsusync');
    expect(isAllowed(r, '/a/b.json')).toBe(false);
    expect(isAllowed(r, '/a/b.json?x=1')).toBe(true);
  });
});

describe('SourceHttp politeness', () => {
  it('identifies as AtsuSync, refuses robots-disallowed URLs, and stops at bot challenges', async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ua: new Headers(init?.headers).get('user-agent') });
      if (url.endsWith('/robots.txt')) return new Response(NUVIA_ROBOTS);
      if (url.includes('cf.test')) return new Response('<html><title>Just a moment...</title></html>', { status: 403 });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const http = new SourceHttp(fetchImpl);
    http.configureHost('site.test', { rpm: 6000, concurrency: 1 });
    http.configureHost('cf.test', { rpm: 6000, concurrency: 1 });

    expect(await http.text('https://site.test/comics/a')).toBe('ok');
    await expect(http.text('https://site.test/search?q=a')).rejects.toThrow(/robots/);
    await expect(http.text('https://cf.test/comics/a')).rejects.toThrow(/bot challenge/);
    expect(seen.every((s) => s.ua === USER_AGENT)).toBe(true);
    expect(seen.filter((s) => s.url.includes('/search'))).toEqual([]);
  });

  it('keeps static image asset downloads parallel and fast even when robots.txt specifies Crawl-delay', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nCrawl-delay: 5\n');
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 25));
      inflight--;
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }) as unknown as typeof fetch;
    const http = new SourceHttp(fetchImpl);
    http.configureHost('cdn.test', { rpm: 6000, concurrency: 1 });

    const start = Date.now();
    await Promise.all(Array.from({ length: 8 }, (_, i) => http.bytes(`https://cdn.test/img/${i}.jpg`)));
    const elapsed = Date.now() - start;

    expect(maxInflight).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it('skips robots.txt and retries transient network errors on GET', async () => {
    const seen: string[] = [];
    let attempts = 0;
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.includes('127.0.0.1')) return new Response(new Uint8Array([9, 8, 7]));
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
      attempts++;
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response('recovered');
    }) as unknown as typeof fetch;
    const http = new SourceHttp(fetchImpl);
    http.configureHost('flaky.test', { rpm: 6000, concurrency: 2 });

    const local = await http.bytes('http://127.0.0.1:4567/page/1.jpg');
    expect(local.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(seen.some((u) => u.includes('127.0.0.1/robots.txt'))).toBe(false);

    expect(await http.text('https://flaky.test/ch/1')).toBe('recovered');
    expect(attempts).toBe(2);
  });
});

describe('upload claims in comments', () => {
  const c = (content: string, extra: Partial<AtsuComment> = {}): AtsuComment => ({
    id: content, content, createdAt: 1, removed: false, score: 0, parentId: null,
    user: { usernameDisplay: 'Koroshi', usernameSlug: 'koroshi' }, ...extra,
  });

  it('spots "added" with an Atsu link and uploading notes, ignores chatter', () => {
    expect(isClaim('uploading now')).toBe(true);
    expect(isClaim('thank youuu')).toBe(false);
    expect(isClaim('as soon as im done with melancholy killing')).toBe(false);
    const claims = claimsFrom([c('added\nhttps://atsu.moe/manga/F1ue'), c('pls add this'), c('uploaded', { removed: true })]);
    expect(claims).toEqual([expect.objectContaining({ user: 'Koroshi', atsuMangaId: 'F1ue' })]);
  });
});

describe('presence check', () => {
  async function run(opts: { search: object[]; comments: object[] }) {
    const { openDb } = await import('../src/db/client.ts');
    const { RequestsRepo } = await import('../src/atsu/requests.ts');
    const { AtsuClient } = await import('../src/atsu/client.ts');
    const { PresenceChecker } = await import('../src/atsu/presence.ts');
    const db = openDb(':memory:');
    const repo = new RequestsRepo(db);
    repo.upsertPost({
      id: 'R1', forumId: 'f', title: 'Heart Aching', content: 'no tracker', sectionId: 'forum-post:x',
      commentCount: opts.comments.length, score: 0, pinned: false, locked: false, removed: false, createdAt: 1, tags: [],
    });
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.startsWith('/collections/')) return new Response(JSON.stringify({ hits: opts.search.map((d) => ({ document: d })) }));
      if (path === '/api/comments/v2/threads') return new Response(JSON.stringify({ comments: opts.comments }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return new PresenceChecker(new AtsuClient(() => '', fetchImpl), repo).check(repo.get('R1')!);
  }
  const user = { usernameDisplay: 'K', usernameSlug: 'k' };

  it('flags a near-exact title with chapters as already on Atsu', async () => {
    const p = await run({ search: [{ id: 'A1', title: 'Heart-Aching', otherNames: [], chapterCount: 31 }], comments: [] });
    expect(p).toMatchObject({ verdict: 'on_atsu', match: { mangaId: 'A1', via: 'search', chapterCount: 31 } });
  });

  it('flags upload comments as claimed when search finds nothing', async () => {
    const p = await run({ search: [], comments: [{ id: 'c1', content: 'uploading now', createdAt: 1, removed: false, user }] });
    expect(p.verdict).toBe('claimed');
    expect(p.claims).toHaveLength(1);
  });

  it('a similar but different title is only "possible"', async () => {
    const p = await run({ search: [{ id: 'A2', title: 'Heart Aching Love', otherNames: [], chapterCount: 5 }], comments: [] });
    expect(p.verdict).toBe('possible');
  });
});

describe('medium matching', () => {
  it('keeps novel requests and comic series apart', async () => {
    const { sameMedium } = await import('../src/atsu/presence.ts');
    const req = (title: string, tags: string[]) => ({ title, tags: tags.map((name) => ({ id: name, name, emoji: null })) }) as any;
    expect(sameMedium(req('Otherside Picnic (novel)', ['New series', 'Novel']), 'Comic')).toBe(false);
    expect(sameMedium(req('Otherside Picnic (novel)', ['Novel']), 'Novel')).toBe(true);
    expect(sameMedium(req('Solo Leveling', ['Manhwa']), 'Comic')).toBe(true);
    expect(sameMedium(req('Solo Leveling', ['Manhwa']), 'Novel')).toBe(false);
  });
});
