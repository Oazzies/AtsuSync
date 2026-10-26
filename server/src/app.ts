import { dirname, join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ContentRequest, RequestComment, Settings, SettingsView } from '@atsusync/shared';
import { AtsuClient, emptySeriesState } from './atsu/client.ts';
import { RequestsRepo, syncRequests } from './atsu/requests.ts';
import { getMangaBakaSeries } from './atsu/mangabaka.ts';
import { PresenceChecker, toRequestComment } from './atsu/presence.ts';
import { openDb, type Db } from './db/client.ts';
import { events } from './events.ts';
import { LinksRepo } from './links.ts';
import { SettingsStore } from './settings.ts';
import { Discovery } from './sources/discovery.ts';
import { SourceRegistry } from './sources/registry.ts';
import { SourceHttp } from './sources/http.ts';
import type { SourceAdapter } from './sources/types.ts';
import { DownloadPipeline } from './upload/pipeline.ts';
import { Watcher } from './watcher/watcher.ts';

export interface AppOptions {
  dbFile: string;
  /** Where chapter ZIPs are written; defaults to `downloads/` next to the database. */
  downloadsDir?: string;
  webDist?: string;
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
  const discovery = new Discovery(db, sources);
  const links = new LinksRepo(db, sources);
  const pipeline = new DownloadPipeline(db, links, sources, opts.downloadsDir ?? join(dirname(opts.dbFile), 'downloads'));
  const watcher = new Watcher(links, sources, atsu);
  const presence = new PresenceChecker(atsu, requests);

  const app = Fastify({ logger: { level: 'info', transport: undefined } });

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
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (req) => {
    // Refresh this one post so status tags are current when looking at it.
    const post = await atsu.getPost(req.params.id).catch(() => null);
    if (post?.id && post.createdAt) requests.upsertPost(post);
    const r = mustRequest(req.params.id);
    const mangabaka = r.mangabakaId ? await getMangaBakaSeries(r.mangabakaId).catch(() => null) : null;
    return { request: r, mangabaka, matches: discovery.cached(r.id), links: links.list({ requestId: r.id }) };
  });
  app.get<{ Params: { id: string } }>('/api/requests/:id/comments', async (req): Promise<RequestComment[]> => {
    const r = mustRequest(req.params.id);
    const sectionId = requests.sectionId(r.id);
    if (!sectionId) return [];
    return (await atsu.getComments(sectionId)).map(toRequestComment);
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/presence', async (req) => presence.check(mustRequest(req.params.id)));
  app.get<{ Params: { id: string } }>('/api/requests/:id/atsu', async (req) => {
    const r = mustRequest(req.params.id);
    const linked = links.list({ requestId: r.id }).find((l) => l.atsuMangaId);
    if (!linked && !r.mangabakaId) return { ...emptySeriesState(), error: 'No MangaBaka link on this request' };
    return atsu.getSeriesState(linked ? { mangaId: linked.atsuMangaId } : { mangaBakaId: r.mangabakaId });
  });
  app.post<{ Params: { id: string } }>('/api/requests/:id/find-sources', async (req) => discovery.find(mustRequest(req.params.id)));
  app.post<{ Params: { id: string }; Body: { url: string } }>('/api/requests/:id/add-source', async (req) =>
    discovery.addByUrl(mustRequest(req.params.id), req.body.url),
  );

  // ---- Sources ----
  app.get('/api/sources', async () => sources.info());
  app.put<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/sources/:id', async (req) => {
    sources.setEnabled(req.params.id, !!req.body.enabled);
    return sources.info();
  });
  app.post<{ Params: { id: string }; Body: { query?: string } }>('/api/sources/:id/test', async (req) => {
    const adapter = sources.get(req.params.id);
    const started = Date.now();
    const hits = await adapter.search(req.body?.query || 'a', sources.http);
    return { ok: hits.length > 0, hits: hits.slice(0, 5), ms: Date.now() - started };
  });

  // ---- Links ----
  app.get('/api/links', async () => links.list());
  app.post<{ Body: { requestId: string; sourceId: string; seriesUrl: string } }>('/api/links', async (req) => {
    const r = mustRequest(req.body.requestId);
    const atsuState = r.mangabakaId ? await atsu.getSeriesState({ mangaBakaId: r.mangabakaId }).catch(() => null) : null;
    return links.create({ ...req.body, atsuMangaId: atsuState?.mangaId ?? null, checkIntervalMin: settings.get().defaultCheckIntervalMin });
  });
  app.get<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    const link = links.get(Number(req.params.id));
    if (!link) throw Object.assign(new Error('Link not found'), { statusCode: 404 });
    const r = requests.get(link.requestId);
    const ref = link.atsuMangaId ? { mangaId: link.atsuMangaId } : r?.mangabakaId ? { mangaBakaId: r.mangabakaId } : null;
    const atsuState = ref ? await atsu.getSeriesState(ref).catch((e) => ({ ...emptySeriesState(), error: String(e.message) })) : null;
    if (atsuState?.found && atsuState.mangaId && !link.atsuMangaId) links.update(link.id, { atsuMangaId: atsuState.mangaId });
    return { link: links.get(link.id), atsu: atsuState, chapters: links.chapters(link.id, atsuState ? [...atsuState.ranges, ...atsuState.waiting] : []) };
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
  app.post<{ Body: { chapterIds: number[]; state: 'skipped' | 'known' | 'pending' | 'uploaded' } }>('/api/chapters/state', async (req) => {
    links.setChapterState(req.body.chapterIds, req.body.state);
    return { ok: true };
  });

  // ---- Downloads (chapter ZIPs the user uploads to atsu.moe by hand) ----
  app.get('/api/downloads', async () => pipeline.list());
  app.post<{ Body: { chapterIds: number[] } }>('/api/downloads', async (req) => pipeline.enqueue(req.body.chapterIds));
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
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(createReadStream(file.path));
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

  // ---- Built Vue app ----
  if (opts.webDist && existsSync(opts.webDist)) {
    app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  let syncTimer: NodeJS.Timeout | null = null;
  app.addHook('onReady', async () => {
    if (opts.background === false) return;
    watcher.start();
    presence.start();
    pipeline.pump();
    void runSync(true).catch((e) => app.log.warn(`Request sync failed: ${e.message}`));
    // A quick sync only sees new posts; status tags (Added, Duplicate…) change on old ones, which
    // is what removes a post's upload button, so walk the whole forum (~15 pages) every few hours.
    let ticks = 0;
    syncTimer = setInterval(() => void runSync(++ticks % 12 === 0).catch(() => {}), 15 * 60_000);
  });
  app.addHook('onClose', async () => {
    watcher.stop();
    presence.stop();
    if (syncTimer) clearInterval(syncTimer);
    db.close();
  });

  return { app, db, settings, atsu, requests, sources, discovery, links, pipeline, watcher, presence };
}

export const defaultWebDist = join(import.meta.dirname, '../../web/dist');
