import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SuwayomiStatus } from '@atsusync/shared';
import type { SettingsStore } from '../settings.ts';
import { downloadAndExtractArchive, findFileRecursive } from './runtime.ts';
import { dedupeExtensions, isAtsumaruExtension, isEnglishLang, type SuwayomiClient } from './suwayomi.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_SUWAYOMI_URL = 'http://127.0.0.1:4567';
export const KEIYOUSHI_REPO_URL = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb';
export const KEIYOUSHI_LEGACY_REPO_URL = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json';
export const YUZONO_REPO_URL = 'https://raw.githubusercontent.com/yuzono/cursed-manga-repo/repo/index.pb';
const RELEASES_API = 'https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/latest';

export class SuwayomiManager {
  private child: ChildProcess | null = null;
  private lastError: string | null = null;
  private setupInFlight: Promise<SuwayomiStatus> | null = null;
  private updateInFlight: Promise<number> | null = null;
  private baseDir: string;
  private jarPath: string;
  private serverDataDir: string;
  private jreDir: string;
  private javaBin = 'java';

  constructor(
    dataDir: string,
    private settings: SettingsStore,
    private client: SuwayomiClient,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseDir = join(dataDir, 'suwayomi');
    this.jarPath = join(this.baseDir, 'Suwayomi-Server.jar');
    this.serverDataDir = join(this.baseDir, 'server-data');
    this.jreDir = join(this.baseDir, 'jre');
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
   * via Java if needed), points AtsuSync at it, registers the Keiyoushi & Yūzōnō repos,
   * and fetches the extension catalog.
   */
  async setupAndStart(): Promise<SuwayomiStatus> {
    if (this.setupInFlight) return this.setupInFlight;
    this.setupInFlight = this.runSetup().finally(() => {
      this.setupInFlight = null;
    });
    return this.setupInFlight;
  }

  /** Registers Keiyoushi and Yūzōnō extension repositories (ignoring stores already added). */
  async ensureExtensionStores(): Promise<void> {
    try {
      await this.client.addExtensionStore(KEIYOUSHI_REPO_URL);
    } catch {
      try {
        await this.client.addExtensionStore(KEIYOUSHI_LEGACY_REPO_URL);
      } catch {
        // Store may already exist; fetchExtensions below will verify.
      }
    }

    try {
      await this.client.addExtensionStore(YUZONO_REPO_URL);
    } catch {
      // Store may already exist or be unreachable; don't block Keiyoushi.
    }
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

      await this.ensureExtensionStores();
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

  /** Fetches the Keiyoushi & Yūzōnō catalogs and installs/updates every English (and multi-lang) extension. */
  async syncEnglishExtensions(): Promise<void> {
    await this.ensureExtensionStores();
    const extensions = dedupeExtensions(await this.client.fetchExtensions());
    const targets = extensions
      .filter((e) => isEnglishLang(e.lang) && !isAtsumaruExtension(e) && (!e.isInstalled || e.hasUpdate))
      .map((e) => e.pkgName);
    if (targets.length) {
      await this.client.installAndUpdateExtensions(targets);
    }
  }

  /** Checks the registered repos and updates any installed extensions that have a newer version on GitHub. */
  async updateInstalledExtensions(): Promise<number> {
    if (this.setupInFlight) return 0;
    if (this.updateInFlight) return this.updateInFlight;
    this.updateInFlight = this.runUpdateInstalled().finally(() => {
      this.updateInFlight = null;
    });
    return this.updateInFlight;
  }

  private async runUpdateInstalled(): Promise<number> {
    if (!this.settings.get().suwayomiUrl.trim()) return 0;
    if (!(await this.client.ping())) return 0;
    const extensions = dedupeExtensions(await this.client.fetchExtensions());
    const targets = extensions
      .filter((e) => e.isInstalled && e.hasUpdate && !isAtsumaruExtension(e))
      .map((e) => e.pkgName);
    if (targets.length) {
      await this.client.installAndUpdateExtensions(targets);
    }
    return targets.length;
  }

  private jreDownloadUrl(): string {
    const os =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    return `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
  }

  private async ensureJava(): Promise<void> {
    try {
      await execFileAsync('java', ['-version']);
      this.javaBin = 'java';
      return;
    } catch {
      // Fall back to portable JRE 21 in data/suwayomi/jre.
    }

    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    const existing = findFileRecursive(this.jreDir, exe);
    if (existing) {
      this.javaBin = existing;
      return;
    }

    await downloadAndExtractArchive(this.jreDownloadUrl(), this.jreDir, this.fetchImpl);
    const installed = findFileRecursive(this.jreDir, exe);
    if (!installed) {
      throw new Error('Failed to locate Java binary after downloading portable JRE 21.');
    }
    this.javaBin = installed;
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
      this.javaBin,
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
