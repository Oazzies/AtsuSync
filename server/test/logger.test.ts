import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrettyStream, formatDuration, formatPinoLine } from '../src/logger.ts';

describe('logger', () => {
  it('formats Pino NDJSON lines without raw JSON boilerplate', () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const ts = new Date(2026, 0, 1, 13, 51, 11).getTime();
      const raw = JSON.stringify({
        level: 30,
        time: ts,
        pid: 21012,
        hostname: 'DESKTOP-6ND3OI3',
        reqId: 'req-m',
        msg: 'AtsuSync API on http://127.0.0.1:4517',
      });
      expect(formatPinoLine(raw)).toBe('13:51:11 INFO  AtsuSync API on http://127.0.0.1:4517');
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it('includes error details and extra fields when present', () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const ts = new Date(2026, 0, 1, 9, 5, 3).getTime();
      const raw = JSON.stringify({
        level: 50,
        time: ts,
        port: 4517,
        msg: 'listen failed',
        err: { message: 'EADDRINUSE', stack: 'Error: EADDRINUSE\n    at server.ts:1' },
      });
      expect(formatPinoLine(raw)).toBe(
        '09:05:03 ERROR listen failed port=4517\nError: EADDRINUSE\n    at server.ts:1',
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it('streams chunked lines cleanly', async () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const out = new PassThrough();
      let collected = '';
      out.on('data', (c) => (collected += c.toString()));
      const stream = createPrettyStream(out);
      const ts = new Date(2026, 0, 1, 12, 0, 0).getTime();
      const line1 = JSON.stringify({ level: 30, time: ts, msg: 'first' });
      const line2 = JSON.stringify({ level: 40, time: ts, msg: 'second' });
      stream.write(line1.slice(0, 10));
      stream.write(line1.slice(10) + '\n' + line2 + '\n');
      await new Promise<void>((resolve) => stream.end(resolve));
      expect(collected).toBe('12:00:00 INFO  first\n12:00:00 WARN  second\n');
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it('formats durations concisely', () => {
    expect(formatDuration(1.5382)).toBe('1.5ms');
    expect(formatDuration(28564.2342)).toBe('28.56s');
  });
});
