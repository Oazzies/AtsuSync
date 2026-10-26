import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChapterId, parsePages, parseSeries, parseSitemap } from '../src/sources/adapters/nuviatoon.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('nuviatoon adapter', () => {
  it('lists series from the sitemap (search is disallowed by robots.txt)', () => {
    const hits = parseSitemap(fx('nuviatoon-sitemap.xml'));
    expect(hits.length).toBeGreaterThan(30);
    expect(hits).toContainEqual({ title: 'Heart Aching', url: 'https://nuviatoon.net/comics/heart-aching' });
    expect(hits.every((h) => /\/comics\/[a-z0-9-]+$/.test(h.url))).toBe(true);
  });

  it('parses series metadata and every chapter incl. half chapters', () => {
    const s = parseSeries(fx('nuviatoon-series.html'), 'https://nuviatoon.net/comics/heart-aching');
    expect(s.title).toBe('Heart-Aching');
    expect(s.altTitles).toContain('아리도록');
    const numbers = s.chapters.map((c) => c.number);
    expect(numbers.length).toBeGreaterThanOrEqual(32);
    expect(numbers).toContain(30.5);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    const c31 = s.chapters.find((c) => c.number === 31)!;
    expect(c31.url).toBe('https://nuviatoon.net/comics/heart-aching/chapter/31');
    expect(c31.locked).toBe(false);
  });

  it('extracts the chapter UUID from the reader page', () => {
    expect(parseChapterId(fx('nuviatoon-chapter.html'))).toBe('728c6de8-cf9b-4c10-bfe6-cbef75391794');
  });

  it('maps the content API to ordered page refs with a referer', () => {
    const pages = parsePages(JSON.parse(fx('nuviatoon-content.json')), 'https://nuviatoon.net/comics/heart-aching/chapter/31');
    expect(pages.length).toBeGreaterThan(10);
    expect(pages[0]!.name).toBe('001.webp');
    expect(pages[0]!.url).toContain('/0001.webp');
    expect(pages[0]!.headers?.referer).toContain('/chapter/31');
  });
});
