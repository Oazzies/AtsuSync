import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mangaread } from '../src/sources/adapters/mangaread.ts';
import { madaraSlugFromUrl, parseMadaraPages, parseMadaraSearch, parseMadaraSeries } from '../src/sources/madara.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const BASE = 'https://www.mangaread.org';
const SERIES = 'https://www.mangaread.org/manga/cyberpunk-swordsman/';
const CHAPTER = 'https://www.mangaread.org/manga/cyberpunk-swordsman/chapter-8/';

describe('madara adapter (mangaread)', () => {
  it('owns mangaread.org urls and extracts slug', () => {
    expect(matchesUrl(mangaread, SERIES)).toBe(true);
    expect(matchesUrl(mangaread, CHAPTER)).toBe(true);
    expect(madaraSlugFromUrl(SERIES)).toBe('cyberpunk-swordsman');
  });

  it('maps search results', () => {
    const hits = parseMadaraSearch(fx('madara-search.html'), 'https://manhwanex.com');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      title: 'Revenge of the Iron-Blooded Sword Hound',
      url: 'https://manhwanex.com/manga/revenge-of-the-iron-blooded-sword-hound/',
    });
  });

  it('parses series info and ascending chapters', () => {
    const s = parseMadaraSeries(fx('madara-series.html'), SERIES, BASE);
    expect(s.title).toBe('Cyberpunk Swordsman');
    expect(s.chapters.length).toBeGreaterThan(5);
    const numbers = s.chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(s.chapters[0]!.locked).toBe(false);
  });

  it('collects reader images in order and trims whitespace', () => {
    const pages = parseMadaraPages(fx('madara-chapter.html'), CHAPTER, 'https://manhwanex.com');
    expect(pages.length).toBeGreaterThan(5);
    expect(pages[0]).toEqual({
      url: 'https://cdn.manhwanex.com/manga_6a0008daa3569/3b4273f604c05ec73e31da5e8605b719/imgi_6_001.jpg',
      name: '001.jpg',
      headers: { referer: CHAPTER },
    });
  });
});
