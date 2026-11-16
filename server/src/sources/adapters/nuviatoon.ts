import * as cheerio from 'cheerio';
import { extractJsonAfterKey, rscPayload } from '../nextjs.ts';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://nuviatoon.org';

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

/**
 * Nuviatoon's robots.txt disallows /search, so series discovery uses the sitemap instead:
 * one request a day lists every comic. Titles come from the slug ("heart-aching" → "Heart Aching").
 */
export function parseSitemap(xml: string): SourceSeriesHit[] {
  const hits: SourceSeriesHit[] = [];
  for (const m of xml.matchAll(/<loc>\s*(https:\/\/nuviatoon\.org\/comics\/([a-z0-9-]+))\s*<\/loc>/gi)) {
    const slug = m[2]!;
    hits.push({ title: slug.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '), url: m[1]! });
  }
  return hits;
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
  kind: 'scanlation',
  hosts: ['nuviatoon.org', 'nuviatoon.net'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(_title, http) {
    // Return the whole catalogue; Discovery scores titles and keeps the good matches.
    return parseSitemap(await http.text(`${BASE}/sitemap.xml`, { cacheMs: 24 * 60 * 60_000 }));
  },

  async getSeries(url, http) {
    const slug = new URL(url).pathname.split('/')[2];
    if (!slug) throw new Error(`Not a Nuviatoon series URL: ${url}`);
    const seriesUrl = `${BASE}/comics/${slug}`;
    return parseSeries(await http.text(seriesUrl, { cacheMs: 10 * 60_000 }), seriesUrl);
  },

  async getChapterPages(chapter, http) {
    const chapterUrl = `${BASE}${new URL(chapter.url).pathname}`;
    const html = await http.text(chapterUrl);
    const id = parseChapterId(html);
    if (!id) throw new Error(`Could not find chapter id on ${chapterUrl}`);
    const json = await http.json<{ data?: { pages?: NuviaPage[] } }>(`${BASE}/api/comic-chapters/${id}/content`, {
      headers: { referer: chapterUrl },
    });
    const pages = parsePages(json, chapterUrl);
    if (pages.length === 0) throw new Error('No pages returned (chapter may be locked)');
    return pages;
  },
};
