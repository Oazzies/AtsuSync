import * as cheerio from 'cheerio';
import { chapterXhtml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries } from '../types.ts';

const BASE = 'https://lnmtl.com';

export interface LnmtlVolume {
  id: number;
  title?: string;
  number?: number;
}

export interface LnmtlChapterItem {
  number: number;
  title?: string;
  site_url?: string;
  slug?: string;
}

export function parseVolumes(html: string): LnmtlVolume[] {
  const m = html.match(/lnmtl\.volumes\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]!) as LnmtlVolume[];
  } catch {
    return [];
  }
}

export function parseSeries(html: string, url: string, chapters: SourceChapter[] = []): SourceSeries {
  const $ = cheerio.load(html);
  const title = ($('.novel-name').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim();
  const cover = $('img.img-rounded, .novel-cover img').first().attr('src')?.trim()
    || $('meta[property="og:image"]').attr('content')?.trim()
    || undefined;
  const description = $('.description p').first().text().trim()
    || $('meta[property="og:description"]').attr('content')?.trim()
    || undefined;
  return {
    title,
    url,
    altTitles: [],
    cover,
    description,
    chapters: [...chapters].sort((a, b) => a.number - b.number),
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const box = $('.chapter-body').first();
  // LNMTL renders each paragraph as a <sentence class="translated"> alongside original text.
  const translated = box.find('sentence.translated, .translated');
  let bodyHtml = '';
  if (translated.length > 0) {
    const wrapped = cheerio.load('<div id="c"></div>');
    translated.each((_, el) => {
      const text = $(el).text().trim();
      if (text) wrapped('#c').append(`<p>${cheerio.load('')('<div>').text(text).html()}</p>`);
    });
    bodyHtml = chapterXhtml(wrapped, wrapped('#c'));
  } else {
    box.find('script, style, .original').remove();
    bodyHtml = chapterXhtml($, box);
  }
  const title = ($('.chapter-title').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim() || fallbackTitle;
  return { title, html: bodyHtml };
}

export const lnmtl: SourceAdapter = {
  id: 'lnmtl',
  name: 'LNMTL',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['lnmtl.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async getSeries(url, http) {
    const html = await http.text(url, { cacheMs: 10 * 60_000 });
    const volumes = parseVolumes(html);
    const byNumber = new Map<number, SourceChapter>();
    for (const vol of volumes) {
      let page = 1;
      let lastPage = 1;
      do {
        const res = await http.json<{ last_page?: number; data?: LnmtlChapterItem[] }>(
          `${BASE}/chapter?volumeId=${vol.id}&page=${page}`,
          { cacheMs: 10 * 60_000 },
        );
        lastPage = res.last_page ?? 1;
        for (const item of res.data ?? []) {
          const num = Number(item.number);
          if (!Number.isFinite(num) || byNumber.has(num)) continue;
          const chUrl = item.site_url || (item.slug ? `${BASE}/chapter/${item.slug}` : '');
          if (!chUrl) continue;
          byNumber.set(num, {
            number: num,
            label: item.title ? `Chapter ${num}: ${item.title}` : `Chapter ${num}`,
            url: new URL(chUrl, BASE).href,
          });
        }
        page++;
      } while (page <= lastPage);
    }
    const series = parseSeries(html, url, [...byNumber.values()]);
    if (series.chapters.length === 0) series.emptyReason = 'no chapter list found';
    return series;
  },

  async getChapterPages() {
    throw new Error('LNMTL chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
