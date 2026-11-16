import type { SourceChapter, SourceChapterAlt, SourceKind, SourceMedium, SourceSeries, SourceSeriesHit } from '@atsusync/shared';
import type { SourceHttp } from './http.ts';
import type { TorrentClient } from './torrent.ts';

export type { SourceChapter, SourceChapterAlt, SourceKind, SourceMedium, SourceSeries, SourceSeriesHit };

/** A single image to download for a chapter, with any headers the host requires. */
export interface PageRef {
  url: string;
  /** File name used when uploading, e.g. "001.webp". */
  name: string;
  headers?: Record<string, string>;
  width?: number;
  height?: number;
}

/** What a download-type source (torrent / direct download) hands back for one chapter. */
export type FetchedChapter =
  | { type: 'pages'; files: { name: string; bytes: Uint8Array }[] }
  /** A ready-made ebook (epub, pdf, docx, txt, md), saved as-is. `ext` has no dot. */
  | { type: 'ebook'; ext: string; bytes: Uint8Array };

/** Services the download pipeline gives a source that fetches whole files instead of page URLs. */
export interface FetchContext {
  http: SourceHttp;
  torrents: TorrentClient;
  /** Report progress 0..100 for the job's progress bar. */
  progress(percent: number): void;
  log(msg: string): void;
  /** Throws when the user cancelled the job. */
  checkCancel(): void;
}

export interface SourceAdapter {
  /** Stable id stored in the DB. Never change it once links exist. */
  id: string;
  name: string;
  baseUrl: string;
  kind: SourceKind;
  /** Defaults to 'comic'. A 'novel' adapter implements getChapterText; its chapters download as EPUBs. */
  medium?: SourceMedium;
  /** Hostnames this adapter owns; used for "paste a URL" and the rate limiter. */
  hosts: string[];
  /** Politeness budget, applied per host by SourceHttp. */
  rateLimit: { rpm: number; concurrency: number };

  /** Omit for sites that can't be searched (e.g. robots.txt forbids it); they can still be linked by URL. */
  search?(title: string, http: SourceHttp): Promise<SourceSeriesHit[]>;
  getSeries(url: string, http: SourceHttp): Promise<SourceSeries>;
  /** Resolve pages right before downloading — some hosts sign URLs with short expiries. */
  getChapterPages(chapter: SourceChapter, http: SourceHttp): Promise<PageRef[]>;
  /**
   * Download-type sources (kind 'torrent' / 'download'): fetch the chapter's file(s) and return pages or an ebook.
   * When present the pipeline uses this instead of getChapterPages / getChapterText.
   */
  fetchChapter?(chapter: SourceChapter, ctx: FetchContext): Promise<FetchedChapter>;
  /** Novel sources: the chapter's text as XHTML paragraphs (see novel.ts). Required when medium is 'novel'. */
  getChapterText?(chapter: SourceChapter, http: SourceHttp): Promise<NovelChapter>;
}

export const matchesUrl = (adapter: SourceAdapter, url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return adapter.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

/** A novel chapter's text. `html` is well-formed XHTML (block elements only) ready to drop into an EPUB body. */
export interface NovelChapter {
  title: string;
  html: string;
  /** Inline images referenced from `html` by `src`; bundled into the EPUB. */
  images?: { src: string; url: string; headers?: Record<string, string> }[];
}

export const mediumOf = (a: Pick<SourceAdapter, 'medium'>): SourceMedium => a.medium ?? 'comic';
