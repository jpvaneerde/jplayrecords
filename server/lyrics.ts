// Lyrics for the whole house. JPlaying Now units ask here first; a song nobody asked for before is looked up
// on LRCLIB (lrclib.net: free, no account) and kept, found or not. Each song is fetched once for every unit,
// and a correction made here (later: timing, another version, pasted lyrics) reaches every unit.
//
// An answer: { found, instrumental, synced: [[seconds, line], ...] | null, plain: [line, ...] | null, offset }
// offset (seconds) is added to the song's position before choosing the line: + shows lines later, - earlier.

import { db, get, now, run } from './db.ts';
import { USER_AGENT } from './config.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS lyrics (
    key           TEXT PRIMARY KEY,              -- normalised "artist|title" (see lyricsKey)
    artist        TEXT NOT NULL,
    title         TEXT NOT NULL,
    album         TEXT NOT NULL DEFAULT '',
    duration      REAL,                          -- seconds, when known
    found         INTEGER NOT NULL DEFAULT 0,
    instrumental  INTEGER NOT NULL DEFAULT 0,
    synced        TEXT,                          -- JSON [[seconds, line], ...]
    plain         TEXT,                          -- JSON [line, ...]
    offset        REAL NOT NULL DEFAULT 0,       -- timing correction for this song (seconds)
    source        TEXT NOT NULL DEFAULT 'lrclib',-- lrclib | manual (manual entries are never overwritten)
    lrclib_id     INTEGER,
    fetched_at    INTEGER NOT NULL,              -- when LRCLIB was last asked (ms)
    asked_count   INTEGER NOT NULL DEFAULT 0,    -- how often a unit asked for it
    last_asked_at INTEGER
  );
`);

const API = 'https://lrclib.net/api';
const RETRY_MISS_MS = 3 * 86_400_000; // a song without lyrics is looked up again after 3 days
const RETRY_ERROR_MS = 15 * 60_000; // LRCLIB unreachable: not again for this song for 15 minutes
const DURATION_SLACK = 4; // seconds: the same recording when the lengths differ by at most this

export interface LyricsAnswer {
  found: boolean;
  instrumental: boolean;
  synced: [number, string][] | null;
  plain: string[] | null;
  offset: number;
}
const NOT_FOUND: LyricsAnswer = { found: false, instrumental: false, synced: null, plain: null, offset: 0 };

/* ---------- matching (the same rules as JPlaying Now's lyrics.py) ---------- */

/** 'Purple Rain (2015 Remaster)' -> 'purple rain'; accents, brackets and punctuation ignored. */
export function normText(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 'Dua Lipa & Elton John' / 'X feat. Y' / 'A, B' -> 'Dua Lipa'. */
export function mainArtist(artist: string): string {
  const first = String(artist ?? '').split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bmed\b|\bwith\b)\s*/i)[0];
  return first.trim() || String(artist ?? '');
}

export function lyricsKey(artist: string, title: string) {
  return `${normText(mainArtist(artist))}|${normText(title)}`;
}

/** '[01:02.50] Line' (a line may carry several times) -> [[62.5, 'Line'], ...], in time order. */
export function parseLrc(text: string): [number, string][] {
  const out: [number, string][] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!times.length) continue; // [ar:...], [length:...] and other tags
    const line = raw.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, '').trim();
    for (const t of times) out.push([Math.round((Number(t[1]) * 60 + Number(t[2])) * 100) / 100, line]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

function toAnswer(rec: LrclibRecord): LyricsAnswer {
  const synced = parseLrc(rec.syncedLyrics ?? '');
  let plain = String(rec.plainLyrics ?? '')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  if (plain.length === 1 && !plain[0]) plain = [];
  if (!plain.length && synced.length) plain = synced.map(([, l]) => l);
  return { found: !!(synced.length || plain.length), instrumental: !!rec.instrumental, synced: synced.length ? synced : null, plain: plain.length ? plain : null, offset: 0 };
}

/** How well an LRCLIB entry fits the song; null = not this song. */
export function score(rec: LrclibRecord, artist: string, title: string, duration: number | null): number | null {
  if (normText(rec.trackName) !== normText(title)) return null;
  const want = normText(mainArtist(artist));
  const have = normText(rec.artistName);
  if (!want || !(have.includes(want) || want.includes(have))) return null;
  let s = 0;
  if (duration && rec.duration) {
    const diff = Math.abs(rec.duration - duration);
    if (diff > DURATION_SLACK * 3) return null; // another version (live, extended...)
    s -= diff;
  }
  if (rec.syncedLyrics) s += 10;
  else if (rec.plainLyrics) s += 3;
  if (rec.instrumental) s -= 5;
  return s;
}

type Getter = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;
const httpGet: Getter = (url) => fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });

/** Ask LRCLIB (no cache). */
export async function fetchLrclib(artist: string, title: string, album: string, duration: number | null, get_: Getter = httpGet) {
  // 1. The exact recording, when album and length are known.
  if (duration && album) {
    const q = new URLSearchParams({ artist_name: artist, track_name: title, album_name: album, duration: String(Math.round(duration)) });
    const r = await get_(`${API}/get?${q}`);
    if (r.status === 200) {
      const rec = (await r.json()) as LrclibRecord;
      const ans = toAnswer(rec);
      if (ans.found || ans.instrumental) return { ans, id: rec.id ?? null };
    } else if (r.status !== 404) throw new Error(`LRCLIB answered ${r.status}`);
  }
  // 2. Search by title and artist and take the best fit (also without "(Remastered)" and the like).
  const titles = [...new Set([title, title.replace(/\s*[([].*?[)\]]/g, '').trim()])].filter(Boolean);
  for (const t of titles) {
    const r = await get_(`${API}/search?${new URLSearchParams({ track_name: t, artist_name: mainArtist(artist) })}`);
    if (r.status === 404) continue;
    if (r.status !== 200) throw new Error(`LRCLIB answered ${r.status}`);
    let best: LrclibRecord | null = null;
    let bestScore = -Infinity;
    for (const rec of ((await r.json()) as LrclibRecord[]) ?? []) {
      const s = score(rec, artist, title, duration);
      if (s !== null && s > bestScore) [best, bestScore] = [rec, s];
    }
    if (best) return { ans: toAnswer(best), id: best.id ?? null };
  }
  return { ans: { ...NOT_FOUND }, id: null };
}

/* ---------- the store ---------- */

interface LyricsRow {
  key: string;
  found: number;
  instrumental: number;
  synced: string | null;
  plain: string | null;
  offset: number;
  source: string;
  fetched_at: number;
}

const rowAnswer = (r: LyricsRow): LyricsAnswer => ({
  found: !!r.found,
  instrumental: !!r.instrumental,
  synced: r.synced ? JSON.parse(r.synced) : null,
  plain: r.plain ? JSON.parse(r.plain) : null,
  offset: r.offset ?? 0,
});

const failedAt = new Map<string, number>(); // LRCLIB errors per song (memory only)
const inFlight = new Map<string, Promise<LyricsAnswer>>(); // two units asking at once: one LRCLIB request

/** The lyrics of a song: from the store, or looked up on LRCLIB and stored. Never throws. */
export async function lookupLyrics(artist: string, title: string, album = '', duration: number | null = null, get_: Getter = httpGet): Promise<LyricsAnswer> {
  artist = String(artist ?? '').trim().slice(0, 300);
  title = String(title ?? '').trim().slice(0, 300);
  album = String(album ?? '').trim().slice(0, 300);
  if (!artist || !title) return { ...NOT_FOUND };
  const key = lyricsKey(artist, title);
  if (!key.split('|').every(Boolean)) return { ...NOT_FOUND };
  run('UPDATE lyrics SET asked_count = asked_count + 1, last_asked_at = ? WHERE key = ?', now(), key);
  const row = get<LyricsRow>('SELECT * FROM lyrics WHERE key = ?', key);
  if (row && (row.found || row.source === 'manual' || now() - row.fetched_at < RETRY_MISS_MS)) return rowAnswer(row);
  if (now() - (failedAt.get(key) ?? 0) < RETRY_ERROR_MS) return row ? rowAnswer(row) : { ...NOT_FOUND };

  const pending = inFlight.get(key);
  if (pending) {
    const ans = await pending; // another unit asked the same moment: share its answer, count this ask too
    run('UPDATE lyrics SET asked_count = asked_count + 1, last_asked_at = ? WHERE key = ?', now(), key);
    return ans;
  }
  const job = (async () => {
    try {
      const { ans, id } = await fetchLrclib(artist, title, album, duration, get_);
      run(
        `INSERT INTO lyrics (key, artist, title, album, duration, found, instrumental, synced, plain, lrclib_id, fetched_at, asked_count, last_asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET album = excluded.album, duration = excluded.duration, found = excluded.found,
           instrumental = excluded.instrumental, synced = excluded.synced, plain = excluded.plain,
           lrclib_id = excluded.lrclib_id, fetched_at = excluded.fetched_at
         WHERE lyrics.source <> 'manual'`,
        key,
        artist,
        title,
        album,
        duration,
        ans.found ? 1 : 0,
        ans.instrumental ? 1 : 0,
        ans.synced ? JSON.stringify(ans.synced) : null,
        ans.plain ? JSON.stringify(ans.plain) : null,
        id,
        now(),
        now(),
      );
      failedAt.delete(key);
      const stored = get<LyricsRow>('SELECT * FROM lyrics WHERE key = ?', key);
      return stored ? rowAnswer(stored) : ans;
    } catch (e) {
      console.warn(`Lyrics: LRCLIB lookup failed for ${artist} – ${title}: ${(e as Error).message}`);
      failedAt.set(key, now());
      if (failedAt.size > 2000) failedAt.delete(failedAt.keys().next().value!);
      return row ? rowAnswer(row) : { ...NOT_FOUND };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

export function lyricsStats() {
  return get<{ songs: number; found: number; synced: number }>(
    'SELECT COUNT(*) AS songs, COALESCE(SUM(found), 0) AS found, COALESCE(SUM(synced IS NOT NULL), 0) AS synced FROM lyrics',
  )!;
}
