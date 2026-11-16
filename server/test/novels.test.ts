import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { wantsNovel } from '../src/atsu/presence.ts';
import { knoxt, parseChapterText as knoxtText, parseSearch as knoxtSearch, parseSeries as knoxtSeries } from '../src/sources/adapters/knoxt.ts';
import { novelcool, parseChapterText as ncText, parseSearch as ncSearch, parseSeries as ncSeries } from '../src/sources/adapters/novelcool.ts';
import { penandpaper, parseChapterText as ppText, parseSearch as ppSearch, parseSeries as ppSeries } from '../src/sources/adapters/penandpaper.ts';
import { wuxiaworld, parseChapterText as wwText, parseSeries as wwSeries, searchSitemap as wwSearch } from '../src/sources/adapters/wuxiaworld.ts';
import { hiraeth } from '../src/sources/adapters/hiraeth.ts';
import { lightnovelto, parseChapterText as lnToText, parseSearch as lnToSearch, parseSeries as lnToSeries } from '../src/sources/adapters/lightnovelto.ts';
import { lnmtl, parseChapterText as lnmtlText, parseSeries as lnmtlSeries, parseVolumes as lnmtlVolumes } from '../src/sources/adapters/lnmtl.ts';
import { novelphoenix, parseChapterText as npText, parseChaptersPage as npChapters, parseSearch as npSearch, parseSeries as npSeries } from '../src/sources/adapters/novelphoenix.ts';
import { novelstime, parseChapterText as ntText, parseSearch as ntSearch, parseSeries as ntSeries } from '../src/sources/adapters/novelstime.ts';
import { novgo, parseChapterText as ngText, parseChaptersPage as ngChapters, parseSearch as ngSearch, parseSeries as ngSeries } from '../src/sources/adapters/novgo.ts';
import { requiemtls, parseChapterText as rqText, parseSearch as rqSearch, parseSeries as rqSeries } from '../src/sources/adapters/requiemtls.ts';
import { wuxiaclick, parseChapterText as wcText, parseSeries as wcSeries } from '../src/sources/adapters/wuxiaclick.ts';
import { wuxiadreams, parseChapterText as wdText, parseChaptersPage as wdChapters, parseSearch as wdSearch, parseSeries as wdSeries } from '../src/sources/adapters/wuxiadreams.ts';
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
    expect(ids.sort()).toEqual([
      'hiraeth',
      'knoxt',
      'lightnovelto',
      'lnmtl',
      'novelcool',
      'novelphoenix',
      'novelping',
      'novelstime',
      'novgo',
      'nyaa-novel',
      'penandpaper',
      'requiemtls',
      'scrollerspub',
      'woopread',
      'wuxiaclick',
      'wuxiadreams',
      'wuxiaworld',
      'wuxiaworldsite',
    ]);
  });

  it('are all novel sources that own their hosts', () => {
    for (const [a, url] of [
      [novelcool, 'https://www.novelcool.com/novel/Emperor-of-Solo-Play.html'],
      [wuxiaworldsite, 'https://wuxiaworld.site/novel/x/'],
      [hiraeth, 'https://hiraethtranslation.com/novel/x/'],
      [wuxiaworld, 'https://www.wuxiaworld.com/novel/beyond-the-zenith/bz-chapter-1'],
      [knoxt, 'https://knoxt.space/alpha-predator/'],
      [penandpaper, 'https://penandpapertranslations.com/return-of-a-crazy-genius-composer/'],
      [wuxiadreams, 'https://wuxiadreams.com/novel/shadow-slave'],
      [novelphoenix, 'https://novelphoenix.com/novel/shadow-slave'],
      [novelstime, 'https://www.novelstime.com/novel/the-protagonist-system_24549'],
      [requiemtls, 'https://requiemtls.com/series/dragonica-the-giant-dragon-front'],
      [wuxiaclick, 'https://wuxia.click/novel/remarried-empress'],
      [lightnovelto, 'https://lightnovel.to/novel/shadow-hack'],
      [lnmtl, 'https://lnmtl.com/novel/rebuking-winds-and-clouds'],
      [novgo, 'https://novgo.net/shadow-slave.html'],
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

  it('Pen & Paper Translations: search filters out chapter posts, series lists chapters and side stories, chapter text', () => {
    const hits = ppSearch(fx('penandpaper-search.html'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: 'Return of a Crazy Genius Composer',
      url: 'https://penandpapertranslations.com/return-of-a-crazy-genius-composer/',
    });

    const s = ppSeries(fx('penandpaper-series.html'), 'https://penandpapertranslations.com/return-of-a-crazy-genius-composer/');
    expect(s.title).toBe('Return of a Crazy Genius Composer');
    expect(s.chapters[0]).toMatchObject({ number: 1, url: 'https://penandpapertranslations.com/2025/01/17/the-return-of-the-genius-composer-chapter-1/' });
    expect(s.chapters.find((c) => c.number === 473)?.label).toContain('Main Story End');
    expect(s.chapters.at(-1)).toMatchObject({ number: 509, label: 'Return of a Crazy Genius Composer Side Story 36' });

    const t = ppText(fx('penandpaper-chapter.html'), 'Chapter 473');
    expect(t.title).toBe('Return of a Crazy Genius Composer Chapter 473 (Main Story End)');
    expect(plain(t.html)).toContain('Hyunseung had returned.');
    expect(t.html).not.toContain('Share this:');
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
    const res = await t.app.inject({ method: 'GET', url: `/api/downloads/${job!.id}/file` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/epub+zip');
    expect(res.headers['content-disposition']).toContain('Night Library - Chapter 1.epub');
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

describe('additional EverythingMoe novel parsers', () => {
  it('Wuxia Dreams: search, paginated chapters, chapter text', () => {
    const hits = wdSearch('<a href="/novel/shadow-slave"><span>completed</span><h3>Shadow Slave</h3><img src="https://cdn.wuxiadreams.com/c.png"/></a>');
    expect(hits).toEqual([{ title: 'Shadow Slave', url: 'https://wuxiadreams.com/novel/shadow-slave', cover: 'https://cdn.wuxiadreams.com/c.png' }]);
    const s = wdSeries('<h1>Shadow Slave</h1><a href="/novel/shadow-slave/chapter-1">Chapter 1 Nightmare Begins</a><a href="?page=3">3</a>', 'https://wuxiadreams.com/novel/shadow-slave');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1 Nightmare Begins', url: 'https://wuxiadreams.com/novel/shadow-slave/chapter-1' }]);
    expect(wdChapters('<a href="?page=3">3</a>').maxPage).toBe(3);
    const ch = wdText('<h1>Chapter 1</h1><article class="chapter-content-container"><p>Darkness.</p><div class="ads">ad</div></article>', 'Ch 1');
    expect(ch).toEqual({ title: 'Chapter 1', html: '<p>Darkness.</p>' });
  });

  it('Novel Phoenix: search, paginated chapters, chapter text', () => {
    const hits = npSearch('<div class="novel-item"><a href="/novel/shadow-slave"><h3>Shadow Slave</h3><img data-src="https://novelphoenix.com/c.jpg"/></a></div>');
    expect(hits).toEqual([{ title: 'Shadow Slave', url: 'https://novelphoenix.com/novel/shadow-slave', cover: 'https://novelphoenix.com/c.jpg' }]);
    const s = npSeries('<h1>Shadow Slave</h1>', 'https://novelphoenix.com/novel/shadow-slave', '<a href="/novel/shadow-slave/chapter-2">Chapter 2</a><a href="?page=5">5</a>');
    expect(s.chapters).toEqual([{ number: 2, label: 'Chapter 2', url: 'https://novelphoenix.com/novel/shadow-slave/chapter-2' }]);
    expect(npChapters('<a href="?page=5">5</a>').maxPage).toBe(5);
    expect(npText('<h1>Ch 2</h1><div id="content"><p>Line</p></div>', 'Ch 2')).toEqual({ title: 'Ch 2', html: '<p>Line</p>' });
  });

  it('NovelsTime: search, series chapters, chapter text', () => {
    const hits = ntSearch('<div><div><img src="https://img.test/a.jpg"/></div><a href="/novel/the-protagonist-system_24549">The Protagonist System</a></div>');
    expect(hits[0]).toMatchObject({ title: 'The Protagonist System', url: 'https://www.novelstime.com/novel/the-protagonist-system_24549' });
    const s = ntSeries('<h1>The Protagonist System</h1><a href="/novel/the-protagonist-system_24549/01-loading_12615876">Ch 1</a>', 'https://www.novelstime.com/novel/the-protagonist-system_24549');
    expect(s.chapters).toEqual([{ number: 1, label: 'Ch 1', url: 'https://www.novelstime.com/novel/the-protagonist-system_24549/01-loading_12615876' }]);
    expect(ntText('<h2>Loading</h2><div class="prose max-w-none"><p>Booting...</p></div>', 'Ch 1')).toEqual({ title: 'Loading', html: '<p>Booting...</p>' });
  });

  it('Requiem Translations: search, episode list, chapter text', () => {
    const hits = rqSearch('<div class="series-row"><a href="/series/dragonica"><h3>Dragonica</h3></a></div>');
    expect(hits).toEqual([{ title: 'Dragonica', url: 'https://requiemtls.com/series/dragonica', cover: undefined }]);
    const s = rqSeries('<h1>Dragonica</h1><a href="/dragonica-episode-12">Episode 12</a>', 'https://requiemtls.com/series/dragonica');
    expect(s.chapters).toEqual([{ number: 12, label: 'Episode 12', url: 'https://requiemtls.com/dragonica-episode-12' }]);
    expect(rqText('<div class="reader-prose"><p>Roar.</p></div>', 'Episode 12')).toEqual({ title: 'Episode 12', html: '<p>Roar.</p>' });
  });

  it('WuxiaClick: Next.js __NEXT_DATA__ series & chapter paragraphs', () => {
    const seriesHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          novel: { slug: 'remarried-empress', title: 'Remarried Empress', altTitles: ['재혼 황후'], description: 'Desc', coverOriginal: 'https://img.test/re.jpg' },
          toc: { items: [{ number: 1, title: 'Ch 1' }], ranges: [{ page: 1, from: 1, to: 100 }, { page: 2, from: 101, to: 200 }] },
        },
      },
    })}</script>`;
    const { series, pages } = wcSeries(seriesHtml, 'https://wuxia.click/novel/remarried-empress');
    expect(series.title).toBe('Remarried Empress');
    expect(series.altTitles).toEqual(['재혼 황후']);
    expect(pages).toEqual([2]);
    expect(series.chapters).toEqual([{ number: 1, label: 'Ch 1', url: 'https://wuxia.click/chapter/remarried-empress-1' }]);

    const chHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { data: { chapter: { title: 'Ch 1', paragraphs: ['First & <second>.'] } } } },
    })}</script>`;
    expect(wcText(chHtml, 'Ch 1')).toEqual({ title: 'Ch 1', html: '<p>First &amp; &lt;second&gt;.</p>' });
  });

  it('lightnovel.to: search, total-count series, chapter text', () => {
    const hits = lnToSearch('<a href="/novel/shadow-hack"><h3>Shadow Hack</h3><img src="https://lightnovel.to/c.webp"/></a>');
    expect(hits).toEqual([{ title: 'Shadow Hack', url: 'https://lightnovel.to/novel/shadow-hack', cover: 'https://lightnovel.to/c.webp' }]);
    const s = lnToSeries('<h1>Shadow Hack</h1><script>self.__next_f.push([1,"{\\"total\\":3,\\"novelSlug\\":\\"shadow-hack\\"}"])</script>', 'https://lightnovel.to/novel/shadow-hack');
    expect(s.chapters).toHaveLength(3);
    expect(s.chapters[2]).toEqual({ number: 3, label: 'Chapter 3', url: 'https://lightnovel.to/novel/shadow-hack/chapter-3' });
    expect(lnToText('<h1>Ch 3</h1><div class="ln-prose"><p>Body</p></div>', 'Ch 3')).toEqual({ title: 'Ch 3', html: '<p>Body</p>' });
  });

  it('LNMTL: volumes script, series metadata, translated sentences', () => {
    const vols = lnmtlVolumes('<script>lnmtl.volumes = [{"id":10,"number":1}];</script>');
    expect(vols).toEqual([{ id: 10, number: 1 }]);
    const s = lnmtlSeries('<span class="novel-name">Rebuking Winds</span>', 'https://lnmtl.com/novel/rebuking', [{ number: 1, label: 'Ch 1', url: 'https://lnmtl.com/chapter/1' }]);
    expect(s.title).toBe('Rebuking Winds');
    expect(lnmtlText('<h1 class="chapter-title">#1: Start</h1><div class="chapter-body"><sentence class="translated">Hello.</sentence><sentence class="original">你好。</sentence></div>', 'Ch 1')).toEqual({
      title: '#1: Start',
      html: '<p>Hello.</p>',
    });
  });

  it('Novgo: search, paginated chapters, chapter text', () => {
    const hits = ngSearch('<div class="row"><a href="/shadow-slave.html" title="Shadow Slave">Shadow Slave</a><img src="/uploads/c.jpg"/></div>');
    expect(hits).toEqual([{ title: 'Shadow Slave', url: 'https://novgo.net/shadow-slave.html', cover: 'https://novgo.net/uploads/c.jpg' }]);
    const s = ngSeries('<h3 class="title">Shadow Slave</h3><a href="/shadow-slave/chapter-1-nightmare.html">Chapter 1</a><a href="?page=4">4</a>', 'https://novgo.net/shadow-slave.html');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://novgo.net/shadow-slave/chapter-1-nightmare.html' }]);
    expect(ngChapters('<a href="?page=4">4</a>', 'shadow-slave').maxPage).toBe(4);
    expect(ngText('<span class="chr-text">Ch 1</span><div id="chapter-content"><p>Text</p></div>', 'Ch 1')).toEqual({ title: 'Ch 1', html: '<p>Text</p>' });
  });
});
