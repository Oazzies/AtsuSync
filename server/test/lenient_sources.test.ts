import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { SourceHttp } from '../src/sources/http.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { matchesUrl, mediumOf, type SourceAdapter } from '../src/sources/types.ts';
import { cocomic, parsePages as ccPages, parseSeries as ccSeries } from '../src/sources/adapters/cocomic.ts';
import { mangakatana, parsePages as mkPages, parseSearch as mkSearch, parseSeries as mkSeries } from '../src/sources/adapters/mangakatana.ts';
import { manganatogg, parsePages as mgPages, parseSeries as mgSeries } from '../src/sources/adapters/manganatogg.ts';
import { manhwanex } from '../src/sources/adapters/manhwanex.ts';
import { novelping, parseSearch as npSearch, parseSeries as npSeries, parseText as npText } from '../src/sources/adapters/novelping.ts';
import { scrollerspub, parseSearch as spSearch, parseSeries as spSeries, parseText as spText } from '../src/sources/adapters/scrollerspub.ts';
import { woopread, parseSearch as wrSearch, parseSeries as wrSeries, parseText as wrText } from '../src/sources/adapters/woopread.ts';

describe('lenient adapters across novel, manhwa, manga', () => {
  it('registers all 7 adapters with expected media and hosts', () => {
    const reg = new SourceRegistry(openDb(':memory:'));
    for (const [adapter, medium, url] of [
      [cocomic, 'comic', 'https://cocomic.co/manga/thus-i-married-the-monster-twice/'],
      [manhwanex, 'comic', 'https://manhwanex.com/manga/the-true-tycoon-who-rose-alone/'],
      [mangakatana, 'comic', 'https://mangakatana.com/manga/urasekai-picnic.21096'],
      [manganatogg, 'comic', 'https://www.manganato.gg/manga/the-youngest-son-of-the-eunhae-merchant-group'],
      [novelping, 'novel', 'https://novelping.com/book/eldritch-horror-theatre'],
      [woopread, 'novel', 'https://woopread.com/series/genius'],
      [scrollerspub, 'novel', 'https://www.scrollerspub.com/novel/weakest-beast-tamer'],
    ] as [SourceAdapter, 'comic' | 'novel', string][]) {
      expect(reg.find(adapter.id)).toBeDefined();
      expect(mediumOf(adapter)).toBe(medium);
      expect(matchesUrl(adapter, url)).toBe(true);
    }
  });

  it('Manhwanex: ignores robots.txt disallow on ajax/chapters/', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /\n', { status: 200 });
      }
      if (url.endsWith('/ajax/chapters/')) {
        return new Response('<li class="wp-manga-chapter"><a href="https://manhwanex.com/manga/solo/chapter-1/">Chapter 1</a></li>', { status: 200 });
      }
      return new Response('<html><div class="post-title"><h1>Solo</h1></div></html>', { status: 200 });
    };
    const http = new SourceHttp(fakeFetch, true);
    const series = await manhwanex.getSeries('https://manhwanex.com/manga/solo/', http);
    expect(series.title).toBe('Solo');
    expect(series.chapters).toHaveLength(1);
  });

  it('Cocomic: series and .asura-stream-images pages', () => {
    const seriesHtml = `
      <h1>Monster Twice</h1>
      <a href="/manga/m/chapter-1/">▶ Read First (Chapter 1)</a>
      <a href="/manga/m/chapter-1/">Chapter 1</a>
    `;
    const s = ccSeries(seriesHtml, 'https://cocomic.co/manga/m/');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://cocomic.co/manga/m/chapter-1/' }]);

    const chHtml = `<div class="asura-stream-images"><img src="https://img.cocomic.co/1.jpg"></div>`;
    expect(ccPages(chHtml, 'https://cocomic.co/manga/m/chapter-1/')).toEqual([
      { url: 'https://img.cocomic.co/1.jpg', name: '001.jpg', headers: { referer: 'https://cocomic.co/manga/m/chapter-1/' } },
    ]);
  });

  it('MangaKatana: search, series, and thzq image array', () => {
    const searchHtml = `<div id="book_list"><div class="item"><div class="title"><a href="/manga/up.1">Urasekai Picnic</a></div><img src="/c.jpg"></div></div>`;
    expect(mkSearch(searchHtml)).toEqual([
      { title: 'Urasekai Picnic', url: 'https://mangakatana.com/manga/up.1', cover: 'https://mangakatana.com/c.jpg' },
    ]);

    const seriesHtml = `<h1 class="heading">Urasekai Picnic</h1><div class="chapters"><table><tr><td><a href="/manga/up.1/c1">Chapter 1</a></td></tr></table></div>`;
    const s = mkSeries(seriesHtml, 'https://mangakatana.com/manga/up.1');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://mangakatana.com/manga/up.1/c1' }]);

    const chHtml = `<script>var thzq = ['https://i1.mangakatana.com/t/0.jpg','https://i1.mangakatana.com/t/1.jpg'];</script>`;
    expect(mkPages(chHtml, 'https://mangakatana.com/manga/up.1/c1')).toEqual([
      { url: 'https://i1.mangakatana.com/t/0.jpg', name: '001.jpg', headers: { referer: 'https://mangakatana.com/manga/up.1/c1' } },
      { url: 'https://i1.mangakatana.com/t/1.jpg', name: '002.jpg', headers: { referer: 'https://mangakatana.com/manga/up.1/c1' } },
    ]);
  });

  it('Manganato.gg: URL-only series and .container-chapter-reader pages', () => {
    const seriesHtml = `<h1>Eunhae</h1><a href="/manga/e/chapter-1">Start Reading</a><a href="/manga/e/chapter-1">Chapter 1</a>`;
    const s = mgSeries(seriesHtml, 'https://www.manganato.gg/manga/e');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://www.manganato.gg/manga/e/chapter-1' }]);

    const chHtml = `<div class="container-chapter-reader"><img src="https://img-r1.2xstorage.com/1.webp"></div>`;
    expect(mgPages(chHtml, 'https://www.manganato.gg/manga/e/chapter-1')).toEqual([
      { url: 'https://img-r1.2xstorage.com/1.webp', name: '001.webp', headers: { referer: 'https://www.manganato.gg/manga/e/chapter-1' } },
    ]);
  });

  it('NovelPing, WoopRead, and ScrollersPub: search, series, and chapter text', () => {
    expect(npSearch(`<a href="/book/test">Test Novel</a>`)).toEqual([
      { title: 'Test Novel', url: 'https://novelping.com/book/test', cover: undefined },
    ]);
    expect(npSeries(`<h1>Test</h1><a href="/book/test/chapter-1">READ NOW</a><a href="/book/test/chapter-1">Chapter 1</a>`, 'https://novelping.com/book/test').chapters).toEqual([
      { number: 1, label: 'Chapter 1', url: 'https://novelping.com/book/test/chapter-1' },
    ]);
    expect(npText(`<h1>Ch 1</h1><div id="chr-content"><p>Hello world.</p></div>`, 'Ch 1').html).toContain('Hello world.');

    expect(wrSearch(`<a href="/series/genius"><h3>Genius</h3></a>`)).toEqual([
      { title: 'Genius', url: 'https://woopread.com/series/genius', cover: undefined },
    ]);
    expect(wrSeries(`<h1>Genius</h1><a href="/series/genius/chapter-1">Read Now</a><a href="/series/genius/chapter-1">Chapter 1</a>`, 'https://woopread.com/series/genius').chapters).toEqual([
      { number: 1, label: 'Chapter 1', url: 'https://woopread.com/series/genius/chapter-1' },
    ]);
    expect(wrText(`<h1>Ch 1</h1><div class="space-y-4"><p>A</p><p>B</p><p>C</p></div>`, 'Ch 1').html).toContain('<p>A</p>');

    expect(spSearch(`<a href="/novel/beast">Beast Tamer</a>`)).toEqual([
      { title: 'Beast Tamer', url: 'https://www.scrollerspub.com/novel/beast', cover: undefined },
    ]);
    expect(spSeries(`<h1>Beast</h1><a href="/read/uuid-1">Chapter 1</a>`, 'https://www.scrollerspub.com/novel/beast').chapters).toEqual([
      { number: 1, label: 'Chapter 1', url: 'https://www.scrollerspub.com/read/uuid-1' },
    ]);
    expect(spText(`<h1>Ch 1</h1><div id="chapter-content"><p>Story line.</p></div>`, 'Ch 1').html).toContain('Story line.');
  });
});
