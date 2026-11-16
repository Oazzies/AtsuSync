import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import type { UpdateApplyResult, UpdateStatus } from '@atsusync/shared';

const execFileAsync = promisify(execFile);

export const REPO_URL = 'https://github.com/Oazzies/AtsuSync';
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/Oazzies/AtsuSync/releases/latest';
const CACHE_TTL_MS = 30 * 60_000;

const PROTECTED_ROOT_ENTRIES = new Set([
  'data',
  'data-verify',
  '.env',
  'node_modules',
  '.git',
  '.atsusync-restart',
]);

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  zipball_url?: string;
  assets?: GithubReleaseAsset[];
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function summarizeReleaseBody(body: string | undefined, fallback: string | null): string | null {
  if (!body) return fallback;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s#*-]+/, '').trim();
    if (line) return line;
  }
  return fallback;
}

function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return true;
  const parts = normalized.split('/');
  if (PROTECTED_ROOT_ENTRIES.has(parts[0]!)) return true;
  if (parts.includes('node_modules')) return true;
  return false;
}

export class Updater {
  private readonly repoRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runNpmOverride?: (args: string[]) => Promise<void>;
  private cache: { status: UpdateStatus; expiresAt: number } | null = null;

  constructor(opts: { repoRoot?: string; fetchImpl?: typeof fetch; runNpm?: (args: string[]) => Promise<void> } = {}) {
    this.repoRoot = opts.repoRoot ?? resolve(import.meta.dirname, '../..');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.runNpmOverride = opts.runNpm;
  }

  private readLocalVersion(): string {
    try {
      const raw = readFileSync(join(this.repoRoot, 'package.json'), 'utf8');
      return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private hasGit(): boolean {
    return existsSync(join(this.repoRoot, '.git'));
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.repoRoot, timeout: 60_000 });
    return stdout.trim();
  }

  private async npmCmd(...args: string[]): Promise<void> {
    if (this.runNpmOverride) {
      await this.runNpmOverride(args);
      return;
    }
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await execFileAsync(cmd, args, {
      cwd: this.repoRoot,
      timeout: 180_000,
      shell: process.platform === 'win32',
    });
  }

  private async refreshProtocolHandler(): Promise<void> {
    if (process.platform === 'win32') {
      const psScript = join(this.repoRoot, 'scripts', 'register-protocol.ps1');
      if (existsSync(psScript)) {
        await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript], {
          cwd: this.repoRoot,
          timeout: 15_000,
        }).catch(() => {});
      }
    }
  }

  async check(force = false): Promise<UpdateStatus> {
    if (!force && this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.status;
    }

    const currentVersion = this.readLocalVersion();
    const hasGit = this.hasGit();
    let currentCommit: string | null = null;
    if (hasGit) {
      try {
        currentCommit = (await this.git('rev-parse', '--short', 'HEAD')) || null;
      } catch {
        currentCommit = null;
      }
    }

    try {
      const headers = {
        accept: 'application/vnd.github.v3+json',
        'user-agent': `AtsuSync/${currentVersion}`,
      };
      const res = await this.fetchImpl(GITHUB_LATEST_RELEASE_URL, { headers });

      if (res.status === 404) {
        const status: UpdateStatus = {
          currentVersion,
          currentCommit,
          latestVersion: null,
          latestCommit: null,
          latestMessage: null,
          releaseUrl: RELEASES_URL,
          releaseNotes: null,
          updateAvailable: false,
          canAutoUpdate: true,
          repoUrl: REPO_URL,
          downloadUrl: LATEST_RELEASE_URL,
          checkedAt: new Date().toISOString(),
          error: null,
        };
        this.cache = { status, expiresAt: Date.now() + CACHE_TTL_MS };
        return status;
      }

      if (!res.ok) {
        throw new Error(`GitHub release check failed (HTTP ${res.status})`);
      }

      const release = (await res.json()) as GithubReleasePayload;
      const tagName = release.tag_name?.trim() || '';
      const latestVersion = tagName ? tagName.replace(/^v/i, '') : null;
      const zipAsset = release.assets?.find(
        (a) => a.name?.toLowerCase().endsWith('.zip') && typeof a.browser_download_url === 'string',
      );
      const downloadUrl = zipAsset?.browser_download_url ?? release.zipball_url ?? LATEST_RELEASE_URL;
      const releaseUrl = release.html_url ?? LATEST_RELEASE_URL;
      const releaseNotes = release.body?.trim() || null;
      const latestMessage = summarizeReleaseBody(release.body, release.name?.trim() || tagName || null);
      const updateAvailable = latestVersion ? compareSemver(latestVersion, currentVersion) > 0 : false;

      const status: UpdateStatus = {
        currentVersion,
        currentCommit,
        latestVersion,
        latestCommit: null,
        latestMessage,
        releaseUrl,
        releaseNotes,
        updateAvailable,
        canAutoUpdate: true,
        repoUrl: REPO_URL,
        downloadUrl,
        checkedAt: new Date().toISOString(),
        error: null,
      };
      this.cache = { status, expiresAt: Date.now() + CACHE_TTL_MS };
      return status;
    } catch (err) {
      const status: UpdateStatus = {
        currentVersion,
        currentCommit,
        latestVersion: null,
        latestCommit: null,
        latestMessage: null,
        releaseUrl: RELEASES_URL,
        releaseNotes: null,
        updateAvailable: false,
        canAutoUpdate: true,
        repoUrl: REPO_URL,
        downloadUrl: LATEST_RELEASE_URL,
        checkedAt: new Date().toISOString(),
        error: (err as Error).message,
      };
      return status;
    }
  }

  private async applyViaGit(latestVersion: string): Promise<UpdateApplyResult | null> {
    const dirty = await this.git('status', '--porcelain').catch(() => '');
    if (dirty) {
      return {
        ok: false,
        updated: false,
        needsReload: false,
        message: 'Local git checkout has uncommitted changes. Commit or stash them before auto-updating.',
      };
    }

    try {
      await this.git('fetch', 'origin', '--tags');
      try {
        await this.git('pull', '--ff-only');
      } catch {
        await this.git('merge', '--ff-only', `v${latestVersion}`);
      }
    } catch (err) {
      const msg = (err as Error).message || 'git pull failed';
      return {
        ok: false,
        updated: false,
        needsReload: false,
        message: `Could not fast-forward git update: ${msg}`,
      };
    }

    await this.npmCmd('install', '--no-audit', '--no-fund');
    await this.npmCmd('run', 'build');
    return null;
  }

  private async applyViaReleaseZip(downloadUrl: string, currentVersion: string): Promise<{ hasPrebuiltDist: boolean }> {
    const res = await this.fetchImpl(downloadUrl, {
      headers: { 'user-agent': `AtsuSync/${currentVersion}` },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`Failed to download release archive (HTTP ${res.status})`);
    }
    const zipBytes = new Uint8Array(await res.arrayBuffer());
    const entries = unzipSync(zipBytes);
    const fileNames = Object.keys(entries).filter((name) => !name.endsWith('/'));

    // Strip a single top-level folder if the archive wraps everything in one (e.g. GitHub zipball).
    let prefix = '';
    if (!entries['package.json']) {
      const pkgEntry = fileNames.find((name) => name.endsWith('/package.json') && name.split('/').length === 2);
      if (pkgEntry) {
        prefix = pkgEntry.slice(0, pkgEntry.indexOf('/') + 1);
      }
    }

    const normalizedFiles: Array<{ relPath: string; data: Uint8Array }> = [];
    for (const rawName of fileNames) {
      const relPath = prefix && rawName.startsWith(prefix) ? rawName.slice(prefix.length) : rawName;
      if (!relPath || isProtectedPath(relPath)) continue;
      normalizedFiles.push({ relPath, data: entries[rawName]! });
    }

    if (!normalizedFiles.some((f) => f.relPath === 'package.json')) {
      throw new Error('Release archive is missing package.json');
    }

    const hasPrebuiltDist = normalizedFiles.some((f) => f.relPath === 'extension/dist/manifest.json');
    if (hasPrebuiltDist) {
      rmSync(join(this.repoRoot, 'extension', 'dist'), { recursive: true, force: true });
    }

    for (const { relPath, data } of normalizedFiles) {
      const target = join(this.repoRoot, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      if (process.platform !== 'win32' && (relPath === 'setup.sh' || (relPath.startsWith('scripts/') && relPath.endsWith('.sh')))) {
        chmodSync(target, 0o755);
      }
    }

    return { hasPrebuiltDist };
  }

  async apply(): Promise<UpdateApplyResult> {
    const status = await this.check(true);
    if (status.error) {
      return {
        ok: false,
        updated: false,
        needsReload: false,
        message: status.error,
        downloadUrl: status.downloadUrl,
      };
    }

    if (!status.updateAvailable || !status.latestVersion) {
      return {
        ok: true,
        updated: false,
        needsReload: false,
        message: 'Already up to date.',
      };
    }

    if (this.hasGit()) {
      const gitErr = await this.applyViaGit(status.latestVersion);
      if (gitErr) return gitErr;
    } else {
      const { hasPrebuiltDist } = await this.applyViaReleaseZip(status.downloadUrl, status.currentVersion);
      await this.npmCmd('install', '--no-audit', '--no-fund');
      if (!hasPrebuiltDist) {
        await this.npmCmd('run', 'build');
      }
    }

    await this.refreshProtocolHandler();
    this.cache = null;

    return {
      ok: true,
      updated: true,
      needsReload: true,
      needsRestart: true,
      version: status.latestVersion,
      message: `Updated to v${status.latestVersion}! Restarting server and reloading extension…`,
    };
  }
}
