import type { AtsuPresence, ContentRequest, PresenceClaim, RequestComment } from '@atsusync/shared';
import { sleep } from '../polite.ts';
import { bestScore, searchQueries } from '../sources/match.ts';
import type { AtsuClient, AtsuComment } from './client.ts';
import { getMangaBakaSeries } from './mangabaka.ts';
import type { RequestsRepo } from './requests.ts';

const ON_ATSU_SCORE = 0.9;
const POSSIBLE_SCORE = 0.7;

const ATSU_MANGA_LINK = /atsu\.moe\/manga\/([A-Za-z0-9_-]+)/i;
const CLAIM_WORDS =
  /\b(added|uploaded|uploading|i'?ll upload|will upload|on it|already (?:on|in) atsu|working on (?:it|this)|done (?:uploading|adding))\b/i;

/** A Novel request should only match a novel on Atsu, and comic requests never a novel. */
export function wantsNovel(req: Pick<ContentRequest, 'tags' | 'title'>): boolean {
  return req.tags.some((t) => t.name.toLowerCase() === 'novel') || /\(novel\)|light novel|web ?novel/i.test(req.title);
}

export function sameMedium(req: ContentRequest, medium: string | null): boolean {
  if (!medium) return true;
  return wantsNovel(req) === (medium.toLowerCase() === 'novel');
}

export function isClaim(content: string): boolean {
  return ATSU_MANGA_LINK.test(content) || CLAIM_WORDS.test(content);
}

export function toRequestComment(c: AtsuComment): RequestComment {
  return {
    id: c.id,
    user: c.user?.usernameDisplay ?? 'unknown',
    content: c.removed ? '[removed]' : c.content,
    createdAt: c.createdAt,
    score: c.score ?? 0,
    parentId: c.parentId,
    claim: !c.removed && isClaim(c.content),
  };
}

export function claimsFrom(comments: AtsuComment[]): PresenceClaim[] {
  return comments
    .filter((c) => !c.removed && isClaim(c.content))
    .map((c) => ({
      commentId: c.id,
      user: c.user?.usernameDisplay ?? 'unknown',
      excerpt: c.content.slice(0, 160),
      createdAt: c.createdAt,
      atsuMangaId: c.content.match(ATSU_MANGA_LINK)?.[1] ?? null,
    }));
}

/**
 * Works out whether a request is probably already done on Atsumaru, even though nobody
 * has tagged it "Added" yet. Uses, in order of confidence:
 *  1. the exact MangaBaka → Atsu series lookup (needs the user's cookie),
 *  2. a comment linking atsu.moe/manga/<id> or saying it was added/is being uploaded,
 *  3. Atsu's public search with the request title + MangaBaka alt titles.
 */
export class PresenceChecker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private atsu: AtsuClient,
    private requests: RequestsRepo,
    private opts = { tickMs: 2 * 60_000, perTick: 5, maxAgeMs: 12 * 60 * 60_000, gapMs: 1500 },
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Check a few stale requests, one at a time, with gaps so Atsumaru never sees a burst. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const req of this.requests.dueForPresenceCheck(this.opts.maxAgeMs, this.opts.perTick)) {
        await this.check(req).catch(() => {});
        await sleep(this.opts.gapMs);
      }
    } finally {
      this.running = false;
    }
  }

  async check(req: ContentRequest): Promise<AtsuPresence> {
    let match: AtsuPresence['match'] = null;

    // 1. Exact: MangaBaka id → Atsu series (only answers when logged in).
    if (req.mangabakaId) {
      const state = await this.atsu.getSeriesState({ mangaBakaId: req.mangabakaId }).catch(() => null);
      if (state?.found && state.mangaId && state.total > 0) {
        match = { mangaId: state.mangaId, title: state.title ?? req.title, chapterCount: state.total, dateAdded: null, score: 1, via: 'mangabaka' };
      }
    }

    // 2. Comments.
    const sectionId = this.requests.sectionId(req.id);
    const comments = req.commentCount > 0 && sectionId ? await this.atsu.getComments(sectionId).catch(() => []) : [];
    const claims = claimsFrom(comments);
    const linked = claims.find((c) => c.atsuMangaId);
    if (!match && linked) {
      match = { mangaId: linked.atsuMangaId!, title: req.title, chapterCount: 0, dateAdded: null, score: 1, via: 'comment' };
    }

    // 3. Fuzzy public search.
    if (!match) {
      const titles = [req.title];
      if (req.mangabakaId) {
        const mb = await getMangaBakaSeries(req.mangabakaId).catch(() => null);
        if (mb) titles.push(mb.title, ...mb.titles);
      }
      let best: AtsuPresence['match'] = null;
      for (const q of searchQueries(titles, 2)) {
        for (const hit of await this.atsu.searchPublic(q).catch(() => [])) {
          if (!sameMedium(req, hit.medium)) continue;
          const score = bestScore(titles, [hit.title, ...hit.otherNames]);
          if (!best || score > best.score) {
            best = { mangaId: hit.id, title: hit.title, chapterCount: hit.chapterCount, dateAdded: hit.dateAdded, score, via: 'search' };
          }
        }
        if (best && best.score >= ON_ATSU_SCORE) break;
      }
      if (best && best.score >= POSSIBLE_SCORE) match = best;
    }

    const verdict: AtsuPresence['verdict'] =
      match && match.score >= ON_ATSU_SCORE && (match.chapterCount > 0 || match.via === 'comment')
        ? 'on_atsu'
        : claims.length
          ? 'claimed'
          : match
            ? 'possible'
            : 'none';

    const presence: AtsuPresence = { verdict, checkedAt: Date.now(), commentCount: req.commentCount, match, claims };
    this.requests.setPresence(req.id, presence);
    return presence;
  }
}
