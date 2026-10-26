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
  /** Skip the robots.txt check. Only for documented API endpoints that robots.txt blanket-blocks. */
  ignoreRobots?: boolean;
  /** Static asset (image) request: uses the host's asset limiter instead of the API one. */
  asset?: boolean;
}

const DEFAULT_LIMIT = { rpm: 30, concurrency: 1 };
/** Images are plain CDN files; a handful in parallel is what any browser does. */
const ASSET_LIMIT = { rpm: 600, concurrency: 4 };
const ROBOTS_TTL = 24 * 60 * 60_000;
const MAX_RETRY_WAIT = 5 * 60_000;

export class SourceHttp {
  private limiters = new Map<string, HostLimiter>();
  private cache = new Map<string, { at: number; ttl: number; body: string }>();
  private robots = new Map<string, { at: number; rules: Promise<RobotsRules> }>();

  constructor(
    private fetchImpl: typeof fetch = fetch,
    private respectRobots = true,
  ) {}

  configureHost(host: string, rateLimit: { rpm: number; concurrency: number }) {
    this.limiters.set(host, newLimiter(rateLimit));
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
    if (u.pathname === '/robots.txt') return;
    const rules = await this.robotsFor(u);
    if (!isAllowed(rules, u.pathname + u.search)) {
      throw new BlockedError(`${u.hostname}'s robots.txt doesn't allow fetching ${u.pathname}`);
    }
  }

  private async fetch(url: string, opts: FetchOptions, attempt = 0): Promise<Response> {
    if (!opts.ignoreRobots) await this.assertAllowed(url);
    const host = new URL(url).hostname;
    const release = await this.acquire(host, opts.asset);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT, ...opts.headers }, redirect: 'follow' });
    } finally {
      release();
    }

    if (res.status === 403 || res.status === 503) {
      const body = await res.clone().text().catch(() => '');
      if (isBotChallenge(res, body)) {
        throw new BlockedError(`${host} shows a bot challenge to automated clients; AtsuSync won't try to get past it`);
      }
    }
    if ((res.status === 429 || res.status === 503 || res.status >= 500) && attempt < 3) {
      const wait = retryAfterMs(res) ?? 2000 * 2 ** attempt;
      if (wait > MAX_RETRY_WAIT) throw new Error(`${host} asked us to wait ${Math.round(wait / 60_000)} min; try later`);
      // Slow down for everyone talking to this host, not just this request.
      const l = this.limiterFor(host, opts.asset);
      l.nextAt = Math.max(l.nextAt, Date.now() + wait);
      await sleep(wait);
      return this.fetch(url, opts, attempt + 1);
    }
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
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
      res = await this.fetchImpl(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
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
      // An explicit Crawl-delay overrides the fast image path too.
      for (const asset of [false, true]) {
        const l = this.limiterFor(host, asset);
        l.intervalMs = Math.max(l.intervalMs, rules.crawlDelaySec * 1000);
        if (asset) l.concurrency = 1;
      }
    }
    return rules;
  }

  private limiterFor(host: string, asset = false): HostLimiter {
    if (asset) {
      const key = `asset:${host}`;
      let l = this.limiters.get(key);
      if (!l) this.limiters.set(key, (l = newLimiter(ASSET_LIMIT)));
      return l;
    }
    for (const [h, l] of this.limiters) if (host === h || host.endsWith(`.${h}`)) return l;
    const l = newLimiter(DEFAULT_LIMIT);
    this.limiters.set(host, l);
    return l;
  }

  private async acquire(host: string, asset = false): Promise<() => void> {
    const l = this.limiterFor(host, asset);
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

const newLimiter = (r: { rpm: number; concurrency: number }): HostLimiter => ({
  intervalMs: Math.ceil(60_000 / Math.max(1, r.rpm)),
  concurrency: Math.max(1, r.concurrency),
  active: 0,
  nextAt: 0,
  waiters: [],
});
