import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://www.mgeko.cc';

export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/manga\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href, BASE).href;

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const hits: SourceSeriesHit[] = [];
  $('li.novel-item > a[href*="/manga/"]').each((_, el) => {
    const slug = slugFromUrl(abs($(el).attr('href')!));
    if (!slug) return;
    const cover = $(el).find('img').attr('data-src');
    hits.push({
      title: ($(el).attr('title') || $(el).find('.novel-title').text()).trim(),
      url: `${BASE}/manga/${slug}/`,
      cover: cover ? abs(cover) : undefined,
    });
  });
  return hits;
}

/** "…-chapter-12-eng-li" → 12, "…-chapter-12-5-eng-li" → 12.5. */
const chapterNumber = (href: string): number | null => {
  const m = new URL(href, BASE).pathname.match(/-chapter-(\d+)(?:-(\d+))?(?:-[a-z][a-z-]*)?\/?$/);
  return m ? Number(m[2] ? `${m[1]}.${m[2]}` : m[1]) : null;
};

/** "May 25, 2022, 5:23 a.m." → ISO string; undefined when it doesn't parse. */
const parseDate = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const normalized = raw
    .replace(/\ba\.m\./i, 'AM')
    .replace(/\bp\.m\./i, 'PM')
    .replace(/\bnoon\b/i, '12:00 PM')
    .replace(/\bmidnight\b/i, '12:00 AM')
    .replace(/(\d{4}),\s*(\d{1,2})\s*(AM|PM)/i, '$1, $2:00 $3');
  const t = Date.parse(`${normalized} UTC`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/** Works on both the series page (first batch) and the /all-chapters/ page. */
export function parseChapterList(html: string): SourceChapter[] {
  const $ = cheerio.load(html);
  const byNumber = new Map<number, SourceChapter>();
  $('ul.chapter-list li a[href*="/reader/"]').each((_, el) => {
    const href = $(el).attr('href')!;
    const number = chapterNumber(href);
    if (number == null || byNumber.has(number)) return;
    byNumber.set(number, {
      number,
      label: `Chapter ${number}`,
      url: abs(href),
      date: parseDate($(el).find('time').attr('datetime')),
      locked: false,
    });
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters' | 'altTitles'> {
  const $ = cheerio.load(html);
  const desc = $('p.description').first().clone();
  desc.find('br').replaceWith('\n');
  // The first paragraph is boilerplate ("X is a Manga/Manhwa/Manhua in english language…"), the summary follows.
  const paragraphs = desc.text().split(/\n\s*\n|\n/).map((s) => s.trim()).filter(Boolean);
  const description = paragraphs.length > 1 ? paragraphs.slice(1).join('\n') : paragraphs[0];
  const cover = $('meta[property="og:image"]').attr('content');
  return {
    title: $('h1.novel-title').first().text().trim() || $('h1').first().text().trim() || slugFromUrl(url) || url,
    url,
    cover: cover || undefined,
    description: description || undefined,
  };
}

export function parsePages(html: string, referer: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const urls: string[] = [];
  $('img.mgr-page').each((_, el) => {
    const src = $(el).attr('data-src') ?? $(el).attr('src');
    if (src && /^https?:\/\//.test(src) && !seen.has(src)) {
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

export const mgeko: SourceAdapter = {
  id: 'mgeko',
  name: 'MGeko',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['mgeko.cc'],
  rateLimit: { rpm: 30, concurrency: 2 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/search/?search=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a MGeko series URL: ${url}`);
    const seriesUrl = `${BASE}/manga/${slug}/`;
    const first = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    // The series page only lists a recent batch; /all-chapters/ has everything in one page.
    const all = await http.text(`${seriesUrl}all-chapters/`, { cacheMs: 10 * 60_000 }).catch(() => '');
    const byNumber = new Map<number, SourceChapter>();
    for (const c of [...parseChapterList(first), ...parseChapterList(all)]) byNumber.set(c.number, c);
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
