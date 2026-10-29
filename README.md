# JPlay Records

A touch-friendly browser for JP's record and CD collection, for the screen in the record room. It's part of the JPlay
family (jplay.cloud) and uses the same stack and style. The collection comes from Discogs. The app shows covers,
search and filters, and tells you **which shelf compartment a record stands in**.

Live at https://records.jplay.cloud. The image is `ghcr.io/jpvaneerde/jplayrecords`. Deployment manifests are in
`jpvaneerde/argocd` under `apps/jplayrecords`.

## How it fits together

One Node 24 server (`server/`, Hono) serves the Svelte 5 web app (`src/`, built by Vite) and an API under `/api`.
Data lives in `$DATA_DIR/records.db` (SQLite), and covers live in `$DATA_DIR/covers/`, both on one Longhorn volume.

- **Discogs sync.** On first start and every night (`SYNC_TIME`), and whenever you press **Sync now** in Settings,
  the server:
  1. reads the whole collection ("All" folder) through the Discogs API with your personal access token, **sorted by
     artist**, the same order you see in Discogs;
  2. downloads each cover once and keeps it next to a small WebP copy for the grid;
  3. looks up the **original release year** of every album through its Discogs *master*. The grid, decade filter
     and year sort use that year. The record page also shows the year of your pressing when it differs;
  4. fetches tracklists slowly, so you can search track titles too.

  Discogs allows 60 requests per minute. A first sync of 1,000 records takes about 35 minutes, mostly for
  original years and tracklists. After that, only new records are fetched.
- **Search** uses SQLite FTS5 over artist, title, label and catalogue number, format, genres and styles, year,
  your custom Discogs fields and the tracks. Every word matches the start of a word, and accents are ignored
  ("bjork" finds Björk).
- **Who can see what**
  - The **kiosk screen** signs in with a device link (`/d/<token>`, created under Settings → Kiosk screens). It
    can only read, and you can unlink it at any time.
  - **Settings** are only for `ADMIN_EMAIL`, signed in on **jplay.cloud**. JPlay's login cookie is set for the
    `jplay.cloud` domain, so it also reaches `records.jplay.cloud`. This server asks JPlay's API (`JPLAY_API`,
    in-cluster) whose cookie it is. JPlay Records has no passwords of its own.
  - Other JPlay accounts get read-only access only when you allow them (`READ_USERS`).

## Where is it on the shelf?

The collection is split over **shelves**. Each shelf takes some formats and fills its compartments in Discogs' artist
order. The defaults match the record room:

| Shelf | Takes | Layout |
| --- | --- | --- |
| LPs | Vinyl and box sets, 12" (LPs and 12" EPs) | A stack of 6 IKEA BESTÅ frames, 120×40×38 cm: **6 rows × 2 compartments** of ~56 cm. Filled row by row from the top, left then right. **Spread over 7** compartments (3½ frames are in use). |
| 10" records, Singles (7"), CDs, Other | everything else | one long row each, for now |

How a position is worked out:

1. Every record has a thickness: about 4 mm in its sleeve, plus 3 mm for each extra disc (doubles, box sets).
2. **Spread over N** scales those thicknesses so the shelf ends exactly at the end of compartment N. Set it to
   the number of compartments you really fill, and the estimate stays calibrated as the collection grows.
3. Walking along the shelf in artist order, a record belongs to the compartment its middle falls in. The record
   page shows the compartment (e.g. **2R** = row 2, right), "about the 23rd of 46 from the left", a map of the
   shelf and the records next to it.
4. **Wrong place?** On a record page, the owner taps the compartment where that record is really the first one.
   That pins it, and everything after it moves along.
5. **Discogs field.** If you fill in a custom collection field called `Location` in Discogs (e.g. `3L`), it
   overrides the computed spot. You can change the field name and the rule under Settings → Shelves.

Every value above can be changed under **Settings → Shelves**: rows, compartments, width, fill direction, starting
row, thicknesses and which formats go where.

## Spins: what was played, where

JPlaying Now units in the lounge and the study ("listeners") report to `POST /api/spins/events`. Each sends what its
microphone recognises (Shazam) and what its room's JPlay player is doing: which source (Radio, Plex, CD, Spotify,
Bluetooth), which station and which song. The server turns that into one history at
**records.jplay.cloud/spins**, and each record page says how often it was put on.

How a song is attributed, about 45 seconds after the last report:

1. **Heard in both rooms** at about the same time: **one play**, in the room with the highest listener priority
   (the lounge).
2. **That room's JPlay player is playing:**
   - a **CD in the player**: a **physical** play of your CD (which copy is found in the collection; if it isn't
     there, it's still a CD play, without a copy)
   - **Radio, Plex, Spotify or Bluetooth**: a **streamed** play, labelled with that source. For radio without song
     names, the unit recognises the song from the stream itself; when the microphone heard something else at that
     moment, the microphone wins.
3. **Player idle:** the song is matched against the collection. Only formats the room can play count (study: CD;
   lounge: vinyl and CD):
   - **Vinyl or CD:** if you own it on vinyl, it's vinyl; otherwise on CD, it's CD. Your copy is found by artist
     plus album or track title, using the synced tracklists.
   - **Artist only:** if only the artist matches, it's still counted as that format:
     - with **one** record by that artist, as that record
     - with **several**, as "which record?", which you pick on the Spins page
   - **Not in collection:** nothing matched (TV, a phone, …). These plays are kept but not counted as records, and
     the page says why.
4. **The player's song info on its own** also adds plays the microphone missed. Radio time is counted per station
   even when no song is known. (Plays from the old moOde players show as "moOde".)
5. **One play per song:** the same song from the radio's text and from the microphone, or from both rooms, is one
   play, also when the artist is spelled differently (radio text like "Magasinet i P3 med …, spelar nu Dua Lipa"
   against "Dua Lipa"); the clean name is kept. **Match again** also merges such duplicates from before.
6. **Spins:** physical plays of the same copy with less than 20 minutes between them form one "spin", the record
   being put on.

Listeners are created under **Settings → Listeners**: room, priority, formats, and a token for the unit's
JPlaying Now settings.

**Corrections** on the Spins page (owner only): **Which record?** / **It was my record…** opens a picker with
suggestions and a search of your collection. From there you can pick the copy, mark it **Not one of my records**,
or press **Match automatically** to undo a correction. After every Discogs sync, and on start, plays that weren't
matched or weren't certain are matched again. **Match again** does the same on demand.

## Lyrics for the JPlaying Now units

The units show lyrics under the song. They ask here first (`GET /api/lyrics?artist=&title=&album=&duration=`, with
their listener token): a song nobody asked for before is looked up on LRCLIB (lrclib.net) and kept in the `lyrics`
table, found or not (misses are looked up again after 3 days). So each song is fetched once for the whole house,
and both units get the same answer. Each song has an `offset` (seconds) for its timing, which the units apply; a
screen to correct timing, pick another version or paste lyrics comes later. Settings → Listeners shows how many
songs are stored. When this server can't be reached, the units use their own copy or ask LRCLIB directly.

## Deals: LPs for sale that fit the collection

**records.jplay.cloud/deals** (owner only, not on the kiosk) lists records for sale (LPs by default) in your region (the EU by default) that fit
the collection, with a price verdict. Everything goes through the official Discogs API; nothing scrapes Discogs pages.

**Where listings come from**

1. **Sellers you name** (Deals → Settings → Sellers). Each run reads their newest listings with
   `GET /users/{seller}/inventory`, newest first, and after the first run only what's new. Every listing says where it
   ships from, so only your region is kept.
2. **The browser helper**, a userscript for Tampermonkey/Violentmonkey (Deals → Settings → Browser helper). On Discogs
   marketplace pages you open yourself, such as *Shop my wants*, it sends the listing numbers it sees to
   `POST /api/deals/ingest` (with its own token). The server reads each one through `GET /marketplace/listings/{id}`.
   Good sellers in your region that it sees are added to the seller list (can be turned off).

**What fits**: on your wantlist (100), an album by an artist you collect that you don't own on vinyl (55 + 5 per record
you own by them), or labels and styles you have a lot of (lower; only well-known records, to keep the request count
down). A record you already own on vinyl is never shown.

**Price verdict**: compared with Discogs' price suggestion for the listing's media condition (Discogs only gives these
when your seller settings are filled in), else the median of what the finder has seen for that release in that
condition, plus the lowest price on Discogs. *Great deal* and *Good price* are % below typical (30 % / 15 % by default).

**Filters** (on the page and in settings): skip compilations (format plus title words such as "Greatest Hits"), live
albums (title, or release notes saying "recorded live"), box sets, unofficial releases, reissues, picture discs,
promos/test pressings, and albums you own on CD. **Media and sleeve are each "X or better"** (e.g. VG+ or better / VG or
better), with optional Generic / Not Graded / No Cover sleeves. **Formats** are a checklist, any combination of LP, EP,
Single, 12", 10", 7", CD and Cassette (LP only by default). "Already owned" means the album on the same media (vinyl, CD
or cassette); owning it on another one is shown, or skipped if you like. Also: max price, seller rating and number of
ratings. "Not interested" hides an album, an artist or a seller.

**Runs** every 6 hours (and after each collection sync), within a request budget (1,500 per run by default, about 28
minutes). It shares Discogs' 60-per-minute limit with the collection sync, which goes first.

**Optional, off by default** (Deals → Settings):

- **Digest** daily or weekly with new deals (each sent once): by email (needs `SMTP_URL`) and/or push to an
  [ntfy](https://ntfy.sh) topic or any webhook (e.g. Home Assistant), which gets JSON.
- **Auto-wantlist**: puts missing albums by artists you collect on your Discogs wantlist (a few per run, the most
  collected or the original vinyl LP version), so Discogs and the helper watch for them. They get the note "Added by the
  JPlay Records deal finder"; one button removes them all again.

| Variable | Default | What it does |
| --- | --- | --- |
| `SMTP_URL` | none | For the email digest, e.g. `smtps://user:password@smtp.example.com:465` (Kubernetes secret). |
| `DEALS_MAIL_TO` | `ADMIN_EMAIL` | Who gets the digest. |
| `DEALS_MAIL_FROM` | `JPlay Records <records@jplay.cloud>` | Sender of the digest. |

Exchange rates come from the ECB's daily reference rates (www.ecb.europa.eu), so the pod needs outbound access there.
The first collection sync after updating stores Discogs artist and label ids, which the finder needs; until then only
wantlist matches work.

## Run it locally

```sh
npm install
npm run demo-data    # optional: a fake collection with generated covers in ./data
npm run dev:server   # API on :8788, DEV_ADMIN=1 (you are the admin)
npm run dev          # web app on http://127.0.0.1:5174  (add ?kiosk=1 for the kiosk keyboard)
```

To sync your real collection locally, run `DISCOGS_TOKEN=… npm run dev:server`.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `DISCOGS_TOKEN` | none | Personal access token from https://www.discogs.com/settings/developers (Kubernetes secret). |
| `DISCOGS_USER` | owner of the token | Whose collection to sync. |
| `SYNC_TIME` | `03:30` | Nightly sync, local time in `TZ`. Empty turns the nightly sync off. |
| `TZ` | `Europe/Stockholm` | Time zone for `SYNC_TIME`. |
| `PUBLIC_URL` | `http://127.0.0.1:5174` | The address people use (device links, secure cookies). |
| `ADMIN_EMAIL` | none | The JPlay account that may open Settings. |
| `JPLAY_API` | none | JPlay's address for checking the login, e.g. `http://jplay.jplay.svc.cluster.local`. |
| `JPLAY_LOGIN_URL` | `https://jplay.cloud/login` | Where "Sign in with JPlay" goes. |
| `READ_USERS` | `none` | Other JPlay accounts that may browse: `none`, `all`, or a comma-separated list of emails. |
| `DATA_DIR` | `./data` | Where `records.db` and `covers/` are kept. |
| `DEV_ADMIN` | off | `1` makes everyone admin. Local development only, and ignored on https. |

## The kiosk

See [kiosk/README.md](kiosk/README.md): Raspberry Pi OS Lite, cage and Chromium, set up with one script.

## Later

- **Spins, next steps:** your own cover on the JPlaying Now screen; vinyl vs CD in the lounge from power-metering
  plugs on the turntable and CD player (via Home Assistant); "Playing now" on the kiosk; stylus hours.
- **"Do I own this?" on the phone.** The site already works on a phone (sign in on jplay.cloud). Next: a
  barcode scanner page that looks up the barcodes stored with each release.
- **LED strip (WLED / ESP32) that lights the shelf.** The position API already gives the compartment and
  where the record stands across it (`position.at`, 0 = left edge, 1 = right edge). That is enough to light the
  right LEDs through WLED's JSON API.
