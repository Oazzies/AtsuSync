import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSemver, Updater } from '../src/updater.ts';
import { buildApp } from '../src/app.ts';

const tempDirs: string[] = [];

function makeTempRepo(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atsusync-updater-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'atsusync', version }));
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Updater', () => {
  it('compares semver strings accurately', () => {
    expect(compareSemver('0.2.0', '0.1.0')).toBe(1);
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.1.0', '0.1.1')).toBe(-1);
    expect(compareSemver('v1.0.0', '0.9.9')).toBe(1);
  });

  it('reports latest release and zip asset from GitHub Releases API', async () => {
    const repoRoot = makeTempRepo('0.1.0');
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.0',
            name: 'AtsuSync v0.2.0',
            body: '## What changed\n- Auto-update support',
            html_url: 'https://github.com/Oazzies/AtsuSync/releases/tag/v0.2.0',
            assets: [
              {
                name: 'atsusync-v0.2.0.zip',
                browser_download_url: 'https://github.com/Oazzies/AtsuSync/releases/download/v0.2.0/atsusync-v0.2.0.zip',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const updater = new Updater({ repoRoot, fetchImpl: fakeFetch });
    const status = await updater.check(true);
    expect(status.latestVersion).toBe('0.2.0');
    expect(status.latestMessage).toBe('What changed');
    expect(status.releaseUrl).toBe('https://github.com/Oazzies/AtsuSync/releases/tag/v0.2.0');
    expect(status.downloadUrl).toBe('https://github.com/Oazzies/AtsuSync/releases/download/v0.2.0/atsusync-v0.2.0.zip');
    expect(status.updateAvailable).toBe(true);
    expect(status.canAutoUpdate).toBe(true);
    expect(status.error).toBeNull();
  });

  it('treats 404 from /releases/latest as no releases published yet', async () => {
    const repoRoot = makeTempRepo('0.1.0');
    const updater = new Updater({
      repoRoot,
      fetchImpl: async () => new Response('Not Found', { status: 404 }),
    });
    const status = await updater.check(true);
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
    expect(status.canAutoUpdate).toBe(true);
    expect(status.error).toBeNull();
  });

  it('downloads and extracts release zip while preserving data/ and .env', async () => {
    const repoRoot = makeTempRepo('0.1.0');
    mkdirSync(join(repoRoot, 'data'), { recursive: true });
    writeFileSync(join(repoRoot, 'data', 'atsusync.db'), 'keep-me');
    writeFileSync(join(repoRoot, '.env'), 'PORT=4517');
    mkdirSync(join(repoRoot, 'extension', 'dist'), { recursive: true });
    writeFileSync(join(repoRoot, 'extension', 'dist', 'old-chunk.js'), 'stale');

    const archive = zipSync({
      'package.json': strToU8(JSON.stringify({ name: 'atsusync', version: '0.2.0' })),
      'server/src/hello.txt': strToU8('updated-server'),
      'extension/dist/manifest.json': strToU8(JSON.stringify({ version: '0.2.0' })),
      'data/atsusync.db': strToU8('should-not-overwrite'),
    });

    const npmCalls: string[][] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.0',
            assets: [
              {
                name: 'atsusync-v0.2.0.zip',
                browser_download_url: 'https://example.com/atsusync-v0.2.0.zip',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://example.com/atsusync-v0.2.0.zip') {
        return new Response(archive, { status: 200, headers: { 'content-type': 'application/zip' } });
      }
      return new Response('not found', { status: 404 });
    };

    const updater = new Updater({
      repoRoot,
      fetchImpl: fakeFetch,
      runNpm: async (args) => {
        npmCalls.push(args);
      },
    });

    const res = await updater.apply();
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(true);
    expect(res.needsReload).toBe(true);
    expect(res.needsRestart).toBe(true);
    expect(res.version).toBe('0.2.0');

    expect(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version).toBe('0.2.0');
    expect(readFileSync(join(repoRoot, 'server', 'src', 'hello.txt'), 'utf8')).toBe('updated-server');
    expect(readFileSync(join(repoRoot, 'data', 'atsusync.db'), 'utf8')).toBe('keep-me');
    expect(readFileSync(join(repoRoot, '.env'), 'utf8')).toBe('PORT=4517');
    expect(existsSync(join(repoRoot, 'extension', 'dist', 'old-chunk.js'))).toBe(false);
    expect(existsSync(join(repoRoot, 'extension', 'dist', 'manifest.json'))).toBe(true);
    expect(npmCalls).toEqual([['install', '--no-audit', '--no-fund']]);
  });

  it('exposes GET /api/server/update and POST /api/server/restart on the Fastify app', async () => {
    const onRestart = vi.fn();
    const { app } = buildApp({
      dbFile: ':memory:',
      background: false,
      logger: false,
      onRestart,
      fetchImpl: async () => new Response('rate limited', { status: 429 }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/server/update?refresh=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentVersion).toBeTypeOf('string');
    expect(body.error).toContain('429');

    const restartRes = await app.inject({ method: 'POST', url: '/api/server/restart' });
    expect(restartRes.statusCode).toBe(200);
    expect(restartRes.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(onRestart).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
