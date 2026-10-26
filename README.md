# AtsuSync

Local, semi-automatic uploader for Atsumaru [content requests](https://atsu.moe/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests).

- Lists every content request (synced from the forum every 15 min, or on demand).
- On a request, **Find sources** searches the enabled scanlation sites once (with the tracker's alt titles) and shows chapter counts. Nothing is scraped in the background except linked series.
- Check the series on the site yourself, then **Link** it. The chapter list shows what Atsumaru is missing.
- Linked series are re-checked on an interval. New chapters show up under **Tracked** (plus a desktop notification) and wait for you to **Upload** or **Skip**.
- **Dry run is on by default**: pages get downloaded and hashed, but nothing is sent to Atsumaru.

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
server/src/upload/pipeline.ts       Upload queue (download → hash → draft → PUT pages → submit)
web/src/views/                      Vue pages
```

## Adding a source site

1. Copy `server/src/sources/adapters/_template.ts` to `<site>.ts` and implement `search`, `getSeries`, `getChapterPages`.
2. Add it to `ADAPTERS` in `server/src/sources/registry.ts`.
3. Save a search/series/chapter page under `server/test/fixtures/` and add a parser test like `test/nuviatoon.test.ts`.

All requests go through `SourceHttp`, which applies the adapter's `rateLimit` per host and caches search (1 h) and series (10 min) pages.

## Tests

```bash
npm test            # offline, uses saved fixtures
npm run test:live   # hits nuviatoon.net and atsu.moe once each
```

## How an upload talks to Atsumaru

Mirrors the site's own `/upload` page:

1. `GET /api/uploads/series?mangaId=…|mangaBakaId=…` → coverage ranges plus your existing upload sources for the series
2. `POST /api/uploads/sources` `{ id, groupId | null, mangaId | mangaBakaId }`, only if you have no source for that series and group yet
3. `POST /api/uploads/drafts` `{ id, sourceId, number, title, pageOrder: [sha256…], replaceChapterId: null }`
4. `PUT /api/uploads/:draftId/pages/:sha256?name=…` for each page
5. `POST /api/uploads/drafts/submit` `{ ids }`. If a draft isn't accepted, the job fails and the draft is deleted.

If your account can't publish directly (`canPublish: false`), submitted chapters go to Atsumaru's review queue. Pick "Just me" or one of your groups under Settings → Upload as.
