import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { novelcool } from '../src/sources/adapters/novelcool.ts';
import { SourceHttp } from '../src/sources/http.ts';
import {
  LncrawlClient,
  createLncrawlAdapter,
  dedupeLncrawlSources,
  isEnglishLncrawlLang,
} from '../src/sources/lncrawl.ts';

function mockLncrawlFetch() {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};

    if (url.endsWith('/health')) {
      return Response.json({ ok: true });
    }
    if (url.endsWith('/sources')) {
      return Response.json({
        sources: [
          {
            domain: 'www.royalroad.com',
            url: 'https://www.royalroad.com/',
            language: 'en',
            canSearch: true,
            hasMtl: false,
            hasManga: false,
          },
          {
            domain: 'royalroad.com',
            url: 'https://www.royalroad.com/',
            language: 'en',
            canSearch: false,
            hasMtl: false,
            hasManga: false,
          },
          {
            domain: 'novelcool.com',
            url: 'https://www.novelcool.com/',
            language: 'en',
            canSearch: true,
            hasMtl: false,
            hasManga: false,
          },
          {
            domain: 'zh-site.example',
            url: 'https://zh-site.example/',
            language: 'zh',
            canSearch: true,
            hasMtl: false,
            hasManga: false,
          },
        ],
      });
    }
    if (url.endsWith('/search')) {
      expect(body.query).toBe('Mother of Learning');
      return Response.json({
        hits: [{ title: 'Mother of Learning', url: 'https://www.royalroad.com/fiction/21220/mother-of-learning' }],
      });
    }
    if (url.endsWith('/series')) {
      return Response.json({
        title: 'Mother of Learning',
        url: body.url,
        cover: 'https://www.royalroad.com/cover.jpg',
        author: 'nobody103',
        synopsis: 'Time loop story.',
        chapters: [
          { id: 1, title: 'Chapter 1: Good Morning Brother', url: 'https://www.royalroad.com/fiction/21220/chapter/1' },
          { id: 2, title: 'Chapter 2: Life in Cyoria', url: 'https://www.royalroad.com/fiction/21220/chapter/2' },
        ],
      });
    }
    if (url.endsWith('/chapter')) {
      return Response.json({
        title: 'Chapter 1: Good Morning Brother',
        html: '<p>Morning arrived.</p><script>bad()</script><p>Zorian woke up.</p>',
      });
    }

    return new Response('Not found', { status: 404 });
  });
}

describe('LNCrawl bridge', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('deduplicates domains, skips built-in adapters, and filters languages', () => {
    expect(isEnglishLncrawlLang('en')).toBe(true);
    expect(isEnglishLncrawlLang('all')).toBe(true);
    expect(isEnglishLncrawlLang('')).toBe(true);
    expect(isEnglishLncrawlLang('zh')).toBe(false);

    const deduped = dedupeLncrawlSources(
      [
        { domain: 'royalroad.com', url: 'https://www.royalroad.com/', language: 'en', canSearch: false, hasMtl: false, hasManga: false },
        { domain: 'www.royalroad.com', url: 'https://www.royalroad.com/', language: 'en', canSearch: true, hasMtl: false, hasManga: false },
        { domain: 'novelcool.com', url: 'https://www.novelcool.com/', language: 'en', canSearch: true, hasMtl: false, hasManga: false },
        { domain: 'atsu.moe', url: 'https://atsu.moe/', language: 'en', canSearch: true, hasMtl: false, hasManga: false },
      ],
      [novelcool],
    );
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.domain).toBe('royalroad.com');
    expect(deduped[0]!.canSearch).toBe(true);
  });

  it('searches, fetches series/chapters, and sanitizes chapter XHTML', async () => {
    const fetchMock = mockLncrawlFetch();
    const client = new LncrawlClient(() => 'http://127.0.0.1:4568', fetchMock as unknown as typeof fetch);
    const http = new SourceHttp(fetchMock as unknown as typeof fetch, false);

    const nodes = await client.listSources();
    const adapter = createLncrawlAdapter(nodes[0]!, client);
    expect(adapter.id).toBe('lncrawl:royalroad.com');
    expect(adapter.kind).toBe('lncrawl');
    expect(adapter.medium).toBe('novel');

    const hits = await adapter.search!('Mother of Learning', http);
    expect(hits).toEqual([
      { title: 'Mother of Learning', url: 'https://www.royalroad.com/fiction/21220/mother-of-learning' },
    ]);

    const series = await adapter.getSeries(hits[0]!.url, http);
    expect(series.title).toBe('Mother of Learning');
    expect(series.chapters.map((c) => c.number)).toEqual([1, 2]);

    const text = await adapter.getChapterText!(series.chapters[0]!, http);
    expect(text.title).toBe('Chapter 1: Good Morning Brother');
    expect(text.html).toBe('<p>Morning arrived.</p>\n<p>Zorian woke up.</p>');
  });

  it('syncs and clears LNCrawl sources via the HTTP API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-lncrawl-'));
    dirs.push(dir);
    const fetchMock = mockLncrawlFetch();
    const { app } = buildApp({
      dbFile: join(dir, 'test.db'),
      adapters: [novelcool],
      fetchImpl: fetchMock as unknown as typeof fetch,
      background: false,
    });

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { lncrawlUrl: 'http://127.0.0.1:4568' },
    });

    const syncRes = await app.inject({ method: 'POST', url: '/api/sources/lncrawl/sync' });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().count).toBe(1);
    expect(syncRes.json().sources.map((s: { id: string }) => s.id)).toEqual(['novelcool', 'lncrawl:royalroad.com']);

    const testRes = await app.inject({
      method: 'POST',
      url: '/api/sources/lncrawl:royalroad.com/test',
      payload: { query: 'Mother of Learning' },
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);
    expect(testRes.json().hits[0].title).toBe('Mother of Learning');

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { lncrawlUrl: '' },
    });
    const afterRes = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(afterRes.json().map((s: { id: string }) => s.id)).toEqual(['novelcool']);

    await app.close();
  });
});
