// Discogs API client and the collection sync.
// Rate limit: 60 requests/minute with a token. We stay at ~1/second and back off on 429.

import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DISCOGS_TOKEN, DISCOGS_USER, USER_AGENT } from './config.ts';
import { all, COVER_DIR, get, getSetting, indexItem, now, run, setSetting, tx, type ItemRow } from './db.ts';
import { invalidateShelves } from './shelves.ts';

const API = 'https://api.discogs.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;

async function discogs<T>(path: string): Promise<T> {
  if (!DISCOGS_TOKEN) throw new Error('DISCOGS_TOKEN is not set.');
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      headers: { Authorization: `Discogs token=${DISCOGS_TOKEN}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(15_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discogs ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

/* ---------- types (only what we use) ---------- */

interface DFormat {
  name: string;
  qty: string;
  text?: string;
  descriptions?: string[];
}
interface DArtist {
  name: string;
  anv?: string;
  join?: string;
}
interface DCollectionItem {
  id: number;
  instance_id: number;
  folder_id: number;
  rating: number;
  date_added: string;
  notes?: { field_id: number; value: string }[];
  basic_information: {
    id: number;
    master_id?: number;
    title: string;
    year: number;
    cover_image?: string;
    thumb?: string;
    formats?: DFormat[];
    labels?: { name: string; catno: string }[];
    artists?: DArtist[];
    genres?: string[];
    styles?: string[];
  };
}
interface DPage {
  pagination: { page: number; pages: number; items: number };
  releases: DCollectionItem[];
}

/* ---------- helpers ---------- */

/** "Prince (2)" → "Prince" (Discogs adds numbers to tell artists with the same name apart). */
export const cleanName = (n: string) => n.replace(/\s\(\d+\)$/, '').trim();

export function artistLine(artists: DArtist[] = []) {
  let s = '';
  artists.forEach((a, i) => {
    s += cleanName(a.anv || a.name);
    if (i < artists.length - 1) s += a.join && a.join !== ',' ? ` ${a.join} ` : a.join === ',' ? ', ' : ' & ';
  });
  return s || 'Unknown artist';
}

export function formatInfo(formats: DFormat[] = []) {
  const main = formats.find((f) => f.name !== 'Box Set' && f.name !== 'All Media') ?? formats[0];
  const isBox = formats.some((f) => f.name === 'Box Set');
  const name = isBox ? 'Box Set' : (main?.name ?? '');
  const desc = main?.descriptions ?? [];
  const size = main?.name === 'Vinyl' ? (desc.find((d) => /^\d+"$/.test(d)) ?? (desc.includes('LP') ? '12"' : '')) : '';
  const discs = formats
    .filter((f) => f.name !== 'Box Set' && f.name !== 'All Media')
    .reduce((n, f) => n + (Number(f.qty) || 1), 0) || 1;
  const text = formats
    .map((f) => [`${Number(f.qty) > 1 ? f.qty + '×' : ''}${f.name}`, ...(f.descriptions ?? []), f.text ?? ''].filter(Boolean).join(', '))
    .join(' + ');
  return { name, size, discs, text };
}

/* ---------- sync state ---------- */

export interface SyncStatus {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  startedAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  username: string | null;
  count: number;
}

const status: SyncStatus = {
  running: false,
  phase: '',
  done: 0,
  total: 0,
  startedAt: null,
  lastSyncAt: getSetting<number | null>('lastSyncAt', null),
  lastError: getSetting<string | null>('lastSyncError', null),
  username: getSetting<string | null>('discogsUser', null),
  count: 0,
};

/** Called after every successful sync (JPlay Spins matches earlier plays again). */
export const afterSync: (() => void)[] = [];

export function syncStatus(): SyncStatus {
  return { ...status, count: get<{ n: number }>('SELECT COUNT(*) AS n FROM items')!.n };
}

/** The Discogs custom fields of this collection (for picking the "Location" field). */
export function customFields(): { id: number; name: string }[] {
  return getSetting('discogsFields', []);
}

/* ---------- covers ---------- */

let sharpMod: typeof import('sharp') | null | undefined;
async function sharp() {
  if (sharpMod === undefined) {
    try {
      sharpMod = (await import('sharp')).default as unknown as typeof import('sharp');
    } catch (e) {
      console.warn('sharp is not available, covers are kept at full size:', (e as Error).message);
      sharpMod = null;
    }
  }
  return sharpMod;
}

/** Downloads one cover: <stem>.jpg (as delivered, ~600px) and <stem>-s.webp (grid size). */
async function fetchCover(it: Pick<ItemRow, 'instance_id' | 'release_id' | 'cover_url'>) {
  if (!it.cover_url) return;
  const stem = String(it.release_id);
  const res = await fetch(it.cover_url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`cover ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(join(COVER_DIR, `${stem}.jpg`), buf);
  const s = await sharp();
  if (s) {
    await s(buf).resize(360, 360, { fit: 'cover' }).webp({ quality: 78 }).toFile(join(COVER_DIR, `${stem}-s.webp`));
  }
  run('UPDATE items SET cover = ? WHERE release_id = ?', stem, it.release_id);
}

export function coverFiles(stem: string | null) {
  if (!stem) return { small: null, large: null };
  const small = existsSync(join(COVER_DIR, `${stem}-s.webp`)) ? `/covers/${stem}-s.webp` : `/covers/${stem}.jpg`;
  return { small, large: `/covers/${stem}.jpg` };
}

/* ---------- release details ---------- */

interface DRelease {
  id: number;
  title: string;
  year?: number;
  released?: string;
  country?: string;
  notes?: string;
  uri?: string;
  tracklist?: { position: string; title: string; duration: string; type_: string; artists?: DArtist[] }[];
  extraartists?: { name: string; anv?: string; role: string }[];
  identifiers?: { type: string; value: string; description?: string }[];
}

export interface ReleaseDetails {
  country: string | null;
  released: string | null;
  notes: string | null;
  url: string | null;
  tracklist: { position: string; title: string; duration: string; heading: boolean; artists?: string }[];
  credits: { name: string; role: string }[];
  barcodes: string[];
}

export async function fetchRelease(releaseId: number): Promise<ReleaseDetails> {
  const r = await discogs<DRelease>(`/releases/${releaseId}`);
  const details: ReleaseDetails = {
    country: r.country ?? null,
    released: r.released ?? null,
    notes: r.notes ? r.notes.slice(0, 4000) : null,
    url: r.uri ?? `https://www.discogs.com/release/${releaseId}`,
    tracklist: (r.tracklist ?? []).map((t) => ({
      position: t.position,
      title: t.title,
      duration: t.duration,
      heading: t.type_ === 'heading',
      ...(t.artists?.length ? { artists: artistLine(t.artists) } : {}),
    })),
    credits: (r.extraartists ?? []).slice(0, 60).map((a) => ({ name: cleanName(a.anv || a.name), role: a.role })),
    barcodes: (r.identifiers ?? []).filter((i) => i.type === 'Barcode').map((i) => i.value.replace(/\s/g, '')),
  };
  run(
    'INSERT INTO releases (release_id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(release_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
    releaseId,
    JSON.stringify(details),
    now(),
  );
  for (const { instance_id } of all<{ instance_id: number }>('SELECT instance_id FROM items WHERE release_id = ?', releaseId)) {
    indexItem(instance_id);
  }
  return details;
}

export function releaseDetails(releaseId: number): ReleaseDetails | null {
  const row = get<{ data: string }>('SELECT data FROM releases WHERE release_id = ?', releaseId);
  return row ? (JSON.parse(row.data) as ReleaseDetails) : null;
}

/* ---------- the sync ---------- */

export function startSync(reason: string): boolean {
  if (status.running) return false;
  void runSync(reason);
  return true;
}

async function runSync(reason: string) {
  Object.assign(status, { running: true, phase: 'Connecting to Discogs', done: 0, total: 0, startedAt: now(), lastError: null });
  console.log(`Sync started (${reason})`);
  try {
    let username = DISCOGS_USER;
    if (!username) {
      const me = await discogs<{ username: string }>('/oauth/identity');
      username = me.username;
    }
    status.username = username;
    setSetting('discogsUser', username);
    const u = encodeURIComponent(username);

    // Custom fields (Media Condition, Notes, and your own such as "Location").
    const f = await discogs<{ fields: { id: number; name: string }[] }>(`/users/${u}/collection/fields`);
    const fields = f.fields.map((x) => ({ id: x.id, name: x.name }));
    setSetting('discogsFields', fields);
    const fieldName = new Map(fields.map((x) => [x.id, x.name]));

    // The whole collection ("All" folder), in Discogs' own artist order = the shelf order.
    status.phase = 'Reading your collection';
    const seen: DCollectionItem[] = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      const p = await discogs<DPage>(`/users/${u}/collection/folders/0/releases?sort=artist&sort_order=asc&per_page=100&page=${page}`);
      pages = p.pagination.pages;
      status.total = p.pagination.items;
      seen.push(...p.releases);
      status.done = seen.length;
    }

    status.phase = 'Saving';
    const t = now();
    const changedCovers: Pick<ItemRow, 'instance_id' | 'release_id' | 'cover_url'>[] = [];
    tx(() => {
      const upsert = `INSERT INTO items (instance_id, release_id, folder_id, artist, title, year, format, size, discs, format_text, labels,
          genres, styles, fields, rating, date_added, cover_url, discogs_rank, synced_at, master_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id) DO UPDATE SET release_id = excluded.release_id, folder_id = excluded.folder_id,
          artist = excluded.artist, title = excluded.title, year = excluded.year, master_id = excluded.master_id,
          format = excluded.format, size = excluded.size,
          discs = excluded.discs, format_text = excluded.format_text, labels = excluded.labels, genres = excluded.genres,
          styles = excluded.styles, fields = excluded.fields, rating = excluded.rating, date_added = excluded.date_added,
          cover_url = excluded.cover_url, discogs_rank = excluded.discogs_rank, synced_at = excluded.synced_at`;
      seen.forEach((it, rank) => {
        const b = it.basic_information;
        const fi = formatInfo(b.formats);
        const notes: Record<string, string> = {};
        for (const n of it.notes ?? []) if (n.value?.trim()) notes[fieldName.get(n.field_id) ?? `Field ${n.field_id}`] = n.value.trim();
        const cover = b.cover_image && !b.cover_image.includes('spacer.gif') ? b.cover_image : null;
        const old = get<{ cover_url: string | null; cover: string | null }>('SELECT cover_url, cover FROM items WHERE instance_id = ?', it.instance_id);
        run(
          upsert,
          it.instance_id,
          b.id,
          it.folder_id,
          artistLine(b.artists),
          b.title,
          b.year || null,
          fi.name,
          fi.size,
          fi.discs,
          fi.text,
          (b.labels ?? []).map((l) => `${cleanName(l.name)}${l.catno && l.catno !== 'none' ? ' – ' + l.catno : ''}`).join(', '),
          JSON.stringify(b.genres ?? []),
          JSON.stringify(b.styles ?? []),
          JSON.stringify(notes),
          it.rating || 0,
          it.date_added,
          cover,
          rank,
          t,
          b.master_id || null,
        );
        const coverMissing = !old?.cover || !existsSync(join(COVER_DIR, `${old.cover}.jpg`));
        if (cover && (coverMissing || old?.cover_url !== cover)) changedCovers.push({ instance_id: it.instance_id, release_id: b.id, cover_url: cover });
        else if (old?.cover) run('UPDATE items SET cover = ? WHERE instance_id = ?', old.cover, it.instance_id);
      });
      // Sold or removed in Discogs: gone here too.
      run('DELETE FROM items WHERE synced_at <> ?', t);
      run('DELETE FROM search WHERE rowid NOT IN (SELECT instance_id FROM items)');
      applyOriginalYears();
      for (const it of seen) indexItem(it.instance_id);
    });
    invalidateShelves();

    // Covers, two at a time (images come from Discogs' CDN, not the rate-limited API).
    status.phase = 'Downloading covers';
    const uniq = [...new Map(changedCovers.map((c) => [c.release_id, c])).values()];
    status.done = 0;
    status.total = uniq.length;
    let i = 0;
    await Promise.all(
      [0, 1].map(async () => {
        while (i < uniq.length) {
          const c = uniq[i++];
          try {
            await fetchCover(c);
          } catch (e) {
            console.warn(`Cover for release ${c.release_id}: ${(e as Error).message}`);
          }
          status.done++;
          await sleep(150);
        }
      }),
    );

    // Original release years: one request per master we haven't seen yet (~1/second).
    const masters = all<{ master_id: number }>(
      'SELECT DISTINCT master_id FROM items WHERE master_id IS NOT NULL AND master_id NOT IN (SELECT master_id FROM masters)',
    );
    status.phase = 'Fetching original release years';
    status.done = 0;
    status.total = masters.length;
    for (const m of masters) {
      try {
        const r = await discogs<{ year?: number }>(`/masters/${m.master_id}`);
        run('INSERT OR REPLACE INTO masters (master_id, year, fetched_at) VALUES (?, ?, ?)', m.master_id, r.year || null, now());
      } catch (e) {
        console.warn(`Master ${m.master_id}: ${(e as Error).message}`);
      }
      status.done++;
    }
    if (masters.length) {
      tx(() => {
        applyOriginalYears();
        for (const { instance_id } of all<{ instance_id: number }>('SELECT instance_id FROM items')) indexItem(instance_id);
      });
    }

    // Tracklists for search, for releases we haven't fetched yet (~1/second).
    const missing = all<{ release_id: number }>(
      'SELECT DISTINCT release_id FROM items WHERE release_id NOT IN (SELECT release_id FROM releases)',
    );
    status.phase = 'Fetching tracklists';
    status.done = 0;
    status.total = missing.length;
    for (const m of missing) {
      try {
        await fetchRelease(m.release_id);
      } catch (e) {
        console.warn(`Release ${m.release_id}: ${(e as Error).message}`);
      }
      status.done++;
    }

    // Clean up covers of releases no longer in the collection.
    const keep = new Set(all<{ cover: string }>('SELECT DISTINCT cover FROM items WHERE cover IS NOT NULL').map((r) => r.cover));
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(COVER_DIR)) {
      const stem = file.replace(/(-s)?\.(jpg|webp)$/, '');
      if (!keep.has(stem)) await rm(join(COVER_DIR, file), { force: true });
    }
    run('DELETE FROM releases WHERE release_id NOT IN (SELECT release_id FROM items)');

    status.lastSyncAt = now();
    setSetting('lastSyncAt', status.lastSyncAt);
    setSetting('lastSyncError', null);
    for (const fn of afterSync) {
      try {
        fn();
      } catch (e) {
        console.error('After-sync step failed:', (e as Error).message);
      }
    }
    console.log(`Sync done: ${seen.length} items, ${uniq.length} new covers, ${missing.length} tracklists`);
  } catch (e) {
    status.lastError = (e as Error).message;
    setSetting('lastSyncError', status.lastError);
    console.error('Sync failed:', status.lastError);
  } finally {
    status.running = false;
    status.phase = '';
  }
}

/** Copies the master's (original) year onto each item; NULL when unknown, so the pressing year is shown instead. */
function applyOriginalYears() {
  run('UPDATE items SET orig_year = (SELECT m.year FROM masters m WHERE m.master_id = items.master_id AND m.year > 0)');
}

/** Runs the sync once a day at SYNC_TIME (local time in TZ). */
export function scheduleNightly(time: string, tz: string) {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return;
  let lastDay = '';
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' });
  const [hh, mm] = time.split(':').map(Number);
  setInterval(() => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (Number(parts.hour) === hh && Number(parts.minute) === mm && day !== lastDay) {
      lastDay = day;
      startSync('nightly');
    }
  }, 30_000).unref();
}
