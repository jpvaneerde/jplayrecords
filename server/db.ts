import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

mkdirSync(join(DATA_DIR, 'covers'), { recursive: true });

export const COVER_DIR = join(DATA_DIR, 'covers');
export const db = new DatabaseSync(join(DATA_DIR, 'records.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  -- One row per copy in the Discogs collection (a release can be owned twice).
  CREATE TABLE IF NOT EXISTS items (
    instance_id   INTEGER PRIMARY KEY,
    release_id    INTEGER NOT NULL,
    folder_id     INTEGER NOT NULL DEFAULT 0,
    artist        TEXT NOT NULL,
    title         TEXT NOT NULL,
    year          INTEGER,
    format        TEXT NOT NULL DEFAULT '',  -- primary format: Vinyl, CD, Cassette, Box Set, …
    size          TEXT NOT NULL DEFAULT '',  -- 12", 10", 7" (vinyl), '' otherwise
    discs         INTEGER NOT NULL DEFAULT 1,
    format_text   TEXT NOT NULL DEFAULT '',  -- "2×Vinyl, LP, Album, Gatefold"
    labels        TEXT NOT NULL DEFAULT '',  -- "Blue Note – BST 84003"
    genres        TEXT NOT NULL DEFAULT '[]',
    styles        TEXT NOT NULL DEFAULT '[]',
    fields        TEXT NOT NULL DEFAULT '{}', -- Discogs custom fields by name
    rating        INTEGER NOT NULL DEFAULT 0,
    date_added    TEXT,
    cover_url     TEXT,
    cover         TEXT,                       -- local file stem in covers/ once downloaded
    discogs_rank  INTEGER NOT NULL,           -- position in Discogs "sort by artist"
    synced_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_rank ON items (discogs_rank);
  CREATE INDEX IF NOT EXISTS items_release ON items (release_id);

  -- Release details (tracklist etc.) fetched once per release.
  CREATE TABLE IF NOT EXISTS releases (
    release_id INTEGER PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
    artist, title, labels, tags, tracks,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  -- Discogs "master" (all versions of an album): holds the original release year.
  CREATE TABLE IF NOT EXISTS masters (
    master_id  INTEGER PRIMARY KEY,
    year       INTEGER,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Kiosk screens: a secret link signs them in read-only.
  CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );
`);

// Small additive migrations for databases created by earlier versions.
const itemCols = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
if (!itemCols.includes('master_id')) db.exec('ALTER TABLE items ADD COLUMN master_id INTEGER');
if (!itemCols.includes('artist_ids')) db.exec("ALTER TABLE items ADD COLUMN artist_ids TEXT NOT NULL DEFAULT '[]'");
if (!itemCols.includes('label_ids')) db.exec("ALTER TABLE items ADD COLUMN label_ids TEXT NOT NULL DEFAULT '[]'");
if (!itemCols.includes('orig_year')) {
  // Original release year (from the master); year = this pressing.
  db.exec('ALTER TABLE items ADD COLUMN orig_year INTEGER');
}

/** The year we show and filter on: the original release year when known, else this pressing's year. */
export const YEAR = 'COALESCE(orig_year, year)';

export function now() {
  return Date.now();
}

type P = string | number | null;
export function get<T>(sql: string, ...params: P[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: P[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: P[]) {
  return db.prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export interface ItemRow {
  instance_id: number;
  release_id: number;
  folder_id: number;
  artist: string;
  title: string;
  year: number | null;
  master_id: number | null;
  orig_year: number | null;
  format: string;
  size: string;
  discs: number;
  format_text: string;
  labels: string;
  genres: string;
  styles: string;
  fields: string;
  rating: number;
  date_added: string | null;
  cover_url: string | null;
  cover: string | null;
  discogs_rank: number;
  synced_at: number;
  artist_ids: string; // JSON array of Discogs artist ids
  label_ids: string; // JSON array of Discogs label ids
}

/** Rebuild the full-text row for one item (call after any change to it or its release details). */
export function indexItem(id: number) {
  const it = get<ItemRow>('SELECT * FROM items WHERE instance_id = ?', id);
  run('DELETE FROM search WHERE rowid = ?', id);
  if (!it) return;
  const rel = get<{ data: string }>('SELECT data FROM releases WHERE release_id = ?', it.release_id);
  let tracks = '';
  let barcodes = '';
  if (rel) {
    try {
      const d = JSON.parse(rel.data) as { tracklist?: { title: string; artists?: string }[]; barcodes?: string[] };
      tracks = (d.tracklist ?? []).map((t) => [t.title, t.artists ?? ''].join(' ')).join(' · ');
      barcodes = (d.barcodes ?? []).join(' '); // for "do I own this?" by barcode
    } catch {
      /* ignore */
    }
  }
  const fields = Object.values(JSON.parse(it.fields || '{}') as Record<string, string>).join(' ');
  const tags = [
    it.format_text,
    ...JSON.parse(it.genres),
    ...JSON.parse(it.styles),
    it.year ? String(it.year) : '',
    it.orig_year && it.orig_year !== it.year ? String(it.orig_year) : '',
    fields,
    barcodes,
  ].join(' ');
  run(
    'INSERT INTO search (rowid, artist, title, labels, tags, tracks) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    it.artist,
    it.title,
    it.labels,
    tags,
    tracks,
  );
}
