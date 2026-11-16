import { inRanges, type AtsuPresence, type AtsuSeriesState, type ChapterState, type Link, type LinkChapter, type SourceChapterAlt, type SourceSeries } from '@atsusync/shared';
import type { Db } from './db/client.ts';
import { tx } from './db/client.ts';
import type { SourceRegistry } from './sources/registry.ts';

interface LinkRow {
  id: number;
  request_id: string;
  request_title: string;
  request_atsu_manga_id: string | null;
  request_presence_json: string | null;
  source_id: string;
  series_url: string;
  series_title: string;
  cover: string | null;
  atsu_manga_id: string | null;
  atsu_ranges_json: string | null;
  atsu_total: number | null;
  atsu_checked_at: number | null;
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
  source_group: string | null;
  alternatives_json: string | null;
  state: ChapterState;
  first_seen_at: number;
}

const parseAlts = (raw: string | null): SourceChapterAlt[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseRanges = (raw: string | null): [number, number][] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const LINK_SELECT = `
  SELECT l.*, r.title AS request_title,
    r.atsu_manga_id AS request_atsu_manga_id,
    r.presence_json AS request_presence_json,
    COALESCE(
      l.cover,
      (SELECT sm.cover FROM source_matches sm WHERE sm.request_id = l.request_id AND sm.source_id = l.source_id AND sm.series_url = l.series_url LIMIT 1),
      r.cover
    ) AS cover,
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
    return this.mapLinks(rows);
  }

  get(id: number): Link | null {
    const row = this.db.prepare(`${LINK_SELECT} WHERE l.id = ?`).get(id) as unknown as LinkRow | undefined;
    return row ? this.mapLinks([row])[0]! : null;
  }

  dueForCheck(now = Date.now()): Link[] {
    const rows = this.db
      .prepare(`${LINK_SELECT} WHERE l.watch = 1 AND (l.next_check_at IS NULL OR l.next_check_at <= ?) ORDER BY l.next_check_at`)
      .all(now) as unknown as LinkRow[];
    return this.mapLinks(rows);
  }

  async create(input: { requestId: string; sourceId: string; seriesUrl: string; atsuMangaId?: string | null; checkIntervalMin: number }) {
    const adapter = this.sources.get(input.sourceId);
    const series = await adapter.getSeries(input.seriesUrl, this.sources.http);
    const now = Date.now();
    const id = tx(this.db, () => {
      const res = this.db
        .prepare(
          `INSERT INTO links (request_id, source_id, series_url, series_title, cover, atsu_manga_id, watch, check_interval_min,
             last_checked_at, next_check_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          input.requestId,
          input.sourceId,
          series.url,
          series.title,
          series.cover ?? null,
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

  setAtsuState(id: number, state: AtsuSeriesState) {
    const now = Date.now();
    if (state.found) {
      const ranges = [...state.ranges, ...state.waiting];
      this.db
        .prepare('UPDATE links SET atsu_ranges_json = ?, atsu_total = ?, atsu_checked_at = ?, atsu_manga_id = COALESCE(atsu_manga_id, ?) WHERE id = ?')
        .run(JSON.stringify(ranges), state.total, now, state.mangaId, id);
    } else if (!state.error) {
      this.db.prepare('UPDATE links SET atsu_ranges_json = ?, atsu_total = NULL, atsu_checked_at = ? WHERE id = ?').run('[]', now, id);
    }
  }

  delete(id: number) {
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
  }

  /** Insert chapters not seen before. `added` are the new rows; `unlocked` are known chapters that just went from paid to free. */
  applySeries(linkId: number, series: SourceSeries, newState: ChapterState): { added: LinkChapter[]; unlocked: LinkChapter[] } {
    const existing = new Map(
      (
        this.db
          .prepare('SELECT id, number, locked, url, label, source_group, alternatives_json FROM source_chapters WHERE link_id = ?')
          .all(linkId) as unknown as ChapterRow[]
      ).map((r) => [r.number, r]),
    );
    const insert = this.db.prepare(
      `INSERT INTO source_chapters (link_id, number, label, url, locked, source_group, alternatives_json, state, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const refresh = this.db.prepare(
      'UPDATE source_chapters SET label = ?, url = ?, locked = ?, source_group = ?, alternatives_json = ? WHERE id = ?',
    );
    const added: number[] = [];
    const unlocked: number[] = [];
    const now = Date.now();
    for (const c of series.chapters) {
      const group = c.group ?? null;
      const alts = c.alternatives ?? [];
      const prev = existing.get(c.number);
      if (prev) {
        // If the user explicitly switched this chapter to an alternative group's upload, keep that
        // choice active and keep the primary + other alternatives in `alternatives_json`.
        const chosenAlt = alts.find((a) => a.url === prev.url);
        const nextUrl = chosenAlt ? chosenAlt.url : c.url;
        const nextLabel = chosenAlt ? (chosenAlt.label ?? prev.label) : c.label;
        const nextGroup = chosenAlt ? chosenAlt.group : group;
        const nextAlts = chosenAlt
          ? [{ group: group ?? 'Default', url: c.url, label: c.label, title: c.title, date: c.date }, ...alts.filter((a) => a.url !== prev.url)]
          : alts;
        const altsJson = nextAlts.length ? JSON.stringify(nextAlts) : null;
        // Locked/early-access chapters unlock over time; keep the row current.
        if (
          prev.locked !== (c.locked ? 1 : 0) ||
          prev.url !== nextUrl ||
          prev.label !== nextLabel ||
          prev.source_group !== nextGroup ||
          prev.alternatives_json !== altsJson
        ) {
          refresh.run(nextLabel, nextUrl, c.locked ? 1 : 0, nextGroup, altsJson, prev.id);
        }
        if (prev.locked && !c.locked) unlocked.push(prev.id);
        continue;
      }
      const altsJson = alts.length ? JSON.stringify(alts) : null;
      const res = insert.run(linkId, c.number, c.label, c.url, c.locked ? 1 : 0, group, altsJson, newState, now);
      added.push(Number(res.lastInsertRowid));
    }
    this.db.prepare('UPDATE links SET series_title = ?, cover = COALESCE(?, cover) WHERE id = ?').run(series.title, series.cover ?? null, linkId);
    if (!added.length && !unlocked.length) return { added: [], unlocked: [] };
    const rows = this.chapters(linkId);
    return { added: rows.filter((c) => added.includes(c.id)), unlocked: rows.filter((c) => unlocked.includes(c.id)) };
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
    return rows.map((r) => this.toChapter(r, atsuRanges));
  }

  private toChapter(r: ChapterRow, atsuRanges: [number, number][] = []): LinkChapter {
    return {
      id: r.id,
      number: r.number,
      label: r.label,
      url: r.url,
      locked: !!r.locked,
      group: r.source_group ?? null,
      alternatives: parseAlts(r.alternatives_json),
      state: r.state,
      onAtsu: inRanges(r.number, atsuRanges),
      firstSeenAt: r.first_seen_at,
    };
  }

  /** Switch a chapter's active URL/group to one of its recorded alternative uploads. */
  setChapterSource(chapterId: number, url: string): LinkChapter {
    const row = this.chapter(chapterId);
    if (!row) throw Object.assign(new Error('Chapter not found'), { statusCode: 404 });
    const alts = parseAlts(row.alternatives_json);
    const chosen = alts.find((a) => a.url === url);
    if (!chosen) throw Object.assign(new Error('Alternative source not found for this chapter'), { statusCode: 400 });
    const nextAlts: SourceChapterAlt[] = [
      { group: row.source_group ?? 'Default', url: row.url, label: row.label },
      ...alts.filter((a) => a.url !== url),
    ];
    const nextLabel = chosen.label ?? row.label;
    this.db
      .prepare('UPDATE source_chapters SET url = ?, label = ?, source_group = ?, alternatives_json = ? WHERE id = ?')
      .run(chosen.url, nextLabel, chosen.group, JSON.stringify(nextAlts), chapterId);
    return this.toChapter(this.chapter(chapterId)!);
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

  private mapLinks(rows: LinkRow[]): Link[] {
    if (!rows.length) return [];
    const rangesByLink = new Map<number, [number, number][]>();
    for (const r of rows) rangesByLink.set(r.id, parseRanges(r.atsu_ranges_json));
    const missing = new Map<number, number>();
    const chapterRows = (
      rows.length === 1
        ? this.db.prepare("SELECT link_id, number FROM source_chapters WHERE link_id = ? AND state NOT IN ('uploaded', 'skipped')").all(rows[0]!.id)
        : this.db.prepare("SELECT link_id, number FROM source_chapters WHERE state NOT IN ('uploaded', 'skipped')").all()
    ) as unknown as { link_id: number; number: number }[];
    for (const c of chapterRows) {
      const ranges = rangesByLink.get(c.link_id);
      if (ranges && !inRanges(c.number, ranges)) {
        missing.set(c.link_id, (missing.get(c.link_id) ?? 0) + 1);
      }
    }
    return rows.map((r) => this.toLink(r, missing.get(r.id) ?? 0));
  }

  private toLink(r: LinkRow, missingCount: number): Link {
    const adapter = this.sources.find(r.source_id);
    const sourceName = adapter?.name ?? r.source_id;
    const sourceKind = adapter?.kind ?? 'scanlation';
    let atsuMangaId = r.atsu_manga_id ?? r.request_atsu_manga_id ?? null;
    if (!atsuMangaId && r.request_presence_json) {
      try {
        const presence = JSON.parse(r.request_presence_json) as AtsuPresence;
        if (presence.verdict === 'on_atsu' && presence.match?.mangaId) {
          atsuMangaId = presence.match.mangaId;
        }
      } catch {
        /* ignore malformed cached presence */
      }
    }
    return {
      id: r.id,
      requestId: r.request_id,
      requestTitle: r.request_title,
      sourceId: r.source_id,
      sourceName,
      sourceKind,
      seriesUrl: r.series_url,
      seriesTitle: r.series_title,
      cover: r.cover ?? null,
      atsuMangaId,
      watch: !!r.watch,
      checkIntervalMin: r.check_interval_min,
      lastCheckedAt: r.last_checked_at,
      lastError: r.last_error,
      pendingCount: r.pending_count,
      chapterCount: r.chapter_count,
      atsuTotal: r.atsu_total ?? null,
      atsuCheckedAt: r.atsu_checked_at ?? null,
      missingCount,
    };
  }
}

/** Next check time with ±10% jitter so many links don't all fire together. */
export function nextCheck(from: number, intervalMin: number) {
  const ms = intervalMin * 60_000;
  return Math.round(from + ms * (0.9 + Math.random() * 0.2));
}
