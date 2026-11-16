import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.ts';
import { RequestsRepo } from '../src/atsu/requests.ts';
import { Discovery, matchesSourceFilter } from '../src/sources/discovery.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import type { SourceAdapter } from '../src/sources/types.ts';
import { SourceHttp } from '../src/sources/http.ts';

function fakeAdapter(
  id: string,
  kind: SourceAdapter['kind'],
  nsfw = false,
  searched?: string[],
): SourceAdapter {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example`,
    kind,
    nsfw,
    hosts: [`${id}.example`],
    rateLimit: { rpm: 60, concurrency: 2 },
    async search(title) {
      searched?.push(id);
      return [{ title, url: `https://${id}.example/series/1` }];
    },
    async getSeries(url) {
      return {
        title: 'Test Series',
        url,
        altTitles: [],
        chapters: [{ number: 1, label: 'Chapter 1', url: `${url}/1` }],
      };
    },
    async getChapterPages() {
      return [];
    },
  };
}

describe('matchesSourceFilter', () => {
  it('allows all source kinds and NSFW by default', () => {
    expect(matchesSourceFilter({ kind: 'suwayomi', nsfw: false })).toBe(true);
    expect(matchesSourceFilter({ kind: 'suwayomi', nsfw: true })).toBe(true);
    expect(matchesSourceFilter({ kind: 'aggregator', nsfw: false })).toBe(true);
    expect(matchesSourceFilter({ kind: 'aggregator', nsfw: true })).toBe(true);
    expect(matchesSourceFilter({ kind: 'scanlation', nsfw: false })).toBe(true);
    expect(matchesSourceFilter({ kind: 'official', nsfw: false })).toBe(true);
    expect(matchesSourceFilter({ kind: 'torrent', nsfw: false })).toBe(true);
  });

  it('filters out NSFW sources when nsfw is false regardless of kind', () => {
    expect(matchesSourceFilter({ kind: 'suwayomi', nsfw: true }, { nsfw: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'aggregator', nsfw: true }, { nsfw: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'suwayomi', nsfw: false }, { nsfw: false })).toBe(true);
    expect(matchesSourceFilter({ kind: 'aggregator', nsfw: false }, { nsfw: false })).toBe(true);
  });

  it('filters each source kind independently', () => {
    expect(matchesSourceFilter({ kind: 'suwayomi', nsfw: false }, { keiyoushi: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'lncrawl', nsfw: false }, { lncrawl: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'lnreader', nsfw: false }, { lnreader: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'aggregator', nsfw: false }, { aggregators: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'scanlation', nsfw: false }, { scanlations: false })).toBe(false);
    expect(matchesSourceFilter({ kind: 'official', nsfw: false }, { official: false })).toBe(false);
  });

  it('returns false for all sources when all kinds are unchecked', () => {
    const none = { keiyoushi: false, lncrawl: false, lnreader: false, aggregators: false, scanlations: false, official: false, nsfw: true };
    expect(matchesSourceFilter({ kind: 'suwayomi', nsfw: true }, none)).toBe(false);
    expect(matchesSourceFilter({ kind: 'lncrawl', nsfw: false }, none)).toBe(false);
    expect(matchesSourceFilter({ kind: 'lnreader', nsfw: false }, none)).toBe(false);
    expect(matchesSourceFilter({ kind: 'torrent', nsfw: false }, none)).toBe(false);
  });
});

describe('Discovery.find with source filter', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('only searches adapters matching the provided filter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-filter-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'test.db'));
    try {
      const searched: string[] = [];
      const adapters: SourceAdapter[] = [
        fakeAdapter('keiyoushi-sfw', 'suwayomi', false, searched),
        fakeAdapter('keiyoushi-nsfw', 'suwayomi', true, searched),
        fakeAdapter('agg-sfw', 'aggregator', false, searched),
        fakeAdapter('agg-nsfw', 'aggregator', true, searched),
        fakeAdapter('scan-1', 'scanlation', false, searched),
        fakeAdapter('off-1', 'official', false, searched),
      ];
      const http = new SourceHttp(
        (async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch,
        false,
      );
      const registry = new SourceRegistry(db, adapters, http);
      const discovery = new Discovery(db, registry);

      const req = new RequestsRepo(db).upsertMangaBakaSeries('12345', 'Test Series');

      await discovery.find(req, {
        keiyoushi: true,
        aggregators: false,
        scanlations: true,
        official: false,
        nsfw: false,
      });

      expect([...new Set(searched)].sort()).toEqual(['keiyoushi-sfw', 'scan-1']);
    } finally {
      db.close();
    }
  });
});
