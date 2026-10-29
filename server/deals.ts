// The deal finder: LPs for sale in your region (EU by default) that fit your collection.
//
// Where listings come from (all through the official Discogs API; nothing scrapes Discogs pages):
//  1. Seller inventories. You (and the browser helper) name sellers; their newest listings are read
//     incrementally, newest first, with GET /users/{seller}/inventory. Every listing says where it ships from.
//  2. The browser helper. A userscript in your own browser sends the listing ids it sees on Discogs
//     marketplace pages you open yourself (e.g. "Shop my wants"). The server then reads each listing
//     through the API (GET /marketplace/listings/{id}).
//
// What "fits" means: on your wantlist, a missing album by an artist you collect, or the labels and
// styles that dominate your collection. Prices are compared with Discogs' price suggestion for the
// listing's condition, what we've seen for the same release, and the lowest price on Discogs.

import { createHash, randomBytes } from 'node:crypto';
import { all, db, get, getSetting, now, run, setSetting, tx, type ItemRow } from './db.ts';
import { afterSync, DiscogsError, discogs, discogsCalls, discogsUser, syncStatus } from './discogs.ts';
import { convert, refreshRates, toEur } from './fx.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

db.exec(`
  -- Sellers whose inventories are read (named by you, or learned from the browser helper).
  CREATE TABLE IF NOT EXISTS deal_sellers (
    username      TEXT PRIMARY KEY COLLATE NOCASE,
    source        TEXT NOT NULL DEFAULT 'manual',   -- manual | learned
    enabled       INTEGER NOT NULL DEFAULT 1,
    ships_from    TEXT,
    rating        REAL,
    sales         INTEGER,
    newest_posted TEXT,                             -- newest listing seen (incremental reads stop there)
    last_crawl_at INTEGER,
    last_error    TEXT,
    added_at      INTEGER NOT NULL
  );

  -- Listings worth keeping: in your region, in a format you look for, and plausibly a fit.
  CREATE TABLE IF NOT EXISTS deal_listings (
    listing_id    INTEGER PRIMARY KEY,
    release_id    INTEGER NOT NULL,
    seller        TEXT NOT NULL,
    seller_rating REAL,
    seller_sales  INTEGER,
    ships_from    TEXT NOT NULL,
    condition     TEXT NOT NULL,
    sleeve        TEXT NOT NULL DEFAULT '',
    price         REAL NOT NULL,
    currency      TEXT NOT NULL,
    price_eur     REAL,
    shipping      REAL,
    shipping_cur  TEXT,
    comments      TEXT NOT NULL DEFAULT '',
    uri           TEXT NOT NULL,
    posted        TEXT,
    allow_offers  INTEGER NOT NULL DEFAULT 0,
    artist        TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL DEFAULT '',
    format        TEXT NOT NULL DEFAULT '',
    thumb         TEXT,
    have          INTEGER NOT NULL DEFAULT 0,
    source        TEXT NOT NULL,                    -- inventory | browser
    status        TEXT NOT NULL DEFAULT 'active',   -- active | gone
    first_seen    INTEGER NOT NULL,
    checked_at    INTEGER NOT NULL,
    notified_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS deal_listings_release ON deal_listings (release_id);
  CREATE INDEX IF NOT EXISTS deal_listings_status ON deal_listings (status);

  -- Release details for listed releases (master, artists, labels, styles, formats).
  CREATE TABLE IF NOT EXISTS deal_releases (
    release_id INTEGER PRIMARY KEY,
    master_id  INTEGER,
    data       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Price references per release: Discogs' suggestions per condition and the marketplace stats.
  CREATE TABLE IF NOT EXISTS deal_prices (
    release_id   INTEGER PRIMARY KEY,
    suggestions  TEXT,            -- {"Very Good Plus (VG+)": eur, …} or null when Discogs gives none
    sugg_at      INTEGER,
    lowest_eur   REAL,
    for_sale     INTEGER,
    stats_at     INTEGER
  );

  -- Your Discogs wantlist (mirrored every run).
  CREATE TABLE IF NOT EXISTS deal_wants (
    release_id INTEGER PRIMARY KEY,
    master_id  INTEGER,
    artist     TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT ''
  );

  -- What the finder put on your wantlist itself (never added twice, even after you removed it).
  CREATE TABLE IF NOT EXISTS deal_autowants (
    release_id INTEGER PRIMARY KEY,
    master_id  INTEGER,
    artist     TEXT NOT NULL,
    title      TEXT NOT NULL,
    added_at   INTEGER NOT NULL,
    removed_at INTEGER
  );

  -- Albums by artists you collect (from their Discogs discographies).
  CREATE TABLE IF NOT EXISTS deal_missing (
    key          TEXT PRIMARY KEY,     -- m<master id> or r<release id>
    master_id    INTEGER,
    release_id   INTEGER,
    artist_id    INTEGER NOT NULL,
    artist       TEXT NOT NULL,
    title        TEXT NOT NULL,
    year         INTEGER,
    thumb        TEXT,
    have         INTEGER NOT NULL DEFAULT 0,
    want         INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS deal_artists (
    artist_id  INTEGER PRIMARY KEY,
    crawled_at INTEGER NOT NULL
  );

  -- Things you hid: an album (master), a release, an artist or a seller.
  CREATE TABLE IF NOT EXISTS deal_hidden (
    kind     TEXT NOT NULL,
    key      TEXT NOT NULL COLLATE NOCASE,
    label    TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );

  -- Listing ids sent by the browser helper, waiting to be read through the API.
  CREATE TABLE IF NOT EXISTS deal_queue (
    listing_id INTEGER PRIMARY KEY,
    added_at   INTEGER NOT NULL
  );
`);

/* ---------- settings ---------- */

export const CONDITIONS = [
  'Mint (M)',
  'Near Mint (NM or M-)',
  'Very Good Plus (VG+)',
  'Very Good (VG)',
  'Good Plus (G+)',
  'Good (G)',
  'Fair (F)',
  'Poor (P)',
] as const;
export const SLEEVE_EXTRAS = ['Generic', 'Not Graded', 'No Cover'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Formats you can look for (several at once). */
export const FORMATS = ['LP', 'EP', 'Single', '12"', '10"', '7"', 'CD', 'Cassette'] as const;
export type FormatKey = (typeof FORMATS)[number];
export type SleeveExtra = (typeof SLEEVE_EXTRAS)[number];

export const EU = [
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Czechia', 'Denmark', 'Estonia', 'Finland',
  'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Luxembourg', 'Malta',
  'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Spain', 'Sweden',
];
/** Countries offered as extras (outside the EU: customs and VAT apply when shipping to Sweden). */
export const NEAR_EU = ['United Kingdom', 'Norway', 'Switzerland', 'Iceland'];

export interface DealSettings {
  enabled: boolean;
  everyHours: number;
  countries: string[];
  currency: string;
  maxPrice: number | null; // in `currency`, item price
  minMedia: Condition; // "this or better"
  minSleeve: Condition; // "this or better"
  sleeveAlso: SleeveExtra[]; // also accept these sleeve gradings
  minSellerRating: number; // percent
  minSellerSales: number;
  formats: FormatKey[]; // any of these
  skip: {
    compilations: boolean;
    live: boolean;
    boxSets: boolean;
    unofficial: boolean;
    pictureDiscs: boolean;
    reissues: boolean;
    promos: boolean;
    ownedOnCd: boolean; // owned in another format (e.g. on CD when looking for vinyl)
  };
  skipWords: string[]; // title words that mean "skip" (Greatest Hits, Best Of, …)
  fit: {
    wantlist: boolean;
    artists: boolean;
    labelsStyles: boolean;
    minFit: number; // 0–100: below this a listing isn't shown
    discoveryMinHave: number; // label/style discovery: only releases at least this many people own
    discoveryPerRun: number;
    minOwnedForMissing: number; // discographies of artists you own at least this many records by
  };
  levels: { great: number; good: number }; // % below the typical price
  learnSellers: boolean;
  maxCallsPerRun: number;
  pagesPerSeller: number; // per run (100 listings a page)
  digest: {
    mode: 'off' | 'daily' | 'weekly';
    time: string; // HH:MM
    weekday: number; // 0 = Sunday (weekly)
    email: boolean;
    push: boolean;
    pushUrl: string; // ntfy topic URL or any webhook (Home Assistant)
    pushKind: 'ntfy' | 'webhook';
    minLevel: 'great' | 'good' | 'any';
    max: number;
  };
  wantlist: {
    auto: boolean;
    maxPerRun: number;
    minOwned: number; // only for artists you own at least this many records by
    version: 'popular' | 'original';
  };
}

export const DEFAULT_SETTINGS: DealSettings = {
  enabled: true,
  everyHours: 6,
  countries: EU,
  currency: 'EUR',
  maxPrice: 50,
  minMedia: 'Very Good Plus (VG+)',
  minSleeve: 'Very Good (VG)',
  sleeveAlso: [],
  minSellerRating: 98,
  minSellerSales: 10,
  formats: ['LP'],
  skip: { compilations: true, live: true, boxSets: true, unofficial: true, pictureDiscs: false, reissues: false, promos: false, ownedOnCd: false },
  skipWords: ['Greatest Hits', 'Best Of', 'The Very Best', 'Anthology', 'The Essential', 'Singles Collection', 'Hits Collection'],
  fit: { wantlist: true, artists: true, labelsStyles: true, minFit: 45, discoveryMinHave: 500, discoveryPerRun: 150, minOwnedForMissing: 2 },
  levels: { great: 30, good: 15 },
  learnSellers: true,
  maxCallsPerRun: 1500,
  pagesPerSeller: 5,
  digest: { mode: 'off', time: '08:00', weekday: 6, email: false, push: false, pushUrl: '', pushKind: 'ntfy', minLevel: 'great', max: 15 },
  wantlist: { auto: false, maxPerRun: 3, minOwned: 3, version: 'popular' },
};

export function dealSettings(): DealSettings {
  const s = getSetting<Partial<DealSettings>>('deals', {});
  const d = DEFAULT_SETTINGS;
  // Earlier versions stored 'lp' / 'lp12'.
  const old = s.formats as unknown;
  const formats: FormatKey[] = Array.isArray(old) && old.length ? (old as FormatKey[]) : old === 'lp12' ? ['LP', 'EP', '12"'] : d.formats;
  return {
    ...d,
    ...s,
    formats,
    skip: { ...d.skip, ...s.skip },
    fit: { ...d.fit, ...s.fit },
    levels: { ...d.levels, ...s.levels },
    digest: { ...d.digest, ...s.digest },
    wantlist: { ...d.wantlist, ...s.wantlist },
  };
}

const clampN = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const isCond = (v: unknown): v is Condition => CONDITIONS.includes(v as Condition);

/** Validates settings sent by the page (anything odd falls back to the current value). */
export function saveDealSettings(b: Partial<DealSettings>): DealSettings {
  const cur = dealSettings();
  const strs = (a: unknown, max = 60) =>
    Array.isArray(a) ? [...new Set(a.map((x) => String(x).trim()).filter(Boolean))].slice(0, max) : null;
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  const skip = { ...cur.skip };
  for (const k of Object.keys(skip) as (keyof DealSettings['skip'])[]) skip[k] = bool(b.skip?.[k], skip[k]);
  const s: DealSettings = {
    enabled: bool(b.enabled, cur.enabled),
    everyHours: Math.round(clampN(b.everyHours, 1, 168, cur.everyHours)),
    countries: strs(b.countries) ?? cur.countries,
    currency: typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) ? b.currency : cur.currency,
    maxPrice: b.maxPrice === null || (b.maxPrice as unknown) === '' ? null : b.maxPrice === undefined ? cur.maxPrice : clampN(b.maxPrice, 1, 100000, 50),
    minMedia: isCond(b.minMedia) ? b.minMedia : cur.minMedia,
    minSleeve: isCond(b.minSleeve) ? b.minSleeve : cur.minSleeve,
    sleeveAlso: (strs(b.sleeveAlso) ?? cur.sleeveAlso).filter((x): x is SleeveExtra => SLEEVE_EXTRAS.includes(x as SleeveExtra)),
    minSellerRating: clampN(b.minSellerRating, 0, 100, cur.minSellerRating),
    minSellerSales: Math.round(clampN(b.minSellerSales, 0, 1e6, cur.minSellerSales)),
    formats: (() => {
      const f = (strs(b.formats) ?? cur.formats).filter((x): x is FormatKey => FORMATS.includes(x as FormatKey));
      return f.length ? f : cur.formats;
    })(),
    skip,
    skipWords: strs(b.skipWords, 40) ?? cur.skipWords,
    fit: {
      wantlist: bool(b.fit?.wantlist, cur.fit.wantlist),
      artists: bool(b.fit?.artists, cur.fit.artists),
      labelsStyles: bool(b.fit?.labelsStyles, cur.fit.labelsStyles),
      minFit: Math.round(clampN(b.fit?.minFit, 0, 100, cur.fit.minFit)),
      discoveryMinHave: Math.round(clampN(b.fit?.discoveryMinHave, 0, 1e7, cur.fit.discoveryMinHave)),
      discoveryPerRun: Math.round(clampN(b.fit?.discoveryPerRun, 0, 2000, cur.fit.discoveryPerRun)),
      minOwnedForMissing: Math.round(clampN(b.fit?.minOwnedForMissing, 1, 100, cur.fit.minOwnedForMissing)),
    },
    levels: {
      great: clampN(b.levels?.great, 1, 90, cur.levels.great),
      good: clampN(b.levels?.good, 0, 90, cur.levels.good),
    },
    learnSellers: bool(b.learnSellers, cur.learnSellers),
    maxCallsPerRun: Math.round(clampN(b.maxCallsPerRun, 50, 20000, cur.maxCallsPerRun)),
    pagesPerSeller: Math.round(clampN(b.pagesPerSeller, 1, 100, cur.pagesPerSeller)),
    digest: {
      mode: b.digest?.mode === 'daily' || b.digest?.mode === 'weekly' || b.digest?.mode === 'off' ? b.digest.mode : cur.digest.mode,
      time: typeof b.digest?.time === 'string' && /^\d{1,2}:\d{2}$/.test(b.digest.time) ? b.digest.time : cur.digest.time,
      weekday: Math.round(clampN(b.digest?.weekday, 0, 6, cur.digest.weekday)),
      email: bool(b.digest?.email, cur.digest.email),
      push: bool(b.digest?.push, cur.digest.push),
      pushUrl: typeof b.digest?.pushUrl === 'string' ? b.digest.pushUrl.trim().slice(0, 500) : cur.digest.pushUrl,
      pushKind: b.digest?.pushKind === 'webhook' || b.digest?.pushKind === 'ntfy' ? b.digest.pushKind : cur.digest.pushKind,
      minLevel: b.digest?.minLevel === 'good' || b.digest?.minLevel === 'any' || b.digest?.minLevel === 'great' ? b.digest.minLevel : cur.digest.minLevel,
      max: Math.round(clampN(b.digest?.max, 1, 100, cur.digest.max)),
    },
    wantlist: {
      auto: bool(b.wantlist?.auto, cur.wantlist.auto),
      maxPerRun: Math.round(clampN(b.wantlist?.maxPerRun, 1, 50, cur.wantlist.maxPerRun)),
      minOwned: Math.round(clampN(b.wantlist?.minOwned, 1, 100, cur.wantlist.minOwned)),
      version: b.wantlist?.version === 'original' || b.wantlist?.version === 'popular' ? b.wantlist.version : cur.wantlist.version,
    },
  };
  if (s.digest.pushUrl && !/^https?:\/\//.test(s.digest.pushUrl)) s.digest.pushUrl = '';
  if (s.levels.good > s.levels.great) s.levels.good = s.levels.great;
  setSetting('deals', s);
  return s;
}

/* ---------- your collection, as the finder sees it ---------- */

/** "The Beatles" / "Beatles, The" / "Björk (2)" → "beatles" / "bjork". */
export function normName(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s\(\d+\)$/, '')
    .replace(/,\s*the$/, '')
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** All the names in an artist line ("Simon & Garfunkel" also gives "simon", "garfunkel"). */
function nameParts(line: string) {
  const parts = new Set([normName(line)]);
  for (const p of line.split(/\s*(?:,|&|\band\b|\bfeat\.?|\bfeaturing\b|\bwith\b|\/|\+|\bvs\.?)\s*/i)) {
    const n = normName(p);
    if (n.length > 1) parts.add(n);
  }
  return [...parts].filter(Boolean);
}

interface Profile {
  total: number;
  masters: Map<number, Set<Media>>; // which media you own an album on
  releases: Set<number>;
  artists: Map<number, { n: number; name: string }>;
  artistNames: Map<string, number>; // normalised name → records
  labels: Map<number, { n: number; name: string }>;
  styles: Map<string, number>;
}

let profileCache: { at: number; p: Profile } | null = null;
afterSync.push(() => {
  profileCache = null;
  startDealsRun('after sync');
});

export function profile(): Profile {
  if (profileCache && now() - profileCache.at < 10 * 60_000) return profileCache.p;
  const items = all<ItemRow>('SELECT * FROM items');
  const p: Profile = { total: items.length, masters: new Map(), releases: new Set(), artists: new Map(), artistNames: new Map(), labels: new Map(), styles: new Map() };
  for (const it of items) {
    p.releases.add(it.release_id);
    if (it.master_id) {
      const m = p.masters.get(it.master_id) ?? new Set<Media>();
      for (const x of mediaOf(`${it.format} ${it.format_text}`)) m.add(x);
      p.masters.set(it.master_id, m);
    }
    const ids = JSON.parse(it.artist_ids || '[]') as number[];
    for (const id of ids) {
      const a = p.artists.get(id) ?? { n: 0, name: ids.length === 1 ? it.artist : '' };
      a.n++;
      if (!a.name && ids.length === 1) a.name = it.artist;
      p.artists.set(id, a);
    }
    for (const n of nameParts(it.artist)) p.artistNames.set(n, (p.artistNames.get(n) ?? 0) + 1);
    const labelIds = JSON.parse(it.label_ids || '[]') as number[];
    const labelNames = it.labels.split(', ').map((l) => l.split(' – ')[0]);
    labelIds.forEach((id, i) => {
      const l = p.labels.get(id) ?? { n: 0, name: labelNames[i] ?? '' };
      l.n++;
      p.labels.set(id, l);
    });
    for (const s of JSON.parse(it.styles || '[]') as string[]) p.styles.set(s, (p.styles.get(s) ?? 0) + 1);
  }
  profileCache = { at: now(), p };
  return p;
}

/* ---------- release details ---------- */

interface DFormat {
  name: string;
  qty: string;
  text?: string;
  descriptions?: string[];
}
interface DealRelease {
  id: number;
  masterId: number | null;
  title: string;
  year: number | null;
  country: string | null;
  artists: { id: number; name: string }[];
  labels: { id: number; name: string; catno: string }[];
  formats: DFormat[];
  styles: string[];
  genres: string[];
  have: number;
  want: number;
  thumb: string | null;
  liveNotes: boolean; // the notes say it was recorded live
}

const relCache = new Map<number, DealRelease>();
function releaseOf(id: number): DealRelease | null {
  const hit = relCache.get(id);
  if (hit) return hit;
  const row = get<{ data: string }>('SELECT data FROM deal_releases WHERE release_id = ?', id);
  if (!row) return null;
  const r = JSON.parse(row.data) as DealRelease;
  relCache.set(id, r);
  if (relCache.size > 20000) relCache.delete(relCache.keys().next().value!);
  return r;
}

interface ApiRelease {
  id: number;
  master_id?: number;
  title: string;
  year?: number;
  country?: string;
  notes?: string;
  thumb?: string;
  images?: { uri150?: string; type?: string }[];
  artists?: { id: number; name: string; anv?: string }[];
  labels?: { id: number; name: string; catno: string }[];
  formats?: DFormat[];
  styles?: string[];
  genres?: string[];
  community?: { have?: number; want?: number };
}

const LIVE_NOTES = /\b(recorded live|live recording|recorded in concert|live at the)\b/i;

async function fetchDealRelease(id: number): Promise<DealRelease> {
  const r = await call<ApiRelease>(`/releases/${id}`);
  const out: DealRelease = {
    id,
    masterId: r.master_id || null,
    title: r.title,
    year: r.year || null,
    country: r.country ?? null,
    artists: (r.artists ?? []).map((a) => ({ id: a.id, name: (a.anv || a.name).replace(/\s\(\d+\)$/, '') })),
    labels: (r.labels ?? []).map((l) => ({ id: l.id, name: l.name.replace(/\s\(\d+\)$/, ''), catno: l.catno })),
    formats: r.formats ?? [],
    styles: r.styles ?? [],
    genres: r.genres ?? [],
    have: r.community?.have ?? 0,
    want: r.community?.want ?? 0,
    thumb: r.thumb || r.images?.[0]?.uri150 || null,
    liveNotes: LIVE_NOTES.test(r.notes ?? ''),
  };
  run(
    'INSERT OR REPLACE INTO deal_releases (release_id, master_id, data, fetched_at) VALUES (?, ?, ?, ?)',
    id,
    out.masterId,
    JSON.stringify(out),
    now(),
  );
  relCache.set(id, out);
  return out;
}

/* ---------- filters ---------- */

const condRank = (c: string) => CONDITIONS.indexOf(c as Condition);

/** Media condition is "minimum or better". */
export function mediaOk(cond: string, s: DealSettings) {
  const r = condRank(cond);
  return r >= 0 && r <= condRank(s.minMedia);
}
/** Sleeve condition is "minimum or better", plus the extra gradings you allow. */
export function sleeveOk(sleeve: string, s: DealSettings) {
  if (!sleeve) return s.sleeveAlso.includes('Not Graded');
  if (SLEEVE_EXTRAS.includes(sleeve as SleeveExtra)) return s.sleeveAlso.includes(sleeve as SleeveExtra);
  const r = condRank(sleeve);
  return r >= 0 && r <= condRank(s.minSleeve);
}

const LIVE_TITLE = /\b(live|in concert|unplugged|bbc sessions|on stage|at the (fillmore|apollo|royal albert hall|budokan))\b/i;
const descs = (formats: DFormat[]) => formats.flatMap((f) => [f.name, ...(f.descriptions ?? []), ...(f.text ? [f.text] : [])]);

/** Does a format text ("Vinyl, LP, Album" or "7\", Single") match one of the formats you look for? */
export function formatOk(text: string, s: Pick<DealSettings, 'formats'>) {
  const isLP = /\bLP\b/.test(text);
  const test: Record<FormatKey, boolean> = {
    LP: isLP,
    EP: /\bEP\b/.test(text),
    Single: /\b(Maxi-)?Single\b/.test(text),
    '12"': /12"/.test(text) && !isLP,
    '10"': /10"/.test(text),
    '7"': /7"/.test(text),
    CD: /\bCD\b/.test(text),
    Cassette: /\bCass(ette)?\b/.test(text),
  };
  return s.formats.some((f) => test[f]);
}

export type Media = 'vinyl' | 'cd' | 'cassette';
/** The physical media in a format text. */
export function mediaOf(text: string): Media[] {
  const out: Media[] = [];
  if (/\bVinyl\b|\bLP\b|\b(7|10|12)"/.test(text)) out.push('vinyl');
  if (/\bCD\b/.test(text)) out.push('cd');
  if (/\bCass(ette)?\b/.test(text)) out.push('cassette');
  return out;
}
const mediaName: Record<Media, string> = { vinyl: 'vinyl', cd: 'CD', cassette: 'cassette' };
/** The media your chosen formats are on (LP/12"/… → vinyl, CD → CD). */
export function wantedMedia(s: Pick<DealSettings, 'formats'>): Set<Media> {
  const m = new Set<Media>();
  for (const f of s.formats) {
    if (f === 'CD') m.add('cd');
    else if (f === 'Cassette') m.add('cassette');
    else if (f === 'EP' || f === 'Single') m.add('vinyl').add('cd'); // EPs and singles come on both
    else m.add('vinyl'); // LP, 12", 10", 7"
  }
  return m;
}

/** Why a release is skipped by your filters (null = keep). */
export function skipReason(rel: Pick<DealRelease, 'title' | 'formats' | 'liveNotes'>, s: DealSettings): string | null {
  const d = descs(rel.formats);
  const has = (x: string) => d.some((v) => v.toLowerCase() === x.toLowerCase());
  const formatText = d.join(', ');
  if (rel.formats.length && !formatOk(formatText, s)) return 'Not a format you look for';
  if (s.skip.compilations && has('Compilation')) return 'Compilation';
  const words = s.skip.compilations ? s.skipWords : [];
  const tl = rel.title.toLowerCase();
  for (const w of words) if (w && tl.includes(w.toLowerCase())) return `Title has “${w}”`;
  if (s.skip.live && (LIVE_TITLE.test(rel.title) || rel.liveNotes)) return 'Live album';
  if (s.skip.boxSets && has('Box Set')) return 'Box set';
  if (s.skip.unofficial && has('Unofficial Release')) return 'Unofficial release';
  if (s.skip.pictureDiscs && has('Picture Disc')) return 'Picture disc';
  if (s.skip.reissues && (has('Reissue') || has('Repress'))) return 'Reissue';
  if (s.skip.promos && (has('Promo') || has('Test Pressing') || has('White Label'))) return 'Promo / test pressing';
  return null;
}

/* ---------- fit and price ---------- */

export interface Fit {
  score: number; // 0–100
  kind: 'want' | 'artist' | 'label' | 'style' | 'none';
  reasons: string[];
  ownedOnCd: boolean; // you own the album in another format (see ownedOther)
  ownedOther: string | null; // e.g. "CD"
  owned: boolean;
}

let wantsCache: { at: number; releases: Set<number>; masters: Set<number> } | null = null;
function wants() {
  if (wantsCache && now() - wantsCache.at < 60_000) return wantsCache;
  const rows = all<{ release_id: number; master_id: number | null }>('SELECT release_id, master_id FROM deal_wants');
  wantsCache = { at: now(), releases: new Set(rows.map((r) => r.release_id)), masters: new Set(rows.map((r) => r.master_id).filter((x): x is number => !!x)) };
  return wantsCache;
}

export function fitOf(rel: DealRelease, s: DealSettings, p = profile()): Fit {
  const reasons: string[] = [];
  let score = 0;
  let kind: Fit['kind'] = 'none';
  const sources = new Set<string>();
  const m = rel.masterId ? p.masters.get(rel.masterId) : undefined;
  // Owned = this exact release, or the album on the same media as this listing (vinyl, CD or cassette).
  const media = mediaOf(descs(rel.formats).join(', '));
  const owned = p.releases.has(rel.id) || (!!m && media.some((x) => m.has(x)));
  const other = !owned && m ? [...m].find((x) => !media.includes(x)) : undefined;
  const ownedOnCd = !!other;
  const w = wants();

  if (s.fit.wantlist && w.releases.has(rel.id)) {
    score = 100;
    kind = 'want';
    sources.add('want');
    reasons.push('On your wantlist');
  } else if (s.fit.wantlist && rel.masterId && w.masters.has(rel.masterId)) {
    score = 92;
    kind = 'want';
    sources.add('want');
    reasons.push('Another pressing of a record on your wantlist');
  }
  if (s.fit.artists) {
    let best: { n: number; name: string } | null = null;
    for (const a of rel.artists) {
      const o = p.artists.get(a.id);
      if (o && (!best || o.n > best.n)) best = { n: o.n, name: o.name || a.name };
    }
    if (best) {
      const v = 55 + Math.min(35, best.n * 5);
      if (v > score) {
        score = v;
        kind = 'artist';
      }
      sources.add('artist');
      reasons.push(`${best.n} ${best.n === 1 ? 'record' : 'records'} by ${best.name} in your collection`);
    }
  }
  if (s.fit.labelsStyles) {
    let bestLabel: { n: number; name: string } | null = null;
    for (const l of rel.labels) {
      const o = p.labels.get(l.id);
      if (o && o.n >= 2 && (!bestLabel || o.n > bestLabel.n)) bestLabel = { n: o.n, name: o.name || l.name };
    }
    if (bestLabel) {
      const v = 30 + Math.min(25, bestLabel.n * 2.5);
      if (v > score) {
        score = v;
        kind = 'label';
      }
      sources.add('label');
      reasons.push(`${bestLabel.n} records on ${bestLabel.name}`);
    }
    if (p.total) {
      const shared = rel.styles.filter((st) => (p.styles.get(st) ?? 0) >= 3);
      const share = shared.reduce((a, st) => a + (p.styles.get(st) ?? 0) / p.total, 0);
      if (share >= 0.05) {
        const v = 20 + Math.min(30, share * 150);
        if (v > score) {
          score = v;
          kind = 'style';
        }
        sources.add('style');
        reasons.push(`Styles you collect: ${shared.slice(0, 3).join(', ')}`);
      }
    }
  }
  if (score > 0) {
    if (sources.size >= 2) score += 5;
    score += Math.min(10, Math.log10(rel.have + 1) * 2.5); // well-loved records rank a little higher
  }
  if (other) reasons.push(`You have it on ${mediaName[other]}`);
  return { score: Math.min(100, Math.round(score)), kind, reasons, ownedOnCd, ownedOther: other ? mediaName[other] : null, owned };
}

export interface PriceView {
  priceEur: number | null;
  shippingEur: number | null;
  refEur: number | null; // typical price for this condition
  refKind: 'suggestion' | 'seen' | null;
  lowestEur: number | null; // lowest on Discogs (any country)
  cheapest: boolean;
  discount: number | null; // 0.3 = 30% below typical
  level: 'great' | 'good' | 'fair' | 'unknown';
}

function priceOf(l: ListingRow, s: DealSettings): PriceView {
  const pr = get<{ suggestions: string | null; lowest_eur: number | null }>('SELECT suggestions, lowest_eur FROM deal_prices WHERE release_id = ?', l.release_id);
  const sugg = pr?.suggestions ? (JSON.parse(pr.suggestions) as Record<string, number>) : null;
  let refEur: number | null = sugg?.[l.condition] ?? null;
  let refKind: PriceView['refKind'] = refEur ? 'suggestion' : null;
  if (!refEur) {
    // What we've seen for the same release in the same condition (needs a few sightings).
    const seen = all<{ price_eur: number }>(
      'SELECT price_eur FROM deal_listings WHERE release_id = ? AND condition = ? AND price_eur IS NOT NULL ORDER BY price_eur',
      l.release_id,
      l.condition,
    ).map((r) => r.price_eur);
    if (seen.length >= 3) {
      refEur = seen[Math.floor(seen.length / 2)];
      refKind = 'seen';
    }
  }
  const priceEur = l.price_eur;
  const shippingEur = l.shipping != null && l.shipping_cur ? toEur(l.shipping, l.shipping_cur) : null;
  const lowestEur = pr?.lowest_eur ?? null;
  const cheapest = priceEur != null && lowestEur != null && priceEur <= lowestEur * 1.01;
  const discount = priceEur != null && refEur ? 1 - priceEur / refEur : null;
  let level: PriceView['level'] = 'unknown';
  if (discount != null) level = discount * 100 >= s.levels.great ? 'great' : discount * 100 >= s.levels.good ? 'good' : 'fair';
  else if (cheapest) level = 'good';
  return { priceEur, shippingEur, refEur, refKind, lowestEur, cheapest, discount, level };
}

/* ---------- listings ---------- */

interface ApiListing {
  id: number;
  status: string;
  uri: string;
  condition: string;
  sleeve_condition: string;
  comments?: string;
  ships_from: string;
  posted: string;
  allow_offers: boolean;
  price: { value?: number; currency?: string };
  shipping_price?: { value?: number; currency?: string };
  seller: { username: string; stats?: { rating?: string; total?: number } };
  release: {
    id: number;
    artist: string;
    title: string;
    format: string;
    description: string;
    year?: number;
    thumbnail?: string;
    stats?: { community?: { in_collection?: number; in_wantlist?: number }; user?: { in_wantlist?: number } };
  };
}

export interface ListingRow {
  listing_id: number;
  release_id: number;
  seller: string;
  seller_rating: number | null;
  seller_sales: number | null;
  ships_from: string;
  condition: string;
  sleeve: string;
  price: number;
  currency: string;
  price_eur: number | null;
  shipping: number | null;
  shipping_cur: string | null;
  comments: string;
  uri: string;
  posted: string | null;
  allow_offers: number;
  artist: string;
  title: string;
  format: string;
  thumb: string | null;
  have: number;
  source: string;
  status: string;
  first_seen: number;
  checked_at: number;
  notified_at: number | null;
}

const inRegion = (country: string, s: DealSettings) => s.countries.some((c) => c.toLowerCase() === country.toLowerCase());

/** Is a listing worth keeping before we know its release details? */
function looksRelevant(l: ApiListing, s: DealSettings, p: Profile) {
  if (!inRegion(l.ships_from, s)) return false;
  if (!formatOk(`${l.release.format} ${l.release.description}`, s)) return false;
  if (p.releases.has(l.release.id)) return false; // you own this exact pressing
  if (wants().releases.has(l.release.id) || releaseOf(l.release.id)) return true;
  if (nameParts(l.release.artist).some((n) => p.artistNames.has(n))) return true;
  return s.fit.labelsStyles && (l.release.stats?.community?.in_collection ?? 0) >= s.fit.discoveryMinHave;
}

function saveListing(l: ApiListing, source: 'inventory' | 'browser') {
  const price = l.price.value ?? 0;
  const cur = l.price.currency ?? 'EUR';
  const t = now();
  run(
    `INSERT INTO deal_listings (listing_id, release_id, seller, seller_rating, seller_sales, ships_from, condition, sleeve, price, currency,
       price_eur, shipping, shipping_cur, comments, uri, posted, allow_offers, artist, title, format, thumb, have, source, status, first_seen, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(listing_id) DO UPDATE SET price = excluded.price, currency = excluded.currency, price_eur = excluded.price_eur,
       shipping = excluded.shipping, shipping_cur = excluded.shipping_cur, condition = excluded.condition, sleeve = excluded.sleeve,
       comments = excluded.comments, seller_rating = excluded.seller_rating, seller_sales = excluded.seller_sales,
       status = 'active', checked_at = excluded.checked_at`,
    l.id,
    l.release.id,
    l.seller.username,
    l.seller.stats?.rating ? Number(l.seller.stats.rating) : null,
    l.seller.stats?.total ?? null,
    l.ships_from,
    l.condition,
    l.sleeve_condition ?? '',
    price,
    cur,
    toEur(price, cur),
    l.shipping_price?.value ?? null,
    l.shipping_price?.currency ?? null,
    (l.comments ?? '').slice(0, 600),
    l.uri,
    l.posted ?? null,
    l.allow_offers ? 1 : 0,
    l.release.artist,
    l.release.title,
    l.release.format || l.release.description,
    l.release.thumbnail || null,
    l.release.stats?.community?.in_collection ?? 0,
    source,
    t,
    t,
  );
}

/* ---------- the run ---------- */

export interface DealsStatus {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  startedAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  lastCalls: number;
  nextRunAt: number | null;
  queue: number;
  listings: number;
  wants: number;
  sellers: number;
}

const status: Omit<DealsStatus, 'queue' | 'listings' | 'wants' | 'sellers' | 'nextRunAt'> = {
  running: false,
  phase: '',
  done: 0,
  total: 0,
  startedAt: null,
  lastRunAt: getSetting<number | null>('dealsLastRunAt', null),
  lastError: getSetting<string | null>('dealsLastError', null),
  lastCalls: getSetting<number>('dealsLastCalls', 0),
};

export function dealsStatus(): DealsStatus {
  const s = dealSettings();
  const n = (sql: string) => get<{ n: number }>(sql)!.n;
  return {
    ...status,
    nextRunAt: s.enabled && status.lastRunAt ? status.lastRunAt + s.everyHours * 3600_000 : null,
    queue: n('SELECT COUNT(*) AS n FROM deal_queue'),
    listings: n("SELECT COUNT(*) AS n FROM deal_listings WHERE status = 'active'"),
    wants: n('SELECT COUNT(*) AS n FROM deal_wants'),
    sellers: n('SELECT COUNT(*) AS n FROM deal_sellers WHERE enabled = 1'),
  };
}

class BudgetSpent extends Error {}
let runStartCalls = 0;
let runBudget = Infinity;

/** A Discogs call for the finder: waits while the collection sync runs and respects the per-run budget. */
async function call<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  while (syncStatus().running) await sleep(5000);
  if (discogsCalls() - runStartCalls >= runBudget) throw new BudgetSpent('budget');
  return discogs<T>(path, opts);
}

export function startDealsRun(reason: string): boolean {
  if (status.running) return false;
  if (!discogsUser()) return false; // the first collection sync hasn't run yet
  void runDeals(reason);
  return true;
}

async function step(name: string, fn: () => Promise<void>) {
  status.phase = name;
  status.done = 0;
  status.total = 0;
  try {
    await fn();
  } catch (e) {
    if (e instanceof BudgetSpent) throw e;
    console.warn(`Deals, ${name}: ${(e as Error).message}`);
    status.lastError = `${name}: ${(e as Error).message}`;
  }
}

async function runDeals(reason: string) {
  const s = dealSettings();
  Object.assign(status, { running: true, phase: 'Starting', done: 0, total: 0, startedAt: now(), lastError: null });
  runStartCalls = discogsCalls();
  runBudget = s.maxCallsPerRun;
  console.log(`Deal finder started (${reason})`);
  try {
    await refreshRates();
    await step('Reading your wantlist', syncWantlist);
    await step('Reading listings from the browser helper', () => processQueue(Infinity));
    await step('Reading seller inventories', () => crawlSellers(s));
    await step('Looking up releases', () => enrichReleases(s));
    await step('Checking prices', () => refreshPrices(s));
    await step('Checking that deals are still for sale', () => recheckDeals(s));
    await step('Reading discographies of your artists', () => crawlDiscographies(s));
    if (s.wantlist.auto) await step('Adding missing albums to your wantlist', () => autoWantlist(s));
    cleanup();
  } catch (e) {
    if (!(e instanceof BudgetSpent)) {
      status.lastError = (e as Error).message;
      console.error('Deal finder failed:', status.lastError);
    } else {
      console.log('Deal finder: request budget for this run used up; the rest continues next run.');
      cleanup();
    }
  } finally {
    status.lastCalls = discogsCalls() - runStartCalls;
    status.lastRunAt = now();
    runBudget = Infinity;
    setSetting('dealsLastRunAt', status.lastRunAt);
    setSetting('dealsLastError', status.lastError);
    setSetting('dealsLastCalls', status.lastCalls);
    status.running = false;
    status.phase = '';
    console.log(`Deal finder done: ${status.lastCalls} Discogs requests`);
  }
}

/* ---------- 1. wantlist ---------- */

async function syncWantlist() {
  const u = encodeURIComponent(discogsUser()!);
  const rows: { release_id: number; master_id: number | null; artist: string; title: string; notes: string }[] = [];
  for (let page = 1, pages = 1; page <= pages && page <= 100; page++) {
    const r = await call<{
      pagination: { pages: number; items: number };
      wants: { id: number; notes?: string; basic_information: { master_id?: number; title: string; artists?: { name: string }[] } }[];
    }>(`/users/${u}/wants?per_page=100&page=${page}`);
    pages = r.pagination.pages;
    status.total = r.pagination.items;
    for (const w of r.wants) {
      rows.push({
        release_id: w.id,
        master_id: w.basic_information.master_id || null,
        artist: (w.basic_information.artists ?? []).map((a) => a.name.replace(/\s\(\d+\)$/, '')).join(', '),
        title: w.basic_information.title,
        notes: w.notes ?? '',
      });
    }
    status.done = rows.length;
  }
  tx(() => {
    run('DELETE FROM deal_wants');
    for (const w of rows) {
      run('INSERT OR REPLACE INTO deal_wants (release_id, master_id, artist, title, notes) VALUES (?, ?, ?, ?, ?)', w.release_id, w.master_id, w.artist, w.title, w.notes);
    }
  });
  wantsCache = null;
}

/* ---------- 2. seller inventories ---------- */

interface SellerRow {
  username: string;
  newest_posted: string | null;
  last_crawl_at: number | null;
}

async function crawlSellers(s: DealSettings) {
  const p = profile();
  const sellers = all<SellerRow>('SELECT username, newest_posted, last_crawl_at FROM deal_sellers WHERE enabled = 1 ORDER BY last_crawl_at IS NOT NULL, last_crawl_at');
  const hidden = new Set(all<{ key: string }>("SELECT key FROM deal_hidden WHERE kind = 'seller'").map((r) => r.key.toLowerCase()));
  status.total = sellers.length;
  for (const seller of sellers) {
    if (hidden.has(seller.username.toLowerCase())) {
      status.done++;
      continue;
    }
    let newest = seller.newest_posted;
    let kept = 0;
    try {
      const u = encodeURIComponent(seller.username);
      for (let page = 1, pages = 1; page <= pages && page <= s.pagesPerSeller; page++) {
        const r = await call<{ pagination: { pages: number }; listings: ApiListing[] }>(
          `/users/${u}/inventory?status=For%20Sale&sort=listed&sort_order=desc&per_page=100&page=${page}`,
        );
        pages = r.pagination.pages;
        let reachedOld = false;
        tx(() => {
          for (const l of r.listings) {
            if (seller.newest_posted && l.posted && l.posted <= seller.newest_posted) reachedOld = true;
            if (l.posted && (!newest || l.posted > newest)) newest = l.posted;
            if (looksRelevant(l, s, p)) {
              saveListing(l, 'inventory');
              kept++;
            }
          }
          const first = r.listings[0];
          if (first) {
            run(
              'UPDATE deal_sellers SET ships_from = ?, rating = ?, sales = ? WHERE username = ?',
              first.ships_from,
              first.seller.stats?.rating ? Number(first.seller.stats.rating) : null,
              first.seller.stats?.total ?? null,
              seller.username,
            );
          }
        });
        if (reachedOld) break;
      }
      run('UPDATE deal_sellers SET newest_posted = ?, last_crawl_at = ?, last_error = NULL WHERE username = ?', newest, now(), seller.username);
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      const msg = e instanceof DiscogsError && e.status === 404 ? 'Seller not found on Discogs' : (e as Error).message;
      run('UPDATE deal_sellers SET last_error = ?, last_crawl_at = ? WHERE username = ?', msg.slice(0, 300), now(), seller.username);
    }
    if (kept) console.log(`Deals: ${kept} listings kept from ${seller.username}`);
    status.done++;
  }
}

/* ---------- 3. the browser helper's queue ---------- */

let queueBusy = false;

/** Listing ids seen in your browser. Returns how many were new. */
export function enqueueListings(ids: number[]): number {
  let added = 0;
  const t = now();
  tx(() => {
    for (const id of ids.slice(0, 500)) {
      if (!Number.isInteger(id) || id <= 0) continue;
      const known = get<{ checked_at: number }>('SELECT checked_at FROM deal_listings WHERE listing_id = ?', id);
      if (known && t - known.checked_at < DAY) continue;
      added += Number(run('INSERT OR IGNORE INTO deal_queue (listing_id, added_at) VALUES (?, ?)', id, t).changes);
    }
    // Keep the queue bounded: drop the oldest.
    run('DELETE FROM deal_queue WHERE listing_id IN (SELECT listing_id FROM deal_queue ORDER BY added_at DESC LIMIT -1 OFFSET 3000)');
  });
  if (added && !status.running) void processQueue(400).catch((e) => console.warn('Deals queue:', (e as Error).message));
  return added;
}

async function processQueue(max: number) {
  if (queueBusy) return;
  queueBusy = true;
  try {
    await refreshRates();
    const s = dealSettings();
    const ids = all<{ listing_id: number }>('SELECT listing_id FROM deal_queue ORDER BY added_at LIMIT ?', Number.isFinite(max) ? max : 5000);
    if (status.running) status.total = ids.length;
    for (const { listing_id } of ids) {
      try {
        const l = await call<ApiListing>(`/marketplace/listings/${listing_id}?curr_abbr=EUR`);
        if (l.status === 'For Sale' && inRegion(l.ships_from, s) && formatOk(`${l.release.format} ${l.release.description}`, s)) {
          saveListing(l, 'browser');
          if (s.learnSellers) learnSeller(l);
        } else {
          run("UPDATE deal_listings SET status = 'gone', checked_at = ? WHERE listing_id = ?", now(), listing_id);
        }
      } catch (e) {
        if (e instanceof BudgetSpent) throw e;
        if (!(e instanceof DiscogsError && e.status === 404)) console.warn(`Deals, listing ${listing_id}: ${(e as Error).message}`);
      }
      run('DELETE FROM deal_queue WHERE listing_id = ?', listing_id);
      if (status.running) status.done++;
    }
  } finally {
    queueBusy = false;
  }
}

/** A good seller in your region that the helper saw: read their inventory from now on. */
function learnSeller(l: ApiListing) {
  const s = dealSettings();
  const rating = l.seller.stats?.rating ? Number(l.seller.stats.rating) : 0;
  const sales = l.seller.stats?.total ?? 0;
  if (rating < s.minSellerRating || sales < Math.max(s.minSellerSales, 50)) return;
  const learned = get<{ n: number }>("SELECT COUNT(*) AS n FROM deal_sellers WHERE source = 'learned'")!.n;
  if (learned >= 60) return;
  run(
    "INSERT OR IGNORE INTO deal_sellers (username, source, ships_from, rating, sales, added_at) VALUES (?, 'learned', ?, ?, ?, ?)",
    l.seller.username,
    l.ships_from,
    rating,
    sales,
    now(),
  );
}

/* ---------- 4. release details ---------- */

async function enrichReleases(s: DealSettings) {
  const p = profile();
  const missing = all<{ release_id: number; artist: string; have: number; source: string }>(
    `SELECT release_id, MAX(artist) AS artist, MAX(have) AS have, MIN(source) AS source FROM deal_listings
     WHERE status = 'active' AND release_id NOT IN (SELECT release_id FROM deal_releases) GROUP BY release_id`,
  );
  const w = wants();
  const rank = (m: (typeof missing)[number]) =>
    w.releases.has(m.release_id) ? 0 : m.source === 'browser' ? 1 : nameParts(m.artist).some((n) => p.artistNames.has(n)) ? 2 : 3;
  missing.sort((a, b) => rank(a) - rank(b) || b.have - a.have);
  let discovery = 0;
  const todo = missing.filter((m) => rank(m) < 3 || discovery++ < s.fit.discoveryPerRun);
  status.total = todo.length;
  for (const m of todo) {
    try {
      await fetchDealRelease(m.release_id);
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      if (e instanceof DiscogsError && e.status === 404) run("UPDATE deal_listings SET status = 'gone' WHERE release_id = ?", m.release_id);
    }
    status.done++;
  }
}

/* ---------- 5. prices ---------- */

async function refreshPrices(s: DealSettings) {
  const candidates = computeDeals(s, { includeUnpriced: true }).filter((d) => !d.skipped);
  const releases = [...new Map(candidates.map((d) => [d.releaseId, d])).values()].sort((a, b) => b.fit.score - a.fit.score);
  status.total = releases.length;
  for (const d of releases) {
    const pr = get<{ sugg_at: number | null; stats_at: number | null }>('SELECT sugg_at, stats_at FROM deal_prices WHERE release_id = ?', d.releaseId);
    run('INSERT OR IGNORE INTO deal_prices (release_id) VALUES (?)', d.releaseId);
    if (!pr?.sugg_at || now() - pr.sugg_at > 7 * DAY) {
      let sugg: Record<string, number> | null = null;
      try {
        const r = await call<Record<string, { value: number; currency: string }>>(`/marketplace/price_suggestions/${d.releaseId}`);
        sugg = {};
        for (const [cond, v] of Object.entries(r ?? {})) {
          const eur = v?.value != null ? toEur(v.value, v.currency) : null;
          if (eur != null) sugg[cond] = Math.round(eur * 100) / 100;
        }
        if (!Object.keys(sugg).length) sugg = null;
      } catch (e) {
        if (e instanceof BudgetSpent) throw e;
        // Discogs only gives suggestions when your seller settings are filled in; without them we use what we've seen.
      }
      run('UPDATE deal_prices SET suggestions = ?, sugg_at = ? WHERE release_id = ?', sugg ? JSON.stringify(sugg) : null, now(), d.releaseId);
    }
    if (!pr?.stats_at || now() - pr.stats_at > DAY) {
      try {
        const r = await call<{ lowest_price?: { value?: number; currency?: string } | null; num_for_sale?: number | null }>(
          `/marketplace/stats/${d.releaseId}?curr_abbr=EUR`,
        );
        const lowest = r.lowest_price?.value != null ? toEur(r.lowest_price.value, r.lowest_price.currency ?? 'EUR') : null;
        run('UPDATE deal_prices SET lowest_eur = ?, for_sale = ?, stats_at = ? WHERE release_id = ?', lowest, r.num_for_sale ?? null, now(), d.releaseId);
      } catch (e) {
        if (e instanceof BudgetSpent) throw e;
      }
    }
    status.done++;
  }
}

/* ---------- 6. still for sale? ---------- */

async function recheckDeals(s: DealSettings) {
  const shown = computeDeals(s).filter((d) => !d.skipped && now() - d.checkedAt > DAY).slice(0, 200);
  status.total = shown.length;
  for (const d of shown) {
    try {
      const l = await call<ApiListing>(`/marketplace/listings/${d.listingId}?curr_abbr=EUR`);
      if (l.status === 'For Sale') saveListing(l, d.source as 'inventory' | 'browser');
      else run("UPDATE deal_listings SET status = 'gone', checked_at = ? WHERE listing_id = ?", now(), d.listingId);
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      if (e instanceof DiscogsError && e.status === 404) {
        run("UPDATE deal_listings SET status = 'gone', checked_at = ? WHERE listing_id = ?", now(), d.listingId);
      }
    }
    status.done++;
  }
}

/* ---------- 7. discographies (missing albums) ---------- */

async function crawlDiscographies(s: DealSettings) {
  if (!s.fit.artists) return;
  const p = profile();
  const due = [...p.artists.entries()]
    .filter(([, a]) => a.n >= s.fit.minOwnedForMissing)
    .sort((a, b) => b[1].n - a[1].n)
    .filter(([id]) => {
      const r = get<{ crawled_at: number }>('SELECT crawled_at FROM deal_artists WHERE artist_id = ?', id);
      return !r || now() - r.crawled_at > 30 * DAY;
    })
    .slice(0, 80);
  status.total = due.length;
  for (const [id, a] of due) {
    const rows: { key: string; master_id: number | null; release_id: number | null; artist: string; title: string; year: number | null; thumb: string | null; have: number; want: number }[] = [];
    for (let page = 1, pages = 1; page <= pages && page <= 3; page++) {
      const r = await call<{
        pagination: { pages: number };
        releases: {
          id: number;
          type?: string;
          role?: string;
          title: string;
          artist: string;
          year?: number;
          thumb?: string;
          format?: string;
          stats?: { community?: { in_collection?: number; in_wantlist?: number } };
        }[];
      }>(`/artists/${id}/releases?sort=year&sort_order=asc&per_page=100&page=${page}`);
      pages = r.pagination.pages;
      for (const x of r.releases) {
        if (x.role !== 'Main') continue;
        const isMaster = x.type === 'master';
        if (!isMaster && x.format && !formatOk(x.format, s) && !/Album/.test(x.format)) continue;
        rows.push({
          key: `${isMaster ? 'm' : 'r'}${x.id}`,
          master_id: isMaster ? x.id : null,
          release_id: isMaster ? null : x.id,
          artist: (x.artist || a.name).replace(/\s\(\d+\)$/, ''),
          title: x.title,
          year: x.year || null,
          thumb: x.thumb || null,
          have: x.stats?.community?.in_collection ?? 0,
          want: x.stats?.community?.in_wantlist ?? 0,
        });
      }
    }
    tx(() => {
      run('DELETE FROM deal_missing WHERE artist_id = ?', id);
      for (const m of rows) {
        run(
          'INSERT OR REPLACE INTO deal_missing (key, master_id, release_id, artist_id, artist, title, year, thumb, have, want) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          m.key, m.master_id, m.release_id, id, m.artist, m.title, m.year, m.thumb, m.have, m.want,
        );
      }
      run('INSERT OR REPLACE INTO deal_artists (artist_id, crawled_at) VALUES (?, ?)', id, now());
    });
    status.done++;
  }
}

export interface MissingAlbum {
  key: string;
  masterId: number | null;
  releaseId: number | null;
  artistId: number;
  artist: string;
  title: string;
  year: number | null;
  thumb: string | null;
  have: number;
  want: number;
  owned: number; // records by this artist you own
  onCd: boolean; // owned in another format (see ownedOn)
  ownedOn: string | null;
  onWantlist: boolean;
  skipped: string | null;
  url: string;
}

export function missingAlbums(s = dealSettings()): MissingAlbum[] {
  const p = profile();
  const w = wants();
  const hidden = hiddenSets();
  const rows = all<{ key: string; master_id: number | null; release_id: number | null; artist_id: number; artist: string; title: string; year: number | null; thumb: string | null; have: number; want: number }>(
    'SELECT * FROM deal_missing',
  );
  const out: MissingAlbum[] = [];
  for (const r of rows) {
    const owned = p.artists.get(r.artist_id)?.n ?? 0;
    if (owned < s.fit.minOwnedForMissing) continue;
    const m = r.master_id ? p.masters.get(r.master_id) : undefined;
    const want = wantedMedia(s);
    if ((m && [...want].some((x) => m.has(x))) || (r.release_id && p.releases.has(r.release_id))) continue;
    if (r.master_id && hidden.master.has(String(r.master_id))) continue;
    if (hidden.artist.has(String(r.artist_id))) continue;
    const onOther = m ? [...m].find((x) => !want.has(x)) : undefined;
    const onCd = !!onOther;
    out.push({
      key: r.key,
      masterId: r.master_id,
      releaseId: r.release_id,
      artistId: r.artist_id,
      artist: r.artist,
      title: r.title,
      year: r.year,
      thumb: r.thumb,
      have: r.have,
      want: r.want,
      owned,
      onCd,
      onWantlist: (!!r.master_id && w.masters.has(r.master_id)) || (!!r.release_id && w.releases.has(r.release_id)),
      skipped: skipReason({ title: r.title, formats: [], liveNotes: false }, s) ?? (onOther && s.skip.ownedOnCd ? `You have it on ${mediaName[onOther]}` : null),
      ownedOn: onOther ? mediaName[onOther] : null,
      url: r.master_id ? `https://www.discogs.com/master/${r.master_id}` : `https://www.discogs.com/release/${r.release_id}`,
    });
  }
  return out.sort((a, b) => b.owned - a.owned || b.have - a.have);
}

/* ---------- 8. wantlist ---------- */

/** Picks the version of an album to put on the wantlist: one in a format you look for. */
async function pickVersion(masterId: number, version: 'popular' | 'original'): Promise<number | null> {
  const s = dealSettings();
  const r = await call<{
    versions: { id: number; format?: string; major_formats?: string[]; released?: string; stats?: { community?: { in_collection?: number } } }[];
  }>(`/masters/${masterId}/versions?per_page=100&sort=released&sort_order=asc`);
  const ok = r.versions.filter((v) => {
    const text = `${(v.major_formats ?? []).join(', ')}, ${v.format ?? ''}`;
    return formatOk(text, s) && !/Unofficial/.test(text);
  });
  if (!ok.length) return null;
  if (version === 'original') return ok[0].id;
  return ok.reduce((a, b) => ((b.stats?.community?.in_collection ?? 0) > (a.stats?.community?.in_collection ?? 0) ? b : a)).id;
}

const AUTO_NOTE = 'Added by the JPlay Records deal finder';

/** Puts a release (or the best LP version of an album) on your Discogs wantlist. */
export async function addToWantlist(opts: { releaseId?: number; masterId?: number; auto?: boolean; artist?: string; title?: string }) {
  const s = dealSettings();
  let releaseId = opts.releaseId ?? null;
  if (!releaseId && opts.masterId) releaseId = await pickVersion(opts.masterId, s.wantlist.version);
  if (!releaseId) throw new Error('No version of this album on Discogs in the formats you look for.');
  const u = encodeURIComponent(discogsUser()!);
  const notes = opts.auto ? `?notes=${encodeURIComponent(AUTO_NOTE)}` : '';
  await call(`/users/${u}/wants/${releaseId}${notes}`, { method: 'PUT' });
  run(
    'INSERT OR REPLACE INTO deal_wants (release_id, master_id, artist, title, notes) VALUES (?, ?, ?, ?, ?)',
    releaseId,
    opts.masterId ?? releaseOf(releaseId)?.masterId ?? null,
    opts.artist ?? '',
    opts.title ?? '',
    opts.auto ? AUTO_NOTE : '',
  );
  if (opts.auto) {
    run(
      'INSERT OR REPLACE INTO deal_autowants (release_id, master_id, artist, title, added_at) VALUES (?, ?, ?, ?, ?)',
      releaseId, opts.masterId ?? null, opts.artist ?? '', opts.title ?? '', now(),
    );
  }
  wantsCache = null;
  return releaseId;
}

async function autoWantlist(s: DealSettings) {
  const done = new Set(all<{ master_id: number }>('SELECT master_id FROM deal_autowants WHERE master_id IS NOT NULL').map((r) => r.master_id));
  const picks = missingAlbums(s)
    .filter((m) => m.masterId && !m.onWantlist && !m.skipped && m.owned >= s.wantlist.minOwned && !done.has(m.masterId))
    .sort((a, b) => b.owned - a.owned || b.have - a.have)
    .slice(0, s.wantlist.maxPerRun);
  status.total = picks.length;
  for (const m of picks) {
    try {
      await addToWantlist({ masterId: m.masterId!, auto: true, artist: m.artist, title: m.title });
    } catch (e) {
      if (e instanceof BudgetSpent) throw e;
      // Remember it anyway so a release without an LP version isn't tried every run.
      run('INSERT OR IGNORE INTO deal_autowants (release_id, master_id, artist, title, added_at, removed_at) VALUES (?, ?, ?, ?, ?, ?)', -m.masterId!, m.masterId, m.artist, m.title, now(), now());
    }
    status.done++;
  }
}

/** Removes everything the finder put on your wantlist (that's still there). */
export async function removeAutoWants(): Promise<number> {
  const u = encodeURIComponent(discogsUser()!);
  const rows = all<{ release_id: number }>('SELECT release_id FROM deal_autowants WHERE removed_at IS NULL AND release_id > 0');
  let n = 0;
  for (const r of rows) {
    try {
      await discogs(`/users/${u}/wants/${r.release_id}`, { method: 'DELETE' });
      n++;
    } catch (e) {
      if (!(e instanceof DiscogsError && e.status === 404)) throw e;
    }
    run('UPDATE deal_autowants SET removed_at = ? WHERE release_id = ?', now(), r.release_id);
    run('DELETE FROM deal_wants WHERE release_id = ?', r.release_id);
  }
  wantsCache = null;
  return n;
}

export const autoWantCount = () => get<{ n: number }>('SELECT COUNT(*) AS n FROM deal_autowants WHERE removed_at IS NULL AND release_id > 0')!.n;

/* ---------- cleanup ---------- */

function cleanup() {
  run("DELETE FROM deal_listings WHERE status = 'gone' AND checked_at < ?", now() - 14 * DAY);
  run("DELETE FROM deal_listings WHERE status = 'active' AND checked_at < ?", now() - 90 * DAY);
  run('DELETE FROM deal_releases WHERE release_id NOT IN (SELECT release_id FROM deal_listings) AND fetched_at < ?', now() - 30 * DAY);
  run('DELETE FROM deal_prices WHERE release_id NOT IN (SELECT release_id FROM deal_listings)');
  relCache.clear();
}

/* ---------- the deals list ---------- */

function hiddenSets() {
  const rows = all<{ kind: string; key: string }>('SELECT kind, key FROM deal_hidden');
  const by = (k: string) => new Set(rows.filter((r) => r.kind === k).map((r) => r.key.toLowerCase()));
  return { master: by('master'), release: by('release'), artist: by('artist'), seller: by('seller') };
}

export interface Deal {
  listingId: number;
  releaseId: number;
  masterId: number | null;
  artist: string;
  title: string;
  year: number | null;
  country: string | null;
  format: string;
  labels: string;
  styles: string[];
  thumb: string | null;
  condition: string;
  sleeve: string;
  comments: string;
  seller: string;
  sellerRating: number | null;
  sellerSales: number | null;
  shipsFrom: string;
  price: { value: number; currency: string; display: number | null; shippingDisplay: number | null; refDisplay: number | null; lowestDisplay: number | null };
  priceView: PriceView;
  fit: Fit;
  score: number;
  skipped: string | null;
  url: string;
  releaseUrl: string;
  allowOffers: boolean;
  onWantlist: boolean;
  firstSeen: number;
  checkedAt: number;
  posted: string | null;
  source: string;
  notifiedAt: number | null;
}

/**
 * Every active listing with its fit, price and whether your filters skip it.
 * `skipped` names the first filter that hides it (null = shown).
 */
export function computeDeals(s = dealSettings(), opts: { includeUnpriced?: boolean } = {}): Deal[] {
  const p = profile();
  const hidden = hiddenSets();
  const w = wants();
  const rows = all<ListingRow>("SELECT * FROM deal_listings WHERE status = 'active'");
  const disp = (eur: number | null) => (eur == null ? null : Math.round((convert(eur, 'EUR', s.currency) ?? eur) * 100) / 100);
  const out: Deal[] = [];
  for (const l of rows) {
    const rel = releaseOf(l.release_id);
    if (!rel) continue; // details not fetched yet
    const fit = fitOf(rel, s, p);
    const pv = priceOf(l, s);
    let skipped: string | null = null;
    if (fit.owned) skipped = 'Already in your collection';
    else if (!inRegion(l.ships_from, s)) skipped = `Ships from ${l.ships_from}`;
    else if (hidden.seller.has(l.seller.toLowerCase())) skipped = 'Seller hidden';
    else if (hidden.release.has(String(l.release_id)) || (rel.masterId && hidden.master.has(String(rel.masterId)))) skipped = 'Album hidden';
    else if (rel.artists.some((a) => hidden.artist.has(String(a.id)))) skipped = 'Artist hidden';
    else if (fit.score < s.fit.minFit) skipped = 'Not a close enough fit';
    else skipped = skipReason(rel, s);
    if (!skipped && fit.ownedOther && s.skip.ownedOnCd) skipped = `You have it on ${fit.ownedOther}`;
    if (!skipped && !mediaOk(l.condition, s)) skipped = `Media ${short(l.condition)}`;
    if (!skipped && !sleeveOk(l.sleeve, s)) skipped = `Sleeve ${short(l.sleeve) || 'not graded'}`;
    if (!skipped && l.seller_rating != null && l.seller_rating < s.minSellerRating) skipped = `Seller ${l.seller_rating}%`;
    if (!skipped && l.seller_sales != null && l.seller_sales < s.minSellerSales) skipped = 'Seller has few sales';
    if (!skipped && s.maxPrice != null && pv.priceEur != null && (disp(pv.priceEur) ?? 0) > s.maxPrice) skipped = 'Above your max price';
    if (!skipped && !opts.includeUnpriced && pv.priceEur == null) skipped = 'Unknown currency';
    const dealPart = pv.discount != null ? Math.max(0, Math.min(100, 50 + pv.discount * 150)) : pv.cheapest ? 70 : 40;
    out.push({
      listingId: l.listing_id,
      releaseId: l.release_id,
      masterId: rel.masterId,
      artist: rel.artists.map((a) => a.name).join(', ') || l.artist,
      title: rel.title || l.title,
      year: rel.year,
      country: rel.country,
      format: rel.formats.map((f) => [`${Number(f.qty) > 1 ? f.qty + '×' : ''}${f.name}`, ...(f.descriptions ?? [])].join(', ')).join(' + ') || l.format,
      labels: rel.labels.map((x) => `${x.name}${x.catno && x.catno !== 'none' ? ' – ' + x.catno : ''}`).join(', '),
      styles: rel.styles,
      thumb: rel.thumb || l.thumb,
      condition: l.condition,
      sleeve: l.sleeve,
      comments: l.comments,
      seller: l.seller,
      sellerRating: l.seller_rating,
      sellerSales: l.seller_sales,
      shipsFrom: l.ships_from,
      price: {
        value: l.price,
        currency: l.currency,
        display: disp(pv.priceEur),
        shippingDisplay: disp(pv.shippingEur),
        refDisplay: disp(pv.refEur),
        lowestDisplay: disp(pv.lowestEur),
      },
      priceView: pv,
      fit,
      score: Math.round(fit.score * 0.55 + dealPart * 0.45),
      skipped,
      url: l.uri || `https://www.discogs.com/sell/item/${l.listing_id}`,
      releaseUrl: `https://www.discogs.com/release/${l.release_id}`,
      allowOffers: !!l.allow_offers,
      onWantlist: w.releases.has(l.release_id) || (!!rel.masterId && w.masters.has(rel.masterId)),
      firstSeen: l.first_seen,
      checkedAt: l.checked_at,
      posted: l.posted,
      source: l.source,
      notifiedAt: l.notified_at,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** "Very Good Plus (VG+)" → "VG+". */
export const short = (c: string) => /\(([^)]+)\)$/.exec(c)?.[1] ?? c;

/* ---------- hiding things ---------- */

export function hide(kind: string, key: string, label: string) {
  if (!['master', 'release', 'artist', 'seller'].includes(kind) || !key) throw new Error('Nothing to hide.');
  run('INSERT OR REPLACE INTO deal_hidden (kind, key, label, added_at) VALUES (?, ?, ?, ?)', kind, key, label.slice(0, 200), now());
}
export function unhide(kind: string, key: string) {
  run('DELETE FROM deal_hidden WHERE kind = ? AND key = ?', kind, key);
}
export const hiddenList = () =>
  all<{ kind: string; key: string; label: string; added_at: number }>('SELECT kind, key, label, added_at FROM deal_hidden ORDER BY added_at DESC');

/* ---------- sellers ---------- */

export const sellerList = () =>
  all<{ username: string; source: string; enabled: number; ships_from: string | null; rating: number | null; sales: number | null; last_crawl_at: number | null; last_error: string | null }>(
    'SELECT username, source, enabled, ships_from, rating, sales, last_crawl_at, last_error FROM deal_sellers ORDER BY source, username COLLATE NOCASE',
  );

export function addSeller(username: string) {
  const u = username.trim().replace(/^https?:\/\/(www\.)?discogs\.com\/(seller|user)\//i, '').replace(/\/.*$/, '');
  if (!/^[\w.\-]{2,40}$/.test(u)) throw new Error('That is not a Discogs username.');
  run("INSERT INTO deal_sellers (username, source, added_at) VALUES (?, 'manual', ?) ON CONFLICT(username) DO UPDATE SET source = 'manual', enabled = 1", u, now());
}
export function setSellerEnabled(username: string, enabled: boolean) {
  run('UPDATE deal_sellers SET enabled = ? WHERE username = ?', enabled ? 1 : 0, username);
}
export function removeSeller(username: string) {
  run('DELETE FROM deal_sellers WHERE username = ?', username);
}

/* ---------- the browser helper's token ---------- */

const sha = (x: string) => createHash('sha256').update(x).digest('hex');

export function newHelperToken(): string {
  const token = randomBytes(24).toString('base64url');
  setSetting('dealsHelperToken', sha(token));
  return token;
}
export function helperTokenOk(token: string) {
  const h = getSetting<string | null>('dealsHelperToken', null);
  return !!token && !!h && sha(token) === h;
}
export const helperLastSeen = () => getSetting<number | null>('dealsHelperSeenAt', null);
export const markHelperSeen = () => setSetting('dealsHelperSeenAt', now());

/** Marks deals as sent in a digest. */
export function markNotified(ids: number[]) {
  const t = now();
  tx(() => {
    for (const id of ids) run('UPDATE deal_listings SET notified_at = ? WHERE listing_id = ?', t, id);
  });
}

/* ---------- schedule ---------- */

/** Runs the finder every `everyHours` (checked each minute), and the browser queue whenever it fills. */
export function startDealsWorker() {
  setInterval(() => {
    const s = dealSettings();
    if (!s.enabled || status.running) return;
    const last = status.lastRunAt ?? 0;
    if (now() - last >= s.everyHours * 3600_000) startDealsRun('scheduled');
  }, 60_000).unref();
}
