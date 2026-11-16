import type { SourceChapter, SourceKind, SourceSeries, SourceSeriesHit } from '@atsusync/shared';
import type { SourceHttp } from './http.ts';

export type { SourceChapter, SourceChapterAlt, SourceKind, SourceSeries, SourceSeriesHit };

/** A single image to download for a chapter, with any headers the host requires. */
export interface PageRef {
  url: string;
  /** File name used when uploading, e.g. "001.webp". */
  name: string;
  headers?: Record<string, string>;
  width?: number;
  height?: number;
}

export interface SourceAdapter {
  /** Stable id stored in the DB. Never change it once links exist. */
  id: string;
  name: string;
  baseUrl: string;
  kind: SourceKind;
  /** Hostnames this adapter owns; used for "paste a URL" and the rate limiter. */
  hosts: string[];
  /** Politeness budget, applied per host by SourceHttp. */
  rateLimit: { rpm: number; concurrency: number };

  /** Omit for sites that can't be searched (e.g. robots.txt forbids it); they can still be linked by URL. */
  search?(title: string, http: SourceHttp): Promise<SourceSeriesHit[]>;
  getSeries(url: string, http: SourceHttp): Promise<SourceSeries>;
  /** Resolve pages right before downloading — some hosts sign URLs with short expiries. */
  getChapterPages(chapter: SourceChapter, http: SourceHttp): Promise<PageRef[]>;
}

export const matchesUrl = (adapter: SourceAdapter, url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return adapter.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};
