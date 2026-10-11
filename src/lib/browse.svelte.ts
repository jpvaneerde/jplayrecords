// The browse state lives here (not in the page) so it survives opening a record and coming back.

import { api, type Facets, type ListItem } from './api';

export interface Filters {
  q: string;
  format: string;
  genre: string;
  decade: string;
  artist: string;
  letter: string;
  shelf: string; // "<run>:<compartment>"
  sort: '' | 'shelf' | 'added' | 'year' | 'year-desc' | 'title';
}

const EMPTY: Filters = { q: '', format: '', genre: '', decade: '', artist: '', letter: '', shelf: '', sort: '' };
const PAGE = 120;

class Browse {
  filters = $state<Filters>({ ...EMPTY });
  items = $state<ListItem[]>([]);
  total = $state(0);
  loading = $state(false);
  error = $state('');
  facets = $state<Facets | null>(null);
  /** Remembered scroll position of the grid. */
  scrollTop = 0;
  /** Label for the shelf filter ("LPs · 3L"). */
  shelfLabel = $state('');

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  active = $derived(
    !!(this.filters.format || this.filters.genre || this.filters.decade || this.filters.artist || this.filters.letter || this.filters.shelf),
  );

  params(extra: Record<string, string | number> = {}) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(this.filters)) if (v) p.set(k, String(v));
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return p.toString();
  }

  async loadFacets() {
    try {
      this.facets = await api.get<Facets>('/records/facets');
    } catch {
      /* the grid shows the error */
    }
  }

  /** Reload from the start (after a filter change). Typing is debounced. */
  reload(debounce = 0) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fetch(true), debounce);
  }

  async more() {
    if (this.loading || this.items.length >= this.total) return;
    await this.fetch(false);
  }

  private async fetch(reset: boolean) {
    const seq = ++this.seq;
    this.loading = true;
    try {
      const r = await api.get<{ total: number; items: ListItem[] }>(
        `/records?${this.params({ limit: PAGE, offset: reset ? 0 : this.items.length })}`,
      );
      if (seq !== this.seq) return;
      this.total = r.total;
      this.items = reset ? r.items : [...this.items, ...r.items];
      if (reset) this.scrollTop = 0;
      this.error = '';
    } catch (e) {
      if (seq === this.seq) this.error = (e as Error).message;
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  set<K extends keyof Filters>(key: K, value: Filters[K]) {
    this.filters[key] = value;
    // Picking an artist replaces the letter; a shelf replaces the rest.
    if (key === 'artist' && value) this.filters.letter = '';
    if (key === 'letter' && value) this.filters.artist = '';
    this.reload(key === 'q' ? 220 : 0);
  }

  showShelf(shelf: string, label: string) {
    this.filters = { ...EMPTY, shelf, sort: 'shelf' };
    this.shelfLabel = label;
    this.reload();
  }

  clear(keepQuery = false) {
    this.filters = { ...EMPTY, q: keepQuery ? this.filters.q : '' };
    this.reload();
  }

  async random(): Promise<number | null> {
    try {
      const r = await api.get<{ id: number }>(`/records/random?${this.params()}`);
      return r.id;
    } catch {
      return null;
    }
  }
}

export const browse = new Browse();
