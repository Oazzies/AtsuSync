import { createHash } from 'node:crypto';
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

function setup(opts: { submitStatus?: string | null } = {}) {
  const chapters = { current: [ch(1), ch(2)] };
  const atsuCalls: { method: string; url: string; body?: any }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://fake.test/img/')) return new Response(PAGE);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    atsuCalls.push({ method, url, body });
    const path = new URL(url).pathname;
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (path === '/api/uploads/series')
      return json({ series: { mangaId: null, mangaBakaId: '1', title: 'Heart Aching' }, coverage: { out: [], waiting: [], total: 0 }, sources: [], elsewhere: [] });
    if (method === 'POST' && path === '/api/uploads/sources') return json({ source: { id: 'S1' } });
    if (method === 'POST' && path === '/api/uploads/drafts') return json({ draft: { id: body.id } });
    if (method === 'POST' && path === '/api/uploads/drafts/submit')
      return json({ results: [{ id: body.ids[0], status: opts.submitStatus === undefined ? 'Pending' : opts.submitStatus, message: 'Chapter 3 already exists' }] });
    return json({});
  }) as unknown as typeof fetch;

  const ctx = buildApp({ dbFile: ':memory:', adapters: [fakeAdapter(chapters)], fetchImpl, background: false });
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
  for (let i = 0; i < 200; i++) {
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

describe('upload pipeline', () => {
  it('dry run downloads and hashes pages but makes no Atsumaru write calls', async () => {
    const t = setup();
    close = () => t.app.close();
    t.settings.update({ dryRun: true });
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    const [c1] = t.links.chapters(link.id);

    t.pipeline.enqueue([c1!.id]);
    const [job] = await waitForJobs(t.pipeline);

    expect(job).toMatchObject({ state: 'done', dryRun: true, progress: 2, total: 2 });
    expect(t.atsuCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(t.links.chapters(link.id)[0]!.state).toBe('known');
  });

  it('real upload creates source + draft, PUTs each page by sha256, then submits', async () => {
    const t = setup();
    close = () => t.app.close();
    t.settings.update({ dryRun: false });
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });

    t.pipeline.enqueue([t.links.chapters(link.id)[1]!.id]);
    const [job] = await waitForJobs(t.pipeline);

    const sha = createHash('sha256').update(PAGE).digest('hex');
    expect(job!.state).toBe('done');
    const writes = t.atsuCalls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/uploads/sources',
      'POST /api/uploads/drafts',
      `PUT /api/uploads/${writes[1]!.body.id}/pages/${sha}`,
      'POST /api/uploads/drafts/submit',
    ]);
    expect(writes[0]!.body).toMatchObject({ groupId: null, mangaBakaId: '1' });
    // Both fake pages are identical, so they collapse to one sha in pageOrder.
    expect(writes[1]!.body).toMatchObject({ sourceId: 'S1', number: 2, title: null, pageOrder: [sha], replaceChapterId: null });
    expect(writes[3]!.body).toEqual({ ids: [writes[1]!.body.id] });
    expect(t.links.chapters(link.id)[1]!.state).toBe('uploaded');
  });

  it('a rejected submit fails the job, deletes the draft and restores chapter state', async () => {
    const t = setup({ submitStatus: null });
    close = () => t.app.close();
    t.settings.update({ dryRun: false });
    const link = await t.links.create({ requestId: 'REQ1', sourceId: 'fake', seriesUrl: 'https://fake.test/s/heart', checkIntervalMin: 60 });
    t.chapters.current = [ch(1), ch(2), ch(3)];
    await t.watcher.check(t.links.get(link.id)!);
    const pending = t.links.chapters(link.id).find((c) => c.state === 'pending')!;

    t.pipeline.enqueue([pending.id]);
    const [job] = await waitForJobs(t.pipeline);

    expect(job!.state).toBe('failed');
    expect(job!.error).toMatch(/already exists/);
    expect(t.atsuCalls.at(-1)).toMatchObject({ method: 'DELETE' });
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
