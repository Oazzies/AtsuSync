import { createHash } from 'node:crypto';
import type { ChapterState, JobState, UploadJob } from '@atsusync/shared';
import type { AtsuClient } from '../atsu/client.ts';
import type { Db } from '../db/client.ts';
import { events } from '../events.ts';
import type { LinksRepo } from '../links.ts';
import type { SettingsStore } from '../settings.ts';
import type { SourceRegistry } from '../sources/registry.ts';

interface JobRow {
  id: number;
  link_id: number;
  chapter_id: number;
  state: JobState;
  progress: number;
  total: number;
  dry_run: number;
  draft_id: string | null;
  prev_chapter_state: ChapterState;
  error: string | null;
  log_json: string;
  created_at: number;
  updated_at: number;
  chapter_label: string;
  series_title: string;
  source_id: string;
}

const JOB_SELECT = `
  SELECT j.*, c.label AS chapter_label, l.series_title, l.source_id
  FROM upload_jobs j JOIN source_chapters c ON c.id = j.chapter_id JOIN links l ON l.id = j.link_id`;

const ACTIVE: JobState[] = ['queued', 'downloading', 'uploading', 'submitting'];

/**
 * Upload queue persisted in SQLite: download → hash → create draft → PUT pages → submit.
 * Runs at most `concurrency` jobs at once and never two for the same link, so chapters of
 * a series go up in order. In dry-run mode every Atsumaru write call is skipped and logged.
 */
export class UploadPipeline {
  private running = new Set<number>();
  private busyLinks = new Set<number>();
  private cancelled = new Set<number>();

  constructor(
    private db: Db,
    private links: LinksRepo,
    private sources: SourceRegistry,
    private atsu: AtsuClient,
    private settings: SettingsStore,
    private concurrency = 2,
  ) {
    // Jobs interrupted by a restart go back to the queue.
    this.db.prepare(`UPDATE upload_jobs SET state = 'queued', progress = 0 WHERE state IN ('downloading','uploading','submitting')`).run();
  }

  list(limit = 200): UploadJob[] {
    return (this.db.prepare(`${JOB_SELECT} ORDER BY j.id DESC LIMIT ?`).all(limit) as unknown as JobRow[]).map((r) => this.toJob(r));
  }

  get(id: number): UploadJob | null {
    const r = this.db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as unknown as JobRow | undefined;
    return r ? this.toJob(r) : null;
  }

  enqueue(chapterIds: number[]): UploadJob[] {
    const dryRun = this.settings.get().dryRun;
    const created: number[] = [];
    for (const chapterId of chapterIds) {
      const ch = this.links.chapter(chapterId);
      if (!ch) throw new Error(`Unknown chapter ${chapterId}`);
      if (ch.locked) throw new Error(`${ch.label} is locked on the source`);
      const active = this.db
        .prepare(`SELECT 1 FROM upload_jobs WHERE chapter_id = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`)
        .get(chapterId, ...ACTIVE);
      if (active) continue;
      const now = Date.now();
      const res = this.db
        .prepare(
          `INSERT INTO upload_jobs (link_id, chapter_id, state, dry_run, prev_chapter_state, created_at, updated_at)
           VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(ch.link_id, chapterId, dryRun ? 1 : 0, ch.state === 'queued' ? 'known' : ch.state, now, now);
      this.links.setChapterState([chapterId], 'queued');
      created.push(Number(res.lastInsertRowid));
    }
    const jobs = created.map((id) => this.get(id)!);
    jobs.forEach((j) => events.emitEvent({ type: 'job', job: j }));
    this.pump();
    return jobs;
  }

  retry(id: number) {
    const job = this.get(id);
    if (!job || (job.state !== 'failed' && job.state !== 'cancelled')) return;
    this.db
      .prepare(`UPDATE upload_jobs SET state = 'queued', progress = 0, error = NULL, dry_run = ?, updated_at = ? WHERE id = ?`)
      .run(this.settings.get().dryRun ? 1 : 0, Date.now(), id);
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

  private async run(id: number) {
    const job = this.get(id)!;
    const chapter = this.links.chapter(job.chapterId)!;
    const link = this.links.get(job.linkId)!;
    const adapter = this.sources.get(link.sourceId);
    const settings = this.settings.get();
    const checkCancel = () => {
      if (this.cancelled.has(id)) throw new CancelError();
    };
    let draft: string | null = null;

    try {
      this.setState(id, 'downloading', `Resolving pages for ${chapter.label} from ${adapter.name}`);
      const pages = await adapter.getChapterPages(
        { number: chapter.number, label: chapter.label, url: chapter.url, locked: !!chapter.locked },
        this.sources.http,
      );
      this.update(id, { total: pages.length, progress: 0 });

      const files: { name: string; sha256: string; bytes: Uint8Array }[] = [];
      for (const [i, p] of pages.entries()) {
        checkCancel();
        const { bytes } = await this.sources.http.bytes(p.url, { headers: p.headers });
        if (bytes.length < 1024) throw new Error(`Page ${p.name} looks empty (${bytes.length} bytes)`);
        files.push({ name: p.name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes });
        this.update(id, { progress: i + 1 });
      }
      const totalMb = files.reduce((n, f) => n + f.bytes.length, 0) / 1024 / 1024;
      this.log(id, `Downloaded ${files.length} pages (${totalMb.toFixed(1)} MB)`);

      // Atsumaru keys pages by sha256, so identical pages (e.g. blank separators) can only appear once.
      const unique = files.filter((f, i) => files.findIndex((g) => g.sha256 === f.sha256) === i);
      if (unique.length < files.length) this.log(id, `Dropped ${files.length - unique.length} duplicate page(s)`);

      const seriesRef = { mangaId: link.atsuMangaId, mangaBakaId: this.requestMangaBakaId(link.requestId) };
      const groupId = settings.atsuGroupId || null;
      const draftFields = { number: chapter.number, title: chapterTitle(chapter.label), pageOrder: unique.map((f) => f.sha256) };

      if (job.dryRun) {
        this.setState(id, 'uploading', `[dry run] would use/create upload source ${JSON.stringify({ ...seriesRef, groupId })}`);
        this.log(id, `[dry run] would POST /api/uploads/drafts ${JSON.stringify({ ...draftFields, pageOrder: `[${unique.length} sha256]` })}`);
        for (const f of unique) this.log(id, `[dry run] would PUT /api/uploads/:draftId/pages/${f.sha256}?name=${f.name}`);
        this.log(id, '[dry run] would POST /api/uploads/drafts/submit');
        this.finish(id, 'done', null);
        return;
      }

      checkCancel();
      this.setState(id, 'uploading', 'Preparing Atsumaru upload source');
      const sourceId = await this.atsu.ensureSource(seriesRef, groupId);
      const { draftId } = await this.atsu.createDraft({ sourceId, ...draftFields });
      draft = draftId;
      this.db.prepare('UPDATE upload_jobs SET draft_id = ? WHERE id = ?').run(draftId, id);
      this.log(id, `Created draft ${draftId}`);
      this.update(id, { progress: 0, total: unique.length });
      for (const [i, f] of unique.entries()) {
        checkCancel();
        await this.atsu.putPage(draftId, f.sha256, f.name, f.bytes);
        this.update(id, { progress: i + 1 });
      }

      checkCancel();
      this.setState(id, 'submitting', `Submitting draft ${draftId}`);
      const result = await this.atsu.submitDraft(draftId);
      draft = null;
      this.log(id, `Atsumaru status: ${result.status}`);
      this.finish(id, 'done', null);
    } catch (err) {
      // Don't leave a half-uploaded draft behind; a retry starts a fresh one.
      if (draft) await this.atsu.deleteDraft(draft).catch(() => {});
      if (err instanceof CancelError) this.finish(id, 'cancelled', 'Cancelled');
      else this.finish(id, 'failed', (err as Error).message);
    }
  }

  private requestMangaBakaId(requestId: string): string | null {
    const r = this.db.prepare('SELECT mangabaka_id FROM requests WHERE id = ?').get(requestId) as { mangabaka_id: string | null } | undefined;
    return r?.mangabaka_id ?? null;
  }

  private finish(id: number, state: 'done' | 'failed' | 'cancelled', error: string | null) {
    const job = this.get(id)!;
    const row = this.db.prepare('SELECT prev_chapter_state FROM upload_jobs WHERE id = ?').get(id) as { prev_chapter_state: ChapterState };
    this.db.prepare('UPDATE upload_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state, error, Date.now(), id);
    // A dry run leaves the chapter as it was before queuing, so the real upload is still one click away.
    const chapterState: ChapterState = state === 'done' && !job.dryRun ? 'uploaded' : row.prev_chapter_state;
    this.links.setChapterState([job.chapterId], chapterState);
    this.log(id, state === 'done' ? (job.dryRun ? 'Dry run complete' : 'Uploaded') : `${state}: ${error}`);
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

  private toJob(r: JobRow): UploadJob {
    let sourceName = r.source_id;
    try {
      sourceName = this.sources.get(r.source_id).name;
    } catch {
      /* adapter removed */
    }
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
      dryRun: !!r.dry_run,
      error: r.error,
      log: JSON.parse(r.log_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

class CancelError extends Error {}

/** "Chapter 12 — The Return" → "The Return"; plain "Chapter 12" → null. */
const chapterTitle = (label: string) => label.match(/ — (.+)$/)?.[1] ?? null;
