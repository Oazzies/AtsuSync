import { Writable } from 'node:stream';

const useColor = () => !process.env.NO_COLOR;
const ansi = (code: string, text: string) => (useColor() ? `\x1b[${code}m${text}\x1b[0m` : text);

export const fmt = {
  dim: (s: string) => ansi('90', s),
  bold: (s: string) => ansi('1', s),
  cyan: (s: string) => ansi('36', s),
  green: (s: string) => ansi('32', s),
  yellow: (s: string) => ansi('33', s),
  red: (s: string) => ansi('31', s),
  magenta: (s: string) => ansi('35', s),
};

const LEVELS: Record<number, { label: string; color: (s: string) => string }> = {
  10: { label: 'TRACE', color: fmt.dim },
  20: { label: 'DEBUG', color: fmt.magenta },
  30: { label: 'INFO ', color: fmt.cyan },
  40: { label: 'WARN ', color: fmt.yellow },
  50: { label: 'ERROR', color: fmt.red },
  60: { label: 'FATAL', color: (s) => ansi('1;31', s) },
};

const IGNORED_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'reqId', 'msg', 'err', 'v']);

function formatTime(ms?: number): string {
  const d = ms ? new Date(ms) : new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

export function formatStatus(status: number): string {
  const s = String(status);
  if (status >= 500) return fmt.red(s);
  if (status >= 400) return fmt.yellow(s);
  if (status >= 300) return fmt.cyan(s);
  return fmt.green(s);
}

export function formatPinoLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return trimmed;
  }

  const time = fmt.dim(formatTime(typeof obj.time === 'number' ? obj.time : undefined));
  const DEFAULT_LEVEL = { label: 'INFO ', color: fmt.cyan };
  const lvl = (typeof obj.level === 'number' ? LEVELS[obj.level] : undefined) ?? DEFAULT_LEVEL;
  const badge = lvl.color(lvl.label);
  const msg = typeof obj.msg === 'string' ? obj.msg : '';

  const extra: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (IGNORED_KEYS.has(k) || v === undefined) continue;
    extra.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }

  let line = `${time} ${badge} ${msg}`;
  if (extra.length > 0) line += ` ${fmt.dim(extra.join(' '))}`;

  const err = obj.err as { message?: string; stack?: string } | undefined;
  if (err && (err.stack || err.message)) {
    const detail = err.stack ?? err.message ?? '';
    line += `\n${fmt.red(detail)}`;
  }
  return line;
}

/** Writable stream for Fastify's Pino logger that formats NDJSON into concise, colored console lines. */
export function createPrettyStream(out: NodeJS.WritableStream = process.stdout): Writable {
  let buf = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const formatted = formatPinoLine(line);
        if (formatted) out.write(`${formatted}\n`);
      }
      callback();
    },
    final(callback) {
      if (buf.trim()) {
        const formatted = formatPinoLine(buf);
        if (formatted) out.write(`${formatted}\n`);
      }
      callback();
    },
  });
}
