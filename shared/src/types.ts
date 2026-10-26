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
  commentCount: number;
  score: number;
  createdAt: number;
  linkCount: number;
}

export interface SourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
}

export interface SourceChapter {
  number: number;
  label: string;
  url: string;
  title?: string;
  date?: string;
  locked?: boolean;
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
}

export interface SourceMatch {
  sourceId: string;
  sourceName: string;
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

export type ChapterState = 'known' | 'pending' | 'queued' | 'uploaded' | 'skipped';

export interface LinkChapter {
  id: number;
  number: number;
  label: string;
  url: string;
  locked: boolean;
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

export type JobState = 'queued' | 'downloading' | 'uploading' | 'submitting' | 'done' | 'failed' | 'cancelled';

export interface UploadJob {
  id: number;
  linkId: number;
  chapterId: number;
  chapterLabel: string;
  seriesTitle: string;
  sourceName: string;
  state: JobState;
  progress: number;
  total: number;
  dryRun: boolean;
  error: string | null;
  log: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  atsuCookie: string;
  dryRun: boolean;
  defaultCheckIntervalMin: number;
  /** Atsumaru upload group to publish under; empty = "Just me". */
  atsuGroupId: string;
}

export interface SettingsView extends Omit<Settings, 'atsuCookie'> {
  atsuCookieSet: boolean;
  atsuUser: string | null;
}

export type ServerEvent =
  | { type: 'job'; job: UploadJob }
  | { type: 'new_chapters'; linkId: number; seriesTitle: string; labels: string[] }
  | { type: 'requests_synced'; added: number };
