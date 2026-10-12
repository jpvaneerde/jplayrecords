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
}
