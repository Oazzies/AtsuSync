import { mkdirSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChapterState, DownloadJob, JobState } from '@atsusync/shared';
import { uploadMangaBakaId } from '../atsu/requests.ts';
import type { Db } from '../db/client.ts';
import { events } from '../events.ts';
import type { LinksRepo } from '../links.ts';
import type { SourceRegistry } from '../sources/registry.ts';
import { looksLikeImage, mergeSliverPages, type PageFile } from './fixups.ts';
import { createZip } from './zip.ts';

interface JobRow {
  id: number;
  link_id: number;
  chapter_id: number;
  state: JobState;
  progress: number;
  total: number;
  error: string | null;
  log_json: string;
  file_path: string | null;
  file_size: number | null;
  created_at: number;
  updated_at: number;
  chapter_label: string;
  series_title: string;
  source_id: string;
  content: string;
  mangabaka_id: string | null;
}

const JOB_SELECT = `
  SELECT j.*, c.label AS chapter_label, l.series_title, l.source_id, r.content, r.mangabaka_id
  FROM upload_jobs j JOIN source_chapters c ON c.id = j.chapter_id JOIN links l ON l.id = j.link_id JOIN requests r ON r.id = l.request_id`;

const ACTIVE: JobState[] = ['queued', 'downloading'];
const PAGE_PARALLELISM = 6;

/** Chapters built by hand from uploaded images have no page on the source site. */
export const MANUAL_URL_PREFIX = 'manual:';
export const isManualUrl = (url: string) => url.startsWith(MANUAL_URL_PREFIX);

/** Strip characters Windows/macOS/Linux reject in file names. */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80) || 'untitled';

type FinishedRow = { id: number; chapter_id: number; state: JobState; file_path: string | null; prev_chapter_state: ChapterState };

/**
 * Download queue persisted in SQLite: resolve pages → download → bundle into a ZIP under
 * `<dir>/<series>/`. Nothing is ever sent to Atsumaru; the user uploads the ZIP by hand on
 * atsu.moe/upload. Runs at most `concurrency` jobs and never two for the same link, so a
 * series' chapters finish in order.
 */
export class DownloadPipeline {
  private running = new Set<number>();
  private busyLinks = new Set<number>();
  private cancelled = new Set<number>();

  constructor(
    private db: Db,
    private links: LinksRepo,
    private sources: SourceRegistry,
    private dir: string,
    private concurrency = 2,
  ) {
    // Jobs interrupted by a restart go back to the queue.
    this.db.prepare(`UPDATE upload_jobs SET state = 'queued', progress = 0 WHERE state NOT IN ('queued','done','failed','cancelled')`).run();
  }

  list(opts: { linkId?: number; limit?: number } = {}): DownloadJob[] {
    const { linkId, limit = 500 } = opts;
    const rows = (
      linkId === undefined
        ? this.db.prepare(`${JOB_SELECT} ORDER BY j.id DESC LIMIT ?`).all(limit)
        : this.db.prepare(`${JOB_SELECT} WHERE j.link_id = ? ORDER BY j.id DESC LIMIT ?`).all(linkId, limit)
    ) as unknown as JobRow[];
    return rows.map((r) => this.toJob(r));
  }

  get(id: number): DownloadJob | null {
    const r = this.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as unknown as JobRow | undefined;
    return r ? this.toJob(r) : null;
  }

  /** The ZIP on disk for a finished job, with the name to offer in the browser. */
  file(id: number): { path: string; name: string } | null {
    const job = this.get(id);
    const row = this.db.prepare('SELECT file_path FROM upload_jobs WHERE id = ?').get(id) as { file_path: string | null } | undefined;
    if (!job || job.state !== 'done' || !row?.file_path) return null;
    try {
      statSync(row.file_path);
    } catch {
      return null;
    }
    return { path: row.file_path, name: `${safeName(job.seriesTitle)} - ${safeName(job.chapterLabel)}.zip` };
  }

  enqueue(chapterIds: number[]): DownloadJob[] {
    const created: number[] = [];
    for (const chapterId of chapterIds) {
      const ch = this.links.chapter(chapterId);
      if (!ch) throw new Error(`Unknown chapter ${chapterId}`);
      if (ch.locked) throw new Error(`${ch.label} is locked on the source`);
      if (isManualUrl(ch.url)) throw new Error(`${ch.label} was added by hand and has no source page; use "Add chapter" to rebuild it`);
      const active = this.db
        .prepare(`SELECT 1 FROM upload_jobs WHERE chapter_id = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`)
        .get(chapterId, ...ACTIVE);
      if (active) continue;
      const now = Date.now();
      const res = this.db
        .prepare(
          `INSERT INTO upload_jobs (link_id, chapter_id, state, dry_run, prev_chapter_state, created_at, updated_at)
           VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
        )
        .run(ch.link_id, chapterId, ch.state === 'queued' ? 'known' : ch.state, now, now);
      this.links.setChapterState([chapterId], 'queued');
      created.push(Number(res.lastInsertRowid));
    }
    const jobs = created.map((id) => this.get(id)!);
    jobs.forEach((j) => events.emitEvent({ type: 'job', job: j }));
    this.pump();
    return jobs;
  }

  /**
   * Register a chapter built from images the user supplied: it becomes a source chapter on the link
   * (or fills in an existing one with that number) and a finished download, exactly like a scraped one.
   */
  addManual(input: { linkId: number; number: number; label: string; files: PageFile[] }): DownloadJob {
    const link = this.links.get(input.linkId);
    if (!link) throw new Error('Unknown link');
    if (!Number.isFinite(input.number) || input.number < 0) throw new Error('Chapter number must be a positive number');
    if (input.files.length === 0) throw new Error('Add at least one page');
    const label = input.label.trim() || `Chapter ${input.number}`;

    const existing = this.db.prepare('SELECT id, state FROM source_chapters WHERE link_id = ? AND number = ?').get(input.linkId, input.number) as
      | { id: number; state: ChapterState }
      | undefined;
    if (existing) {
      const active = this.db
        .prepare(`SELECT 1 FROM upload_jobs WHERE chapter_id = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`)
        .get(existing.id, ...ACTIVE);
      if (active) throw new Error(`Chapter ${input.number} is being downloaded right now; wait for it or cancel it first`);
    }

    const now = Date.now();
    let chapterId: number;
    let prevState: ChapterState;
    if (existing) {
      chapterId = existing.id;
      prevState = existing.state === 'queued' ? 'known' : existing.state;
      this.removeJobs(this.finishedRows(`chapter_id = ?`, existing.id));
      this.db.prepare('UPDATE source_chapters SET label = ? WHERE id = ?').run(label, chapterId);
    } else {
      prevState = 'known';
      const res = this.db
        .prepare(`INSERT INTO source_chapters (link_id, number, label, url, locked, state, first_seen_at) VALUES (?, ?, ?, ?, 0, 'known', ?)`)
        .run(input.linkId, input.number, label, `${MANUAL_URL_PREFIX}${now}`, now);
      chapterId = Number(res.lastInsertRowid);
    }

    const { path, size } = this.bundle(link.seriesTitle, label, input.files);
    const log = [`${new Date().toISOString().slice(11, 19)} Built by hand from ${input.files.length} page(s) (${(size / 1024 / 1024).toFixed(1)} MB) at ${path}`];
    const res = this.db
      .prepare(
        `INSERT INTO upload_jobs (link_id, chapter_id, state, progress, total, dry_run, prev_chapter_state, file_path, file_size, log_json, created_at, updated_at)
         VALUES (?, ?, 'done', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.linkId, chapterId, input.files.length, input.files.length, prevState, path, size, JSON.stringify(log), now, now);
    this.links.setChapterState([chapterId], 'downloaded');
    const job = this.get(Number(res.lastInsertRowid))!;
    events.emitEvent({ type: 'job', job });
    return job;
  }

  /**
   * Delete a link's finished jobs (done / failed / cancelled) and their ZIPs so a re-download starts clean.
   * Running jobs are left alone. Chapters that were only "downloaded" go back to what they were before;
   * ones already marked uploaded or skipped keep their state, and hand-built chapters that were never
   * uploaded disappear along with their ZIP.
   */
  clear(linkId: number): { jobs: number; files: number } {
    return this.removeJobs(this.finishedRows('link_id = ?', linkId));
  }

  private finishedRows(where: string, arg: number): FinishedRow[] {
    return this.db
      .prepare(`SELECT id, chapter_id, state, file_path, prev_chapter_state FROM upload_jobs WHERE ${where} AND state IN ('done','failed','cancelled')`)
      .all(arg) as unknown as FinishedRow[];
  }

  private removeJobs(rows: FinishedRow[]): { jobs: number; files: number } {
    let files = 0;
    const dirs = new Set<string>();
    for (const r of rows) {
      if (!r.file_path) continue;
      dirs.add(dirname(r.file_path));
      try {
        rmSync(r.file_path);
        files++;
      } catch {
        /* already gone */
      }
    }
    for (const d of dirs) {
      try {
        if (readdirSync(d).length === 0) rmdirSync(d);
      } catch {
        /* not empty or gone */
      }
    }
    // setChapterState opens its own transaction, so these can't be nested in another one.
    for (const r of rows) {
      this.db.prepare('DELETE FROM upload_jobs WHERE id = ?').run(r.id);
      const ch = this.links.chapter(r.chapter_id);
      if (ch?.state !== 'downloaded') continue;
      if (isManualUrl(ch.url)) this.db.prepare('DELETE FROM source_chapters WHERE id = ?').run(r.chapter_id);
      else this.links.setChapterState([r.chapter_id], r.prev_chapter_state === 'downloaded' ? 'known' : r.prev_chapter_state);
    }
    return { jobs: rows.length, files };
  }

  retry(id: number) {
    const job = this.get(id);
    if (!job || (job.state !== 'failed' && job.state !== 'cancelled')) return;
    this.db.prepare(`UPDATE upload_jobs SET state = 'queued', progress = 0, error = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
    this.links.setChapterState([job.chapterId], 'queued');
    this.emit(id);
    this.pump();
  }

  cancel(id: number) {
    const job = this.get(id);
    if (!job || !ACTIVE.includes(job.state)) return;
    if (this.running.has(id)) this.cancelled.add(id);
    else this.finish(id, 'cancelled', 'Cancelled');
  }

  /** Start queued jobs up to the concurrency limit. */
  pump() {
    if (this.running.size >= this.concurrency) return;
    const queued = this.db.prepare(`${JOB_SELECT} WHERE j.state = 'queued' ORDER BY c.number, j.id`).all() as unknown as JobRow[];
    for (const row of queued) {
      if (this.running.size >= this.concurrency) break;
      if (this.busyLinks.has(row.link_id) || this.running.has(row.id)) continue;
      this.running.add(row.id);
      this.busyLinks.add(row.link_id);
      void this.run(row.id).finally(() => {
        this.running.delete(row.id);
        this.busyLinks.delete(row.link_id);
        this.cancelled.delete(row.id);
        this.pump();
      });
    }
  }

  /** Write the chapter ZIP to `<dir>/<series>/<chapter>.zip`. */
  private bundle(seriesTitle: string, chapterLabel: string, files: PageFile[]): { path: string; size: number } {
    const seriesDir = join(this.dir, safeName(seriesTitle));
    mkdirSync(seriesDir, { recursive: true });
    const path = join(seriesDir, `${safeName(chapterLabel)}.zip`);
    writeFileSync(path, createZip(files));
    return { path, size: statSync(path).size };
  }

  private async run(id: number) {
    const job = this.get(id)!;
    const chapter = this.links.chapter(job.chapterId)!;
    const link = this.links.get(job.linkId)!;
    const adapter = this.sources.get(link.sourceId);
    const checkCancel = () => {
      if (this.cancelled.has(id)) throw new CancelError();
    };

    try {
      this.setState(id, 'downloading', `Resolving pages for ${chapter.label} from ${adapter.name}`);
      const pages = await adapter.getChapterPages(
        { number: chapter.number, label: chapter.label, url: chapter.url, locked: !!chapter.locked },
        this.sources.http,
      );
      this.update(id, { total: pages.length, progress: 0 });

      // Pages download in parallel (the per-host limiter still caps it); results keep page order.
      let files: PageFile[] = new Array(pages.length);
      let next = 0;
      let done = 0;
      const worker = async () => {
        try {
          while (next < pages.length) {
            checkCancel();
            const i = next++;
            const p = pages[i]!;
            const { bytes } = await this.sources.http.bytes(p.url, { headers: p.headers });
            // Tiny but valid images (blank pages) are fine; only reject error bodies and truncated files.
            if (bytes.length < 64 || !looksLikeImage(bytes)) throw new Error(`Page ${p.name} is not a valid image (${bytes.length} bytes)`);
            files[i] = { name: p.name, bytes };
            this.update(id, { progress: ++done });
          }
        } catch (err) {
          next = pages.length; // stop the other workers picking up more pages
          throw err;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PAGE_PARALLELISM, pages.length) }, worker));

      checkCancel();
      const fixed = await mergeSliverPages(files);
      if (fixed.merged > 0) this.log(id, `Joined ${fixed.merged} thin leftover strip(s) onto the pages above them (${files.length} → ${fixed.files.length} pages)`);
      files = fixed.files;
      const { path, size } = this.bundle(link.seriesTitle, chapter.label, files);
      this.db.prepare('UPDATE upload_jobs SET file_path = ?, file_size = ? WHERE id = ?').run(path, size, id);
      this.log(id, `Saved ${files.length} pages (${(size / 1024 / 1024).toFixed(1)} MB) to ${path}`);
      this.finish(id, 'done', null);
    } catch (err) {
      if (err instanceof CancelError) this.finish(id, 'cancelled', 'Cancelled');
      else this.finish(id, 'failed', (err as Error).message);
    }
  }

  private finish(id: number, state: 'done' | 'failed' | 'cancelled', error: string | null) {
    const job = this.get(id)!;
    const row = this.db.prepare('SELECT prev_chapter_state FROM upload_jobs WHERE id = ?').get(id) as { prev_chapter_state: ChapterState };
    this.db.prepare('UPDATE upload_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state, error, Date.now(), id);
    // 'downloaded' = the ZIP is ready but not yet uploaded to Atsumaru; the user marks it uploaded themselves.
    this.links.setChapterState([job.chapterId], state === 'done' ? 'downloaded' : row.prev_chapter_state);
    this.log(id, state === 'done' ? 'Ready to download' : `${state}: ${error}`);
  }

  private setState(id: number, state: JobState, msg: string) {
    this.db.prepare('UPDATE upload_jobs SET state = ?, updated_at = ? WHERE id = ?').run(state, Date.now(), id);
    this.log(id, msg);
  }

  private update(id: number, patch: { progress?: number; total?: number }) {
    if (patch.total !== undefined) this.db.prepare('UPDATE upload_jobs SET total = ? WHERE id = ?').run(patch.total, id);
    if (patch.progress !== undefined) this.db.prepare('UPDATE upload_jobs SET progress = ?, updated_at = ? WHERE id = ?').run(patch.progress, Date.now(), id);
    this.emit(id);
  }

  private log(id: number, msg: string) {
    const r = this.db.prepare('SELECT log_json FROM upload_jobs WHERE id = ?').get(id) as { log_json: string };
    const log = JSON.parse(r.log_json) as string[];
    log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    this.db.prepare('UPDATE upload_jobs SET log_json = ? WHERE id = ?').run(JSON.stringify(log.slice(-200)), id);
    this.emit(id);
  }

  private emit(id: number) {
    const job = this.get(id);
    if (job) events.emitEvent({ type: 'job', job });
  }

  private toJob(r: JobRow): DownloadJob {
    let sourceName = r.source_id;
    try {
      sourceName = this.sources.get(r.source_id).name;
    } catch {
      /* adapter removed */
    }
    const mb = uploadMangaBakaId(r.content) ?? r.mangabaka_id;
    return {
      id: r.id,
      linkId: r.link_id,
      chapterId: r.chapter_id,
      chapterLabel: r.chapter_label,
      seriesTitle: r.series_title,
      sourceName,
      state: r.state,
      progress: r.progress,
      total: r.total,
      error: r.error,
      log: JSON.parse(r.log_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      fileSize: r.state === 'done' ? r.file_size : null,
      uploadUrl: mb ? `https://atsu.moe/upload?mb=${encodeURIComponent(mb)}` : 'https://atsu.moe/upload',
    };
  }
}

class CancelError extends Error {}
