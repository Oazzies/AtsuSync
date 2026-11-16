import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { wantsNovel } from '../src/atsu/presence.ts';
import { knoxt, parseChapterText as knoxtText, parseSearch as knoxtSearch, parseSeries as knoxtSeries } from '../src/sources/adapters/knoxt.ts';
import { novelcool, parseChapterText as ncText, parseSearch as ncSearch, parseSeries as ncSeries } from '../src/sources/adapters/novelcool.ts';
import { wuxiaworld, parseChapterText as wwText, parseSeries as wwSeries, searchSitemap as wwSearch } from '../src/sources/adapters/wuxiaworld.ts';
import { hiraeth } from '../src/sources/adapters/hiraeth.ts';
import { wuxiaworldsite } from '../src/sources/adapters/wuxiaworldsite.ts';
import { parseMadaraSearch, parseMadaraSeries, parseMadaraText } from '../src/sources/madara.ts';
import { chapterNumberFrom, chapterXhtml } from '../src/sources/novel.ts';
import { matchesUrl, mediumOf, type SourceAdapter } from '../src/sources/types.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { openDb } from '../src/db/client.ts';
import { createEpub } from '../src/upload/epub.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const plain = (xhtml: string) => xhtml.replace(/<[^>]+>/g, '');

describe('chapter XHTML sanitizer', () => {
  const run = (html: string) => {
    const $ = cheerio.load(`<div id="c">${html}</div>`);
    return chapterXhtml($, $('#c'));
  };

  it('keeps paragraphs and emphasis, escapes text, drops ads and empty paragraphs', () => {
    const out = run('<p>Tom &amp; <em>Jerry</em> &lt;3</p><p>&nbsp;</p><script>x()</script><div class="ads"><ins>ad</ins></div><p><strong>Bold</strong></p>');
    expect(out).toBe('<p>Tom &amp; <em>Jerry</em> &lt;3</p>\n<p><strong>Bold</strong></p>');
  });

  it('splits <br>-separated text into paragraphs and unwraps nested divs', () => {
    expect(run('<div><div>One<br>Two<br/><br>Three</div></div>')).toBe('<p>One</p>\n<p>Two</p>\n<p>Three</p>');
  });

  it('turns headings into h2 and strips zero-width watermarks', () => {
    expect(run('<h3>Part​ 1</h3><p>Hi‍</p>')).toBe('<h2>Part 1</h2>\n<p>Hi</p>');
  });

  it('reads chapter numbers from labels and slugs', () => {
    expect(chapterNumberFrom('Ch. 133 -END-')).toBe(133);
    expect(chapterNumberFrom('x', 'emperor-chapter-12-5')).toBe(12.5);
    expect(chapterNumberFrom('Prologue')).toBeNull();
  });
});

describe('EPUB writer', () => {
  it('writes a stored mimetype first, then container, package, nav and chapter', () => {
    const zip = createEpub({ seriesTitle: 'A & B', chapterTitle: 'Chapter 1', bodyHtml: '<p>Hello</p>' });
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.subarray(30, 38).toString()).toBe('mimetype');
    expect(zip.subarray(38, 58).toString()).toBe('application/epub+zip');
    const text = zip.toString('latin1');
    for (const name of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/chapter.xhtml']) expect(text).toContain(name);
    expect(text).toContain('<dc:title>A &amp; B - Chapter 1</dc:title>');
    expect(text).toContain('<p>Hello</p>');
  });

  it('bundles illustrations and rewrites their src', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const zip = createEpub({
      seriesTitle: 'S',
      chapterTitle: 'C',
      bodyHtml: '<p><img src="https://x.test/a.png" alt=""/></p>',
      images: [{ src: 'https://x.test/a.png', bytes: png, mediaType: 'image/png' }],
    });
    const text = zip.toString('latin1');
    expect(text).toContain('src="images/img-001.png"');
    expect(text).toContain('media-type="image/png"');
    expect(text).not.toContain('src="https://x.test/a.png"');
  });
});

describe('request medium', () => {
  it('detects novel requests from tags or title', () => {
    expect(wantsNovel({ tags: [{ id: '1', name: 'Novel', emoji: null }], title: 'X' })).toBe(true);
    expect(wantsNovel({ tags: [], title: 'Some Title (Novel)' })).toBe(true);
    expect(wantsNovel({ tags: [], title: 'Some Manhwa' })).toBe(false);
  });
});

describe('novel adapters', () => {
  it('are registered in the default registry', () => {
    const ids = new SourceRegistry(openDb(':memory:')).enabled().filter((a) => mediumOf(a) === 'novel').map((a) => a.id);
    expect(ids.sort()).toEqual(['hiraeth', 'knoxt', 'novelcool', 'wuxiaworld', 'wuxiaworldsite']);
  });

  it('are all novel sources that own their hosts', () => {
    for (const [a, url] of [
      [novelcool, 'https://www.novelcool.com/novel/Emperor-of-Solo-Play.html'],
      [wuxiaworldsite, 'https://wuxiaworld.site/novel/x/'],
      [hiraeth, 'https://hiraethtranslation.com/novel/x/'],
      [wuxiaworld, 'https://www.wuxiaworld.com/novel/beyond-the-zenith/bz-chapter-1'],
      [knoxt, 'https://knoxt.space/alpha-predator/'],
    ] as [SourceAdapter, string][]) {
      expect(mediumOf(a)).toBe('novel');
      expect(a.getChapterText).toBeTypeOf('function');
      expect(matchesUrl(a, url)).toBe(true);
    }
    expect(mediumOf({})).toBe('comic');
  });

  it('NovelCool: only novels in search, full chapter list, chapter text', () => {
    const hits = ncSearch(fx('novelcool-search.html'));
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ title: 'Emperor Of Solo Play', url: 'https://www.novelcool.com/novel/Emperor-of-Solo-Play.html' });

    const s = ncSeries(fx('novelcool-series.html'), 'https://www.novelcool.com/novel/Emperor-of-Solo-Play.html');
    expect(s.title).toBe('Emperor Of Solo Play');
    expect(s.altTitles).toContain('솔플의 제왕');
    expect(s.chapters[0]).toMatchObject({ number: 0, label: 'Prologue' });
    expect(s.chapters[1]).toMatchObject({ number: 1 });
    expect(s.chapters.at(-1)).toMatchObject({ number: 191, label: 'Chapter 191' });
    expect(s.chapters.length).toBeGreaterThan(150);

    const t = ncText(fx('novelcool-chapter.html'), 'Prologue');
    expect(t.title).toBe('Emperor of Solo Play Prologue');
    expect(plain(t.html)).toContain('I’ve been called trash my whole life.');
    expect(plain(t.html)).not.toMatch(/Chapter end/i);
  });

  it('Wuxiaworld.site: Madara novel list from ajax/chapters and chapter text', () => {
    const hits = parseMadaraSearch(fx('wuxiaworldsite-search.html'), 'https://wuxiaworld.site');
    expect(hits[0]!.url).toMatch(/^https:\/\/wuxiaworld\.site\/novel\//);

    const s = parseMadaraSeries(`${fx('wuxiaworldsite-series.html')}<ul>${fx('wuxiaworldsite-chapters.html')}</ul>`, 'https://wuxiaworld.site/novel/complete-martial-arts-attributes-spp/', 'https://wuxiaworld.site');
    expect(s.title).toBe('Complete Martial Arts Attributes');
    expect(s.chapters.length).toBeGreaterThan(3000);
    expect(s.chapters[0]).toMatchObject({ number: 1 });

    const t = parseMadaraText(fx('wuxiaworldsite-chapter.html'), 'Chapter 1');
    expect(t.title).toMatch(/Chapter 1/);
    expect(plain(t.html)).toContain('Donghai was as hot as a furnace in June');
    expect(t.html.match(/<p>/g)!.length).toBeGreaterThan(20);
  });

  it('Wuxiaworld (official): sitemap search, chapter range from the embedded state, chapter text', () => {
    const hits = wwSearch(fx('wuxiaworld-sitemap.xml'), 'Beyond the Zenith');
    expect(hits[0]).toMatchObject({ title: 'Beyond The Zenith', url: 'https://www.wuxiaworld.com/novel/beyond-the-zenith' });
    expect(wwSearch(fx('wuxiaworld-sitemap.xml'), 'zzzz nothing')).toEqual([]);

    const s = wwSeries(fx('wuxiaworld-novel.html'), 'https://www.wuxiaworld.com/novel/beyond-the-zenith');
    expect(s.title).toBe('Beyond the Zenith');
    expect(s.chapters[0]).toMatchObject({ number: 1, url: 'https://www.wuxiaworld.com/novel/beyond-the-zenith/bz-chapter-1' });
    expect(s.chapters.at(-1)).toMatchObject({ number: 148 });

    const t = wwText(fx('wuxiaworld-chapter.html'), 'Chapter 1');
    expect(t.title).toBe('Chapter 1 - Once Upon a Time at Fenglong Valley');
    expect(plain(t.html)).toContain('Han Qingyu');
    expect(t.html).not.toContain('data-uid');
  });

  it('Hiraeth Translation: Madara novel list and chapter text', () => {
    const url = 'https://hiraethtranslation.com/novel/born-to-be-either-rich-or-noble/';
    expect(parseMadaraSearch(fx('hiraeth-search.html'), 'https://hiraethtranslation.com').length).toBeGreaterThan(5);
    const s = parseMadaraSeries(`${fx('hiraeth-series.html')}<ul>${fx('hiraeth-ajax.html')}</ul>`, url, 'https://hiraethtranslation.com');
    expect(s.chapters.length).toBeGreaterThan(60);
    expect(s.chapters[0]!.number).toBeLessThan(s.chapters.at(-1)!.number);
    expect(plain(parseMadaraText(fx('hiraeth-ch.html'), 'Chapter 1').html).length).toBeGreaterThan(500);
  });

  it('KnoxT: search, series chapter list and chapter text', () => {
    const hits = knoxtSearch(fx('knoxt-search.html'));
    expect(hits[0]).toMatchObject({ title: 'Alpha Predator', url: 'https://knoxt.space/alpha-predator/' });
    const s = knoxtSeries(fx('knoxt-series.html'), 'https://knoxt.space/alpha-predator/');
    expect(s.title).toBe('Alpha Predator');
    expect(s.altTitles).toContain('Top Predator');
    expect(s.chapters[0]).toMatchObject({ number: 1, url: 'https://knoxt.space/alpha-predator-chapter-1/' });
    expect(s.chapters.at(-1)).toMatchObject({ number: 133 });
    const t = knoxtText(fx('knoxt-ch.html'), 'Chapter 1');
    expect(t.title).toBe('AP Chapter 1');
    expect(plain(t.html).length).toBeGreaterThan(1000);
    expect(t.html).not.toContain('<img');
  });
});

describe('novel download pipeline', () => {
  let close: (() => Promise<unknown>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  const novel = (opts: { empty?: boolean } = {}): SourceAdapter => ({
    id: 'fakenovel',
    name: 'Fake Novels',
    baseUrl: 'https://novel.test',
    kind: 'aggregator',
    medium: 'novel',
    hosts: ['novel.test'],
    rateLimit: { rpm: 6000, concurrency: 4 },
    search: async () => [{ title: 'Night Library', url: 'https://novel.test/n/night' }],
    getSeries: async (url) => ({ title: 'Night Library', url, altTitles: [], chapters: [{ number: 1, label: 'Chapter 1', url: 'https://novel.test/n/night/1' }] }),
    getChapterPages: async () => {
      throw new Error('not a comic');
    },
    getChapterText: async () => ({
      title: 'Chapter 1: Dusk',
      html: opts.empty ? '<p>.</p>' : '<p>The library opened at dusk and never closed.</p><p>' + 'More text. '.repeat(5) + '</p>',
    }),
  });

  const setup = (adapter: SourceAdapter) => {
    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const ctx = buildApp({ dbFile: ':memory:', downloadsDir: mkdtempSync(join(tmpdir(), 'atsusync-')), adapters: [adapter], fetchImpl, background: false });
    ctx.requests.upsertPost({
      id: 'NOV1',
      forumId: 'f',
      title: 'Night Library',
      content: '',
      commentCount: 0,
      score: 0,
      pinned: false,
      locked: false,
      removed: false,
      createdAt: Date.now(),
      tags: [{ id: 't', name: 'Novel', emoji: null }],
    });
    close = () => ctx.app.close();
    return ctx;
  };

  const settle = async (t: ReturnType<typeof setup>) => {
    for (let i = 0; i < 500; i++) {
      if (t.pipeline.list().every((j) => ['done', 'failed', 'cancelled'].includes(j.state))) return t.pipeline.list();
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('jobs did not finish');
  };

  it('turns a novel chapter into an .epub download', async () => {
    const t = setup(novel());
    const link = await t.links.create({ requestId: 'NOV1', sourceId: 'fakenovel', seriesUrl: 'https://novel.test/n/night', checkIntervalMin: 60 });
    t.pipeline.enqueue([t.links.chapters(link.id)[0]!.id]);
    const [job] = await settle(t);
    expect(job).toMatchObject({ state: 'done' });
    const file = t.pipeline.file(job!.id)!;
    expect(file.name).toBe('Night Library - Chapter 1.epub');
    const epub = readFileSync(file.path);
    expect(epub.subarray(38, 58).toString()).toBe('application/epub+zip');
    expect(epub.includes(Buffer.from('The library opened at dusk'))).toBe(true);
    expect(t.links.chapters(link.id)[0]!.state).toBe('downloaded');
  });

  it('fails a chapter that has no text instead of writing an empty book', async () => {
    const t = setup(novel({ empty: true }));
    const link = await t.links.create({ requestId: 'NOV1', sourceId: 'fakenovel', seriesUrl: 'https://novel.test/n/night', checkIntervalMin: 60 });
    t.pipeline.enqueue([t.links.chapters(link.id)[0]!.id]);
    const [job] = await settle(t);
    expect(job).toMatchObject({ state: 'failed' });
    expect(job!.error).toMatch(/no text/);
    expect(t.pipeline.file(job!.id)).toBeNull();
  });

  it('only searches novel sources for a Novel request, and not comic sources', async () => {
    const comic: SourceAdapter = { ...novel(), id: 'fakecomic', name: 'Fake Comics', medium: undefined, hosts: ['comic.test'], search: async () => [{ title: 'Night Library', url: 'https://comic.test/n' }] };
    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const ctx = buildApp({ dbFile: ':memory:', downloadsDir: mkdtempSync(join(tmpdir(), 'atsusync-')), adapters: [novel(), comic], fetchImpl, background: false });
    close = () => ctx.app.close();
    ctx.requests.upsertPost({
      id: 'NOV2', forumId: 'f', title: 'Night Library', content: '', commentCount: 0, score: 0, pinned: false, locked: false, removed: false, createdAt: Date.now(),
      tags: [{ id: 't', name: 'Novel', emoji: null }],
    });
    const matches = await ctx.discovery.find(ctx.requests.get('NOV2')!);
    expect(matches.map((m) => m.sourceId)).toEqual(['fakenovel']);
  });
});
