// Where is a record on the shelf?
//
// Records stand in Discogs' "sort by artist" order (discogs_rank). Each "run" is a piece of furniture
// for some formats: a grid of compartments (JP's 12" LPs: a stack of 6 BESTÅ 120×40×38 frames = 6 rows ×
// 2 compartments) or one long row. We walk the run in order, adding each record's thickness, and move
// to the next compartment when the current one is full. Anchors ("this record is the first one in
// compartment X") correct drift. A Discogs custom field (e.g. "Location") overrides the computed spot.

import { all, getSetting, setSetting, type ItemRow } from './db.ts';

export interface Run {
  id: string;
  name: string;
  /** Which records: Discogs format names (Vinyl, CD, Cassette, Box Set, …). Empty = everything not matched by another run. */
  formats: string[];
  /** Vinyl sizes for this run (12", 10", 7"). Empty = any size. */
  sizes: string[];
  rows: number;
  cols: number;
  /** Usable width of one compartment in mm (BESTÅ 120 frame: ~2 × 564 mm). */
  compartmentMm: number;
  /** Fill row by row (left → right, then the next row) or column by column. */
  order: 'rows' | 'columns';
  /** Which row is filled first. */
  start: 'top' | 'bottom';
  /** Average thickness of one record in its sleeve, and what each extra disc adds. */
  itemMm: number;
  extraDiscMm: number;
  /** Calibrate: spread the whole run evenly over this many compartments (null = use the thicknesses as they are). */
  spreadOver: number | null;
}

export interface ShelfConfig {
  /** auto: the Discogs field when filled in, else computed. computed: always computed. field: only the field. */
  source: 'auto' | 'computed' | 'field';
  fieldName: string;
  runs: Run[];
  /** Records pinned as the first one in a compartment: instance id → compartment index (0-based, fill order). */
  anchors: Record<string, { run: string; compartment: number }>;
}

export const DEFAULT_CONFIG: ShelfConfig = {
  source: 'auto',
  fieldName: 'Location',
  runs: [
    {
      id: 'lp',
      name: 'LPs',
      formats: ['Vinyl', 'Box Set'],
      sizes: ['12"'],
      rows: 6,
      cols: 2,
      compartmentMm: 560,
      order: 'rows',
      start: 'top',
      itemMm: 4,
      extraDiscMm: 3,
      spreadOver: 7,
    },
    { id: 'ten', name: '10" records', formats: ['Vinyl'], sizes: ['10"'], rows: 1, cols: 1, compartmentMm: 2000, order: 'rows', start: 'top', itemMm: 3.5, extraDiscMm: 2.5, spreadOver: null },
    { id: 'seven', name: 'Singles (7")', formats: ['Vinyl'], sizes: ['7"'], rows: 1, cols: 1, compartmentMm: 2000, order: 'rows', start: 'top', itemMm: 3, extraDiscMm: 2, spreadOver: null },
    { id: 'cd', name: 'CDs', formats: ['CD', 'CDr', 'SACD'], sizes: [], rows: 1, cols: 1, compartmentMm: 4000, order: 'rows', start: 'top', itemMm: 10.4, extraDiscMm: 5, spreadOver: null },
    { id: 'other', name: 'Other', formats: [], sizes: [], rows: 1, cols: 1, compartmentMm: 4000, order: 'rows', start: 'top', itemMm: 12, extraDiscMm: 4, spreadOver: null },
  ],
  anchors: {},
};

export function shelfConfig(): ShelfConfig {
  const c = getSetting<Partial<ShelfConfig>>('shelves', {});
  return { ...DEFAULT_CONFIG, ...c, runs: c.runs?.length ? c.runs : DEFAULT_CONFIG.runs, anchors: c.anchors ?? {} };
}

export function saveShelfConfig(c: ShelfConfig) {
  setSetting('shelves', c);
  invalidateShelves();
}

export interface Position {
  source: 'computed' | 'field';
  run: string;
  runName: string;
  /** Short code, e.g. "3R" (row 3, right compartment). */
  label: string;
  /** Human version, e.g. "Row 3 · right". */
  place: string;
  compartment: number | null; // fill-order index, null when unknown or past the last one
  row: number | null; // 0 = top
  col: number | null; // 0 = left
  nth: number | null; // 1-based from the left within the compartment
  inCompartment: number | null;
  /** Centre of the record across the compartment, 0 = left edge, 1 = right edge (for LEDs later). */
  at: number | null;
  overflow: boolean;
  fieldValue: string | null;
  anchored: boolean;
}

export interface GridView {
  id: string;
  name: string;
  rows: number;
  cols: number;
  order: Run['order'];
  start: Run['start'];
  /** For each compartment (fill order): row, col, label and how many records it holds. */
  compartments: { index: number; row: number; col: number; label: string; count: number; first: string | null; last: string | null }[];
  overflow: number;
}

type Item = Pick<ItemRow, 'instance_id' | 'artist' | 'title' | 'format' | 'size' | 'discs' | 'fields' | 'discogs_rank'>;

let cache: { positions: Map<number, Position>; grids: GridView[]; members: Map<string, number[][]> } | null = null;

export function invalidateShelves() {
  cache = null;
}

export function cellOf(run: Pick<Run, 'rows' | 'cols' | 'order' | 'start'>, index: number) {
  let row: number, col: number;
  if (run.order === 'columns') {
    col = Math.floor(index / run.rows);
    row = index % run.rows;
  } else {
    row = Math.floor(index / run.cols);
    col = index % run.cols;
  }
  if (run.start === 'bottom') row = run.rows - 1 - row;
  return { row, col };
}

export function cellLabel(run: Pick<Run, 'rows' | 'cols'>, row: number, col: number) {
  if (run.rows === 1 && run.cols === 1) return { label: '', place: '' };
  if (run.cols === 1) return { label: String(row + 1), place: `Shelf ${row + 1}` };
  if (run.cols === 2) return { label: `${row + 1}${col ? 'R' : 'L'}`, place: `Row ${row + 1} · ${col ? 'right' : 'left'}` };
  return { label: `${row + 1}${String.fromCharCode(65 + col)}`, place: `Row ${row + 1} · column ${col + 1}` };
}

function runFor(it: Item, runs: Run[]): Run | undefined {
  return (
    runs.find((r) => r.formats.length && r.formats.includes(it.format) && (!r.sizes.length || r.sizes.includes(it.size))) ??
    runs.find((r) => !r.formats.length)
  );
}

function build() {
  const cfg = shelfConfig();
  const items = all<Item>(
    'SELECT instance_id, artist, title, format, size, discs, fields, discogs_rank FROM items ORDER BY discogs_rank',
  );
  const byRun = new Map<string, Item[]>();
  for (const it of items) {
    const r = runFor(it, cfg.runs);
    if (!r) continue;
    if (!byRun.has(r.id)) byRun.set(r.id, []);
    byRun.get(r.id)!.push(it);
  }

  const positions = new Map<number, Position>();
  const grids: GridView[] = [];
  const members = new Map<string, number[][]>();

  for (const run of cfg.runs) {
    const list = byRun.get(run.id) ?? [];
    const total = Math.max(1, run.rows * run.cols);
    const width = (it: Item) => run.itemMm + Math.max(0, it.discs - 1) * run.extraDiscMm;
    const sum = list.reduce((s, it) => s + width(it), 0);
    // Calibration: scale thicknesses so the run ends exactly at the end of compartment `spreadOver`.
    const scale = run.spreadOver && sum > 0 ? (Math.min(run.spreadOver, total) * run.compartmentMm) / sum : 1;
    const comps: { ids: number[]; widths: number[] }[] = Array.from({ length: total }, () => ({ ids: [], widths: [] }));
    const overflow: number[] = [];
    // Walk along the run (mm from its start); a record belongs to the compartment its centre falls in
    // (records squeeze a little, so a compartment can be slightly over-full rather than skipping space).
    let offset = 0;
    let floor = 0; // never move back before an anchor
    for (const it of list) {
      const w = width(it) * scale;
      const anchor = cfg.anchors[String(it.instance_id)];
      if (anchor && anchor.run === run.id && anchor.compartment < total) {
        offset = anchor.compartment * run.compartmentMm;
        floor = anchor.compartment;
      }
      const c = Math.max(floor, Math.floor((offset + w / 2) / run.compartmentMm));
      offset += w;
      if (c >= total) {
        overflow.push(it.instance_id);
        continue;
      }
      comps[c].ids.push(it.instance_id);
      comps[c].widths.push(w);
    }

    const byId = new Map(list.map((it) => [it.instance_id, it]));
    const name = (id: number | undefined) => (id ? byId.get(id)?.artist ?? null : null);
    grids.push({
      id: run.id,
      name: run.name,
      rows: run.rows,
      cols: run.cols,
      order: run.order,
      start: run.start,
      compartments: comps.map((cp, index) => {
        const { row, col } = cellOf(run, index);
        return { index, row, col, label: cellLabel(run, row, col).label, count: cp.ids.length, first: name(cp.ids[0]), last: name(cp.ids.at(-1)) };
      }),
      overflow: overflow.length,
    });
    members.set(run.id, [...comps.map((cp) => cp.ids), overflow]);

    comps.forEach((cp, index) => {
      const { row, col } = cellOf(run, index);
      const lbl = cellLabel(run, row, col);
      const fill = cp.widths.reduce((s, w) => s + w, 0);
      const span = Math.max(fill, run.compartmentMm);
      let x = 0;
      cp.ids.forEach((id, i) => {
        const w = cp.widths[i];
        positions.set(id, {
          source: 'computed',
          run: run.id,
          runName: run.name,
          label: lbl.label,
          place: lbl.place,
          compartment: index,
          row,
          col,
          nth: i + 1,
          inCompartment: cp.ids.length,
          at: (x + w / 2) / span,
          overflow: false,
          fieldValue: null,
          anchored: !!cfg.anchors[String(id)],
        });
        x += w;
      });
    });
    for (const id of overflow) {
      positions.set(id, {
        source: 'computed',
        run: run.id,
        runName: run.name,
        label: '',
        place: 'After the last compartment',
        compartment: null,
        row: null,
        col: null,
        nth: null,
        inCompartment: null,
        at: null,
        overflow: true,
        fieldValue: null,
        anchored: false,
      });
    }
  }

  // The Discogs field wins where it is filled in.
  if (cfg.source !== 'computed' && cfg.fieldName) {
    for (const it of items) {
      const fields = JSON.parse(it.fields || '{}') as Record<string, string>;
      const value = Object.entries(fields).find(([k]) => k.toLowerCase() === cfg.fieldName.toLowerCase())?.[1];
      const computed = positions.get(it.instance_id);
      if (!value) {
        if (cfg.source === 'field') positions.delete(it.instance_id);
        continue;
      }
      // When the value matches a compartment code (e.g. "3R"), show it on that run's map.
      const run = cfg.runs.find((r) => r.id === computed?.run) ?? runFor(it, cfg.runs);
      const grid = grids.find((g) => g.id === run?.id);
      const cell = grid?.compartments.find((cp) => cp.label && cp.label.toLowerCase() === value.trim().toLowerCase());
      positions.set(it.instance_id, {
        source: 'field',
        run: run?.id ?? '',
        runName: run?.name ?? '',
        label: cell?.label ?? value,
        place: cell && run ? cellLabel(run, cell.row, cell.col).place : value,
        compartment: cell?.index ?? null,
        row: cell?.row ?? null,
        col: cell?.col ?? null,
        nth: null,
        inCompartment: null,
        at: null,
        overflow: false,
        fieldValue: value,
        anchored: false,
      });
    }
  }

  cache = { positions, grids, members };
  return cache;
}

function data() {
  return cache ?? build();
}

export function positionOf(instanceId: number): Position | null {
  return data().positions.get(instanceId) ?? null;
}

export function grids(): GridView[] {
  return data().grids;
}

/** Instance ids in one compartment (or the overflow when compartment = -1), in shelf order. */
export function compartmentMembers(run: string, compartment: number): number[] {
  const m = data().members.get(run);
  if (!m) return [];
  return (compartment < 0 ? m.at(-1) : m[compartment]) ?? [];
}

/** Neighbours on the shelf (same run, computed order): helps to find it physically. */
export function neighbours(instanceId: number, n = 3): { before: number[]; after: number[] } {
  const p = data().positions.get(instanceId);
  if (!p) return { before: [], after: [] };
  const flat = (data().members.get(p.run) ?? []).flat();
  const i = flat.indexOf(instanceId);
  if (i < 0) return { before: [], after: [] };
  return { before: flat.slice(Math.max(0, i - n), i), after: flat.slice(i + 1, i + 1 + n) };
}
