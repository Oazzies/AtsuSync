import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { UpdateApplyResult, UpdateStatus } from '@atsusync/shared';

const execFileAsync = promisify(execFile);

export const REPO_URL = 'https://github.com/Oazzies/AtsuSync';
export const DOWNLOAD_ZIP_URL = `${REPO_URL}/archive/refs/heads/master.zip`;
const GITHUB_COMMIT_URL = 'https://api.github.com/repos/Oazzies/AtsuSync/commits/master';
const GITHUB_PKG_URL = 'https://raw.githubusercontent.com/Oazzies/AtsuSync/master/package.json';
const CACHE_TTL_MS = 30 * 60_000;

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

export class Updater {
  private readonly repoRoot: string;
  private readonly fetchImpl: typeof fetch;
  private cache: { status: UpdateStatus; expiresAt: number } | null = null;

  constructor(opts: { repoRoot?: string; fetchImpl?: typeof fetch } = {}) {
    this.repoRoot = opts.repoRoot ?? resolve(import.meta.dirname, '../..');
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
    const { stdout } = await execFileAsync('git', args, { cwd: this.repoRoot, timeout: 30_000 });
    return stdout.trim();
  }

  private async npmCmd(...args: string[]): Promise<void> {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await execFileAsync(cmd, args, {
      cwd: this.repoRoot,
      timeout: 180_000,
      shell: process.platform === 'win32',
    });
  }

  private async isAncestor(ancestorSha: string, descendantRef = 'HEAD'): Promise<boolean> {
    try {
      await execFileAsync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantRef], {
        cwd: this.repoRoot,
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async check(force = false): Promise<UpdateStatus> {
    if (!force && this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.status;
    }

    const currentVersion = this.readLocalVersion();
    const hasGit = this.hasGit();
    let currentFullCommit: string | null = null;
    if (hasGit) {
      try {
        currentFullCommit = await this.git('rev-parse', 'HEAD');
      } catch {
        currentFullCommit = null;
      }
    }
    const currentCommit = currentFullCommit ? currentFullCommit.slice(0, 7) : null;

    try {
      const headers = {
        accept: 'application/vnd.github.v3+json',
        'user-agent': `AtsuSync/${currentVersion}`,
      };
      const [commitRes, pkgRes] = await Promise.all([
        this.fetchImpl(GITHUB_COMMIT_URL, { headers }),
        this.fetchImpl(GITHUB_PKG_URL, { headers: { 'user-agent': `AtsuSync/${currentVersion}` } }).catch(() => null),
      ]);

      if (!commitRes.ok) {
        throw new Error(`GitHub check failed (HTTP ${commitRes.status})`);
      }

      const commitData = (await commitRes.json()) as {
        sha?: string;
        commit?: { message?: string };
      };
      const latestFullCommit = commitData.sha ?? null;
      const latestCommit = latestFullCommit ? latestFullCommit.slice(0, 7) : null;
      const latestMessage = commitData.commit?.message?.split('\n')[0]?.trim() || null;

      let latestVersion: string | null = null;
      if (pkgRes?.ok) {
        const pkgData = (await pkgRes.json()) as { version?: string };
        latestVersion = pkgData.version ?? null;
      }

      let updateAvailable = false;
      if (currentFullCommit && latestFullCommit) {
        if (currentFullCommit !== latestFullCommit) {
          // If local HEAD already contains the remote commit (ahead of origin), no update is needed.
          updateAvailable = !(await this.isAncestor(latestFullCommit));
        }
      } else if (latestVersion) {
        updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
      }

      const status: UpdateStatus = {
        currentVersion,
        currentCommit,
        latestVersion,
        latestCommit,
        latestMessage,
        updateAvailable,
        canAutoUpdate: hasGit,
        repoUrl: REPO_URL,
        downloadUrl: DOWNLOAD_ZIP_URL,
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
        updateAvailable: false,
        canAutoUpdate: hasGit,
        repoUrl: REPO_URL,
        downloadUrl: DOWNLOAD_ZIP_URL,
        checkedAt: new Date().toISOString(),
        error: (err as Error).message,
      };
      return status;
    }
  }

  async apply(): Promise<UpdateApplyResult> {
    if (!this.hasGit()) {
      return {
        ok: false,
        updated: false,
        needsReload: false,
        message: 'Installed without Git. Download the latest ZIP from GitHub and run setup again.',
        downloadUrl: DOWNLOAD_ZIP_URL,
      };
    }

    const beforeSha = await this.git('rev-parse', 'HEAD').catch(() => '');
    try {
      await this.git('pull', '--ff-only', 'origin', 'master');
    } catch (err) {
      const msg = (err as Error).message || 'git pull failed';
      return {
        ok: false,
        updated: false,
        needsReload: false,
        message: `Could not fast-forward update: ${msg}`,
      };
    }

    const afterSha = await this.git('rev-parse', 'HEAD').catch(() => '');
    this.cache = null;

    if (beforeSha && afterSha && beforeSha === afterSha) {
      return {
        ok: true,
        updated: false,
        needsReload: false,
        message: 'Already up to date.',
      };
    }

    await this.npmCmd('install', '--no-audit', '--no-fund');
    await this.npmCmd('run', 'build');

    return {
      ok: true,
      updated: true,
      needsReload: true,
      message: 'Updated! Reload the extension in chrome://extensions and restart the server.',
    };
  }
}
