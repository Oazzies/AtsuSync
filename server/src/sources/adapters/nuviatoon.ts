import * as cheerio from 'cheerio';
import { extractJsonAfterKey, rscPayload } from '../nextjs.ts';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://nuviatoon.net';

interface NuviaChapter {
  id: string;
  number: number;
  title: string | null;
  priceCoins: number;
  publishedAt?: string;
}

interface NuviaPage {
  index: number;
  url: string;
  width?: number;
  height?: number;
}

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const hits = new Map<string, SourceSeriesHit>();
  $('a[href^="/comics/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/^\/comics\/[^/]+$/.test(href) || hits.has(href)) return;
    const img = $(el).find('img').first();
    const title = img.attr('alt')?.trim() || $(el).find('h2,h3,p').first().text().trim();
    if (!title) return;
    hits.set(href, { title, url: BASE + href, cover: resolveNextImage(img.attr('src')) });
  });
  return [...hits.values()];
}

export function parseSeries(html: string, url: string): SourceSeries {
  const $ = cheerio.load(html);
  const slug = new URL(url).pathname.split('/')[2] ?? '';
  let ld: Record<string, any> = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (data['@type'] === 'ComicSeries') ld = data;
    } catch {
      /* ignore */
    }
  });

  const payload = rscPayload(html);
  const raw = extractJsonAfterKey<NuviaChapter[]>(payload, 'chapters') ?? [];
  let chapters: SourceChapter[] = raw.map((c) => toChapter(slug, c));

  // Fallback: plain anchors if the RSC payload shape ever changes.
  if (chapters.length === 0) {
    const seen = new Set<number>();
    $(`a[href^="/comics/${slug}/chapter/"]`).each((_, el) => {
      const n = Number($(el).attr('href')!.split('/').pop());
      if (!Number.isFinite(n) || seen.has(n)) return;
      seen.add(n);
      chapters.push({ number: n, label: `Chapter ${n}`, url: `${BASE}/comics/${slug}/chapter/${n}` });
    });
  }
  chapters = chapters.sort((a, b) => a.number - b.number);

  return {
    title: ld.name ?? ($('h1').first().text().trim() || slug),
    url: `${BASE}/comics/${slug}`,
    altTitles: Array.isArray(ld.alternateName) ? ld.alternateName : [],
    cover: ld.image,
    description: ld.description,
    chapters,
  };
}

function toChapter(slug: string, c: NuviaChapter): SourceChapter {
  return {
    number: c.number,
    label: `Chapter ${c.number}${c.title ? ` — ${c.title}` : ''}`,
    url: `${BASE}/comics/${slug}/chapter/${c.number}`,
    title: c.title ?? undefined,
    date: c.publishedAt,
    locked: c.priceCoins > 0,
  };
}

export function parseChapterId(html: string): string | null {
  const meta = extractJsonAfterKey<{ id?: string }>(rscPayload(html), 'meta');
  return meta?.id ?? null;
}

export function parsePages(json: { data?: { pages?: NuviaPage[] } }, referer: string): PageRef[] {
  const pages = [...(json.data?.pages ?? [])].sort((a, b) => a.index - b.index);
  return pages.map((p, i) => {
    const ext = new URL(p.url).pathname.split('.').pop() ?? 'webp';
    return {
      url: p.url,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
      width: p.width,
      height: p.height,
    };
  });
}

function resolveNextImage(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('/_next/image')) {
    const inner = new URL(src, BASE).searchParams.get('url');
    return inner ? new URL(inner, BASE).href : undefined;
  }
  return new URL(src, BASE).href;
}

export const nuviatoon: SourceAdapter = {
  id: 'nuviatoon',
  name: 'Nuviatoon',
  baseUrl: BASE,
  hosts: ['nuviatoon.net'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    const html = await http.text(`${BASE}/search?q=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 });
    return parseSearch(html);
  },

  async getSeries(url, http) {
    const slug = new URL(url).pathname.split('/')[2];
    if (!slug) throw new Error(`Not a Nuviatoon series URL: ${url}`);
    const seriesUrl = `${BASE}/comics/${slug}`;
    return parseSeries(await http.text(seriesUrl, { cacheMs: 10 * 60_000 }), seriesUrl);
  },

  async getChapterPages(chapter, http) {
    const html = await http.text(chapter.url);
    const id = parseChapterId(html);
    if (!id) throw new Error(`Could not find chapter id on ${chapter.url}`);
    const json = await http.json<{ data?: { pages?: NuviaPage[] } }>(`${BASE}/api/comic-chapters/${id}/content`, {
      headers: { referer: chapter.url },
    });
    const pages = parsePages(json, chapter.url);
    if (pages.length === 0) throw new Error('No pages returned (chapter may be locked)');
    return pages;
  },
};
