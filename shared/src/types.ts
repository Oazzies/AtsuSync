// DTOs shared between the server API and the Vue client.

export type RequestStatus = 'open' | 'queued' | 'looking' | 'added' | 'cant_add' | 'duplicate';

export interface RequestTag {
  id: string;
  name: string;
  emoji: string | null;
}

export interface MangaBaka {
  id: number;
  title: string;
  titles: string[];
  cover: string | null;
  type: string | null;
  status: string | null;
  totalChapters: number | null;
  url: string | null;
  description?: string | null;
  year?: number | null;
  authors?: string[];
  genres?: string[];
  rating?: number | null;
  contentRating?: string | null;
}

export interface AtsuSeriesInfo {
  id: string;
  title: string;
  altTitles: string[];
  synopsis: string;
  cover: string | null;
  chapterCount: number;
  medium: string | null;
}

export interface TrackerLink {
  kind: 'mangabaka' | 'anilist' | 'mal' | 'other';
  url: string;
  id: string | null;
}

export interface ContentRequest {
  id: string;
  title: string;
  customTitle?: string | null;
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

/**
 * Scanlation = the group's own site; aggregator = re-hosts other groups' or official releases; official = the
 * publisher's own platform; torrent = releases fetched through a BitTorrent swarm (Nyaa); download = direct-download file hosts;
 * suwayomi = Keiyoushi / Yūzōnō / Mihon APK extensions bridged through a running Suwayomi-Server instance;
 * lncrawl = lightnovel-crawler novel sources bridged through a local LNCrawl Python service;
 * lnreader = LNReader JS novel plugins executed directly in Node.js.
 */
export type SourceKind = 'scanlation' | 'aggregator' | 'official' | 'torrent' | 'download' | 'suwayomi' | 'lncrawl' | 'lnreader';

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
  /** True for 18+ / NSFW sources. */
  nsfw?: boolean;
}

export interface SourceSearchFilter {
  keiyoushi: boolean;
  lncrawl: boolean;
  lnreader: boolean;
  aggregators: boolean;
  scanlations: boolean;
  official: boolean;
  nsfw: boolean;
}

export const DEFAULT_SOURCE_SEARCH_FILTER: SourceSearchFilter = {
  keiyoushi: true,
  lncrawl: true,
  lnreader: true,
  aggregators: true,
  scanlations: true,
  official: true,
  nsfw: true,
};

export const SOURCE_FILTER_OPTIONS: { key: keyof SourceSearchFilter; label: string }[] = [
  { key: 'keiyoushi', label: 'Keiyoushi / Yūzōnō' },
  { key: 'lncrawl', label: 'LNCrawl' },
  { key: 'lnreader', label: 'LNReader' },
  { key: 'aggregators', label: 'Aggregators' },
  { key: 'scanlations', label: 'Scanlations' },
  { key: 'official', label: 'Official' },
  { key: 'nsfw', label: 'NSFW' },
];

export function matchesSourceFilter(
  source: { kind: SourceKind; nsfw?: boolean },
  filter?: Partial<SourceSearchFilter>,
): boolean {
  const f: SourceSearchFilter = { ...DEFAULT_SOURCE_SEARCH_FILTER, ...filter };
  if (source.nsfw && !f.nsfw) return false;
  switch (source.kind) {
    case 'suwayomi':
      return f.keiyoushi;
    case 'lncrawl':
      return f.lncrawl;
    case 'lnreader':
      return f.lnreader;
    case 'aggregator':
      return f.aggregators;
    case 'scanlation':
      return f.scanlations;
    case 'official':
      return f.official;
    default:
      return f.keiyoushi || f.lncrawl || f.lnreader || f.aggregators || f.scanlations || f.official;
  }
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

/** Rank score (0..1) combining title similarity and chapter-count closeness. */
export function sourceMatchRank(m: SourceMatch, expectedChapters?: number | null): number {
  if (expectedChapters && expectedChapters > 0) {
    const ch = m.chapterCount ?? 0;
    const chapterCloseness = ch > 0 ? Math.min(ch, expectedChapters) / Math.max(ch, expectedChapters) : 0;
    return 0.65 * m.score + 0.35 * chapterCloseness;
  }
  const chBonus = m.chapterCount && m.chapterCount > 0 ? Math.min(1, Math.log10(m.chapterCount + 1) / 3) : 0;
  return 0.85 * m.score + 0.15 * chBonus;
}

/** Sort source matches with best-fitting (no error, close title, close chapter count) first. */
export function rankSourceMatches(matches: SourceMatch[], expectedChapters?: number | null): SourceMatch[] {
  return [...matches].sort((a, b) => {
    const aErr = a.error ? 1 : 0;
    const bErr = b.error ? 1 : 0;
    if (aErr !== bErr) return aErr - bErr;
    const rankDiff = sourceMatchRank(b, expectedChapters) - sourceMatchRank(a, expectedChapters);
    if (Math.abs(rankDiff) > 1e-6) return rankDiff;
    if (b.score !== a.score) return b.score - a.score;
    const chDiff = (b.chapterCount ?? -1) - (a.chapterCount ?? -1);
    if (chDiff !== 0) return chDiff;
    return a.sourceName.localeCompare(b.sourceName);
  });
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
  cover: string | null;
  atsuMangaId: string | null;
  watch: boolean;
  checkIntervalMin: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  pendingCount: number;
  chapterCount: number;
  atsuTotal: number | null;
  atsuCheckedAt: number | null;
  missingCount: number;
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
  suwayomiUrl: string;
  lncrawlUrl: string;
  lnreaderEnabled: boolean;
}

export interface SettingsView extends Omit<Settings, 'atsuCookie'> {
  atsuCookieSet: boolean;
  atsuUser: string | null;
}

export interface NotificationSettings {
  new_chapters: boolean;
  chapters_unlocked: boolean;
  downloads_complete: boolean;
  discovery_done: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  new_chapters: true,
  chapters_unlocked: true,
  downloads_complete: true,
  discovery_done: true,
};

export interface SuwayomiStatus {
  running: boolean;
  managed: boolean;
  url: string;
  jarPresent: boolean;
  pid: number | null;
  lastError: string | null;
}

export interface LncrawlStatus {
  running: boolean;
  managed: boolean;
  url: string;
  installed: boolean;
  pid: number | null;
  lastError: string | null;
}

export interface LnreaderStatus {
  enabled: boolean;
  pluginCount: number;
  lastError: string | null;
}

export interface SuwayomiExtensionInfo {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  isNsfw: boolean;
}

export type ServerEvent =
  | { type: 'job'; job: DownloadJob }
  | { type: 'downloads_complete'; linkId: number; seriesTitle: string; count: number }
  | { type: 'new_chapters'; linkId: number; seriesTitle: string; labels: string[] }
  /** Chapters that were paid / early access and are now free to download. */
  | { type: 'chapters_unlocked'; linkId: number; seriesTitle: string; labels: string[] }
  | { type: 'discovery_start'; requestId: string; sources: { id: string; name: string }[] }
  | { type: 'discovery_progress'; requestId: string; sourceId: string; sourceName: string; matches: SourceMatch[]; error: string | null }
  | { type: 'discovery_done'; requestId: string; seriesTitle: string; matchCount: number };
