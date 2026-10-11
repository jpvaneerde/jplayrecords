<script lang="ts" module>
  export type Kind = 'format' | 'genre' | 'decade' | 'artist' | 'sort';
</script>

<script lang="ts">
  // Full-screen picker for one filter (big touch targets).
  import { api, type Facet } from '../api';
  import { browse, type Filters } from '../browse.svelte';

  let { kind, onclose }: { kind: Kind; onclose: () => void } = $props();

  const titles: Record<Kind, string> = { format: 'Format', genre: 'Genre & style', decade: 'Decade', artist: 'Artist', sort: 'Order' };
  const sorts: { key: Filters['sort']; label: string }[] = [
    { key: '', label: 'Shelf order (A–Z, as in Discogs)' },
    { key: 'added', label: 'Recently added' },
    { key: 'year', label: 'Oldest first' },
    { key: 'year-desc', label: 'Newest first' },
    { key: 'title', label: 'Title A–Z' },
  ];

  let letter = $state(browse.filters.letter || '');
  let artists = $state<{ name: string; n: number }[]>([]);

  $effect(() => {
    if (kind !== 'artist') return;
    const l = letter;
    api.get<{ artists: { name: string; n: number }[] }>(`/records/artists${l ? `?letter=${encodeURIComponent(l)}` : ''}`)
      .then((r) => (artists = r.artists))
      .catch(() => (artists = []));
  });

  function pick<K extends keyof Filters>(key: K, value: Filters[K]) {
    browse.set(key, browse.filters[key] === value ? ('' as Filters[K]) : value);
    onclose();
  }

  const f = $derived(browse.facets);
</script>

<div class="sheet" role="dialog" aria-modal="true" aria-label={titles[kind]}>
  <header>
    <h2>{titles[kind]}</h2>
    <button class="btn icon" onclick={onclose} aria-label="Close">✕</button>
  </header>

  <div class="body">
    {#if kind === 'format'}
      {@render chips(f?.formats ?? [], 'format')}
    {:else if kind === 'genre'}
      <h3 class="muted">Genres</h3>
      {@render chips(f?.genres ?? [], 'genre')}
      {#if f?.styles.length}
        <h3 class="muted">Styles</h3>
        {@render chips(f.styles, 'genre')}
      {/if}
    {:else if kind === 'decade'}
      {@render chips(f?.decades ?? [], 'decade')}
    {:else if kind === 'sort'}
      <div class="list">
        {#each sorts as s (s.key)}
          <button class="chip big" class:on={browse.filters.sort === s.key} onclick={() => { browse.set('sort', s.key); onclose(); }}>{s.label}</button>
        {/each}
      </div>
    {:else}
      <div class="letters">
        {#each f?.letters ?? [] as l (l.key)}
          <button class="chip letter" class:on={letter === l.key} onclick={() => (letter = letter === l.key ? '' : l.key)}>{l.key}</button>
        {/each}
      </div>
      {#if letter}
        <div class="row">
          <button class="btn primary" onclick={() => pick('letter', letter)}>Show everything under {letter}</button>
        </div>
        <div class="artists">
          {#each artists as a (a.name)}
            <button class="chip" class:on={browse.filters.artist === a.name} onclick={() => pick('artist', a.name)}>
              {a.name} <span class="n">{a.n}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="muted">Pick a letter.</p>
      {/if}
    {/if}
  </div>
</div>

{#snippet chips(list: Facet[], key: 'format' | 'genre' | 'decade')}
  <div class="chips">
    {#each list as x (x.key)}
      <button class="chip big" class:on={browse.filters[key] === x.key} onclick={() => pick(key, x.key)}>
        {x.label ?? x.key} <span class="n">{x.n}</span>
      </button>
    {/each}
  </div>
{/snippet}

<style>
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    animation: up 0.18s ease-out;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    font-size: 1.8rem;
  }
  h3 {
    font-size: 1rem;
    margin: 18px 0 10px;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px 40px;
  }
  .chips,
  .artists,
  .list {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .list {
    flex-direction: column;
    align-items: flex-start;
  }
  .chip.big {
    min-height: 56px;
    font-size: 1.1rem;
    padding: 0.4em 1.3em;
  }
  .letters {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
    gap: 8px;
    margin-bottom: 16px;
  }
  .letter {
    justify-content: center;
    min-height: 60px;
    font-size: 1.4rem;
    border-radius: 14px;
  }
  .row {
    margin-bottom: 14px;
  }
  @keyframes up {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
</style>
