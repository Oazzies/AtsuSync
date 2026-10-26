import type { Link } from '@atsusync/shared';
import type { AtsuClient } from '../atsu/client.ts';
import { events } from '../events.ts';
import type { LinksRepo } from '../links.ts';
import type { SourceRegistry } from '../sources/registry.ts';

/**
 * Periodically re-reads linked source series and records chapters that appeared since
 * the last check as "pending". It never uploads — the user approves each one in the UI.
 */
export class Watcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private links: LinksRepo,
    private sources: SourceRegistry,
    private atsu: AtsuClient | null,
    private tickMs = 60_000,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const link of this.links.dueForCheck()) await this.check(link);
    } finally {
      this.running = false;
    }
  }

  async check(link: Link) {
    try {
      const adapter = this.sources.get(link.sourceId);
      this.sources.http.invalidate(link.seriesUrl);
      const series = await adapter.getSeries(link.seriesUrl, this.sources.http);
      const added = this.links.applySeries(link.id, series, 'pending');

      if (this.atsu && link.atsuMangaId) {
        const state = await this.atsu.getSeriesState({ mangaId: link.atsuMangaId }).catch(() => null);
        if (state?.found) this.links.skipChaptersOnAtsu(link.id, [...state.ranges, ...state.waiting]);
      }

      this.links.markChecked(link.id, null);
      const stillPending = added.filter((c) => this.links.chapter(c.id)?.state === 'pending');
      if (stillPending.length) {
        events.emitEvent({
          type: 'new_chapters',
          linkId: link.id,
          seriesTitle: series.title,
          labels: stillPending.map((c) => c.label),
        });
      }
      return stillPending;
    } catch (err) {
      this.links.markChecked(link.id, (err as Error).message);
      return [];
    }
  }
}
