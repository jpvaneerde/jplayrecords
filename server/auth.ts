// Who is looking?
//  - admin:  JP, signed in on jplay.cloud. The shared JPlay cookie (domain jplay.cloud) also reaches
//            records.jplay.cloud; we ask JPlay's API who it belongs to.
//  - viewer: a kiosk screen opened through its device link, or (optional) another JPlay account.
//  - nobody: sees the "sign in or link this screen" page.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { ADMIN_EMAIL, DEV_ADMIN, JPLAY_API, READ_USERS, SECURE_COOKIES } from './config.ts';
import { get, now, run } from './db.ts';

export type Role = 'admin' | 'viewer';
export interface Access {
  role: Role;
  name: string;
  via: 'jplay' | 'device' | 'dev';
  deviceId?: string;
}
export type Env = { Variables: { access: Access } };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/* ---------- kiosk devices ---------- */

const DEVICE_COOKIE = SECURE_COOKIES ? '__Host-jplayrecords-device' : 'jplayrecords-device';
const DEVICE_MAX_AGE = 400 * 86_400; // Chrome's maximum; renewed whenever the screen is used

export function newDevice(name: string) {
  const token = randomBytes(24).toString('base64url');
  const id = randomUUID();
  run('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)', id, name, sha(token), now());
  return { id, token };
}

/** The device link (/d/<token>) signs a screen in and keeps it signed in with a cookie. */
export function linkDevice(c: Context, token: string): boolean {
  const d = get<{ id: string }>('SELECT id FROM devices WHERE token_hash = ?', sha(token));
  if (!d) return false;
  setDeviceCookie(c, token);
  run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now(), d.id);
  return true;
}

function setDeviceCookie(c: Context, token: string) {
  setCookie(c, DEVICE_COOKIE, token, { httpOnly: true, secure: SECURE_COOKIES, sameSite: 'Lax', path: '/', maxAge: DEVICE_MAX_AGE });
}

function deviceAccess(c: Context): Access | null {
  const token = getCookie(c, DEVICE_COOKIE);
  if (!token) return null;
  const d = get<{ id: string; name: string; last_seen_at: number | null }>(
    'SELECT id, name, last_seen_at FROM devices WHERE token_hash = ?',
    sha(token),
  );
  if (!d) return null;
  // Renew the cookie and the "last seen" time about once a day.
  if (!d.last_seen_at || now() - d.last_seen_at > 86_400_000) {
    run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now(), d.id);
    setDeviceCookie(c, token);
  }
  return { role: 'viewer', name: d.name, via: 'device', deviceId: d.id };
}

/* ---------- JPlay login ---------- */

const jplayCache = new Map<string, { at: number; who: { email: string; name: string } | null }>();

async function jplayUser(cookieHeader: string): Promise<{ email: string; name: string } | null> {
  const key = sha(cookieHeader);
  const hit = jplayCache.get(key);
  if (hit && now() - hit.at < 60_000) return hit.who;
  let who: { email: string; name: string } | null = null;
  try {
    const res = await fetch(`${JPLAY_API}/api/me`, { headers: { cookie: cookieHeader, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = (await res.json()) as { user?: { email: string; name: string } };
      if (data.user?.email) who = { email: data.user.email.toLowerCase(), name: data.user.name };
    }
  } catch (e) {
    console.warn('Could not reach JPlay to check the login:', (e as Error).message);
    if (hit) return hit.who; // JPlay restarting: keep the last answer a bit longer
  }
  jplayCache.set(key, { at: now(), who });
  if (jplayCache.size > 500) jplayCache.delete(jplayCache.keys().next().value!);
  return who;
}

function mayRead(email: string) {
  if (READ_USERS === 'all') return true;
  if (READ_USERS === 'none' || !READ_USERS) return false;
  return READ_USERS.split(',').map((s) => s.trim()).includes(email);
}

export async function access(c: Context): Promise<Access | null> {
  if (DEV_ADMIN) return { role: 'admin', name: 'Developer', via: 'dev' };
  const cookies = c.req.header('cookie') ?? '';
  if (JPLAY_API && /(^|;\s*)(__Secure-jplay|__Host-jplay|jplay)=/.test(cookies)) {
    // Forward only JPlay's own cookies.
    const jp = cookies
      .split(/;\s*/)
      .filter((p) => /^(__Secure-jplay|__Host-jplay|jplay)=/.test(p))
      .join('; ');
    const who = await jplayUser(jp);
    if (who && ADMIN_EMAIL && who.email === ADMIN_EMAIL) return { role: 'admin', name: who.name, via: 'jplay' };
    if (who && mayRead(who.email)) return { role: 'viewer', name: who.name, via: 'jplay' };
  }
  return deviceAccess(c);
}

export const requireViewer: MiddlewareHandler<Env> = async (c, next) => {
  const a = await access(c);
  if (!a) throw new HTTPException(401, { message: 'Sign in or open this screen through its device link.' });
  c.set('access', a);
  await next();
};

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const a = await access(c);
  if (!a) throw new HTTPException(401, { message: 'Sign in first.' });
  if (a.role !== 'admin') throw new HTTPException(403, { message: 'Only the owner can change settings.' });
  c.set('access', a);
  await next();
};
