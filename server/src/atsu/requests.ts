import type { AtsuPresence, ContentRequest, RequestStatus, RequestTag, TrackerLink } from '@atsusync/shared';
import type { Db } from '../db/client.ts';
import { tx } from '../db/client.ts';
import { ATSU_BASE, CONTENT_REQUESTS_PATH, type AtsuClient, type AtsuPost } from './client.ts';

const STATUS_BY_TAG: Record<string, RequestStatus> = {
  added: 'added',
  "can't add": 'cant_add',
  duplicate: 'duplicate',
  queued: 'queued',
  'looking into it': 'looking',
};

export function statusFromTags(tags: { name: string }[]): RequestStatus {
  for (const t of tags) {
    const s = STATUS_BY_TAG[t.name.trim().toLowerCase()];
    if (s) return s;
  }
  return 'open';
}

export function kindFromTags(tags: { name: string }[]): ContentRequest['kind'] {
  const names = tags.map((t) => t.name.trim().toLowerCase());
  if (names.includes('new series')) return 'new_series';
  if (names.includes('new source')) return 'new_source';
  return null;
}

const TRACKER_PATTERNS: { kind: TrackerLink['kind']; re: RegExp }[] = [
  { kind: 'mangabaka', re: /https?:\/\/(?:www\.)?mangabaka\.(?:org|dev)\/(?:[a-z]+\/)?(\d+)[^\s)\]>"']*/gi },
  { kind: 'anilist', re: /https?:\/\/(?:www\.)?anilist\.co\/manga\/(\d+)[^\s)\]>"']*/gi },
  { kind: 'mal', re: /https?:\/\/(?:www\.)?myanimelist\.net\/manga\/(\d+)[^\s)\]>"']*/gi },
];

export function parseTrackers(content: string): TrackerLink[] {
  const out: TrackerLink[] = [];
  const seen = new Set<string>();
  for (const { kind, re } of TRACKER_PATTERNS) {
    for (const m of content.matchAll(re)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      out.push({ kind, url: m[0], id: m[1] ?? null });
    }
  }
  // Any other links (group sites etc.) — useful for the user, not parsed further.
  for (const m of content.matchAll(/https?:\/\/[^\s)\]>"']+/gi)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ kind: 'other', url: m[0], id: null });
  }
  return out;
}

const SITE_MANGABAKA_LINK = /mangabaka\.(?:org|dev)\/([a-z-]+)\/(\d+)/gi;
const TERMINAL_STATUSES: RequestStatus[] = ['added', 'cant_add', 'duplicate'];

/**
 * The MangaBaka id behind a post's "Upload this" button. Mirrors atsu.moe's own check: the
 * first MangaBaka link of the form `/<type>/<id>` whose type isn't `novel`.
 */
export function uploadMangaBakaId(content: string): string | null {
  for (const m of content.matchAll(SITE_MANGABAKA_LINK)) if (m[1]!.toLowerCase() !== 'novel') return m[2]!;
  return null;
}

/** Atsumaru only shows "Upload this" on posts without a terminal tag (Added / Can't add / Duplicate). */
export const isUploadable = (status: RequestStatus, content: string) => !TERMINAL_STATUSES.includes(status) && uploadMangaBakaId(content) !== null;

export const postUrl =(id: string) => `${ATSU_BASE}${CONTENT_REQUESTS_PATH}/${id}`;

interface RequestRow {
  id: string;
  title: string;
  content: string;
  author_name: string | null;
  tags_json: string;
  status: RequestStatus;
  kind: ContentRequest['kind'];
  trackers_json: string;
  mangabaka_id: string | null;
  comment_count: number;
  score: number;
  created_at: number;
  section_id: string | null;
  presence_json: string | null;
  link_count?: number;
}

function rowToRequest(r: RequestRow): ContentRequest {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    url: postUrl(r.id),
    authorName: r.author_name,
    tags: JSON.parse(r.tags_json) as RequestTag[],
    status: r.status,
    kind: r.kind,
    trackers: JSON.parse(r.trackers_json) as TrackerLink[],
    mangabakaId: r.mangabaka_id,
    commentCount: r.comment_count,
    score: r.score,
    createdAt: r.created_at,
    linkCount: r.link_count ?? 0,
    presence: r.presence_json ? (JSON.parse(r.presence_json) as AtsuPresence) : null,
    uploadable: isUploadable(r.status, r.content),
  };
}

export class RequestsRepo {
  constructor(private db: Db) {}

  upsertPost(p: AtsuPost): 'inserted' | 'updated' {
    const tags: RequestTag[] = (p.tags ?? []).map((t) => ({ id: t.id, name: t.name, emoji: t.emoji ?? null }));
    const trackers = parseTrackers(p.content ?? '');
    const mb = trackers.find((t) => t.kind === 'mangabaka');
    const existed = this.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(p.id);
    this.db
      .prepare(
        `INSERT INTO requests (id, title, content, author_name, tags_json, status, kind, trackers_json, mangabaka_id,
           comment_count, score, created_at, synced_at, section_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, tags_json = excluded.tags_json,
           status = excluded.status, kind = excluded.kind, trackers_json = excluded.trackers_json,
           mangabaka_id = excluded.mangabaka_id, comment_count = excluded.comment_count, score = excluded.score,
           synced_at = excluded.synced_at, section_id = COALESCE(excluded.section_id, requests.section_id)`,
      )
      .run(
        p.id,
        p.title,
        p.content ?? '',
        p.author?.usernameDisplay ?? null,
        JSON.stringify(tags),
        statusFromTags(tags),
        kindFromTags(tags),
        JSON.stringify(trackers),
        mb?.id ?? null,
        p.commentCount ?? 0,
        p.score ?? 0,
        p.createdAt,
        Date.now(),
        p.sectionId ?? null,
      );
    return existed ? 'updated' : 'inserted';
  }

  sectionId(id: string): string | null {
    const r = this.db.prepare('SELECT section_id FROM requests WHERE id = ?').get(id) as { section_id: string | null } | undefined;
    return r?.section_id ?? null;
  }

  setPresence(id: string, p: AtsuPresence) {
    this.db.prepare('UPDATE requests SET presence_json = ?, presence_checked_at = ? WHERE id = ?').run(JSON.stringify(p), p.checkedAt, id);
  }

  /** Unresolved requests whose presence check is missing, stale, or predates new comments. */
  dueForPresenceCheck(maxAgeMs: number, limit: number): ContentRequest[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, 0 AS link_count FROM requests r
         WHERE r.status IN ('open', 'queued', 'looking')
           AND (r.presence_checked_at IS NULL OR r.presence_checked_at < ?
                OR r.comment_count <> COALESCE(json_extract(r.presence_json, '$.commentCount'), -1))
         ORDER BY r.presence_checked_at IS NOT NULL, r.created_at DESC LIMIT ?`,
      )
      .all(Date.now() - maxAgeMs, limit) as unknown as RequestRow[];
    return rows.map(rowToRequest);
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM requests WHERE id = ?').run(id);
  }

  list(): ContentRequest[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM links l WHERE l.request_id = r.id) AS link_count
         FROM requests r ORDER BY r.created_at DESC`,
      )
      .all() as unknown as RequestRow[];
    return rows.map(rowToRequest);
  }

  get(id: string): ContentRequest | null {
    const row = this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM links l WHERE l.request_id = r.id) AS link_count FROM requests r WHERE r.id = ?`,
      )
      .get(id) as unknown as RequestRow | undefined;
    return row ? rowToRequest(row) : null;
  }

  has(id: string) {
    return !!this.db.prepare('SELECT 1 FROM requests WHERE id = ?').get(id);
  }
}

/** Posts that are forum housekeeping rather than requests. */
const isRequestPost = (p: AtsuPost) => !p.pinned && !p.removed;

/**
 * Pull the forum newest-first. A quick sync stops after a full page of posts we already
 * had; a full sync walks every page (picks up status-tag changes on older posts).
 */
export async function syncRequests(
  client: AtsuClient,
  repo: RequestsRepo,
  db: Db,
  opts: { full?: boolean; maxPages?: number; pageDelayMs?: number } = {},
) {
  const maxPages = opts.maxPages ?? (opts.full ? 200 : 10);
  let added = 0;
  let updated = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listPosts(page, 'new');
    let knownOnPage = 0;
    const requestPosts = res.posts.filter(isRequestPost);
    tx(db, () => {
      for (const p of res.posts) {
        if (!isRequestPost(p)) {
          if (p.removed) repo.remove(p.id);
          continue;
        }
        if (repo.has(p.id)) knownOnPage++;
        if (repo.upsertPost(p) === 'inserted') added++;
        else updated++;
      }
    });
    if (!res.hasMore) break;
    if (!opts.full && requestPosts.length > 0 && knownOnPage === requestPosts.length) break;
    await new Promise((r) => setTimeout(r, opts.pageDelayMs ?? 400));
  }
  return { added, updated };
}
