import { join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ContentRequest, Settings, SettingsView } from '@atsusync/shared';
import { AtsuClient, emptySeriesState } from './atsu/client.ts';
import { RequestsRepo, syncRequests } from './atsu/requests.ts';
import { getMangaBakaSeries } from './atsu/mangabaka.ts';
import { openDb, type Db } from './db/client.ts';
import { events } from './events.ts';
import { LinksRepo } from './links.ts';
import { SettingsStore } from './settings.ts';
import { Discovery } from './sources/discovery.ts';
import { SourceRegistry } from './sources/registry.ts';
import { SourceHttp } from './sources/http.ts';
import type { SourceAdapter } from './sources/types.ts';
import { UploadPipeline } from './upload/pipeline.ts';
import { Watcher } from './watcher/watcher.ts';

export interface AppOptions {
  dbFile: string;
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
  const pipeline = new UploadPipeline(db, links, sources, atsu, settings);
  const watcher = new Watcher(links, sources, atsu);

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

  app.get('/api/atsu/groups', async () => {
    const w = (await atsu.getUploadWorkspace()) as { groups?: { id: string; name: string }[]; canPublish?: boolean };
    return { groups: (w.groups ?? []).map((g) => ({ id: g.id, name: g.name })), canPublish: !!w.canPublish };
  });

  // ---- Requests ----
  let syncing: Promise<unknown> | null = null;
  const runSync = (full: boolean) => {
    syncing ??= syncRequests(atsu, requests, db, { full })
      .then((r) => {
        events.emitEvent({ type: 'requests_synced', added: r.added });
        return r;
      })
      .finally(() => (syncing = null));
    return syncing;
  };
  app.get('/api/requests', async () => requests.list());
  app.post<{ Querystring: { full?: string } }>('/api/requests/sync', async (req) => runSync(req.query.full === '1'));
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (req) => {
    // Refresh this one post so status tags are current when looking at it.
    const fresh = await atsu.getPost(req.params.id).catch(() => null);
    const post = fresh?.post ?? (fresh?.id ? fresh : null);
    if (post && post.id && post.createdAt) requests.upsertPost(post as Parameters<typeof requests.upsertPost>[0]);
    const r = mustRequest(req.params.id);
    const mangabaka = r.mangabakaId ? await getMangaBakaSeries(r.mangabakaId).catch(() => null) : null;
    return { request: r, mangabaka, matches: discovery.cached(r.id), links: links.list({ requestId: r.id }) };
  });
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
  app.post<{ Body: { chapterIds: number[]; state: 'skipped' | 'known' | 'pending' } }>('/api/chapters/state', async (req) => {
    links.setChapterState(req.body.chapterIds, req.body.state);
    return { ok: true };
  });

  // ---- Uploads ----
  app.get('/api/uploads', async () => pipeline.list());
  app.post<{ Body: { chapterIds: number[] } }>('/api/uploads', async (req) => pipeline.enqueue(req.body.chapterIds));
  app.post<{ Params: { id: string } }>('/api/uploads/:id/retry', async (req) => {
    pipeline.retry(Number(req.params.id));
    return pipeline.get(Number(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/uploads/:id/cancel', async (req) => {
    pipeline.cancel(Number(req.params.id));
    return pipeline.get(Number(req.params.id));
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
    pipeline.pump();
    void runSync(false).catch((e) => app.log.warn(`Request sync failed: ${e.message}`));
    syncTimer = setInterval(() => void runSync(false).catch(() => {}), 15 * 60_000);
  });
  app.addHook('onClose', async () => {
    watcher.stop();
    if (syncTimer) clearInterval(syncTimer);
    db.close();
  });

  return { app, db, settings, atsu, requests, sources, discovery, links, pipeline, watcher };
}

export const defaultWebDist = join(import.meta.dirname, '../../web/dist');
