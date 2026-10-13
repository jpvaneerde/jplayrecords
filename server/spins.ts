// JPlay Spins: what was played, where, and from which source.
//
// JPlaying Now units ("listeners", one per room) send raw events:
//   mic      – the microphone recognised a song (Shazam): title, artist, album, cover, loudness
//   mic_end  – that song is no longer heard
//   room     – this room's moOde changed state (play/pause/stop, radio station or file, any metadata);
//              repeated every few minutes as a heartbeat
// A worker turns them into plays a little later (so both rooms' reports are in):
//   1. A song heard in several rooms at about the same time is ONE play.
//   2. If a room that heard it has its moOde playing → a streamed play there (radio/file), not physical.
//   3. Otherwise → the highest-priority room that heard it (the lounge) and, if the song is on a record or
//      CD you own in a format that room can play → a physical play of that copy; else "heard" (TV, phone…).
//   4. moOde metadata adds streamed plays the mic missed; for radio the mic wins when they disagree.
// Physical plays of the same copy in a row form a "spin" (the record being put on).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { all, db, get, now, run, tx, type ItemRow } from './db.ts';
import { coverFiles, releaseDetails } from './discogs.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS listeners (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    room         TEXT NOT NULL,
    priority     INTEGER NOT NULL DEFAULT 1,   -- higher wins when several rooms hear the same song
    formats      TEXT NOT NULL DEFAULT '[]',   -- physical formats that can play in this room: ["vinyl","cd"]
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS spin_events (
    id          TEXT PRIMARY KEY,              -- uuid from the unit (resending is harmless)
    listener_id TEXT NOT NULL,
    room        TEXT NOT NULL,
    type        TEXT NOT NULL,                 -- mic | mic_end | room
    ts          INTEGER NOT NULL,              -- when it happened (ms)
    data        TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    processed   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS spin_events_todo ON spin_events (processed, received_at);
  CREATE INDEX IF NOT EXISTS spin_events_room ON spin_events (room, type, ts);

  CREATE TABLE IF NOT EXISTS plays (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    room         TEXT NOT NULL,
    kind         TEXT NOT NULL,                -- physical | streamed | heard
    detail       TEXT NOT NULL DEFAULT '',     -- vinyl | cd | radio | file | …
    station      TEXT,
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL DEFAULT '',
    album        TEXT NOT NULL DEFAULT '',
    cover        TEXT,                         -- remote cover (Shazam) when not one of yours
    song_key     TEXT NOT NULL,
    instance_id  INTEGER,                      -- your copy, for physical plays
    release_id   INTEGER,
    confidence   TEXT NOT NULL DEFAULT 'mic',  -- mic | metadata | mic+metadata | ambiguous | manual
    heard_by     TEXT NOT NULL DEFAULT '[]',   -- rooms whose microphone heard it
    alternatives TEXT NOT NULL DEFAULT '[]',   -- other copies it could have been
    mic_ids      TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plays_started ON plays (started_at);
  CREATE INDEX IF NOT EXISTS plays_key ON plays (song_key, started_at);
  CREATE INDEX IF NOT EXISTS plays_instance ON plays (instance_id, started_at);

  -- moOde listening time per room (radio sessions are counted even when no song is known).
  CREATE TABLE IF NOT EXISTS room_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    room         TEXT NOT NULL,
    mode         TEXT NOT NULL,                -- radio | file
    station      TEXT NOT NULL DEFAULT '',
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS room_sessions_room ON room_sessions (room, ended_at);
`);

const SETTLE_MS = 45_000; // wait this long for the other room's report before deciding
const SAME_SONG_MS = 180_000; // same song within this window = one play
const RADIO_CONFLICT_MS = 150_000;
const ROOM_STALE_MS = 12 * 60_000; // no room heartbeat for this long = unit/player gone
const SPIN_GAP_MS = 20 * 60_000; // tracks of the same copy closer than this = one spin
const TRACK_GUESS_MS = 4 * 60_000; // assumed length when a play has no end

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/* ---------- listeners ---------- */

export interface Listener {
  id: string;
  name: string;
  room: string;
  priority: number;
  formats: string;
  created_at: number;
  last_seen_at: number | null;
}

export function listeners() {
  return all<Listener>('SELECT id, name, room, priority, formats, created_at, last_seen_at FROM listeners ORDER BY priority DESC, name').map(
    (l) => ({ id: l.id, name: l.name, room: l.room, priority: l.priority, formats: JSON.parse(l.formats) as string[], createdAt: l.created_at, lastSeenAt: l.last_seen_at }),
  );
}

export function createListener(name: string, room: string, priority: number, formats: string[]) {
  const token = randomBytes(24).toString('base64url');
  run(
    'INSERT INTO listeners (id, name, room, priority, formats, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(),
    name,
    room,
    priority,
    JSON.stringify(formats),
    sha(token),
    now(),
  );
  return token;
}

export function updateListener(id: string, name: string, room: string, priority: number, formats: string[]) {
  run('UPDATE listeners SET name = ?, room = ?, priority = ?, formats = ? WHERE id = ?', name, room, priority, JSON.stringify(formats), id);
}

export function deleteListener(id: string) {
  run('DELETE FROM listeners WHERE id = ?', id);
}

export function listenerByToken(token: string): Listener | undefined {
  return get<Listener>('SELECT * FROM listeners WHERE token_hash = ?', sha(token));
}

function roomInfo() {
  const rows = all<{ room: string; priority: number; formats: string }>('SELECT room, priority, formats FROM listeners');
  const map = new Map<string, { priority: number; formats: Set<string> }>();
  for (const r of rows) {
    const cur = map.get(r.room) ?? { priority: -Infinity, formats: new Set<string>() };
    cur.priority = Math.max(cur.priority, r.priority);
    for (const f of JSON.parse(r.formats) as string[]) cur.formats.add(f);
    map.set(r.room, cur);
  }
  return map;
}

/* ---------- ingest ---------- */

interface IncomingEvent {
  id?: unknown;
  type?: unknown;
  ts?: unknown;
  data?: unknown;
}

export function ingest(l: Listener, events: IncomingEvent[]): number {
  let n = 0;
  const t = now();
  tx(() => {
    for (const e of events.slice(0, 500)) {
      const id = String(e.id ?? '');
      const type = String(e.type ?? '');
      let ts = Number(e.ts);
      if (!id || id.length > 64 || !['mic', 'mic_end', 'room'].includes(type) || !Number.isFinite(ts)) continue;
      if (ts < 1e12) ts *= 1000; // seconds from Python
      ts = Math.min(Math.round(ts), t + 60_000);
      const data = JSON.stringify(e.data && typeof e.data === 'object' ? e.data : {});
      if (data.length > 8000) continue;
      const r = run(
        'INSERT OR IGNORE INTO spin_events (id, listener_id, room, type, ts, data, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        l.id,
        l.room,
        type,
        ts,
        data,
        t,
      );
      n += Number(r.changes);
    }
    run('UPDATE listeners SET last_seen_at = ? WHERE id = ?', t, l.id);
  });
  if (n) scheduleProcessing();
  return n;
}

/* ---------- helpers ---------- */

/** "Purple Rain (2015 Remaster)" → "purple rain"; accents and punctuation ignored. */
export function norm(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/^the\s+/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const songKey = (artist: unknown, title: unknown) => {
  const t = norm(title);
  return t ? `${norm(artist)}|${t}` : '';
};

interface RoomState {
  state: string; // play | pause | stop | offline
  mode: string; // radio | file
  station: string;
  title: string;
  artist: string;
  album: string;
}

/** What this room's moOde was doing at time ts (null = unknown: no recent report). */
function roomStateAt(room: string, ts: number): RoomState | null {
  const ev = get<{ data: string; ts: number }>(
    "SELECT data, ts FROM spin_events WHERE room = ? AND type = 'room' AND ts <= ? ORDER BY ts DESC LIMIT 1",
    room,
    ts + 5_000,
  );
  if (!ev || ts - ev.ts > ROOM_STALE_MS) return null;
  const d = JSON.parse(ev.data) as Partial<RoomState>;
  return {
    state: String(d.state ?? ''),
    mode: String(d.mode ?? ''),
    station: String(d.station ?? ''),
    title: String(d.title ?? ''),
    artist: String(d.artist ?? ''),
    album: String(d.album ?? ''),
  };
}

/** Vinyl, CD, … of one of your copies. */
export function mediumOf(it: Pick<ItemRow, 'format' | 'format_text'>): string {
  const f = it.format;
  if (f === 'Vinyl') return 'vinyl';
  if (['CD', 'CDr', 'SACD', 'Hybrid'].includes(f)) return 'cd';
  if (f === 'Box Set' || f === 'All Media') return /Vinyl/.test(it.format_text) ? 'vinyl' : /CD/.test(it.format_text) ? 'cd' : 'other';
  return f.toLowerCase() || 'other';
}

interface Match {
  instanceId: number;
  releaseId: number;
  medium: string;
  ambiguous: boolean;
  alternatives: number[];
}

/** Which of your copies is this song from? Only copies in a format this room can play. */
export function matchCollection(artist: string, title: string, album: string, formats: Set<string>): Match | null {
  const a = norm(artist);
  const t = norm(title);
  const al = norm(album);
  if (!a || !t) return null;
  const words = (s: string) =>
    s
      .split(' ')
      .filter((w) => w.length > 1 || s.length <= 2)
      .slice(0, 6)
      .map((w) => `"${w}"*`)
      .join(' ');
  let rows: ItemRow[] = [];
  try {
    rows = all<ItemRow>(
      `SELECT * FROM items WHERE instance_id IN (SELECT rowid FROM search WHERE search MATCH ?) LIMIT 300`,
      `artist : (${words(a)})`,
    );
    if (!rows.length) {
      // Compilations and "featuring" credits: look for the title in the tracklists.
      rows = all<ItemRow>(
        `SELECT * FROM items WHERE instance_id IN (SELECT rowid FROM search WHERE search MATCH ?) LIMIT 300`,
        `tracks : (${words(t)})`,
      );
    }
  } catch {
    return null;
  }
  const scored: { row: ItemRow; score: number; medium: string }[] = [];
  for (const row of rows) {
    const medium = mediumOf(row);
    if (formats.size && !formats.has(medium)) continue;
    const ia = norm(row.artist);
    let artistScore = 0;
    if (ia === a) artistScore = 3;
    else if (ia && (ia.includes(a) || a.includes(ia))) artistScore = 2;
    const it = norm(row.title);
    let albumScore = 0;
    if (al && it === al) albumScore = 5;
    else if (al && it && (it.includes(al) || al.includes(it))) albumScore = 2;
    let trackScore = 0;
    for (const tr of releaseDetails(row.release_id)?.tracklist ?? []) {
      if (tr.heading) continue;
      const tt = norm(tr.title);
      const trackArtistOk = !tr.artists || norm(tr.artists).includes(a) || a.includes(norm(tr.artists));
      if (tt === t) trackScore = Math.max(trackScore, trackArtistOk ? 4 : 2);
      else if (tt && (tt.includes(t) || t.includes(tt)) && Math.min(tt.length, t.length) >= 4) trackScore = Math.max(trackScore, 2);
    }
    // Compilation found via its tracklist: the track artist stands in for the album artist.
    if (!artistScore && trackScore >= 4) artistScore = 2;
    const score = artistScore + albumScore + trackScore;
    if (artistScore && (albumScore || trackScore) && score >= 5) scored.push({ row, score, medium });
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y.score - x.score || x.row.discogs_rank - y.row.discogs_rank);
  const best = scored[0];
  const top = scored.filter((s) => s.score === best.score);
  return {
    instanceId: best.row.instance_id,
    releaseId: best.row.release_id,
    medium: best.medium,
    ambiguous: top.length > 1,
    alternatives: scored.slice(1, 6).map((s) => s.row.instance_id),
  };
}

interface Attribution {
  room: string;
  kind: 'physical' | 'streamed' | 'heard';
  detail: string;
  station: string | null;
  match: Match | null;
}

function attribute(heard: string[], ts: number, artist: string, title: string, album: string): Attribution {
  const rooms = roomInfo();
  const prio = (r: string) => rooms.get(r)?.priority ?? 0;
  const byPrio = [...new Set(heard)].sort((x, y) => prio(y) - prio(x));
  // A room that heard it is streaming from moOde → that stream.
  for (const r of byPrio) {
    const s = roomStateAt(r, ts);
    if (s?.state === 'play') return { room: r, kind: 'streamed', detail: s.mode || 'stream', station: s.station || null, match: null };
  }
  const room = byPrio[0];
  const match = matchCollection(artist, title, album, rooms.get(room)?.formats ?? new Set());
  if (match) return { room, kind: 'physical', detail: match.medium, station: null, match };
  return { room, kind: 'heard', detail: '', station: null, match: null };
}

interface PlayRow {
  id: number;
  room: string;
  kind: string;
  detail: string;
  station: string | null;
  started_at: number;
  ended_at: number | null;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  song_key: string;
  instance_id: number | null;
  release_id: number | null;
  confidence: string;
  heard_by: string;
  alternatives: string;
  mic_ids: string;
}

/* ---------- processing ---------- */

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleProcessing() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    processEvents();
  }, SETTLE_MS + 1_000);
  timer.unref();
}

export function startSpinsWorker() {
  setInterval(processEvents, 20_000).unref();
  processEvents();
}

export function processEvents(at = now()) {
  const todo = all<{ id: string; room: string; type: string; ts: number; data: string }>(
    'SELECT id, room, type, ts, data FROM spin_events WHERE processed = 0 AND received_at <= ? ORDER BY ts, received_at',
    at - SETTLE_MS,
  );
  for (const ev of todo) {
    try {
      tx(() => {
        const d = JSON.parse(ev.data) as Record<string, unknown>;
        if (ev.type === 'room') applyRoom(ev.room, ev.ts, d);
        else if (ev.type === 'mic') applyMic(ev.id, ev.room, ev.ts, d);
        else if (ev.type === 'mic_end') applyMicEnd(ev.ts, d);
        run('UPDATE spin_events SET processed = 1 WHERE id = ?', ev.id);
      });
    } catch (e) {
      console.error(`Spins: event ${ev.id} (${ev.type}) failed:`, (e as Error).message);
      run('UPDATE spin_events SET processed = 2 WHERE id = ?', ev.id);
    }
  }
  // A unit or player that went silent: close its session at the last sign of life.
  run('UPDATE room_sessions SET ended_at = last_seen_at WHERE ended_at IS NULL AND last_seen_at < ?', at - ROOM_STALE_MS);
  // Raw events are only needed for a while.
  run('DELETE FROM spin_events WHERE processed <> 0 AND ts < ?', at - 30 * 86_400_000);
}

function applyRoom(room: string, ts: number, d: Record<string, unknown>) {
  const state = String(d.state ?? '');
  const mode = String(d.mode ?? '') || 'file';
  const station = String(d.station ?? '');
  const playing = state === 'play';
  const open = get<{ id: number; mode: string; station: string; last_seen_at: number }>(
    'SELECT id, mode, station, last_seen_at FROM room_sessions WHERE room = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
    room,
  );
  const same = !!open && playing && open.mode === mode && open.station === station;
  if (open && !same) run('UPDATE room_sessions SET ended_at = ? WHERE id = ?', Math.max(ts, open.last_seen_at), open.id);
  if (playing && !same) {
    run('INSERT INTO room_sessions (room, mode, station, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', room, mode, station, ts, ts);
  } else if (same) {
    run('UPDATE room_sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?', ts, open!.id);
  }

  // Metadata from moOde: a streamed play the microphone may not have caught.
  if (!playing) {
    endOpenMetadataPlay(room, ts);
    return;
  }
  let artist = String(d.artist ?? '').trim();
  let title = String(d.title ?? '').trim();
  if (mode === 'radio') {
    // Radio sends "Artist - Title" in the title, or a show name, slogan or ad.
    if (!artist && / - /.test(title)) [artist, title] = [title.slice(0, title.indexOf(' - ')), title.slice(title.indexOf(' - ') + 3)];
    if (!artist || !title || /https?:|www\./i.test(title) || title.length > 120 || norm(title) === norm(station)) {
      endOpenMetadataPlay(room, ts);
      return;
    }
  }
  const key = songKey(artist, title);
  if (!key) return;
  const recent = get<PlayRow>(
    'SELECT * FROM plays WHERE room = ? AND song_key = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1',
    room,
    key,
    ts - 15 * 60_000,
  );
  if (recent) {
    // Heartbeat repeating the same song, or the microphone already logged it: just confirm.
    if (recent.confidence !== 'manual' && (recent.kind !== 'streamed' || !recent.confidence.includes('metadata'))) {
      run(
        "UPDATE plays SET kind = 'streamed', detail = ?, station = ?, instance_id = NULL, release_id = NULL, confidence = 'mic+metadata' WHERE id = ?",
        mode,
        station || null,
        recent.id,
      );
    }
    return;
  }
  if (mode === 'radio') {
    // The microphone heard something else on this radio at the same moment: it is right, the metadata isn't.
    const micPlay = get<{ id: number }>(
      "SELECT id FROM plays WHERE room = ? AND confidence LIKE 'mic%' AND started_at BETWEEN ? AND ?",
      room,
      ts - RADIO_CONFLICT_MS,
      ts + RADIO_CONFLICT_MS,
    );
    if (micPlay) return;
  }
  endOpenMetadataPlay(room, ts);
  run(
    `INSERT INTO plays (room, kind, detail, station, started_at, title, artist, album, song_key, confidence, created_at)
     VALUES (?, 'streamed', ?, ?, ?, ?, ?, ?, ?, 'metadata', ?)`,
    room,
    mode,
    station || null,
    ts,
    title,
    artist,
    String(d.album ?? ''),
    key,
    now(),
  );
}

function endOpenMetadataPlay(room: string, ts: number) {
  run(
    "UPDATE plays SET ended_at = ? WHERE room = ? AND confidence = 'metadata' AND ended_at IS NULL AND started_at < ? AND started_at > ?",
    ts,
    room,
    ts,
    ts - 60 * 60_000,
  );
}

function applyMic(eventId: string, room: string, ts: number, d: Record<string, unknown>) {
  const title = String(d.title ?? '').trim();
  const artist = String(d.artist ?? '').trim();
  const album = String(d.album ?? '').trim();
  const key = songKey(artist, title);
  if (!key) return;

  // The same song reported by another room (or again): one play.
  const existing = get<PlayRow>(
    'SELECT * FROM plays WHERE song_key = ? AND started_at BETWEEN ? AND ? ORDER BY ABS(started_at - ?) LIMIT 1',
    key,
    ts - SAME_SONG_MS,
    ts + SAME_SONG_MS,
    ts,
  );
  if (existing) {
    const heard = [...new Set([...(JSON.parse(existing.heard_by) as string[]), room])];
    const micIds = [...(JSON.parse(existing.mic_ids) as string[]), eventId];
    const start = Math.min(existing.started_at, ts);
    if (existing.confidence === 'metadata' || existing.confidence === 'mic+metadata') {
      // moOde already said it's streaming there: keep that, just note the confirmation.
      run("UPDATE plays SET heard_by = ?, mic_ids = ?, confidence = 'mic+metadata', cover = COALESCE(cover, ?) WHERE id = ?",
        JSON.stringify(heard), JSON.stringify(micIds), (d.cover as string) || null, existing.id);
      return;
    }
    if (existing.confidence === 'manual') {
      run('UPDATE plays SET heard_by = ?, mic_ids = ? WHERE id = ?', JSON.stringify(heard), JSON.stringify(micIds), existing.id);
      return;
    }
    const a = attribute(heard, start, existing.artist, existing.title, existing.album || album);
    savePlay(existing.id, a, {
      start,
      heard,
      micIds,
      title: existing.title,
      artist: existing.artist,
      album: existing.album || album,
      cover: existing.cover || (d.cover as string) || null,
      key,
    });
    return;
  }

  const a = attribute([room], ts, artist, title, album);
  if (a.kind === 'streamed' && a.detail === 'radio') {
    // Radio metadata that disagrees with what the microphone heard: drop it.
    run(
      "DELETE FROM plays WHERE room = ? AND confidence = 'metadata' AND detail = 'radio' AND song_key <> ? AND started_at BETWEEN ? AND ?",
      a.room,
      key,
      ts - RADIO_CONFLICT_MS,
      ts + RADIO_CONFLICT_MS,
    );
  }
  savePlay(null, a, { start: ts, heard: [room], micIds: [eventId], title, artist, album, cover: (d.cover as string) || null, key });
}

function savePlay(
  id: number | null,
  a: Attribution,
  p: { start: number; heard: string[]; micIds: string[]; title: string; artist: string; album: string; cover: string | null; key: string },
) {
  const confidence = a.match?.ambiguous ? 'ambiguous' : 'mic';
  const values = [
    a.room,
    a.kind,
    a.detail,
    a.station,
    p.start,
    p.title,
    p.artist,
    p.album,
    p.cover,
    p.key,
    a.match?.instanceId ?? null,
    a.match?.releaseId ?? null,
    confidence,
    JSON.stringify(p.heard),
    JSON.stringify(a.match?.alternatives ?? []),
    JSON.stringify(p.micIds),
  ] as const;
  if (id == null) {
    run(
      `INSERT INTO plays (room, kind, detail, station, started_at, title, artist, album, cover, song_key, instance_id, release_id,
         confidence, heard_by, alternatives, mic_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      now(),
    );
  } else {
    run(
      `UPDATE plays SET room = ?, kind = ?, detail = ?, station = ?, started_at = ?, title = ?, artist = ?, album = ?, cover = ?,
         song_key = ?, instance_id = ?, release_id = ?, confidence = ?, heard_by = ?, alternatives = ?, mic_ids = ? WHERE id = ?`,
      ...values,
      id,
    );
  }
}

function applyMicEnd(ts: number, d: Record<string, unknown>) {
  const micId = String(d.mic_id ?? '');
  if (!micId) return;
  run(
    'UPDATE plays SET ended_at = MAX(COALESCE(ended_at, 0), ?) WHERE mic_ids LIKE ? AND started_at > ?',
    ts,
    `%"${micId.replace(/[%_"]/g, '')}"%`,
    ts - 3 * 3600_000,
  );
}

/* ---------- reading ---------- */

export interface PlayView {
  id: number;
  room: string;
  kind: string;
  detail: string;
  station: string | null;
  startedAt: number;
  endedAt: number | null;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  instanceId: number | null;
  record: { id: number; artist: string; title: string; year: number | null } | null;
  confidence: string;
  heardBy: string[];
}

function view(rows: PlayRow[]): PlayView[] {
  const ids = [...new Set(rows.map((r) => r.instance_id).filter((x): x is number => x != null))];
  const items = new Map(
    (ids.length ? all<ItemRow>(`SELECT * FROM items WHERE instance_id IN (${ids.join(',')})`) : []).map((i) => [i.instance_id, i]),
  );
  return rows.map((r) => {
    const it = r.instance_id != null ? items.get(r.instance_id) : undefined;
    return {
      id: r.id,
      room: r.room,
      kind: r.kind,
      detail: r.detail,
      station: r.station,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      title: r.title,
      artist: r.artist,
      album: r.album,
      cover: (it ? coverFiles(it.cover).small : null) ?? r.cover,
      instanceId: it ? r.instance_id : null,
      record: it ? { id: it.instance_id, artist: it.artist, title: it.title, year: it.orig_year ?? it.year } : null,
      confidence: r.confidence,
      heardBy: JSON.parse(r.heard_by),
    };
  });
}

export function listPlays(f: { kind?: string; room?: string; limit: number; offset: number }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.kind && ['physical', 'streamed', 'heard'].includes(f.kind)) {
    where.push('kind = ?');
    params.push(f.kind);
  }
  if (f.room) {
    where.push('room = ?');
    params.push(f.room);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM plays ${w}`, ...params)!.n;
  const rows = all<PlayRow>(`SELECT * FROM plays ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`, ...params, f.limit, f.offset);
  return { total, plays: view(rows) };
}

export interface Spin {
  instanceId: number;
  room: string;
  medium: string;
  startedAt: number;
  endedAt: number;
  tracks: number;
}

/** Group physical plays into spins: the same copy in the same room without a long gap. */
function groupSpins(rows: Pick<PlayRow, 'instance_id' | 'room' | 'detail' | 'started_at' | 'ended_at'>[]): Spin[] {
  const spins: Spin[] = [];
  const open = new Map<string, Spin>();
  for (const r of [...rows].sort((a, b) => a.started_at - b.started_at)) {
    if (r.instance_id == null) continue;
    const k = `${r.room}|${r.instance_id}`;
    const end = r.ended_at ?? r.started_at + TRACK_GUESS_MS;
    const s = open.get(k);
    if (s && r.started_at - s.endedAt < SPIN_GAP_MS) {
      s.endedAt = Math.max(s.endedAt, end);
      s.tracks++;
    } else {
      const n: Spin = { instanceId: r.instance_id, room: r.room, medium: r.detail, startedAt: r.started_at, endedAt: end, tracks: 1 };
      spins.push(n);
      open.set(k, n);
    }
  }
  return spins.reverse();
}

export function recentSpins(limit: number, room?: string) {
  const rows = all<PlayRow>(
    `SELECT * FROM plays WHERE kind = 'physical' AND instance_id IS NOT NULL ${room ? 'AND room = ?' : ''} ORDER BY started_at DESC LIMIT 1000`,
    ...(room ? [room] : []),
  );
  const spins = groupSpins(rows).slice(0, limit);
  const ids = [...new Set(spins.map((s) => s.instanceId))];
  const items = new Map((ids.length ? all<ItemRow>(`SELECT * FROM items WHERE instance_id IN (${ids.join(',')})`) : []).map((i) => [i.instance_id, i]));
  return spins
    .filter((s) => items.has(s.instanceId))
    .map((s) => {
      const it = items.get(s.instanceId)!;
      return { ...s, record: { id: it.instance_id, artist: it.artist, title: it.title, year: it.orig_year ?? it.year, cover: coverFiles(it.cover).small } };
    });
}

/** How often one copy was put on (for the record page). */
export function playedStats(instanceId: number) {
  const rows = all<PlayRow>("SELECT * FROM plays WHERE kind = 'physical' AND instance_id = ? ORDER BY started_at", instanceId);
  const spins = groupSpins(rows);
  return { spins: spins.length, tracks: rows.length, last: spins[0] ? { at: spins[0].startedAt, room: spins[0].room } : null };
}

/** What is going on in each room right now. */
export function nowPlaying() {
  const t = now();
  const rooms = [...roomInfo().entries()].sort((a, b) => b[1].priority - a[1].priority).map(([r]) => r);
  return rooms.map((room) => {
    const session = get<{ mode: string; station: string; started_at: number; last_seen_at: number }>(
      'SELECT mode, station, started_at, last_seen_at FROM room_sessions WHERE room = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1',
      room,
    );
    const row = get<PlayRow>(
      'SELECT * FROM plays WHERE room = ? AND started_at > ? AND COALESCE(ended_at, started_at + ?) > ? ORDER BY started_at DESC LIMIT 1',
      room,
      t - 3 * 3600_000,
      TRACK_GUESS_MS,
      t - 2 * 60_000,
    );
    const seen = get<{ s: number | null }>('SELECT MAX(last_seen_at) AS s FROM listeners WHERE room = ?', room)?.s ?? null;
    return {
      room,
      online: !!seen && t - seen < ROOM_STALE_MS,
      session: session ? { mode: session.mode, station: session.station, startedAt: session.started_at } : null,
      play: row ? view([row])[0] : null,
    };
  });
}

/** Totals for a period (days back from now; 0 = everything). */
export function stats(days: number) {
  const since = days > 0 ? now() - days * 86_400_000 : 0;
  const t = now();
  const count = (kind: string) => get<{ n: number }>('SELECT COUNT(*) AS n FROM plays WHERE kind = ? AND started_at >= ?', kind, since)!.n;
  const physicalRows = all<PlayRow>("SELECT * FROM plays WHERE kind = 'physical' AND instance_id IS NOT NULL AND started_at >= ?", since);
  const spins = groupSpins(physicalRows);
  const byRecord = new Map<number, number>();
  for (const s of spins) byRecord.set(s.instanceId, (byRecord.get(s.instanceId) ?? 0) + 1);
  const topIds = [...byRecord.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const items = new Map(
    (topIds.length ? all<ItemRow>(`SELECT * FROM items WHERE instance_id IN (${topIds.map(([i]) => i).join(',')})`) : []).map((i) => [i.instance_id, i]),
  );
  const sessions = all<{ room: string; mode: string; station: string; hours: number }>(
    `SELECT room, mode, station, SUM(MIN(COALESCE(ended_at, ?), ?) - MAX(started_at, ?)) / 3600000.0 AS hours
     FROM room_sessions WHERE COALESCE(ended_at, ?) > ? GROUP BY room, mode, station ORDER BY hours DESC`,
    t,
    t,
    since,
    t,
    since,
  );
  return {
    days,
    physical: { spins: spins.length, tracks: count('physical'), vinylHours: spins.filter((s) => s.medium === 'vinyl').reduce((h, s) => h + (s.endedAt - s.startedAt) / 3600_000, 0) },
    streamed: { tracks: count('streamed') },
    heard: { tracks: count('heard') },
    radio: sessions.filter((s) => s.mode === 'radio').slice(0, 10).map((s) => ({ room: s.room, station: s.station || 'Radio', hours: s.hours })),
    streamingHours: sessions.reduce((h, s) => h + s.hours, 0),
    topArtists: all<{ artist: string; n: number }>(
      "SELECT MAX(artist) AS artist, COUNT(*) AS n FROM plays WHERE kind <> 'heard' AND artist <> '' AND started_at >= ? GROUP BY lower(artist) ORDER BY n DESC LIMIT 10",
      since,
    ),
    topRecords: topIds
      .filter(([i]) => items.has(i))
      .map(([i, n]) => {
        const it = items.get(i)!;
        return { id: i, artist: it.artist, title: it.title, cover: coverFiles(it.cover).small, spins: n };
      }),
    rooms: all<{ room: string; kind: string; n: number }>('SELECT room, kind, COUNT(*) AS n FROM plays WHERE started_at >= ? GROUP BY room, kind', since),
  };
}

/** Owner corrections from the Spins page. */
export function deletePlay(id: number) {
  run('DELETE FROM plays WHERE id = ?', id);
}

export function markHeard(id: number) {
  run("UPDATE plays SET kind = 'heard', detail = '', instance_id = NULL, release_id = NULL, confidence = 'manual' WHERE id = ?", id);
}

export function setPlayRecord(id: number, instanceId: number) {
  const it = get<ItemRow>('SELECT * FROM items WHERE instance_id = ?', instanceId);
  if (!it) return false;
  run(
    "UPDATE plays SET kind = 'physical', detail = ?, instance_id = ?, release_id = ?, confidence = 'manual' WHERE id = ?",
    mediumOf(it),
    it.instance_id,
    it.release_id,
    id,
  );
  return true;
}
