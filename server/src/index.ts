import { join, resolve } from 'node:path';
import { buildApp } from './app.ts';
import { config } from './settings.ts';

const dataDir = resolve(import.meta.dirname, '../..', config.dataDir);
const { app } = buildApp({ dbFile: join(dataDir, 'atsusync.db') });

app
  .listen({ port: config.port, host: '127.0.0.1' })
  .then((addr) => app.log.info(`AtsuSync API on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
