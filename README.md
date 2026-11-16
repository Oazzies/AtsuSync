# AtsuSync

Local helper for uploading to Atsumaru [content requests](https://atsu.moe/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests).

- Lists the content requests that still have Atsumaru's **Upload this** button (see [Upload button rule](#upload-button-rule)). The forum is synced every 15 min, plus a full pass every 3 h so posts tagged Added / Duplicate / Can't add drop off the list. A switch shows the rest.
- On a request, **Find sources** searches the enabled scanlation sites once (with the tracker's alt titles) and shows chapter counts. Nothing is scraped in the background except linked series.
- Check the series on the site yourself, then **Link** it. The chapter list shows what Atsumaru is missing.
- Linked series are re-checked on an interval. New chapters show up under **Tracked** (plus a desktop notification) and wait for you to **Download** or **Skip**.
- Series that already exist on Atsumaru need no content request: on **Requests → Existing series** paste an `atsu.moe/manga/<id>` link, then find sources and link one like any request. Download links open `atsu.moe/upload?manga=<id>`.
- **Nothing is ever uploaded for you.** Download turns a chapter into a ZIP; you add it on atsu.moe/upload, submit it yourself, then press **Mark uploaded**.

## Run

```bash
npm install
npm run build      # builds the Vue app
npm start          # http://localhost:4517
```

For development (hot reload on both sides): `npm run dev`, then open http://localhost:5173.

Settings → paste your atsu.moe `cookie` request header (DevTools → Network → any `/api/` request). It is stored in `data/atsusync.db` only.

## Layout

```
shared/src/types.ts                 DTOs shared by server and UI
server/src/atsu/                    Atsumaru API client, request sync, MangaBaka lookups
server/src/sources/                 Source system: adapter interface, rate-limited HTTP, matching, registry
server/src/sources/adapters/        One file per site (nuviatoon.ts, _template.ts)
server/src/links.ts                 Request ↔ source links and their chapters
server/src/watcher/watcher.ts       New-chapter detection
server/src/upload/pipeline.ts       Download queue (resolve pages → download → ZIP in data/downloads/<series>/)
web/src/views/                      Vue pages
```

## Being a good citizen

- Every request identifies itself as `AtsuSync/<version>`, with no browser impersonation.
- Each site's `robots.txt` is read (cached for a day) and obeyed, including `Crawl-delay`. Nuviatoon disallows `/search`, so its adapter uses the sitemap instead.
- Each adapter has a per-host rate limit; `Retry-After` on 429/503 slows every request to that host.
- Sites behind a bot challenge (Cloudflare "Just a moment…") are not supported. AtsuSync stops instead of trying to get past them.
- Requests to atsu.moe are spaced at least 350 ms apart; the "already on Atsu?" checker does a few requests per 2 minutes.

## Novels

Atsumaru accepts novels as `.epub`, `.pdf`, `.docx`, `.txt` or `.md` on its upload page. Adapters with `medium: 'novel'` implement `getChapterText` instead of `getChapterPages`; the download pipeline fetches the chapter text (and any illustrations), sanitizes it to XHTML paragraphs, and writes `data/downloads/<series>/<chapter>.epub`. Upload it with **Add archive** on atsu.moe/upload like any chapter file.

Novel requests (tagged *Novel*, or with "(Novel)" / "light novel" in the title) only search novel sources, and comic requests never search them. Current novel sources: Wuxiaworld (official; paid/Karma chapters fail at download with a "locked" message), NovelCool, Wuxiaworld.site, Hiraeth Translation, KnoxT. Sites from [everythingmoe](https://everythingmoe.com/section/novel) that were checked and skipped: those behind a Cloudflare challenge (FreeWebNovel, Royal Road, ScribbleHub, NovelFull, Foxaholic, Novelhall), ones whose robots.txt forbids novel pages (NovelPing, WoopRead), and ones whose chapter lists or text only load through client-side APIs or redirects (NovelFire, NovelBuddy, lightnovel.to, MVLEMPYR, Wuxia Dreams, ScrollersPub), NovelDex, NovelsTime, Chikari Novel, Full Novels). Requiem Translations and J-Novel Club need a login to read, 9Kafe is an ebook-download site, and the remaining list entries are machine-translation sites, so none of those were added.

## Source kinds

Each adapter sets `kind`: `scanlation` (the group's own site) or `aggregator` (re-hosts releases, e.g. official Webtoon chapters). The UI groups and filters by kind.

## "Probably done" detection

Open requests are checked in the background (every 12 h, or sooner when new comments appear) for:
1. the series on Atsu via its MangaBaka id (needs the cookie),
2. comments linking `atsu.moe/manga/…` or saying it was added/is being uploaded,
3. Atsu's public search with the title + MangaBaka alt titles. A Novel request only matches novels.

## Adding a source site

1. Copy `server/src/sources/adapters/_template.ts` to `<site>.ts`, set `kind`, and implement `search`, `getSeries`, `getChapterPages`. Check the site's robots.txt first.
2. Add it to `ADAPTERS` in `server/src/sources/registry.ts`.
3. Save a search/series/chapter page under `server/test/fixtures/` and add a parser test like `test/nuviatoon.test.ts`.

All requests go through `SourceHttp`, which applies the adapter's `rateLimit` per host and caches search (1 h) and series (10 min) pages.

## Tests

```bash
npm test            # offline, uses saved fixtures
npm run test:live   # hits nuviatoon.org and atsu.moe once each
```

## Uploading a chapter

1. On a linked series, select chapters and press **Download**. Each becomes `data/downloads/<series>/<chapter>.zip` with pages named `001.jpg`, `002.jpg`…
2. Open **Downloads**, press **Download ZIP**, then **Atsumaru upload page** (it pre-selects the series from the post's MangaBaka link).
3. On atsu.moe use **Add archive**, check the pages, and submit.
4. Back here press **Mark uploaded**. Chapters Atsumaru already lists are detected automatically.

AtsuSync only *reads* from atsu.moe (forum posts, comments, series coverage); `AtsuClient` still contains the draft/page/submit calls but nothing uses them.

## Upload button rule

Atsumaru shows **Upload this** on a content request only when the post has no terminal tag (Added, Can't add, Duplicate) and its text links `mangabaka.org/<type>/<id>` with a type other than `novel`. AtsuSync applies the same rule (`isUploadable` in `server/src/atsu/requests.ts`) to decide which requests to list.

## MangaDex

Only English chapters are used. A series MangaDex knows only in other languages (or whose English chapters are all external links) is hidden from **Find sources** instead of appearing with 0 chapters, and pasting its URL explains why it was refused.
