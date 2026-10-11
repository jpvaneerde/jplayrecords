// Fills ./data with a fake collection (abstract generated covers) to try the UI without a Discogs token.
//   npm run demo-data

import sharp from 'sharp';
import { join } from 'node:path';
import { COVER_DIR, indexItem, now, run, setSetting, tx } from './db.ts';

const artists = [
  'ABBA', 'AC/DC', 'Adele', 'Air', 'The Beatles', 'Beck', 'Björk', 'Blondie', 'David Bowie', 'Kate Bush', 'The Clash',
  'Leonard Cohen', 'John Coltrane', 'The Cure', 'Miles Davis', 'Depeche Mode', 'Dire Straits', 'Bob Dylan', 'Eurythmics',
  'Fleetwood Mac', 'Peter Gabriel', 'Marvin Gaye', 'Genesis', 'Herbie Hancock', 'Jimi Hendrix', 'Joy Division', 'Kraftwerk',
  'Led Zeppelin', 'Joni Mitchell', 'Massive Attack', 'New Order', 'Nirvana', 'Pink Floyd', 'Portishead', 'Prince',
  'Queen', 'Radiohead', 'Lou Reed', 'R.E.M.', 'The Rolling Stones', 'Roxy Music', 'Sade', 'Nina Simone', 'Simple Minds',
  'The Smiths', 'Steely Dan', 'Talking Heads', 'Tom Waits', 'U2', 'Underworld', 'Stevie Wonder', 'Neil Young', 'Frank Zappa',
];
const words = ['Blue', 'Night', 'Electric', 'Gold', 'Silent', 'Paper', 'Velvet', 'Glass', 'Northern', 'Summer', 'Wild', 'Crystal', 'Neon', 'Lost', 'Echoes', 'Radio', 'Heart', 'Dreams', 'Ocean', 'Stories', 'Machine', 'Garden', 'Light', 'River'];
const genres = [['Rock'], ['Electronic'], ['Jazz'], ['Pop'], ['Rock', 'Pop'], ['Funk / Soul'], ['Electronic', 'Pop'], ['Folk, World, & Country']];
const styles = ['Synth-pop', 'New Wave', 'Post-Punk', 'Art Rock', 'Hard Bop', 'Trip Hop', 'Soft Rock', 'Indie Rock', 'Ambient', 'Prog Rock'];
const labels = ['Columbia', 'EMI', 'Blue Note', 'Island', 'Mute', 'Factory', 'Warner Bros. Records', 'Virgin', 'Polydor', '4AD'];

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

const sortKey = (a: string) => a.replace(/^The /, '').toLowerCase();
const list: { artist: string; title: string; year: number; format: string; size: string; discs: number }[] = [];
for (const a of artists) {
  const n = 2 + Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const [format, size] = r < 0.78 ? ['Vinyl', '12"'] : r < 0.86 ? ['Vinyl', '7"'] : r < 0.89 ? ['Vinyl', '10"'] : ['CD', ''];
    list.push({
      artist: a,
      title: `${pick(words)} ${pick(words)}`,
      year: 1962 + Math.floor(rnd() * 60),
      format,
      size,
      discs: rnd() < 0.15 ? 2 : 1,
    });
  }
}
// Discogs sorts by artist, then (roughly) title.
list.sort((x, y) => sortKey(x.artist).localeCompare(sortKey(y.artist)) || x.title.localeCompare(y.title));

const t = now();
const covers: { id: number; hue: number; text: string }[] = [];
tx(() => {
  run('DELETE FROM items');
  run('DELETE FROM search');
  list.forEach((it, rank) => {
    const id = 1000 + rank;
    const g = pick(genres);
    run(
      `INSERT INTO items (instance_id, release_id, folder_id, artist, title, year, format, size, discs, format_text, labels, genres, styles, fields, rating, date_added, cover_url, cover, discogs_rank, synced_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)`,
      id,
      id,
      it.artist,
      it.title,
      it.year,
      it.format,
      it.size,
      it.discs,
      `${it.discs > 1 ? it.discs + '×' : ''}${it.format}${it.size ? ', ' + it.size : ''}, ${it.format === 'Vinyl' && it.size === '12"' ? 'LP, ' : ''}Album`,
      `${pick(labels)} – ${String(Math.floor(rnd() * 90000) + 10000)}`,
      JSON.stringify(g),
      JSON.stringify([pick(styles)]),
      JSON.stringify(rnd() < 0.1 ? { 'Media Condition': 'Very Good Plus (VG+)' } : {}),
      new Date(t - Math.floor(rnd() * 3e10)).toISOString(),
      String(id),
      rank,
      t,
    );
    covers.push({ id, hue: Math.floor(rnd() * 360), text: it.artist });
    indexItem(id);
  });
});
setSetting('lastSyncAt', t);
setSetting('discogsUser', 'demo');
setSetting('discogsFields', [
  { id: 1, name: 'Media Condition' },
  { id: 2, name: 'Sleeve Condition' },
  { id: 3, name: 'Notes' },
]);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
for (const c of covers) {
  const h2 = (c.hue + 40 + Math.floor(rnd() * 120)) % 360;
  const shape = Math.floor(rnd() * 3);
  const art =
    shape === 0
      ? `<circle cx="${200 + rnd() * 200}" cy="${200 + rnd() * 200}" r="${100 + rnd() * 140}" fill="hsl(${h2} 70% 60%)" opacity=".85"/>`
      : shape === 1
        ? `<rect x="${rnd() * 200}" y="${rnd() * 200}" width="${250 + rnd() * 200}" height="${60 + rnd() * 80}" fill="hsl(${h2} 75% 55%)"/>`
        : `<path d="M0 ${300 + rnd() * 200} Q 300 ${rnd() * 600} 600 ${300 + rnd() * 200} V600 H0Z" fill="hsl(${h2} 65% 50%)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="hsl(${c.hue} 45% 22%)"/>${art}
    <text x="36" y="560" font-family="sans-serif" font-weight="800" font-size="44" fill="#fff" opacity=".9">${esc(c.text)}</text></svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  await sharp(buf).toFile(join(COVER_DIR, `${c.id}.jpg`));
  await sharp(buf).resize(360, 360).webp({ quality: 78 }).toFile(join(COVER_DIR, `${c.id}-s.webp`));
}
console.log(`Demo collection: ${list.length} items.`);
