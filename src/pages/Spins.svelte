<script lang="ts">
  // JPlay Spins: what's on in each room, the records you put on, and everything that was played.
  import { onMount } from 'svelte';
  import { api, type PlayView, type RoomNow, type SpinStats, type SpinView } from '../lib/api';
  import { router } from '../lib/router.svelte';
  import { session } from '../lib/session.svelte';
  import Logo from '../lib/ui/Logo.svelte';
  import RecordPicker from '../lib/ui/RecordPicker.svelte';

  type Tab = 'records' | 'all' | 'streamed' | 'heard';
  let tab = $state<Tab>('records');
  let room = $state('');
  let days = $state(30);
  let rooms = $state<RoomNow[]>([]);
  let spins = $state<SpinView[]>([]);
  let plays = $state<PlayView[]>([]);
  let total = $state(0);
  let stats = $state<SpinStats | null>(null);
  let error = $state('');
  let picking = $state<PlayView | null>(null);
  let rematchMsg = $state('');

  async function loadNow() {
    try {
      rooms = (await api.get<{ rooms: RoomNow[] }>('/spins/now')).rooms;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function loadList() {
    error = '';
    try {
      const r = room ? `&room=${encodeURIComponent(room)}` : '';
      if (tab === 'records') {
        spins = (await api.get<{ spins: SpinView[] }>(`/spins/spins?limit=60${r}`)).spins;
      } else {
        const kind = tab === 'all' ? '' : tab;
        const res = await api.get<{ total: number; plays: PlayView[] }>(`/spins/plays?limit=120${kind ? `&kind=${kind}` : ''}${r}`);
        plays = res.plays;
        total = res.total;
      }
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function loadStats() {
    try {
      stats = await api.get<SpinStats>(`/spins/stats?days=${days}`);
    } catch {
      /* the list shows errors */
    }
  }

  $effect(() => {
    void tab;
    void room;
    loadList();
  });
  $effect(() => {
    void days;
    loadStats();
  });

  onMount(() => {
    loadNow();
    const t = setInterval(() => {
      loadNow();
      if (tab !== 'records') loadList();
    }, 20_000);
    return () => clearInterval(t);
  });

  function refresh() {
    picking = null;
    loadList();
    loadStats();
    loadNow();
  }
  async function matchAgain() {
    const r = await api.post<{ changed: number }>('/admin/spins/rematch');
    rematchMsg = r.changed ? `${r.changed} plays updated.` : 'Nothing changed.';
    refresh();
  }
  /** Plays worth a second look: not in the collection, or not sure which copy. */
  const unsure = (p: PlayView) => p.kind === 'heard' || (p.kind === 'physical' && (!p.record || p.confidence === 'ambiguous' || p.confidence === 'likely'));
  async function remove(p: PlayView) {
    await api.del(`/admin/spins/plays/${p.id}`);
    loadList();
    loadStats();
  }

  const label: Record<string, string> = { vinyl: 'Vinyl', cd: 'CD', cassette: 'Cassette', radio: 'Radio', file: 'moOde', stream: 'Stream' };
  const badge = (p: { kind: string; detail: string }) => (p.kind === 'heard' ? 'Not in collection' : label[p.detail] ?? p.detail ?? p.kind);
  const time = (t: number) => {
    const d = new Date(t);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const yesterday = new Date(today.getTime() - 86_400_000).toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return hm;
    if (yesterday) return `Yesterday ${hm}`;
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })} ${hm}`;
  };
  const hours = (h: number) => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10);
  const roomNames = $derived(rooms.map((r) => r.room));
  const tabs: { key: Tab; label: string }[] = [
    { key: 'records', label: 'Records put on' },
    { key: 'all', label: 'Everything' },
    { key: 'streamed', label: 'Streamed' },
    { key: 'heard', label: 'Not in collection' },
  ];
</script>

<div class="page">
  <header>
    <a href="/" class="logo" onclick={router.link} aria-label="Back to the records"><Logo height="1.9rem" /></a>
    <h1>Spins</h1>
    <a href="/" class="btn" onclick={router.link}>Back to the records</a>
  </header>

  {#if error}<p class="notice error">{error}</p>{/if}

  <!-- What's on now -->
  {#if rooms.length}
    <section class="now">
      {#each rooms as r (r.room)}
        <div class="room card" class:live={!!r.play || !!r.session}>
          <div class="room-head">
            <span class="dot" class:on={r.online} title={r.online ? 'Listener online' : 'Listener offline'}></span>
            <b>{r.room}</b>
          </div>
          {#if r.play}
            <button class="now-play" onclick={() => r.play?.record && router.go(`/r/${r.play.record.id}`)} disabled={!r.play.record}>
              <span class="thumb nocover">{#if r.play.cover}<img src={r.play.cover} alt="" />{/if}</span>
              <span class="txt">
                <span class="t">{r.play.title}</span>
                <span class="a">{r.play.artist}</span>
                <span class="tag" data-kind={r.play.kind}>{badge(r.play)}{r.play.station ? ` · ${r.play.station}` : ''}</span>
              </span>
            </button>
          {:else if r.session}
            <div class="quiet">
              {r.session.mode === 'radio' ? 'Radio' : 'moOde'}{r.session.station ? ` · ${r.session.station}` : ''}
              <span class="muted">since {time(r.session.startedAt)}</span>
            </div>
          {:else}
            <div class="quiet muted">Quiet</div>
          {/if}
        </div>
      {/each}
    </section>
  {:else}
    <p class="notice">No listeners yet. Add the JPlaying Now units under Settings → Listeners.</p>
  {/if}

  <div class="cols">
    <main>
      <nav class="tabs">
        {#each tabs as t (t.key)}
          <button class="chip" class:on={tab === t.key} onclick={() => (tab = t.key)}>{t.label}</button>
        {/each}
        <span class="sep"></span>
        <button class="chip" class:on={!room} onclick={() => (room = '')}>All rooms</button>
        {#each roomNames as r (r)}
          <button class="chip" class:on={room === r} onclick={() => (room = r)}>{r}</button>
        {/each}
      </nav>

      {#if tab === 'records'}
        {#if !spins.length}<p class="muted empty">No records put on yet.</p>{/if}
        <ul class="list">
          {#each spins as s (`${s.instanceId}-${s.startedAt}`)}
            <li>
              <button class="row" onclick={() => router.go(`/r/${s.record.id}`)}>
                <span class="thumb nocover">{#if s.record.cover}<img src={s.record.cover} alt="" loading="lazy" />{/if}</span>
                <span class="txt">
                  <span class="t">{s.record.title}</span>
                  <span class="a">{s.record.artist}{s.record.year ? ` · ${s.record.year}` : ''}</span>
                </span>
                <span class="meta">
                  <span class="tag" data-kind="physical">{label[s.medium] ?? s.medium}</span>
                  <span class="muted">{s.room} · {time(s.startedAt)} · {s.tracks} {s.tracks === 1 ? 'track' : 'tracks'}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted count">
          {total.toLocaleString('sv-SE')} plays
          {#if tab === 'heard'}· songs the microphone recognised that didn't come from moOde and that aren't on a record or CD you own (TV, a phone…).{/if}
          {#if session.isAdmin}<button class="btn small ghost" onclick={matchAgain}>Match again</button> {rematchMsg}{/if}
        </p>
        <ul class="list">
          {#each plays as p (p.id)}
            <li>
              <div class="row">
                <button class="thumb nocover" onclick={() => p.record && router.go(`/r/${p.record.id}`)} disabled={!p.record} aria-label="Open the record">
                  {#if p.cover}<img src={p.cover} alt="" loading="lazy" />{/if}
                </button>
                <span class="txt">
                  <span class="t">{p.title}</span>
                  <span class="a">{p.artist}{p.record ? ` · ${p.record.title}` : p.kind === 'physical' ? ' · which record?' : p.album ? ` · ${p.album}` : ''}</span>
                  {#if p.note && unsure(p)}<span class="note">{p.note}</span>{/if}
                </span>
                <span class="meta">
                  <span class="tag" data-kind={p.kind}>{badge(p)}{p.station ? ` · ${p.station}` : ''}{p.confidence === 'ambiguous' ? ' ?' : ''}</span>
                  <span class="muted">{p.room} · {time(p.startedAt)}{p.heardBy.length > 1 ? ' · heard in both' : ''}</span>
                </span>
                {#if session.isAdmin}
                  <span class="acts">
                    {#if p.kind !== 'streamed'}
                      <button class="btn small" class:primary={unsure(p)} class:ghost={!unsure(p)} onclick={() => (picking = p)}>
                        {p.kind === 'heard' ? 'It was my record…' : unsure(p) ? 'Which record?' : 'Change…'}
                      </button>
                    {/if}
                    <button class="btn small ghost" onclick={() => remove(p)} aria-label="Remove this play">✕</button>
                  </span>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </main>

    <aside>
      <div class="card stats">
        <div class="period">
          {#each [[7, 'Week'], [30, 'Month'], [365, 'Year'], [0, 'All']] as [d, l] (d)}
            <button class="chip" class:on={days === d} onclick={() => (days = Number(d))}>{l}</button>
          {/each}
        </div>
        {#if stats}
          <div class="tiles">
            <div><b class="tabular">{stats.physical.spins}</b><span class="muted">records put on</span></div>
            <div><b class="tabular">{hours(stats.physical.vinylHours)}</b><span class="muted">hours of vinyl</span></div>
            <div><b class="tabular">{stats.streamed.tracks}</b><span class="muted">songs streamed</span></div>
            <div><b class="tabular">{hours(stats.streamingHours)}</b><span class="muted">hours of moOde</span></div>
          </div>
          {#if stats.topRecords.length}
            <h3>Most played records</h3>
            <div class="covers">
              {#each stats.topRecords.slice(0, 8) as r (r.id)}
                <button class="cv nocover" onclick={() => router.go(`/r/${r.id}`)} title="{r.artist} – {r.title} ({r.spins}×)">
                  {#if r.cover}<img src={r.cover} alt="" />{/if}<span class="n">{r.spins}×</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if stats.topArtists.length}
            <h3>Top artists</h3>
            <ol class="top">
              {#each stats.topArtists as a (a.artist)}<li><span>{a.artist}</span><span class="muted tabular">{a.n}</span></li>{/each}
            </ol>
          {/if}
          {#if stats.radio.length}
            <h3>Radio</h3>
            <ol class="top">
              {#each stats.radio as r (`${r.room}${r.station}`)}<li><span>{r.station} <span class="muted">· {r.room}</span></span><span class="muted tabular">{hours(r.hours)} h</span></li>{/each}
            </ol>
          {/if}
        {/if}
      </div>
    </aside>
  </div>
</div>

{#if picking}
  <RecordPicker play={picking} onclose={() => (picking = null)} ondone={refresh} />
{/if}

<style>
  .page {
    height: 100dvh;
    overflow-y: auto;
    padding: 0 20px 40px;
    max-width: 1300px;
    margin: 0 auto;
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
  .now {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }
  .room {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .room.live {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  }
  .room-head {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 1.05rem;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--muted);
    opacity: 0.5;
  }
  .dot.on {
    background: var(--accent);
    opacity: 1;
  }
  .now-play {
    display: flex;
    gap: 12px;
    align-items: center;
    text-align: left;
    padding: 0;
  }
  .now-play:disabled {
    opacity: 1;
    cursor: default;
  }
  .now-play .thumb {
    width: 76px;
    height: 76px;
  }
  .quiet {
    font-weight: 700;
    min-height: 40px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 22px;
    align-items: start;
  }
  .tabs {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-bottom: 12px;
  }
  .sep {
    width: 1px;
    height: 28px;
    background: var(--line);
    margin: 0 4px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    width: 100%;
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    text-align: left;
  }
  .thumb {
    width: 52px;
    height: 52px;
    flex: none;
    border-radius: 6px;
    overflow: hidden;
    padding: 0;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .thumb:disabled {
    opacity: 1;
    cursor: default;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 800;
  }
  .a {
    font-size: 0.9rem;
    color: var(--muted);
  }
  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .tag {
    font-weight: 800;
    font-size: 0.75rem;
    padding: 0.15em 0.6em;
    border-radius: 99px;
    background: var(--card-hover);
    border: 1px solid var(--line);
    align-self: flex-start;
  }
  .meta .tag {
    align-self: flex-end;
  }
  .tag[data-kind='physical'] {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: transparent;
  }
  .tag[data-kind='streamed'] {
    color: var(--blue);
  }
  .note {
    font-size: 0.78rem;
    color: var(--muted);
    font-style: italic;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acts {
    display: flex;
    gap: 2px;
  }
  .count,
  .empty {
    margin: 4px 0 10px;
  }
  .stats {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .period {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .period .chip {
    min-height: 36px;
  }
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .tiles div {
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border-radius: 10px;
    padding: 10px 12px;
  }
  .tiles b {
    font-size: 1.6rem;
    line-height: 1.1;
  }
  .tiles span {
    font-size: 0.8rem;
  }
  h3 {
    font-size: 0.95rem;
    margin-top: 6px;
  }
  .covers {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .cv {
    position: relative;
    aspect-ratio: 1;
    border-radius: 6px;
    overflow: hidden;
    padding: 0;
  }
  .cv img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .cv .n {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 0.7rem;
    font-weight: 800;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    border-radius: 6px;
    padding: 0 5px;
  }
  .top {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
    font-size: 0.9rem;
  }
  .top li {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  @media (max-width: 900px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
    .meta .muted {
      display: none;
    }
  }
</style>
