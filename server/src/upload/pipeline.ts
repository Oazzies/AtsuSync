import { mkdirSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { ChapterState, DownloadJob, JobState, SourceChapter } from '@atsusync/shared';
import { uploadMangaBakaId } from '../atsu/requests.ts';
import type { Db } from '../db/client.ts';
import { events } from '../events.ts';
import type { LinksRepo } from '../links.ts';
import { BlockedError } from '../polite.ts';
import type { SourceRegistry } from '../sources/registry.ts';
import { WebTorrentClient, type TorrentClient } from '../sources/torrent.ts';
import type { SourceAdapter } from '../sources/types.ts';
import { mediumOf } from '../sources/types.ts';
import { createEpub, imageMediaType, type EpubImage } from './epub.ts';
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
  source_url: string | null;
  created_at: number;
  updated_at: number;
  chapter_label: string;
  series_title: string;
  source_id: string;
  content: string;
  mangabaka_id: string | null;
  atsu_manga_id: string | null;
}

const JOB_SELECT = `
  SELECT j.*, c.label AS chapter_label, l.series_title, l.source_id, r.content, r.mangabaka_id, COALESCE(l.atsu_manga_id, r.atsu_manga_id) AS atsu_manga_id
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
    private torrents: TorrentClient = new WebTorrentClient(join(dir, '.torrents')),
  ) {
    // Torrent data is scratch space; anything left from a crashed run is stale.
    rmSync(join(dir, '.torrents'), { recursive: true, force: true });
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
    const label = job.chapterLabel.replace(/(\d),(\d)/g, '$1.$2');
    return { path: row.file_path, name: `${safeName(job.seriesTitle)} - ${safeName(label)}${extname(row.file_path) || '.zip'}` };
  }

  /** `urls` overrides a chapter's page URL for this download only (see addFromSource). */
  enqueue(chapterIds: number[], urls: Record<number, string> = {}): DownloadJob[] {
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
          `INSERT INTO upload_jobs (link_id, chapter_id, state, dry_run, prev_chapter_state, source_url, created_at, updated_at)
           VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`,
        )
        .run(ch.link_id, chapterId, ch.state === 'queued' ? 'known' : ch.state, urls[chapterId] ?? null, now, now);
      this.links.setChapterState([chapterId], 'queued');
      created.push(Number(res.lastInsertRowid));
    }
    const jobs = created.map((id) => this.get(id)!);
    jobs.forEach((j) => events.emitEvent({ type: 'job', job: j }));
    this.pump();
    return jobs;
  }

  /**
   * Download chapters from a different site than the link's own, e.g. when some chapters are broken on
   * the linked one. The job (not the chapter row) remembers the other site's URL, so later downloads of
   * that chapter go back to the linked site. A chapter the link lacks is added with the other site's URL.
   */
  addFromSource(linkId: number, chapters: SourceChapter[]): DownloadJob[] {
    if (!this.links.get(linkId)) throw new Error('Unknown link');
    const now = Date.now();
    const ids: number[] = [];
    const urls: Record<number, string> = {};
    for (const c of chapters) {
      if (c.locked) throw new Error(`${c.label} is locked on that site`);
      const existing = this.db.prepare('SELECT id FROM source_chapters WHERE link_id = ? AND number = ?').get(linkId, c.number) as { id: number } | undefined;
      if (existing) {
        ids.push(existing.id);
        urls[existing.id] = c.url;
      } else {
        const res = this.db
          .prepare(`INSERT INTO source_chapters (link_id, number, label, url, locked, state, first_seen_at) VALUES (?, ?, ?, ?, 0, 'known', ?)`)
          .run(linkId, c.number, c.label, c.url, now);
        ids.push(Number(res.lastInsertRowid));
      }
    }
    return this.enqueue(ids, urls);
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

  /** Remove one finished download job and its ZIP file from disk. */
  remove(id: number): { jobs: number; files: number } {
    return this.removeJobs(this.finishedRows('id = ?', id));
  }

  /** Remove finished download jobs and ZIP files for the given chapter IDs (e.g. once uploaded). */
  clearForChapters(chapterIds: number[]): { jobs: number; files: number } {
    if (!chapterIds.length) return { jobs: 0, files: 0 };
    const placeholders = chapterIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, chapter_id, state, file_path, prev_chapter_state FROM upload_jobs WHERE chapter_id IN (${placeholders}) AND state IN ('done','failed','cancelled')`,
      )
      .all(...chapterIds) as unknown as FinishedRow[];
    return this.removeJobs(rows);
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
      // run() only handles errors once its try block starts; a job whose setup throws (e.g. its source was
      // removed) must end up failed, or it stays queued and pump() re-runs it in an endless loop.
      void this.run(row.id)
        .catch((err) => this.finish(row.id, 'failed', (err as Error).message))
        .finally(() => {
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

  /** Write a novel chapter's ebook to `<dir>/<series>/<chapter>.<ext>`. */
  private saveEpub(seriesTitle: string, chapterLabel: string, data: Uint8Array, ext = 'epub'): { path: string; size: number } {
    const seriesDir = join(this.dir, safeName(seriesTitle));
    mkdirSync(seriesDir, { recursive: true });
    const path = join(seriesDir, `${safeName(chapterLabel)}.${ext}`);
    writeFileSync(path, data);
    return { path, size: statSync(path).size };
  }

  /** Novel sources: fetch the chapter text (plus any inline images) and write it as an EPUB. */
  private async runNovel(id: number, adapter: SourceAdapter, chapter: SourceChapter, seriesTitle: string, checkCancel: () => void) {
    if (!adapter.getChapterText) throw new Error(`${adapter.name} cannot download novel chapters`);
    this.setState(id, 'downloading', `Fetching the text of ${chapter.label} from ${adapter.name}`);
    const text = await adapter.getChapterText(chapter, this.sources.http);
    const images: EpubImage[] = [];
    const wanted = text.images ?? [];
    this.update(id, { total: 1 + wanted.length, progress: 1 });
    let completed = 0;
    for (const img of wanted) {
      checkCancel();
      try {
        const { bytes, contentType } = await this.sources.http.bytes(img.url, { headers: img.headers });
        const mediaType = imageMediaType(bytes, contentType);
        if (!mediaType || !looksLikeImage(bytes)) {
          this.log(id, `Warning: Illustration ${img.url} is not a valid image (${bytes.length} bytes) — skipped`);
        } else {
          images.push({ src: img.src, bytes, mediaType });
        }
      } catch (err) {
        if (err instanceof CancelError || err instanceof BlockedError) throw err;
        this.log(id, `Warning: Illustration ${img.url} failed (${(err as Error).message}) — skipped`);
      }
      this.update(id, { progress: 1 + ++completed });
    }
    checkCancel();
    if (text.html.replace(/<[^>]+>/g, '').trim().length < 20) throw new Error(`${adapter.name} returned no text for ${chapter.label} (locked or empty?)`);
    const epub = createEpub({ seriesTitle, chapterTitle: text.title || chapter.label, bodyHtml: text.html, images });
    const { path, size } = this.saveEpub(seriesTitle, chapter.label, epub);
    this.db.prepare('UPDATE upload_jobs SET file_path = ?, file_size = ? WHERE id = ?').run(path, size, id);
    this.log(id, `Saved EPUB with ${text.html.split('</p>').length - 1} paragraph(s)${images.length ? ` and ${images.length} image(s)` : ''} (${(size / 1024).toFixed(0)} KB) to ${path}`);
    this.finish(id, 'done', null);
  }

  /**
   * Download-type sources (torrents, file hosts): the adapter fetches whole files, which come back as page
   * images (repacked into the usual ZIP) or a ready-made ebook (saved as-is).
   */
  private async runFetched(id: number, adapter: SourceAdapter, chapter: SourceChapter, seriesTitle: string, checkCancel: () => void) {
    this.setState(id, 'downloading', `Fetching ${chapter.label} from ${adapter.name}`);
    this.update(id, { total: 100, progress: 0 });
    // Remember which torrents this job touched so their files are deleted once the chapter is packed.
    const used = new Set<string>();
    const torrents: TorrentClient = {
      download: (req, pick, hooks) => {
        used.add(req.infoHash);
        return this.torrents.download(req, pick, hooks);
      },
      release: () => {},
      destroy: async () => {},
    };
    let lastPct = -1;
    try {
      const out = await adapter.fetchChapter!(chapter, {
        http: this.sources.http,
        torrents,
        progress: (pct) => {
          if (pct === lastPct) return;
          lastPct = pct;
          this.update(id, { progress: pct });
        },
        log: (m) => this.log(id, m),
        checkCancel,
      });
      checkCancel();
      if (out.type === 'ebook') {
        if (out.bytes.length < 64) throw new Error(`${adapter.name} delivered an empty ${out.ext} file`);
        const { path, size } = this.saveEpub(seriesTitle, chapter.label, out.bytes, out.ext);
        this.db.prepare('UPDATE upload_jobs SET file_path = ?, file_size = ? WHERE id = ?').run(path, size, id);
        this.log(id, `Saved ${out.ext.toUpperCase()} (${(size / 1024 / 1024).toFixed(1)} MB) to ${path}`);
        this.finish(id, 'done', null);
        return;
      }
      const valid = out.files.filter((f) => f.bytes.length >= 64 && looksLikeImage(f.bytes));
      if (valid.length < out.files.length) this.log(id, `Warning: ${out.files.length - valid.length} file(s) were not valid images — skipped`);
      if (valid.length === 0) throw new Error(`No valid images in what ${adapter.name} delivered`);
      const fixed = await mergeSliverPages(valid);
      if (fixed.merged > 0) this.log(id, `Joined ${fixed.merged} thin leftover strip(s) onto the pages above them (${valid.length} → ${fixed.files.length} pages)`);
      const { path, size } = this.bundle(seriesTitle, chapter.label, fixed.files);
      this.db.prepare('UPDATE upload_jobs SET file_path = ?, file_size = ? WHERE id = ?').run(path, size, id);
      this.log(id, `Saved ${fixed.files.length} pages (${(size / 1024 / 1024).toFixed(1)} MB) to ${path}`);
      this.finish(id, 'done', null);
    } finally {
      for (const h of used) this.torrents.release(h);
    }
  }

  async close() {
    await this.torrents.destroy();
  }

  private async run(id: number) {
    const job = this.get(id)!;
    const chapter = this.links.chapter(job.chapterId)!;
    const link = this.links.get(job.linkId)!;
    // A chapter fetched from another site (see addFromSource) is resolved by its own URL's adapter.
    const pageUrl = (this.db.prepare('SELECT source_url FROM upload_jobs WHERE id = ?').get(id) as { source_url: string | null }).source_url ?? chapter.url;
    const adapter = this.sources.forUrl(pageUrl) ?? this.sources.get(link.sourceId);
    const checkCancel = () => {
      if (this.cancelled.has(id)) throw new CancelError();
    };

    try {
      if (adapter.fetchChapter) {
        await this.runFetched(id, adapter, { number: chapter.number, label: chapter.label, url: pageUrl, locked: !!chapter.locked }, link.seriesTitle, checkCancel);
        return;
      }
      if (mediumOf(adapter) === 'novel') {
        await this.runNovel(id, adapter, { number: chapter.number, label: chapter.label, url: pageUrl, locked: !!chapter.locked }, link.seriesTitle, checkCancel);
        return;
      }
      this.setState(id, 'downloading', `Resolving pages for ${chapter.label} from ${adapter.name}`);
      const pages = await adapter.getChapterPages(
        { number: chapter.number, label: chapter.label, url: pageUrl, locked: !!chapter.locked },
        this.sources.http,
      );
      this.update(id, { total: pages.length, progress: 0 });

      // Pages download in parallel (the per-host limiter still caps it); results keep page order.
      const rawFiles: (PageFile | undefined)[] = new Array(pages.length);
      let next = 0;
      let done = 0;
      let skipped = 0;
      let firstSkipReason: string | null = null;
      const worker = async () => {
        try {
          while (next < pages.length) {
            checkCancel();
            const i = next++;
            const p = pages[i]!;
            try {
              const { bytes } = await this.sources.http.bytes(p.url, { headers: p.headers });
              // Tiny but valid images (blank pages) are fine; only reject error bodies and truncated files.
              if (bytes.length < 64 || !looksLikeImage(bytes)) {
                const reason = `Page ${p.name} is not a valid image (${bytes.length} bytes)`;
                skipped++;
                firstSkipReason ??= reason;
                this.log(id, `Warning: ${reason} — skipped`);
              } else {
                rawFiles[i] = { name: p.name, bytes };
              }
            } catch (err) {
              if (err instanceof CancelError || err instanceof BlockedError) throw err;
              const reason = `Page ${p.name} failed (${(err as Error).message})`;
              skipped++;
              firstSkipReason ??= reason;
              this.log(id, `Warning: ${reason} — skipped`);
            }
            this.update(id, { progress: ++done });
          }
        } catch (err) {
          next = pages.length; // stop the other workers picking up more pages
          throw err;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PAGE_PARALLELISM, pages.length) }, worker));

      checkCancel();
      let files = rawFiles.filter((f): f is PageFile => f !== undefined);
      if (files.length === 0) {
        throw new Error(firstSkipReason ?? `No valid images downloaded from ${adapter.name}`);
      }
      const fixed = await mergeSliverPages(files);
      if (fixed.merged > 0) this.log(id, `Joined ${fixed.merged} thin leftover strip(s) onto the pages above them (${files.length} → ${fixed.files.length} pages)`);
      files = fixed.files;
      const { path, size } = this.bundle(link.seriesTitle, chapter.label, files);
      this.db.prepare('UPDATE upload_jobs SET file_path = ?, file_size = ? WHERE id = ?').run(path, size, id);
      this.log(id, `Saved ${files.length} pages${skipped > 0 ? ` (${skipped} skipped)` : ''} (${(size / 1024 / 1024).toFixed(1)} MB) to ${path}`);
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
    if (state === 'done') {
      const remaining = this.db
        .prepare(`SELECT COUNT(*) AS n FROM upload_jobs WHERE link_id = ? AND state IN ('queued','downloading')`)
        .get(job.linkId) as { n: number };
      if (remaining.n === 0) {
        const ready = this.db
          .prepare(`SELECT COUNT(*) AS n FROM upload_jobs WHERE link_id = ? AND state = 'done'`)
          .get(job.linkId) as { n: number };
        if (ready.n > 0) {
          events.emitEvent({ type: 'downloads_complete', linkId: job.linkId, seriesTitle: job.seriesTitle, count: ready.n });
        }
      }
    }
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
      uploadUrl: r.atsu_manga_id
        ? `https://atsu.moe/upload?manga=${encodeURIComponent(r.atsu_manga_id)}`
        : mb
          ? `https://atsu.moe/upload?mb=${encodeURIComponent(mb)}`
          : 'https://atsu.moe/upload',
    };
  }
}

class CancelError extends Error {}
