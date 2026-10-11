<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { browse } from '../lib/browse.svelte';
  import { router } from '../lib/router.svelte';
  import { session } from '../lib/session.svelte';
  import Cover from '../lib/ui/Cover.svelte';
  import FilterSheet, { type Kind } from '../lib/ui/FilterSheet.svelte';
  import Keyboard from '../lib/ui/Keyboard.svelte';
  import Logo from '../lib/ui/Logo.svelte';

  let sheet = $state<Kind | null>(null);
  let typing = $state(false);
  let grid: HTMLElement | undefined = $state();
  let sentinel: HTMLElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let q = $state(browse.filters.q);

  // Keep the query in the store (and search as you type).
  $effect(() => {
    if (q !== browse.filters.q) browse.set('q', q);
  });
  // The store can clear it (idle reset).
  $effect(() => {
    const v = browse.filters.q;
    if (v !== q) q = v;
  });

  onMount(() => {
    if (!browse.items.length) browse.reload();
    if (!browse.facets) browse.loadFacets();
    tick().then(() => grid && (grid.scrollTop = browse.scrollTop));
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && browse.more(), { root: grid, rootMargin: '800px' });
    if (sentinel) io.observe(sentinel);
    return () => io.disconnect();
  });

  function open(id: number) {
    if (grid) browse.scrollTop = grid.scrollTop;
    typing = false;
    router.go(`/r/${id}`);
  }

  async function random() {
    const id = await browse.random();
    if (id) open(id);
  }

  function focusSearch() {
    if (session.osk) typing = true;
    else input?.focus();
  }

  const f = $derived(browse.filters);
  const label = (list: { key: string; label?: string }[] | undefined, key: string) => list?.find((x) => x.key === key)?.label ?? key;
  const tile = $derived({ s: '150px', m: '190px', l: '250px' }[session.display.tile]);
</script>

<div class="page" style:--tile={tile}>
  <header class="top">
    <a href="/" class="logo" onclick={(e) => { e.preventDefault(); browse.clear(); grid?.scrollTo(0, 0); }} aria-label="Start"><Logo height="2.1rem" /></a>

    <div class="search" class:on={typing || !!q}>
      <span class="glass" aria-hidden="true">⌕</span>
      <input
        bind:this={input}
        bind:value={q}
        placeholder="Search artist, album, label, track…"
        readonly={session.osk}
        inputmode={session.osk ? 'none' : 'search'}
        onfocus={() => session.osk && (typing = true)}
        onclick={focusSearch}
        enterkeyhint="search"
        aria-label="Search"
      />
      {#if q}
        <button class="x" onclick={() => (q = '')} aria-label="Clear search">✕</button>
      {/if}
    </div>

    <button class="btn big primary" onclick={random} title="Pick something for me">🎲 <span class="hide-s">Random</span></button>
    {#if session.isAdmin}
      <a class="btn icon" href="/settings" onclick={router.link} aria-label="Settings">⚙</a>
    {/if}
  </header>

  <nav class="filters" aria-label="Filters">
    <button class="chip" class:on={!!f.format} onclick={() => (sheet = 'format')}>{f.format ? label(browse.facets?.formats, f.format) : 'Format'} ▾</button>
    <button class="chip" class:on={!!f.genre} onclick={() => (sheet = 'genre')}>{f.genre || 'Genre'} ▾</button>
    <button class="chip" class:on={!!f.decade} onclick={() => (sheet = 'decade')}>{f.decade ? label(browse.facets?.decades, f.decade) : 'Decade'} ▾</button>
    <button class="chip" class:on={!!(f.artist || f.letter)} onclick={() => (sheet = 'artist')}>{f.artist || (f.letter ? `Artists: ${f.letter}` : 'Artist A–Z')} ▾</button>
    {#if f.shelf}
      <button class="chip on" onclick={() => browse.set('shelf', '')}>Shelf {browse.shelfLabel} ✕</button>
    {/if}
    <button class="chip" class:on={!!f.sort} onclick={() => (sheet = 'sort')}>{f.sort ? 'Order ▾' : 'Shelf order ▾'}</button>
    {#if browse.active}
      <button class="chip ghost" onclick={() => browse.clear(true)}>Clear filters</button>
    {/if}
    <span class="count muted tabular">{browse.total.toLocaleString('sv-SE')} {browse.total === 1 ? 'record' : 'records'}</span>
  </nav>

  <main bind:this={grid} class="grid-wrap">
    {#if browse.error}
      <p class="notice error">{browse.error}</p>
    {/if}
    <div class="grid">
      {#each browse.items as item (item.id)}
        <Cover {item} onopen={open} />
      {/each}
    </div>
    {#if !browse.loading && !browse.items.length && !browse.error}
      <div class="empty">
        <p>Nothing found{q ? ` for “${q}”` : ''}.</p>
        {#if browse.active || q}
          <button class="btn" onclick={() => { q = ''; browse.clear(); }}>Show everything</button>
        {/if}
      </div>
    {/if}
    <div bind:this={sentinel} class="sentinel"></div>
  </main>

  {#if typing && session.osk}
    <div class="kb">
      <Keyboard bind:value={q} ondone={() => (typing = false)} />
    </div>
  {/if}
</div>

{#if sheet}
  <FilterSheet kind={sheet} onclose={() => (sheet = null)} />
{/if}

<style>
  .page {
    height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 20px 10px;
  }
  .logo {
    color: inherit;
    flex: none;
  }
  .search {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }
  .glass {
    position: absolute;
    left: 16px;
    font-size: 1.5rem;
    color: var(--muted);
    pointer-events: none;
  }
  .search input {
    height: 56px;
    font-size: 1.2rem;
    padding-left: 48px !important;
    padding-right: 52px !important;
    border-radius: 14px !important;
  }
  .search.on input {
    border-color: var(--accent);
  }
  .x {
    position: absolute;
    right: 6px;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    color: var(--muted);
    font-size: 1.1rem;
  }
  .filters {
    display: flex;
    gap: 8px;
    padding: 4px 20px 12px;
    overflow-x: auto;
    scrollbar-width: none;
    align-items: center;
  }
  .chip.ghost {
    background: transparent;
    color: var(--muted);
  }
  .count {
    margin-left: auto;
    padding-left: 12px;
    white-space: nowrap;
    font-weight: 600;
  }
  .grid-wrap {
    flex: 1;
    overflow-y: auto;
    padding: 4px 20px 24px;
    overscroll-behavior: contain;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--tile), 1fr));
    gap: 18px 16px;
  }
  .sentinel {
    height: 1px;
  }
  .empty {
    text-align: center;
    padding: 10vh 0;
    font-size: 1.2rem;
  }
  .kb {
    flex: none;
  }
  @media (max-width: 700px) {
    .hide-s {
      display: none;
    }
    .top {
      flex-wrap: wrap;
      padding: 10px 12px;
    }
    .search {
      order: 3;
      flex-basis: 100%;
    }
    .filters,
    .grid-wrap {
      padding-left: 12px;
      padding-right: 12px;
    }
    .page {
      --tile: 120px !important;
    }
  }
</style>
