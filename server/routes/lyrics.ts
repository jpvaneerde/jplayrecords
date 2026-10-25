import { Hono } from 'hono';
import { requireViewer, type Env } from '../auth.ts';
import { lookupLyrics } from '../lyrics.ts';
import { listenerByToken } from '../spins.ts';

/**
 * GET /api/lyrics?artist=&title=&album=&duration=
 * For JPlaying Now units (Authorization: Bearer <listener token>) and anyone who may browse.
 */
export const lyricsApi = new Hono<Env>();

lyricsApi.use('*', async (c, next) => {
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token && listenerByToken(token)) return next();
  return requireViewer(c, next);
});

lyricsApi.get('/', async (c) => {
  const q = (k: string) => c.req.query(k) ?? '';
  const duration = Number(q('duration'));
  const ans = await lookupLyrics(q('artist'), q('title'), q('album'), Number.isFinite(duration) && duration > 0 ? duration : null);
  // LRCLIB couldn't be reached from here: say so (502), so a unit asks LRCLIB itself instead of trusting a "not found"
  if (ans.unavailable) return c.json({ error: 'LRCLIB could not be reached from JPlay Records.' }, 502);
  return c.json(ans);
});
