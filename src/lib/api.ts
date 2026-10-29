// Calls to the JPlay Records server (/api). Cookies carry the login or the device link.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check the network.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

export interface Display {
  idleSeconds: number;
  screensaver: boolean;
  keyboard: 'auto' | 'always' | 'never';
  tile: 's' | 'm' | 'l';
  theme: 'dark' | 'light' | 'retro';
}

export interface ListItem {
  id: number;
  releaseId: number;
  artist: string;
  title: string;
  /** Original release year (Discogs master), else this pressing's year. */
  year: number | null;
  pressingYear: number | null;
  format: string;
  cover: string | null;
}

export interface Facet {
  key: string;
  n: number;
  label?: string;
}

export interface Facets {
  total: number;
  formats: Facet[];
  genres: Facet[];
  styles: Facet[];
  decades: Facet[];
  letters: Facet[];
}

export interface Position {
  source: 'computed' | 'field';
  run: string;
  runName: string;
  label: string;
  place: string;
  compartment: number | null;
  row: number | null;
  col: number | null;
  nth: number | null;
  inCompartment: number | null;
  at: number | null;
  overflow: boolean;
  fieldValue: string | null;
  anchored: boolean;
}

export interface Compartment {
  index: number;
  row: number;
  col: number;
  label: string;
  count: number;
  first: string | null;
  last: string | null;
}

export interface Grid {
  id: string;
  name: string;
  rows: number;
  cols: number;
  order: 'rows' | 'columns';
  start: 'top' | 'bottom';
  compartments: Compartment[];
  overflow: number;
}

export interface RecordDetail {
  item: ListItem & {
    coverLarge: string | null;
    formatText: string;
    labels: string;
    genres: string[];
    styles: string[];
    fields: Record<string, string>;
    rating: number;
    dateAdded: string | null;
    copies: number;
    discogsUrl: string;
  };
  details: {
    country: string | null;
    released: string | null;
    notes: string | null;
    url: string | null;
    tracklist: { position: string; title: string; duration: string; heading: boolean; artists?: string }[];
    credits: { name: string; role: string }[];
    barcodes: string[];
  } | null;
  position: Position | null;
  grid: Grid | null;
  played: { spins: number; tracks: number; last: { at: number; room: string } | null };
  neighbours: { before: ListItem[]; after: ListItem[] };
}

export interface Run {
  id: string;
  name: string;
  formats: string[];
  sizes: string[];
  rows: number;
  cols: number;
  compartmentMm: number;
  order: 'rows' | 'columns';
  start: 'top' | 'bottom';
  itemMm: number;
  extraDiscMm: number;
  spreadOver: number | null;
}

export interface ShelfConfig {
  source: 'auto' | 'computed' | 'field';
  fieldName: string;
  runs: Run[];
  anchors: Record<string, { run: string; compartment: number }>;
}

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

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface AdminState {
  sync: SyncStatus;
  tokenSet: boolean;
  syncTime: string;
  timeZone: string;
  fields: { id: number; name: string }[];
  shelves: ShelfConfig;
  grids: Grid[];
  devices: Device[];
  display: Display;
  lyrics: { songs: number; found: number; synced: number };
}

/* ---------- Spins ---------- */

export interface PlayView {
  id: number;
  room: string;
  kind: 'physical' | 'streamed' | 'heard';
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
  /** Why it was matched this way (or why it isn't yours). */
  note: string | null;
  /** Other copies it could have been. */
  alternatives: { id: number; artist: string; title: string; medium: string; cover: string | null }[];
}

export interface SpinView {
  instanceId: number;
  room: string;
  medium: string;
  startedAt: number;
  endedAt: number;
  tracks: number;
  record: { id: number; artist: string; title: string; year: number | null; cover: string | null };
}

export interface RoomNow {
  room: string;
  online: boolean;
  session: { mode: string; station: string; startedAt: number } | null;
  play: PlayView | null;
}

export interface SpinStats {
  days: number;
  physical: { spins: number; tracks: number; vinylHours: number };
  streamed: { tracks: number };
  heard: { tracks: number };
  radio: { room: string; station: string; hours: number }[];
  streamingHours: number;
  topArtists: { artist: string; n: number }[];
  topRecords: { id: number; artist: string; title: string; cover: string | null; spins: number }[];
}

export interface ListenerView {
  id: string;
  name: string;
  room: string;
  priority: number;
  formats: string[];
  createdAt: number;
  lastSeenAt: number | null;
}

/* ---------- deals ---------- */

export interface DealSettings {
  enabled: boolean;
  everyHours: number;
  countries: string[];
  currency: string;
  maxPrice: number | null;
  minMedia: string;
  minSleeve: string;
  sleeveAlso: string[];
  minSellerRating: number;
  minSellerSales: number;
  formats: string[]; // LP, EP, Single, 12", 10", 7", CD, Cassette
  skip: {
    compilations: boolean;
    live: boolean;
    boxSets: boolean;
    unofficial: boolean;
    pictureDiscs: boolean;
    reissues: boolean;
    promos: boolean;
    ownedOnCd: boolean;
  };
  skipWords: string[];
  fit: {
    wantlist: boolean;
    artists: boolean;
    labelsStyles: boolean;
    minFit: number;
    discoveryMinHave: number;
    discoveryPerRun: number;
    minOwnedForMissing: number;
  };
  levels: { great: number; good: number };
  learnSellers: boolean;
  maxCallsPerRun: number;
  pagesPerSeller: number;
  digest: {
    mode: 'off' | 'daily' | 'weekly';
    time: string;
    weekday: number;
    email: boolean;
    push: boolean;
    pushUrl: string;
    pushKind: 'ntfy' | 'webhook';
    minLevel: 'great' | 'good' | 'any';
    max: number;
  };
  wantlist: { auto: boolean; maxPerRun: number; minOwned: number; version: 'popular' | 'original' };
}

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
  priceView: { discount: number | null; level: 'great' | 'good' | 'fair' | 'unknown'; cheapest: boolean; refKind: 'suggestion' | 'seen' | null };
  fit: { score: number; kind: 'want' | 'artist' | 'label' | 'style' | 'none'; reasons: string[]; ownedOnCd: boolean; ownedOther: string | null };
  score: number;
  skipped: string | null;
  url: string;
  releaseUrl: string;
  allowOffers: boolean;
  onWantlist: boolean;
  firstSeen: number;
  posted: string | null;
}

export interface DealsOverview {
  status: DealsStatus;
  settings: DealSettings;
  options: { formats: string[]; conditions: string[]; sleeveExtras: string[]; eu: string[]; nearEu: string[]; currencies: string[] };
  tokenSet: boolean;
  emailReady: boolean;
  helperSeenAt: number | null;
  autoWants: number;
  deals: Deal[];
  counts: { shown: number; all: number; skipped: Record<string, number> };
  digestPreview: number;
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
  owned: number;
  onCd: boolean;
  ownedOn: string | null;
  onWantlist: boolean;
  skipped: string | null;
  url: string;
}

export interface DealSeller {
  username: string;
  source: 'manual' | 'learned';
  enabled: number;
  ships_from: string | null;
  rating: number | null;
  sales: number | null;
  last_crawl_at: number | null;
  last_error: string | null;
}

export interface HiddenThing {
  kind: 'master' | 'release' | 'artist' | 'seller';
  key: string;
  label: string;
  added_at: number;
}
