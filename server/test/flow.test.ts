import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceChapter } from '@atsusync/shared';
import { buildApp } from '../src/app.ts';
import type { SourceAdapter } from '../src/sources/types.ts';

const PAGE = new Uint8Array(4096).fill(7);

function fakeAdapter(chapters: { current: SourceChapter[] }): SourceAdapter {
  return {
    id: 'fake',
    name: 'Fake Scans',
    baseUrl: 'https://fake.test',
    kind: 'aggregator',
    hosts: ['fake.test'],
    rateLimit: { rpm: 6000, concurrency: 4 },
    search: async () => [{ title: 'Heart Aching', url: 'https://fake.test/s/heart' }],
    getSeries: async (url) => ({ title: 'Heart Aching', url, altTitles: [], chapters: chapters.current }),
    getChapterPages: async (ch) => [
      { url: `https://fake.test/img/${ch.number}/1.webp`, name: '001.webp' },
      { url: `https://fake.test/img/${ch.number}/2.webp`, name: '002.webp' },
    ],
  };
}

const ch = (n: number, locked = false): SourceChapter => ({ number: n, label: `Chapter ${n}`, url: `https://fake.test/s/heart/${n}`, locked });

function setup(opts: { failImages?: boolean } = {}) {
  const chapters = { current: [ch(1), ch(2)] };
  const atsuCalls: { method: string; url: string; body?: any }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://fake.test/img/')) return opts.failImages ? new Response('nope', { status: 404 }) : new Response(PAGE);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    atsuCalls.push({ method, url, body });
    const path = new URL(url).pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (path === '/api/uploads/series')
      return json({ series: { mangaId: null, mangaBakaId: '1', title: 'Heart Aching' }, coverage: { out: [], waiting: [], total: 0 }, sources: [], elsewhere: [] });
    return json({});
  }) as unknown as typeof fetch;

  const ctx = buildApp({ dbFile: ':memory:', downloadsDir: mkdtempSync(join(tmpdir(), 'atsusync-')), adapters: [fakeAdapter(chapters)], fetchImpl, background: false });
  ctx.requests.upsertPost({
    id: 'REQ1',
    forumId: 'f',
    title: 'Heart Aching',
    content: 'tracker: https://mangabaka.org/manhwa/1/Heart',
    commentCount: 0,
    score: 0,
    pinned: false,
    locked: false,
    removed: false,
    createdAt: Date.now(),
    tags: [],
  });
  return { ...ctx, chapters, atsuCalls };
}

async function waitForJobs(pipeline: ReturnType<typeof setup>['pipeline']) {
  for (let i = 0; i < 1000; i++) {
    if (pipeline.list().every((j) => ['done', 'failed', 'cancelled'].includes(j.state))) return pipeline.list();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('jobs did not finish');
}

let close: (() => Promise<unknown>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe('watcher', () => {
  it('records chapters released after linking as pending, once', async () => {
    const t = setup();
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    expect(t.links.chapters(link.id).map((c) => c.state)).toEqual(['known', 'known']);

    t.chapters.current = [ch(1), ch(2), ch(3)];
    expect(await t.watcher.check(t.links.get(link.id)!)).toHaveLength(1);
    expect(await t.watcher.check(t.links.get(link.id)!)).toHaveLength(0);

    const states = t.links.chapters(link.id).map((c) => [c.number, c.state]);
    expect(states).toEqual([
      [1, 'known'],
      [2, 'known'],
      [3, 'pending'],
    ]);
    expect(t.links.get(link.id)!.pendingCount).toBe(1);
  });
});

describe('download pipeline', () => {
  it('bundles a chapter into a ZIP, marks it downloaded and never calls Atsumaru', async () => {
    const t = setup();
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    const [c1] = t.links.chapters(link.id);

    t.pipeline.enqueue([c1!.id]);
    const [job] = await waitForJobs(t.pipeline);

    expect(job).toMatchObject({ state: 'done', progress: 2, total: 2, uploadUrl: 'https://atsu.moe/upload?mb=1' });
    expect(job!.fileSize).toBeGreaterThan(2 * PAGE.length);
    expect(t.atsuCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(t.links.chapters(link.id)[0]!.state).toBe('downloaded');

    const file = t.pipeline.file(job!.id)!;
    expect(file.name).toBe('Heart Aching - Chapter 1.zip');
    const zip = readFileSync(file.path);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(2); // entries in the end-of-central-directory record
    expect(zip.includes(Buffer.from('001.webp'))).toBe(true);
    expect(zip.includes(Buffer.from('002.webp'))).toBe(true);
  });

  it('a failed download restores the chapter state', async () => {
    const t = setup({ failImages: true });
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    t.chapters.current = [ch(1), ch(2), ch(3)];
    await t.watcher.check(t.links.get(link.id)!);
    const pending = t.links.chapters(link.id).find((c) => c.state === 'pending')!;

    t.pipeline.enqueue([pending.id]);
    const [job] = await waitForJobs(t.pipeline);

    expect(job!.state).toBe('failed');
    expect(t.pipeline.file(job!.id)).toBeNull();
    expect(t.links.chapters(link.id).find((c) => c.id === pending.id)!.state).toBe('pending');
  });

  it('refuses locked chapters', async () => {
    const t = setup();
    close = () => t.app.close();
    t.chapters.current = [ch(1), ch(2, true)];
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    expect(() => t.pipeline.enqueue([t.links.chapters(link.id)[1]!.id])).toThrow(/locked/);
  });
});

describe('discovery', () => {
  it('hides sites that know the series but have no chapters to upload', async () => {
    const t = setup();
    close = () => t.app.close();
    t.chapters.current = [];
    const req = t.requests.get('REQ1')!;
    expect(await t.discovery.find(req)).toEqual([]);
    await expect(t.discovery.addByUrl(req, 'https://fake.test/s/heart')).rejects.toThrow(/no chapters to upload/);
    t.chapters.current = [ch(1)];
    expect((await t.discovery.find(req)).map((m) => m.chapterCount)).toEqual([1]);
  });
});
