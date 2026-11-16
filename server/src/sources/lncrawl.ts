import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from './novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from './types.ts';

export const LNCRAWL_PREFIX = 'lncrawl:';

export interface LncrawlSourceNode {
  domain: string;
  url: string;
  language: string;
  canSearch: boolean;
  hasMtl: boolean;
  hasManga: boolean;
}

export interface LncrawlSearchHit {
  title: string;
  url: string;
  info?: string | null;
}

export interface LncrawlSeriesResult {
  title: string;
  url: string;
  cover?: string | null;
  author?: string | null;
  synopsis?: string | null;
  chapters: { id?: number | string | null; title: string; url: string; volume?: number | null }[];
}

export interface LncrawlChapterResult {
  title?: string | null;
  html: string;
}

export function normalizeLncrawlBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^www\./, '');
}

export function isEnglishLncrawlLang(lang: string): boolean {
  const l = lang.trim().toLowerCase();
  return l === '' || l === 'en' || l === 'all';
}

function isAtsumaruDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  return d === 'atsu.moe' || d.endsWith('.atsu.moe');
}

function isBetterLncrawlNode(candidate: LncrawlSourceNode, current: LncrawlSourceNode): boolean {
  if (candidate.canSearch !== current.canSearch) return candidate.canSearch;
  if (candidate.hasMtl !== current.hasMtl) return !candidate.hasMtl;
  return false;
}

/**
 * Deduplicates LNCrawl sources by normalized domain and skips domains already
 * handled by built-in AtsuSync adapters (e.g. NovelCool, Wuxiaworld, Hiraeth).
 */
export function dedupeLncrawlSources(
  nodes: LncrawlSourceNode[],
  existingAdapters: Iterable<Pick<SourceAdapter, 'id' | 'hosts' | 'baseUrl'>> = [],
): LncrawlSourceNode[] {
  const takenHosts = new Set<string>();
  for (const a of existingAdapters) {
    if (a.id.startsWith(LNCRAWL_PREFIX)) continue;
    for (const h of a.hosts) takenHosts.add(normalizeDomain(h));
    try {
      takenHosts.add(normalizeDomain(new URL(a.baseUrl).hostname));
    } catch {
      // ignore invalid baseUrl
    }
  }

  const byDomain = new Map<string, LncrawlSourceNode>();
  for (const node of nodes) {
    const domain = normalizeDomain(node.domain);
    if (!domain || isAtsumaruDomain(domain) || takenHosts.has(domain)) continue;
    const normalized: LncrawlSourceNode = { ...node, domain };
    const existing = byDomain.get(domain);
    if (!existing || isBetterLncrawlNode(normalized, existing)) {
      byDomain.set(domain, normalized);
    }
  }

  return [...byDomain.values()];
}

/** Client for AtsuSync's local lightnovel-crawler HTTP bridge. */
export class LncrawlClient {
  constructor(
    private getBaseUrl: () => string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  baseUrl(): string {
    return normalizeLncrawlBaseUrl(this.getBaseUrl());
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const base = this.baseUrl();
    if (!base) throw new Error('LNCrawl bridge URL is not configured');
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await this.fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      signal,
    });
    const payload = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) {
      throw new Error(payload?.error || `LNCrawl HTTP ${res.status} ${res.statusText}`);
    }
    if (!payload) throw new Error('LNCrawl returned an empty response');
    return payload;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request<{ ok: boolean }>('/health', undefined, { timeoutMs: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  async listSources(): Promise<LncrawlSourceNode[]> {
    const data = await this.request<{ sources: LncrawlSourceNode[] }>('/sources');
    return data.sources;
  }

  async search(baseUrl: string, query: string): Promise<LncrawlSearchHit[]> {
    const data = await this.request<{ hits: LncrawlSearchHit[] }>('/search', {
      method: 'POST',
      body: JSON.stringify({ url: baseUrl, query }),
    });
    return data.hits;
  }

  async getSeries(url: string): Promise<LncrawlSeriesResult> {
    return this.request<LncrawlSeriesResult>('/series', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  }

  async getChapter(chapterUrl: string, novelUrl?: string, chapterId?: number | string): Promise<LncrawlChapterResult> {
    return this.request<LncrawlChapterResult>('/chapter', {
      method: 'POST',
      body: JSON.stringify({ chapterUrl, novelUrl, chapterId }),
    });
  }
}

/** Wraps one lightnovel-crawler source as an AtsuSync novel SourceAdapter. */
export function createLncrawlAdapter(node: LncrawlSourceNode, client: LncrawlClient): SourceAdapter {
  const domain = normalizeDomain(node.domain);
  const adapter: SourceAdapter = {
    id: `${LNCRAWL_PREFIX}${domain}`,
    name: domain,
    baseUrl: node.url,
    kind: 'lncrawl',
    medium: 'novel',
    hosts: [domain],
    rateLimit: { rpm: 30, concurrency: 1 },

    async getSeries(url: string): Promise<SourceSeries> {
      const series = await client.getSeries(url);
      const byNumber = new Map<number, SourceChapter>();
      series.chapters.forEach((ch, idx) => {
        const number = chapterNumberFrom(ch.title, ch.url) ?? idx + 1;
        if (!Number.isFinite(number) || byNumber.has(number)) return;
        byNumber.set(number, {
          number,
          label: ch.title || `Chapter ${number}`,
          url: ch.url,
        });
      });

      return {
        title: series.title || domain,
        url: series.url || url,
        altTitles: [],
        cover: series.cover || undefined,
        description: series.synopsis || undefined,
        chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
      };
    },

    async getChapterPages(): Promise<never[]> {
      return [];
    },

    async getChapterText(chapter: SourceChapter): Promise<NovelChapter> {
      const res = await client.getChapter(chapter.url);
      const $ = cheerio.load(`<div id="lncrawl-body">${res.html || ''}</div>`);
      const html = chapterXhtml($, $('#lncrawl-body'));
      return {
        title: res.title || chapter.label,
        html,
      };
    },
  };

  if (node.canSearch) {
    adapter.search = async (title: string): Promise<SourceSeriesHit[]> => {
      const hits = await client.search(node.url, title);
      return hits.map((h) => ({
        title: h.title,
        url: h.url,
      }));
    };
  }

  return adapter;
}
