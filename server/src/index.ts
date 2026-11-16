import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildApp } from './app.ts';
import { config } from './settings.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const dataDir = resolve(repoRoot, config.dataDir);
const restartMarker = join(repoRoot, '.atsusync-restart');
try {
  rmSync(restartMarker, { force: true });
} catch {
  /* ignore */
}

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();
  app.server.closeAllConnections?.();
  void app.close().then(() => process.exit(0));
};

const restart = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref();

  if (process.env.ATSUSYNC_WRAPPER === '1') {
    writeFileSync(restartMarker, String(Date.now()));
  }

  app.server.closeAllConnections?.();
  void app.close().then(() => {
    if (process.env.ATSUSYNC_WRAPPER !== '1') {
      const script =
        process.platform === 'win32'
          ? join(repoRoot, 'scripts', 'start-server.cmd')
          : join(repoRoot, 'scripts', 'start-server.sh');
      const child =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', script], { cwd: repoRoot, detached: true, stdio: 'ignore' })
          : spawn('bash', [script], { cwd: repoRoot, detached: true, stdio: 'ignore' });
      child.unref();
    }
    process.exit(0);
  });
};

const { app } = buildApp({ dbFile: join(dataDir, 'atsusync.db'), onShutdown: shutdown, onRestart: restart });

app
  .listen({ port: config.port, host: '127.0.0.1' })
  .then((addr) => app.log.info(`AtsuSync API on ${addr}`))
  .catch(async (err) => {
    const code = (err as { code?: string })?.code;
    if (code === 'EADDRINUSE') {
      const alive = await fetch(`http://127.0.0.1:${config.port}/api/settings`).then((r) => r.ok).catch(() => false);
      if (alive) {
        app.log.info(`AtsuSync API is already running on http://127.0.0.1:${config.port}`);
        process.exit(0);
      }
    }
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown);
