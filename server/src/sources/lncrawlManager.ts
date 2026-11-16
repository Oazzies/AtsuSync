import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LncrawlStatus } from '@atsusync/shared';
import type { SettingsStore } from '../settings.ts';
import type { LncrawlClient } from './lncrawl.ts';
import { downloadAndExtractArchive, findFileRecursive } from './runtime.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_LNCRAWL_URL = 'http://127.0.0.1:4568';
const BRIDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'lncrawl_bridge.py');

export class LncrawlManager {
  private child: ChildProcess | null = null;
  private lastError: string | null = null;
  private setupInFlight: Promise<LncrawlStatus> | null = null;
  private baseDir: string;
  private venvDir: string;
  private venvPython: string;
  private binDir: string;
  private pythonInstallDir: string;

  constructor(
    dataDir: string,
    private settings: SettingsStore,
    private client: LncrawlClient,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.baseDir = join(dataDir, 'lncrawl');
    this.venvDir = join(this.baseDir, 'venv');
    this.binDir = join(this.baseDir, 'bin');
    this.pythonInstallDir = join(this.baseDir, 'python');
    this.venvPython =
      process.platform === 'win32'
        ? join(this.venvDir, 'Scripts', 'python.exe')
        : join(this.venvDir, 'bin', 'python');
  }

  async status(): Promise<LncrawlStatus> {
    const url = this.settings.get().lncrawlUrl.trim() || DEFAULT_LNCRAWL_URL;
    const running = this.settings.get().lncrawlUrl.trim() ? await this.client.ping() : false;
    return {
      running,
      managed: this.child !== null && !this.child.killed,
      url,
      installed: existsSync(this.venvPython),
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * One-click setup: creates an isolated Python venv in `data/lncrawl/venv` if missing,
   * installs `lightnovel-crawler`, starts the local bridge, and points AtsuSync at it.
   */
  async setupAndStart(): Promise<LncrawlStatus> {
    if (this.setupInFlight) return this.setupInFlight;
    this.setupInFlight = this.runSetup().finally(() => {
      this.setupInFlight = null;
    });
    return this.setupInFlight;
  }

  private async runSetup(): Promise<LncrawlStatus> {
    this.lastError = null;
    try {
      const configured = this.settings.get().lncrawlUrl.trim();
      const targetUrl = configured || DEFAULT_LNCRAWL_URL;
      if (!configured) {
        this.settings.update({ lncrawlUrl: targetUrl });
      }

      const alreadyUp = await this.client.ping();
      if (!alreadyUp) {
        await this.ensureInstalled();
        await this.startProcess(targetUrl);
      }

      return await this.status();
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  /** Starts the managed LNCrawl bridge on boot when previously set up for localhost. */
  async startIfInstalled(): Promise<boolean> {
    const targetUrl = this.settings.get().lncrawlUrl.trim();
    if (!targetUrl || !existsSync(this.venvPython)) return false;
    if (await this.client.ping()) return true;
    try {
      const host = new URL(targetUrl).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') return false;
    } catch {
      return false;
    }
    await this.startProcess(targetUrl);
    return true;
  }

  private async hasCommand(cmd: string, args: string[] = ['--version']): Promise<boolean> {
    try {
      await execFileAsync(cmd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async findPython(): Promise<string> {
    for (const cmd of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
      if (await this.hasCommand(cmd, ['--version'])) return cmd;
    }
    throw new Error('Python 3.10+ (or uv) was not found on PATH. Install Python or run the LNCrawl bridge manually.');
  }

  private uvDownloadUrl(): string {
    const target =
      process.platform === 'win32'
        ? process.arch === 'arm64'
          ? 'uv-aarch64-pc-windows-msvc.zip'
          : 'uv-x86_64-pc-windows-msvc.zip'
        : process.platform === 'darwin'
          ? process.arch === 'arm64'
            ? 'uv-aarch64-apple-darwin.tar.gz'
            : 'uv-x86_64-apple-darwin.tar.gz'
          : process.arch === 'arm64'
            ? 'uv-aarch64-unknown-linux-gnu.tar.gz'
            : 'uv-x86_64-unknown-linux-gnu.tar.gz';
    return `https://github.com/astral-sh/uv/releases/latest/download/${target}`;
  }

  private async ensureUv(): Promise<string> {
    if (await this.hasCommand('uv', ['--version'])) return 'uv';
    const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const existing = findFileRecursive(this.binDir, exe);
    if (existing) return existing;

    await downloadAndExtractArchive(this.uvDownloadUrl(), this.binDir, this.fetchImpl);
    const installed = findFileRecursive(this.binDir, exe);
    if (!installed) {
      throw new Error('Failed to locate uv binary after downloading portable uv.');
    }
    return installed;
  }

  private async ensureInstalled(): Promise<void> {
    if (existsSync(this.venvPython) && (await this.hasCommand(this.venvPython, ['-c', 'import lncrawl']))) {
      return;
    }
    mkdirSync(this.baseDir, { recursive: true });
    const uvEnv = { ...process.env, UV_PYTHON_INSTALL_DIR: this.pythonInstallDir };
    const uvBin = await this.ensureUv().catch(() => null);

    if (uvBin) {
      if (!existsSync(this.venvPython)) {
        await execFileAsync(uvBin, ['venv', '--python', '3.12', this.venvDir], {
          env: uvEnv,
          timeout: 300_000,
        });
      }
      await execFileAsync(uvBin, ['pip', 'install', '--python', this.venvPython, '-U', 'lightnovel-crawler'], {
        env: uvEnv,
        timeout: 300_000,
      });
      return;
    }

    if (!existsSync(this.venvPython)) {
      const py = await this.findPython();
      await execFileAsync(py, ['-m', 'venv', this.venvDir]);
    }
    await execFileAsync(this.venvPython, ['-m', 'pip', 'install', '-U', 'lightnovel-crawler'], {
      timeout: 300_000,
    });
  }

  private async startProcess(targetUrl: string): Promise<void> {
    if (this.child && !this.child.killed) {
      if (await this.waitForReady(5_000)) return;
      await this.stop();
    }

    const parsed = new URL(targetUrl);
    const port = parsed.port || '4568';
    const stderrTail: string[] = [];

    const child = spawn(
      this.venvPython,
      [BRIDGE_SCRIPT, '--host', '127.0.0.1', '--port', port],
      {
        cwd: this.baseDir,
        env: { ...process.env, PYTHONUTF8: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
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
          ? `LNCrawl bridge exited with code ${exitedCode}${detail ? `: ${detail}` : ''}`
          : 'Timed out waiting for LNCrawl bridge to start',
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
