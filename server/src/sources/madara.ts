// Shared parser and adapter factory for WordPress Madara manga sites
// that render chapter lists and reader images server-side.
import * as cheerio from 'cheerio';
import type { SourceHttp } from './http.ts';
import { chapterXhtml } from './novel.ts';
import type { NovelChapter, PageRef, SourceAdapter, SourceChapter, SourceKind, SourceMedium, SourceSeries, SourceSeriesHit } from './types.ts';

export interface MadaraConfig {
  id: string;
  name: string;
  baseUrl: string;
  kind: SourceKind;
  /** 'novel' sites serve text at /novel/<slug>/ and list chapters through ajax/chapters/. */
  medium?: SourceMedium;
  hosts: string[];
  rateLimit?: { rpm: number; concurrency: number };
}

/** "/manga/some-slug/..." → "some-slug". */
export function madaraSlugFromUrl(url: string): string | null {
  try {
    return new URL(url).pathname.match(/^\/(?:manga|novel)\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseMadaraSearch(html: string, baseUrl: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const hits: SourceSeriesHit[] = [];
  $('.c-tabs-item__content').each((_, el) => {
    const link = $(el).find('.post-title a').first().length ? $(el).find('.post-title a').first() : $(el).find('.tab-thumb a').first();
    const href = link.attr('href');
    if (!href) return;
    const url = new URL(href, baseUrl).href;
    if (seen.has(url)) return;
    const title = link.text().trim() || link.attr('title')?.trim() || '';
    if (!title) return;
    seen.add(url);
    const img = $(el).find('.tab-thumb img').first();
    const cover = (img.attr('data-src') ?? img.attr('src'))?.trim() || undefined;
    hits.push({ title, url, cover });
  });
  return hits;
}

const chapterNumber = (label: string, href: string): number | null => {
  const fromHref = href.match(/chapter[-/](\d+(?:[.-]\d+)?)/i)?.[1]?.replace('-', '.');
  if (fromHref) return Number(fromHref);
  const fromLabel = label.match(/(?:chapter|ch\.?)\s*#?(\d+(?:\.\d+)?)/i)?.[1];
  if (fromLabel) return Number(fromLabel);
  return null;
};

export function parseMadaraSeries(html: string, url: string, baseUrl: string): SourceSeries {
  const $ = cheerio.load(html);
  const title = $('h1').first().text().trim() || madaraSlugFromUrl(url) || url;
  const cover = ($('meta[property="og:image"]').attr('content') ?? $('.summary_image img').first().attr('data-src') ?? $('.summary_image img').first().attr('src'))?.trim() || undefined;
  const description = $('.summary__content p, .description-summary .summary__content').first().text().trim() || undefined;

  let altTitles: string[] = [];
  $('.post-content_item').each((_, el) => {
    const heading = $(el).find('.summary-heading').text().trim().toLowerCase();
    if (heading.includes('alternative')) {
      altTitles = $(el)
        .find('.summary-content')
        .text()
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter((s) => s && s !== title);
    }
  });

  const byNumber = new Map<number, SourceChapter>();
  $('li.wp-manga-chapter a').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#')) return;
    const label = $(el).text().trim();
    const number = chapterNumber(label, href);
    if (number == null || !Number.isFinite(number) || byNumber.has(number)) return;
    const locked = $(el).closest('li').hasClass('premium-block') || $(el).find('.fa-lock').length > 0;
    byNumber.set(number, {
      number,
      label: label || `Chapter ${number}`,
      url: new URL(href, baseUrl).href,
      locked,
    });
  });

  return {
    title,
    url,
    altTitles,
    cover,
    description,
    chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseMadaraPages(html: string, referer: string, baseUrl: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('.reading-content img').each((_, el) => {
    const raw = ($(el).attr('data-src') ?? $(el).attr('src'))?.trim();
    if (!raw || raw.startsWith('data:')) return;
    const abs = new URL(raw, baseUrl).href;
    if (/^https?:\/\//.test(abs) && !seen.has(abs)) {
      seen.add(abs);
      urls.push(abs);
    }
  });
  return urls.map((u, i) => {
    const ext = new URL(u).pathname.split('.').pop()?.toLowerCase() || 'jpg';
    return {
      url: u,
      name: `${String(i + 1).padStart(3, '0')}.${ext}`,
      headers: { referer },
    };
  });
}

/** The reader text of a Madara novel chapter, as XHTML paragraphs. */
export function parseMadaraText(html: string, fallbackTitle: string): NovelChapter {
  const $ = cheerio.load(html);
  const container = $('.reading-content .text-left').first().length ? $('.reading-content .text-left').first() : $('.reading-content').first();
  const heading = ($('#chapter-heading').first().text() || $('.entry-title').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim();
  return {
    title: heading || fallbackTitle,
    html: chapterXhtml($, container),
  };
}

export function createMadaraAdapter(cfg: MadaraConfig): SourceAdapter {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const novel = cfg.medium === 'novel';
  return {
    id: cfg.id,
    name: cfg.name,
    baseUrl: base,
    kind: cfg.kind,
    medium: cfg.medium,
    hosts: cfg.hosts,
    rateLimit: cfg.rateLimit ?? { rpm: 20, concurrency: 1 },

    async search(title, http) {
      const url = `${base}/?s=${encodeURIComponent(title)}&post_type=wp-manga`;
      return parseMadaraSearch(await http.text(url, { cacheMs: 60 * 60_000 }), base);
    },

    async getSeries(url, http) {
      const slug = madaraSlugFromUrl(url);
      if (!slug) throw new Error(`Not a ${cfg.name} series URL: ${url}`);
      const html = await http.text(url, { cacheMs: 10 * 60_000 });
      if (!novel) return parseMadaraSeries(html, url, base);
      // Novel pages only embed the latest few chapters; the full list is a POST to ajax/chapters/.
      const seriesUrl = url.endsWith('/') ? url : `${url}/`;
      const list = await http.text(`${seriesUrl}ajax/chapters/`, {
        method: 'POST',
        headers: { 'x-requested-with': 'XMLHttpRequest', referer: url },
        cacheMs: 10 * 60_000,
      });
      return parseMadaraSeries(`${html}<ul>${list}</ul>`, url, base);
    },

    ...(novel
      ? {
          async getChapterText(chapter: SourceChapter, http: SourceHttp) {
            return parseMadaraText(await http.text(chapter.url), chapter.label);
          },
        }
      : {}),

    async getChapterPages(chapter, http) {
      return parseMadaraPages(await http.text(chapter.url), chapter.url, base);
    },
  };
}
