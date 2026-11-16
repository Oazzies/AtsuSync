import type { ContentRequest, MangaBaka, SourceMatch } from '@atsusync/shared';
import type { Db } from '../db/client.ts';
import { tx } from '../db/client.ts';
import { events } from '../events.ts';
import { getMangaBakaSeries, searchMangaBakaSeries } from '../atsu/mangabaka.ts';
import { wantsNovel } from '../atsu/presence.ts';
import { bestScore, searchQueries } from './match.ts';
import type { SourceRegistry } from './registry.ts';
import { mediumOf, type SourceAdapter, type SourceSeriesHit } from './types.ts';

const MIN_SCORE = 0.62;
const MAX_HITS_PER_SOURCE = 3;

interface MatchRow {
  request_id: string;
  source_id: string;
  series_url: string;
  title: string;
  cover: string | null;
  score: number;
  chapter_count: number | null;
  latest_chapter: number | null;
  error: string | null;
  fetched_at: number;
}

/**
 * On-demand lookup of which enabled sources carry a request's series. Nothing here runs
 * in the background — only when the user presses "Find sources" on a request.
 */
export class Discovery {
  constructor(
    private db: Db,
    private sources: SourceRegistry,
  ) {}

  cached(requestId: string): SourceMatch[] {
    const rows = this.db
      .prepare('SELECT * FROM source_matches WHERE request_id = ? ORDER BY score DESC')
      .all(requestId) as unknown as MatchRow[];
    // "(search failed)" rows left over from before a source lost its search can never be refreshed; hide and purge them.
    const stale = rows.filter((r) => r.series_url.endsWith('#search-error') && !this.sources.find(r.source_id)?.search);
    if (stale.length) {
      for (const r of stale) this.db.prepare('DELETE FROM source_matches WHERE request_id = ? AND source_id = ? AND series_url = ?').run(r.request_id, r.source_id, r.series_url);
    }
    return rows.filter((r) => !stale.includes(r)).map((r) => this.rowToMatch(r));
  }

  async resolveMangaBaka(req: ContentRequest): Promise<MangaBaka | null> {
    if (req.mangabakaId) {
      return getMangaBakaSeries(req.mangabakaId).catch(() => null);
    }
    const medium = wantsNovel(req) ? 'novel' : 'comic';
    return searchMangaBakaSeries([req.title, ...req.altTitles].filter(Boolean), medium).catch(() => null);
  }

  async titlesFor(req: ContentRequest, mb?: MangaBaka | null): Promise<string[]> {
    const resolved = mb === undefined ? await this.resolveMangaBaka(req) : mb;
    const titles = [
      ...(resolved ? [resolved.title, ...resolved.titles] : []),
      req.title,
      ...req.altTitles,
    ];
    return titles.filter(Boolean);
  }

  async find(req: ContentRequest): Promise<SourceMatch[]> {
    const mb = await this.resolveMangaBaka(req);
    const titles = await this.titlesFor(req, mb);
    const queries = searchQueries(titles);
    // A Novel request only searches novel sources; comic requests never search them.
    const medium = wantsNovel(req) ? 'novel' : 'comic';
    const adapters = this.sources.enabled().filter((a) => a.search && mediumOf(a) === medium);
    events.emitEvent({
      type: 'discovery_start',
      requestId: req.id,
      sources: adapters.map((a) => ({ id: a.id, name: a.name })),
    });
    try {
      const results = await Promise.all(
        adapters.map(async (a) => {
          const found = await this.searchOne(a, titles, queries, mb);
          const searchError = found.length === 1 && found[0]!.series_url.endsWith('#search-error') ? found[0]!.error : null;
          const valid = searchError ? [] : found;
          events.emitEvent({
            type: 'discovery_progress',
            requestId: req.id,
            sourceId: a.id,
            sourceName: a.name,
            matches: valid.map((r) => this.rowToMatch({ ...r, request_id: req.id })),
            error: searchError,
          });
          return valid;
        }),
      );
      const rows = results.flat().map((m) => ({ ...m, request_id: req.id }));
      tx(this.db, () => {
        this.db.prepare('DELETE FROM source_matches WHERE request_id = ?').run(req.id);
        for (const r of rows) this.insert(r);
      });
      return this.cached(req.id);
    } finally {
      events.emitEvent({ type: 'discovery_done', requestId: req.id });
    }
  }

  /** Manually attach a series by pasting its URL on a supported site. */
  async addByUrl(req: ContentRequest, url: string): Promise<SourceMatch> {
    const adapter = this.sources.forUrl(url);
    if (!adapter) throw new Error('No supported source for that URL');
    const series = await adapter.getSeries(url, this.sources.http);
    if (series.chapters.length === 0) throw new Error(`${adapter.name} has no chapters to upload: ${series.emptyReason ?? 'the series is empty'}`);
    const titles = await this.titlesFor(req);
    const row: MatchRow = {
      request_id: req.id,
      source_id: adapter.id,
      series_url: series.url,
      title: series.title,
      cover: series.cover ?? null,
      score: bestScore(titles, [series.title, ...series.altTitles]),
      chapter_count: series.chapters.length,
      latest_chapter: series.chapters.at(-1)?.number ?? null,
      error: null,
      fetched_at: Date.now(),
    };
    this.insert(row);
    return this.rowToMatch(row);
  }

  private async searchOne(
    adapter: SourceAdapter,
    titles: string[],
    queries: string[],
    mb: MangaBaka | null = null,
  ): Promise<Omit<MatchRow, 'request_id'>[]> {
    try {
      const hits = new Map<string, SourceSeriesHit>();
      for (const q of queries) {
        for (const h of await adapter.search!(q, this.sources.http)) if (!hits.has(h.url)) hits.set(h.url, h);
      }
      const scored = [...hits.values()]
        .map((h) => ({ h, score: bestScore(titles, [h.title, ...(h.altTitles ?? [])]) }))
        .filter((x) => x.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_HITS_PER_SOURCE);

      const rows = await Promise.all(
        scored.map(async ({ h, score }) => {
          const base = { source_id: adapter.id, series_url: h.url, title: h.title, cover: h.cover ?? null, fetched_at: Date.now() };
          try {
            const s = await adapter.getSeries(h.url, this.sources.http);
            // The site knows the series but has nothing to upload (e.g. MangaDex without English chapters).
            if (s.chapters.length === 0) return null;
            let finalScore = Math.max(score, bestScore(titles, [s.title, ...s.altTitles]));
            if (mb?.totalChapters && s.chapters.length > mb.totalChapters * 2.5 + 10) {
              finalScore = Math.round(finalScore * 0.75 * 100) / 100;
            }
            if (finalScore < MIN_SCORE) return null;
            return {
              ...base,
              title: s.title,
              cover: s.cover ?? base.cover,
              score: finalScore,
              chapter_count: s.chapters.length,
              latest_chapter: s.chapters.at(-1)?.number ?? null,
              error: null,
            };
          } catch (err) {
            return { ...base, score, chapter_count: null, latest_chapter: null, error: String((err as Error).message) };
          }
        }),
      );
      return rows.filter((r) => r !== null);
    } catch (err) {
      return [
        {
          source_id: adapter.id,
          series_url: `${adapter.baseUrl}#search-error`,
          title: '(search failed)',
          cover: null,
          score: 0,
          chapter_count: null,
          latest_chapter: null,
          error: String((err as Error).message),
          fetched_at: Date.now(),
        },
      ];
    }
  }

  private insert(r: MatchRow) {
    this.db
      .prepare(
        `INSERT INTO source_matches (request_id, source_id, series_url, title, cover, score, chapter_count, latest_chapter, error, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id, source_id, series_url) DO UPDATE SET title = excluded.title, cover = excluded.cover,
           score = excluded.score, chapter_count = excluded.chapter_count, latest_chapter = excluded.latest_chapter,
           error = excluded.error, fetched_at = excluded.fetched_at`,
      )
      .run(r.request_id, r.source_id, r.series_url, r.title, r.cover, r.score, r.chapter_count, r.latest_chapter, r.error, r.fetched_at);
  }

  private rowToMatch(r: MatchRow): SourceMatch {
    const adapter = this.sources.find(r.source_id);
    const sourceName = adapter?.name ?? r.source_id;
    const sourceKind = adapter?.kind ?? 'scanlation';
    return {
      sourceId: r.source_id,
      sourceName,
      sourceKind,
      seriesUrl: r.series_url,
      title: r.title,
      cover: r.cover,
      score: r.score,
      chapterCount: r.chapter_count,
      latestChapter: r.latest_chapter,
      error: r.error,
      fetchedAt: r.fetched_at,
    };
  }
}
