import * as cheerio from 'cheerio';
import { extractJsonAfterKey, rscPayload } from '../nextjs.ts';
import type { PageRef, SourceAdapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://lewdmanhwa.com';

/** "/webtoon/autumn-chili" or ".../autumn-chili/chapter/1" → "autumn-chili". */
export const slugFromUrl = (url: string): string | null => {
  try {
    const m = new URL(url).pathname.match(/^\/webtoon\/([^/]+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const byUrl = new Map<string, SourceSeriesHit>();
  $('a[href^="/webtoon/"]').each((_, el) => {
    const href = $(el).attr('href')!;
    if (!/^\/webtoon\/[^/]+$/.test(href)) return;
    const url = abs(href);
    const hit = byUrl.get(url) ?? { title: '', url };
    // Each series has a cover link and a title link; merge them.
    const title = $(el).text().trim();
    if (title && !hit.title) hit.title = title;
    const src = $(el).find('img').first().attr('src');
    if (src && !hit.cover) hit.cover = abs(src);
    byUrl.set(url, hit);
  });
  return [...byUrl.values()].filter((h) => h.title);
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters'> {
  const $ = cheerio.load(html);
  let book: Record<string, any> = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      for (const node of data['@graph'] ?? [data]) if (node['@type'] === 'Book') book = node;
    } catch {
      /* ignore */
    }
  });
  const alt: unknown = book.alternateName;
  return {
    title: book.name ?? ($('h1').first().text().trim() || slugFromUrl(url) || url),
    url,
    altTitles: Array.isArray(alt) ? alt.filter((a): a is string => typeof a === 'string') : [],
    cover: $('meta[property="og:image"]').attr('content') || undefined,
    description: (book.description as string | undefined) || $('meta[name="description"]').attr('content') || undefined,
  };
}

export function parseChapterList(html: string, slug: string): SourceSeries['chapters'] {
  const $ = cheerio.load(html);
  const prefix = `/webtoon/${slug}/chapter/`;
  const byNumber = new Map<number, SourceSeries['chapters'][number]>();
  $(`a[href^="${prefix}"]`).each((_, el) => {
    const href = $(el).attr('href')!;
    const number = Number(href.slice(prefix.length));
    // The "Latest Ch." / "Read First" buttons wrap the same links; only list rows carry the "Ch. N" label.
    if (!Number.isFinite(number) || byNumber.has(number) || !/^\s*Ch\./.test($(el).text())) return;
    byNumber.set(number, { number, label: `Chapter ${number}`, url: abs(href), locked: false });
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

interface ChapterImage {
  filename: string;
  width?: number;
  height?: number;
  sortOrder?: number;
}

const pageName = (i: number, url: string) => `${String(i + 1).padStart(3, '0')}.${new URL(url).pathname.split('.').pop() ?? 'webp'}`;

/**
 * The server-rendered HTML only contains the first few `<img>` tags (the rest are lazy placeholders filled in by
 * the client), but the full page list ships in the RSC payload as `chapter.images`.
 */
export function parsePages(html: string, referer: string): PageRef[] {
  const images = extractJsonAfterKey<{ images?: ChapterImage[] }>(rscPayload(html), 'chapter')?.images;
  if (images?.length) {
    const sorted = [...images].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return sorted.map((img, i) => {
      const url = abs(`/uploads/${img.filename}`);
      return { url, name: pageName(i, url), headers: { referer }, width: img.width, height: img.height };
    });
  }

  // Fallback: whatever <img> tags the page rendered (may be only the first few pages).
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('img[src*="/uploads/chapters/"]').each((_, el) => {
    const url = abs($(el).attr('src')!);
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  });
  return urls.map((u, i) => ({ url: u, name: pageName(i, u), headers: { referer } }));
}

export const lewdmanhwa: SourceAdapter = {
  id: 'lewdmanhwa',
  name: 'LewdManhwa',
  baseUrl: BASE,
  kind: 'aggregator',
  nsfw: true,
  hosts: ['lewdmanhwa.com'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a LewdManhwa series URL: ${url}`);
    const seriesUrl = `${BASE}/webtoon/${slug}`;
    const html = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    return { ...parseSeries(html, seriesUrl), chapters: parseChapterList(html, slug) };
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
