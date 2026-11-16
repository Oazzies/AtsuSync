import type { PageRef, SourceAdapter, SourceChapter, SourceChapterAlt, SourceSeries, SourceSeriesHit } from './types.ts';

export const SUWAYOMI_PREFIX = 'suwayomi:';

export interface SuwayomiSourceNode {
  id: string;
  name: string;
  displayName: string;
  lang: string;
  homeUrl: string | null;
  baseUrl: string | null;
  isNsfw: boolean;
}

export interface SuwayomiManga {
  id: number;
  sourceId: string;
  url: string;
  realUrl: string | null;
  title: string;
  thumbnailUrl: string | null;
  artist?: string | null;
  author?: string | null;
  description?: string | null;
}

export interface SuwayomiChapter {
  id: number;
  url: string;
  name: string;
  uploadDate: number | string | null;
  chapterNumber: number;
  scanlator: string | null;
  mangaId: number;
  sourceOrder: number;
  realUrl: string | null;
  pageCount: number;
}

export interface SuwayomiExtension {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
  isNsfw: boolean;
}

const SOURCES_QUERY = `
  query Sources {
    sources {
      nodes {
        id
        name
        displayName
        lang
        homeUrl
        baseUrl
        isNsfw
      }
    }
  }
`;

const SEARCH_MUTATION = `
  mutation FetchSourceManga($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      mangas {
        id
        sourceId
        url
        realUrl
        title
        thumbnailUrl
      }
      hasNextPage
    }
  }
`;

const MANGA_AND_CHAPTERS_MUTATION = `
  mutation FetchMangaAndChapters($input: FetchMangaAndChaptersInput!) {
    fetchMangaAndChapters(input: $input) {
      manga {
        id
        sourceId
        url
        realUrl
        title
        thumbnailUrl
        author
        artist
        description
      }
      chapters {
        id
        url
        name
        uploadDate
        chapterNumber
        scanlator
        mangaId
        sourceOrder
        realUrl
        pageCount
      }
    }
  }
`;

const CHAPTER_PAGES_MUTATION = `
  mutation FetchChapterPages($input: FetchChapterPagesInput!) {
    fetchChapterPages(input: $input) {
      pages
    }
  }
`;

const ADD_EXTENSION_STORE_MUTATION = `
  mutation AddExtensionStore($input: AddExtensionStoreInput!) {
    addExtensionStore(input: $input) {
      extensionStore {
        name
        indexUrl
      }
    }
  }
`;

const FETCH_EXTENSIONS_MUTATION = `
  mutation FetchExtensions($input: FetchExtensionsInput!) {
    fetchExtensions(input: $input) {
      extensions {
        pkgName
        name
        lang
        versionName
        isInstalled
        hasUpdate
        isNsfw
      }
    }
  }
`;

const UPDATE_EXTENSION_MUTATION = `
  mutation UpdateExtension($input: UpdateExtensionInput!) {
    updateExtension(input: $input) {
      extension {
        pkgName
        isInstalled
      }
    }
  }
`;

const UPDATE_EXTENSIONS_MUTATION = `
  mutation UpdateExtensions($input: UpdateExtensionsInput!) {
    updateExtensions(input: $input) {
      extensions {
        pkgName
        isInstalled
      }
    }
  }
`;

export function isEnglishLang(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'en' || l === 'all';
}

const isAtsumaruUrl = (raw: string | null | undefined): boolean => {
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'atsu.moe' || host.endsWith('.atsu.moe');
  } catch {
    return false;
  }
};

/** Atsumaru is the upload target itself, never a source to scrape from. */
export function isAtsumaruSource(node: Pick<SuwayomiSourceNode, 'name' | 'displayName' | 'homeUrl' | 'baseUrl'>): boolean {
  return (
    isAtsumaruUrl(node.homeUrl) ||
    isAtsumaruUrl(node.baseUrl) ||
    /\batsumaru\b/i.test(node.name) ||
    /\batsumaru\b/i.test(node.displayName)
  );
}

/** Skip the Atsumaru Keiyoushi extension so we never install or list our own target site. */
export function isAtsumaruExtension(ext: Pick<SuwayomiExtension, 'pkgName' | 'name'>): boolean {
  return /(?:^|\.)atsumaru(?:$|\.)/i.test(ext.pkgName) || /\batsumaru\b/i.test(ext.name);
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Client for Suwayomi-Server's GraphQL API, which hosts Keiyoushi/Mihon APK extensions. */
export class SuwayomiClient {
  constructor(
    private getBaseUrl: () => string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  baseUrl(): string {
    return normalizeBaseUrl(this.getBaseUrl());
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const base = this.baseUrl();
    if (!base) throw new Error('Suwayomi-Server URL is not configured');
    const res = await this.fetchImpl(`${base}/api/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Suwayomi HTTP ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (payload.errors?.length) {
      throw new Error(`Suwayomi GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`);
    }
    if (!payload.data) throw new Error('Suwayomi returned an empty GraphQL response');
    return payload.data;
  }

  async listSources(): Promise<SuwayomiSourceNode[]> {
    const data = await this.graphql<{ sources: { nodes: SuwayomiSourceNode[] } }>(SOURCES_QUERY);
    return data.sources.nodes;
  }

  async search(sourceId: string, query: string): Promise<SuwayomiManga[]> {
    const data = await this.graphql<{ fetchSourceManga: { mangas: SuwayomiManga[] } }>(SEARCH_MUTATION, {
      input: { source: sourceId, type: 'SEARCH', page: 1, query },
    });
    return data.fetchSourceManga.mangas;
  }

  async getMangaAndChapters(mangaId: number): Promise<{ manga: SuwayomiManga; chapters: SuwayomiChapter[] }> {
    const data = await this.graphql<{ fetchMangaAndChapters: { manga: SuwayomiManga; chapters: SuwayomiChapter[] } }>(
      MANGA_AND_CHAPTERS_MUTATION,
      { input: { id: mangaId, fetchManga: true, fetchChapters: true } },
    );
    return data.fetchMangaAndChapters;
  }

  async getChapterPages(chapterId: number): Promise<string[]> {
    const data = await this.graphql<{ fetchChapterPages: { pages: string[] } }>(CHAPTER_PAGES_MUTATION, {
      input: { chapterId },
    });
    return data.fetchChapterPages.pages;
  }

  async ping(): Promise<boolean> {
    try {
      await this.graphql<{ __typename: string }>('{ __typename }');
      return true;
    } catch {
      return false;
    }
  }

  async addExtensionStore(indexUrl: string): Promise<void> {
    await this.graphql(ADD_EXTENSION_STORE_MUTATION, { input: { indexUrl } });
  }

  async fetchExtensions(): Promise<SuwayomiExtension[]> {
    const data = await this.graphql<{ fetchExtensions: { extensions: SuwayomiExtension[] } }>(
      FETCH_EXTENSIONS_MUTATION,
      { input: {} },
    );
    return data.fetchExtensions.extensions;
  }

  async setExtensionInstalled(pkgName: string, install: boolean): Promise<void> {
    await this.graphql(UPDATE_EXTENSION_MUTATION, {
      input: { id: pkgName, patch: install ? { install: true } : { uninstall: true } },
    });
  }

  async installAndUpdateExtensions(pkgNames: string[]): Promise<void> {
    const CHUNK = 20;
    for (let i = 0; i < pkgNames.length; i += CHUNK) {
      const ids = pkgNames.slice(i, i + CHUNK);
      try {
        await this.graphql(UPDATE_EXTENSIONS_MUTATION, {
          input: { ids, patch: { install: true, update: true } },
        });
      } catch {
        // Fall back one-by-one if a single extension in the batch fails to download/install.
        for (const id of ids) {
          await this.graphql(UPDATE_EXTENSION_MUTATION, {
            input: { id, patch: { install: true, update: true } },
          }).catch(() => {});
        }
      }
    }
  }
}

function resolveAsset(pathOrUrl: string | null | undefined, baseUrl: string): string | undefined {
  if (!pathOrUrl) return undefined;
  try {
    return new URL(pathOrUrl, baseUrl).href;
  } catch {
    return undefined;
  }
}

export function extractMangaId(url: string): number | null {
  const hash = url.match(/#suwayomi=(\d+)/)?.[1];
  if (hash) return Number(hash);
  const path = url.match(/\/manga\/(\d+)/)?.[1];
  return path ? Number(path) : null;
}

export function extractChapterId(url: string): number | null {
  const hash = url.match(/#suwayomi-ch=(\d+)/)?.[1];
  return hash ? Number(hash) : null;
}

function parseChapterNumber(ch: SuwayomiChapter): number {
  if (Number.isFinite(ch.chapterNumber) && ch.chapterNumber >= 0) return ch.chapterNumber;
  const match = ch.name.match(/(?:ch(?:apter)?\.?\s*#?|ep\.?\s*)(\d+(?:\.\d+)?)/i)?.[1];
  if (match) return Number(match);
  return ch.sourceOrder;
}

function buildSeriesUrl(m: Pick<SuwayomiManga, 'id' | 'realUrl'>, baseUrl: string): string {
  const base = m.realUrl || `${baseUrl}/manga/${m.id}`;
  return `${base.split('#')[0]}#suwayomi=${m.id}`;
}

function buildChapterUrl(ch: SuwayomiChapter, baseUrl: string): string {
  const base = ch.realUrl || `${baseUrl}/manga/${ch.mangaId}/chapter/${ch.id}`;
  return `${base.split('#')[0]}#suwayomi-ch=${ch.id}`;
}

/** Parses Suwayomi's `LongString` (or numeric) epoch-ms `uploadDate` into `YYYY-MM-DD`, never throwing. */
function formatUploadDate(raw: number | string | null | undefined): string | undefined {
  if (raw == null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return undefined;
}

/** Wraps one installed Suwayomi/Keiyoushi source as an AtsuSync SourceAdapter. */
export function createSuwayomiAdapter(node: SuwayomiSourceNode, client: SuwayomiClient): SourceAdapter {
  const base = () => client.baseUrl();
  return {
    id: `${SUWAYOMI_PREFIX}${node.id}`,
    name: node.displayName || node.name,
    baseUrl: node.homeUrl || node.baseUrl || base() || 'http://localhost:4567',
    kind: 'suwayomi',
    medium: 'comic',
    hosts: [],
    rateLimit: { rpm: 600, concurrency: 4 },

    async search(title: string): Promise<SourceSeriesHit[]> {
      const mangas = await client.search(node.id, title);
      const b = base();
      return mangas.map((m) => ({
        title: m.title,
        url: buildSeriesUrl(m, b),
        cover: resolveAsset(m.thumbnailUrl, b),
      }));
    },

    async getSeries(url: string): Promise<SourceSeries> {
      const mangaId = extractMangaId(url);
      if (mangaId == null || !Number.isFinite(mangaId)) {
        throw new Error(`Invalid Suwayomi series URL: ${url}`);
      }
      const b = base();
      const { manga, chapters: rawChapters } = await client.getMangaAndChapters(mangaId);

      const byNumber = new Map<number, SourceChapter>();
      for (const ch of rawChapters) {
        const number = parseChapterNumber(ch);
        if (!Number.isFinite(number)) continue;
        const chUrl = buildChapterUrl(ch, b);
        const date = formatUploadDate(ch.uploadDate);
        const group = ch.scanlator?.trim() || undefined;
        const existing = byNumber.get(number);
        if (!existing) {
          byNumber.set(number, {
            number,
            label: ch.name || `Chapter ${number}`,
            url: chUrl,
            group,
            date,
          });
        } else {
          const alt: SourceChapterAlt = {
            group: group ?? 'Unknown',
            url: chUrl,
            label: ch.name || undefined,
            date,
          };
          existing.alternatives = [...(existing.alternatives ?? []), alt];
        }
      }

      return {
        title: manga.title,
        url: buildSeriesUrl(manga, b),
        altTitles: [],
        cover: resolveAsset(manga.thumbnailUrl, b),
        description: manga.description ?? undefined,
        chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
      };
    },

    async getChapterPages(chapter: SourceChapter): Promise<PageRef[]> {
      const chapterId = extractChapterId(chapter.url);
      if (chapterId == null || !Number.isFinite(chapterId)) {
        throw new Error(`Invalid Suwayomi chapter URL: ${chapter.url}`);
      }
      const b = base();
      const pages = await client.getChapterPages(chapterId);
      return pages.map((p, i) => ({
        url: new URL(p, b).href,
        name: `${String(i + 1).padStart(3, '0')}.jpg`,
      }));
    },
  };
}
