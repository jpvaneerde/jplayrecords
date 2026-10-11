import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { access, newDevice, requireAdmin, requireViewer, type Env } from '../auth.ts';
import { DISCOGS_TOKEN, JPLAY_API, JPLAY_LOGIN_URL, PUBLIC_URL, SYNC_TIME, TZ } from '../config.ts';
import { all, get, getSetting, run, setSetting, type ItemRow } from '../db.ts';
import { coverFiles, customFields, fetchRelease, releaseDetails, startSync, syncStatus } from '../discogs.ts';
import {
  compartmentMembers,
  grids,
  neighbours,
  positionOf,
  saveShelfConfig,
  shelfConfig,
  type Run,
  type ShelfConfig,
} from '../shelves.ts';

const bad = (msg: string, status: 400 | 404 = 400) => new HTTPException(status, { message: msg });

/* ---------- display settings (kiosk behaviour) ---------- */

export interface Display {
  idleSeconds: number; // back to the start screen after this long without a touch (0 = never)
  screensaver: boolean; // cover wall when idle
  keyboard: 'auto' | 'always' | 'never'; // on-screen keyboard: auto = on kiosk screens
  tile: 's' | 'm' | 'l';
  theme: 'dark' | 'light' | 'retro';
}
const DEFAULT_DISPLAY: Display = { idleSeconds: 180, screensaver: true, keyboard: 'auto', tile: 'm', theme: 'dark' };
const display = (): Display => ({ ...DEFAULT_DISPLAY, ...getSetting<Partial<Display>>('display', {}) });

/* ---------- listing helpers ---------- */

const FORMAT_KEY = `CASE WHEN format = 'Vinyl' AND size <> '' THEN 'Vinyl ' || size ELSE format END`;
// Initial for the A–Z bar: ignore a leading "The ", digits and symbols go under "#".
const INITIAL = `CASE WHEN upper(substr(CASE WHEN artist LIKE 'The %' THEN substr(artist, 5) ELSE artist END, 1, 1)) BETWEEN 'A' AND 'Z'
  THEN upper(substr(CASE WHEN artist LIKE 'The %' THEN substr(artist, 5) ELSE artist END, 1, 1)) ELSE '#' END`;

export function formatLabel(key: string) {
  const m: Record<string, string> = { 'Vinyl 12"': 'LP / 12"', 'Vinyl 10"': '10"', 'Vinyl 7"': '7" single', Vinyl: 'Vinyl' };
  return m[key] ?? key;
}

function listItem(r: ItemRow) {
  return {
    id: r.instance_id,
    releaseId: r.release_id,
    artist: r.artist,
    title: r.title,
    year: r.year,
    format: formatLabel(r.format === 'Vinyl' && r.size ? `Vinyl ${r.size}` : r.format),
    cover: coverFiles(r.cover).small,
  };
}

/** Turns typed text into an FTS5 query: every word must match the start of a word. */
function ftsQuery(q: string) {
  const words = q
    .normalize('NFKC')
    .replace(/["*()^:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

function filters(qp: (k: string) => string | undefined) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const q = qp('q')?.trim();
  if (q) {
    const fts = ftsQuery(q);
    if (fts) {
      where.push('items.instance_id IN (SELECT rowid FROM search WHERE search MATCH ?)');
      params.push(fts);
    }
  }
  const format = qp('format');
  if (format) {
    where.push(`${FORMAT_KEY} = ?`);
    params.push(format);
  }
  const genre = qp('genre');
  if (genre) {
    where.push('(EXISTS (SELECT 1 FROM json_each(genres) WHERE value = ?) OR EXISTS (SELECT 1 FROM json_each(styles) WHERE value = ?))');
    params.push(genre, genre);
  }
  const decade = qp('decade');
  if (decade === 'unknown') where.push('year IS NULL');
  else if (decade && /^\d{4}$/.test(decade)) {
    where.push('year BETWEEN ? AND ?');
    params.push(Number(decade), Number(decade) + 9);
  }
  const artist = qp('artist');
  if (artist) {
    where.push('artist = ?');
    params.push(artist);
  }
  const letter = qp('letter');
  if (letter && /^([A-Z]|#)$/.test(letter)) {
    where.push(`${INITIAL} = ?`);
    params.push(letter);
  }
  const shelf = qp('shelf'); // "<run>:<compartment>"
  if (shelf && /^[\w-]+:-?\d+$/.test(shelf)) {
    const [r, c] = shelf.split(':');
    const ids = compartmentMembers(r, Number(c));
    where.push(`items.instance_id IN (${ids.length ? ids.join(',') : '-1'})`);
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params, q };
}

function orderBy(sort: string | undefined, q: string | undefined) {
  switch (sort) {
    case 'added':
      return 'ORDER BY date_added DESC';
    case 'year':
      return 'ORDER BY year IS NULL, year, discogs_rank';
    case 'year-desc':
      return 'ORDER BY year IS NULL, year DESC, discogs_rank';
    case 'title':
      return 'ORDER BY title COLLATE NOCASE';
    default:
      // With a search: best matches first (artist and title weigh most), else shelf order.
      return q && sort !== 'shelf'
        ? `ORDER BY (SELECT bm25(search, 10.0, 6.0, 2.0, 1.0, 1.0) FROM search WHERE search.rowid = items.instance_id AND search MATCH '${ftsQuery(q).replace(/'/g, "''")}'), discogs_rank`
        : 'ORDER BY discogs_rank';
  }
}

/* ---------- public: who am I ---------- */

export const session = new Hono();

session.get('/', async (c) => {
  const a = await access(c);
  return c.json({
    role: a?.role ?? null,
    name: a?.name ?? null,
    via: a?.via ?? null,
    loginUrl: JPLAY_API ? JPLAY_LOGIN_URL : null,
    display: display(),
  });
});

/* ---------- browsing (viewer) ---------- */

export const records = new Hono<Env>();
records.use('*', requireViewer);

records.get('/', (c) => {
  const { where, params, q } = filters((k) => c.req.query(k));
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 120, 1), 300);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM items ${where}`, ...params)!.n;
  const rows = all<ItemRow>(`SELECT * FROM items ${where} ${orderBy(c.req.query('sort'), q)} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return c.json({ total, offset, items: rows.map(listItem) });
});

records.get('/random', (c) => {
  const { where, params } = filters((k) => c.req.query(k));
  const row = get<{ instance_id: number }>(`SELECT instance_id FROM items ${where} ORDER BY random() LIMIT 1`, ...params);
  if (!row) throw bad('Nothing matches these filters.', 404);
  return c.json({ id: row.instance_id });
});

/** Random covers for the screensaver. */
records.get('/wall', (c) => {
  const n = Math.min(Number(c.req.query('n')) || 60, 200);
  const rows = all<ItemRow>('SELECT * FROM items WHERE cover IS NOT NULL ORDER BY random() LIMIT ?', n);
  return c.json({ items: rows.map(listItem) });
});

records.get('/facets', (c) => {
  const formats = all<{ key: string; n: number }>(`SELECT ${FORMAT_KEY} AS key, COUNT(*) AS n FROM items GROUP BY key ORDER BY n DESC`);
  const genres = all<{ key: string; n: number }>(
    `SELECT value AS key, COUNT(*) AS n FROM items, json_each(items.genres) GROUP BY value ORDER BY n DESC`,
  );
  const styles = all<{ key: string; n: number }>(
    `SELECT value AS key, COUNT(*) AS n FROM items, json_each(items.styles) GROUP BY value HAVING n >= 3 ORDER BY n DESC LIMIT 40`,
  );
  const decades = all<{ key: string; n: number }>(
    `SELECT CASE WHEN year IS NULL THEN 'unknown' ELSE CAST(year / 10 * 10 AS TEXT) END AS key, COUNT(*) AS n FROM items GROUP BY key ORDER BY key`,
  );
  const letters = all<{ key: string; n: number }>(`SELECT ${INITIAL} AS key, COUNT(*) AS n FROM items GROUP BY key ORDER BY key`);
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM items')!.n;
  return c.json({
    total,
    formats: formats.map((f) => ({ ...f, label: formatLabel(f.key) })),
    genres,
    styles,
    decades: decades.map((d) => ({ ...d, label: d.key === 'unknown' ? 'Unknown' : `${d.key.slice(2)}s` })),
    letters,
  });
});

records.get('/artists', (c) => {
  const letter = c.req.query('letter');
  const rows = all<{ name: string; n: number }>(
    `SELECT artist AS name, COUNT(*) AS n, MIN(discogs_rank) AS r FROM items ${letter ? `WHERE ${INITIAL} = ?` : ''} GROUP BY artist ORDER BY r`,
    ...(letter ? [letter] : []),
  );
  return c.json({ artists: rows.map((r) => ({ name: r.name, n: r.n })) });
});

records.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const r = get<ItemRow>('SELECT * FROM items WHERE instance_id = ?', id);
  if (!r) throw bad('Not in the collection (any more).', 404);
  let details = releaseDetails(r.release_id);
  if (!details && DISCOGS_TOKEN) {
    try {
      details = await Promise.race([
        fetchRelease(r.release_id),
        new Promise<null>((res) => setTimeout(() => res(null), 6000)),
      ]);
    } catch {
      details = null;
    }
  }
  const position = positionOf(id);
  const nb = neighbours(id);
  const byIds = (ids: number[]) => {
    if (!ids.length) return [];
    const rows = all<ItemRow>(`SELECT * FROM items WHERE instance_id IN (${ids.join(',')})`);
    return ids.map((i) => rows.find((x) => x.instance_id === i)).filter(Boolean).map((x) => listItem(x!));
  };
  const grid = position?.run ? grids().find((g) => g.id === position.run) : null;
  const copies = get<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE release_id = ?', r.release_id)!.n;
  return c.json({
    item: {
      ...listItem(r),
      coverLarge: coverFiles(r.cover).large,
      formatText: r.format_text,
      labels: r.labels,
      genres: JSON.parse(r.genres),
      styles: JSON.parse(r.styles),
      fields: JSON.parse(r.fields),
      rating: r.rating,
      dateAdded: r.date_added,
      copies,
      discogsUrl: details?.url ?? `https://www.discogs.com/release/${r.release_id}`,
    },
    details,
    position,
    grid,
    neighbours: { before: byIds(nb.before), after: byIds(nb.after) },
  });
});

/* ---------- settings (admin) ---------- */

export const admin = new Hono<Env>();
admin.use('*', requireAdmin);

function devices() {
  return all<{ id: string; name: string; created_at: number; last_seen_at: number | null }>(
    'SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at',
  ).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at }));
}

admin.get('/', (c) =>
  c.json({
    sync: syncStatus(),
    tokenSet: !!DISCOGS_TOKEN,
    syncTime: SYNC_TIME,
    timeZone: TZ,
    fields: customFields(),
    shelves: shelfConfig(),
    grids: grids(),
    devices: devices(),
    display: display(),
  }),
);

admin.get('/sync', (c) => c.json(syncStatus()));

admin.post('/sync', (c) => {
  if (!DISCOGS_TOKEN) throw bad('DISCOGS_TOKEN is not set on the server.');
  const started = startSync('sync now');
  return c.json({ started, sync: syncStatus() });
});

const num = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

function cleanRun(r: Partial<Run>, i: number): Run {
  const strs = (a: unknown) => (Array.isArray(a) ? a.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : []);
  return {
    id: String(r.id || `run${i}`).replace(/[^\w-]/g, '').slice(0, 20) || `run${i}`,
    name: String(r.name || 'Shelf').slice(0, 40),
    formats: strs(r.formats),
    sizes: strs(r.sizes),
    rows: Math.round(num(r.rows, 1, 30, 1)),
    cols: Math.round(num(r.cols, 1, 20, 1)),
    compartmentMm: num(r.compartmentMm, 50, 20000, 560),
    order: r.order === 'columns' ? 'columns' : 'rows',
    start: r.start === 'bottom' ? 'bottom' : 'top',
    itemMm: num(r.itemMm, 0.5, 100, 4),
    extraDiscMm: num(r.extraDiscMm, 0, 100, 3),
    spreadOver: r.spreadOver == null || (r.spreadOver as unknown) === '' ? null : Math.round(num(r.spreadOver, 1, 600, 1)),
  };
}

admin.put('/shelves', async (c) => {
  const b = await c.req.json<Partial<ShelfConfig>>();
  const runs = (Array.isArray(b.runs) ? b.runs : []).slice(0, 20).map(cleanRun);
  if (!runs.length) throw bad('Keep at least one shelf.');
  if (new Set(runs.map((r) => r.id)).size !== runs.length) throw bad('Two shelves have the same id.');
  const cfg: ShelfConfig = {
    source: b.source === 'computed' || b.source === 'field' ? b.source : 'auto',
    fieldName: String(b.fieldName ?? 'Location').slice(0, 60),
    runs,
    anchors: shelfConfig().anchors,
  };
  saveShelfConfig(cfg);
  return c.json({ shelves: shelfConfig(), grids: grids() });
});

/** "This record is the first one in compartment X" — fixes drift in the computed positions. */
admin.post('/anchors', async (c) => {
  const b = await c.req.json<{ id?: number; compartment?: number }>();
  const id = Number(b.id);
  const pos = positionOf(id);
  if (!pos?.run) throw bad('That record has no shelf.');
  const cfg = shelfConfig();
  const runCfg = cfg.runs.find((r) => r.id === pos.run);
  const compartment = Math.round(Number(b.compartment));
  if (!runCfg || !(compartment >= 0 && compartment < runCfg.rows * runCfg.cols)) throw bad('Pick a compartment.');
  cfg.anchors[String(id)] = { run: pos.run, compartment };
  saveShelfConfig(cfg);
  return c.json({ position: positionOf(id) });
});

admin.delete('/anchors/:id', (c) => {
  const cfg = shelfConfig();
  delete cfg.anchors[c.req.param('id')];
  saveShelfConfig(cfg);
  return c.json({ ok: true });
});

admin.get('/anchors', (c) => {
  const cfg = shelfConfig();
  const ids = Object.keys(cfg.anchors).map(Number).filter(Number.isFinite);
  const rows = ids.length ? all<ItemRow>(`SELECT * FROM items WHERE instance_id IN (${ids.join(',')})`) : [];
  return c.json({
    anchors: rows.map((r) => ({ ...listItem(r), ...cfg.anchors[String(r.instance_id)], label: positionOf(r.instance_id)?.label ?? '' })),
  });
});

admin.post('/devices', async (c) => {
  const b = await c.req.json<{ name?: string }>();
  const name = String(b.name ?? '').trim().slice(0, 40) || 'Record room';
  const { token } = newDevice(name);
  return c.json({ link: `${PUBLIC_URL}/d/${token}`, devices: devices() });
});

admin.delete('/devices/:id', (c) => {
  run('DELETE FROM devices WHERE id = ?', c.req.param('id'));
  return c.json({ devices: devices() });
});

admin.put('/display', async (c) => {
  const b = await c.req.json<Partial<Display>>();
  const d: Display = {
    idleSeconds: Math.round(num(b.idleSeconds, 0, 3600, 180)),
    screensaver: b.screensaver !== false,
    keyboard: b.keyboard === 'always' || b.keyboard === 'never' ? b.keyboard : 'auto',
    tile: b.tile === 's' || b.tile === 'l' ? b.tile : 'm',
    theme: b.theme === 'light' || b.theme === 'retro' ? b.theme : 'dark',
  };
  setSetting('display', d);
  return c.json({ display: d });
});
