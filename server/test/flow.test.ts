import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceChapter } from '@atsusync/shared';
import { buildApp } from '../src/app.ts';
import { events } from '../src/events.ts';
import type { SourceAdapter } from '../src/sources/types.ts';

// PNG signature followed by filler, so it passes the image check.
const PAGE = new Uint8Array(4096).fill(7);
PAGE.set([0x89, 0x50, 0x4e, 0x47]);

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

function setup(opts: { failImages?: boolean; extra?: SourceAdapter[] } = {}) {
  const chapters = { current: [ch(1), ch(2)] };
  const atsuCalls: { method: string; url: string; body?: any }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://fake.test/img/') || url.startsWith('https://other.test/img/')) return opts.failImages ? new Response('nope', { status: 404 }) : new Response(PAGE);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    atsuCalls.push({ method, url, body });
    const path = new URL(url).pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (path === '/api/uploads/series')
      return json({ series: { mangaId: null, mangaBakaId: '1', title: 'Heart Aching' }, coverage: { out: [], waiting: [], total: 0 }, sources: [], elsewhere: [] });
    return json({});
  }) as unknown as typeof fetch;

  const ctx = buildApp({ dbFile: ':memory:', downloadsDir: mkdtempSync(join(tmpdir(), 'atsusync-')), adapters: [fakeAdapter(chapters), ...(opts.extra ?? [])], fetchImpl, background: false });
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

  it('downloads a chapter from another site onto a link without linking that site', async () => {
    const other: SourceAdapter = {
      id: 'other',
      name: 'Other Scans',
      baseUrl: 'https://other.test',
      kind: 'aggregator',
      hosts: ['other.test'],
      rateLimit: { rpm: 6000, concurrency: 4 },
      getSeries: async (url) => ({ title: 'Heart Aching', url, altTitles: [], chapters: [{ number: 2, label: 'Chapter 2', url: 'https://other.test/heart-2', locked: false }] }),
      getChapterPages: async (c) => [{ url: `https://other.test/img/${c.number}/1.webp`, name: '001.webp' }],
    };
    const t = setup({ extra: [other] });
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });

    const res = await t.app.inject({ method: 'POST', url: `/api/links/${link.id}/fetch-from`, payload: { url: 'https://other.test/s/heart', numbers: [2] } });
    expect(res.statusCode).toBe(200);
    const [job] = await waitForJobs(t.pipeline);

    expect(job).toMatchObject({ state: 'done', total: 1, sourceName: 'Fake Scans' });
    const c2 = t.links.chapters(link.id).find((c) => c.number === 2)!;
    expect(c2).toMatchObject({ url: 'https://fake.test/s/heart/2', state: 'downloaded' }); // row stays on the linked site
    expect(job!.log.join(' ')).toContain('from Other Scans');
    expect(t.links.list()).toHaveLength(1);

    const bad = await t.app.inject({ method: 'POST', url: `/api/links/${link.id}/fetch-from`, payload: { url: 'https://other.test/s/heart', numbers: [99] } });
    expect(bad.statusCode).toBe(400);
  });

  it('clearing a link deletes finished jobs and ZIPs and makes chapters downloadable again', async () => {
    const t = setup();
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    const [c1, c2] = t.links.chapters(link.id);

    t.pipeline.enqueue([c1!.id, c2!.id]);
    const jobs = await waitForJobs(t.pipeline);
    const files = jobs.map((j) => t.pipeline.file(j.id)!.path);
    t.links.setChapterState([c2!.id], 'uploaded');

    expect(t.pipeline.clear(link.id)).toEqual({ jobs: 2, files: 2 });
    expect(t.pipeline.list({ linkId: link.id })).toEqual([]);
    expect(files.every((f) => !existsSync(f))).toBe(true);
    expect(t.links.chapters(link.id).map((c) => c.state)).toEqual(['known', 'uploaded']);
  });

  it('builds a chapter from uploaded images: preview, strip joining, ZIP, and clean-up', async () => {
    const t = setup();
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    const jpg = (h: number) => sharp({ create: { width: 800, height: h, channels: 3, background: '#999' } }).jpeg().toBuffer();
    const json = (r: { payload: string }) => JSON.parse(r.payload);

    const draft = json(await t.app.inject({ method: 'POST', url: '/api/manual/drafts' }));
    // Uploaded out of order on purpose; "sortByName" puts them right.
    for (const [name, h] of [['p3.jpg', 1000], ['p1.jpg', 1067], ['p2.jpg', 65]] as const) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/manual/drafts/${draft.id}/pages?name=${name}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: await jpg(h),
      });
      expect(res.statusCode).toBe(200);
    }
    const bad = await t.app.inject({ method: 'POST', url: `/api/manual/drafts/${draft.id}/pages?name=x.jpg`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('not an image at all, just text') });
    expect(bad.statusCode).toBe(400);

    const sorted = json(await t.app.inject({ method: 'PUT', url: `/api/manual/drafts/${draft.id}`, payload: { sortByName: true } }));
    expect(sorted.pages.map((p: { name: string }) => p.name)).toEqual(['p1.jpg', 'p2.jpg', 'p3.jpg']);

    const preview = json(await t.app.inject({ method: 'GET', url: `/api/manual/drafts/${draft.id}/preview` }));
    expect(preview.map((p: { height: number; parts: number }) => [p.height, p.parts])).toEqual([[1132, 2], [1000, 1]]);
    const raw = json(await t.app.inject({ method: 'GET', url: `/api/manual/drafts/${draft.id}/preview?autoJoin=0` }));
    expect(raw).toHaveLength(3);
    const img = await t.app.inject({ method: 'GET', url: `/api/manual/drafts/${draft.id}/preview/0` });
    expect(img.headers['content-type']).toBe('image/jpeg');

    const job = json(await t.app.inject({ method: 'POST', url: `/api/manual/drafts/${draft.id}/commit`, payload: { linkId: link.id, number: 3.5, label: 'Chapter 3.5 - Extra' } }));
    expect(job).toMatchObject({ state: 'done', total: 2, chapterLabel: 'Chapter 3.5 - Extra', uploadUrl: 'https://atsu.moe/upload?mb=1' });
    const added = t.links.chapters(link.id).find((c) => c.number === 3.5)!;
    expect(added).toMatchObject({ label: 'Chapter 3.5 - Extra', state: 'downloaded', locked: false });
    expect(t.pipeline.file(job.id)!.name).toBe('Heart Aching - Chapter 3.5 - Extra.zip');
    expect((await t.app.inject({ method: 'GET', url: `/api/manual/drafts/${draft.id}` })).statusCode).toBe(404);
    expect(() => t.pipeline.enqueue([added.id])).toThrow(/added by hand/);

    // Clearing removes the hand-built chapter entirely, since it can't be re-fetched.
    t.pipeline.clear(link.id);
    expect(t.links.chapters(link.id).some((c) => c.number === 3.5)).toBe(false);
  });

  it('announces a paid chapter only once it goes free', async () => {
    const t = setup();
    close = () => t.app.close();
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    const seen: string[] = [];
    const off = events.onEvent((e) => e.type !== 'job' && e.type !== 'requests_synced' && seen.push(`${e.type}:${e.labels.join(',')}`));

    t.chapters.current = [ch(1), ch(2), ch(3, true)];
    expect(await t.watcher.check(t.links.get(link.id)!)).toHaveLength(0);
    expect(seen).toEqual([]);
    expect(t.links.chapters(link.id).find((c) => c.number === 3)).toMatchObject({ locked: true, state: 'pending' });

    t.chapters.current = [ch(1), ch(2), ch(3)];
    await t.watcher.check(t.links.get(link.id)!);
    off();
    expect(seen).toEqual(['chapters_unlocked:Chapter 3']);
    expect(t.links.chapters(link.id).find((c) => c.number === 3)).toMatchObject({ locked: false, state: 'pending' });
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
