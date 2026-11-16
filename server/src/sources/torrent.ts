// BitTorrent engine for torrent-type sources, built on WebTorrent. It is a plain leecher: uploads are
// throttled to a trickle, nothing is seeded, and finished torrents are dropped from the client. Only
// the files a chapter needs are downloaded, into `<dir>/<infohash>/`, which stays on disk until the
// pipeline releases the torrent (so a 50-chapter pack is fetched once, not 50 times).
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface TorrentFile {
  /** Path inside the torrent, forward slashes, starting with the torrent's root folder if it has one. */
  path: string;
  length: number;
}

export interface TorrentRequest {
  infoHash: string;
  name?: string;
  trackers?: string[];
}

export interface TorrentHooks {
  /** Percent 0..100 of the selected files. */
  progress(percent: number): void;
  log(msg: string): void;
  /** Throws when the user cancelled. */
  checkCancel(): void;
}

export interface DownloadedFile {
  /** Path inside the torrent, as in TorrentFile. */
  path: string;
  /** Absolute location on disk. */
  diskPath: string;
}

export interface TorrentClient {
  /**
   * Fetch metadata for the torrent, let `pick` choose which files to download (by index), download them and
   * resolve their disk locations. Rejects when no peers show up or the transfer stalls.
   */
  download(req: TorrentRequest, pick: (files: TorrentFile[]) => number[], hooks: TorrentHooks): Promise<DownloadedFile[]>;
  /** Call once per download() after the files were read (or it failed); the last release deletes the files. */
  release(infoHash: string): void;
  destroy(): Promise<void>;
}

/** Public trackers Nyaa itself announces on; magnets built from an info hash carry them. */
export const DEFAULT_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackers.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://explodie.org:6969/announce',
];

export const magnetFor = (req: TorrentRequest) =>
  `magnet:?xt=urn:btih:${req.infoHash}${req.name ? `&dn=${encodeURIComponent(req.name)}` : ''}${(req.trackers ?? DEFAULT_TRACKERS)
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join('')}`;

const METADATA_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

/** The pieces of a WebTorrent torrent this wrapper touches (the library ships no types). */
interface WtFile {
  path: string;
  length: number;
  select(): void;
  deselect(): void;
}
interface WtTorrent {
  infoHash: string;
  files: WtFile[];
  progress: number;
  numPeers: number;
  ready: boolean;
  done: boolean;
  once(ev: string, fn: (...a: unknown[]) => void): void;
  off(ev: string, fn: (...a: unknown[]) => void): void;
  deselect(from: number, to: number, priority: number): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: () => void): void;
}
interface WtClient {
  add(uri: string, opts: Record<string, unknown>): WtTorrent;
  get(id: string): Promise<WtTorrent | null> | WtTorrent | null;
  destroy(cb?: () => void): void;
}

export class WebTorrentClient implements TorrentClient {
  private client: Promise<WtClient> | null = null;
  /** Downloads in flight per info hash; files are deleted when the last one is released. */
  private refs = new Map<string, number>();

  constructor(private dir: string) {}

  private getClient(): Promise<WtClient> {
    this.client ??= import('webtorrent').then((m) => {
      const WebTorrent = m.default as unknown as new (opts: Record<string, unknown>) => WtClient;
      // Leech only: no µTP, no local peer discovery, uploads capped to 1 KB/s.
      return new WebTorrent({ utp: false, lsd: false, natUpnp: false, natPmp: false, uploadLimit: 1024, maxConns: 60 });
    });
    return this.client;
  }

  async download(req: TorrentRequest, pick: (files: TorrentFile[]) => number[], hooks: TorrentHooks): Promise<DownloadedFile[]> {
    const client = await this.getClient();
    const hash = req.infoHash.toLowerCase();
    const root = join(this.dir, hash);
    mkdirSync(root, { recursive: true });
    this.refs.set(hash, (this.refs.get(hash) ?? 0) + 1);
    const existing = await client.get(hash);
    const torrent = existing ?? client.add(magnetFor(req), { path: root, deselect: true });

    let failure: Error | null = null;
    torrent.once('error', (e) => (failure = e instanceof Error ? e : new Error(String(e))));
    const fail = () => {
      if (failure) throw failure;
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    try {
      hooks.log(`Looking for peers of ${req.name ?? hash}`);
      const t0 = Date.now();
      while (!torrent.ready) {
        fail();
        hooks.checkCancel();
        if (Date.now() - t0 > METADATA_TIMEOUT_MS) {
          throw new Error(`No peers answered for this torrent in ${METADATA_TIMEOUT_MS / 1000}s (it may have no seeders). Try again later or pick another release.`);
        }
        await sleep(POLL_MS);
      }

      const files = torrent.files;
      const wanted = pick(files.map((f) => ({ path: f.path.replaceAll('\\', '/'), length: f.length })));
      if (wanted.length === 0) throw new Error('The torrent has no files this chapter can use');
      const wantedSet = new Set(wanted);
      files.forEach((f, i) => (wantedSet.has(i) ? f.select() : f.deselect()));
      const total = wanted.reduce((n, i) => n + files[i]!.length, 0);
      hooks.log(`Downloading ${wanted.length} file(s), ${(total / 1024 / 1024).toFixed(1)} MB, from ${torrent.numPeers} peer(s)`);

      let lastBytes = -1;
      let lastMove = Date.now();
      for (;;) {
        fail();
        hooks.checkCancel();
        // `progress` is for the whole torrent; count the selected files' bytes ourselves.
        const have = wanted.reduce((n, i) => n + Math.round(files[i]!.length * fileProgress(files[i]!)), 0);
        hooks.progress(total === 0 ? 100 : Math.min(100, Math.round((have / total) * 100)));
        if (have >= total) break;
        if (have !== lastBytes) {
          lastBytes = have;
          lastMove = Date.now();
        } else if (Date.now() - lastMove > STALL_TIMEOUT_MS) {
          throw new Error(`Download stalled at ${Math.round((have / total) * 100)}% with ${torrent.numPeers} peer(s)`);
        }
        await sleep(POLL_MS);
      }
      return wanted.map((i) => ({ path: files[i]!.path.replaceAll('\\', '/'), diskPath: join(root, files[i]!.path) }));
    } finally {
      // Cleanup is the caller's release() once it has read the files.
    }
  }

  /** Called once per download() when its files have been read (or it failed); the last release deletes the files. */
  release(infoHash: string) {
    const hash = infoHash.toLowerCase();
    const left = (this.refs.get(hash) ?? 1) - 1;
    if (left > 0) this.refs.set(hash, left);
    else {
      this.refs.delete(hash);
      void this.drop(hash);
    }
  }

  private async drop(hash: string) {
    if (this.client) {
      const client = await this.client;
      const t = await client.get(hash);
      if (t) await new Promise<void>((r) => t.destroy({ destroyStore: false }, r));
    }
    try {
      rmSync(join(this.dir, hash), { recursive: true, force: true });
    } catch {
      /* in use on Windows; the next release or restart cleans it */
    }
  }

  async destroy() {
    if (!this.client) return;
    const client = await this.client;
    this.client = null;
    await new Promise<void>((r) => client.destroy(r));
  }
}

/** Fraction of a file that is on disk. WebTorrent exposes it as `file.progress`. */
const fileProgress = (f: WtFile): number => {
  const p = (f as unknown as { progress?: number }).progress;
  return typeof p === 'number' ? p : 0;
};

/** For tests and offline use: a client that serves canned files instead of touching the network. */
export class FakeTorrentClient implements TorrentClient {
  released: string[] = [];
  constructor(private serve: (req: TorrentRequest) => { path: string; diskPath: string; length?: number }[]) {}
  async download(req: TorrentRequest, pick: (files: TorrentFile[]) => number[], hooks: TorrentHooks) {
    const all = this.serve(req);
    const wanted = pick(all.map((f) => ({ path: f.path, length: f.length ?? 1 })));
    hooks.checkCancel();
    hooks.progress(100);
    return wanted.map((i) => ({ path: all[i]!.path, diskPath: all[i]!.diskPath }));
  }
  release(infoHash: string) {
    this.released.push(infoHash);
  }
  async destroy() {}
}
