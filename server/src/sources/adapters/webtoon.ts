import * as cheerio from 'cheerio';
import { BlockedError } from '../../polite.ts';
import type { SourceHttp } from '../http.ts';
import type { PageRef, SourceAdapter, SourceChapter, SourceSeries } from '../types.ts';

// WEBTOON (webtoons.com). Series live at /<lang>/<genre|canvas>/<slug>/list?title_no=<n>, episodes at
// .../<episode-slug>/viewer?title_no=<n>&episode_no=<m>.
//
// Only freely readable episodes are ever touched: anything the list marks as paid / Fast Pass / coin-locked is
// reported as `locked` (the pipeline skips those), and a viewer page that doesn't serve images is an error — we never
// try to get around a paywall. Canvas (creator-uploaded) series are always free.
const BASE = 'https://www.webtoons.com';
const MAX_LIST_PAGES = 120;
const MAX_WALK_STEPS = 400;

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

/** The site-wide episode id from a viewer URL. */
const episodeNoOf = (url: string): number | null => {
  const n = Number(new URL(url, BASE).searchParams.get('episode_no'));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A viewer page links to the previous episode and (on Canvas) embeds the series' whole episode list in
 * `#_bottomEpisodeList`. Both are plain, robots-allowed pages, so they fill the gap the list pages leave.
 */
export function parseViewerNav(html: string): { prev?: string; episodes: { episodeNo: number; url: string; title: string }[] } {
  const $ = cheerio.load(html);
  const prev = $('a._prevEpisode').attr('href');
  const episodes: { episodeNo: number; url: string; title: string }[] = [];
  $('#_bottomEpisodeList li[data-episode-no]').each((_, el) => {
    const href = $(el).find('a').first().attr('href');
    const episodeNo = Number($(el).attr('data-episode-no'));
    if (!href || href === '#' || !Number.isInteger(episodeNo) || episodeNo <= 0) return;
    episodes.push({ episodeNo, url: abs(href), title: $(el).find('.subj').first().text().replace(/\s+/g, ' ').trim() });
  });
  return { prev: prev && prev !== '#' ? abs(prev) : undefined, episodes };
}

/**
 * robots.txt forbids some list pages (its `&page=1` rule also matches page=10..19). Older episodes are then
 * recovered from the oldest known episode's viewer page. Numbering follows the list's own: the offset between
 * `episode_no` and the printed number at the oldest known episode is assumed constant.
 */
async function fillOlder(chapters: Map<number, SourceChapter>, http: SourceHttp) {
  const oldest = [...chapters.values()].filter((c) => c.url).sort((a, b) => a.number - b.number)[0];
  const oldestNo = oldest && episodeNoOf(oldest.url);
  if (!oldest || !oldestNo) return;
  const numberFor = (episodeNo: number) => oldest.number - (oldestNo - episodeNo);
  const add = (episodeNo: number, url: string, title: string) => {
    const number = numberFor(episodeNo);
    if (number <= 0 || chapters.has(number)) return;
    chapters.set(number, { number, label: title || `Episode ${number}`, title: title || undefined, url, locked: false });
  };

  let url: string | undefined = oldest.url;
  const visited = new Set<string>();
  for (let step = 0; url && step < MAX_WALK_STEPS && !visited.has(url); step++) {
    visited.add(url);
    const nav = parseViewerNav(await http.text(url, { cacheMs: 10 * 60_000 }));
    for (const e of nav.episodes) if (e.episodeNo < oldestNo) add(e.episodeNo, e.url, e.title);
    if (nav.episodes.some((e) => e.episodeNo < oldestNo)) {
      // The embedded list covered everything before this episode; nothing left to walk.
      return;
    }
    const prevNo = nav.prev ? episodeNoOf(nav.prev) : null;
    if (!nav.prev || !prevNo) return;
    add(prevNo, nav.prev, '');
    url = nav.prev;
  }
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
      let html: string;
      try {
        html = await http.text(`${base}&page=${page}`, { cacheMs: 10 * 60_000 });
      } catch (e) {
        if (!(e instanceof BlockedError)) throw e;
        await fillOlder(byNumber, http); // robots.txt disallows this list page; use the viewer pages instead
        break;
      }
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
