import { inRanges, type ChapterState, type Link, type LinkChapter, type SourceSeries } from '@atsusync/shared';
import type { Db } from './db/client.ts';
import { tx } from './db/client.ts';
import type { SourceRegistry } from './sources/registry.ts';

interface LinkRow {
  id: number;
  request_id: string;
  request_title: string;
  source_id: string;
  series_url: string;
  series_title: string;
  atsu_manga_id: string | null;
  watch: number;
  check_interval_min: number;
  last_checked_at: number | null;
  next_check_at: number | null;
  last_error: string | null;
  pending_count: number;
  chapter_count: number;
}

interface ChapterRow {
  id: number;
  link_id: number;
  number: number;
  label: string;
  url: string;
  locked: number;
  state: ChapterState;
  first_seen_at: number;
}

const LINK_SELECT = `
  SELECT l.*, r.title AS request_title,
    (SELECT COUNT(*) FROM source_chapters c WHERE c.link_id = l.id AND c.state = 'pending') AS pending_count,
    (SELECT COUNT(*) FROM source_chapters c WHERE c.link_id = l.id) AS chapter_count
  FROM links l JOIN requests r ON r.id = l.request_id`;

export class LinksRepo {
  constructor(
    private db: Db,
    private sources: SourceRegistry,
  ) {}

  list(filter: { requestId?: string } = {}): Link[] {
    const rows = (
      filter.requestId
        ? this.db.prepare(`${LINK_SELECT} WHERE l.request_id = ? ORDER BY l.created_at DESC`).all(filter.requestId)
        : this.db.prepare(`${LINK_SELECT} ORDER BY pending_count DESC, l.created_at DESC`).all()
    ) as unknown as LinkRow[];
    return rows.map((r) => this.toLink(r));
  }

  get(id: number): Link | null {
    const row = this.db.prepare(`${LINK_SELECT} WHERE l.id = ?`).get(id) as unknown as LinkRow | undefined;
    return row ? this.toLink(row) : null;
  }

  dueForCheck(now = Date.now()): Link[] {
    const rows = this.db
      .prepare(`${LINK_SELECT} WHERE l.watch = 1 AND (l.next_check_at IS NULL OR l.next_check_at <= ?) ORDER BY l.next_check_at`)
      .all(now) as unknown as LinkRow[];
    return rows.map((r) => this.toLink(r));
  }

  async create(input: { requestId: string; sourceId: string; seriesUrl: string; atsuMangaId?: string | null; checkIntervalMin: number }) {
    const adapter = this.sources.get(input.sourceId);
    const series = await adapter.getSeries(input.seriesUrl, this.sources.http);
    const now = Date.now();
    const id = tx(this.db, () => {
      const res = this.db
        .prepare(
          `INSERT INTO links (request_id, source_id, series_url, series_title, atsu_manga_id, watch, check_interval_min,
             last_checked_at, next_check_at, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          input.requestId,
          input.sourceId,
          series.url,
          series.title,
          input.atsuMangaId ?? null,
          input.checkIntervalMin,
          now,
          nextCheck(now, input.checkIntervalMin),
          now,
        );
      const linkId = Number(res.lastInsertRowid);
      // Everything present at link time is the baseline; only later arrivals become "pending".
      this.applySeries(linkId, series, 'known');
      return linkId;
    });
    return this.get(id)!;
  }

  update(id: number, patch: { watch?: boolean; checkIntervalMin?: number; atsuMangaId?: string | null }) {
    if (patch.watch !== undefined) this.db.prepare('UPDATE links SET watch = ? WHERE id = ?').run(patch.watch ? 1 : 0, id);
    if (patch.checkIntervalMin !== undefined) {
      const min = Math.max(10, Math.round(patch.checkIntervalMin));
      this.db.prepare('UPDATE links SET check_interval_min = ?, next_check_at = ? WHERE id = ?').run(min, nextCheck(Date.now(), min), id);
    }
    if (patch.atsuMangaId !== undefined) this.db.prepare('UPDATE links SET atsu_manga_id = ? WHERE id = ?').run(patch.atsuMangaId, id);
  }

  delete(id: number) {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
  }

  /** Insert chapters not seen before. Returns the newly inserted ones. */
  applySeries(linkId: number, series: SourceSeries, newState: ChapterState): LinkChapter[] {
    const existing = new Map(
      (this.db.prepare('SELECT id, number, locked, url, label FROM source_chapters WHERE link_id = ?').all(linkId) as unknown as ChapterRow[]).map(
        (r) => [r.number, r],
      ),
    );
    const insert = this.db.prepare(
      `INSERT INTO source_chapters (link_id, number, label, url, locked, state, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const refresh = this.db.prepare('UPDATE source_chapters SET label = ?, url = ?, locked = ? WHERE id = ?');
    const added: number[] = [];
    const now = Date.now();
    for (const c of series.chapters) {
      const prev = existing.get(c.number);
      if (prev) {
        // Locked/early-access chapters unlock over time; keep the row current.
        if (prev.locked !== (c.locked ? 1 : 0) || prev.url !== c.url || prev.label !== c.label) refresh.run(c.label, c.url, c.locked ? 1 : 0, prev.id);
        continue;
      }
      const res = insert.run(linkId, c.number, c.label, c.url, c.locked ? 1 : 0, newState, now);
      added.push(Number(res.lastInsertRowid));
    }
    this.db.prepare('UPDATE links SET series_title = ? WHERE id = ?').run(series.title, linkId);
    return added.length ? this.chapters(linkId).filter((c) => added.includes(c.id)) : [];
  }

  markChecked(id: number, error: string | null) {
    const link = this.get(id);
    if (!link) return;
    const now = Date.now();
    this.db
      .prepare('UPDATE links SET last_checked_at = ?, next_check_at = ?, last_error = ? WHERE id = ?')
      .run(now, nextCheck(now, link.checkIntervalMin), error, id);
  }

  /** `atsuRanges`: chapter ranges Atsumaru already has (published or in review). */
  chapters(linkId: number, atsuRanges: [number, number][] = []): LinkChapter[] {
    const rows = this.db
      .prepare('SELECT * FROM source_chapters WHERE link_id = ? ORDER BY number')
      .all(linkId) as unknown as ChapterRow[];
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      label: r.label,
      url: r.url,
      locked: !!r.locked,
      state: r.state,
      onAtsu: inRanges(r.number, atsuRanges),
      firstSeenAt: r.first_seen_at,
    }));
  }

  chapter(id: number) {
    return this.db.prepare('SELECT * FROM source_chapters WHERE id = ?').get(id) as unknown as ChapterRow | undefined;
  }

  setChapterState(ids: number[], state: ChapterState) {
    const stmt = this.db.prepare('UPDATE source_chapters SET state = ? WHERE id = ?');
    tx(this.db, () => ids.forEach((id) => stmt.run(state, id)));
  }

  /** Pending chapters that already exist on Atsumaru (uploaded by someone else) are skipped. */
  skipChaptersOnAtsu(linkId: number, atsuRanges: [number, number][]) {
    const ids = this.chapters(linkId, atsuRanges)
      .filter((c) => c.onAtsu && c.state === 'pending')
      .map((c) => c.id);
    if (ids.length) this.setChapterState(ids, 'skipped');
    return ids.length;
  }

  private toLink(r: LinkRow): Link {
    const adapter = this.sources.find(r.source_id);
    const sourceName = adapter?.name ?? r.source_id;
    const sourceKind = adapter?.kind ?? 'scanlation';
    return {
      id: r.id,
      requestId: r.request_id,
      requestTitle: r.request_title,
      sourceId: r.source_id,
      sourceName,
      sourceKind,
      seriesUrl: r.series_url,
      seriesTitle: r.series_title,
      atsuMangaId: r.atsu_manga_id,
      watch: !!r.watch,
      checkIntervalMin: r.check_interval_min,
      lastCheckedAt: r.last_checked_at,
      lastError: r.last_error,
      pendingCount: r.pending_count,
      chapterCount: r.chapter_count,
    };
  }
}

/** Next check time with ±10% jitter so many links don't all fire together. */
export function nextCheck(from: number, intervalMin: number) {
  const ms = intervalMin * 60_000;
  return Math.round(from + ms * (0.9 + Math.random() * 0.2));
}
