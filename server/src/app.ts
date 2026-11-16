import { dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import Fastify from 'fastify';
import type { ContentRequest, RequestComment, Settings, SettingsView } from '@atsusync/shared';
import { AtsuClient, emptySeriesState } from './atsu/client.ts';
import { RequestsRepo, syncRequests } from './atsu/requests.ts';
import { checkMangaBakaForRequest, getMangaBakaSeries } from './atsu/mangabaka.ts';
import { PresenceChecker, toRequestComment } from './atsu/presence.ts';
import { openDb, type Db } from './db/client.ts';
import { events } from './events.ts';
import { LinksRepo } from './links.ts';
import { SettingsStore } from './settings.ts';
import { Discovery } from './sources/discovery.ts';
import { mediumOf } from './sources/types.ts';
import { SourceRegistry } from './sources/registry.ts';
import { SourceHttp } from './sources/http.ts';
import { SUWAYOMI_PREFIX, SuwayomiClient, createSuwayomiAdapter, isAtsumaruExtension, isAtsumaruSource, isEnglishLang } from './sources/suwayomi.ts';
import { SuwayomiManager } from './sources/suwayomiManager.ts';
import type { SourceAdapter } from './sources/types.ts';
import { Drafts, mimeFor } from './upload/drafts.ts';
import type { TorrentClient } from './sources/torrent.ts';
import { DownloadPipeline } from './upload/pipeline.ts';
import { Watcher } from './watcher/watcher.ts';

export interface AppOptions {
  dbFile: string;
  /** Where chapter ZIPs are written; defaults to `downloads/` next to the database. */
  downloadsDir?: string;
  /** Torrent engine for torrent sources; defaults to the built-in WebTorrent client. Tests inject a fake. */
  torrents?: TorrentClient;
  adapters?: SourceAdapter[];
  fetchImpl?: typeof fetch;
  background?: boolean;
}

export function buildApp(opts: AppOptions) {
  const db: Db = openDb(opts.dbFile);
  const settings = new SettingsStore(db);
  const atsu = new AtsuClient(() => settings.get().atsuCookie, opts.fetchImpl);
  const requests = new RequestsRepo(db);
  const sources = new SourceRegistry(db, opts.adapters, new SourceHttp(opts.fetchImpl));
  const suwayomi = new SuwayomiClient(() => settings.get().suwayomiUrl, opts.fetchImpl);
  const suwayomiManager = new SuwayomiManager(dirname(opts.dbFile), settings, suwayomi, opts.fetchImpl);
  const syncSuwayomi = async () => {
    const base = suwayomi.baseUrl();
    if (!base) {
      sources.replaceDynamic(SUWAYOMI_PREFIX, []);
      return 0;
    }
    try {
      const host = new URL(base).hostname;
      if (host) sources.http.configureHost(host, { rpm: 600, concurrency: 4 });
    } catch {
      throw Object.assign(new Error('Invalid Suwayomi-Server URL'), { statusCode: 400 });
    }
    const nodes = (await suwayomi.listSources())
      .filter((n) => isEnglishLang(n.lang) && !isAtsumaruSource(n))
      .sort((a, b) => Number(a.isNsfw) - Number(b.isNsfw) || (a.displayName || a.name).localeCompare(b.displayName || b.name));
    const adapters = nodes.map((n) => createSuwayomiAdapter(n, suwayomi));
    sources.replaceDynamic(SUWAYOMI_PREFIX, adapters);
    return adapters.length;
  };
  const discovery = new Discovery(db, sources);
  const links = new LinksRepo(db, sources);
  const downloadsDir = opts.downloadsDir ?? join(dirname(opts.dbFile), 'downloads');
  const pipeline = new DownloadPipeline(db, links, sources, downloadsDir, 2, opts.torrents);
  const drafts = new Drafts(join(downloadsDir, '.drafts'));
  const watcher = new Watcher(links, sources, atsu, 60_000, (ids) => pipeline.clearForChapters(ids));
  const presence = new PresenceChecker(atsu, requests);

  const app = Fastify({ logger: { level: 'info', transport: undefined } });

  // Images for hand-built chapters arrive as raw bodies, one request per file.
  const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
  app.addContentTypeParser(/^(image\/.+|application\/octet-stream)$/, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message: string };
    reply.status(e.statusCode ?? 500).send({ error: e.message });
  });

  const mustRequest = (id: string): ContentRequest => {
    const r = requests.get(id);
    if (!r) throw Object.assign(new Error('Request not found'), { statusCode: 404 });
    return r;
  };

  // ---- Settings ----
  const settingsView = async (): Promise<SettingsView> => {
    const { atsuCookie, ...rest } = settings.get();
    return { ...rest, atsuCookieSet: !!atsuCookie, atsuUser: await atsu.whoAmI().catch(() => null) };
  };
  app.get('/api/settings', settingsView);
  app.put<{ Body: Partial<Settings> }>('/api/settings', async (req) => {
    settings.update(req.body ?? {});
    if (!settings.get().suwayomiUrl.trim()) {
      sources.replaceDynamic(SUWAYOMI_PREFIX, []);
    }
    return settingsView();
  });

  // ---- Requests ----
  let syncing: Promise<unknown> | null = null;
  const runSync = (full: boolean) => {
    syncing ??= syncRequests(atsu, requests, db, { full })
      .then((r) => {
        events.emitEvent({ type: 'requests_synced', added: r.added });
        void presence.tick();
        return r;
      })
      .finally(() => (syncing = null));
    return syncing;
  };
  app.get('/api/requests', async () => requests.list());
  app.post<{ Querystring: { full?: string } }>('/api/requests/sync', async (req) => runSync(req.query.full === '1'));
  // Series that already exist on Atsumaru (https://atsu.moe/manga/<id>) can be tracked and extended without a content request.
  app.post<{ Body: { url: string } }>('/api/series', async (req) => {
    const input = (req.body?.url ?? '').trim();
    const mangaId = input.match(/atsu\.moe\/manga\/([A-Za-z0-9_-]+)/i)?.[1] ?? (/^[A-Za-z0-9_-]+$/.test(input) ? input : null);
    if (!mangaId) throw Object.assign(new Error('Paste an atsu.moe/manga/… link'), { statusCode: 400 });
    const info = await atsu.getSeriesInfo(mangaId);
    if (!info) throw Object.assign(new Error('That series was not found on Atsumaru'), { statusCode: 404 });
    return requests.upsertAtsuSeries(info);
  });
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (req) => {
    // Refresh this one post so status tags are current when looking at it.
    const post = req.params.id.startsWith('atsu:') || req.params.id.startsWith('mb:') ? null : await atsu.getPost(req.params.id).catch(() => null);
    if (post?.id && post.createdAt) requests.upsertPost(post);
    const r = (req.params.id.startsWith('atsu:') ? requests.findByMangaId(req.params.id.slice(5)) : null) ?? mustRequest(req.params.id);
    const mangabaka = r.mangabakaId ? await getMangaBakaSeries(r.mangabakaId).catch(() => null) : null;
    return { request: r, mangabaka, matches: discovery.cached(r.id), links: links.list({ requestId: r.id }) };
  });
  app.patch<{ Params: { id: string }; Body: { title?: string | null } }>('/api/requests/:id', async (req) => {
    const r = mustRequest(req.params.id);
    if (req.body && 'title' in req.body) {
      requests.setCustomTitle(r.id, req.body.title ?? null);
    }
    return mustRequest(r.id);
  });
  app.post<{ Body: { sourceId?: string | null; mangaId?: string | null; title?: string | null } }>('/api/uploads/resolve', async (req) => {
    const sourceId = req.body?.sourceId?.trim() || null;
    let mangaId = req.body?.mangaId?.trim() || null;
    let mangaBakaId: string | null = null;
    let title = req.body?.title?.trim() || null;

    if (sourceId && !mangaId) {
      const fromWorkspace = await atsu.resolveUploadSource(sourceId).catch(() => null);
      if (fromWorkspace) {
        mangaId = fromWorkspace.mangaId;
        mangaBakaId = fromWorkspace.mangaBakaId;
        title = title ?? fromWorkspace.title;
      }
    }

    let r = mangaId ? requests.findByMangaId(mangaId) : null;
    if (!r && mangaBakaId) r = requests.findByMangaBakaId(mangaBakaId);

    if (!r && mangaId) {
      const info = await atsu.getSeriesInfo(mangaId).catch(() => null);
      if (info) {
        r = requests.upsertAtsuSeries(info);
        if (mangaBakaId && !r.mangabakaId) {
          requests.setMangaBakaId(r.id, mangaBakaId);
          r = requests.get(r.id)!;
        }
      }
    }
    if (!r && mangaBakaId) {
      const mb = await getMangaBakaSeries(mangaBakaId).catch(() => null);
      r = requests.upsertMangaBakaSeries(mangaBakaId, mb?.title ?? title ?? `MangaBaka #${mangaBakaId}`);
    }

    if (!r) {
      return { request: null, mangabaka: null, matches: [], links: [], resolved: { mangaId, mangaBakaId, title } };
    }
    const mangabaka = r.mangabakaId ? await getMangaBakaSeries(r.mangabakaId).catch(() => null) : null;
    return {
      request: r,
      mangabaka,
      matches: discovery.cached(r.id),
      links: links.list({ requestId: r.id }),
      resolved: { mangaId: mangaId ?? r.atsuMangaId, mangaBakaId: mangaBakaId ?? r.mangabakaId, title: r.title },
    };
  });
  app.get<{ Params: { id: string } }>('/api/requests/:id/comments', async (req): Promise<RequestComment[]> => {
    const r = mustRequest(req.params.id);
    const sectionId = requests.sectionId(r.id);
    if (!sectionId) return [];
    return (await atsu.getComments(sectionId)).map(toRequestComment);
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/presence', async (req) => {
    const r = mustRequest(req.params.id);
    if (r.atsuMangaId) throw Object.assign(new Error('This series is already on Atsumaru'), { statusCode: 400 });
    return presence.check(r);
  });
  app.get<{ Params: { id: string } }>('/api/requests/:id/atsu', async (req) => {
    const r = mustRequest(req.params.id);
    const linked = links.list({ requestId: r.id }).find((l) => l.atsuMangaId);
    const mangaId = linked?.atsuMangaId ?? r.atsuMangaId;
    if (!mangaId && !r.mangabakaId) return { ...emptySeriesState(), error: 'No MangaBaka link on this request' };
    return atsu.getSeriesState(mangaId ? { mangaId } : { mangaBakaId: r.mangabakaId });
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/find-sources', async (req) => discovery.find(mustRequest(req.params.id)));
  app.post<{ Params: { id: string } }>('/api/requests/:id/mangabaka', async (req) => {
    const r = mustRequest(req.params.id);
    const result = await checkMangaBakaForRequest(r, { force: true });
    if (result.mangabaka && !result.mediumMismatch && String(result.mangabaka.id) !== r.mangabakaId) {
      requests.setMangaBakaId(r.id, String(result.mangabaka.id));
    }
    return result;
  });
  app.post<{ Params: { id: string }; Body: { url: string } }>('/api/requests/:id/add-source', async (req) =>
    discovery.addByUrl(mustRequest(req.params.id), req.body.url),
  );

  // ---- Sources ----
  app.get('/api/sources', async () => sources.info());
  app.post('/api/sources/suwayomi/sync', async () => {
    if (suwayomi.baseUrl()) {
      await suwayomiManager.syncEnglishExtensions();
    }
    const count = await syncSuwayomi();
    return { count, sources: sources.info() };
  });
  app.get('/api/sources/suwayomi/status', async () => suwayomiManager.status());
  app.post('/api/sources/suwayomi/setup', async () => {
    const status = await suwayomiManager.setupAndStart();
    const count = await syncSuwayomi();
    return { status, count, sources: sources.info() };
  });
  app.post('/api/sources/suwayomi/stop', async () => {
    await suwayomiManager.stop();
    return suwayomiManager.status();
  });
  app.get('/api/sources/suwayomi/extensions', async () => ({
    extensions: (await suwayomi.fetchExtensions())
      .filter((e) => isEnglishLang(e.lang) && !isAtsumaruExtension(e))
      .sort((a, b) => Number(a.isNsfw) - Number(b.isNsfw) || a.name.localeCompare(b.name)),
  }));
  app.post<{ Params: { pkgName: string } }>('/api/sources/suwayomi/extensions/:pkgName/install', async (req) => {
    await suwayomi.setExtensionInstalled(req.params.pkgName, true);
    const count = await syncSuwayomi();
    return { count, sources: sources.info() };
  });
  app.post<{ Params: { pkgName: string } }>('/api/sources/suwayomi/extensions/:pkgName/uninstall', async (req) => {
    await suwayomi.setExtensionInstalled(req.params.pkgName, false);
    const count = await syncSuwayomi();
    return { count, sources: sources.info() };
  });
  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/sources/:id', async (req) => {
    sources.setEnabled(req.params.id, !!req.body.enabled);
    return sources.info();
  });
  app.post<{ Params: { id: string }; Body: { query?: string } }>('/api/sources/:id/test', async (req, reply) => {
    const adapter = sources.get(req.params.id);
    if (!adapter.search) return reply.code(400).send({ error: `${adapter.name} can't be searched; link its series by URL` });
    const started = Date.now();
    const hits = await adapter.search(req.body?.query || 'a', sources.http);
    return { ok: hits.length > 0, hits: hits.slice(0, 5), ms: Date.now() - started };
  });

  // ---- Links ----
  app.get('/api/links', async () => links.list());
  app.post<{ Body: { requestId: string; sourceId: string; seriesUrl: string } }>('/api/links', async (req) => {
    const r = mustRequest(req.body.requestId);
    const presenceMangaId = r.presence?.verdict === 'on_atsu' ? r.presence.match?.mangaId : null;
    const knownMangaId = r.atsuMangaId ?? presenceMangaId;
    const atsuState = knownMangaId
      ? await atsu.getSeriesState({ mangaId: knownMangaId }).catch(() => null)
      : r.mangabakaId
        ? await atsu.getSeriesState({ mangaBakaId: r.mangabakaId }).catch(() => null)
        : null;
    const link = await links.create({
      ...req.body,
      atsuMangaId: knownMangaId ?? atsuState?.mangaId ?? null,
      checkIntervalMin: settings.get().defaultCheckIntervalMin,
    });
    if (atsuState) {
      links.setAtsuState(link.id, atsuState);
      if (atsuState.found) {
        const uploadedIds = links.skipChaptersOnAtsu(link.id, [...atsuState.ranges, ...atsuState.waiting]);
        if (uploadedIds.length) pipeline.clearForChapters(uploadedIds);
      }
    }
    return links.get(link.id)!;
  });
  app.get<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    const link = links.get(Number(req.params.id));
    if (!link) throw Object.assign(new Error('Link not found'), { statusCode: 404 });
    const r = requests.get(link.requestId);
    const ref = link.atsuMangaId ? { mangaId: link.atsuMangaId } : r?.mangabakaId ? { mangaBakaId: r.mangabakaId } : null;
    const atsuState = ref ? await atsu.getSeriesState(ref).catch((e) => ({ ...emptySeriesState(), error: String(e.message) })) : null;
    if (atsuState) {
      links.setAtsuState(link.id, atsuState);
      if (atsuState.found) {
        const uploadedIds = links.skipChaptersOnAtsu(link.id, [...atsuState.ranges, ...atsuState.waiting]);
        if (uploadedIds.length) pipeline.clearForChapters(uploadedIds);
      }
    }
    const mangabaka = r?.mangabakaId ? await getMangaBakaSeries(r.mangabakaId).catch(() => null) : null;
    return { link: links.get(link.id), atsu: atsuState, mangabaka, chapters: links.chapters(link.id, atsuState ? [...atsuState.ranges, ...atsuState.waiting] : []) };
  });
  app.patch<{ Params: { id: string }; Body: { watch?: boolean; checkIntervalMin?: number; atsuMangaId?: string | null } }>(
    '/api/links/:id',
    async (req) => {
      links.update(Number(req.params.id), req.body);
      return links.get(Number(req.params.id));
    },
  );
  app.delete<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    links.delete(Number(req.params.id));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/links/:id/check', async (req) => {
    const link = links.get(Number(req.params.id));
    if (!link) throw Object.assign(new Error('Link not found'), { statusCode: 404 });
    const added = await watcher.check(link);
    return { added: added.length, link: links.get(link.id) };
  });
  app.post<{ Body: { linkIds?: number[] } }>('/api/links/refresh-atsu', async (req) => {
    const all = links.list();
    const target = req.body?.linkIds?.length ? all.filter((l) => req.body.linkIds!.includes(l.id)) : all;
    let updated = 0;
    for (const link of target) {
      const r = requests.get(link.requestId);
      const ref = link.atsuMangaId ? { mangaId: link.atsuMangaId } : r?.mangabakaId ? { mangaBakaId: r.mangabakaId } : null;
      if (!ref) continue;
      const state = await atsu.getSeriesState(ref).catch(() => null);
      if (state) {
        links.setAtsuState(link.id, state);
        if (state.found) {
          const uploadedIds = links.skipChaptersOnAtsu(link.id, [...state.ranges, ...state.waiting]);
          if (uploadedIds.length) pipeline.clearForChapters(uploadedIds);
        }
        updated++;
      }
    }
    return { updated, links: links.list() };
  });
  app.post<{ Body: { linkIds?: number[] } }>('/api/links/check-all', async (req) => {
    const all = links.list();
    const target = req.body?.linkIds?.length ? all.filter((l) => req.body.linkIds!.includes(l.id)) : all.filter((l) => l.watch);
    let added = 0;
    for (const link of target) {
      const res = await watcher.check(link);
      added += res.length;
    }
    return { checked: target.length, added };
  });
  app.post<{ Body: { ids: number[]; action: 'watch' | 'pause' | 'untrack' | 'check' } }>('/api/links/bulk', async (req) => {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || !ids.length) return { ok: true, count: 0 };
    if (action === 'untrack') {
      for (const id of ids) links.delete(id);
    } else if (action === 'watch' || action === 'pause') {
      for (const id of ids) links.update(id, { watch: action === 'watch' });
    } else if (action === 'check') {
      for (const id of ids) {
        const link = links.get(id);
        if (link) await watcher.check(link);
      }
    }
    return { ok: true, count: ids.length };
  });
  // Pull specific chapters from another site into an existing link (e.g. ones that are broken on the linked site).
  const sourceFor = (url: string) => {
    const adapter = sources.forUrl(url);
    if (!adapter) throw Object.assign(new Error('No source handles that URL'), { statusCode: 400 });
    return adapter;
  };
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/links/:id/search-sources', async (req) => {
    const link = links.get(Number(req.params.id));
    if (!link) throw Object.assign(new Error('Link not found'), { statusCode: 404 });
    const q = (req.query.q || link.seriesTitle).trim();
    const linkMedium = mediumOf(sources.find(link.sourceId) ?? { medium: 'comic' });
    const searchable = sources.enabled().filter((a) => a.search && a.id !== link.sourceId && mediumOf(a) === linkMedium);
    const results = await Promise.all(
      searchable.map(async (a) => {
        try {
          return { sourceId: a.id, sourceName: a.name, hits: (await a.search!(q, sources.http)).slice(0, 5), error: null };
        } catch (e) {
          return { sourceId: a.id, sourceName: a.name, hits: [], error: (e as Error).message };
        }
      }),
    );
    return results;
  });
  app.get<{ Params: { id: string }; Querystring: { url: string } }>('/api/links/:id/other-series', async (req) => {
    const link = links.get(Number(req.params.id));
    if (!link) throw Object.assign(new Error('Link not found'), { statusCode: 404 });
    const adapter = sourceFor(req.query.url);
    const series = await adapter.getSeries(req.query.url, sources.http);
    const have = new Set(links.chapters(link.id).map((c) => c.number));
    return {
      sourceName: adapter.name,
      title: series.title,
      url: series.url,
      chapters: series.chapters.map((c) => ({ ...c, inLink: have.has(c.number) })),
    };
  });
  app.post<{ Params: { id: string }; Body: { url: string; numbers: number[]; urls?: Record<number, string> } }>('/api/links/:id/fetch-from', async (req) => {
    const link = links.get(Number(req.params.id));
    if (!link) throw Object.assign(new Error('Link not found'), { statusCode: 404 });
    const series = await sourceFor(req.body.url).getSeries(req.body.url, sources.http);
    const wanted = new Set(req.body.numbers);
    const picked = series.chapters
      .filter((c) => wanted.has(c.number))
      .map((c) => {
        const overrideUrl = req.body.urls?.[c.number];
        const alt = overrideUrl ? c.alternatives?.find((a) => a.url === overrideUrl) : undefined;
        return alt ? { ...c, url: alt.url, label: alt.label ?? c.label, group: alt.group } : c;
      });
    if (picked.length !== wanted.size) throw Object.assign(new Error('Some requested chapters are not on that site'), { statusCode: 400 });
    return pipeline.addFromSource(link.id, picked);
  });
  app.post<{ Body: { chapterIds: number[]; state: 'skipped' | 'known' | 'pending' | 'uploaded' } }>('/api/chapters/state', async (req) => {
    links.setChapterState(req.body.chapterIds, req.body.state);
    if (req.body.state === 'uploaded') {
      pipeline.clearForChapters(req.body.chapterIds);
    }
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { url: string } }>('/api/chapters/:id/source', async (req) =>
    links.setChapterSource(Number(req.params.id), req.body.url),
  );

  // ---- Downloads (chapter ZIPs the user uploads to atsu.moe by hand) ----
  app.get<{ Querystring: { linkId?: string } }>('/api/downloads', async (req) =>
    pipeline.list({ linkId: req.query.linkId ? Number(req.query.linkId) : undefined }),
  );
  app.post<{ Body: { chapterIds: number[] } }>('/api/downloads', async (req) => pipeline.enqueue(req.body.chapterIds));
  app.delete<{ Querystring: { linkId?: string } }>('/api/downloads', async (req) => {
    if (!req.query.linkId) throw Object.assign(new Error('linkId is required'), { statusCode: 400 });
    return pipeline.clear(Number(req.query.linkId));
  });
  app.delete<{ Params: { id: string } }>('/api/downloads/:id', async (req) => pipeline.remove(Number(req.params.id)));
  app.post<{ Params: { id: string } }>('/api/downloads/:id/retry', async (req) => {
    pipeline.retry(Number(req.params.id));
    return pipeline.get(Number(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/downloads/:id/cancel', async (req) => {
    pipeline.cancel(Number(req.params.id));
    return pipeline.get(Number(req.params.id));
  });
  app.get<{ Params: { id: string } }>('/api/downloads/:id/file', async (req, reply) => {
    const file = pipeline.file(Number(req.params.id));
    if (!file) throw Object.assign(new Error('That download is not ready (or the file was deleted). Download it again.'), { statusCode: 404 });
    const contentType = file.path.toLowerCase().endsWith('.epub') ? 'application/epub+zip' : 'application/zip';
    return reply
      .header('content-type', contentType)
      .header('content-disposition', `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(createReadStream(file.path));
  });

  // ---- Hand-built chapters: upload images → preview the stitched result → save as a download ----
  const autoJoin = (q: { autoJoin?: string }) => q.autoJoin !== '0';
  app.post('/api/manual/drafts', async () => drafts.create());
  app.get<{ Params: { id: string } }>('/api/manual/drafts/:id', async (req) => drafts.get(req.params.id));
  app.delete<{ Params: { id: string } }>('/api/manual/drafts/:id', async (req) => {
    drafts.discard(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Querystring: { name?: string } }>(
    '/api/manual/drafts/:id/pages',
    { bodyLimit: MAX_IMAGE_BYTES },
    async (req) => drafts.addPage(req.params.id, req.query.name || 'page.jpg', req.body as Buffer),
  );
  app.put<{ Params: { id: string }; Body: { order?: string[]; joins?: Record<string, boolean>; sortByName?: boolean } }>(
    '/api/manual/drafts/:id',
    async (req) => drafts.update(req.params.id, req.body ?? {}),
  );
  app.delete<{ Params: { id: string; pageId: string } }>('/api/manual/drafts/:id/pages/:pageId', async (req) =>
    drafts.removePage(req.params.id, req.params.pageId),
  );
  app.get<{ Params: { id: string; pageId: string } }>('/api/manual/drafts/:id/pages/:pageId/image', async (req, reply) => {
    const f = drafts.pageFile(req.params.id, req.params.pageId);
    return reply.header('content-type', mimeFor(f.name)).header('cache-control', 'no-store').send(Buffer.from(f.bytes));
  });
  app.get<{ Params: { id: string }; Querystring: { autoJoin?: string } }>('/api/manual/drafts/:id/preview', async (req) =>
    drafts.preview(req.params.id, { autoJoin: autoJoin(req.query) }),
  );
  app.get<{ Params: { id: string; index: string }; Querystring: { autoJoin?: string } }>('/api/manual/drafts/:id/preview/:index', async (req, reply) => {
    const f = await drafts.previewImage(req.params.id, Number(req.params.index), { autoJoin: autoJoin(req.query) });
    return reply.header('content-type', mimeFor(f.name)).header('cache-control', 'no-store').send(Buffer.from(f.bytes));
  });
  app.post<{ Params: { id: string }; Body: { linkId: number; number: number; label?: string; autoJoin?: boolean } }>('/api/manual/drafts/:id/commit', async (req) => {
    const { linkId, number, label, autoJoin: join_ } = req.body;
    const files = await drafts.build(req.params.id, { autoJoin: join_ !== false });
    const job = pipeline.addManual({ linkId, number: Number(number), label: label ?? '', files });
    drafts.discard(req.params.id);
    return job;
  });

  // ---- Live events (SSE) ----
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write(': connected\n\n');
    const off = events.onEvent((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  let syncTimer: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    if (opts.background === false) return;
    watcher.start();
    presence.start();
    pipeline.pump();
    if (settings.get().suwayomiUrl.trim()) {
      void suwayomiManager
        .startIfInstalled()
        .then(() => syncSuwayomi())
        .catch((e) => app.log.warn(`Suwayomi sync failed: ${(e as Error).message}`));
    }
    void runSync(true).catch((e) => app.log.warn(`Request sync failed: ${e.message}`));
    // A quick sync only sees new posts; status tags (Added, Duplicate…) change on old ones, which
    // is what removes a post's upload button, so walk the whole forum (~15 pages) every few hours.
    let ticks = 0;
    syncTimer = setInterval(() => void runSync(++ticks % 12 === 0).catch(() => {}), 15 * 60_000);
  });
  app.addHook('onClose', async () => {
    watcher.stop();
    presence.stop();
    await pipeline.close();
    await suwayomiManager.stop();
    if (syncTimer) clearInterval(syncTimer);
    db.close();
  });

  return { app, db, settings, atsu, requests, sources, discovery, links, pipeline, watcher, presence };
}
