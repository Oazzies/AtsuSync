import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { matchesUrl, mediumOf, type SourceAdapter } from '../src/sources/types.ts';
import { flamecomics, parseBrowse as fcBrowse, parsePages as fcPages, parseSeries as fcSeries } from '../src/sources/adapters/flamecomics.ts';
import { mangack, parsePages as mcPages, parseSearch as mcSearch, parseSeries as mcSeries } from '../src/sources/adapters/mangack.ts';
import { mangazin } from '../src/sources/adapters/mangazin.ts';
import { nyxscans, parsePages as nyxPages, parseSeries as nyxSeries } from '../src/sources/adapters/nyxscans.ts';
import { rokaricomics } from '../src/sources/adapters/rokaricomics.ts';
import { webtoonclub, parsePages as wcPages, parseSearch as wcSearch, parseSeries as wcSeries } from '../src/sources/adapters/webtoonclub.ts';

describe('manhwa adapters', () => {
  it('are registered in the default registry as comics', () => {
    const reg = new SourceRegistry(openDb(':memory:'));
    for (const [adapter, url] of [
      [mangazin, 'https://mangazin.org/manga/solo-leveling-arise/'],
      [rokaricomics, 'https://rokaricomics.com/manga/do-your-best-and-regret/'],
      [flamecomics, 'https://flamecomics.xyz/series/2'],
      [webtoonclub, 'https://webtoonclub.com/webtoon/solo-leveling'],
      [mangack, 'https://mangack.com/manga/damn-reincarnation/'],
      [nyxscans, 'https://nyxscans.com/series/the-villainess-wants-a-divorce!'],
    ] as [SourceAdapter, string][]) {
      expect(reg.find(adapter.id)).toBeDefined();
      expect(mediumOf(adapter)).toBe('comic');
      expect(matchesUrl(adapter, url)).toBe(true);
    }
  });

  it('Flame Comics: browse search, __NEXT_DATA__ series, and chapter images', () => {
    const browseHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          series: [{ series_id: 2, title: "Omniscient Reader's Viewpoint", altTitles: ['ORV'], cover: 'thumbnail.png' }],
        },
      },
    })}</script>`;
    expect(fcBrowse(browseHtml, 'omniscient')).toEqual([
      {
        title: "Omniscient Reader's Viewpoint",
        url: 'https://flamecomics.xyz/series/2',
        cover: 'https://cdn.flamecomics.xyz/uploads/images/series/2/thumbnail.png',
      },
    ]);

    const seriesHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          series: { series_id: 2, title: "Omniscient Reader's Viewpoint", altTitles: ['ORV'], description: 'Desc', cover: 'thumbnail.png' },
          chapters: [{ chapter: '1.00', title: 'Prologue', token: 'tok1', release_date: 1700000000 }],
        },
      },
    })}</script>`;
    const s = fcSeries(seriesHtml, 'https://flamecomics.xyz/series/2');
    expect(s.title).toBe("Omniscient Reader's Viewpoint");
    expect(s.chapters[0]).toMatchObject({ number: 1, label: 'Chapter 1: Prologue', url: 'https://flamecomics.xyz/series/2/tok1' });

    const chHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          chapter: { series_id: 2, token: 'tok1', images: { '0': { name: '001.jpg', width: 800, height: 1200 } } },
        },
      },
    })}</script>`;
    expect(fcPages(chHtml, 'https://flamecomics.xyz/series/2/tok1')).toEqual([
      {
        url: 'https://cdn.flamecomics.xyz/uploads/images/series/2/tok1/001.jpg',
        name: '001.jpg',
        width: 800,
        height: 1200,
        headers: { referer: 'https://flamecomics.xyz/series/2/tok1' },
      },
    ]);
  });

  it('WebtoonClub: search, truncated chapter fill from 0..max, and page images', () => {
    expect(wcSearch('<a href="/webtoon/solo-leveling"><h3>Solo Leveling</h3><img src="/c.webp"/></a>')).toEqual([
      { title: 'Solo Leveling', url: 'https://webtoonclub.com/webtoon/solo-leveling', cover: 'https://webtoonclub.com/c.webp' },
    ]);
    const s = wcSeries(
      '<h1>Solo Leveling</h1><a href="/webtoon/solo-leveling/chapter/0">Ch 0</a><a href="/webtoon/solo-leveling/chapter/3">Ch 3</a>',
      'https://webtoonclub.com/webtoon/solo-leveling',
    );
    expect(s.chapters.map((c) => c.number)).toEqual([0, 1, 2, 3]);
    expect(wcPages('<img src="/uploads/chapters/1/2/001.webp"/>', 'https://webtoonclub.com/webtoon/solo-leveling/chapter/0')).toEqual([
      {
        url: 'https://webtoonclub.com/uploads/chapters/1/2/001.webp',
        name: '001.webp',
        headers: { referer: 'https://webtoonclub.com/webtoon/solo-leveling/chapter/0' },
      },
    ]);
  });

  it('mangack: search, series chapters, and .separator images', () => {
    expect(mcSearch('<div class="item"><a href="https://mangack.com/manga/damn-reincarnation/">Damn Reincarnation</a></div>')).toEqual([
      { title: 'Damn Reincarnation', url: 'https://mangack.com/manga/damn-reincarnation/', cover: undefined },
    ]);
    const s = mcSeries('<h1>Damn Reincarnation</h1><a href="https://mangack.com/chapter/damn-reincarnation-chapter-1/">Chapter 1</a>', 'https://mangack.com/manga/damn-reincarnation/');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://mangack.com/chapter/damn-reincarnation-chapter-1/' }]);
    expect(mcPages('<div class="separator"><img src="https://cdn.example/1.webp"/></div>', 'https://mangack.com/chapter/damn-reincarnation-chapter-1/')).toEqual([
      { url: 'https://cdn.example/1.webp', name: '001.webp', headers: { referer: 'https://mangack.com/chapter/damn-reincarnation-chapter-1/' } },
    ]);
  });

  it('Nyx Scans: series chapters and upload/series images (excluding featured cover)', () => {
    const s = nyxSeries(
      '<h1>The Villainess</h1><a href="/series/the-villainess/chapter-1">Ch 1</a><a href="/series/the-villainess/chapter-3">Ch 3</a>',
      'https://nyxscans.com/series/the-villainess',
    );
    expect(s.chapters.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(
      nyxPages(
        '<img src="https://storage.nyxscans.com/public/upload/series/featured/x.jpg"/><img src="https://media.nyxscans.com/upload/series/x/01.webp"/>',
        'https://nyxscans.com/series/the-villainess/chapter-1',
      ),
    ).toEqual([
      {
        url: 'https://media.nyxscans.com/upload/series/x/01.webp',
        name: '001.webp',
        headers: { referer: 'https://nyxscans.com/series/the-villainess/chapter-1' },
      },
    ]);
  });
});
