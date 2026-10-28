import type { ContentRequest, SourceMatch } from '@atsusync/shared';
import type { Db } from '../db/client.ts';
import { tx } from '../db/client.ts';
import { getMangaBakaSeries } from '../atsu/mangabaka.ts';
import { bestScore, searchQueries } from './match.ts';
import type { SourceRegistry } from './registry.ts';
import type { SourceAdapter, SourceSeriesHit } from './types.ts';

const MIN_SCORE = 0.45;
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

  async titlesFor(req: ContentRequest): Promise<string[]> {
    const titles = [req.title, ...req.altTitles];
    if (req.mangabakaId) {
      const mb = await getMangaBakaSeries(req.mangabakaId).catch(() => null);
      if (mb) titles.push(mb.title, ...mb.titles);
    }
    return titles.filter(Boolean);
  }

  async find(req: ContentRequest): Promise<SourceMatch[]> {
    const titles = await this.titlesFor(req);
    const queries = searchQueries(titles);
    const results = await Promise.all(this.sources.enabled().filter((a) => a.search).map((a) => this.searchOne(a, titles, queries)));
    const rows = results.flat().map((m) => ({ ...m, request_id: req.id }));
    tx(this.db, () => {
      this.db.prepare('DELETE FROM source_matches WHERE request_id = ?').run(req.id);
      for (const r of rows) this.insert(r);
    });
    return this.cached(req.id);
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

  private async searchOne(adapter: SourceAdapter, titles: string[], queries: string[]): Promise<Omit<MatchRow, 'request_id'>[]> {
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
            return {
              ...base,
              title: s.title,
              cover: s.cover ?? base.cover,
              score: Math.max(score, bestScore(titles, [s.title, ...s.altTitles])),
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
