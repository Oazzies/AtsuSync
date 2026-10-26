import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://mgread.io';
const MAX_LIST_PAGES = 100;
const IMAGE_HOST = /^https:\/\/mg\.mgread\.io\//;

interface MgSearchItem {
  title: string;
  url: string;
  post_type?: string;
  thumb?: string;
}

export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/manga\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const text = (html: string) => cheerio.load(`<p>${html}</p>`)('p').text().trim();

/** Search API returns titles with <mark> highlights and HTML entities. */
export function parseSearch(items: MgSearchItem[]): SourceSeriesHit[] {
  return items
    .filter((i) => (i.post_type ?? 'manga') === 'manga' && slugFromUrl(i.url))
    .map((i) => ({ title: text(i.title), url: `${BASE}/manga/${slugFromUrl(i.url)}/`, cover: i.thumb?.replace(/-150x150(?=\.\w+$)/, '') }));
}

/** "chapter-12" → 12, "chapter-12-5" → 12.5. */
const chapterNumber = (href: string): number | null => {
  const m = new URL(href, BASE).pathname.match(/\/chapter-(\d+)(?:-(\d+))?\/?$/);
  return m ? Number(m[2] ? `${m[1]}.${m[2]}` : m[1]) : null;
};

/** One page of the (24 per page) chapter list, plus the highest page number linked from it. */
export function parseChapterList(html: string): { chapters: SourceChapter[]; lastPage: number } {
  const $ = cheerio.load(html);
  const chapters: SourceChapter[] = [];
  $('.chapter-item a[href*="/chapter-"]').each((_, el) => {
    const href = $(el).attr('href')!;
    const number = chapterNumber(href);
    if (number == null) return;
    chapters.push({
      number,
      label: `Chapter ${number}`,
      url: new URL(href, BASE).href,
      date: $(el).find('time').attr('datetime') || undefined,
      locked: false,
    });
  });
  let lastPage = 1;
  $('ul.uk-pagination a[href*="/chapter/page/"]').each((_, el) => {
    const n = Number($(el).attr('href')!.match(/\/chapter\/page\/(\d+)/)?.[1]);
    if (n > lastPage) lastPage = n;
  });
  return { chapters, lastPage };
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters' | 'altTitles'> {
  const $ = cheerio.load(html);
  let ld: Record<string, any> = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (JSON.stringify(data['@type'] ?? '').includes('ComicSeries')) ld = data;
    } catch {
      /* ignore */
    }
  });
  const description = typeof ld.description === 'string' ? text(ld.description).replace(/\s*\[…\]$/, '…') : undefined;
  return {
    title: $('h1').first().text().trim() || ld.name || slugFromUrl(url) || url,
    url,
    cover: typeof ld.image === 'string' ? ld.image : ld.image?.url,
    description,
  };
}

/** Reader images; lazy ones keep the real URL in data-original-src. */
export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('img').each((_, el) => {
    const src = $(el).attr('data-original-src') ?? $(el).attr('src');
    if (src && IMAGE_HOST.test(src) && !seen.has(src)) {
      seen.add(src);
      urls.push(src);
    }
  });
  return urls.map((u, i) => ({
    url: u,
    name: `${String(i + 1).padStart(3, '0')}.${new URL(u).pathname.split('.').pop() ?? 'jpg'}`,
    headers: { referer },
  }));
}

export const mgread: SourceAdapter = {
  id: 'mgread',
  name: 'Mgread',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mgread.io'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    const items = await http.json<MgSearchItem[]>(`${BASE}/wp-json/initlise/v1/search?term=${encodeURIComponent(title)}`, {
      cacheMs: 60 * 60_000,
    });
    return parseSearch(Array.isArray(items) ? items : []);
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a Mgread series URL: ${url}`);
    const seriesUrl = `${BASE}/manga/${slug}/`;
    const first = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    const list = parseChapterList(first);
    const byNumber = new Map(list.chapters.map((c) => [c.number, c]));
    for (let page = 2; page <= Math.min(list.lastPage, MAX_LIST_PAGES); page++) {
      const html = await http.text(`${BASE}/manga/${slug}/chapter/page/${page}/`, { cacheMs: 10 * 60_000 });
      const next = parseChapterList(html);
      for (const c of next.chapters) byNumber.set(c.number, c);
      if (next.lastPage > list.lastPage) list.lastPage = next.lastPage;
    }
    return {
      ...parseSeries(first, seriesUrl),
      altTitles: [],
      chapters: [...byNumber.values()].sort((a, b) => a.number - b.number),
    };
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
