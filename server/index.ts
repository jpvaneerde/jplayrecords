import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { HTTPException } from 'hono/http-exception';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { DATA_DIR, DISCOGS_TOKEN, JPLAY_API, PORT, PUBLIC_ORIGIN, PUBLIC_URL, STATIC_DIR, SYNC_TIME, TZ, ADMIN_EMAIL, DEV_ADMIN } from './config.ts';
import './db.ts';
import { COVER_DIR, getSetting } from './db.ts';
import { linkDevice, requireViewer, type Env } from './auth.ts';
import { admin, records, session } from './routes/api.ts';
import { scheduleNightly, startSync } from './discogs.ts';
import { spins, spinsAdmin, spinsExport, spinsFromHub, spinsIngest, spinsMatch } from './routes/spins.ts';
import { lyricsApi } from './routes/lyrics.ts';
import { listenerByToken, startSpinsWorker } from './spins.ts';

const app = new Hono<Env>();

app.get('/healthz', (c) => c.text('ok\n'));

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
});

// API writes must come from this site.
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== PUBLIC_ORIGIN) throw new HTTPException(403, { message: 'Cross-site request blocked.' });
    if (!c.req.header('content-type')?.includes('application/json') && c.req.method !== 'DELETE') {
      throw new HTTPException(415, { message: 'Send JSON.' });
    }
  }
  c.header('Cache-Control', 'no-store');
  await next();
});

app.route('/api/session', session);
app.route('/api/records', records);
app.route('/api/spins/events', spinsIngest);
app.route('/api/spins/match', spinsMatch); // the JPlay hub (listener token)
app.route('/api/spins/export', spinsExport);
app.route('/api/spins/hub-plays', spinsFromHub);
app.route('/api/spins', spins);
app.route('/api/admin/spins', spinsAdmin);
app.route('/api/admin', admin);
app.route('/api/lyrics', lyricsApi);
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Device link: signs a kiosk screen in (read-only) and opens the collection.
app.get('/d/:token', (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!linkDevice(c, c.req.param('token'))) return c.redirect('/?link=invalid');
  return c.redirect('/?kiosk=1');
});

// Cached covers (named after the Discogs release id). The JPlay hub fetches them with a listener token.
app.use('/covers/*', async (c, next) => {
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token && listenerByToken(token)) return next();
  return requireViewer(c, next);
});
app.use(
  '/covers/*',
  serveStatic({
    root: relative(process.cwd(), COVER_DIR) || '.',
    rewriteRequestPath: (p) => p.replace(/^\/covers/, ''),
    onFound: (_p, c) => {
      c.header('Cache-Control', 'private, max-age=604800');
    },
  }),
);
app.get('/covers/*', (c) => c.text('Not found', 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON.' }, 400);
  console.error(err);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

// The web app (built by Vite).
if (existsSync(STATIC_DIR)) {
  const indexHtml = readFileSync(join(STATIC_DIR, 'index.html'), 'utf8');
  app.use(
    '/assets/*',
    serveStatic({
      root: STATIC_DIR,
      onFound: (_p, c) => {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.get('/assets/*', (c) => c.text('Not found', 404));
  app.use('*', async (c, next) => {
    const p = c.req.path;
    if (extname(p) && extname(p) !== '.html' && existsSync(join(STATIC_DIR, p))) {
      return serveStatic({ root: STATIC_DIR, onFound: (_p, cc) => cc.header('Cache-Control', 'no-cache') })(c, next);
    }
    await next();
  });
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.html(indexHtml);
  });
}

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  startSpinsWorker();
  console.log(`JPlay Records listening on :${PORT} (public URL ${PUBLIC_URL}, data in ${DATA_DIR})`);
  if (DEV_ADMIN) console.log('DEV_ADMIN=1: everyone is the admin (local development only).');
  else if (!JPLAY_API || !ADMIN_EMAIL) console.log('JPLAY_API or ADMIN_EMAIL is not set: nobody can open Settings.');
  if (!DISCOGS_TOKEN) console.log('DISCOGS_TOKEN is not set: no syncing.');
  else {
    if (SYNC_TIME) {
      scheduleNightly(SYNC_TIME, TZ);
      console.log(`Nightly sync at ${SYNC_TIME} (${TZ}).`);
    }
    // First start: fill the collection straight away.
    if (!getSetting<number | null>('lastSyncAt', null)) startSync('first start');
  }
});
