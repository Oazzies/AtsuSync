// Append-only list of migrations. Never edit an applied entry; add a new one.
export const migrations: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author_name TEXT,
    tags_json TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT,
    trackers_json TEXT NOT NULL,
    mangabaka_id TEXT,
    comment_count INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE INDEX requests_created ON requests(created_at DESC);

  CREATE TABLE source_settings (
    source_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  -- Cache of lazy "find sources" lookups per request.
  CREATE TABLE source_matches (
    request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    series_url TEXT NOT NULL,
    title TEXT NOT NULL,
    cover TEXT,
    score REAL NOT NULL,
    chapter_count INTEGER,
    latest_chapter REAL,
    error TEXT,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (request_id, source_id, series_url)
  );

  CREATE TABLE links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    series_url TEXT NOT NULL,
    series_title TEXT NOT NULL,
    atsu_manga_id TEXT,
    watch INTEGER NOT NULL DEFAULT 1,
    check_interval_min INTEGER NOT NULL DEFAULT 60,
    last_checked_at INTEGER,
    next_check_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (request_id, source_id, series_url)
  );

  CREATE TABLE source_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    number REAL NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    UNIQUE (link_id, number)
  );

  CREATE TABLE upload_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    chapter_id INTEGER NOT NULL REFERENCES source_chapters(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    dry_run INTEGER NOT NULL,
    draft_id TEXT,
    error TEXT,
    log_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX upload_jobs_state ON upload_jobs(state);
  `,
  `
  ALTER TABLE upload_jobs ADD COLUMN prev_chapter_state TEXT NOT NULL DEFAULT 'known';
  `,
  `
  ALTER TABLE requests ADD COLUMN section_id TEXT;
  ALTER TABLE requests ADD COLUMN presence_json TEXT;
  ALTER TABLE requests ADD COLUMN presence_checked_at INTEGER;
  `,
  `
  -- Jobs now produce a ZIP for manual upload instead of calling Atsumaru.
  ALTER TABLE upload_jobs ADD COLUMN file_path TEXT;
  ALTER TABLE upload_jobs ADD COLUMN file_size INTEGER;
  `,
  `
  -- Sites that know a series but have no chapters to upload are no longer listed.
  DELETE FROM source_matches WHERE chapter_count = 0 AND error IS NULL;
  `,
  `
  -- A download can fetch its chapter from a different site than the link's without rewriting the chapter row.
  ALTER TABLE upload_jobs ADD COLUMN source_url TEXT;
  `,
  `
  -- Series already on Atsumaru can be added directly (as a request row with id 'atsu:<mangaId>').
  ALTER TABLE requests ADD COLUMN atsu_manga_id TEXT;
  ALTER TABLE requests ADD COLUMN alt_titles_json TEXT;
  ALTER TABLE requests ADD COLUMN cover TEXT;
  `,
];
