import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import { chapterNumberFrom, chapterXhtml } from './novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from './types.ts';

export const LNREADER_PREFIX = 'lnreader:';
export const LNREADER_INDEX_URL =
  'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export interface LnreaderPluginMeta {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  url: string;
  iconUrl?: string;
}

export interface LnreaderChapterItem {
  name: string;
  path: string;
  releaseTime?: string | null;
  chapterNumber?: number;
}

export interface LnreaderNovelItem {
  name: string;
  path: string;
  cover?: string;
}

export interface LnreaderSourceNovel extends LnreaderNovelItem {
  summary?: string;
  author?: string;
  chapters?: LnreaderChapterItem[];
  totalPages?: number;
}

export interface LnreaderPluginInstance {
  id: string;
  name: string;
  site: string;
  searchNovels?(searchTerm: string, pageNo: number): Promise<LnreaderNovelItem[]>;
  parseNovel(novelPath: string): Promise<LnreaderSourceNovel>;
  parsePage?(novelPath: string, page: string): Promise<{ chapters: LnreaderChapterItem[] }>;
  parseChapter(chapterPath: string): Promise<string>;
}

function normalizeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.trim().toLowerCase().replace(/^www\./, '');
  }
}

export function isEnglishLnreaderLang(lang: string): boolean {
  const l = lang.trim().toLowerCase();
  return l === 'english' || l === 'en';
}

/**
 * Deduplicates LNReader plugins by plugin id and site domain, skipping Atsumaru
 * and any domain already served by built-in or LNCrawl adapters.
 */
export function dedupeLnreaderSources(
  entries: LnreaderPluginMeta[],
  existingAdapters: Iterable<Pick<SourceAdapter, 'id' | 'hosts' | 'baseUrl'>> = [],
): LnreaderPluginMeta[] {
  const takenHosts = new Set<string>();
  for (const a of existingAdapters) {
    if (a.id.startsWith(LNREADER_PREFIX)) continue;
    for (const h of a.hosts) takenHosts.add(normalizeHost(h));
    if (a.baseUrl) takenHosts.add(normalizeHost(a.baseUrl));
  }

  const byId = new Map<string, LnreaderPluginMeta>();
  const byHost = new Map<string, LnreaderPluginMeta>();

  for (const entry of entries) {
    if (!isEnglishLnreaderLang(entry.lang)) continue;
    const host = normalizeHost(entry.site);
    if (!host || host === 'atsu.moe' || host.endsWith('.atsu.moe') || takenHosts.has(host)) continue;

    const existing = byId.get(entry.id) ?? byHost.get(host);
    if (!existing || entry.version.localeCompare(existing.version, undefined, { numeric: true }) > 0) {
      if (existing) {
        byId.delete(existing.id);
        byHost.delete(normalizeHost(existing.site));
      }
      byId.set(entry.id, entry);
      byHost.set(host, entry);
    }
  }

  return [...byId.values()];
}

function createFetchLib(fetchImpl: typeof fetch) {
  const defaultHeaders: Record<string, string> = {
    Connection: 'keep-alive',
    Accept: '*/*',
    'Accept-Language': '*',
    'User-Agent': ANDROID_UA,
  };

  const fetchApi = async (url: string, init?: RequestInit) => {
    const headers = new Headers(defaultHeaders);
    if (init?.headers) {
      const incoming = new Headers(init.headers);
      incoming.forEach((v, k) => headers.set(k, v));
    }
    return fetchImpl(url, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  };

  const fetchText = async (url: string, init?: RequestInit) => (await fetchApi(url, init)).text();
  const fetchFile = async (url: string, init?: RequestInit) => {
    const buf = Buffer.from(await (await fetchApi(url, init)).arrayBuffer());
    return buf.toString('base64');
  };

  return { fetchApi, fetchText, fetchFile, fetchProto: async () => ({}) };
}

function createStorageLib() {
  const mem = new Map<string, unknown>();
  return {
    storage: {
      get: (k: string) => mem.get(k),
      set: (k: string, v: unknown) => {
        mem.set(k, v);
      },
      delete: (k: string) => {
        mem.delete(k);
      },
      clearAll: () => mem.clear(),
    },
  };
}

const nodeRequire = createRequire(import.meta.url);

export function createPluginRequire(fetchImpl: typeof fetch = fetch): (id: string) => unknown {
  const fetchLib = createFetchLib(fetchImpl);
  const storageLib = createStorageLib();
  const libs: Record<string, unknown> = {
    cheerio,
    '@libs/fetch': fetchLib,
    '@lib/fetch': fetchLib,
    '@libs/defaultCover': { defaultCover: '' },
    '@libs/novelStatus': {
      NovelStatus: {
        Unknown: 'Unknown',
        Ongoing: 'Ongoing',
        Completed: 'Completed',
        Licensed: 'Licensed',
        PublishingFinished: 'Publishing Finished',
        Cancelled: 'Cancelled',
        OnHiatus: 'On Hiatus',
      },
    },
    '@libs/filterInputs': {
      FilterTypes: {
        TextInput: 'Text',
        Picker: 'Picker',
        CheckboxGroup: 'Checkbox',
        Switch: 'Switch',
        ExcludableCheckboxGroup: 'XCheckbox',
      },
    },
    '@libs/isAbsoluteUrl': { isUrlAbsolute: (u: string) => /^https?:\/\//i.test(u) },
    '@libs/storage': storageLib,
    '@libs/aes': {},
    crypto,
    'node:crypto': crypto,
  };

  return (id: string) => {
    if (id in libs) return libs[id];
    try {
      return nodeRequire(id);
    } catch {
      return {};
    }
  };
}

/** Evaluates a compiled CommonJS LNReader plugin and returns its exported plugin instance. */
export function loadLnreaderPlugin(code: string, fetchImpl: typeof fetch = fetch): LnreaderPluginInstance {
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: createPluginRequire(fetchImpl),
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    Buffer,
    TextDecoder,
    TextEncoder,
    FormData,
    Headers,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(code, sandbox, { timeout: 5_000 });
  const exported = (moduleObj.exports.default ?? moduleObj.exports) as LnreaderPluginInstance;
  if (!exported || typeof exported.parseNovel !== 'function' || typeof exported.parseChapter !== 'function') {
    throw new Error('Invalid LNReader plugin export');
  }
  return exported;
}

function buildUrlWithPath(site: string, path: string, hashKey: string): string {
  const base = /^https?:\/\//i.test(path) ? path : new URL(path, site).href;
  return `${base.split('#')[0]}#${hashKey}=${encodeURIComponent(path)}`;
}

function extractPluginPath(url: string, hashKey: string): string {
  const match = url.match(new RegExp(`#${hashKey}=([^#]+)`));
  if (match?.[1]) return decodeURIComponent(match[1]);
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function resolveCover(cover: string | undefined, site: string): string | undefined {
  if (!cover) return undefined;
  try {
    return new URL(cover, site).href;
  } catch {
    return undefined;
  }
}

/** Wraps one LNReader JS plugin as an AtsuSync novel SourceAdapter. */
export function createLnreaderAdapter(
  meta: LnreaderPluginMeta,
  getPlugin: () => Promise<LnreaderPluginInstance>,
): SourceAdapter {
  const host = normalizeHost(meta.site);
  return {
    id: `${LNREADER_PREFIX}${meta.id}`,
    name: meta.name,
    baseUrl: meta.site,
    kind: 'lnreader',
    medium: 'novel',
    hosts: host ? [host] : [],
    rateLimit: { rpm: 30, concurrency: 1 },

    async search(title: string): Promise<SourceSeriesHit[]> {
      const plugin = await getPlugin();
      if (typeof plugin.searchNovels !== 'function') return [];
      const hits = await plugin.searchNovels(title, 1);
      return (hits ?? []).map((h) => ({
        title: h.name,
        url: buildUrlWithPath(meta.site, h.path, 'lnreader'),
        cover: resolveCover(h.cover, meta.site),
      }));
    },

    async getSeries(url: string): Promise<SourceSeries> {
      const plugin = await getPlugin();
      const novelPath = extractPluginPath(url, 'lnreader');
      const novel = await plugin.parseNovel(novelPath);
      const rawChapters = [...(novel.chapters ?? [])];

      if (!rawChapters.length && novel.totalPages && novel.totalPages > 1 && typeof plugin.parsePage === 'function') {
        for (let p = 1; p <= novel.totalPages; p++) {
          const pageData = await plugin.parsePage(novelPath, String(p));
          if (pageData?.chapters?.length) rawChapters.push(...pageData.chapters);
        }
      }

      const byNumber = new Map<number, SourceChapter>();
      rawChapters.forEach((ch, idx) => {
        const number =
          (typeof ch.chapterNumber === 'number' && Number.isFinite(ch.chapterNumber) ? ch.chapterNumber : null) ??
          chapterNumberFrom(ch.name, ch.path) ??
          idx + 1;
        if (!Number.isFinite(number) || byNumber.has(number)) return;
        byNumber.set(number, {
          number,
          label: ch.name || `Chapter ${number}`,
          url: buildUrlWithPath(meta.site, ch.path, 'lnreader-ch'),
          date: ch.releaseTime?.slice(0, 10) || undefined,
        });
      });

      return {
        title: novel.name || meta.name,
        url: buildUrlWithPath(meta.site, novel.path || novelPath, 'lnreader'),
        altTitles: [],
        cover: resolveCover(novel.cover, meta.site),
        description: novel.summary || undefined,
        chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
      };
    },

    async getChapterPages(): Promise<never[]> {
      return [];
    },

    async getChapterText(chapter: SourceChapter): Promise<NovelChapter> {
      const plugin = await getPlugin();
      const chPath = extractPluginPath(chapter.url, 'lnreader-ch');
      const rawHtml = await plugin.parseChapter(chPath);
      const $ = cheerio.load(`<div id="lnreader-body">${rawHtml || ''}</div>`);
      return {
        title: chapter.label,
        html: chapterXhtml($, $('#lnreader-body')),
      };
    },
  };
}
