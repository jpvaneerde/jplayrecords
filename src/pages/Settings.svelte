<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type AdminState, type Device, type Display, type Grid, type ListenerView, type Run, type ShelfConfig } from '../lib/api';
  import { browse } from '../lib/browse.svelte';
  import { router } from '../lib/router.svelte';
  import { applyTheme, session } from '../lib/session.svelte';
  import Logo from '../lib/ui/Logo.svelte';
  import ShelfMap from '../lib/ui/ShelfMap.svelte';

  let st = $state<AdminState | null>(null);
  let error = $state('');
  let shelves = $state<ShelfConfig | null>(null);
  let grids = $state<Grid[]>([]);
  let shelfMsg = $state('');
  let shelfDirty = $state(false);
  let display = $state<Display | null>(null);
  let displayMsg = $state('');
  let newDevice = $state('Record room');
  let newLink = $state('');
  let anchors = $state<{ id: number; artist: string; title: string; label: string }[]>([]);
  let poll: ReturnType<typeof setInterval> | undefined;
  let listenerList = $state<ListenerView[]>([]);
  let newListener = $state({ name: '', room: '', priority: 1, vinyl: false, cd: true });
  let listenerToken = $state('');
  let listenerMsg = $state('');

  async function load() {
    try {
      st = await api.get<AdminState>('/admin');
      shelves = structuredClone($state.snapshot(st.shelves));
      grids = st.grids;
      display = { ...st.display };
      shelfDirty = false;
      anchors = (await api.get<{ anchors: typeof anchors }>('/admin/anchors')).anchors;
      listenerList = (await api.get<{ listeners: ListenerView[] }>('/admin/spins/listeners')).listeners;
      if (st.sync.running) startPolling();
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => {
    load();
    return () => clearInterval(poll);
  });

  function startPolling() {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!st) return;
      st.sync = await api.get('/admin/sync');
      if (!st.sync.running) {
        clearInterval(poll);
        await load();
        browse.reload();
        browse.loadFacets();
      }
    }, 1500);
  }

  async function syncNow() {
    try {
      const r = await api.post<{ sync: AdminState['sync'] }>('/admin/sync');
      if (st) st.sync = r.sync;
      startPolling();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function saveShelves() {
    if (!shelves) return;
    shelfMsg = '';
    try {
      const r = await api.put<{ shelves: ShelfConfig; grids: Grid[] }>('/admin/shelves', shelves);
      shelves = r.shelves;
      grids = r.grids;
      shelfDirty = false;
      shelfMsg = 'Saved.';
    } catch (e) {
      shelfMsg = (e as Error).message;
    }
  }

  function addRun() {
    shelves?.runs.push({
      id: `shelf${(shelves?.runs.length ?? 0) + 1}`,
      name: 'New shelf',
      formats: [],
      sizes: [],
      rows: 1,
      cols: 1,
      compartmentMm: 2000,
      order: 'rows',
      start: 'top',
      itemMm: 4,
      extraDiscMm: 3,
      spreadOver: null,
    });
    shelfDirty = true;
  }
  function removeRun(i: number) {
    shelves?.runs.splice(i, 1);
    shelfDirty = true;
  }
  const csv = (a: string[]) => a.join(', ');
  const fromCsv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  async function addDevice() {
    const r = await api.post<{ link: string; devices: Device[] }>('/admin/devices', { name: newDevice });
    newLink = r.link;
    if (st) st.devices = r.devices;
  }
  async function removeDevice(d: Device) {
    const r = await api.del<{ devices: Device[] }>(`/admin/devices/${d.id}`);
    if (st) st.devices = r.devices;
  }

  async function saveDisplay() {
    if (!display) return;
    const r = await api.put<{ display: Display }>('/admin/display', display);
    session.display = r.display;
    applyTheme(r.display.theme);
    displayMsg = 'Saved. Kiosk screens pick it up when they next reload (or after idle).';
  }

  const fmts = (v: { vinyl: boolean; cd: boolean }) => [...(v.vinyl ? ['vinyl'] : []), ...(v.cd ? ['cd'] : [])];
  async function addListener() {
    listenerMsg = '';
    try {
      const r = await api.post<{ token: string; listeners: ListenerView[] }>('/admin/spins/listeners', {
        name: newListener.name,
        room: newListener.room,
        priority: newListener.priority,
        formats: fmts(newListener),
      });
      listenerToken = r.token;
      listenerList = r.listeners;
    } catch (e) {
      listenerMsg = (e as Error).message;
    }
  }
  async function saveListener(l: ListenerView) {
    const r = await api.put<{ listeners: ListenerView[] }>(`/admin/spins/listeners/${l.id}`, l);
    listenerList = r.listeners;
    listenerMsg = 'Saved.';
  }
  async function removeListener(l: ListenerView) {
    const r = await api.del<{ listeners: ListenerView[] }>(`/admin/spins/listeners/${l.id}`);
    listenerList = r.listeners;
  }
  function toggleFormat(l: ListenerView, f: string) {
    l.formats = l.formats.includes(f) ? l.formats.filter((x) => x !== f) : [...l.formats, f];
  }

  async function unpin(id: number) {
    await api.del(`/admin/anchors/${id}`);
    await load();
  }

  const when = (t: number | null) => (t ? new Date(t).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
  const pct = $derived(st?.sync.total ? Math.round((st.sync.done / st.sync.total) * 100) : 0);
  const gridFor = (r: Run) => grids.find((g) => g.id === r.id);
</script>

<div class="wrap">
  <header>
    <a href="/" onclick={router.link} class="logo"><Logo height="1.9rem" /></a>
    <h1>Settings</h1>
    <a href="/" class="btn" onclick={router.link}>Back to the records</a>
  </header>

  {#if error}<p class="notice error">{error}</p>{/if}

  {#if st && shelves && display}
    <!-- Discogs -->
    <section class="card">
      <h2>Discogs</h2>
      {#if !st.tokenSet}
        <p class="notice error">No Discogs token on the server. Put your personal access token in the Kubernetes secret (see the README).</p>
      {/if}
      <p>
        {st.sync.count.toLocaleString('sv-SE')} records{st.sync.username ? ` from ${st.sync.username}` : ''}. Last sync: <b>{when(st.sync.lastSyncAt)}</b>.
        {#if st.syncTime}Nightly at {st.syncTime} ({st.timeZone}).{/if}
      </p>
      {#if st.sync.lastError && !st.sync.running}<p class="notice error">Last sync failed: {st.sync.lastError}</p>{/if}
      {#if st.sync.running}
        <div class="progress">
          <div class="bar" style:width="{pct}%"></div>
        </div>
        <p class="muted">{st.sync.phase}… {st.sync.done} / {st.sync.total || '?'}</p>
      {:else}
        <button class="btn primary" onclick={syncNow} disabled={!st.tokenSet}>Sync now</button>
      {/if}
    </section>

    <!-- Shelves -->
    <section class="card">
      <h2>Shelves</h2>
      <p class="muted">
        Records stand in Discogs' "sort by artist" order. Each shelf below takes the formats it lists and fills its compartments
        in that order; a record goes to the compartment where its middle falls. Use <b>Spread over</b> to say how many compartments
        the shelf fills today, so thicknesses are calibrated for you. If a record is in the wrong place, open it and tap “Wrong place?”.
      </p>

      <div class="grid2">
        <label class="field">
          <span>Where the location comes from</span>
          <select bind:value={shelves.source} onchange={() => (shelfDirty = true)}>
            <option value="auto">Discogs field when filled in, otherwise computed</option>
            <option value="computed">Always computed</option>
            <option value="field">Only the Discogs field</option>
          </select>
        </label>
        <label class="field">
          <span>Discogs custom field with the location</span>
          <select bind:value={shelves.fieldName} onchange={() => (shelfDirty = true)}>
            <option value="Location">Location</option>
            {#each st.fields.filter((f) => f.name !== 'Location') as f (f.id)}
              <option value={f.name}>{f.name}</option>
            {/each}
          </select>
        </label>
      </div>

      {#each shelves.runs as r, i (i)}
        {@const g = gridFor(r)}
        <div class="run">
          <div class="run-form">
            <div class="grid3">
              <label class="field"><span>Name</span><input bind:value={r.name} oninput={() => (shelfDirty = true)} /></label>
              <label class="field"><span>Formats (empty = everything else)</span>
                <input value={csv(r.formats)} oninput={(e) => { r.formats = fromCsv(e.currentTarget.value); shelfDirty = true; }} placeholder="Vinyl, CD, Cassette, Box Set" /></label>
              <label class="field"><span>Vinyl sizes (empty = any)</span>
                <input value={csv(r.sizes)} oninput={(e) => { r.sizes = fromCsv(e.currentTarget.value); shelfDirty = true; }} placeholder={'12", 10", 7"'} /></label>
            </div>
            <div class="grid4">
              <label class="field"><span>Rows</span><input type="number" min="1" bind:value={r.rows} oninput={() => (shelfDirty = true)} /></label>
              <label class="field"><span>Compartments per row</span><input type="number" min="1" bind:value={r.cols} oninput={() => (shelfDirty = true)} /></label>
              <label class="field"><span>Compartment width (mm)</span><input type="number" min="50" bind:value={r.compartmentMm} oninput={() => (shelfDirty = true)} /></label>
              <label class="field"><span>Spread over (compartments)</span>
                <input type="number" min="1" value={r.spreadOver ?? ''} placeholder="off" oninput={(e) => { const v = e.currentTarget.value; r.spreadOver = v ? Number(v) : null; shelfDirty = true; }} /></label>
              <label class="field"><span>Fill</span>
                <select bind:value={r.order} onchange={() => (shelfDirty = true)}><option value="rows">Row by row (left → right)</option><option value="columns">Column by column</option></select></label>
              <label class="field"><span>Start at</span>
                <select bind:value={r.start} onchange={() => (shelfDirty = true)}><option value="top">Top row</option><option value="bottom">Bottom row</option></select></label>
              <label class="field"><span>Record thickness (mm)</span><input type="number" step="0.1" bind:value={r.itemMm} oninput={() => (shelfDirty = true)} /></label>
              <label class="field"><span>Each extra disc (mm)</span><input type="number" step="0.1" bind:value={r.extraDiscMm} oninput={() => (shelfDirty = true)} /></label>
            </div>
            <button class="btn small danger" onclick={() => removeRun(i)}>Remove this shelf</button>
          </div>
          {#if g}
            <div class="run-map">
              {#if g.rows > 1 || g.cols > 1}<ShelfMap grid={g} compact />{/if}
              <ul class="comp-list">
                {#each g.compartments.filter((c) => c.count) as c (c.index)}
                  <li><b>{c.label || g.name}</b> <span class="muted">{c.count} ·</span> {c.first} → {c.last}</li>
                {/each}
                {#if g.overflow}<li class="err">{g.overflow} records don't fit: add compartments or raise “Spread over”.</li>{/if}
              </ul>
            </div>
          {/if}
        </div>
      {/each}
      <div class="row">
        <button class="btn" onclick={addRun}>Add a shelf</button>
        <button class="btn primary" onclick={saveShelves} disabled={!shelfDirty}>Save shelves</button>
        {#if shelfMsg}<span class="muted">{shelfMsg}</span>{/if}
      </div>

      {#if anchors.length}
        <h3>Fixed positions</h3>
        <ul class="anchors">
          {#each anchors as a (a.id)}
            <li><b>{a.label}</b> starts with {a.artist} – {a.title} <button class="btn small ghost" onclick={() => unpin(a.id)}>Remove</button></li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Devices -->
    <section class="card">
      <h2>Kiosk screens</h2>
      <p class="muted">A device link signs a screen in read-only, without a password. Open it once on the Raspberry Pi (or use it as the kiosk start page). Anyone with the link can browse, so keep it to yourself.</p>
      {#if st.devices.length}
        <ul class="devices">
          {#each st.devices as d (d.id)}
            <li><b>{d.name}</b> <span class="muted">added {when(d.createdAt)} · last seen {when(d.lastSeenAt)}</span>
              <button class="btn small danger" onclick={() => removeDevice(d)}>Unlink</button></li>
          {/each}
        </ul>
      {/if}
      <div class="row">
        <input class="short" bind:value={newDevice} aria-label="Screen name" />
        <button class="btn primary" onclick={addDevice}>Create device link</button>
      </div>
      {#if newLink}
        <p class="notice ok">Shown only once. Kiosk start page:<br /><code class="link">{newLink}</code></p>
      {/if}
    </section>

    <!-- Listeners (JPlay Spins) -->
    <section class="card">
      <h2>Listeners (Spins)</h2>
      <p class="muted">
        Each JPlaying Now unit reports what its microphone hears and what its room's JPlay player plays. When two rooms hear the same
        song, it counts once, in the room with the <b>highest priority</b>. <b>Formats</b> are what can be played physically in that
        room (the study has a CD player; the lounge vinyl and CD).
      </p>
      {#if listenerList.length}
        <div class="listeners">
          {#each listenerList as l (l.id)}
            <div class="listener">
              <input bind:value={l.name} aria-label="Name" />
              <input bind:value={l.room} aria-label="Room" />
              <input type="number" min="0" max="100" bind:value={l.priority} aria-label="Priority" title="Priority (higher wins)" />
              <label class="check"><input type="checkbox" checked={l.formats.includes('vinyl')} onchange={() => toggleFormat(l, 'vinyl')} /> Vinyl</label>
              <label class="check"><input type="checkbox" checked={l.formats.includes('cd')} onchange={() => toggleFormat(l, 'cd')} /> CD</label>
              <span class="muted small">{l.lastSeenAt ? `seen ${when(l.lastSeenAt)}` : 'not connected yet'}</span>
              <button class="btn small" onclick={() => saveListener(l)}>Save</button>
              <button class="btn small danger" onclick={() => removeListener(l)}>Remove</button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="listener new">
        <input bind:value={newListener.name} placeholder="Unit name, e.g. Lounge JPlaying Now" aria-label="New listener name" />
        <input bind:value={newListener.room} placeholder="Room, e.g. Lounge" aria-label="New listener room" />
        <input type="number" min="0" max="100" bind:value={newListener.priority} aria-label="Priority" title="Priority (higher wins)" />
        <label class="check"><input type="checkbox" bind:checked={newListener.vinyl} /> Vinyl</label>
        <label class="check"><input type="checkbox" bind:checked={newListener.cd} /> CD</label>
        <button class="btn primary" onclick={addListener}>Add listener</button>
      </div>
      {#if listenerMsg}<p class="muted">{listenerMsg}</p>{/if}
      {#if st.lyrics?.songs}
        <p class="muted small">
          Lyrics: {st.lyrics.songs} songs looked up for the units, {st.lyrics.found} with lyrics ({st.lyrics.synced} timed).
          Kept here so each song is looked up once for the whole house.
        </p>
      {/if}
      {#if listenerToken}
        <p class="notice ok">
          Token for this unit (shown only once). Paste it in the unit's JPlaying Now settings under <b>Spins</b>, with the address
          <code>{location.origin}</code>:<br /><code class="link">{listenerToken}</code>
        </p>
      {/if}
    </section>

    <!-- Display -->
    <section class="card">
      <h2>Kiosk display</h2>
      <div class="grid4">
        <label class="field"><span>Back to start after (seconds idle, 0 = never)</span><input type="number" min="0" bind:value={display.idleSeconds} /></label>
        <label class="field"><span>On-screen keyboard</span>
          <select bind:value={display.keyboard}><option value="auto">On kiosk screens</option><option value="always">Always</option><option value="never">Never</option></select></label>
        <label class="field"><span>Cover size</span>
          <select bind:value={display.tile}><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>
        <label class="field"><span>Theme</span>
          <select bind:value={display.theme}><option value="dark">Dark</option><option value="light">Light</option><option value="retro">Retro</option></select></label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={display.screensaver} /> Show the cover wall when idle</label>
      <div class="row">
        <button class="btn primary" onclick={saveDisplay}>Save display</button>
        {#if displayMsg}<span class="muted">{displayMsg}</span>{/if}
      </div>
    </section>
  {:else if !error}
    <p class="muted">Loading…</p>
  {/if}
</div>

<style>
  .wrap {
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 20px 60px;
    height: 100dvh;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 16px 0;
  }
  header h1 {
    flex: 1;
    font-size: 1.5rem;
    color: var(--muted);
  }
  .logo {
    color: inherit;
  }
  section {
    padding: 20px 22px;
    margin-bottom: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    font-size: 1.35rem;
  }
  section > .btn {
    align-self: flex-start;
  }
  h3 {
    font-size: 1.05rem;
    margin-top: 8px;
  }
  p {
    margin: 0;
  }
  .grid2,
  .grid3,
  .grid4 {
    display: grid;
    gap: 12px;
  }
  .grid2 {
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }
  .grid3 {
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  }
  .grid4 {
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  }
  .run {
    display: grid;
    grid-template-columns: 1.6fr 1fr;
    gap: 18px;
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-2) 60%, transparent);
  }
  .run-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .run-form > div {
    width: 100%;
  }
  .comp-list {
    list-style: none;
    padding: 0;
    margin: 10px 0 0;
    font-size: 0.85rem;
    display: grid;
    gap: 2px;
  }
  .err {
    color: var(--danger);
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .short {
    max-width: 260px;
  }
  .devices,
  .anchors {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 6px;
  }
  .devices li,
  .anchors li {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .listeners {
    display: grid;
    gap: 8px;
  }
  .listener {
    display: grid;
    grid-template-columns: 1.4fr 1fr 70px auto auto 1fr auto auto;
    gap: 8px;
    align-items: center;
  }
  .listener.new {
    grid-template-columns: 1.4fr 1fr 70px auto auto auto;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .small {
    font-size: 0.8rem;
  }
  .link {
    word-break: break-all;
    user-select: all;
  }
  .progress {
    height: 10px;
    border-radius: 99px;
    background: var(--line);
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s;
  }
  @media (max-width: 860px) {
    .run {
      grid-template-columns: 1fr;
    }
    .listener,
    .listener.new {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
