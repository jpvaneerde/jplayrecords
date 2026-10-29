<script lang="ts">
  // Deals: LPs for sale in your region that fit your collection (owner only).
  import { onMount } from 'svelte';
  import { api, type Deal, type DealSeller, type DealSettings, type DealsOverview, type DealsStatus, type HiddenThing, type MissingAlbum } from '../lib/api';
  import { router } from '../lib/router.svelte';
  import Logo from '../lib/ui/Logo.svelte';

  type Tab = 'deals' | 'missing' | 'settings';
  let tab = $state<Tab>((router.query.get('tab') as Tab) || 'deals');
  let ov = $state<DealsOverview | null>(null);
  let s = $state<DealSettings | null>(null); // settings being edited
  let error = $state('');
  let msg = $state('');
  let showSkipped = $state(false);
  let level = $state<'all' | 'good' | 'great'>('all');
  let why = $state<'all' | 'want' | 'artist' | 'labelstyle'>('all');
  let country = $state('');
  let sort = $state<'score' | 'discount' | 'price' | 'new'>('score');
  let missing = $state<MissingAlbum[]>([]);
  let missingSkipped = $state(false);
  let sellers = $state<DealSeller[]>([]);
  let hidden = $state<HiddenThing[]>([]);
  let newSeller = $state('');
  let dirty = $state(false);
  let poll: ReturnType<typeof setInterval> | undefined;
  let busy = $state<Record<string, boolean>>({});

  async function load() {
    error = '';
    try {
      ov = await api.get<DealsOverview>(`/admin/deals${showSkipped ? '?skipped=1' : ''}`);
      if (!dirty) s = structuredClone($state.snapshot(ov.settings));
      if (ov.status.running) startPolling();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function loadMissing() {
    try {
      missing = (await api.get<{ albums: MissingAlbum[] }>(`/admin/deals/missing${missingSkipped ? '?skipped=1' : ''}`)).albums;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function loadSettingsExtras() {
    try {
      sellers = (await api.get<{ sellers: DealSeller[] }>('/admin/deals/sellers')).sellers;
      hidden = (await api.get<{ hidden: HiddenThing[] }>('/admin/deals/hidden')).hidden;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(() => {
    load();
    loadSettingsExtras();
    return () => clearInterval(poll);
  });
  $effect(() => {
    if (tab === 'missing') loadMissing();
  });

  function setTab(t: Tab) {
    tab = t;
    router.go(t === 'deals' ? '/deals' : `/deals?tab=${t}`, true);
  }

  function startPolling() {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!ov) return;
      ov.status = await api.get<DealsStatus>('/admin/deals/status');
      if (!ov.status.running) {
        clearInterval(poll);
        await load();
        if (tab === 'missing') loadMissing();
        loadSettingsExtras();
      }
    }, 2000);
  }

  async function runNow() {
    msg = '';
    try {
      const r = await api.post<{ started: boolean; status: DealsStatus }>('/admin/deals/run');
      if (ov) ov.status = r.status;
      startPolling();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  /** Quick filters on the deals tab save straight away. */
  async function saveNow(patch: Partial<DealSettings>) {
    try {
      const r = await api.put<{ settings: DealSettings }>('/admin/deals/settings', patch);
      s = r.settings;
      dirty = false;
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function saveAll() {
    if (!s) return;
    msg = '';
    try {
      const r = await api.put<{ settings: DealSettings }>('/admin/deals/settings', $state.snapshot(s));
      s = r.settings;
      dirty = false;
      msg = 'Saved.';
      await load();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function hideThing(kind: HiddenThing['kind'], key: string | number, label: string) {
    await api.post('/admin/deals/hide', { kind, key: String(key), label });
    await load();
    if (tab === 'missing') loadMissing();
    loadSettingsExtras();
  }
  async function unhideThing(h: HiddenThing) {
    hidden = (await api.del<{ hidden: HiddenThing[] }>(`/admin/deals/hidden/${h.kind}/${encodeURIComponent(h.key)}`)).hidden;
    load();
  }

  async function want(opts: { releaseId?: number; masterId?: number; artist: string; title: string }, key: string) {
    busy[key] = true;
    try {
      await api.post('/admin/deals/want', opts);
      msg = `${opts.artist} – ${opts.title} is on your Discogs wantlist.`;
      if (tab === 'missing') await loadMissing();
      else await load();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy[key] = false;
    }
  }

  async function addSellers() {
    try {
      sellers = (await api.post<{ sellers: DealSeller[] }>('/admin/deals/sellers', { username: newSeller })).sellers;
      newSeller = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function toggleSeller(x: DealSeller) {
    sellers = (await api.put<{ sellers: DealSeller[] }>(`/admin/deals/sellers/${encodeURIComponent(x.username)}`, { enabled: !x.enabled })).sellers;
  }
  async function removeSellerRow(x: DealSeller) {
    sellers = (await api.del<{ sellers: DealSeller[] }>(`/admin/deals/sellers/${encodeURIComponent(x.username)}`)).sellers;
  }

  async function downloadHelper() {
    if (!confirm('This makes a new helper script. A helper you installed before stops working. Continue?')) return;
    const r = await api.post<{ script: string; filename: string }>('/admin/deals/helper');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.script], { type: 'text/javascript' }));
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function testDigest() {
    msg = '';
    try {
      const r = await api.post<{ sent: number; channels: string[]; errors: string[]; message?: string }>('/admin/deals/digest/test');
      msg = r.message ?? (r.sent ? `Sent ${r.sent} deals by ${r.channels.join(' and ')}.` : '');
      if (r.errors.length) error = r.errors.join(' ');
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function unwantAuto() {
    if (!confirm('Remove every record the deal finder put on your Discogs wantlist?')) return;
    const r = await api.post<{ removed: number }>('/admin/deals/unwant-auto');
    msg = `Removed ${r.removed} records from your wantlist.`;
    load();
  }

  /* ---------- helpers ---------- */

  const short = (c: string) => /\(([^)]+)\)$/.exec(c)?.[1] ?? c;
  const money = (v: number | null, cur = s?.currency ?? 'EUR') =>
    v == null ? '–' : new Intl.NumberFormat('sv-SE', { style: 'currency', currency: cur, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
  const when = (t: number | null) => (t ? new Date(t).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const ago = (t: number) => {
    const h = (Date.now() - t) / 3600_000;
    if (h < 1) return 'just now';
    if (h < 24) return `${Math.round(h)} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };
  const flag = (country: string) => {
    const iso: Record<string, string> = {
      Austria: 'AT', Belgium: 'BE', Bulgaria: 'BG', Croatia: 'HR', Cyprus: 'CY', 'Czech Republic': 'CZ', Czechia: 'CZ', Denmark: 'DK', Estonia: 'EE',
      Finland: 'FI', France: 'FR', Germany: 'DE', Greece: 'GR', Hungary: 'HU', Ireland: 'IE', Italy: 'IT', Latvia: 'LV', Lithuania: 'LT',
      Luxembourg: 'LU', Malta: 'MT', Netherlands: 'NL', Poland: 'PL', Portugal: 'PT', Romania: 'RO', Slovakia: 'SK', Slovenia: 'SI',
      Spain: 'ES', Sweden: 'SE', 'United Kingdom': 'GB', Norway: 'NO', Switzerland: 'CH', Iceland: 'IS',
    };
    const c = iso[country];
    return c ? String.fromCodePoint(...[...c].map((ch) => 0x1f1a5 + ch.charCodeAt(0))) : '🌍';
  };
  const levelLabel = { great: 'Great deal', good: 'Good price', fair: 'Fair price', unknown: 'No price reference yet' };
  const whyLabel = { want: 'Wantlist', artist: 'Artist you collect', label: 'Label you collect', style: 'Your styles', none: '' };

  const deals = $derived.by(() => {
    if (!ov) return [] as Deal[];
    let d = ov.deals;
    if (level === 'good') d = d.filter((x) => x.priceView.level === 'good' || x.priceView.level === 'great');
    if (level === 'great') d = d.filter((x) => x.priceView.level === 'great');
    if (why === 'want') d = d.filter((x) => x.fit.kind === 'want');
    if (why === 'artist') d = d.filter((x) => x.fit.kind === 'artist');
    if (why === 'labelstyle') d = d.filter((x) => x.fit.kind === 'label' || x.fit.kind === 'style');
    if (country) d = d.filter((x) => x.shipsFrom === country);
    const by = {
      score: (a: Deal, b: Deal) => b.score - a.score,
      discount: (a: Deal, b: Deal) => (b.priceView.discount ?? -9) - (a.priceView.discount ?? -9),
      price: (a: Deal, b: Deal) => (a.price.display ?? 1e9) - (b.price.display ?? 1e9),
      new: (a: Deal, b: Deal) => b.firstSeen - a.firstSeen,
    }[sort];
    return [...d].sort((a, b) => Number(!!a.skipped) - Number(!!b.skipped) || by(a, b));
  });
  const countries = $derived([...new Set((ov?.deals ?? []).map((d) => d.shipsFrom))].sort());
  const skippedTotal = $derived(ov ? ov.counts.all - ov.counts.shown : 0);
  const pct = $derived(ov?.status.total ? Math.round((ov.status.done / ov.status.total) * 100) : 0);
  const gettingStarted = $derived(!!ov && ov.status.sellers === 0 && !ov.helperSeenAt);

  const skipChips: { key: keyof DealSettings['skip']; label: string }[] = [
    { key: 'compilations', label: 'Compilations' },
    { key: 'live', label: 'Live albums' },
    { key: 'boxSets', label: 'Box sets' },
    { key: 'unofficial', label: 'Unofficial' },
    { key: 'reissues', label: 'Reissues' },
    { key: 'pictureDiscs', label: 'Picture discs' },
    { key: 'promos', label: 'Promos / tests' },
    { key: 'ownedOnCd', label: 'Owned in another format' },
  ];
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** Adds or removes a format; at least one stays selected. */
  function toggled(list: string[], f: string) {
    const next = list.includes(f) ? list.filter((x) => x !== f) : [...list, f];
    return next.length ? next : list;
  }
  const formatHelp: Record<string, string> = {
    LP: 'LP (albums on vinyl)',
    EP: 'EP',
    Single: 'Single (any size)',
    '12"': '12" (singles, maxis)',
    '10"': '10"',
    '7"': '7"',
    CD: 'CD',
    Cassette: 'Cassette',
  };

  function setRegion(preset: 'eu' | 'eu-uk' | 'nordic') {
    if (!s || !ov) return;
    const eu = ov.options.eu;
    s.countries = preset === 'eu' ? [...eu] : preset === 'eu-uk' ? [...eu, 'United Kingdom'] : ['Sweden', 'Denmark', 'Finland', 'Norway'];
    dirty = true;
  }
  function toggleCountry(c: string) {
    if (!s) return;
    s.countries = s.countries.includes(c) ? s.countries.filter((x) => x !== c) : [...s.countries, c];
    dirty = true;
  }
</script>

<div class="page">
  <header>
    <a href="/" class="logo" onclick={router.link} aria-label="Back to the records"><Logo height="1.9rem" /></a>
    <h1>Deals</h1>
    {#if ov?.status.running}
      <span class="running muted">{ov.status.phase}… {ov.status.total ? `${ov.status.done}/${ov.status.total}` : ''}</span>
    {:else}
      <button class="btn primary" onclick={runNow} disabled={!ov?.tokenSet}>Look for deals now</button>
    {/if}
    <a href="/" class="btn" onclick={router.link}>Back to the records</a>
  </header>

  {#if error}<p class="notice error">{error} <button class="btn small ghost" onclick={() => (error = '')}>✕</button></p>{/if}
  {#if msg}<p class="notice ok">{msg} <button class="btn small ghost" onclick={() => (msg = '')}>✕</button></p>{/if}

  {#if ov}
    {#if ov.status.running}
      <div class="progress"><div class="bar" style:width="{pct}%"></div></div>
    {/if}
    <p class="statusline muted">
      {ov.status.listings.toLocaleString('sv-SE')} listings watched · {ov.status.sellers} sellers · {ov.status.wants} on your wantlist ·
      last look {when(ov.status.lastRunAt)}{#if ov.status.lastCalls}{' '}({ov.status.lastCalls} Discogs requests){/if}
      {#if ov.status.nextRunAt && !ov.status.running} · next {when(ov.status.nextRunAt)}{/if}
      {#if ov.status.queue} · {ov.status.queue} from your browser waiting{/if}
    </p>
    {#if ov.status.lastError && !ov.status.running}<p class="notice error">Last run: {ov.status.lastError}</p>{/if}

    <nav class="tabs">
      <button class="chip" class:on={tab === 'deals'} onclick={() => setTab('deals')}>Deals <span class="n">{ov.counts.shown}</span></button>
      <button class="chip" class:on={tab === 'missing'} onclick={() => setTab('missing')}>Missing albums</button>
      <button class="chip" class:on={tab === 'settings'} onclick={() => setTab('settings')}>Settings{dirty ? ' •' : ''}</button>
    </nav>

    {#if gettingStarted && tab !== 'settings'}
      <section class="card start">
        <h2>Get started</h2>
        <ol>
          <li>
            <b>Add a few sellers in your region</b> whose shops you like (Settings → Sellers). Their new listings are read through the
            Discogs API every {ov.settings.everyHours} hours, and only what ships from your region and fits your collection is kept.
          </li>
          <li>
            <b>Install the browser helper</b> (Settings → Browser helper). Whenever you open a Discogs marketplace page yourself,
            such as <a href="https://www.discogs.com/sell/mywants" target="_blank" rel="noreferrer">Shop my wants</a>, it passes the
            listings to this page, and good sellers it sees are added to the list automatically.
          </li>
          <li><b>Look for deals now</b>, or wait for the next run.</li>
        </ol>
        <button class="btn primary" onclick={() => setTab('settings')}>Open settings</button>
      </section>
    {/if}

    {#if tab === 'deals' && s}
      <!-- What to skip and how good it must be: saved straight away -->
      <div class="quick card">
        <div class="row-chips">
          <span class="lbl">Skip</span>
          {#each skipChips as c (c.key)}
            <button class="chip small" class:on={s.skip[c.key]} onclick={() => saveNow({ skip: { ...s!.skip, [c.key]: !s!.skip[c.key] } })}>
              {s.skip[c.key] ? '✓ ' : ''}{c.label}
            </button>
          {/each}
        </div>
        <div class="row-chips">
          <span class="lbl">Formats</span>
          {#each ov.options.formats as f (f)}
            <button class="chip small" class:on={s.formats.includes(f)} onclick={() => saveNow({ formats: toggled(s!.formats, f) })}>
              {s.formats.includes(f) ? '✓ ' : ''}{f}
            </button>
          {/each}
        </div>
        <div class="row-fields">
          <label class="field"><span>Media</span>
            <select value={s.minMedia} onchange={(e) => saveNow({ minMedia: e.currentTarget.value })}>
              {#each ov.options.conditions as c (c)}<option value={c}>{short(c)} or better</option>{/each}
            </select>
          </label>
          <label class="field"><span>Sleeve</span>
            <select value={s.minSleeve} onchange={(e) => saveNow({ minSleeve: e.currentTarget.value })}>
              {#each ov.options.conditions as c (c)}<option value={c}>{short(c)} or better</option>{/each}
            </select>
          </label>
          <label class="field"><span>Max price ({s.currency})</span>
            <input type="number" min="1" value={s.maxPrice ?? ''} placeholder="no limit"
              onchange={(e) => saveNow({ maxPrice: e.currentTarget.value ? Number(e.currentTarget.value) : null })} />
          </label>
          <label class="field"><span>Price</span>
            <select bind:value={level}>
              <option value="all">Any price</option>
              <option value="good">Good prices and better</option>
              <option value="great">Great deals only</option>
            </select>
          </label>
          <label class="field"><span>Why</span>
            <select bind:value={why}>
              <option value="all">Everything that fits</option>
              <option value="want">On my wantlist</option>
              <option value="artist">Artists I collect</option>
              <option value="labelstyle">Labels &amp; styles I collect</option>
            </select>
          </label>
          <label class="field"><span>Ships from</span>
            <select bind:value={country}>
              <option value="">Anywhere in my region</option>
              {#each countries as c (c)}<option value={c}>{flag(c)} {c}</option>{/each}
            </select>
          </label>
          <label class="field"><span>Order</span>
            <select bind:value={sort}>
              <option value="score">Best match</option>
              <option value="discount">Biggest discount</option>
              <option value="price">Cheapest</option>
              <option value="new">Newest</option>
            </select>
          </label>
        </div>
        {#if skippedTotal}
          <p class="muted small-text">
            {skippedTotal} more listings are skipped by these filters
            ({Object.entries(ov.counts.skipped).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}: ${n}`).join(', ')}).
            <button class="link" onclick={() => { showSkipped = !showSkipped; load(); }}>{showSkipped ? 'Hide them' : 'Show them'}</button>
          </p>
        {/if}
      </div>

      {#if !deals.length}
        <div class="empty card">
          <p><b>No deals {ov.counts.all ? 'match these filters' : 'yet'}.</b></p>
          <p class="muted">
            {#if ov.status.running}Still looking…{:else if !ov.counts.all}The finder needs sellers or the browser helper to see listings, and a run to read them.{:else}Try a higher max price or a lower condition.{/if}
          </p>
        </div>
      {/if}

      <ul class="deals">
        {#each deals as d (d.listingId)}
          <li class="deal card" class:skipped={!!d.skipped} class:great={d.priceView.level === 'great'}>
            <a class="cover nocover" href={d.url} target="_blank" rel="noreferrer">
              {#if d.thumb}<img src={d.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
            </a>
            <div class="body">
              <div class="top">
                <span class="badge {d.priceView.level}">{levelLabel[d.priceView.level]}</span>
                {#if d.fit.kind !== 'none'}<span class="badge why">{whyLabel[d.fit.kind]}</span>{/if}
                {#if d.skipped}<span class="badge skip">Skipped: {d.skipped}</span>{/if}
              </div>
              <h3><a href={d.releaseUrl} target="_blank" rel="noreferrer">{d.artist} – {d.title}</a></h3>
              <p class="muted meta">{[d.year, d.country, d.format].filter(Boolean).join(' · ')}</p>
              {#if d.labels}<p class="muted meta">{d.labels}</p>{/if}

              <div class="price">
                <b class="tabular">{money(d.price.display)}</b>
                {#if d.price.shippingDisplay != null}<span class="muted">+ {money(d.price.shippingDisplay)} shipping</span>{/if}
                {#if d.price.currency !== s.currency}<span class="muted">({money(d.price.value, d.price.currency)})</span>{/if}
              </div>
              <p class="ref">
                {#if d.priceView.discount != null}
                  {#if d.priceView.discount > 0}<b class="good">{Math.round(d.priceView.discount * 100)}% below</b>{:else}{Math.round(-d.priceView.discount * 100)}% above{/if}
                  the {d.priceView.refKind === 'suggestion' ? 'Discogs suggestion' : 'usual price'} for {short(d.condition)} ({money(d.price.refDisplay)}).
                {/if}
                {#if d.priceView.cheapest}<b class="good">Cheapest copy on Discogs.</b>{:else if d.price.lowestDisplay != null}Lowest anywhere: {money(d.price.lowestDisplay)}.{/if}
              </p>

              <p class="cond">
                <span class="pill">Media {short(d.condition)}</span>
                <span class="pill">Sleeve {short(d.sleeve) || '–'}</span>
                <span class="muted">{flag(d.shipsFrom)} {d.seller}{d.sellerRating != null ? ` · ${d.sellerRating}%` : ''}{d.sellerSales != null ? ` · ${d.sellerSales.toLocaleString('sv-SE')} ratings` : ''}</span>
              </p>
              {#if d.comments}<p class="comments muted">“{d.comments}”</p>{/if}
              <ul class="reasons">
                {#each d.fit.reasons as r (r)}<li>{r}</li>{/each}
              </ul>
              <div class="actions">
                <a class="btn small primary" href={d.url} target="_blank" rel="noreferrer">Open on Discogs</a>
                {#if !d.onWantlist}
                  <button class="btn small" disabled={busy[`r${d.releaseId}`]} onclick={() => want({ releaseId: d.releaseId, artist: d.artist, title: d.title }, `r${d.releaseId}`)}>+ Wantlist</button>
                {/if}
                <button class="btn small ghost" onclick={() => (d.masterId ? hideThing('master', d.masterId, `${d.artist} – ${d.title}`) : hideThing('release', d.releaseId, `${d.artist} – ${d.title}`))}>Not interested</button>
                <button class="btn small ghost" onclick={() => hideThing('seller', d.seller, d.seller)}>Hide seller</button>
                <span class="muted seen">seen {ago(d.firstSeen)}</span>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if tab === 'missing' && s}
      <section class="card intro">
        <p class="muted">
          Albums by artists you own at least {s.fit.minOwnedForMissing} records by, that you don't have in the formats you look for ({s.formats.join(', ')}). Put one on your wantlist
          and Discogs (and the browser helper) will watch for it. The version picked is the
          {s.wantlist.version === 'popular' ? 'most collected' : 'earliest'} one in those formats (change it in Settings).
        </p>
        <label class="check"><input type="checkbox" bind:checked={missingSkipped} onchange={loadMissing} /> Also show what your skip filters hide</label>
      </section>
      {#if !missing.length}
        <div class="empty card"><p class="muted">Nothing yet. Discographies are read during each run, a few dozen artists at a time.</p></div>
      {/if}
      <ul class="missing">
        {#each missing as m (m.key)}
          <li class="row card" class:skipped={!!m.skipped}>
            <span class="thumb nocover">{#if m.thumb}<img src={m.thumb} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}</span>
            <span class="txt">
              <a href={m.url} target="_blank" rel="noreferrer"><b>{m.artist} – {m.title}</b></a>
              <span class="muted">
                {m.year ?? ''} · you own {m.owned} by this artist · {m.have.toLocaleString('sv-SE')} collectors
                {#if m.ownedOn} · <b>you have it on {m.ownedOn}</b>{/if}
                {#if m.skipped} · skipped: {m.skipped}{/if}
              </span>
            </span>
            {#if m.onWantlist}
              <span class="badge want">On wantlist</span>
            {:else}
              <button class="btn small" disabled={busy[m.key]} onclick={() => want({ masterId: m.masterId ?? undefined, releaseId: m.releaseId ?? undefined, artist: m.artist, title: m.title }, m.key)}>+ Wantlist</button>
            {/if}
            {#if m.masterId}<button class="btn small ghost" onclick={() => hideThing('master', m.masterId!, `${m.artist} – ${m.title}`)}>Hide</button>{/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if tab === 'settings' && s}
      <div class="settings">
        <section class="card">
          <h2>Region and price</h2>
          <div class="region-presets">
            <button class="btn small" onclick={() => setRegion('eu')}>European Union</button>
            <button class="btn small" onclick={() => setRegion('eu-uk')}>EU + United Kingdom</button>
            <button class="btn small" onclick={() => setRegion('nordic')}>Nordics</button>
            <span class="muted small-text">{s.countries.length} countries</span>
          </div>
          <div class="countries">
            {#each [...ov.options.eu.filter((c) => c !== 'Czechia'), ...ov.options.nearEu] as c (c)}
              <label class="check small-text"><input type="checkbox" checked={s.countries.includes(c)} onchange={() => toggleCountry(c)} /> {flag(c)} {c}</label>
            {/each}
          </div>
          <p class="muted small-text">Outside the EU (UK, Norway, Switzerland) customs and VAT are added when shipping to Sweden.</p>
          <div class="grid3">
            <label class="field"><span>Show prices in</span>
              <select bind:value={s.currency} onchange={() => (dirty = true)}>
                {#each ov.options.currencies as c (c)}<option value={c}>{c}</option>{/each}
              </select>
            </label>
            <label class="field"><span>Max price per record ({s.currency})</span>
              <input type="number" min="1" value={s.maxPrice ?? ''} placeholder="no limit"
                oninput={(e) => { s!.maxPrice = e.currentTarget.value ? Number(e.currentTarget.value) : null; dirty = true; }} /></label>
            <div class="field"><span>Formats to look for (one or more)</span>
              <div class="format-checks">
                {#each ov.options.formats as f (f)}
                  <label class="check"><input type="checkbox" checked={s.formats.includes(f)}
                    disabled={s.formats.length === 1 && s.formats.includes(f)}
                    onchange={() => { s!.formats = toggled(s!.formats, f); dirty = true; }} /> {formatHelp[f] ?? f}</label>
                {/each}
              </div>
            </div>
            <label class="field"><span>“Great deal” at least … % below typical</span>
              <input type="number" min="1" max="90" bind:value={s.levels.great} oninput={() => (dirty = true)} /></label>
            <label class="field"><span>“Good price” at least … % below typical</span>
              <input type="number" min="0" max="90" bind:value={s.levels.good} oninput={() => (dirty = true)} /></label>
          </div>
        </section>

        <section class="card">
          <h2>Condition</h2>
          <div class="grid3">
            <label class="field"><span>Media (the record)</span>
              <select bind:value={s.minMedia} onchange={() => (dirty = true)}>
                {#each ov.options.conditions as c (c)}<option value={c}>{c} or better</option>{/each}
              </select>
            </label>
            <label class="field"><span>Sleeve</span>
              <select bind:value={s.minSleeve} onchange={() => (dirty = true)}>
                {#each ov.options.conditions as c (c)}<option value={c}>{c} or better</option>{/each}
              </select>
            </label>
            <div class="field"><span>Also accept sleeves graded</span>
              {#each ov.options.sleeveExtras as x (x)}
                <label class="check"><input type="checkbox" checked={s.sleeveAlso.includes(x)}
                  onchange={() => { s!.sleeveAlso = s!.sleeveAlso.includes(x) ? s!.sleeveAlso.filter((y) => y !== x) : [...s!.sleeveAlso, x]; dirty = true; }} /> {x}</label>
              {/each}
            </div>
            <label class="field"><span>Seller rating at least (%)</span>
              <input type="number" min="0" max="100" step="0.1" bind:value={s.minSellerRating} oninput={() => (dirty = true)} /></label>
            <label class="field"><span>Seller has at least … ratings</span>
              <input type="number" min="0" bind:value={s.minSellerSales} oninput={() => (dirty = true)} /></label>
          </div>
        </section>

        <section class="card">
          <h2>Skip</h2>
          <div class="checks">
            {#each skipChips as c (c.key)}
              <label class="check"><input type="checkbox" bind:checked={s.skip[c.key]} onchange={() => (dirty = true)} /> {c.label}</label>
            {/each}
          </div>
          <label class="field"><span>With “Compilations”, also skip titles containing (comma separated)</span>
            <input value={s.skipWords.join(', ')} oninput={(e) => { s!.skipWords = e.currentTarget.value.split(',').map((x) => x.trim()).filter(Boolean); dirty = true; }} />
          </label>
          <p class="muted small-text">Live albums are recognised by their title (Live, In Concert, Unplugged…) and by release notes that say “recorded live”.</p>
        </section>

        <section class="card">
          <h2>What fits your collection</h2>
          <div class="checks">
            <label class="check"><input type="checkbox" bind:checked={s.fit.wantlist} onchange={() => (dirty = true)} /> On my Discogs wantlist</label>
            <label class="check"><input type="checkbox" bind:checked={s.fit.artists} onchange={() => (dirty = true)} /> Albums by artists I collect that I don't have</label>
            <label class="check"><input type="checkbox" bind:checked={s.fit.labelsStyles} onchange={() => (dirty = true)} /> Records on labels and in styles I collect a lot of</label>
          </div>
          <div class="grid3">
            <label class="field"><span>Minimum fit to show (0–100)</span>
              <input type="number" min="0" max="100" bind:value={s.fit.minFit} oninput={() => (dirty = true)} /></label>
            <label class="field"><span>Missing albums: artists I own at least … by</span>
              <input type="number" min="1" bind:value={s.fit.minOwnedForMissing} oninput={() => (dirty = true)} /></label>
            <label class="field"><span>Labels &amp; styles: only records at least … people own</span>
              <input type="number" min="0" bind:value={s.fit.discoveryMinHave} oninput={() => (dirty = true)} /></label>
          </div>
          <p class="muted small-text">
            Wantlist = 100. An artist you collect = 55, plus 5 for every record you own by them. A label you have 2+ records on, or styles that
            make up a good share of your collection, score lower. Records many people own get a small bonus.
          </p>
        </section>

        <section class="card">
          <h2>Sellers</h2>
          <p class="muted small-text">
            Their newest listings are read through the Discogs API ({s.pagesPerSeller * 100} per seller per run, newest first; after the first run only new
            ones). Paste usernames or shop links, several at once if you like.
          </p>
          <div class="add-row">
            <input bind:value={newSeller} placeholder="username or https://www.discogs.com/seller/…" onkeydown={(e) => e.key === 'Enter' && addSellers()} />
            <button class="btn" onclick={addSellers} disabled={!newSeller.trim()}>Add</button>
          </div>
          <label class="check"><input type="checkbox" bind:checked={s.learnSellers} onchange={() => (dirty = true)} /> Add good sellers in my region that the browser helper sees</label>
          {#if sellers.length}
            <table class="sellers">
              <thead><tr><th>Seller</th><th>From</th><th>Rating</th><th>Last read</th><th></th></tr></thead>
              <tbody>
                {#each sellers as x (x.username)}
                  <tr class:off={!x.enabled}>
                    <td><a href="https://www.discogs.com/seller/{encodeURIComponent(x.username)}/profile" target="_blank" rel="noreferrer">{x.username}</a>
                      {#if x.source === 'learned'}<span class="badge why">learned</span>{/if}
                      {#if x.last_error}<br /><span class="err small-text">{x.last_error}</span>{/if}</td>
                    <td>{x.ships_from ? `${flag(x.ships_from)} ${x.ships_from}` : '–'}</td>
                    <td class="tabular">{x.rating != null ? `${x.rating}%` : '–'}{x.sales != null ? ` · ${x.sales.toLocaleString('sv-SE')}` : ''}</td>
                    <td>{x.last_crawl_at ? ago(x.last_crawl_at) : 'not yet'}</td>
                    <td class="nowrap">
                      <button class="btn small ghost" onclick={() => toggleSeller(x)}>{x.enabled ? 'Pause' : 'Resume'}</button>
                      <button class="btn small ghost danger" onclick={() => removeSellerRow(x)}>Remove</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>

        <section class="card">
          <h2>Browser helper</h2>
          <p class="muted small-text">
            A small userscript for Tampermonkey or Violentmonkey. On Discogs marketplace pages you open yourself (Shop my wants, a release's
            “for sale” list, a seller's shop) it sends the listing numbers it sees to this server, which reads those listings through the
            Discogs API. It doesn't browse on its own. Tip: bookmark Shop my wants, sorted by “Listed newest”.
          </p>
          <p>Last heard from: <b>{when(ov.helperSeenAt)}</b></p>
          <button class="btn" onclick={downloadHelper}>Download the helper script</button>
        </section>

        <section class="card">
          <h2>Digest</h2>
          <div class="grid3">
            <label class="field"><span>Send new deals</span>
              <select bind:value={s.digest.mode} onchange={() => (dirty = true)}>
                <option value="off">Never (just this page)</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
            </label>
            {#if s.digest.mode !== 'off'}
              <label class="field"><span>At</span><input type="time" bind:value={s.digest.time} oninput={() => (dirty = true)} /></label>
              {#if s.digest.mode === 'weekly'}
                <label class="field"><span>On</span>
                  <select bind:value={s.digest.weekday} onchange={() => (dirty = true)}>
                    {#each weekdays as w, i (w)}<option value={i}>{w}</option>{/each}
                  </select>
                </label>
              {/if}
              <label class="field"><span>Which deals</span>
                <select bind:value={s.digest.minLevel} onchange={() => (dirty = true)}>
                  <option value="great">Great deals</option>
                  <option value="good">Good prices and better</option>
                  <option value="any">Everything that fits</option>
                </select>
              </label>
              <label class="field"><span>At most</span><input type="number" min="1" max="100" bind:value={s.digest.max} oninput={() => (dirty = true)} /></label>
            {/if}
          </div>
          {#if s.digest.mode !== 'off'}
            <label class="check"><input type="checkbox" bind:checked={s.digest.email} onchange={() => (dirty = true)} /> By email</label>
            {#if s.digest.email && !ov.emailReady}<p class="notice error small-text">Email needs SMTP_URL on the server (see the README).</p>{/if}
            <label class="check"><input type="checkbox" bind:checked={s.digest.push} onchange={() => (dirty = true)} /> As a push notification</label>
            {#if s.digest.push}
              <div class="grid3">
                <label class="field"><span>Kind</span>
                  <select bind:value={s.digest.pushKind} onchange={() => (dirty = true)}>
                    <option value="ntfy">ntfy topic</option>
                    <option value="webhook">Webhook (JSON), e.g. Home Assistant</option>
                  </select>
                </label>
                <label class="field wide"><span>Address</span>
                  <input bind:value={s.digest.pushUrl} placeholder={s.digest.pushKind === 'ntfy' ? 'https://ntfy.sh/your-secret-topic' : 'https://homeassistant…/api/webhook/…'} oninput={() => (dirty = true)} /></label>
              </div>
            {/if}
            <p class="muted small-text">{ov.digestPreview} deals would go out now. Each deal is sent once.</p>
            <button class="btn small" onclick={testDigest} disabled={dirty}>Send a test now</button>
          {/if}
        </section>

        <section class="card">
          <h2>Wantlist</h2>
          <label class="check"><input type="checkbox" bind:checked={s.wantlist.auto} onchange={() => (dirty = true)} /> Put missing albums on my Discogs wantlist automatically</label>
          <div class="grid3">
            <label class="field"><span>Version to add</span>
              <select bind:value={s.wantlist.version} onchange={() => (dirty = true)}>
                <option value="popular">The most collected version in my formats</option>
                <option value="original">The earliest version in my formats</option>
              </select>
            </label>
            {#if s.wantlist.auto}
              <label class="field"><span>At most per run</span><input type="number" min="1" max="50" bind:value={s.wantlist.maxPerRun} oninput={() => (dirty = true)} /></label>
              <label class="field"><span>Only for artists I own at least … by</span><input type="number" min="1" bind:value={s.wantlist.minOwned} oninput={() => (dirty = true)} /></label>
            {/if}
          </div>
          <p class="muted small-text">
            Added records get the note “Added by the JPlay Records deal finder”, and an album is never added twice. Your skip filters apply.
            Discogs wantlists hold pressings, not albums, so one version in your formats is picked.
          </p>
          {#if ov.autoWants}<button class="btn small danger" onclick={unwantAuto}>Remove the {ov.autoWants} records it added</button>{/if}
        </section>

        <section class="card">
          <h2>Schedule</h2>
          <label class="check"><input type="checkbox" bind:checked={s.enabled} onchange={() => (dirty = true)} /> Look for deals automatically</label>
          <div class="grid3">
            <label class="field"><span>Every … hours</span><input type="number" min="1" max="168" bind:value={s.everyHours} oninput={() => (dirty = true)} /></label>
            <label class="field"><span>Listing pages per seller per run</span><input type="number" min="1" max="100" bind:value={s.pagesPerSeller} oninput={() => (dirty = true)} /></label>
            <label class="field"><span>Max Discogs requests per run</span><input type="number" min="50" bind:value={s.maxCallsPerRun} oninput={() => (dirty = true)} /></label>
          </div>
          <p class="muted small-text">Discogs allows about one request a second; the collection sync gets priority. {s.maxCallsPerRun} requests take about {Math.round((s.maxCallsPerRun * 1.1) / 60)} minutes.</p>
        </section>

        {#if hidden.length}
          <section class="card">
            <h2>Hidden</h2>
            <ul class="hidden-list">
              {#each hidden as h (h.kind + h.key)}
                <li><span class="badge why">{h.kind}</span> {h.label || h.key} <button class="btn small ghost" onclick={() => unhideThing(h)}>Show again</button></li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if dirty}
        <div class="savebar">
          <button class="btn primary big" onclick={saveAll}>Save settings</button>
          <button class="btn ghost" onclick={() => { dirty = false; s = structuredClone($state.snapshot(ov!.settings)); }}>Undo changes</button>
        </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    height: 100dvh;
    overflow-y: auto;
    padding: 0 20px 60px;
    max-width: 1300px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 0;
    flex-wrap: wrap;
  }
  header h1 {
    flex: 1;
    font-size: 1.5rem;
    color: var(--muted);
  }
  .logo {
    color: inherit;
  }
  .running {
    font-weight: 600;
  }
  .progress {
    height: 6px;
    border-radius: 3px;
    background: var(--card);
    overflow: hidden;
    margin-bottom: 8px;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s;
  }
  .statusline {
    font-size: 0.9rem;
    margin: 0 0 12px;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .notice {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }
  .card {
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  .start ol {
    padding-left: 1.2em;
    display: grid;
    gap: 8px;
  }
  .quick {
    display: grid;
    gap: 12px;
  }
  .row-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .lbl {
    font-weight: 800;
    color: var(--muted);
    margin-right: 4px;
  }
  .chip.small {
    min-height: 36px;
    padding: 0.2em 0.85em;
    font-size: 0.9rem;
  }
  .row-fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
  }
  .small-text {
    font-size: 0.85rem;
  }
  .link {
    color: var(--accent-2);
    font-weight: 700;
    padding: 0;
  }
  .empty {
    text-align: center;
  }
  .deals {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 560px), 1fr));
    gap: 14px;
  }
  .deal {
    display: flex;
    gap: 16px;
    margin: 0;
  }
  .deal.great {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  }
  .deal.skipped {
    opacity: 0.55;
  }
  .cover {
    flex: none;
    width: 128px;
    height: 128px;
    border-radius: 8px;
    overflow: hidden;
    display: block;
  }
  .cover img,
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .body {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .top {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 0.75rem;
    font-weight: 800;
    padding: 0.15em 0.6em;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--bg-2);
    white-space: nowrap;
  }
  .badge.great {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: transparent;
  }
  .badge.good {
    color: var(--accent-2);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .badge.why,
  .badge.want {
    color: var(--gold);
  }
  .badge.skip {
    color: var(--danger);
  }
  h3 {
    font-size: 1.1rem;
  }
  h3 a {
    color: var(--text);
    text-decoration: none;
  }
  .meta {
    margin: 0;
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .price {
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .price b {
    font-size: 1.35rem;
  }
  .ref,
  .cond,
  .comments {
    margin: 0;
    font-size: 0.875rem;
  }
  .good {
    color: var(--accent-2);
  }
  .cond {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .pill {
    font-weight: 700;
    font-size: 0.8rem;
    padding: 0.1em 0.55em;
    border-radius: 6px;
    background: var(--bg-2);
    border: 1px solid var(--line);
  }
  .comments {
    font-style: italic;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .reasons {
    margin: 2px 0 0;
    padding-left: 1.1em;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 6px;
  }
  .seen {
    font-size: 0.8rem;
    margin-left: auto;
  }
  .missing {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 12px;
    margin: 0;
  }
  .row.skipped {
    opacity: 0.55;
  }
  .thumb {
    width: 56px;
    height: 56px;
    flex: none;
    border-radius: 6px;
    overflow: hidden;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .txt a {
    color: var(--text);
    text-decoration: none;
  }
  .txt .muted {
    font-size: 0.85rem;
  }
  .settings h2 {
    font-size: 1.15rem;
    margin-bottom: 10px;
  }
  .settings section {
    display: grid;
    gap: 10px;
  }
  .grid3 {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }
  .field.wide {
    grid-column: span 2;
  }
  .checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }
  .region-presets {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .format-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
  }
  .countries {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 4px 12px;
  }
  .add-row {
    display: flex;
    gap: 8px;
  }
  .sellers {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  .sellers th {
    text-align: left;
    color: var(--muted);
    font-weight: 700;
    padding: 6px 8px 6px 0;
  }
  .sellers td {
    padding: 6px 8px 6px 0;
    border-top: 1px solid var(--line);
    vertical-align: top;
  }
  .sellers tr.off {
    opacity: 0.5;
  }
  .nowrap {
    white-space: nowrap;
    text-align: right;
  }
  .err {
    color: var(--danger);
  }
  .hidden-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 4px;
  }
  .savebar {
    position: sticky;
    bottom: 0;
    display: flex;
    gap: 10px;
    padding: 12px 0;
    background: linear-gradient(transparent, var(--bg) 35%);
  }
  @media (max-width: 640px) {
    .page {
      padding: 0 12px 60px;
    }
    .cover {
      width: 84px;
      height: 84px;
    }
    .field.wide {
      grid-column: auto;
    }
    .seen {
      margin-left: 0;
    }
  }
</style>
