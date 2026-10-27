import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries, SourceSeriesHit } from '../types.ts';

// MangaReader (ThemeSia) WordPress theme: series live at /manga/<slug>/, chapters at /<slug>-chapter-<n>/.
const BASE = 'https://kingofshojo.com';

export const slugFromUrl = (url: string): string | null => {
  try {
    return new URL(url).pathname.match(/^\/manga\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
};

const abs = (href: string) => new URL(href.trim(), BASE).href;
const splitAlts = (s: string) => s.split(/\s*[/;]\s*/).map((x) => x.trim()).filter(Boolean);

export function parseSearch(html: string): SourceSeriesHit[] {
  const $ = cheerio.load(html);
  const hits: SourceSeriesHit[] = [];
  $('.listupd .bsx > a').each((_, el) => {
    const slug = slugFromUrl($(el).attr('href') ?? '');
    if (!slug) return;
    const cover = $(el).find('img').first().attr('src');
    hits.push({
      title: $(el).find('.tt').text().trim() || ($(el).attr('title') ?? '').trim() || slug,
      url: `${BASE}/manga/${slug}/`,
      // The wp.com image proxy resizes via the query string; drop it for the original.
      cover: cover?.replace(/\?.*$/, ''),
    });
  });
  return hits;
}

/** "…-chapter-12/" → 12, "…-chapter-12-5/" → 12.5. */
const chapterNumber = (href: string): number | null => {
  const m = new URL(href, BASE).pathname.match(/-chapter-(\d+)(?:-(\d+))?\/?$/);
  return m ? Number(m[2] ? `${m[1]}.${m[2]}` : m[1]) : null;
};

/** "July 11, 2025" → ISO date; undefined when it doesn't parse. */
const parseDate = (raw: string): string | undefined => {
  const t = Date.parse(`${raw.trim()} UTC`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/** The series page lists every chapter, newest first. */
export function parseChapterList(html: string): SourceChapter[] {
  const $ = cheerio.load(html);
  const byNumber = new Map<number, SourceChapter>();
  $('#chapterlist li').each((_, el) => {
    const href = $(el).find('a').first().attr('href');
    const number = href ? (chapterNumber(href) ?? (Number($(el).attr('data-num')) || null)) : null;
    if (!href || number == null || byNumber.has(number)) return;
    byNumber.set(number, {
      number,
      label: `Chapter ${number}`,
      url: abs(href),
      date: parseDate($(el).find('.chapterdate').text()),
      locked: false,
    });
  });
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters'> {
  const $ = cheerio.load(html);
  const description = $('.entry-content[itemprop="description"] p')
    .map((_, p) => $(p).text().trim())
    .get()
    .filter(Boolean)
    // The first paragraph starts with "Read manhwa <title> / <alt titles>" boilerplate.
    .map((t) => t.replace(/^Read (?:manhwa|manga|manhua)\b[^\n]*\n/i, '').trim())
    .filter(Boolean)
    .join('\n');
  const alt = $('.infotable td:contains("Alternative")').first().next().text().trim();
  return {
    title: $('h1.entry-title').first().text().trim() || slugFromUrl(url) || url,
    url,
    cover: $('meta[property="og:image"]').attr('content') || undefined,
    description: description || undefined,
    altTitles: alt ? splitAlts(alt) : [],
  };
}

/** Reader images come from the ts_reader.run({...}) JSON; falls back to the #readerarea <img>s. */
export function parsePages(html: string, referer: string): PageRef[] {
  let urls: string[] = [];
  const m = html.match(/ts_reader\.run\((\{.*?\})\);/s);
  if (m) {
    try {
      const data = JSON.parse(m[1]!) as { sources?: { images?: string[] }[] };
      urls = data.sources?.[0]?.images ?? [];
    } catch {
      /* fall through to the DOM */
    }
  }
  if (urls.length === 0) {
    const $ = cheerio.load(html);
    $('#readerarea img').each((_, el) => {
      const src = ($(el).attr('data-src') ?? $(el).attr('src') ?? '').trim();
      if (/^https?:\/\//.test(src) && !src.endsWith('readerarea.svg')) urls.push(src);
    });
  }
  const seen = new Set<string>();
  const unique = urls.filter((u) => /^https?:\/\//.test(u) && !seen.has(u) && seen.add(u));
  return unique.map((u, i) => ({
    url: u,
    name: `${String(i + 1).padStart(3, '0')}.${new URL(u).pathname.split('.').pop() ?? 'jpg'}`,
    headers: { referer },
  }));
}

export const kingofshojo: SourceAdapter = {
  id: 'kingofshojo',
  name: 'Kingofshojo',
  baseUrl: BASE,
  kind: 'aggregator',
  hosts: ['kingofshojo.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  async search(title, http) {
    return parseSearch(await http.text(`${BASE}/?s=${encodeURIComponent(title)}`, { cacheMs: 60 * 60_000 }));
  },

  async getSeries(url, http): Promise<SourceSeries> {
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Not a Kingofshojo series URL: ${url}`);
    const seriesUrl = `${BASE}/manga/${slug}/`;
    const html = await http.text(seriesUrl, { cacheMs: 10 * 60_000 });
    return { ...parseSeries(html, seriesUrl), chapters: parseChapterList(html) };
  },

  async getChapterPages(chapter, http) {
    const pages = parsePages(await http.text(chapter.url), chapter.url);
    if (pages.length === 0) throw new Error(`No images found on ${chapter.url}`);
    return pages;
  },
};
