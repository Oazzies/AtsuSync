import * as cheerio from 'cheerio';
import { escapeXml } from '../novel.ts';
import type { NovelChapter, SourceAdapter, SourceChapter, SourceSeries } from '../types.ts';

const BASE = 'https://wuxia.click';

interface WuxiaClickNextData {
  props?: {
    pageProps?: {
      novel?: {
        slug?: string;
        title?: string;
        altTitles?: string[];
        description?: string;
        coverOriginal?: string;
      };
      toc?: {
        items?: { number: number; title?: string }[];
        ranges?: { page: number; from: number; to: number }[];
      };
      data?: {
        chapter?: {
          title?: string;
          paragraphs?: string[];
        };
      };
    };
  };
}

function nextData(html: string): WuxiaClickNextData {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').html();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as WuxiaClickNextData;
  } catch {
    return {};
  }
}

export function parseSeries(html: string, url: string): { series: SourceSeries; pages: number[] } {
  const pp = nextData(html).props?.pageProps;
  const novel = pp?.novel;
  if (!novel?.slug || !novel.title) throw new Error(`Not a WuxiaClick novel page: ${url}`);
  const slug = novel.slug;
  const byNumber = new Map<number, SourceChapter>();
  for (const item of pp?.toc?.items ?? []) {
    if (!Number.isFinite(item.number) || byNumber.has(item.number)) continue;
    byNumber.set(item.number, {
      number: item.number,
      label: item.title?.trim() || `Chapter ${item.number}`,
      url: `${BASE}/chapter/${slug}-${item.number}`,
    });
  }
  const pages = (pp?.toc?.ranges ?? []).map((r) => r.page).filter((p) => p > 1);
  return {
    series: {
      title: novel.title.trim(),
      url: `${BASE}/novel/${slug}`,
      altTitles: (novel.altTitles ?? []).map((t) => t.trim()).filter((t) => t && t !== novel.title),
      cover: novel.coverOriginal || undefined,
      description: novel.description?.trim() || undefined,
      chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
    },
    pages,
  };
}

export function parseChapterText(html: string, fallbackTitle: string): NovelChapter {
  const ch = nextData(html).props?.pageProps?.data?.chapter;
  if (!ch?.paragraphs?.length) throw new Error('WuxiaClick chapter has no text');
  const body = ch.paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p)}</p>`)
    .join('\n');
  return { title: ch.title?.trim() || fallbackTitle, html: body };
}

export const wuxiaclick: SourceAdapter = {
  id: 'wuxiaclick',
  name: 'WuxiaClick',
  baseUrl: BASE,
  kind: 'aggregator',
  medium: 'novel',
  hosts: ['wuxia.click'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async getSeries(url, http) {
    const clean = url.split('?')[0]!.replace(/\/$/, '');
    const first = parseSeries(await http.text(clean, { cacheMs: 10 * 60_000 }), clean);
    const byNumber = new Map(first.series.chapters.map((c) => [c.number, c]));
    for (const page of first.pages) {
      const next = parseSeries(await http.text(`${clean}?page=${page}`, { cacheMs: 10 * 60_000 }), clean);
      for (const c of next.series.chapters) {
        if (!byNumber.has(c.number)) byNumber.set(c.number, c);
      }
    }
    first.series.chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    if (first.series.chapters.length === 0) first.series.emptyReason = 'no chapter list found';
    return first.series;
  },

  async getChapterPages() {
    throw new Error('WuxiaClick chapters are novel text, not page images');
  },

  async getChapterText(chapter, http) {
    return parseChapterText(await http.text(chapter.url), chapter.label);
  },
};
