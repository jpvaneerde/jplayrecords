// The deal digest: new deals by email and/or push (ntfy, or any webhook such as Home Assistant's).

import { DEALS_MAIL_FROM, DEALS_MAIL_TO, PUBLIC_URL, SMTP_URL, TZ, USER_AGENT } from './config.ts';
import { getSetting, setSetting } from './db.ts';
import { computeDeals, dealSettings, markNotified, short, type Deal, type DealSettings } from './deals.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function money(v: number | null, cur: string) {
  if (v == null) return '?';
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: cur, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
}

/** The deals that would go out now: shown, at the chosen level, not sent before. */
export function digestDeals(s: DealSettings, includeSent = false): Deal[] {
  const ok = (d: Deal) =>
    s.digest.minLevel === 'any' || d.priceView.level === 'great' || (s.digest.minLevel === 'good' && d.priceView.level === 'good');
  return computeDeals(s)
    .filter((d) => !d.skipped && ok(d) && (includeSent || !d.notifiedAt))
    .slice(0, s.digest.max);
}

function line(d: Deal, cur: string) {
  const off = d.priceView.discount != null && d.priceView.discount > 0 ? ` (${Math.round(d.priceView.discount * 100)}% below typical)` : d.priceView.cheapest ? ' (cheapest on Discogs)' : '';
  return `${d.artist} – ${d.title}: ${money(d.price.display, cur)}${off}, ${short(d.condition)}/${short(d.sleeve) || '–'}, ${d.seller} (${d.shipsFrom})`;
}

function html(deals: Deal[], cur: string) {
  const rows = deals
    .map((d) => {
      const off = d.priceView.discount != null && d.priceView.discount > 0 ? `${Math.round(d.priceView.discount * 100)}% below typical` : d.priceView.cheapest ? 'Cheapest on Discogs' : '';
      return `<tr>
  <td style="padding:8px 10px 8px 0;vertical-align:top">${d.thumb ? `<img src="${esc(d.thumb)}" width="64" height="64" style="border-radius:6px;object-fit:cover" alt="">` : ''}</td>
  <td style="padding:8px 0;vertical-align:top;font-family:system-ui,sans-serif;font-size:14px">
    <a href="${esc(d.url)}" style="color:#047857;font-weight:700;text-decoration:none">${esc(d.artist)} – ${esc(d.title)}</a><br>
    <b>${esc(money(d.price.display, cur))}</b>${d.price.shippingDisplay != null ? ` + ${esc(money(d.price.shippingDisplay, cur))} shipping` : ''}
    ${off ? ` · <span style="color:#047857">${esc(off)}</span>` : ''}<br>
    <span style="color:#6b7280">Media ${esc(short(d.condition))} · Sleeve ${esc(short(d.sleeve) || '–')} · ${esc(d.seller)} (${esc(d.shipsFrom)})<br>${esc(d.fit.reasons.slice(0, 2).join(' · '))}</span>
  </td></tr>`;
    })
    .join('');
  return `<div style="max-width:640px"><h2 style="font-family:system-ui,sans-serif">${deals.length} new record deal${deals.length === 1 ? '' : 's'}</h2>
<table cellspacing="0" cellpadding="0">${rows}</table>
<p style="font-family:system-ui,sans-serif;font-size:13px"><a href="${PUBLIC_URL}/deals">All deals in JPlay Records</a></p></div>`;
}

export async function sendDigest(opts: { test?: boolean } = {}): Promise<{ sent: number; channels: string[]; errors: string[] }> {
  const s = dealSettings();
  const deals = digestDeals(s, opts.test);
  const channels: string[] = [];
  const errors: string[] = [];
  if (!deals.length) return { sent: 0, channels, errors };
  const cur = s.currency;
  const subject = opts.test ? `Test: ${deals.length} record deals` : `${deals.length} new record deal${deals.length === 1 ? '' : 's'}`;
  const text = deals.map((d) => `• ${line(d, cur)}\n  ${d.url}`).join('\n') + `\n\nAll deals: ${PUBLIC_URL}/deals`;

  if (s.digest.email) {
    if (!SMTP_URL || !DEALS_MAIL_TO) errors.push('Email: SMTP_URL (and DEALS_MAIL_TO or ADMIN_EMAIL) are not set on the server.');
    else {
      try {
        const nodemailer = await import('nodemailer');
        const t = nodemailer.createTransport(SMTP_URL);
        await t.sendMail({ from: DEALS_MAIL_FROM, to: DEALS_MAIL_TO, subject, text, html: html(deals, cur) });
        channels.push('email');
      } catch (e) {
        errors.push(`Email: ${(e as Error).message}`);
      }
    }
  }
  if (s.digest.push) {
    if (!s.digest.pushUrl) errors.push('Push: no push address set.');
    else {
      try {
        const top = deals.slice(0, 5).map((d) => `• ${line(d, cur)}`).join('\n') + (deals.length > 5 ? `\n…and ${deals.length - 5} more` : '');
        const res =
          s.digest.pushKind === 'ntfy'
            ? await fetch(s.digest.pushUrl, {
                method: 'POST',
                headers: { Title: subject, Click: `${PUBLIC_URL}/deals`, Tags: 'cd', 'User-Agent': USER_AGENT },
                body: top,
                signal: AbortSignal.timeout(15_000),
              })
            : await fetch(s.digest.pushUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
                body: JSON.stringify({
                  title: subject,
                  message: top,
                  url: `${PUBLIC_URL}/deals`,
                  deals: deals.map((d) => ({ artist: d.artist, title: d.title, price: d.price.display, currency: cur, level: d.priceView.level, url: d.url, shipsFrom: d.shipsFrom })),
                }),
                signal: AbortSignal.timeout(15_000),
              });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        channels.push('push');
      } catch (e) {
        errors.push(`Push: ${(e as Error).message}`);
      }
    }
  }
  if (channels.length && !opts.test) markNotified(deals.map((d) => d.listingId));
  if (errors.length) console.warn('Deal digest:', errors.join(' | '));
  return { sent: channels.length ? deals.length : 0, channels, errors };
}

/** Checks every half minute whether it's digest time (daily, or weekly on the chosen day, local time in TZ). */
export function startDigestSchedule() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const enDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  setInterval(() => {
    const s = dealSettings();
    if (s.digest.mode === 'off' || (!s.digest.email && !s.digest.push)) return;
    const d = new Date();
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    const [hh, mm] = s.digest.time.split(':').map(Number);
    if (Number(parts.hour) !== hh || Number(parts.minute) !== mm) return;
    if (s.digest.mode === 'weekly' && days.indexOf(enDay.format(d)) !== s.digest.weekday) return;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (getSetting<string>('dealsDigestDay', '') === day) return;
    setSetting('dealsDigestDay', day);
    void sendDigest().catch((e) => console.error('Deal digest failed:', (e as Error).message));
  }, 30_000).unref();
}
