// All settings come from environment variables (see README).

const env = process.env;

export const PORT = Number(env.PORT || 8080);
export const PUBLIC_URL = (env.PUBLIC_URL || 'http://127.0.0.1:5174').replace(/\/$/, '');
export const DATA_DIR = env.DATA_DIR || './data';
export const STATIC_DIR = env.STATIC_DIR || './dist';
export const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');
export const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;

/** Personal access token from https://www.discogs.com/settings/developers (Kubernetes secret). */
export const DISCOGS_TOKEN = (env.DISCOGS_TOKEN || '').trim();
/** Optional: whose collection to sync. Defaults to the owner of the token. */
export const DISCOGS_USER = (env.DISCOGS_USER || '').trim();
export const USER_AGENT = 'JPlayRecords/1.0.3 +https://github.com/jpvaneerde/jplayrecords';

/** Nightly sync time (24h, local time in TZ). Empty = no nightly sync. */
export const SYNC_TIME = (env.SYNC_TIME ?? '03:30').trim();
export const TZ = env.TZ || 'Europe/Stockholm';

/** The owner: the only one who can open Settings. Same address as on jplay.cloud. */
export const ADMIN_EMAIL = (env.ADMIN_EMAIL || '').trim().toLowerCase();
/** JPlay's API, used to check the shared jplay.cloud login (in-cluster address is fine). */
export const JPLAY_API = (env.JPLAY_API || '').replace(/\/$/, '');
/** Where the "Sign in" button sends you. */
export const JPLAY_LOGIN_URL = env.JPLAY_LOGIN_URL || 'https://jplay.cloud/login';
/**
 * Who else may browse with a JPlay login (read-only): "none" (default), "all" (any JPlay account),
 * or a comma-separated list of email addresses.
 */
export const READ_USERS = (env.READ_USERS || 'none').trim().toLowerCase();
/** Local development only: everyone is the admin. Ignored on https. */
export const DEV_ADMIN = env.DEV_ADMIN === '1' && !SECURE_COOKIES;

/** Deal digest by email: an SMTP URL such as smtps://user:password@smtp.example.com:465 (Kubernetes secret). */
export const SMTP_URL = (env.SMTP_URL || '').trim();
/** Who gets the digest (defaults to ADMIN_EMAIL) and who it's from. */
export const DEALS_MAIL_TO = (env.DEALS_MAIL_TO || env.ADMIN_EMAIL || '').trim();
export const DEALS_MAIL_FROM = (env.DEALS_MAIL_FROM || 'JPlay Records <records@jplay.cloud>').trim();
