import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LnreaderStatus } from '@atsusync/shared';
import type { SettingsStore } from '../settings.ts';
import {
  LNREADER_INDEX_URL,
  loadLnreaderPlugin,
  type LnreaderPluginInstance,
  type LnreaderPluginMeta,
} from './lnreader.ts';

export class LnreaderManager {
  private baseDir: string;
  private pluginsDir: string;
  private indexPath: string;
  private lastError: string | null = null;
  private loaded = new Map<string, LnreaderPluginInstance>();
  private catalogCount = 0;

  constructor(
    dataDir: string,
    private settings: SettingsStore,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseDir = join(dataDir, 'lnreader');
    this.pluginsDir = join(this.baseDir, 'plugins');
    this.indexPath = join(this.baseDir, 'plugins.min.json');
  }

  status(): LnreaderStatus {
    return {
      enabled: this.settings.get().lnreaderEnabled,
      pluginCount: this.catalogCount,
      lastError: this.lastError,
    };
  }

  setCatalogCount(count: number) {
    this.catalogCount = count;
  }

  async syncCatalog(): Promise<LnreaderPluginMeta[]> {
    this.lastError = null;
    try {
      const res = await this.fetchImpl(LNREADER_INDEX_URL, {
        headers: { 'user-agent': 'AtsuSync', accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch LNReader plugin index: HTTP ${res.status}`);
      }
      const entries = (await res.json()) as LnreaderPluginMeta[];
      mkdirSync(this.pluginsDir, { recursive: true });
      writeFileSync(this.indexPath, JSON.stringify(entries), 'utf8');
      this.loaded.clear();
      this.settings.update({ lnreaderEnabled: true });
      return entries;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  loadCachedCatalog(): LnreaderPluginMeta[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf8')) as LnreaderPluginMeta[];
    } catch {
      return [];
    }
  }

  disable(): LnreaderStatus {
    this.settings.update({ lnreaderEnabled: false });
    this.loaded.clear();
    this.catalogCount = 0;
    this.lastError = null;
    return this.status();
  }

  async getPlugin(meta: LnreaderPluginMeta): Promise<LnreaderPluginInstance> {
    const cacheKey = `${meta.id}@${meta.version}`;
    const existing = this.loaded.get(cacheKey);
    if (existing) return existing;

    const safeId = meta.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = join(this.pluginsDir, `${safeId}-${meta.version}.js`);
    let code: string;
    if (existsSync(filePath)) {
      code = readFileSync(filePath, 'utf8');
    } else {
      const res = await this.fetchImpl(meta.url, {
        headers: { 'user-agent': 'AtsuSync' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch LNReader plugin ${meta.name}: HTTP ${res.status}`);
      }
      code = await res.text();
      mkdirSync(this.pluginsDir, { recursive: true });
      writeFileSync(filePath, code, 'utf8');
    }

    const instance = loadLnreaderPlugin(code, this.fetchImpl);
    this.loaded.set(cacheKey, instance);
    return instance;
  }
}
