import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SuwayomiStatus } from '@atsusync/shared';
import type { SettingsStore } from '../settings.ts';
import { isAtsumaruExtension, isEnglishLang, type SuwayomiClient } from './suwayomi.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_SUWAYOMI_URL = 'http://127.0.0.1:4567';
export const KEIYOUSHI_REPO_URL = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb';
export const KEIYOUSHI_LEGACY_REPO_URL = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json';
const RELEASES_API = 'https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/latest';

export class SuwayomiManager {
  private child: ChildProcess | null = null;
  private lastError: string | null = null;
  private setupInFlight: Promise<SuwayomiStatus> | null = null;
  private baseDir: string;
  private jarPath: string;
  private serverDataDir: string;

  constructor(
    dataDir: string,
    private settings: SettingsStore,
    private client: SuwayomiClient,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseDir = join(dataDir, 'suwayomi');
    this.jarPath = join(this.baseDir, 'Suwayomi-Server.jar');
    this.serverDataDir = join(this.baseDir, 'server-data');
  }

  async status(): Promise<SuwayomiStatus> {
    const url = this.settings.get().suwayomiUrl.trim() || DEFAULT_SUWAYOMI_URL;
    const running = this.settings.get().suwayomiUrl.trim() ? await this.client.ping() : false;
    return {
      running,
      managed: this.child !== null && !this.child.killed,
      url,
      jarPresent: existsSync(this.jarPath),
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * One-click setup: ensures Suwayomi-Server is running (downloading the JAR & launching it
   * via Java if needed), points AtsuSync at it, registers the keiyoushi/extensions repo,
   * and fetches the extension catalog.
   */
  async setupAndStart(): Promise<SuwayomiStatus> {
    if (this.setupInFlight) return this.setupInFlight;
    this.setupInFlight = this.runSetup().finally(() => {
      this.setupInFlight = null;
    });
    return this.setupInFlight;
  }

  private async runSetup(): Promise<SuwayomiStatus> {
    this.lastError = null;
    try {
      const configured = this.settings.get().suwayomiUrl.trim();
      const targetUrl = configured || DEFAULT_SUWAYOMI_URL;
      if (!configured) {
        this.settings.update({ suwayomiUrl: targetUrl });
      }

      const alreadyUp = await this.client.ping();
      if (!alreadyUp) {
        await this.ensureJava();
        await this.ensureJar();
        await this.startProcess(targetUrl);
      }

      // Register the Keiyoushi extension repository (ignore if already added).
      try {
        await this.client.addExtensionStore(KEIYOUSHI_REPO_URL);
      } catch {
        try {
          await this.client.addExtensionStore(KEIYOUSHI_LEGACY_REPO_URL);
        } catch {
          // Store may already exist; fetchExtensions below will verify.
        }
      }

      await this.syncEnglishExtensions();
      return await this.status();
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  /** Starts the managed Suwayomi-Server JAR on boot when previously set up for localhost. */
  async startIfInstalled(): Promise<boolean> {
    const targetUrl = this.settings.get().suwayomiUrl.trim();
    if (!targetUrl || !existsSync(this.jarPath)) return false;
    if (await this.client.ping()) return true;
    try {
      const host = new URL(targetUrl).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') return false;
    } catch {
      return false;
    }
    await this.ensureJava();
    await this.startProcess(targetUrl);
    return true;
  }

  /** Fetches the Keiyoushi catalog and installs/updates every English (and multi-lang) extension. */
  async syncEnglishExtensions(): Promise<void> {
    const extensions = await this.client.fetchExtensions();
    const targets = extensions
      .filter((e) => isEnglishLang(e.lang) && !isAtsumaruExtension(e) && (!e.isInstalled || e.hasUpdate))
      .map((e) => e.pkgName);
    if (targets.length) {
      await this.client.installAndUpdateExtensions(targets);
    }
  }

  private async ensureJava() {
    try {
      await execFileAsync('java', ['-version']);
    } catch {
      throw new Error('Java (JDK/JRE 21+) was not found on PATH. Install Java or run Suwayomi-Server via Docker and set its URL.');
    }
  }

  private async ensureJar() {
    if (existsSync(this.jarPath)) return;
    mkdirSync(this.baseDir, { recursive: true });

    const relRes = await this.fetchImpl(RELEASES_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'AtsuSync' },
    });
    if (!relRes.ok) {
      throw new Error(`Failed to check Suwayomi-Server releases: HTTP ${relRes.status}`);
    }
    const release = (await relRes.json()) as { assets?: { name: string; browser_download_url: string }[] };
    const jarAsset = release.assets?.find((a) => /^Suwayomi-Server-.*\.jar$/i.test(a.name));
    if (!jarAsset) {
      throw new Error('Could not find a Suwayomi-Server .jar asset in the latest GitHub release');
    }

    const jarRes = await this.fetchImpl(jarAsset.browser_download_url, {
      headers: { 'user-agent': 'AtsuSync' },
    });
    if (!jarRes.ok) {
      throw new Error(`Failed to download ${jarAsset.name}: HTTP ${jarRes.status}`);
    }
    const buf = Buffer.from(await jarRes.arrayBuffer());
    const tmp = `${this.jarPath}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, this.jarPath);
  }

  private async startProcess(targetUrl: string) {
    if (this.child && !this.child.killed) {
      const up = await this.waitForReady(5_000);
      if (up) return;
      await this.stop();
    }

    mkdirSync(this.serverDataDir, { recursive: true });
    const parsed = new URL(targetUrl);
    const port = parsed.port || '4567';

    const stderrTail: string[] = [];
    const child = spawn(
      'java',
      [
        `-Dsuwayomi.tachidesk.config.server.rootDir=${this.serverDataDir}`,
        `-Dsuwayomi.tachidesk.config.server.port=${port}`,
        '-Dsuwayomi.tachidesk.config.server.initialOpenInBrowserEnabled=false',
        '-jar',
        this.jarPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );

    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
      stderrTail.push(...lines);
      if (stderrTail.length > 20) stderrTail.splice(0, stderrTail.length - 20);
    });

    let exitedCode: number | null = null;
    child.on('exit', (code) => {
      exitedCode = code ?? 1;
      if (this.child === child) this.child = null;
    });
    this.child = child;

    const ready = await this.waitForReady(60_000, () => exitedCode !== null);
    if (!ready) {
      await this.stop();
      const detail = stderrTail.slice(-3).join(' | ');
      throw new Error(
        exitedCode !== null
          ? `Suwayomi-Server exited with code ${exitedCode}${detail ? `: ${detail}` : ''}`
          : 'Timed out waiting for Suwayomi-Server to start',
      );
    }
  }

  private async waitForReady(timeoutMs: number, aborted?: () => boolean): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (aborted?.()) return false;
      if (await this.client.ping()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
