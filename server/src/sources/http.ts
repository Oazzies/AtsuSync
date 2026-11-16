// Shared HTTP layer for all source adapters. Every request:
//  - identifies itself as AtsuSync (no browser user agent),
//  - is checked against the host's robots.txt (cached for a day; Crawl-delay is honoured),
//  - waits its turn in a per-host rate limiter,
//  - backs off on 429/503 using Retry-After,
//  - stops on bot challenges (Cloudflare "Just a moment…") instead of trying to get around them.
// Text responses can be cached so browsing the UI doesn't re-fetch pages.

import { BlockedError, ROBOTS_AGENT, USER_AGENT, isBotChallenge, retryAfterMs, sleep } from '../polite.ts';
import { ALLOW_ALL, DISALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from './robots.ts';

interface HostLimiter {
  baseIntervalMs: number;
  baseConcurrency: number;
  intervalMs: number;
  concurrency: number;
  active: number;
  nextAt: number;
  successStreak: number;
  waiters: (() => void)[];
}

export interface FetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** Cache the response body for this many ms (text/json only). */
  cacheMs?: number;
  /** Skip the robots.txt check. Only for documented API endpoints that robots.txt blanket-blocks. */
  ignoreRobots?: boolean;
  /** Static asset (image) request: uses the host's asset limiter instead of the API one. */
  asset?: boolean;
  /** Per-attempt request timeout in ms (0 disables). Defaults to 30s. */
  timeoutMs?: number;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = { rpm: 30, concurrency: 1 };
/** Images are plain CDN files; load them with browser-like parallelism. */
const ASSET_LIMIT = { rpm: 3600, concurrency: 16 };
/** Local bridges (e.g. Suwayomi) need no artificial rate-limit sleep. */
const LOOPBACK_ASSET_LIMIT = { rpm: 60_000, concurrency: 24 };
const CACHE_MAX = 500;
const ROBOTS_TTL = 24 * 60 * 60_000;
const ROBOTS_TIMEOUT_MS = 5_000;
const MAX_RETRY_WAIT = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const isLoopbackHost = (host: string) =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';

export class SourceHttp {
  private apiLimiters = new Map<string, HostLimiter>();
  private assetLimiters = new Map<string, HostLimiter>();
  private cache = new Map<string, { at: number; ttl: number; body: string }>();
  private robots = new Map<string, { at: number; rules: Promise<RobotsRules> }>();
  /** Identical in-flight text requests share one network call. */
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private fetchImpl: typeof fetch = fetch,
    private respectRobots = true,
  ) {}

  configureHost(host: string, rateLimit: { rpm: number; concurrency: number }) {
    this.apiLimiters.set(host, newLimiter(rateLimit));
  }

  async text(url: string, opts: FetchOptions = {}): Promise<string> {
    const key = opts.method && opts.method !== 'GET' ? `${opts.method}:${url}:${opts.body ?? ''}` : url;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.body;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const res = await this.fetch(url, opts);
      const body = await res.text();
      if (opts.cacheMs) {
        this.cache.set(key, { at: Date.now(), ttl: opts.cacheMs, body });
        if (this.cache.size > CACHE_MAX) this.pruneCache();
      }
      return body;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private pruneCache() {
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at >= v.ttl) this.cache.delete(k);
    // Still too big: drop the oldest entries (Map iterates in insertion order).
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_MAX) break;
      this.cache.delete(k);
    }
  }

  async json<T>(url: string, opts: FetchOptions = {}): Promise<T> {
    return JSON.parse(await this.text(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } })) as T;
  }

  async postJson<T>(url: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
    return this.json<T>(url, {
      ...opts,
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...opts.headers },
    });
  }

  /** Page images: static files, so they get a faster, parallel limiter than API/HTML requests. */
  async bytes(url: string, opts: FetchOptions = {}): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const res = await this.fetch(url, { ...opts, asset: true });
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }

  invalidate(url: string) {
    this.cache.delete(url);
  }

  /** Throws if robots.txt forbids AtsuSync from fetching `url`. */
  async assertAllowed(url: string) {
    if (!this.respectRobots) return;
    const u = new URL(url);
    if (isLoopbackHost(u.hostname) || u.pathname === '/robots.txt') return;
    const rules = await this.robotsFor(u);
    if (!isAllowed(rules, u.pathname + u.search)) {
      throw new BlockedError(`${u.hostname}'s robots.txt doesn't allow fetching ${u.pathname}`);
    }
  }

  private async fetch(url: string, opts: FetchOptions, attempt = 0): Promise<Response> {
    opts.signal?.throwIfAborted();
    if (!opts.ignoreRobots) await this.assertAllowed(url);
    opts.signal?.throwIfAborted();
    const host = new URL(url).hostname;
    const isLocal = isLoopbackHost(host);
    const method = opts.method ?? 'GET';
    const release = await this.acquire(host, opts.asset, opts.signal);
    let res: Response;
    try {
      opts.signal?.throwIfAborted();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal =
        opts.signal && timeoutSignal ? AbortSignal.any([opts.signal, timeoutSignal]) : (opts.signal ?? timeoutSignal);
      res = await this.fetchImpl(url, {
        method,
        body: opts.body,
        headers: { 'user-agent': USER_AGENT, ...opts.headers },
        redirect: 'follow',
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted || attempt >= 3 || (method !== 'GET' && method !== 'HEAD')) throw err;
      const wait = isLocal ? 200 : 500 * 2 ** attempt;
      await sleepOrAbort(wait, opts.signal);
      return this.fetch(url, opts, attempt + 1);
    } finally {
      release();
    }

    if (res.status === 403 || res.status === 503) {
      const body = await res.clone().text().catch(() => '');
      if (isBotChallenge(res, body)) {
        throw new BlockedError(`${host} shows a bot challenge to automated clients; AtsuSync won't try to get past it`);
      }
    }
    const maxAttempts = isLocal && res.status >= 500 && res.status !== 503 ? 1 : 3;
    if ((res.status === 429 || res.status === 503 || res.status >= 500) && attempt < maxAttempts) {
      const wait = retryAfterMs(res) ?? (isLocal ? 500 : 2000 * 2 ** attempt);
      if (wait > MAX_RETRY_WAIT) throw new Error(`${host} asked us to wait ${Math.round(wait / 60_000)} min; try later`);
      if (res.status === 429 || res.status === 503) {
        // Slow down for everyone talking to this host and adaptively back off concurrency/spacing.
        const l = this.limiterFor(host, opts.asset);
        l.nextAt = Math.max(l.nextAt, Date.now() + wait);
        l.successStreak = 0;
        l.concurrency = Math.max(1, Math.floor(l.concurrency / 2));
        l.intervalMs = Math.min(10_000, Math.max(l.intervalMs * 2, 250));
      }
      await sleepOrAbort(wait, opts.signal);
      return this.fetch(url, opts, attempt + 1);
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);

    const l = this.limiterFor(host, opts.asset);
    if (l.concurrency < l.baseConcurrency || l.intervalMs > l.baseIntervalMs) {
      l.successStreak++;
      if (l.successStreak >= 16) {
        l.successStreak = 0;
        l.concurrency = Math.min(l.baseConcurrency, l.concurrency + 1);
        l.intervalMs = Math.max(l.baseIntervalMs, Math.floor(l.intervalMs * 0.75));
      }
    }
    return res;
  }

  private robotsFor(u: URL): Promise<RobotsRules> {
    const key = u.origin;
    const hit = this.robots.get(key);
    if (hit && Date.now() - hit.at < ROBOTS_TTL) return hit.rules;
    const rules = this.loadRobots(u.origin);
    this.robots.set(key, { at: Date.now(), rules });
    return rules;
  }

  private async loadRobots(origin: string): Promise<RobotsRules> {
    const host = new URL(origin).hostname;
    const release = await this.acquire(host);
    let res: Response;
    try {
      res = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      });
    } catch {
      return ALLOW_ALL; // unreachable robots.txt: nothing to obey; the real request will fail anyway
    } finally {
      release();
    }
    // RFC 9309: 4xx means no restrictions, 5xx means assume full disallow.
    if (res.status >= 500) return DISALLOW_ALL;
    if (!res.ok) return ALLOW_ALL;
    const body = await res.text();
    if (isBotChallenge(res, body) || /<html/i.test(body.slice(0, 200))) return ALLOW_ALL;
    const rules = parseRobots(body, ROBOTS_AGENT);
    if (rules.crawlDelaySec) {
      // Honour Crawl-delay for HTML/API crawling, but keep static image asset fetches fast.
      const l = this.limiterFor(host, false);
      l.baseIntervalMs = Math.max(l.baseIntervalMs, rules.crawlDelaySec * 1000);
      l.intervalMs = Math.max(l.intervalMs, rules.crawlDelaySec * 1000);
    }
    return rules;
  }

  private limiterFor(host: string, asset = false): HostLimiter {
    if (asset) {
      let l = this.assetLimiters.get(host);
      if (!l) {
        l = newLimiter(isLoopbackHost(host) ? LOOPBACK_ASSET_LIMIT : ASSET_LIMIT);
        this.assetLimiters.set(host, l);
      }
      return l;
    }
    for (const [h, l] of this.apiLimiters) if (host === h || host.endsWith(`.${h}`)) return l;
    const l = newLimiter(DEFAULT_LIMIT);
    this.apiLimiters.set(host, l);
    return l;
  }

  private async acquire(host: string, asset = false, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const l = this.limiterFor(host, asset);
    while (l.active >= l.concurrency) {
      await waitForSlot(l, signal);
    }
    l.active++;
    try {
      const wait = l.nextAt - Date.now();
      l.nextAt = Math.max(Date.now(), l.nextAt) + l.intervalMs;
      if (wait > 0) await sleepOrAbort(wait, signal);
    } catch (err) {
      l.active--;
      l.waiters.shift()?.();
      throw err;
    }
    return () => {
      l.active--;
      l.waiters.shift()?.();
    };
  }
}

const newLimiter = (r: { rpm: number; concurrency: number }): HostLimiter => {
  const intervalMs = r.rpm >= 60_000 ? 0 : Math.ceil(60_000 / Math.max(1, r.rpm));
  const concurrency = Math.max(1, r.concurrency);
  return {
    baseIntervalMs: intervalMs,
    baseConcurrency: concurrency,
    intervalMs,
    concurrency,
    active: 0,
    nextAt: 0,
    successStreak: 0,
    waiters: [],
  };
};

function waitForSlot(l: HostLimiter, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>((r) => l.waiters.push(r));
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const wake = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      const idx = l.waiters.indexOf(wake);
      if (idx !== -1) l.waiters.splice(idx, 1);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    l.waiters.push(wake);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
