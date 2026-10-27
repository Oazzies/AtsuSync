import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChapterList, parsePages, parseSeries, parseSeriesUrl, webtoon } from '../src/sources/adapters/webtoon.ts';
import { matchesUrl } from '../src/sources/types.ts';

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const SERIES = 'https://www.webtoons.com/en/canvas/kiss-it-goodbye/list?title_no=443703';
const VIEWER =
  'https://www.webtoons.com/en/canvas/kiss-it-goodbye/extra-chapter-2-page-34/viewer?title_no=443703&episode_no=212&readingLanguageCode=en';

describe('webtoon adapter', () => {
  it('owns webtoons.com urls and parses series/viewer urls', () => {
    expect(matchesUrl(webtoon, SERIES)).toBe(true);
    expect(parseSeriesUrl(SERIES)).toEqual({ lang: 'en', genre: 'canvas', slug: 'kiss-it-goodbye', titleNo: '443703' });
    expect(parseSeriesUrl(VIEWER)?.titleNo).toBe('443703');
    expect(parseSeriesUrl('https://www.webtoons.com/en/')).toBeNull();
  });

  it('has no search (robots.txt forbids it) and is official', () => {
    expect(webtoon.search).toBeUndefined();
    expect(webtoon.kind).toBe('official');
  });

  it('parses series info', () => {
    const s = parseSeries(fx('webtoon-canvas-list.html'), SERIES);
    expect(s.title).toBe('Kiss It Goodbye');
    expect(s.cover).toMatch(/^https:\/\/.+\.jpg$/);
    expect(s.description).toMatch(/Aruka and Yukimi/);
  });

  it('lists free canvas episodes using episode_no as the number', () => {
    const chapters = parseChapterList(fx('webtoon-canvas-list.html'));
    expect(chapters).toHaveLength(10);
    expect(chapters[0]).toMatchObject({ number: 213, label: 'Dokomi!', locked: false, date: '2026-05-26T00:00:00.000Z' });
    expect(chapters[0]!.url).toContain('/viewer?title_no=443703&episode_no=213');
    expect(chapters.every((c) => !c.locked)).toBe(true);
  });

  it('uses an original series printed counter, not the site-wide episode id', () => {
    const chapters = parseChapterList(fx('webtoon-original-list.html'));
    expect(chapters[0]).toMatchObject({ number: 652, label: '[Season 3] Ep. 235 (Season 3 Finale)' });
  });

  it('marks paid / fast-pass / unlinked episodes as locked', () => {
    const html = `<ul>
      <li class="_episodeItem" data-episode-no="1"><a class="detail_list_link" href="/en/x/y/e/viewer?title_no=1&episode_no=1"><span class="subj">Free</span></a></li>
      <li class="_episodeItem" data-episode-no="2"><a class="detail_list_link" href="/en/x/y/e/viewer?title_no=1&episode_no=2"><span class="subj">Paid</span><span class="ico_lock"></span></a></li>
      <li class="_episodeItem" data-episode-no="3"><a class="detail_list_link" href="/en/x/y/e/viewer?title_no=1&episode_no=3"><span class="subj">Ep</span><em>Fast Pass</em></a></li>
      <li class="_episodeItem" data-episode-no="4"><a class="detail_list_link" href="#"><span class="subj">Gated</span></a></li>
    </ul>`;
    expect(parseChapterList(html).map((c) => c.locked)).toEqual([false, true, true, true]);
  });

  it('extracts viewer images with a webtoons referer', () => {
    const pages = parsePages(fx('webtoon-viewer.html'));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]).toMatchObject({ name: '001.jpg', headers: { referer: 'https://www.webtoons.com/' } });
    expect(pages[0]!.url).toMatch(/^https:\/\/webtoon-phinf\.pstatic\.net\//);
  });

  it('refuses locked chapters without fetching', async () => {
    await expect(webtoon.getChapterPages({ number: 1, label: 'Paid', url: VIEWER, locked: true }, {} as never)).rejects.toThrow(/locked/);
  });
});
