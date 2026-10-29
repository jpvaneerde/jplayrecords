// Exchange rates from the European Central Bank (daily reference rates, EUR based).
// Used by the deal finder to compare listings priced in different currencies.

import { USER_AGENT } from './config.ts';
import { getSetting, setSetting } from './db.ts';

const ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const MAX_AGE = 12 * 3600_000;

interface Rates {
  at: number;
  perEur: Record<string, number>; // 1 EUR = x <currency>
}

let rates: Rates = getSetting<Rates>('fxRates', { at: 0, perEur: { EUR: 1 } });
let loading: Promise<void> | null = null;

async function load() {
  try {
    const res = await fetch(ECB, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ECB ${res.status}`);
    const xml = await res.text();
    const perEur: Record<string, number> = { EUR: 1 };
    for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) perEur[m[1]] = Number(m[2]);
    if (Object.keys(perEur).length < 10) throw new Error('unexpected ECB answer');
    rates = { at: Date.now(), perEur };
    setSetting('fxRates', rates);
  } catch (e) {
    console.warn('Exchange rates:', (e as Error).message, '(keeping the last known rates)');
  }
}

/** Refreshes the rates when older than 12 hours. */
export async function refreshRates() {
  if (Date.now() - rates.at < MAX_AGE) return;
  loading ??= load().finally(() => (loading = null));
  await loading;
}

/** Converts an amount between currencies; null when a rate is unknown. */
export function convert(value: number, from: string, to: string): number | null {
  if (from === to) return value;
  const f = rates.perEur[from];
  const t = rates.perEur[to];
  if (!f || !t) return null;
  return (value / f) * t;
}

export const toEur = (value: number, from: string) => convert(value, from, 'EUR');

/** Currencies we can show prices in. */
export const currencies = () => Object.keys(rates.perEur).sort();
