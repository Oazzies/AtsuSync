// How AtsuSync presents itself to every site it talks to. No browser impersonation.
export const APP_VERSION = '0.2.0';
export const USER_AGENT = `AtsuSync/${APP_VERSION}`;
/** Product token matched against robots.txt `User-agent:` lines. */
export const ROBOTS_AGENT = 'atsusync';

export class BlockedError extends Error {}

/** Cloudflare / similar interstitials that only a real browser can pass. We don't try to. */
export function isBotChallenge(res: Response, body: string): boolean {
  if (res.headers.get('cf-mitigated') === 'challenge') return true;
  return (res.status === 403 || res.status === 503) && /<title>Just a moment\.\.\.<\/title>|challenges\.cloudflare\.com/i.test(body);
}

/** Retry-After as milliseconds (seconds or HTTP date), or null. */
export function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
