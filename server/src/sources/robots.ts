// Minimal robots.txt support (RFC 9309): groups by user-agent, longest-match Allow/Disallow
// with `*` and `$` wildcards, plus the non-standard Crawl-delay most sites still use.

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySec: number | null;
}

export const ALLOW_ALL: RobotsRules = { allow: [], disallow: [], crawlDelaySec: null };
export const DISALLOW_ALL: RobotsRules = { allow: [], disallow: ['/'], crawlDelaySec: null };

/** Rules for `agent` (lowercase product token), falling back to the `*` group. */
export function parseRobots(text: string, agent: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [], crawlDelaySec: null } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.rules.allow.push(value);
    else if (key === 'disallow' && value) current.rules.disallow.push(value);
    else if (key === 'crawl-delay' && Number.isFinite(Number(value))) current.rules.crawlDelaySec = Number(value);
  }

  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.startsWith(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.reduce<RobotsRules>(
    (acc, g) => ({
      allow: [...acc.allow, ...g.rules.allow],
      disallow: [...acc.disallow, ...g.rules.disallow],
      crawlDelaySec: g.rules.crawlDelaySec ?? acc.crawlDelaySec,
    }),
    { allow: [], disallow: [], crawlDelaySec: null },
  );
}

export function isAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (!matches(p, pathAndQuery)) continue;
      const len = p.length;
      // Longest match wins; on a tie Allow wins.
      if (!best || len > best.len || (len === best.len && allow)) best = { len, allow };
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best ? (best as { allow: boolean }).allow : true;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map(escape).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
