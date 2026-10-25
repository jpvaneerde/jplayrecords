// Lyrics for the whole house. JPlaying Now units ask here first; a song nobody asked for before is looked up
// on LRCLIB (lrclib.net: free, no account) and kept, found or not. Each song is fetched once for every unit,
// and a correction made here (later: timing, another version, pasted lyrics) reaches every unit.
//
// An answer: { found, instrumental, synced: [[seconds, line], ...] | null, plain: [line, ...] | null, offset }
// offset (seconds) is added to the song's position before choosing the line: + shows lines later, - earlier.

import { db, get, getSetting, now, run, setSetting } from './db.ts';
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

// Raised whenever the matching gets better: songs not found with an older version are looked up again.
const MATCHER_VERSION = 6;
if (getSetting<number>('lyricsMatcher', 0) < MATCHER_VERSION) {
  db.exec("DELETE FROM lyrics WHERE found = 0 AND source <> 'manual'");
  setSetting('lyricsMatcher', MATCHER_VERSION);
}

const API = 'https://lrclib.net/api';
const RETRY_MISS_MS = 3 * 86_400_000; // a song without lyrics is looked up again after 3 days
const RETRY_ERROR_MS = 45_000; // LRCLIB busy or unreachable: not again for this song for 45 seconds
const DURATION_SLACK = 4; // seconds: the same recording when the lengths differ by at most this

export interface LyricsAnswer {
  found: boolean;
  instrumental: boolean;
  synced: [number, string][] | null;
  plain: string[] | null;
  offset: number;
  /** LRCLIB couldn't be asked (and nothing is stored): not a real "not found". The units then ask LRCLIB themselves. */
  unavailable?: boolean;
}
const NOT_FOUND: LyricsAnswer = { found: false, instrumental: false, synced: null, plain: null, offset: 0 };

/* ---------- matching (the same rules as JPlaying Now's lyrics.py) ---------- */

/**
 * 'Purple Rain (2015 Remaster)' -> 'purple rain', 'Björk' -> 'bjork', '分かってないよ' stays.
 * Accents on Latin letters, brackets and punctuation are ignored; letters of every script are kept, and
 * full-width characters become ordinary ones ('ＴＥＳＴ（Live）' = 'TEST (Live)').
 */
export function normText(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/([\u0000-\u024f])\p{M}+/gu, '$1') // an accent on a Latin letter: drop it
    .normalize('NFC') // が, 방 etc. put back together
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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

/**
 * How to search for a title: as it is, without '(Remastered)' and the like, and without punctuation
 * (LRCLIB's search matches whole words, so 'CHANEL$' wouldn't find 'CHANEL').
 */
export function titleVariants(title: string): string[] {
  const plain = title.replace(/\s*[([].*?[)\]]/g, '').trim();
  const bare = plain.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...new Set([title, plain, bare])].filter(Boolean);
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

/**
 * For a song whose title is written differently (Japanese script vs romaji or English): the same artist
 * (or album) and the same length to within 2 seconds. null = not this song.
 */
export function scoreByLength(rec: LrclibRecord, artist: string, album: string, duration: number | null): number | null {
  if (!duration || !rec.duration || (!rec.syncedLyrics && !rec.plainLyrics)) return null;
  const diff = Math.abs(rec.duration - duration);
  if (diff > 2) return null;
  const want = normText(mainArtist(artist));
  const have = normText(rec.artistName);
  const sameArtist = !!want && (have.includes(want) || want.includes(have));
  const sameAlbum = !!normText(album) && normText(album) === normText(rec.albumName);
  if (!sameArtist && !sameAlbum) return null;
  let s = -diff * 3;
  if (rec.syncedLyrics) s += 10;
  else if (rec.plainLyrics) s += 3;
  if (rec.instrumental) s -= 5;
  return s;
}

/** How well an LRCLIB entry fits the song; null = not this song. */
export function score(rec: LrclibRecord, artist: string, title: string, duration: number | null): number | null {
  if (!rec.syncedLyrics && !rec.plainLyrics) return null; // no lyrics in it: never the answer
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

let retryPause = 1500; // ms between the two tries of a request (tests set it to 0)
export function setRetryPause(ms: number) {
  retryPause = ms;
}

/** One LRCLIB request, tried twice. 404 -> null; a failure (503 when LRCLIB is busy, timeouts, odd answers) is
 *  noted in problems and also gives null, so the lookup can carry on with its other ways of searching. */
async function ask(get_: Getter, path: string, problems: string[], expectList: boolean): Promise<unknown> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await get_(`${API}/${path}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (expectList && !Array.isArray(data)) throw new Error(`unexpected answer: ${JSON.stringify(data).slice(0, 100)}`);
      return data;
    } catch (e) {
      if (attempt === 2) {
        problems.push(`${path.split('?')[0]}: ${(e as Error).message}`);
        return null;
      }
      await new Promise((res) => setTimeout(res, retryPause));
    }
  }
  return null;
}

/** Ask LRCLIB (no cache). Throws when nothing was found and some requests failed (that isn't "no lyrics"). */
export async function fetchLrclib(artist: string, title: string, album: string, duration: number | null, get_: Getter = httpGet) {
  let instrumental = false;
  const problems: string[] = [];
  const pick = (recs: LrclibRecord[], byLength: boolean) => {
    let best: LrclibRecord | null = null;
    let bestScore = -Infinity;
    for (const rec of recs) {
      const s = score(rec, artist, title, duration) ?? (byLength ? scoreByLength(rec, artist, album, duration) : null);
      if (s !== null && s > bestScore) [best, bestScore] = [rec, s];
    }
    return best;
  };
  // 1. The exact recording, when album and length are known.
  if (duration && album) {
    const q = new URLSearchParams({ artist_name: artist, track_name: title, album_name: album, duration: String(Math.round(duration)) });
    const rec = (await ask(get_, `get?${q}`, problems, false)) as LrclibRecord | null;
    if (rec) {
      const ans = toAnswer(rec);
      if (ans.found) return { ans, id: rec.id ?? null };
      // An entry without lyrics (marked instrumental, or empty): look further, another entry may have them.
      instrumental = ans.instrumental;
    }
  }
  // 2. Search by title and artist and take the best fit (also without "(Remastered)" and the like).
  const titles = titleVariants(title);
  for (const t of titles) {
    const recs = (await ask(get_, `search?${new URLSearchParams({ track_name: t, artist_name: mainArtist(artist) })}`, problems, true)) as LrclibRecord[] | null;
    const best = pick(recs ?? [], false);
    if (best) return { ans: toAnswer(best), id: best.id ?? null };
  }
  // 3. A free search: artist and title, artist and album, the artist alone. Take a result with the same title,
  //    or (for a title written differently: Japanese script vs romaji or English) the same length.
  const a = mainArtist(artist);
  const queries = [...new Set([`${a} ${titles[titles.length - 1]}`, album ? `${a} ${album}` : '', a])].filter(Boolean);
  for (const q of queries) {
    const recs = (await ask(get_, `search?${new URLSearchParams({ q })}`, problems, true)) as LrclibRecord[] | null;
    const best = pick(recs ?? [], true);
    if (best) return { ans: toAnswer(best), id: best.id ?? null };
  }
  if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
  return { ans: { ...NOT_FOUND, instrumental }, id: null };
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
  if (now() - (failedAt.get(key) ?? 0) < RETRY_ERROR_MS) return row ? rowAnswer(row) : { ...NOT_FOUND, unavailable: true };

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
      return row ? rowAnswer(row) : { ...NOT_FOUND, unavailable: true };
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
