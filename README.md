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

- **"Do I own this?" on the phone.** The site already works on a phone (sign in on jplay.cloud). Next: a
  barcode scanner page that looks up the barcodes stored with each release.
- **LED strip (WLED / ESP32) that lights the shelf.** The position API already gives the compartment and
  where the record stands across it (`position.at`, 0 = left edge, 1 = right edge). That is enough to light the
  right LEDs through WLED's JSON API.
