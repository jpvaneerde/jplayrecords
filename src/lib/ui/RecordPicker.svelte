<script lang="ts">
  // "Which record was this?" — fix a play on the Spins page: pick your copy, mark it as not yours, or undo.
  import { onMount } from 'svelte';
  import { api, type ListItem, type PlayView } from '../api';
  import { session } from '../session.svelte';
  import Keyboard from './Keyboard.svelte';

  let { play, onclose, ondone }: { play: PlayView; onclose: () => void; ondone: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let q = $state(play.artist); // prefilled once
  let results = $state<ListItem[]>([]);
  let busy = $state(false);
  let error = $state('');
  let typing = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function search() {
    const text = q.trim();
    if (!text) {
      results = [];
      return;
    }
    try {
      results = (await api.get<{ items: ListItem[] }>(`/records?q=${encodeURIComponent(text)}&limit=40`)).items;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void q;
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });
  onMount(() => () => clearTimeout(timer));

  async function save(body: unknown) {
    busy = true;
    error = '';
    try {
      await api.put(`/admin/spins/plays/${play.id}`, body);
      ondone();
    } catch (e) {
      error = (e as Error).message;
      busy = false;
    }
  }

  const fmt: Record<string, string> = { vinyl: 'Vinyl', cd: 'CD', cassette: 'Cassette' };
</script>

<div class="back" role="presentation" onclick={onclose}></div>
<div class="sheet card" role="dialog" aria-modal="true" aria-label="Which record was this?">
  <header>
    <div>
      <h2>Which record was this?</h2>
      <p class="muted">{play.artist} – {play.title} · {play.room}</p>
    </div>
    <button class="btn icon" onclick={onclose} aria-label="Close">✕</button>
  </header>

  {#if play.alternatives.length}
    <h3>Suggestions</h3>
    <ul class="list">
      {#each play.alternatives as a (a.id)}
        <li>
          <button class="row" disabled={busy} onclick={() => save({ record: a.id })}>
            <span class="thumb nocover">{#if a.cover}<img src={a.cover} alt="" />{/if}</span>
            <span class="txt"><b>{a.title}</b><span class="muted">{a.artist}</span></span>
            <span class="tag">{fmt[a.medium] ?? a.medium}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <h3>Search your collection</h3>
  <input
    bind:value={q}
    placeholder="Artist, album, track…"
    readonly={session.osk}
    inputmode={session.osk ? 'none' : 'search'}
    onclick={() => session.osk && (typing = true)}
    aria-label="Search your collection"
  />
  <ul class="list results">
    {#each results as r (r.id)}
      <li>
        <button class="row" disabled={busy} onclick={() => save({ record: r.id })}>
          <span class="thumb nocover">{#if r.cover}<img src={r.cover} alt="" loading="lazy" />{/if}</span>
          <span class="txt"><b>{r.title}</b><span class="muted">{r.artist}{r.year ? ` · ${r.year}` : ''}</span></span>
          <span class="tag">{r.format}</span>
        </button>
      </li>
    {:else}
      {#if q.trim()}<li class="muted none">Nothing found.</li>{/if}
    {/each}
  </ul>

  {#if error}<p class="notice error">{error}</p>{/if}

  <footer>
    <button class="btn" disabled={busy} onclick={() => save({ auto: true })} title="Undo your correction and let JPlay Spins decide">Match automatically</button>
    {#if play.kind !== 'heard'}
      <button class="btn danger" disabled={busy} onclick={() => save({ heard: true })}>Not one of my records</button>
    {/if}
  </footer>

  {#if typing && session.osk}
    <div class="kb"><Keyboard bind:value={q} ondone={() => (typing = false)} /></div>
  {/if}
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 50;
  }
  .sheet {
    position: fixed;
    z-index: 51;
    left: 50%;
    top: 4vh;
    translate: -50% 0;
    width: min(720px, calc(100vw - 24px));
    max-height: 92vh;
    overflow-y: auto;
    background: var(--bg);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }
  header p {
    margin: 4px 0 0;
  }
  h2 {
    font-size: 1.4rem;
  }
  h3 {
    font-size: 0.95rem;
    margin: 6px 0 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .results {
    max-height: 42vh;
    overflow-y: auto;
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
    width: 48px;
    height: 48px;
    flex: none;
    border-radius: 6px;
    overflow: hidden;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }
  .txt b,
  .txt span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    font-weight: 800;
    font-size: 0.75rem;
    padding: 0.15em 0.6em;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-ink);
    white-space: nowrap;
  }
  .none {
    padding: 8px 2px;
  }
  footer {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .kb {
    position: sticky;
    bottom: -18px;
    margin: 0 -20px -18px;
  }
</style>
