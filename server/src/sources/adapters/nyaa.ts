// Nyaa (nyaa.si), "Literature - English-translated" (category 3_1): scanlated manga/manhwa/manhua chapters
// and volumes, plus light novel volumes, shared as torrents. Searching uses the site's RSS feed (robots.txt
// only blocks /download, which we never touch: torrents are fetched by info hash through the swarm).
//
// Releases are named loosely ("One Piece 1197", "Series v01-03 (2026) (Digital) (Group)", "Series c001-050"),
// so titles are parsed into series + chapter/volume numbers and grouped. One torrent can be a pack of many
// chapters; each becomes its own chapter whose URL carries the torrent's info hash and chapter number in the
// fragment, so downloading chapter N only fetches the files for N.
import * as cheerio from 'cheerio';
import { normalizeTitle } from '../match.ts';
import { buildChapter, pickChapterFiles } from '../torrentpack.ts';
import type { FetchContext, FetchedChapter, SourceAdapter, SourceChapter, SourceChapterAlt, SourceMedium, SourceSeries, SourceSeriesHit } from '../types.ts';

const BASE = 'https://nyaa.si';
const CATEGORY = '3_1';
const PAGE_SIZE = 75;
const MAX_PAGES = 6;
const MAX_PACK = 3000;

export interface NyaaItem {
  id: string;
  title: string;
  infoHash: string;
  seeders: number;
  leechers: number;
  size: string;
  date: string;
  trusted: boolean;
}

export function parseRss(xml: string): NyaaItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('item')
    .map((_, el) => {
      const item = $(el);
      const guid = item.find('guid').text();
      const id = /\/view\/(\d+)/.exec(guid)?.[1] ?? '';
      const infoHash = item.find('nyaa\\:infoHash').text().trim().toLowerCase();
      return {
        id,
        title: item.find('title').first().text().replace(/\s+/g, ' ').trim(),
        infoHash,
        seeders: Number(item.find('nyaa\\:seeders').text()) || 0,
        leechers: Number(item.find('nyaa\\:leechers').text()) || 0,
        size: item.find('nyaa\\:size').text().trim(),
        date: item.find('pubDate').text().trim(),
        trusted: /yes/i.test(item.find('nyaa\\:trusted').text()),
      };
    })
    .get()
    .filter((i) => i.id && /^[0-9a-f]{40}$/.test(i.infoHash) && i.title);
}

export interface Release {
  /** Series name with numbers and tags stripped. */
  series: string;
  kind: 'chapter' | 'volume' | 'none';
  from: number;
  to: number;
  /** Publisher-style novel release (epub), as opposed to a scanlated comic. */
  novel: boolean;
  audiobook: boolean;
  group: string | null;
}

const NUM = String.raw`0*(\d+(?:\.\d+)?)`;
const RANGE_SEP = String.raw`\s*[-–~]\s*`;
const CHAPTER_RE = new RegExp(String.raw`(?:^|[\s_-])(?:c|ch|chap(?:ter)?s?)\.?\s*${NUM}(?:${RANGE_SEP}(?:c|ch)?\.?\s*${NUM})?(?=\s|$|,)`, 'i');
const VOLUME_RE = new RegExp(String.raw`(?:^|[\s_-])v(?:ol(?:ume)?s?)?\.?\s*${NUM}(?:${RANGE_SEP}(?:v(?:ol(?:ume)?)?\.?\s*)?${NUM})?(?=\s|$|,)`, 'i');
const TRAILING_RE = new RegExp(String.raw`^(.*\S)\s+#?${NUM}(?:${RANGE_SEP}${NUM})?$`);
const NOVEL_WORDS = /\b(?:light novels?|web novels?|novels?|epub|kobo|ln)\b/i;
const NOVEL_PUBLISHER = /\[(?:Yen Press|Yen On|Seven Seas|J-Novel Club|Airship|Cross Infinite World|Sol Press|Hanashi Media|One Peace Books|Kodansha|Stick|Oak|LuCaZ|Kobo)\]/i;
const COMIC_MARK = /\((?:Digital|Scanlation)\)/i;
const NOT_A_GROUP = /^(?:\d{4}(?:-\d{4})?|digital|scanlation|f|ebook|epub|completed?|ongoing|raw|official)$/i;

export function parseRelease(title: string): Release {
  const tags = [...title.matchAll(/[([]([^)\]]*)[)\]]/g)].map((m) => m[1]!.trim());
  const group = [...tags].reverse().find((t) => t && !NOT_A_GROUP.test(t)) ?? null;
  const core = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const audiobook = /audiobook|\[audio/i.test(title);
  const novel = !COMIC_MARK.test(title) && (NOVEL_WORDS.test(title) || NOVEL_PUBLISHER.test(title));
  const base = { novel, audiobook, group };
  const clean = (s: string) => s.replace(/[\s\-–:,~]+$/, '').trim();
  const range = (a: string, b: string | undefined) => {
    const from = Number(a);
    const to = b === undefined ? from : Number(b);
    return { from: Math.min(from, to), to: Math.max(from, to) };
  };

  const ch = CHAPTER_RE.exec(core);
  if (ch) return { ...base, series: clean(core.slice(0, ch.index)), kind: 'chapter', ...range(ch[1]!, ch[2]) };
  const vol = VOLUME_RE.exec(core);
  if (vol) return { ...base, series: clean(core.slice(0, vol.index)), kind: 'volume', ...range(vol[1]!, vol[2]) };
  const tr = TRAILING_RE.exec(core);
  if (tr) {
    const r = range(tr[2]!, tr[3]);
    // A lone 4-digit number in the years' range is a year, not chapter 2024.
    const yearish = r.from === r.to && r.from >= 1950 && r.from <= 2035 && Number.isInteger(r.from);
    if (!yearish) return { ...base, series: clean(tr[1]!), kind: 'chapter', ...r };
  }
  return { ...base, series: clean(core), kind: 'none', from: 0, to: 0 };
}

const fmt = (n: number) => String(n);

/** Chapter URL for one number of a release; the fragment tells fetchChapter which torrent and files. */
export function releaseUrl(item: NyaaItem, chapter: number | null): string {
  const frag = new URLSearchParams({ ih: item.infoHash, dn: item.title });
  if (chapter !== null) frag.set('ch', fmt(chapter));
  return `${BASE}/view/${item.id}#${frag}`;
}

export function parseChapterUrl(url: string): { infoHash: string; name: string; chapter: number | null } {
  const frag = new URLSearchParams(new URL(url).hash.slice(1));
  const infoHash = frag.get('ih') ?? '';
  if (!/^[0-9a-f]{40}$/i.test(infoHash)) throw new Error('This chapter has no torrent attached; refresh the series');
  const ch = frag.get('ch');
  return { infoHash: infoHash.toLowerCase(), name: frag.get('dn') ?? '', chapter: ch === null ? null : Number(ch) };
}

interface Candidate {
  item: NyaaItem;
  release: Release;
  /** Part of a multi-chapter pack. */
  pack: boolean;
}

/**
 * Chapters of one series from its releases. Comics use chapter releases; novels use volumes (and chapters if
 * that is all there is). Several torrents for one number: the best-seeded single release wins and the rest are
 * kept as alternatives.
 */
export function buildChapters(items: NyaaItem[], seriesKey: string, medium: SourceMedium): { chapters: SourceChapter[]; emptyReason?: string } {
  const byNumber = new Map<number, Candidate[]>();
  let volumes = 0;
  for (const item of items) {
    const release = parseRelease(item.title);
    if (release.audiobook || release.kind === 'none' || normalizeTitle(release.series) !== seriesKey) continue;
    if (release.novel !== (medium === 'novel')) continue;
    if (release.kind === 'volume' && medium === 'comic') {
      volumes++;
      continue;
    }
    const span = release.to - release.from;
    const pack = span > 0;
    if (span > MAX_PACK) continue;
    if (!pack) {
      add(byNumber, release.from, { item, release, pack });
    } else if (Number.isInteger(release.from) && Number.isInteger(release.to)) {
      for (let n = release.from; n <= release.to; n++) add(byNumber, n, { item, release, pack });
    }
  }

  const chapters: SourceChapter[] = [...byNumber.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, cands]) => {
      const ranked = [...cands].sort((a, b) => Number(a.pack) - Number(b.pack) || b.item.seeders - a.item.seeders || Number(b.item.trusted) - Number(a.item.trusted));
      const best = ranked[0]!;
      const alternatives: SourceChapterAlt[] = ranked.slice(1).map((c) => ({
        group: c.release.group ?? 'Unknown',
        url: releaseUrl(c.item, c.pack ? number : null),
        label: c.item.title,
        date: c.item.date,
      }));
      return {
        number,
        label: `${medium === 'novel' ? 'Volume' : 'Chapter'} ${fmt(number)}`,
        url: releaseUrl(best.item, best.pack ? number : null),
        title: best.item.title,
        date: best.item.date,
        locked: false,
        ...(best.release.group ? { group: best.release.group } : {}),
        ...(alternatives.length ? { alternatives } : {}),
      };
    });

  if (chapters.length) return { chapters };
  return {
    chapters,
    emptyReason: volumes ? `only volume releases (${volumes}) on Nyaa, no per-chapter torrents` : 'no matching releases',
  };
}

const add = (m: Map<number, Candidate[]>, n: number, c: Candidate) => {
  const list = m.get(n);
  if (list) list.push(c);
  else m.set(n, [c]);
};

const seriesUrl = (query: string) => `${BASE}/?c=${CATEGORY}&q=${encodeURIComponent(query)}`;

const rssUrl = (query: string, page: number) =>
  `${BASE}/?page=rss&c=${CATEGORY}&q=${encodeURIComponent(query)}${page > 1 ? `&p=${page}` : ''}`;

/** Hits grouped by series for a search result page. */
export function groupSeries(items: NyaaItem[], medium: SourceMedium): SourceSeriesHit[] {
  const groups = new Map<string, { names: Map<string, number>; count: number }>();
  for (const item of items) {
    const r = parseRelease(item.title);
    if (r.audiobook || r.kind === 'none' || !r.series || r.novel !== (medium === 'novel')) continue;
    if (r.kind === 'volume' && medium === 'comic') continue;
    const key = normalizeTitle(r.series);
    if (!key) continue;
    const g = groups.get(key) ?? { names: new Map(), count: 0 };
    g.names.set(r.series, (g.names.get(r.series) ?? 0) + 1);
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => {
      const title = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      return { title, url: seriesUrl(title) };
    });
}

function makeNyaa(opts: { id: string; name: string; medium: SourceMedium }): SourceAdapter {
  const { medium } = opts;
  return {
    id: opts.id,
    name: opts.name,
    baseUrl: BASE,
    kind: 'torrent',
    medium,
    hosts: ['nyaa.si'],
    // robots.txt asks for a 5 s crawl delay, which SourceHttp raises the limiter to on its own.
    rateLimit: { rpm: 12, concurrency: 1 },

    async search(title, http) {
      const xml = await http.text(rssUrl(title, 1), { cacheMs: 60 * 60_000 });
      return groupSeries(parseRss(xml), medium).slice(0, 8);
    },

    async getSeries(url, http): Promise<SourceSeries> {
      const u = new URL(url);
      let query = u.searchParams.get('q')?.trim() ?? '';
      if (!query && u.pathname.startsWith('/view/')) {
        // A pasted torrent page: take the series name from its title.
        const html = await http.text(`${BASE}${u.pathname}`, { cacheMs: 10 * 60_000 });
        const t = /<title>([^<]*?)\s*::\s*Nyaa/i.exec(html)?.[1] ?? '';
        const parsed = parseRelease(cheerio.load(`<p>${t}</p>`)('p').text());
        if (parsed.kind !== 'none') query = parsed.series;
      }
      if (!query) throw new Error('Not a Nyaa series or torrent URL');

      const items: NyaaItem[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = parseRss(await http.text(rssUrl(query, page), { cacheMs: 10 * 60_000 }));
        items.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      const { chapters, emptyReason } = buildChapters(items, normalizeTitle(query), medium);
      return { title: query, url: seriesUrl(query), altTitles: [], chapters, ...(emptyReason ? { emptyReason } : {}) };
    },

    async getChapterPages() {
      throw new Error('Nyaa chapters are fetched as torrents, not page URLs');
    },

    async fetchChapter(chapter: SourceChapter, ctx: FetchContext): Promise<FetchedChapter> {
      const { infoHash, name, chapter: ch } = parseChapterUrl(chapter.url);
      const files = await ctx.torrents.download({ infoHash, name }, (all) => pickChapterFiles(all, ch), {
        progress: ctx.progress,
        log: ctx.log,
        checkCancel: ctx.checkCancel,
      });
      return buildChapter(files);
    },
  };
}

export const nyaa = makeNyaa({ id: 'nyaa', name: 'Nyaa (manga / manhwa / manhua)', medium: 'comic' });
export const nyaaNovel = makeNyaa({ id: 'nyaa-novel', name: 'Nyaa (novels)', medium: 'novel' });
