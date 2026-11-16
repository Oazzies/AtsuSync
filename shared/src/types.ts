// DTOs shared between the server API and the Vue client.

export type RequestStatus = 'open' | 'queued' | 'looking' | 'added' | 'cant_add' | 'duplicate';

export interface RequestTag {
  id: string;
  name: string;
  emoji: string | null;
}

export interface TrackerLink {
  kind: 'mangabaka' | 'anilist' | 'mal' | 'other';
  url: string;
  id: string | null;
}

export interface ContentRequest {
  id: string;
  title: string;
  content: string;
  url: string;
  authorName: string | null;
  tags: RequestTag[];
  status: RequestStatus;
  kind: 'new_series' | 'new_source' | null;
  trackers: TrackerLink[];
  mangabakaId: string | null;
  /** Set for a series added straight from atsu.moe/manga/<id> instead of a forum post (`id` is `atsu:<mangaId>`). */
  atsuMangaId: string | null;
  altTitles: string[];
  cover: string | null;
  commentCount: number;
  score: number;
  createdAt: number;
  linkCount: number;
  presence: AtsuPresence | null;
  /** Atsumaru shows an "Upload this" button on the post: not resolved, with a non-novel MangaBaka link. */
  uploadable: boolean;
}

export interface PresenceClaim {
  commentId: string;
  user: string;
  excerpt: string;
  createdAt: number;
  /** Set when the comment links an atsu.moe/manga/<id> page. */
  atsuMangaId: string | null;
}

/**
 * Whether a request looks done on Atsumaru even though it isn't tagged "Added":
 * - on_atsu: the series exists on Atsu with chapters (exact MangaBaka match or a near-exact title)
 * - claimed: someone commented that they added/are uploading it
 * - possible: a similar title exists on Atsu, worth a look
 */
export interface AtsuPresence {
  verdict: 'on_atsu' | 'claimed' | 'possible' | 'none';
  checkedAt: number;
  commentCount: number;
  match: {
    mangaId: string;
    title: string;
    chapterCount: number;
    dateAdded: number | null;
    score: number;
    via: 'mangabaka' | 'search' | 'comment';
  } | null;
  claims: PresenceClaim[];
}

export interface RequestComment {
  id: string;
  user: string;
  content: string;
  createdAt: number;
  score: number;
  parentId: string | null;
  claim: boolean;
}

/** Scanlation = the group's own site; aggregator = re-hosts other groups' or official releases; official = the publisher's own platform. */
export type SourceKind = 'scanlation' | 'aggregator' | 'official';

/** Comics are downloaded as page-image ZIPs, novels as one EPUB per chapter. */
export type SourceMedium = 'comic' | 'novel';

export interface SourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  kind: SourceKind;
  medium: SourceMedium;
  enabled: boolean;
  /** False for sources that can only be linked by pasting a series URL. */
  searchable: boolean;
}

export interface SourceChapterAlt {
  group: string;
  url: string;
  label?: string;
  title?: string;
  date?: string;
}

export interface SourceChapter {
  number: number;
  label: string;
  url: string;
  title?: string;
  date?: string;
  locked?: boolean;
  /** Scanlation group or official uploader name on multi-source aggregators (e.g. MangaDex). */
  group?: string;
  /** Other uploads for the same chapter number from different groups/sources on this site. */
  alternatives?: SourceChapterAlt[];
}

export interface SourceSeriesHit {
  title: string;
  url: string;
  cover?: string;
  altTitles?: string[];
}

export interface SourceSeries {
  title: string;
  url: string;
  altTitles: string[];
  cover?: string;
  description?: string;
  chapters: SourceChapter[];
  /** Why `chapters` is empty when the site has the series but nothing usable, e.g. "no English chapters". */
  emptyReason?: string;
}

export interface SourceMatch {
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  seriesUrl: string;
  title: string;
  cover: string | null;
  score: number;
  chapterCount: number | null;
  latestChapter: number | null;
  error: string | null;
  fetchedAt: number;
}

export interface AtsuOtherSource {
  id: string;
  label: string;
  manual: boolean;
  chapters: number;
  latest: number | null;
  pending: number;
}

export interface AtsuSeriesState {
  /** Series exists on Atsumaru (mangaId set). It can also be "new on Atsu": known to MangaBaka only. */
  found: boolean;
  mangaId: string | null;
  mangaBakaId: string | null;
  title: string | null;
  /** Inclusive chapter ranges already published, e.g. [[1, 64]]. */
  ranges: [number, number][];
  /** Inclusive chapter ranges waiting for review. */
  waiting: [number, number][];
  total: number;
  latest: number | null;
  /** Upload sources the logged-in user owns for this series. */
  mySourceIds: string[];
  others: AtsuOtherSource[];
  error?: string;
}

/** Whether chapter `n` falls inside any inclusive [from, to] range. */
export const inRanges = (n: number, ranges: [number, number][]) => ranges.some(([a, b]) => n >= a && n <= b);

/** `downloaded` = ZIP ready, waiting for the user to upload it on atsu.moe; `uploaded` = the user confirmed it. */
export type ChapterState = 'known' | 'pending' | 'queued' | 'downloaded' | 'uploaded' | 'skipped';

export interface LinkChapter {
  id: number;
  number: number;
  label: string;
  url: string;
  locked: boolean;
  group: string | null;
  alternatives: SourceChapterAlt[];
  state: ChapterState;
  onAtsu: boolean;
  firstSeenAt: number;
}

export interface Link {
  id: number;
  requestId: string;
  requestTitle: string;
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  seriesUrl: string;
  seriesTitle: string;
  atsuMangaId: string | null;
  watch: boolean;
  checkIntervalMin: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  pendingCount: number;
  chapterCount: number;
}

export type JobState = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';

/** A chapter being fetched from its source and bundled into a ZIP for manual upload. */
export interface DownloadJob {
  id: number;
  linkId: number;
  chapterId: number;
  chapterLabel: string;
  seriesTitle: string;
  sourceName: string;
  state: JobState;
  progress: number;
  total: number;
  error: string | null;
  log: string[];
  createdAt: number;
  updatedAt: number;
  /** Size of the finished ZIP; null until the job is done. */
  fileSize: number | null;
  /** Atsumaru's upload page, pre-selecting the series when its MangaBaka id is known. */
  uploadUrl: string;
}

export interface Settings {
  atsuCookie: string;
  defaultCheckIntervalMin: number;
}

export interface SettingsView extends Omit<Settings, 'atsuCookie'> {
  atsuCookieSet: boolean;
  atsuUser: string | null;
}

export type ServerEvent =
  | { type: 'job'; job: DownloadJob }
  | { type: 'new_chapters'; linkId: number; seriesTitle: string; labels: string[] }
  /** Chapters that were paid / early access and are now free to download. */
  | { type: 'chapters_unlocked'; linkId: number; seriesTitle: string; labels: string[] }
  | { type: 'requests_synced'; added: number };
