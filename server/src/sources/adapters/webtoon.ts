import * as cheerio from 'cheerio';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries } from '../types.ts';

// WEBTOON (webtoons.com). Series live at /<lang>/<genre|canvas>/<slug>/list?title_no=<n>, episodes at
// .../<episode-slug>/viewer?title_no=<n>&episode_no=<m>.
//
// Only freely readable episodes are ever touched: anything the list marks as paid / Fast Pass / coin-locked is
// reported as `locked` (the pipeline skips those), and a viewer page that doesn't serve images is an error — we never
// try to get around a paywall. Canvas (creator-uploaded) series are always free.
const BASE = 'https://www.webtoons.com';
const MAX_LIST_PAGES = 120;

interface SeriesRef {
  lang: string;
  genre: string;
  slug: string;
  titleNo: string;
}

export const parseSeriesUrl = (url: string): SeriesRef | null => {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/([a-z]{2}(?:-[a-z]{2,4})?)\/([^/]+)\/([^/]+)\/(?:list|[^/]+\/viewer)\/?$/i);
    const titleNo = u.searchParams.get('title_no');
    if (!m || !titleNo || !/^\d+$/.test(titleNo)) return null;
    return { lang: m[1]!, genre: m[2]!, slug: m[3]!, titleNo };
  } catch {
    return null;
  }
};

const seriesUrl = (r: SeriesRef) => `${BASE}/${r.lang}/${r.genre}/${r.slug}/list?title_no=${r.titleNo}`;
const abs = (href: string) => new URL(href.trim(), BASE).href;

export function parseSeries(html: string, url: string): Omit<SourceSeries, 'chapters'> {
  const $ = cheerio.load(html);
  const title =
    $('h1.subj').first().text().replace(/\s+/g, ' ').trim() ||
    $('._challengeTitle').first().text().replace(/\s+/g, ' ').trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    parseSeriesUrl(url)?.slug ||
    url;
  const description = $('meta[property="og:description"]').attr('content')?.trim();
  return {
    title,
    url,
    cover: $('meta[property="og:image"]').attr('content') || undefined,
    description: description || undefined,
    altTitles: [],
  };
}

/** Class names or visible labels that mark an episode as paid / time-gated. */
const LOCK_CLASS = /(?:^|[_-])(?:lock|locked|fastpass|dailypass|coin|paid|rental|premium)(?:$|[_-])/i;
const LOCK_TEXT = /fast\s*pass|daily\s*pass|\bcoins?\b|unlock|wait\s*for\s*free/i;

const isLocked = ($: cheerio.CheerioAPI, li: cheerio.Cheerio<any>, href: string | undefined) => {
  if (!href || href === '#' || !/\/viewer\b/.test(href)) return true;
  let locked = false;
  li.find('[class]').each((_, el) => {
    if (($(el).attr('class') ?? '').split(/\s+/).some((c) => LOCK_CLASS.test(c))) locked = true;
  });
  return locked || LOCK_TEXT.test(li.find('a.detail_list_link').text());
};

/** "May 26, 2026" → ISO date; undefined when it doesn't parse. */
const parseDate = (raw: string): string | undefined => {
  const t = Date.parse(`${raw.replace(/\s+/g, ' ').trim()} UTC`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/**
 * One page of the episode list (newest first). Originals print their own "#652" counter in `.tx`; Canvas
 * episodes don't, so the site-wide episode_no stands in as the chapter number.
 */
export function parseChapterList(html: string): SourceChapter[] {
  const $ = cheerio.load(html);
  const chapters: SourceChapter[] = [];
  $('li._episodeItem').each((_, el) => {
    const li = $(el);
    const href = li.find('a.detail_list_link').attr('href');
    const printed = li.find('.tx').first().text().match(/#\s*(\d+)/)?.[1];
    const number = printed ? Number(printed) : Number(li.attr('data-episode-no'));
    if (!Number.isFinite(number) || number <= 0) return;
    const title = li.find('.subj').first().text().replace(/\s+/g, ' ').trim();
    chapters.push({
      number,
      label: title || `Episode ${number}`,
      title: title || undefined,
      url: href && href !== '#' ? abs(href) : '',
      date: parseDate(li.find('.date').first().text()),
      locked: isLocked($, li, href),
    });
  });
  return chapters;
}

/** Viewer images are lazy-loaded: the real URL sits in `data-url` on `img._images`. */
export function parsePages(html: string): PageRef[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const pages: PageRef[] = [];
  $('#_imageList img._images, .viewer_img img._images').each((_, el) => {
    const src = ($(el).attr('data-url') ?? '').trim();
    if (!/^https?:\/\//.test(src) || seen.has(src)) return;
    seen.add(src);
    const width = Number($(el).attr('width'));
    const height = Number($(el).attr('height'));
    pages.push({
      url: src,
      name: `${String(pages.length + 1).padStart(3, '0')}.${new URL(src).pathname.split('.').pop() ?? 'jpg'}`,
      // The image CDN rejects requests without a webtoons.com referer.
      headers: { referer: `${BASE}/` },
      width: width > 0 ? width : undefined,
      height: height > 0 ? Math.round(height) : undefined,
    });
  });
  return pages;
}

export const webtoon: SourceAdapter = {
  id: 'webtoon',
  name: 'WEBTOON',
  baseUrl: BASE,
  kind: 'official',
  hosts: ['webtoons.com'],
  rateLimit: { rpm: 20, concurrency: 1 },

  // No search: robots.txt disallows /*/search, so series are linked by pasting their URL.

  async getSeries(url, http): Promise<SourceSeries> {
    const ref = parseSeriesUrl(url);
    if (!ref) throw new Error(`Not a WEBTOON series URL: ${url}`);
    const base = seriesUrl(ref);
    // robots.txt forbids `&page=1` but allows the bare list URL, so page 1 is fetched without a page param.
    const first = await http.text(base, { cacheMs: 10 * 60_000 });
    const byNumber = new Map<number, SourceChapter>();
    const add = (list: SourceChapter[]) => {
      let added = 0;
      for (const c of list) {
        if (byNumber.has(c.number)) continue;
        byNumber.set(c.number, c);
        added++;
      }
      return added;
    };
    add(parseChapterList(first));
    for (let page = 2; page <= MAX_LIST_PAGES; page++) {
      const html = await http.text(`${base}&page=${page}`, { cacheMs: 10 * 60_000 });
      if (add(parseChapterList(html)) === 0) break;
    }
    const chapters = [...byNumber.values()].sort((a, b) => a.number - b.number);
    return {
      ...parseSeries(first, base),
      chapters,
      emptyReason: chapters.length > 0 && chapters.every((c) => c.locked) ? 'every episode is paid or locked' : undefined,
    };
  },

  async getChapterPages(chapter, http) {
    if (chapter.locked || !chapter.url) throw new Error(`"${chapter.label}" is a paid/locked WEBTOON episode; skipping`);
    const pages = parsePages(await http.text(chapter.url));
    if (pages.length === 0) throw new Error(`No readable images on ${chapter.url} (paid, age-gated or removed episode?)`);
    return pages;
  },
};
