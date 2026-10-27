import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireAdmin, requireViewer, type Env } from '../auth.ts';
import {
  createListener,
  deleteListener,
  deletePlay,
  exportForHub,
  ingest,
  listenerByToken,
  listeners,
  listPlays,
  markHeard,
  matchForHub,
  nowPlaying,
  recentSpins,
  mergeDuplicates,
  rematch,
  resetPlay,
  setPlayRecord,
  stats,
  updateListener,
} from '../spins.ts';

const bad = (msg: string, status: 400 | 401 | 404 = 400) => new HTTPException(status, { message: msg });

/* ---------- JPlaying Now units post here (Authorization: Bearer <listener token>) ---------- */

export const spinsIngest = new Hono();

spinsIngest.post('/', async (c) => {
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const l = token ? listenerByToken(token) : undefined;
  if (!l) throw bad('Unknown listener token.', 401);
  const b = await c.req.json<{ events?: unknown[] }>();
  if (!Array.isArray(b.events)) throw bad('Send {"events": [...]}.');
  const accepted = ingest(l, b.events as never[]);
  return c.json({ accepted, room: l.room });
});

/* ---------- the JPlay hub (jpvaneerde/jplayer): collection matching and import, with a listener token ---------- */

const listenerOnly: MiddlewareHandler = async (c, next) => {
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !listenerByToken(token)) throw bad('Unknown listener token.', 401);
  return next();
};

export const spinsMatch = new Hono();
spinsMatch.use('*', listenerOnly);
spinsMatch.post('/', async (c) => {
  const b = await c.req.json<{ songs?: unknown[] }>();
  if (!Array.isArray(b.songs)) throw bad('Send {"songs": [...]}.');
  return c.json({ results: matchForHub(b.songs as never[]) });
});

export const spinsExport = new Hono();
spinsExport.use('*', listenerOnly);
spinsExport.get('/', (c) =>
  c.json(exportForHub(c.req.query('part') ?? '', c.req.query('after') ?? '', Math.min(Math.max(Number(c.req.query('limit')) || 500, 1), 1000))),
);

/* ---------- reading (anyone who may browse) ---------- */

export const spins = new Hono<Env>();
spins.use('*', requireViewer);

spins.get('/now', (c) => c.json({ rooms: nowPlaying() }));

spins.get('/plays', (c) =>
  c.json(
    listPlays({
      kind: c.req.query('kind') || undefined,
      room: c.req.query('room') || undefined,
      limit: Math.min(Number(c.req.query('limit')) || 60, 200),
      offset: Math.max(Number(c.req.query('offset')) || 0, 0),
    }),
  ),
);

spins.get('/spins', (c) => c.json({ spins: recentSpins(Math.min(Number(c.req.query('limit')) || 30, 100), c.req.query('room') || undefined) }));

spins.get('/stats', (c) => c.json(stats(Math.max(Number(c.req.query('days') ?? 30) || 0, 0))));

/* ---------- owner: listeners and corrections ---------- */

export const spinsAdmin = new Hono<Env>();
spinsAdmin.use('*', requireAdmin);

function cleanListener(b: { name?: unknown; room?: unknown; priority?: unknown; formats?: unknown }) {
  const name = String(b.name ?? '').trim().slice(0, 40);
  const room = String(b.room ?? '').trim().slice(0, 40);
  if (!name || !room) throw bad('Give the listener a name and a room.');
  const priority = Math.round(Math.min(Math.max(Number(b.priority) || 1, 0), 100));
  const formats = (Array.isArray(b.formats) ? b.formats : [])
    .map((f) => String(f).toLowerCase())
    .filter((f) => ['vinyl', 'cd', 'cassette'].includes(f));
  return { name, room, priority, formats };
}

spinsAdmin.get('/listeners', (c) => c.json({ listeners: listeners() }));

spinsAdmin.post('/listeners', async (c) => {
  const l = cleanListener(await c.req.json());
  const token = createListener(l.name, l.room, l.priority, l.formats);
  return c.json({ token, listeners: listeners() });
});

spinsAdmin.put('/listeners/:id', async (c) => {
  const l = cleanListener(await c.req.json());
  updateListener(c.req.param('id'), l.name, l.room, l.priority, l.formats);
  return c.json({ listeners: listeners() });
});

spinsAdmin.delete('/listeners/:id', (c) => {
  deleteListener(c.req.param('id'));
  return c.json({ listeners: listeners() });
});

spinsAdmin.post('/rematch', (c) => {
  const days = Number(c.req.query('days')) || 365;
  return c.json({ changed: mergeDuplicates(days) + rematch(days) });
});

spinsAdmin.delete('/plays/:id', (c) => {
  deletePlay(Number(c.req.param('id')));
  return c.json({ ok: true });
});

/** {heard: true} = "not one of my records"; {record: <instance id>} = "it was this copy"; {auto: true} = undo. */
spinsAdmin.put('/plays/:id', async (c) => {
  const b = await c.req.json<{ heard?: boolean; record?: number; auto?: boolean }>();
  const id = Number(c.req.param('id'));
  if (b.auto) resetPlay(id);
  else if (b.heard) markHeard(id);
  else if (b.record && !setPlayRecord(id, Number(b.record))) throw bad('That record is not in the collection.', 404);
  return c.json({ ok: true });
});
