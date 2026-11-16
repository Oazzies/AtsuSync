# AtsuSync

Local helper + browser extension for uploading to Atsumaru [content requests](https://atsu.moe/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests).

- **In-page dock & side panel on `atsu.moe`**: browse open content requests (filtered by Atsumaru's **Upload this** rule), track linked series, manage downloads, and auto-attach chapter archives on `atsu.moe/upload`.
- **Source discovery**: on a request or series, **Find sources** searches enabled sites once (using MangaBaka alt titles) and ranks matches with cover previews and chapter counts. Supports built-in adapters, **Suwayomi / Keiyoushi** (manga), **LNReader** & **LNCrawl** (novels), and **Nyaa** (torrents).
- **Watched series & notifications**: linked series are re-checked on an interval; new or unlocked chapters show up under **Tracked** with desktop notifications.
- **Existing series**: paste any `atsu.moe/manga/<id>` link to track and download missing chapters without a content request.
- **Nothing is ever uploaded for you**: Download turns a chapter into a `.zip` or `.epub` (and auto-attaches it on `atsu.moe/upload`), then you review and submit it yourself.

## Requirements

- **Node.js >= 22.5** (22 LTS or 24 LTS recommended) — `setup.cmd` can install it via `winget` on Windows if missing
- **Git** (recommended — enables 1-click updates)
- **Chromium browser** (Chrome, Edge, Brave, Vivaldi, etc.)

## Install

1. Clone the repository (recommended so 1-click updates work) or download the ZIP from GitHub:
   ```bash
   git clone https://github.com/Oazzies/AtsuSync.git
   cd AtsuSync
   ```
2. Run the setup script:
   - **Windows**: double-click `setup.cmd` (or run `.\setup.cmd`)
   - **macOS / Linux**: run `./setup.sh`

   Setup installs dependencies, builds the extension into `extension/dist`, and registers the `atsusync://` protocol handler (Windows & Linux) so the browser's **Start Server** button can launch the local server automatically.
3. Load the extension in your browser:
   1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`)
   2. Enable **Developer mode**
   3. Click **Load unpacked** and select the `extension/dist` folder inside your AtsuSync directory
4. Open `https://atsu.moe`. Your `atsu.moe` session cookie is synced automatically by the extension (or can be pasted in **Settings**).

> **Starting the server manually:** If you are on macOS or prefer starting the server yourself, run `scripts/start-server.cmd` (Windows) or `./scripts/start-server.sh` (macOS/Linux), or `npm start`.

## Updating

- **From the extension**: open the AtsuSync side panel → **Settings → Updates** and click **Update** (available when installed via `git clone`), then click the reload icon (↻) on AtsuSync in `chrome://extensions` and restart the server.
- **From a terminal / file explorer**: run `scripts/update.cmd` (Windows) or `./scripts/update.sh` (macOS/Linux), then reload the extension in `chrome://extensions`.

## Optional Source Runtimes

Built-in adapters and **LNReader** (200+ English novel plugins) run directly in Node.js with no extra dependencies. **Suwayomi** (Keiyoushi manga extensions) and **LNCrawl** (300+ novel sources) automatically download and manage their own isolated Java / Python (`uv`) runtimes inside `data/` when enabled from **Settings**.

## Development

```bash
npm install
npm run dev        # watches server + extension
npm run build      # builds extension into extension/dist
npm start          # runs API server on http://127.0.0.1:4517
npm run typecheck  # typechecks server and extension
```

## Layout

```
shared/src/types.ts                 DTOs shared by server and extension
extension/src/                      Browser extension (side panel, in-page dock, tools, background)
server/src/atsu/                    Atsumaru API client, request sync, MangaBaka lookups
server/src/sources/                 Source registry, rate-limited HTTP, Suwayomi/LNReader/LNCrawl bridges
server/src/sources/adapters/        Built-in site adapters (_template.ts); nyaa.ts for torrents
server/src/sources/torrent.ts       Built-in WebTorrent client; torrentpack.ts for archive/ebook packing
server/src/links.ts                 Request ↔ source links and their chapters
server/src/watcher/watcher.ts       New-chapter detection
server/src/upload/pipeline.ts       Download queue (resolve pages → download → ZIP/EPUB in data/downloads/)
server/src/updater.ts               GitHub update checker & git fast-forward updater
scripts/                            Setup, start-server, protocol registration, and update scripts
```

## Being a good citizen

- Every request identifies itself as `AtsuSync/<version>`, with no browser impersonation.
- Each site's `robots.txt` is read (cached for a day) and obeyed, including `Crawl-delay`. Nuviatoon disallows `/search`, so its adapter uses the sitemap instead.
- Each adapter has a per-host rate limit; `Retry-After` on 429/503 slows every request to that host.
- Sites behind a bot challenge (Cloudflare "Just a moment…") are not supported. AtsuSync stops instead of trying to get past them.
- Requests to atsu.moe are spaced at least 350 ms apart; the "already on Atsu?" checker does a few requests per 2 minutes.

## Novels

Atsumaru accepts novels as `.epub`, `.pdf`, `.docx`, `.txt` or `.md` on its upload page. Adapters with `medium: 'novel'` implement `getChapterText` instead of `getChapterPages`; the download pipeline fetches the chapter text (and any illustrations), sanitizes it to XHTML paragraphs, and writes `data/downloads/<series>/<chapter>.epub`. Upload it with **Add archive** on `atsu.moe/upload` like any chapter file.

Novel requests (tagged *Novel*, or with "(Novel)" / "light novel" in the title) only search novel sources, and comic requests never search them. Built-in novel sources include Wuxiaworld, NovelCool, Wuxiaworld.site, Hiraeth Translation, KnoxT, and Pen & Paper Translations, alongside optional **LNReader** and **LNCrawl** plugins.

## Source kinds

Each adapter sets `kind`: `scanlation` (the group's own site), `aggregator` (re-hosts releases, e.g. official Webtoon chapters), `official`, `torrent` or `download`. The UI groups and filters by kind.

## Torrent / download sources

- **Nyaa** (`nyaa` for comics, `nyaa-novel` for novels): searches the *Literature - English-translated* category through its RSS feed. Release titles (`One Piece 1197`, `Series c001-050`, `Series v01-03 (Digital)`) are parsed into series + chapter/volume numbers. Robots.txt blocks `/download`, so `.torrent` files are never fetched: the built-in WebTorrent client (`server/src/sources/torrent.ts`) joins the swarm from the info hash with Nyaa's trackers, downloads only the files for the chosen chapter, and deletes them once the ZIP/EPUB is written. It is leech-only (uploads capped to 1 KB/s, nothing seeded).

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

## Upload button rule

Atsumaru shows **Upload this** on a content request only when the post has no terminal tag (Added, Can't add, Duplicate) and its text links `mangabaka.org/<type>/<id>` with a type other than `novel`. AtsuSync applies the same rule (`isUploadable` in `server/src/atsu/requests.ts`) to decide which requests to list.

## MangaDex

Only English chapters are used. A series MangaDex knows only in other languages (or whose English chapters are all external links) is hidden from **Find sources** instead of appearing with 0 chapters, and pasting its URL explains why it was refused.
