import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAdmin, type Env } from '../auth.ts';
import { DISCOGS_TOKEN, PUBLIC_URL, SMTP_URL } from '../config.ts';
import { currencies } from '../fx.ts';
import { sendDigest, digestDeals } from '../digest.ts';
import {
  addSeller,
  addToWantlist,
  autoWantCount,
  computeDeals,
  CONDITIONS,
  dealSettings,
  dealsStatus,
  enqueueListings,
  EU,
  FORMATS,
  helperLastSeen,
  helperTokenOk,
  hiddenList,
  hide,
  markHelperSeen,
  missingAlbums,
  NEAR_EU,
  newHelperToken,
  removeAutoWants,
  removeSeller,
  saveDealSettings,
  sellerList,
  setSellerEnabled,
  SLEEVE_EXTRAS,
  startDealsRun,
  unhide,
  type DealSettings,
} from '../deals.ts';

const bad = (msg: string) => new HTTPException(400, { message: msg });

/* ---------- the owner's deals page ---------- */

export const dealsAdmin = new Hono<Env>();
dealsAdmin.use('*', requireAdmin);

function overview() {
  const s = dealSettings();
  return {
    status: dealsStatus(),
    settings: s,
    options: { formats: FORMATS, conditions: CONDITIONS, sleeveExtras: SLEEVE_EXTRAS, eu: EU, nearEu: NEAR_EU, currencies: currencies() },
    tokenSet: !!DISCOGS_TOKEN,
    emailReady: !!SMTP_URL,
    helperSeenAt: helperLastSeen(),
    autoWants: autoWantCount(),
  };
}

dealsAdmin.get('/', (c) => {
  const s = dealSettings();
  const all = computeDeals(s);
  const shown = all.filter((d) => !d.skipped);
  // Why the rest is hidden, for the "N skipped" summary.
  const skipped: Record<string, number> = {};
  for (const d of all) if (d.skipped) skipped[d.skipped.replace(/ \d+(\.\d+)?%$/, '')] = (skipped[d.skipped.replace(/ \d+(\.\d+)?%$/, '')] ?? 0) + 1;
  const showSkipped = c.req.query('skipped') === '1';
  return c.json({
    ...overview(),
    deals: (showSkipped ? all : shown).slice(0, 400),
    counts: { shown: shown.length, all: all.length, skipped },
    digestPreview: digestDeals(s).length,
  });
});

dealsAdmin.get('/status', (c) => c.json(dealsStatus()));

dealsAdmin.get('/missing', (c) => {
  const showSkipped = c.req.query('skipped') === '1';
  const list = missingAlbums();
  return c.json({ albums: (showSkipped ? list : list.filter((m) => !m.skipped)).slice(0, 500), total: list.length });
});

dealsAdmin.put('/settings', async (c) => {
  const b = await c.req.json<Partial<DealSettings>>();
  return c.json({ settings: saveDealSettings(b) });
});

dealsAdmin.post('/run', (c) => {
  if (!DISCOGS_TOKEN) throw bad('DISCOGS_TOKEN is not set on the server.');
  const started = startDealsRun('run now');
  if (!started && !dealsStatus().running) throw bad('Sync your collection first.');
  return c.json({ started, status: dealsStatus() });
});

dealsAdmin.post('/hide', async (c) => {
  const b = await c.req.json<{ kind?: string; key?: string | number; label?: string }>();
  try {
    hide(String(b.kind), String(b.key ?? ''), String(b.label ?? ''));
  } catch (e) {
    throw bad((e as Error).message);
  }
  return c.json({ hidden: hiddenList() });
});
dealsAdmin.get('/hidden', (c) => c.json({ hidden: hiddenList() }));
dealsAdmin.delete('/hidden/:kind/:key', (c) => {
  unhide(c.req.param('kind'), c.req.param('key'));
  return c.json({ hidden: hiddenList() });
});

dealsAdmin.post('/want', async (c) => {
  const b = await c.req.json<{ releaseId?: number; masterId?: number; artist?: string; title?: string }>();
  if (!b.releaseId && !b.masterId) throw bad('Which record?');
  try {
    const releaseId = await addToWantlist({ releaseId: b.releaseId, masterId: b.masterId, artist: b.artist, title: b.title });
    return c.json({ releaseId });
  } catch (e) {
    throw bad((e as Error).message);
  }
});

dealsAdmin.post('/unwant-auto', async (c) => c.json({ removed: await removeAutoWants() }));

dealsAdmin.get('/sellers', (c) => c.json({ sellers: sellerList() }));
dealsAdmin.post('/sellers', async (c) => {
  const b = await c.req.json<{ username?: string }>();
  try {
    for (const u of String(b.username ?? '').split(/[\s,]+/).filter(Boolean).slice(0, 50)) addSeller(u);
  } catch (e) {
    throw bad((e as Error).message);
  }
  return c.json({ sellers: sellerList() });
});
dealsAdmin.put('/sellers/:name', async (c) => {
  const b = await c.req.json<{ enabled?: boolean }>();
  setSellerEnabled(c.req.param('name'), b.enabled !== false);
  return c.json({ sellers: sellerList() });
});
dealsAdmin.delete('/sellers/:name', (c) => {
  removeSeller(c.req.param('name'));
  return c.json({ sellers: sellerList() });
});

dealsAdmin.post('/digest/test', async (c) => {
  const r = await sendDigest({ test: true });
  if (!r.sent && !r.errors.length) return c.json({ ...r, message: 'No deals to send at the moment.' });
  return c.json(r);
});

/** A new browser-helper userscript (with a fresh token; the old one stops working). */
dealsAdmin.post('/helper', (c) => {
  const token = newHelperToken();
  const host = new URL(PUBLIC_URL).hostname;
  const script = `// ==UserScript==
// @name         JPlay Records – Discogs deals helper
// @namespace    ${PUBLIC_URL}
// @version      1.0
// @description  Sends the listing ids on Discogs marketplace pages you open to JPlay Records, which reads them through the Discogs API.
// @match        https://www.discogs.com/*
// @grant        GM_xmlhttpRequest
// @connect      ${host}
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const SERVER = ${JSON.stringify(PUBLIC_URL)};
  const TOKEN = ${JSON.stringify(token)};
  const sent = new Set();

  function scan() {
    // Marketplace pages only: Shop my wants, search results, a release's listings, seller shops.
    if (!/^\\/(sell|seller|shop|[a-z]{2}\\/sell)\\b/.test(location.pathname)) return;
    const ids = [];
    for (const a of document.querySelectorAll('a[href*="/sell/item/"]')) {
      const m = /\\/sell\\/item\\/(\\d+)/.exec(a.getAttribute('href') || '');
      const id = m && Number(m[1]);
      if (id && !sent.has(id)) {
        sent.add(id);
        ids.push(id);
      }
    }
    if (!ids.length) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER + '/api/deals/ingest',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      data: JSON.stringify({ ids: ids }),
    });
  }

  scan();
  setInterval(scan, 3000); // pages that load more listings as you scroll
})();
`;
  return c.json({ script, filename: 'jplayrecords-deals.user.js' });
});

/* ---------- the browser helper (its own token, no cookies) ---------- */

export const dealsIngest = new Hono();

dealsIngest.post('/', async (c) => {
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!helperTokenOk(token)) throw new HTTPException(401, { message: 'Unknown helper. Download a new script under Deals → Settings.' });
  const b = await c.req.json<{ ids?: unknown[] }>();
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  markHelperSeen();
  return c.json({ queued: enqueueListings(ids) });
});
