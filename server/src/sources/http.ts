// Shared HTTP layer for all source adapters: per-host rate limiting, a polite UA,
// retries on 429/5xx, and a small TTL cache so browsing the UI doesn't re-scrape.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

interface HostLimiter {
  intervalMs: number;
  concurrency: number;
  active: number;
  nextAt: number;
  waiters: (() => void)[];
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Cache the response body for this many ms (text/json only). */
  cacheMs?: number;
}

export class SourceHttp {
  private limiters = new Map<string, HostLimiter>();
  private cache = new Map<string, { at: number; ttl: number; body: string }>();

  constructor(private fetchImpl: typeof fetch = fetch) {}

  configureHost(host: string, rateLimit: { rpm: number; concurrency: number }) {
    this.limiters.set(host, {
      intervalMs: Math.ceil(60_000 / Math.max(1, rateLimit.rpm)),
      concurrency: Math.max(1, rateLimit.concurrency),
      active: 0,
      nextAt: 0,
      waiters: [],
    });
  }

  async text(url: string, opts: FetchOptions = {}): Promise<string> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.body;
    const res = await this.fetch(url, opts);
    const body = await res.text();
    if (opts.cacheMs) this.cache.set(url, { at: Date.now(), ttl: opts.cacheMs, body });
    return body;
  }

  async json<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    return JSON.parse(await this.text(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } })) as T;
  }

  async bytes(url: string, opts: FetchOptions = {}): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const res = await this.fetch(url, opts);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }

  invalidate(url: string) {
    this.cache.delete(url);
  }

  private async fetch(url: string, opts: FetchOptions, attempt = 0): Promise<Response> {
    const host = new URL(url).hostname;
    const release = await this.acquire(host);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'user-agent': UA, ...opts.headers }, redirect: 'follow' });
    } finally {
      release();
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Math.max(2000 * 2 ** attempt, retryAfter || 0));
      return this.fetch(url, opts, attempt + 1);
    }
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res;
  }

  private limiterFor(host: string): HostLimiter | undefined {
    for (const [h, l] of this.limiters) if (host === h || host.endsWith(`.${h}`)) return l;
    return undefined;
  }

  private async acquire(host: string): Promise<() => void> {
    const l = this.limiterFor(host);
    if (!l) return () => {};
    while (l.active >= l.concurrency) await new Promise<void>((r) => l.waiters.push(r));
    l.active++;
    const wait = l.nextAt - Date.now();
    l.nextAt = Math.max(Date.now(), l.nextAt) + l.intervalMs;
    if (wait > 0) await sleep(wait);
    return () => {
      l.active--;
      l.waiters.shift()?.();
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
