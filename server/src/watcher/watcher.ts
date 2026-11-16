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
    private onChaptersUploaded?: (chapterIds: number[]) => void,
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
    const adapter = this.sources.find(link.sourceId);
    if (!adapter) {
      this.links.update(link.id, { watch: false });
      this.links.markChecked(link.id, null);
      return [];
    }
    try {
      this.sources.http.invalidate(link.seriesUrl);
      const series = await adapter.getSeries(link.seriesUrl, this.sources.http);
      const { added, unlocked } = this.links.applySeries(link.id, series, 'pending');

      if (this.atsu && link.atsuMangaId) {
        const state = await this.atsu.getSeriesState({ mangaId: link.atsuMangaId }).catch(() => null);
        if (state) {
          this.links.setAtsuState(link.id, state);
          if (state.found) {
            const uploadedIds = this.links.skipChaptersOnAtsu(link.id, [...state.ranges, ...state.waiting]);
            if (uploadedIds.length) this.onChaptersUploaded?.(uploadedIds);
          }
        }
      }

      this.links.markChecked(link.id, null);
      const stillPending = added.filter((c) => this.links.chapter(c.id)?.state === 'pending');
      // Paid chapters aren't announced as new (they can't be downloaded); they get their own event once they go free.
      const available = stillPending.filter((c) => !c.locked);
      if (available.length) {
        events.emitEvent({
          type: 'new_chapters',
          linkId: link.id,
          seriesTitle: series.title,
          labels: available.map((c) => c.label),
        });
      }
      const nowFree = unlocked.filter((c) => this.links.chapter(c.id)?.state === 'pending');
      if (nowFree.length) {
        events.emitEvent({
          type: 'chapters_unlocked',
          linkId: link.id,
          seriesTitle: series.title,
          labels: nowFree.map((c) => c.label),
        });
      }
      return available;
    } catch (err) {
      this.links.markChecked(link.id, (err as Error).message);
      return [];
    }
  }
}
