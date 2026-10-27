import type { SourceInfo } from '@atsusync/shared';
import type { Db } from '../db/client.ts';
import { mangadex } from './adapters/mangadex.ts';
import { kingofshojo } from './adapters/kingofshojo.ts';
import { mgeko } from './adapters/mgeko.ts';
import { mgread } from './adapters/mgread.ts';
import { nuviatoon } from './adapters/nuviatoon.ts';
import { webtoon } from './adapters/webtoon.ts';
import { SourceHttp } from './http.ts';
import { matchesUrl, type SourceAdapter } from './types.ts';

// Register new source sites here.
const ADAPTERS: SourceAdapter[] = [nuviatoon, mangadex, mgread, mgeko, kingofshojo, webtoon];

export class SourceRegistry {
  readonly http: SourceHttp;
  private byId = new Map<string, SourceAdapter>();

  constructor(
    private db: Db,
    adapters: SourceAdapter[] = ADAPTERS,
    http = new SourceHttp(),
  ) {
    this.http = http;
    for (const a of adapters) {
      if (this.byId.has(a.id)) throw new Error(`Duplicate source id ${a.id}`);
      this.byId.set(a.id, a);
      for (const h of a.hosts) this.http.configureHost(h, a.rateLimit);
    }
  }

  get(id: string): SourceAdapter {
    const a = this.byId.get(id);
    if (!a) throw new Error(`Unknown source ${id}`);
    return a;
  }

  find(id: string): SourceAdapter | undefined {
    return this.byId.get(id);
  }

  all(): SourceAdapter[] {
    return [...this.byId.values()];
  }

  enabled(): SourceAdapter[] {
    const disabled = new Set(
      (this.db.prepare('SELECT source_id FROM source_settings WHERE enabled = 0').all() as { source_id: string }[]).map(
        (r) => r.source_id,
      ),
    );
    return this.all().filter((a) => !disabled.has(a.id));
  }

  forUrl(url: string): SourceAdapter | undefined {
    return this.all().find((a) => matchesUrl(a, url));
  }

  info(): SourceInfo[] {
    const enabled = new Set(this.enabled().map((a) => a.id));
    return this.all().map((a) => ({ id: a.id, name: a.name, baseUrl: a.baseUrl, kind: a.kind, enabled: enabled.has(a.id), searchable: !!a.search }));
  }

  setEnabled(id: string, enabled: boolean) {
    this.get(id);
    this.db
      .prepare(
        'INSERT INTO source_settings (source_id, enabled) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET enabled = excluded.enabled',
      )
      .run(id, enabled ? 1 : 0);
  }
}
