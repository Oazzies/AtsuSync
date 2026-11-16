import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { SourceHttp } from '../src/sources/http.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { matchesUrl, mediumOf, type SourceAdapter } from '../src/sources/types.ts';
import { aquareader } from '../src/sources/adapters/aquareader.ts';
import { demonicscans, parsePages as dsPages, parseSearch as dsSearch, parseSeries as dsSeries } from '../src/sources/adapters/demonicscans.ts';
import { manhuabuddy, parsePages as mbPages, parseSearch as mbSearch, parseSeries as mbSeries } from '../src/sources/adapters/manhuabuddy.ts';
import { mangamikan, parsePages as mmPages, parseSearch as mmSearch, parseSeries as mmSeries } from '../src/sources/adapters/mangamikan.ts';

describe('manga adapters', () => {
  it('are registered in the default registry as comics', () => {
    const reg = new SourceRegistry(openDb(':memory:'));
    for (const [adapter, url] of [
      [aquareader, 'https://aquareader.org/manga/solo-leveling-arise/'],
      [demonicscans, 'https://demonicscans.org/manga/Solo-Leveling'],
      [manhuabuddy, 'https://manhuabuddy.com/manhwa/temptress/'],
      [mangamikan, 'https://mangamikan.com/title/49454/love-one-hundred-years-strong'],
    ] as [SourceAdapter, string][]) {
      expect(reg.find(adapter.id)).toBeDefined();
      expect(mediumOf(adapter)).toBe('comic');
      expect(matchesUrl(adapter, url)).toBe(true);
    }
  });

  it('Aqua Manga: uses Madara ajax/chapters/ POST for chapter list', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.endsWith('/ajax/chapters/')) {
        return new Response('<li class="wp-manga-chapter"><a href="https://aquareader.org/manga/solo/chapter-1/">Chapter 1</a></li>', { status: 200 });
      }
      return new Response('<html><div class="post-title"><h1>Solo</h1></div></html>', { status: 200 });
    };
    const http = new SourceHttp(fakeFetch, false);
    const series = await aquareader.getSeries('https://aquareader.org/manga/solo/', http);
    expect(series.title).toBe('Solo');
    expect(series.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://aquareader.org/manga/solo/chapter-1/', locked: false }]);
    expect(calls).toEqual([
      { url: 'https://aquareader.org/manga/solo/', method: 'GET' },
      { url: 'https://aquareader.org/manga/solo/ajax/chapters/', method: 'POST' },
    ]);
  });

  it('Manga Demon: search, series (prefers real label over Read First), and pages (filters ads)', () => {
    const searchHtml = `<div><a href="/manga/Solo-Leveling"><img src="/covers/sl.jpg">Solo Leveling</a></div>`;
    expect(dsSearch(searchHtml)).toEqual([
      { title: 'Solo Leveling', url: 'https://demonicscans.org/manga/Solo-Leveling', cover: 'https://demonicscans.org/covers/sl.jpg' },
    ]);

    const seriesHtml = `
      <h1>Solo Leveling</h1>
      <a href="/title/Solo-Leveling/chapter/1/chaptered.php?chapter=1">Read First Chap</a>
      <a href="/title/Solo-Leveling/chapter/1/chaptered.php?chapter=1">Chapter 1</a>
    `;
    const s = dsSeries(seriesHtml, 'https://demonicscans.org/manga/Solo-Leveling');
    expect(s.chapters).toEqual([
      { number: 1, label: 'Chapter 1', url: 'https://demonicscans.org/title/Solo-Leveling/chapter/1/chaptered.php?chapter=1' },
    ]);

    const chHtml = `
      <img class="imgholder" src="https://demonicscans.org/images/free_ads.jpg">
      <img class="imgholder" src="https://mangareadon.org/Solo/1/1.jpg">
    `;
    expect(dsPages(chHtml, 'https://demonicscans.org/ch1')).toEqual([
      { url: 'https://mangareadon.org/Solo/1/1.jpg', name: '001.jpg', headers: { referer: 'https://demonicscans.org/ch1' } },
    ]);
  });

  it('ManhuaBuddy: search, series, and pages', () => {
    const searchHtml = `<div><a href="/manhwa/temptress/" title="Temptress"><img data-src="https://cdn.manhuabuddy.com/c.jpg"></a></div>`;
    expect(mbSearch(searchHtml)).toEqual([
      { title: 'Temptress', url: 'https://manhuabuddy.com/manhwa/temptress/', cover: 'https://cdn.manhuabuddy.com/c.jpg' },
    ]);

    const seriesHtml = `
      <h1>Temptress</h1>
      <a href="/manhwa/temptress/chapter-1/">Read Now</a>
      <a href="/manhwa/temptress/chapter-1/">Chapter 1</a>
    `;
    const s = mbSeries(seriesHtml, 'https://manhuabuddy.com/manhwa/temptress/');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://manhuabuddy.com/manhwa/temptress/chapter-1/' }]);

    const chHtml = `<div class="chapter-content"><img src="https://cdn.manhuabuddy.com/images/1.jpg"></div>`;
    expect(mbPages(chHtml, 'https://manhuabuddy.com/manhwa/temptress/chapter-1/')).toEqual([
      { url: 'https://cdn.manhuabuddy.com/images/1.jpg', name: '001.jpg', headers: { referer: 'https://manhuabuddy.com/manhwa/temptress/chapter-1/' } },
    ]);
  });

  it('MangaMikan: search, series (strips New badge), and pages', () => {
    const searchHtml = `<div><a href="/title/49454/love" title="Love"><img src="/c.webp"></a></div>`;
    expect(mmSearch(searchHtml)).toEqual([
      { title: 'Love', url: 'https://mangamikan.com/title/49454/love', cover: 'https://mangamikan.com/c.webp' },
    ]);

    const seriesHtml = `<h1>Love</h1><a href="/read/49454/1">Chapter 1New 1 day ago</a>`;
    const s = mmSeries(seriesHtml, 'https://mangamikan.com/title/49454/love');
    expect(s.chapters).toEqual([{ number: 1, label: 'Chapter 1', url: 'https://mangamikan.com/read/49454/1' }]);

    const chHtml = `<img src="/mangas/49454/p0001.webp">`;
    expect(mmPages(chHtml, 'https://mangamikan.com/read/49454/1')).toEqual([
      { url: 'https://mangamikan.com/mangas/49454/p0001.webp', name: '001.webp', headers: { referer: 'https://mangamikan.com/read/49454/1' } },
    ]);
  });
});
