import type { Settings } from '@atsusync/shared';
import type { Db } from './db/client.ts';

export const config = {
  port: Number(process.env.PORT ?? 4517),
  dataDir: process.env.DATA_DIR ?? './data',
};

const defaults = (): Settings => ({
  atsuCookie: '',
  defaultCheckIntervalMin: 60,
});

export class SettingsStore {
  constructor(private db: Db) {}

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out = defaults() as unknown as Record<string, unknown>;
    for (const { key, value } of rows) {
      if (key in out) out[key] = JSON.parse(value);
    }
    return out as unknown as Settings;
  }

  update(patch: Partial<Settings>) {
    const known = defaults();
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in known) || value === undefined) continue;
      if (typeof value !== typeof known[key as keyof Settings]) throw new Error(`Invalid type for setting ${key}`);
      stmt.run(key, JSON.stringify(value));
    }
  }
}
