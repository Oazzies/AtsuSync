import type { SourceInfo } from '@atsusync/shared';
import type { Db } from '../db/client.ts';
import { aquareader } from './adapters/aquareader.ts';
import { arenascan } from './adapters/arenascan.ts';
import { cocomic } from './adapters/cocomic.ts';
import { danke } from './adapters/danke.ts';
import { demonicscans } from './adapters/demonicscans.ts';
import { dynasty } from './adapters/dynasty.ts';
import { flamecomics } from './adapters/flamecomics.ts';
import { lewdmanhwa } from './adapters/lewdmanhwa.ts';
import { mangack } from './adapters/mangack.ts';
import { mangacherri } from './adapters/mangacherri.ts';
import { mangadex } from './adapters/mangadex.ts';
import { mangafreak } from './adapters/mangafreak.ts';
import { mangakatana } from './adapters/mangakatana.ts';
import { mangamikan } from './adapters/mangamikan.ts';
import { manganatogg } from './adapters/manganatogg.ts';
import { manhuabuddy } from './adapters/manhuabuddy.ts';
import { manhwanex } from './adapters/manhwanex.ts';
import { hiraeth } from './adapters/hiraeth.ts';
import { kingofshojo } from './adapters/kingofshojo.ts';
import { knoxt } from './adapters/knoxt.ts';
import { mgeko } from './adapters/mgeko.ts';
import { mangapill } from './adapters/mangapill.ts';
import { mangaread } from './adapters/mangaread.ts';
import { mangazin } from './adapters/mangazin.ts';
import { lightnovelto } from './adapters/lightnovelto.ts';
import { lnmtl } from './adapters/lnmtl.ts';
import { nyaa, nyaaNovel } from './adapters/nyaa.ts';
import { novelcool } from './adapters/novelcool.ts';
import { novelphoenix } from './adapters/novelphoenix.ts';
import { novelping } from './adapters/novelping.ts';
import { novelstime } from './adapters/novelstime.ts';
import { novgo } from './adapters/novgo.ts';
import { nuviatoon } from './adapters/nuviatoon.ts';
import { nyxscans } from './adapters/nyxscans.ts';
import { penandpaper } from './adapters/penandpaper.ts';
import { readmanga } from './adapters/readmanga.ts';
import { requiemtls } from './adapters/requiemtls.ts';
import { rokaricomics } from './adapters/rokaricomics.ts';
import { scrollerspub } from './adapters/scrollerspub.ts';
import { webcomics } from './adapters/webcomics.ts';
import { webtoon } from './adapters/webtoon.ts';
import { webtoonclub } from './adapters/webtoonclub.ts';
import { weebcentral } from './adapters/weebcentral.ts';
import { woopread } from './adapters/woopread.ts';
import { wuxiaclick } from './adapters/wuxiaclick.ts';
import { wuxiadreams } from './adapters/wuxiadreams.ts';
import { wuxiaworld } from './adapters/wuxiaworld.ts';
import { wuxiaworldsite } from './adapters/wuxiaworldsite.ts';
import { SourceHttp } from './http.ts';
import { matchesUrl, mediumOf, type SourceAdapter } from './types.ts';

// Register new source sites here.
const ADAPTERS: SourceAdapter[] = [
  nuviatoon,
  mangadex,
  mgeko,
  kingofshojo,
  webtoon,
  mangapill,
  lewdmanhwa,
  mangafreak,
  arenascan,
  weebcentral,
  dynasty,
  mangacherri,
  danke,
  readmanga,
  mangaread,
  webcomics,
  mangazin,
  rokaricomics,
  flamecomics,
  webtoonclub,
  mangack,
  nyxscans,
  aquareader,
  demonicscans,
  manhuabuddy,
  mangamikan,
  cocomic,
  manhwanex,
  mangakatana,
  manganatogg,
  // Novels (downloaded as EPUBs)
  wuxiaworld,
  novelcool,
  wuxiaworldsite,
  hiraeth,
  knoxt,
  penandpaper,
  wuxiadreams,
  novelphoenix,
  novelstime,
  requiemtls,
  wuxiaclick,
  lightnovelto,
  lnmtl,
  novgo,
  novelping,
  woopread,
  scrollerspub,
  // Torrents (fetched through the built-in BitTorrent client)
  nyaa,
  nyaaNovel,
];

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
    return this.all().map((a) => ({ id: a.id, name: a.name, baseUrl: a.baseUrl, kind: a.kind, medium: mediumOf(a), enabled: enabled.has(a.id), searchable: !!a.search }));
  }

  setEnabled(id: string, enabled: boolean) {
    this.get(id);
    this.db
      .prepare(
        'INSERT INTO source_settings (source_id, enabled) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET enabled = excluded.enabled',
      )
      .run(id, enabled ? 1 : 0);
  }

  /** Replace all dynamically registered adapters whose id starts with `prefix`. */
  replaceDynamic(prefix: string, adapters: SourceAdapter[]) {
    for (const id of [...this.byId.keys()]) {
      if (id.startsWith(prefix)) this.byId.delete(id);
    }
    for (const a of adapters) {
      if (this.byId.has(a.id)) throw new Error(`Duplicate source id ${a.id}`);
      this.byId.set(a.id, a);
      for (const h of a.hosts) this.http.configureHost(h, a.rateLimit);
    }
  }
}
