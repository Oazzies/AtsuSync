import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { novelcool } from '../src/sources/adapters/novelcool.ts';
import { SourceHttp } from '../src/sources/http.ts';
import {
  LNREADER_INDEX_URL,
  createLnreaderAdapter,
  dedupeLnreaderSources,
  loadLnreaderPlugin,
  type LnreaderPluginMeta,
} from '../src/sources/lnreader.ts';

const SAMPLE_PLUGIN_JS = `
const { fetchText } = require('@libs/fetch');
const cheerio = require('cheerio');
const { NovelStatus } = require('@libs/novelStatus');

exports.default = {
  id: 'sample-novel',
  name: 'SampleNovel',
  site: 'https://samplenovel.example/',
  version: '1.0.0',
  async searchNovels(term) {
    const html = await fetchText('https://samplenovel.example/search?q=' + encodeURIComponent(term));
    const $ = cheerio.load(html);
    return [{ name: $('h2').text(), path: '/novel/shadow-slave', cover: '/cover.jpg' }];
  },
  async parseNovel(novelPath) {
    return {
      name: 'Shadow Slave',
      path: novelPath,
      status: NovelStatus.Ongoing,
      summary: 'A dark fantasy novel.',
      chapters: [
        { name: 'Chapter 1: Nightmare', path: '/novel/shadow-slave/ch-1', releaseTime: '2026-01-01' },
        { name: 'Chapter 2: Awakening', path: '/novel/shadow-slave/ch-2', releaseTime: '2026-01-02' },
      ],
    };
  },
  async parseChapter() {
    return '<p>Sunny woke up.</p><script>evil()</script><p>The spell whispered.</p>';
  },
};
`;

function mockLnreaderFetch() {
  const index: LnreaderPluginMeta[] = [
    {
      id: 'sample-novel',
      name: 'SampleNovel',
      site: 'https://samplenovel.example/',
      lang: 'English',
      version: '1.0.0',
      url: 'https://cdn.example/sample-novel.js',
    },
    {
      id: 'novelcool-dup',
      name: 'NovelCool',
      site: 'https://www.novelcool.com/',
      lang: 'English',
      version: '1.0.0',
      url: 'https://cdn.example/novelcool.js',
    },
    {
      id: 'es-novel',
      name: 'EsNovel',
      site: 'https://esnovel.example/',
      lang: 'Spanish',
      version: '1.0.0',
      url: 'https://cdn.example/es.js',
    },
  ];

  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === LNREADER_INDEX_URL) return Response.json(index);
    if (url === 'https://cdn.example/sample-novel.js') return new Response(SAMPLE_PLUGIN_JS, { status: 200 });
    if (url.startsWith('https://samplenovel.example/search')) {
      return new Response('<h2>Shadow Slave</h2>', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  });
}

describe('LNReader plugins', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('deduplicates by id and domain and skips built-in/lncrawl domains', () => {
    const deduped = dedupeLnreaderSources(
      [
        { id: 'a', name: 'A', site: 'https://a.example/', lang: 'English', version: '1.0.0', url: 'https://x/a1.js' },
        { id: 'a', name: 'A', site: 'https://a.example/', lang: 'English', version: '1.2.0', url: 'https://x/a2.js' },
        { id: 'nc', name: 'NovelCool', site: 'https://novelcool.com/', lang: 'English', version: '1.0.0', url: 'https://x/nc.js' },
        { id: 'rr', name: 'RoyalRoad', site: 'https://www.royalroad.com/', lang: 'English', version: '1.0.0', url: 'https://x/rr.js' },
        { id: 'fr', name: 'French', site: 'https://fr.example/', lang: 'French', version: '1.0.0', url: 'https://x/fr.js' },
      ],
      [novelcool, { id: 'lncrawl:royalroad.com', hosts: ['royalroad.com'], baseUrl: 'https://www.royalroad.com/' }],
    );
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.version).toBe('1.2.0');
  });

  it('loads a CommonJS plugin, searches, parses novel, and sanitizes chapter XHTML', async () => {
    const fetchMock = mockLnreaderFetch();
    const http = new SourceHttp(fetchMock as unknown as typeof fetch, false);
    const meta: LnreaderPluginMeta = {
      id: 'sample-novel',
      name: 'SampleNovel',
      site: 'https://samplenovel.example/',
      lang: 'English',
      version: '1.0.0',
      url: 'https://cdn.example/sample-novel.js',
    };
    const plugin = loadLnreaderPlugin(SAMPLE_PLUGIN_JS, fetchMock as unknown as typeof fetch);
    const adapter = createLnreaderAdapter(meta, async () => plugin);

    expect(adapter.id).toBe('lnreader:sample-novel');
    expect(adapter.kind).toBe('lnreader');
    expect(adapter.medium).toBe('novel');

    const hits = await adapter.search!('Shadow Slave', http);
    expect(hits).toEqual([
      {
        title: 'Shadow Slave',
        url: 'https://samplenovel.example/novel/shadow-slave#lnreader=%2Fnovel%2Fshadow-slave',
        cover: 'https://samplenovel.example/cover.jpg',
      },
    ]);

    const series = await adapter.getSeries(hits[0]!.url, http);
    expect(series.title).toBe('Shadow Slave');
    expect(series.chapters.map((c) => c.number)).toEqual([1, 2]);

    const text = await adapter.getChapterText!(series.chapters[0]!, http);
    expect(text.title).toBe('Chapter 1: Nightmare');
    expect(text.html).toBe('<p>Sunny woke up.</p>\n<p>The spell whispered.</p>');
  });

  it('syncs and disables LNReader plugins via the HTTP API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-lnreader-'));
    dirs.push(dir);
    const fetchMock = mockLnreaderFetch();
    const { app } = buildApp({
      dbFile: join(dir, 'test.db'),
      adapters: [novelcool],
      fetchImpl: fetchMock as unknown as typeof fetch,
      background: false,
    });

    const syncRes = await app.inject({ method: 'POST', url: '/api/sources/lnreader/sync' });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().count).toBe(1);
    expect(syncRes.json().status.enabled).toBe(true);
    expect(syncRes.json().sources.map((s: { id: string }) => s.id)).toEqual(['novelcool', 'lnreader:sample-novel']);

    const testRes = await app.inject({
      method: 'POST',
      url: '/api/sources/lnreader:sample-novel/test',
      payload: { query: 'Shadow Slave' },
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);
    expect(testRes.json().hits[0].title).toBe('Shadow Slave');

    const disableRes = await app.inject({ method: 'POST', url: '/api/sources/lnreader/disable' });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().status.enabled).toBe(false);
    expect(disableRes.json().sources.map((s: { id: string }) => s.id)).toEqual(['novelcool']);

    await app.close();
  });
});
