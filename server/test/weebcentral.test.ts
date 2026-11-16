import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chapterIdFromUrl,
  idFromUrl,
  parseChapterList,
  parsePages,
  parseSearch,
  parseSeries,
  weebcentral,
} from '../src/sources/adapters/weebcentral.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://weebcentral.com/series/01J76XYEZWRB4MRT7EHVVPEDXV/Reformation-of-the-Deadbeat-Noble';
const CHAPTER = 'https://weebcentral.com/chapters/01M7DX7VHA3NK9QCF1Y0Z8AGQ6';

describe('weebcentral adapter', () => {
  it('owns weebcentral.com urls and extracts series/chapter ids', () => {
    expect(matchesUrl(weebcentral, SERIES)).toBe(true);
    expect(matchesUrl(weebcentral, CHAPTER)).toBe(true);
    expect(idFromUrl(SERIES)).toBe('01J76XYEZWRB4MRT7EHVVPEDXV');
    expect(idFromUrl('https://weebcentral.com/series/01J76XYEZWRB4MRT7EHVVPEDXV')).toBe('01J76XYEZWRB4MRT7EHVVPEDXV');
    expect(idFromUrl('https://weebcentral.com/')).toBeNull();
    expect(chapterIdFromUrl(CHAPTER)).toBe('01M7DX7VHA3NK9QCF1Y0Z8AGQ6');
  });

  it('maps search results', () => {
    const hits = parseSearch(fx('weebcentral-search.html'));
    expect(hits).toEqual([
      {
        title: 'The Lazy Lord Masters the Sword',
        url: SERIES,
      },
      {
        title: "A DeadbEAT's Meal",
        url: 'https://weebcentral.com/series/01J76XYFA7G8MW7DZVA6B0BSSP/A-DeadbEATs-Meal',
      },
    ]);
  });

  it('parses series info and alt titles', () => {
    const s = parseSeries(fx('weebcentral-series.html'), SERIES);
    expect(s).toMatchObject({
      title: 'The Lazy Lord Masters the Sword',
      url: SERIES,
      altTitles: ['Reformation of the Deadbeat Noble', 'The Lazy Prince Becomes a Genius'],
    });
    expect(s.cover).toMatch(/01J76XYEZWRB4MRT7EHVVPEDXV\.jpg/);
    expect(s.description).toMatch(/Perreira is a boy who sleeps/);
  });

  it('parses an ascending chapter list with dates', () => {
    const chapters = parseChapterList(fx('weebcentral-chapters.html'));
    expect(chapters.length).toBeGreaterThan(100);
    const numbers = chapters.map((c) => c.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(chapters[0]).toMatchObject({
      number: 1,
      label: 'Episode 1',
      url: 'https://weebcentral.com/chapters/01J76XZ36FYB1P2S47YHSBDVND',
      locked: false,
    });
    const last = chapters.at(-1)!;
    expect(last).toMatchObject({
      number: 168,
      label: 'Episode 168',
      url: CHAPTER,
      date: '2026-11-14T20:51:01.802Z',
      locked: false,
    });
  });

  it('collects reader images in order', () => {
    const pages = parsePages(fx('weebcentral-chapter.html'), CHAPTER);
    expect(pages.length).toBeGreaterThan(10);
    expect(pages[0]).toEqual({
      url: 'https://scans.lastation.us/manga/Reformation-of-the-Deadbeat-Noble/0168-001.png',
      name: '001.png',
      headers: { referer: CHAPTER },
    });
    expect(pages[1]!.name).toBe('002.png');
  });
});
