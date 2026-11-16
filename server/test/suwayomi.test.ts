import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/client.ts';
import { SettingsStore } from '../src/settings.ts';
import { SourceHttp } from '../src/sources/http.ts';
import {
  SuwayomiClient,
  createSuwayomiAdapter,
  dedupeExtensions,
  dedupeSuwayomiSources,
} from '../src/sources/suwayomi.ts';
import {
  KEIYOUSHI_REPO_URL,
  SuwayomiManager,
  YUZONO_REPO_URL,
} from '../src/sources/suwayomiManager.ts';

function mockSuwayomiFetch() {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/manga/42/thumbnail')) {
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }
    if (!url.endsWith('/api/graphql')) {
      return new Response('Not found', { status: 404 });
    }
    const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: any };

    if (query.includes('__typename')) {
      return Response.json({ data: { __typename: 'Query' } });
    }

    if (query.includes('addExtensionStore')) {
      return Response.json({
        data: {
          addExtensionStore: {
            extensionStore: { name: 'Keiyoushi', indexUrl: variables.input.indexUrl },
          },
        },
      });
    }

    if (query.includes('fetchExtensions')) {
      return Response.json({
        data: {
          fetchExtensions: {
            extensions: [
              {
                pkgName: 'eu.kanade.tachiyomi.extension.en.batoto',
                name: 'Bato.to',
                lang: 'en',
                versionName: '1.4.0',
                isInstalled: false,
                hasUpdate: false,
                isNsfw: false,
              },
              {
                pkgName: 'eu.kanade.tachiyomi.extension.all.mangadex',
                name: 'MangaDex',
                lang: 'all',
                versionName: '1.4.1',
                isInstalled: true,
                hasUpdate: true,
                isNsfw: false,
              },
              {
                pkgName: 'eu.kanade.tachiyomi.extension.es.tumanga',
                name: 'TuManga',
                lang: 'es',
                versionName: '1.0.0',
                isInstalled: false,
                hasUpdate: false,
                isNsfw: false,
              },
              {
                pkgName: 'eu.kanade.tachiyomi.extension.en.hentaisite',
                name: 'HentaiSite',
                lang: 'en',
                versionName: '1.0.0',
                isInstalled: false,
                hasUpdate: false,
                isNsfw: true,
              },
              {
                pkgName: 'eu.kanade.tachiyomi.extension.en.atsumaru',
                name: 'Atsumaru',
                lang: 'en',
                versionName: '1.0.0',
                isInstalled: false,
                hasUpdate: false,
                isNsfw: false,
              },
            ],
          },
        },
      });
    }

    if (query.includes('updateExtensions(')) {
      expect(variables.input.ids).toEqual([
        'eu.kanade.tachiyomi.extension.en.batoto',
        'eu.kanade.tachiyomi.extension.all.mangadex',
        'eu.kanade.tachiyomi.extension.en.hentaisite',
      ]);
      expect(variables.input.patch).toEqual({ install: true, update: true });
      return Response.json({
        data: {
          updateExtensions: {
            extensions: variables.input.ids.map((id: string) => ({ pkgName: id, isInstalled: true })),
          },
        },
      });
    }

    if (query.includes('updateExtension(')) {
      return Response.json({
        data: {
          updateExtension: {
            extension: { pkgName: variables.input.id, isInstalled: !!variables.input.patch.install },
          },
        },
      });
    }

    if (query.includes('query Sources')) {
      return Response.json({
        data: {
          sources: {
            nodes: [
              {
                id: '123456',
                name: 'Bato.to',
                displayName: 'Bato.to (EN)',
                lang: 'en',
                homeUrl: 'https://bato.to',
                baseUrl: 'https://bato.to',
                isNsfw: false,
              },
              {
                id: '999999',
                name: 'TuManga',
                displayName: 'TuManga (ES)',
                lang: 'es',
                homeUrl: 'https://tumanga.example',
                baseUrl: 'https://tumanga.example',
                isNsfw: false,
              },
              {
                id: '888888',
                name: 'HentaiSite',
                displayName: 'HentaiSite (EN)',
                lang: 'en',
                homeUrl: 'https://hentai.example',
                baseUrl: 'https://hentai.example',
                isNsfw: true,
              },
              {
                id: '777777',
                name: 'Atsumaru',
                displayName: 'Atsumaru (EN)',
                lang: 'en',
                homeUrl: 'https://atsu.moe',
                baseUrl: 'https://atsu.moe',
                isNsfw: false,
              },
            ],
          },
        },
      });
    }

    if (query.includes('fetchSourceManga')) {
      expect(variables.input).toEqual({ source: '123456', type: 'SEARCH', page: 1, query: 'Dandadan' });
      return Response.json({
        data: {
          fetchSourceManga: {
            mangas: [
              {
                id: 42,
                sourceId: '123456',
                url: '/series/999',
                realUrl: 'https://bato.to/series/999',
                title: 'Dandadan',
                thumbnailUrl: '/api/v1/manga/42/thumbnail',
              },
            ],
            hasNextPage: false,
          },
        },
      });
    }

    if (query.includes('fetchMangaAndChapters')) {
      expect(variables.input).toEqual({ id: 42, fetchManga: true, fetchChapters: true });
      return Response.json({
        data: {
          fetchMangaAndChapters: {
            manga: {
              id: 42,
              sourceId: '123456',
              url: '/series/999',
              realUrl: 'https://bato.to/series/999',
              title: 'Dandadan',
              thumbnailUrl: '/api/v1/manga/42/thumbnail',
              author: 'Yukinobu Tatsu',
              artist: 'Yukinobu Tatsu',
              description: 'Aliens and ghosts.',
            },
            chapters: [
              {
                id: 102,
                url: '/chapter/102',
                name: 'Ch. 2',
                uploadDate: '1700000000000',
                chapterNumber: -1,
                scanlator: 'Group B',
                mangaId: 42,
                sourceOrder: 2,
                realUrl: 'https://bato.to/chapter/102',
                pageCount: 2,
              },
              {
                id: 101,
                url: '/chapter/101',
                name: 'Chapter 1',
                uploadDate: 1699900000000,
                chapterNumber: 1,
                scanlator: 'Group A',
                mangaId: 42,
                sourceOrder: 1,
                realUrl: 'https://bato.to/chapter/101',
                pageCount: 2,
              },
              {
                id: 103,
                url: '/chapter/103',
                name: 'Chapter 1 (Alt)',
                uploadDate: 1699950000000,
                chapterNumber: 1,
                scanlator: 'Group C',
                mangaId: 42,
                sourceOrder: 3,
                realUrl: null,
                pageCount: 2,
              },
            ],
          },
        },
      });
    }

    if (query.includes('fetchChapterPages')) {
      expect(variables.input).toEqual({ chapterId: 101 });
      return Response.json({
        data: {
          fetchChapterPages: {
            pages: ['/api/v1/manga/42/chapter/1/page/0', '/api/v1/manga/42/chapter/1/page/1'],
          },
        },
      });
    }

    return new Response('Unexpected query', { status: 400 });
  });
}

describe('Suwayomi / Keiyoushi bridge', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('searches, fetches series/chapters with alts, and resolves page URLs', async () => {
    const fetchMock = mockSuwayomiFetch();
    const client = new SuwayomiClient(() => 'http://localhost:4567/', fetchMock as unknown as typeof fetch);
    const http = new SourceHttp(fetchMock as unknown as typeof fetch, false);

    const nodes = await client.listSources();
    expect(nodes).toHaveLength(4);
    const adapter = createSuwayomiAdapter(nodes[0]!, client);
    expect(adapter.id).toBe('suwayomi:123456');
    expect(adapter.kind).toBe('suwayomi');

    const hits = await adapter.search!('Dandadan', http);
    expect(hits).toEqual([
      {
        title: 'Dandadan',
        url: 'https://bato.to/series/999#suwayomi=42',
        cover: 'http://localhost:4567/api/v1/manga/42/thumbnail',
      },
    ]);

    const series = await adapter.getSeries(hits[0]!.url, http);
    expect(series.title).toBe('Dandadan');
    expect(series.chapters.map((c) => c.number)).toEqual([1, 2]);
    expect(series.chapters[0]!.group).toBe('Group A');
    expect(series.chapters[0]!.alternatives).toEqual([
      {
        group: 'Group C',
        url: 'http://localhost:4567/manga/42/chapter/103#suwayomi-ch=103',
        label: 'Chapter 1 (Alt)',
        date: '2023-11-14',
      },
    ]);
    expect(series.chapters[1]!.number).toBe(2);

    const pages = await adapter.getChapterPages(series.chapters[0]!, http);
    expect(pages).toEqual([
      { url: 'http://localhost:4567/api/v1/manga/42/chapter/1/page/0', name: '001.jpg' },
      { url: 'http://localhost:4567/api/v1/manga/42/chapter/1/page/1', name: '002.jpg' },
    ]);
  });

  it('syncs and clears Suwayomi sources via the HTTP API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-suwayomi-'));
    dirs.push(dir);
    const fetchMock = mockSuwayomiFetch();
    const { app } = buildApp({
      dbFile: join(dir, 'test.db'),
      adapters: [],
      fetchImpl: fetchMock as unknown as typeof fetch,
      background: false,
    });

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { suwayomiUrl: 'http://localhost:4567' },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().suwayomiUrl).toBe('http://localhost:4567');

    const syncRes = await app.inject({ method: 'POST', url: '/api/sources/suwayomi/sync' });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().count).toBe(2);
    expect(syncRes.json().sources).toEqual([
      expect.objectContaining({
        id: 'suwayomi:123456',
        name: 'Bato.to (EN)',
        kind: 'suwayomi',
        searchable: true,
        enabled: true,
      }),
      expect.objectContaining({
        id: 'suwayomi:888888',
        name: 'HentaiSite (EN)',
        kind: 'suwayomi',
        searchable: true,
        enabled: true,
      }),
    ]);

    const testRes = await app.inject({
      method: 'POST',
      url: '/api/sources/suwayomi:123456/test',
      payload: { query: 'Dandadan' },
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(true);
    expect(testRes.json().hits[0].title).toBe('Dandadan');

    const thumbRes = await app.inject({
      method: 'GET',
      url: '/api/sources/suwayomi/thumbnail?url=' + encodeURIComponent('http://127.0.0.1:4567/api/v1/manga/42/thumbnail'),
    });
    expect(thumbRes.statusCode).toBe(200);
    expect(thumbRes.headers['content-type']).toBe('image/webp');
    expect(thumbRes.rawPayload).toEqual(Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const badThumbRes = await app.inject({
      method: 'GET',
      url: '/api/sources/suwayomi/thumbnail?url=' + encodeURIComponent('https://evil.example.com/api/v1/manga/42/thumbnail'),
    });
    expect(badThumbRes.statusCode).toBe(400);

    const clearRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { suwayomiUrl: '' },
    });
    expect(clearRes.statusCode).toBe(200);

    const sourcesAfter = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(sourcesAfter.json()).toEqual([]);

    // One-click setup when Suwayomi is already reachable at the configured URL
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { suwayomiUrl: 'http://localhost:4567' } });
    const setupRes = await app.inject({ method: 'POST', url: '/api/sources/suwayomi/setup' });
    expect(setupRes.statusCode).toBe(200);
    expect(setupRes.json().status.running).toBe(true);
    expect(setupRes.json().count).toBe(2);

    const extRes = await app.inject({ method: 'GET', url: '/api/sources/suwayomi/extensions' });
    expect(extRes.statusCode).toBe(200);
    expect(extRes.json().extensions.map((e: { pkgName: string }) => e.pkgName)).toEqual([
      'eu.kanade.tachiyomi.extension.en.batoto',
      'eu.kanade.tachiyomi.extension.all.mangadex',
      'eu.kanade.tachiyomi.extension.en.hentaisite',
    ]);

    const instRes = await app.inject({
      method: 'POST',
      url: '/api/sources/suwayomi/extensions/eu.kanade.tachiyomi.extension.en.batoto/install',
    });
    expect(instRes.statusCode).toBe(200);
    expect(instRes.json().count).toBe(2);

    await app.close();
  });

  it('auto-updates only installed extensions with hasUpdate via SuwayomiManager', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-suwayomi-upd-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'test.db'));
    const settings = new SettingsStore(db);
    const updatedBatches: string[][] = [];

    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: any };
      if (query.includes('__typename')) {
        return Response.json({ data: { __typename: 'Query' } });
      }
      if (query.includes('fetchExtensions')) {
        return Response.json({
          data: {
            fetchExtensions: {
              extensions: [
                { pkgName: 'eu.kanade.tachiyomi.extension.en.batoto', name: 'Bato.to', lang: 'en', versionName: '1.4.0', isInstalled: false, hasUpdate: false, isNsfw: false },
                { pkgName: 'eu.kanade.tachiyomi.extension.all.mangadex', name: 'MangaDex', lang: 'all', versionName: '1.4.1', isInstalled: true, hasUpdate: true, isNsfw: false },
                { pkgName: 'eu.kanade.tachiyomi.extension.en.up2date', name: 'UpToDate', lang: 'en', versionName: '1.0.0', isInstalled: true, hasUpdate: false, isNsfw: false },
                { pkgName: 'eu.kanade.tachiyomi.extension.en.atsumaru', name: 'Atsumaru', lang: 'en', versionName: '1.0.0', isInstalled: true, hasUpdate: true, isNsfw: false },
              ],
            },
          },
        });
      }
      if (query.includes('updateExtensions(')) {
        updatedBatches.push(variables.input.ids);
        return Response.json({
          data: {
            updateExtensions: {
              extensions: variables.input.ids.map((id: string) => ({ pkgName: id, isInstalled: true })),
            },
          },
        });
      }
      return new Response('Unexpected query', { status: 400 });
    });

    const client = new SuwayomiClient(() => settings.get().suwayomiUrl, fetchMock as unknown as typeof fetch);
    const manager = new SuwayomiManager(dir, settings, client, fetchMock as unknown as typeof fetch);

    // No-op when Suwayomi URL is not configured
    expect(await manager.updateInstalledExtensions()).toBe(0);
    expect(updatedBatches).toEqual([]);

    // Updates only installed extensions with hasUpdate (excluding Atsumaru)
    settings.update({ suwayomiUrl: 'http://localhost:4567' });
    expect(await manager.updateInstalledExtensions()).toBe(1);
    expect(updatedBatches).toEqual([['eu.kanade.tachiyomi.extension.all.mangadex']]);

    db.close();
  });

  it('registers both Keiyoushi and Yuzono repos and deduplicates extensions/sources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atsusync-yuzono-'));
    dirs.push(dir);
    const db = openDb(join(dir, 'test.db'));
    const settings = new SettingsStore(db);
    settings.update({ suwayomiUrl: 'http://localhost:4567' });

    const addedStores: string[] = [];
    const installedBatches: string[][] = [];
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: any };
      if (query.includes('__typename')) return Response.json({ data: { __typename: 'Query' } });
      if (query.includes('addExtensionStore')) {
        addedStores.push(variables.input.indexUrl);
        // Simulate Keiyoushi primary already existing so we also verify Yuzono still registers.
        if (variables.input.indexUrl === KEIYOUSHI_REPO_URL) {
          return Response.json({ errors: [{ message: 'Store already exists' }] });
        }
        return Response.json({
          data: { addExtensionStore: { extensionStore: { name: 'Yuzono', indexUrl: variables.input.indexUrl } } },
        });
      }
      if (query.includes('fetchExtensions')) {
        return Response.json({
          data: {
            fetchExtensions: {
              extensions: [
                { pkgName: 'eu.kanade.tachiyomi.extension.all.nhentai', name: 'NHentai', lang: 'all', versionName: '1.6.0', isInstalled: false, hasUpdate: false, isNsfw: true },
                { pkgName: 'eu.kanade.tachiyomi.extension.all.nhentai', name: 'NHentai', lang: 'all', versionName: '1.6.1', isInstalled: false, hasUpdate: false, isNsfw: true },
                { pkgName: 'eu.kanade.tachiyomi.extension.en.hentai2read', name: 'Hentai2Read', lang: 'en', versionName: '1.6.1', isInstalled: false, hasUpdate: false, isNsfw: true },
              ],
            },
          },
        });
      }
      if (query.includes('updateExtensions(')) {
        installedBatches.push(variables.input.ids);
        return Response.json({
          data: { updateExtensions: { extensions: variables.input.ids.map((id: string) => ({ pkgName: id, isInstalled: true })) } },
        });
      }
      return new Response('Unexpected query', { status: 400 });
    });

    const client = new SuwayomiClient(() => settings.get().suwayomiUrl, fetchMock as unknown as typeof fetch);
    const manager = new SuwayomiManager(dir, settings, client, fetchMock as unknown as typeof fetch);
    await manager.syncEnglishExtensions();

    expect(addedStores).toContain(KEIYOUSHI_REPO_URL);
    expect(addedStores).toContain(YUZONO_REPO_URL);
    expect(installedBatches).toEqual([
      ['eu.kanade.tachiyomi.extension.all.nhentai', 'eu.kanade.tachiyomi.extension.en.hentai2read'],
    ]);

    const dedupedExts = dedupeExtensions([
      { pkgName: 'pkg.a', name: 'SiteA', lang: 'en', versionName: '1.0.0', isInstalled: false, hasUpdate: false, isNsfw: true },
      { pkgName: 'pkg.a', name: 'SiteA', lang: 'en', versionName: '1.2.0', isInstalled: true, hasUpdate: false, isNsfw: true },
      { pkgName: 'pkg.b.fork', name: 'SiteA', lang: 'en', versionName: '1.3.0', isInstalled: false, hasUpdate: false, isNsfw: true },
    ]);
    expect(dedupedExts).toHaveLength(1);
    expect(dedupedExts[0]!.pkgName).toBe('pkg.a');

    const dedupedSources = dedupeSuwayomiSources([
      { id: '1', name: 'NHentai', displayName: 'NHentai (ALL)', lang: 'all', homeUrl: 'https://nhentai.net', baseUrl: 'https://nhentai.net', isNsfw: true },
      { id: '2', name: 'NHentai', displayName: 'NHentai (EN)', lang: 'en', homeUrl: 'https://nhentai.net', baseUrl: 'https://nhentai.net', isNsfw: true },
      { id: '3', name: 'E-Hentai', displayName: 'E-Hentai (EN)', lang: 'en', homeUrl: 'https://e-hentai.org', baseUrl: 'https://e-hentai.org', isNsfw: true },
      { id: '4', name: 'NHentai', displayName: 'NHentai (EN)', lang: 'en', homeUrl: 'https://nhentai.net', baseUrl: 'https://nhentai.net', isNsfw: true },
    ]);
    expect(dedupedSources.map((s) => s.id)).toEqual(['2', '3']);

    db.close();
  });
});
