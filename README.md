# AtsuSync

Local helper + browser extension for uploading to Atsumaru [content requests](https://atsu.moe/social/forum/cms0o0eh80000uj0lmpkut6tc/content-requests).

- **In-page dock & side panel on `atsu.moe`**: browse open content requests, track linked series, manage downloads, and auto-attach chapter archives on `atsu.moe/upload`.
- **Source discovery**: on a request or series, **Find sources** searches enabled sites and ranks matches with cover previews and chapter counts. Supports built-in sites, **Suwayomi / Keiyoushi** (manga), **LNReader** & **LNCrawl** (novels), and **Nyaa** (torrents).
- **Watched series & notifications**: linked series are re-checked automatically; new or unlocked chapters show up under **Tracked** with desktop notifications.
- **Existing series**: paste any `atsu.moe/manga/<id>` link to track and download missing chapters without a content request.
- **Nothing is ever uploaded for you**: Download turns a chapter into a `.zip` or `.epub` (and auto-attaches it on `atsu.moe/upload`), then you review and submit it yourself.

## Requirements

- **Node.js >= 22.5** (on Windows, `setup.cmd` will offer to install it for you automatically if missing)
- **Chromium browser** (Chrome, Edge, Brave, Vivaldi, etc.)

## Install

1. Download the latest `atsusync-v*.zip` from [GitHub Releases](https://github.com/Oazzies/AtsuSync/releases/latest) and extract the folder.
2. Run the setup:
   - **Windows**: double-click **`setup.cmd`**
   - **macOS / Linux**: run **`setup.sh`**
3. Load the extension in your browser:
   1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`)
   2. Enable **Developer mode**
   3. Click **Load unpacked** and select the `extension/dist` folder inside your AtsuSync folder
4. Open `https://atsu.moe`, open the AtsuSync side panel, and click **Start Server**. Your `atsu.moe` session is synced automatically.

## How to Use

1. Open any content request (or paste an `atsu.moe/manga/<id>` link into **Tracked**).
2. Click **Find sources**, pick a matching source, and **Link** it.
3. Select the missing chapters and click **Download**.
4. Open `atsu.moe/upload` — AtsuSync attaches the downloaded `.zip` / `.epub` for you to review and submit.
5. Click **Mark uploaded** (chapters already on Atsumaru are also detected automatically).

## Optional Sources

Built-in sites and **LNReader** (novels) work out of the box. **Suwayomi** (Keiyoushi manga extensions) and **LNCrawl** (novel sources) can be enabled in **Settings** and will automatically set up what they need.

## Updating

When an update is available, open the AtsuSync side panel → **Settings → Updates** and click **Update & Restart**. AtsuSync will download the latest release, update your files (keeping your `data/` folder and `.env` intact), restart the local server, and reload the extension automatically.
