import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { buildChapters, groupSeries, nyaa, nyaaNovel, parseChapterUrl, parseRelease, parseRss, releaseUrl, type NyaaItem } from '../src/sources/adapters/nyaa.ts';
import { SourceHttp } from '../src/sources/http.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { FakeTorrentClient, magnetFor } from '../src/sources/torrent.ts';
import { buildChapter, chapterNumberIn, pickChapterFiles } from '../src/sources/torrentpack.ts';
import { matchesUrl, mediumOf } from '../src/sources/types.ts';
import { openDb } from '../src/db/client.ts';
import { createZip } from '../src/upload/zip.ts';
import { normalizeTitle } from '../src/sources/match.ts';

const hash = (n: number) => n.toString(16).padStart(40, '0');
const item = (id: number, title: string, seeders = 5, trusted = false): NyaaItem => ({ id: String(id), title, infoHash: hash(id), seeders, leechers: 0, size: '8 MiB', date: 'Fri, 30 Oct 2026 15:37:05 -0000', trusted });

const RSS = `<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel>
<item><title>One Piece 1197</title><guid isPermaLink="true">https://nyaa.si/view/2180362</guid><pubDate>Fri, 30 Oct 2026 15:37:05 -0000</pubDate>
<nyaa:seeders>49</nyaa:seeders><nyaa:leechers>2</nyaa:leechers><nyaa:infoHash>6506A47A152E85AAECA04865557873AF38F895F3</nyaa:infoHash><nyaa:size>8.0 MiB</nyaa:size><nyaa:trusted>No</nyaa:trusted></item>
<item><title>broken</title><guid isPermaLink="true">https://nyaa.si/view/1</guid><nyaa:infoHash>nothex</nyaa:infoHash></item>
</channel></rss>`;

describe('Nyaa release titles', () => {
  it.each([
    ['One Piece 1197', { series: 'One Piece', kind: 'chapter', from: 1197, to: 1197 }],
    ['BanG Dream! Arale 003 (2026) (Digital)', { series: 'BanG Dream! Arale', kind: 'chapter', from: 3, to: 3 }],
    ['Solo Leveling - Chapter 12.5 (Scanlation) (Group)', { series: 'Solo Leveling', kind: 'chapter', from: 12.5, to: 12.5 }],
    ['Tower of God c001-050 (Scanlation)', { series: 'Tower of God', kind: 'chapter', from: 1, to: 50 }],
    ['Nighthawk Returns v01-03 (2026) (Scanlation) (Morgan)', { series: 'Nighthawk Returns', kind: 'volume', from: 1, to: 3 }],
    ['Black Cat (2006-2009) (Digital) (Rillant) (f)', { series: 'Black Cat', kind: 'none' }],
    ['Some Series 2024', { series: 'Some Series 2024', kind: 'none' }],
  ])('parses %s', (title, want) => {
    expect(parseRelease(title)).toMatchObject(want);
  });

  it('tells novels, comics and audiobooks apart', () => {
    expect(parseRelease('A Tale of the Secret Saint ZERO v01-06 [Seven Seas] [Stick]').novel).toBe(true);
    expect(parseRelease('Mushoku Tensei Light Novel v01').novel).toBe(true);
    expect(parseRelease('Nighthawk Returns v01-03 (2026) (Scanlation) (Morgan)').novel).toBe(false);
    expect(parseRelease('Series v01 [Audiobook] [Seven Seas Siren]').audiobook).toBe(true);
  });

  it('takes the last real tag as the release group', () => {
    expect(parseRelease('One Piece 1197 (2026) (Digital) (Rillant)').group).toBe('Rillant');
    expect(parseRelease('One Piece 1197').group).toBeNull();
  });
});

describe('Nyaa series building', () => {
  it('reads the RSS feed, dropping items without a valid info hash', () => {
    const items = parseRss(RSS);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: '2180362', title: 'One Piece 1197', seeders: 49, infoHash: '6506a47a152e85aaeca04865557873af38f895f3' });
  });

  it('round-trips the torrent and chapter number through the chapter URL', () => {
    const i = item(7, 'Series c001-003');
    expect(parseChapterUrl(releaseUrl(i, 2))).toEqual({ infoHash: hash(7), name: 'Series c001-003', chapter: 2 });
    expect(parseChapterUrl(releaseUrl(i, null)).chapter).toBeNull();
    expect(() => parseChapterUrl('https://nyaa.si/view/1')).toThrow(/no torrent/);
  });

  it('expands packs into chapters and keeps the best-seeded single release', () => {
    const items = [
      item(1, 'Tower of God c001-003 (Scanlation)', 40),
      item(2, 'Tower of God 002 (Scanlation) (GroupA)', 3),
      item(3, 'Tower of God 002 (Scanlation) (GroupB)', 9),
      item(4, 'Tower of God 004', 1),
      item(5, 'Tower of God Ragnarok 001', 1), // a different series
    ];
    const { chapters } = buildChapters(items, normalizeTitle('Tower of God'), 'comic');
    expect(chapters.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    const two = chapters[1]!;
    expect(parseChapterUrl(two.url).infoHash).toBe(hash(3)); // single + most seeders beats the pack
    expect(two.group).toBe('GroupB');
    expect(two.alternatives).toHaveLength(2);
    expect(parseChapterUrl(chapters[0]!.url)).toMatchObject({ infoHash: hash(1), chapter: 1 });
  });

  it('explains a comic that only has volume torrents; novels use volumes as chapters', () => {
    const items = [item(1, 'Nighthawk Returns v01-03 (2026) (Scanlation)'), item(2, 'Nighthawk Returns v04 (2026) (Scanlation)')];
    expect(buildChapters(items, normalizeTitle('Nighthawk Returns'), 'comic')).toMatchObject({ chapters: [], emptyReason: expect.stringMatching(/volume/) });
    const novels = [item(3, 'Secret Saint v01-02 [Seven Seas] [Stick]'), item(4, 'Secret Saint v03 [Seven Seas]')];
    const { chapters } = buildChapters(novels, normalizeTitle('Secret Saint'), 'novel');
    expect(chapters.map((c) => c.label)).toEqual(['Volume 1', 'Volume 2', 'Volume 3']);
  });

  it('groups search results per series and per medium', () => {
    const items = [item(1, 'Solo Leveling 001'), item(2, 'Solo Leveling 002'), item(3, 'Solo Leveling Ragnarok 001'), item(4, 'Solo Leveling v01 [Yen Press]')];
    expect(groupSeries(items, 'comic').map((h) => h.title)).toEqual(['Solo Leveling', 'Solo Leveling Ragnarok']);
    expect(groupSeries(items, 'novel').map((h) => h.title)).toEqual(['Solo Leveling']);
  });

  it('is registered as torrent sources: comic and novel', () => {
    const reg = new SourceRegistry(openDb(':memory:'));
    expect(reg.find('nyaa')).toBe(nyaa);
    expect(reg.find('nyaa-novel')).toBe(nyaaNovel);
    expect([nyaa.kind, nyaaNovel.kind]).toEqual(['torrent', 'torrent']);
    expect([mediumOf(nyaa), mediumOf(nyaaNovel)]).toEqual(['comic', 'novel']);
    expect(matchesUrl(nyaa, 'https://nyaa.si/view/123')).toBe(true);
    expect(reg.info().find((s) => s.id === 'nyaa')).toMatchObject({ kind: 'torrent', searchable: true });
  });

  it('searches and lists chapters through the RSS feed', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      return new Response(RSS, { status: 200 });
    };
    const http = new SourceHttp(fake, false);
    const hits = await nyaa.search!('one piece', http);
    expect(hits).toEqual([{ title: 'One Piece', url: 'https://nyaa.si/?c=3_1&q=One%20Piece' }]);
    expect(calls[0]).toContain('page=rss');
    expect(calls[0]).toContain('c=3_1');
    const s = await nyaa.getSeries(hits[0]!.url, http);
    expect(s.chapters.map((c) => c.number)).toEqual([1197]);
  });
});

describe('torrent file handling', () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, length: 100 }));

  it('reads chapter numbers from names', () => {
    expect(chapterNumberIn('Series c012 (Digital)')).toBe(12);
    expect(chapterNumberIn('Chapter 12.5')).toBe(12.5);
    expect(chapterNumberIn('Series 045 (Digital)')).toBe(45);
    expect(chapterNumberIn('Series v02')).toBe(2);
    expect(chapterNumberIn('cover')).toBeNull();
  });

  it('picks only the files of the wanted chapter from a pack, and everything from a single release', () => {
    const pack = files('Pack/Series c001.cbz', 'Pack/Series c002.cbz', 'Pack/Series c003.cbz', 'Pack/readme.txt');
    expect(pickChapterFiles(pack, 2)).toEqual([1]);
    expect(pickChapterFiles(pack, 9)).toEqual([]);
    expect(pickChapterFiles(pack, null)).toEqual([0, 1, 2]);
    const folders = files('Pack/Chapter 1/001.jpg', 'Pack/Chapter 1/002.jpg', 'Pack/Chapter 2/001.jpg');
    expect(pickChapterFiles(folders, 1)).toEqual([0, 1]);
    // a single archive named oddly is still "the" chapter
    expect(pickChapterFiles(files('release.cbz'), 5)).toEqual([0]);
  });

  const dir = mkdtempSync(join(tmpdir(), 'atsusync-pack-'));
  const put = (name: string, data: Uint8Array) => {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data);
    return p;
  };

  it('repacks a CBZ into numbered pages in natural order, ignoring junk', () => {
    const cbz = createZip([
      { name: '10.jpg', bytes: new Uint8Array([1, 1]) },
      { name: '2.png', bytes: new Uint8Array([2, 2]) },
      { name: '1.jpg', bytes: new Uint8Array([3, 3]) },
      { name: '__MACOSX/1.jpg', bytes: new Uint8Array([9]) },
      { name: 'ComicInfo.xml', bytes: new Uint8Array([9]) },
    ]);
    const out = buildChapter([{ path: 'x.cbz', diskPath: put('x.cbz', cbz) }]);
    expect(out.type).toBe('pages');
    if (out.type !== 'pages') return;
    expect(out.files.map((f) => f.name)).toEqual(['001.jpg', '002.png', '003.jpg']);
    expect(out.files.map((f) => f.bytes[0])).toEqual([3, 2, 1]);
  });

  it('hands back an ebook as-is and explains RAR archives', () => {
    const epub = new Uint8Array(100).fill(5);
    expect(buildChapter([{ path: 'a/v01.epub', diskPath: put('a/v01.epub', epub) }])).toMatchObject({ type: 'ebook', ext: 'epub' });
    expect(() => buildChapter([{ path: 'a.cbr', diskPath: put('a.cbr', epub) }])).toThrow(/CBR/);
    expect(() => buildChapter([{ path: 'notes.nfo', diskPath: put('notes.nfo', epub) }])).toThrow(/no images/);
  });

  it('builds a magnet carrying the info hash and trackers', () => {
    const m = magnetFor({ infoHash: hash(1), name: 'A B' });
    expect(m).toContain(`xt=urn:btih:${hash(1)}`);
    expect(m).toContain('dn=A%20B');
    expect(m).toContain('&tr=');
  });
});

describe('torrent source in the download pipeline', () => {
  let close: (() => Promise<unknown>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('downloads a chapter from a torrent into a ZIP and releases the torrent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-t-'));
    const page = (n: number) => {
      const b = new Uint8Array(4096).fill(n);
      b.set([0x89, 0x50, 0x4e, 0x47]);
      return b;
    };
    const cbzPath = join(dir, 'One Piece 1197.cbz');
    writeFileSync(cbzPath, createZip([{ name: '01.png', bytes: page(1) }, { name: '02.png', bytes: page(2) }]));
    const torrents = new FakeTorrentClient(() => [{ path: 'One Piece 1197.cbz', diskPath: cbzPath }]);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('page=rss')) return new Response(`<rss xmlns:nyaa="x"><channel><item><title>One Piece 1197</title><guid>https://nyaa.si/view/9</guid><nyaa:infoHash>${hash(9)}</nyaa:infoHash><nyaa:seeders>4</nyaa:seeders></item></channel></rss>`);
      return new Response('{}');
    }) as unknown as typeof fetch;
    const ctx = buildApp({ dbFile: ':memory:', downloadsDir: join(dir, 'dl'), adapters: [{ ...nyaa, rateLimit: { rpm: 6000, concurrency: 4 } }], fetchImpl, torrents, background: false });
    close = () => ctx.app.close();
    ctx.requests.upsertPost({ id: 'R', forumId: 'f', title: 'One Piece', content: '', commentCount: 0, score: 0, pinned: false, locked: false, removed: false, createdAt: Date.now(), tags: [] });

    const link = await ctx.links.create({ requestId: 'R', sourceId: 'nyaa', seriesUrl: 'https://nyaa.si/?c=3_1&q=One%20Piece', checkIntervalMin: 60 });
    const chapters = ctx.links.chapters(link.id);
    expect(chapters.map((c) => c.number)).toEqual([1197]);
    ctx.pipeline.enqueue([chapters[0]!.id]);
    let job = ctx.pipeline.list()[0]!;
    for (let i = 0; i < 500 && !['done', 'failed'].includes(job.state); i++) {
      await new Promise((r) => setTimeout(r, 10));
      job = ctx.pipeline.list()[0]!;
    }
    expect(job).toMatchObject({ state: 'done', sourceName: 'Nyaa (manga / manhwa / manhua)' });
    const file = ctx.pipeline.file(job.id)!;
    expect(file.name).toBe('One Piece - Chapter 1197.zip');
    expect(readFileSync(file.path).includes(Buffer.from('001.png'))).toBe(true);
    expect(torrents.released).toEqual([hash(9)]);
    expect(ctx.links.chapters(link.id)[0]!.state).toBe('downloaded');
  });
});
