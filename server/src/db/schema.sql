-- Stremio4Manga 2.0 — one database, every account.
--
-- The Java server this replaces was single-tenant at the schema level, which is
-- why the old gateway had to run one JVM per person. Here every domain row
-- carries user_id and every resolver filters on it, so the separation costs one
-- column instead of 768 MB of heap.
--
-- Times are epoch milliseconds in INTEGER columns throughout. The UI reads
-- several of them through the LongString scalar (a Long serialised as a string),
-- so they must stay integral milliseconds, not seconds and not ISO strings.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- accounts --

CREATE TABLE IF NOT EXISTS users (
  username            TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  password            TEXT NOT NULL,
  -- A session issued before this stamp is refused, so changing a password
  -- signs out devices that are already signed in.
  password_changed_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- Only the SHA-256 of the cookie value; the raw id exists only in the cookie.
  id_hash    TEXT PRIMARY KEY,
  username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(username);

-- ----------------------------------------------------------------- library --

CREATE TABLE IF NOT EXISTS manga (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  -- Source ids are Long on the wire (LongString). '1' is the AniList
  -- pseudo-source: entries imported from AniList are shells with no chapters,
  -- url 'anilist:<mediaId>', bound to a real source through manga meta.
  source_id                TEXT NOT NULL,
  url                      TEXT NOT NULL,
  title                    TEXT NOT NULL,
  artist                   TEXT,
  author                   TEXT,
  description              TEXT,
  genre                    TEXT,              -- JSON array of strings
  status                   TEXT NOT NULL DEFAULT 'UNKNOWN',
  thumbnail_url            TEXT,
  real_url                 TEXT,
  initialized              INTEGER NOT NULL DEFAULT 0,
  in_library               INTEGER NOT NULL DEFAULT 0,
  in_library_at            INTEGER NOT NULL DEFAULT 0,
  last_fetched_at          INTEGER NOT NULL DEFAULT 0,
  chapters_last_fetched_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, source_id, url)
);

CREATE INDEX IF NOT EXISTS manga_in_library ON manga(user_id, in_library);

CREATE TABLE IF NOT EXISTS chapter (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  manga_id       INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  name           TEXT NOT NULL,
  scanlator      TEXT,
  chapter_number REAL NOT NULL DEFAULT -1,
  -- Position in the list the source returned, 1-based. This is what the reader
  -- route carries (/manga/:id/chapter/:sourceOrder), not the row id.
  source_order   INTEGER NOT NULL,
  date_upload    INTEGER NOT NULL DEFAULT 0,
  real_url       TEXT,
  is_read        INTEGER NOT NULL DEFAULT 0,
  is_bookmarked  INTEGER NOT NULL DEFAULT 0,
  last_page_read INTEGER NOT NULL DEFAULT 0,
  -- Stamped by the reader's progress PATCH only. updateChapters(isRead) must
  -- leave it alone: the continue-reading shelf orders on it, and a bulk
  -- "mark read" would otherwise push every title to the top of the shelf.
  last_read_at   INTEGER NOT NULL DEFAULT 0,
  page_count     INTEGER NOT NULL DEFAULT -1,
  is_downloaded  INTEGER NOT NULL DEFAULT 0,
  fetched_at     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (manga_id, url)
);

CREATE INDEX IF NOT EXISTS chapter_by_manga ON chapter(manga_id, source_order);
CREATE INDEX IF NOT EXISTS chapter_last_read ON chapter(user_id, last_read_at);
CREATE INDEX IF NOT EXISTS chapter_downloaded ON chapter(user_id, is_downloaded);

CREATE TABLE IF NOT EXISTS page (
  chapter_id INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  url        TEXT NOT NULL,
  -- Resolved lazily for sources that hand out a page URL first and the image
  -- URL only on a second request; written back once known.
  image_url  TEXT,
  PRIMARY KEY (chapter_id, idx)
);

-- -------------------------------------------------------------- categories --

-- Category id 0 ("Default") is virtual: it is every library entry filed
-- nowhere else. It is never stored, never returned by manga.categories, and
-- adding to it is refused rather than silently ignored.
CREATE TABLE IF NOT EXISTS category (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  ord      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS category_by_user ON category(user_id, ord);

CREATE TABLE IF NOT EXISTS category_manga (
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  manga_id    INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, manga_id)
);

CREATE INDEX IF NOT EXISTS category_manga_by_manga ON category_manga(manga_id);

-- ---------------------------------------------------------------- tracking --

CREATE TABLE IF NOT EXISTS track_record (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  manga_id          INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
  tracker_id        INTEGER NOT NULL,          -- 2 = AniList
  remote_id         TEXT NOT NULL,             -- LongString on the wire
  title             TEXT NOT NULL DEFAULT '',
  last_chapter_read REAL NOT NULL DEFAULT 0,
  total_chapters    INTEGER NOT NULL DEFAULT 0,
  status            INTEGER NOT NULL DEFAULT 0,
  score             REAL NOT NULL DEFAULT 0,
  remote_url        TEXT,
  start_date        INTEGER NOT NULL DEFAULT 0,
  finish_date       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (manga_id, tracker_id)
);

CREATE INDEX IF NOT EXISTS track_by_user ON track_record(user_id, tracker_id);

CREATE TABLE IF NOT EXISTS tracker_credential (
  user_id      TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  tracker_id   INTEGER NOT NULL,
  access_token TEXT NOT NULL,
  expires_at   INTEGER NOT NULL DEFAULT 0,
  remote_user  TEXT,                          -- numeric AniList account id
  display_name TEXT,
  avatar_url   TEXT,
  score_type   TEXT,
  PRIMARY KEY (user_id, tracker_id)
);

-- -------------------------------------------------------------------- meta --

-- Client state the server stores but never interprets: source bindings,
-- chapter-view preferences, saved searches, the whole settings blob.
CREATE TABLE IF NOT EXISTS global_meta (
  user_id TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS manga_meta (
  manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (manga_id, key)
);

-- Server-side settings the UI reads and writes through the settings mutation
-- (backupInterval, backupTime, backupTTL, autoBackupInclude*). Values are JSON.
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- --------------------------------------------------------------- downloads --

CREATE TABLE IF NOT EXISTS download_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  chapter_id  INTEGER NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'QUEUED',  -- QUEUED|DOWNLOADING|FINISHED|ERROR
  progress    REAL NOT NULL DEFAULT 0,         -- 0..1
  tries       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  enqueued_at INTEGER NOT NULL,
  UNIQUE (chapter_id)
);

CREATE INDEX IF NOT EXISTS download_by_user ON download_queue(user_id, position);

-- ----------------------------------------------------------------- sources --

-- Which sources an account has "installed". The catalogue itself is static
-- (server/catalog.json); this is only the per-account on/off state, so that
-- two people on one server can read from different sets.
CREATE TABLE IF NOT EXISTS source_state (
  user_id      TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  pkg_name     TEXT NOT NULL,
  installed    INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pkg_name)
);

-- Extension "stores" exist so the UI's Sources page keeps working; ours holds
-- exactly one row for the built-in catalogue, and addExtensionStore is accepted
-- and ignored rather than failing the page.
CREATE TABLE IF NOT EXISTS extension_store (
  user_id   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  index_url TEXT NOT NULL,
  PRIMARY KEY (user_id, index_url)
);
