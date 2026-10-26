// Helpers for Next.js App Router sites, which stream page data as
// `self.__next_f.push([1, "<escaped RSC text>"])` script chunks.

/** Concatenated, unescaped RSC payload of a page. */
export function rscPayload(html: string): string {
  let out = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      out += JSON.parse(m[1]!) as string;
    } catch {
      /* skip malformed chunk */
    }
  }
  return out;
}

/** Find `"key":` in the payload and parse the JSON array/object that follows it. */
export function extractJsonAfterKey<T>(payload: string, key: string, from = 0): T | null {
  const needle = `"${key}":`;
  let idx = payload.indexOf(needle, from);
  while (idx !== -1) {
    const start = idx + needle.length;
    const open = payload[start];
    if (open === '[' || open === '{') {
      const end = matchBracket(payload, start);
      if (end !== -1) {
        try {
          return JSON.parse(payload.slice(start, end + 1)) as T;
        } catch {
          /* try next occurrence */
        }
      }
    }
    idx = payload.indexOf(needle, start);
  }
  return null;
}

function matchBracket(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
