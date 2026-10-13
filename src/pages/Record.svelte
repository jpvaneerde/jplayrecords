<script lang="ts">
  import { api, type RecordDetail, type ListItem } from '../lib/api';
  import { browse } from '../lib/browse.svelte';
  import { router } from '../lib/router.svelte';
  import { session } from '../lib/session.svelte';
  import ShelfMap from '../lib/ui/ShelfMap.svelte';

  let { id }: { id: number } = $props();

  let data = $state<RecordDetail | null>(null);
  let error = $state('');
  let fixing = $state(false);
  let msg = $state('');
  let scroller: HTMLElement | undefined = $state();

  async function load(i: number) {
    error = '';
    msg = '';
    fixing = false;
    try {
      data = await api.get<RecordDetail>(`/records/${i}`);
      scroller?.scrollTo(0, 0);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    load(id);
  });

  function close() {
    router.back('/');
  }
  function filterBy(key: 'artist' | 'genre', value: string) {
    browse.filters = { ...browse.filters, artist: '', letter: '', genre: '', format: '', decade: '', shelf: '', q: '' };
    browse.set(key, value);
    router.go('/');
  }
  function go(it: ListItem) {
    router.go(`/r/${it.id}`, true);
  }
  function showShelf() {
    const p = data?.position;
    if (!p || p.compartment == null) return;
    browse.showShelf(`${p.run}:${p.compartment}`, `${p.runName} ${p.label}`.trim());
    router.go('/');
  }

  async function pinHere(compartment: number) {
    try {
      await api.post('/admin/anchors', { id, compartment });
      await load(id);
      msg = 'Saved: records after this one move along with it.';
    } catch (e) {
      msg = (e as Error).message;
    }
  }
  async function unpin() {
    await api.del(`/admin/anchors/${id}`);
    await load(id);
  }

  const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
  const it = $derived(data?.item);
  const pos = $derived(data?.position);
  const tracks = $derived(data?.details?.tracklist ?? []);
  const multi = $derived(!!data?.grid && data.grid.rows * data.grid.cols > 1);
  const fieldEntries = $derived(Object.entries(it?.fields ?? {}).filter(([k]) => k !== 'Location'));
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label={it ? `${it.artist} – ${it.title}` : 'Record'}>
  <button class="btn icon close" onclick={close} aria-label="Back">✕</button>

  {#if error}
    <div class="center"><p class="notice error">{error}</p><button class="btn" onclick={close}>Back</button></div>
  {:else if it}
    <div class="layout" bind:this={scroller}>
      <section class="left">
        <div class="cover nocover">
          {#if it.coverLarge}<img src={it.coverLarge} alt="Cover of {it.title}" />{/if}
        </div>

        {#if pos}
          <div class="where card">
            <div class="where-head">
              <div>
                <div class="eyebrow muted">{multi ? pos.runName : 'Shelf'}{pos.source === 'field' ? ' · from Discogs' : ''}</div>
                {#if pos.overflow}
                  <div class="big">Past the last compartment</div>
                {:else}
                  <div class="big">{pos.place || pos.label || pos.runName}</div>
                  {#if pos.nth && pos.inCompartment}
                    <div class="muted">about the {ordinal(pos.nth)} of {pos.inCompartment} from the left</div>
                  {:else if pos.source === 'computed' && !pos.label}
                    <div class="muted">in A–Z order</div>
                  {/if}
                {/if}
              </div>
              {#if pos.label}<div class="code">{pos.label}</div>{/if}
            </div>
            {#if data?.grid && multi}
              <ShelfMap grid={data.grid} position={pos} onpick={fixing ? pinHere : undefined} compact />
            {/if}
            <div class="where-actions">
              {#if pos.compartment != null}
                <button class="btn small" onclick={showShelf}>What else is here</button>
              {/if}
              {#if session.isAdmin && pos.source === 'computed' && multi}
                <button class="btn small" class:primary={fixing} onclick={() => (fixing = !fixing)}>{fixing ? 'Tap its compartment…' : 'Wrong place?'}</button>
                {#if pos.anchored}<button class="btn small ghost" onclick={unpin}>Remove fix</button>{/if}
              {/if}
            </div>
            {#if fixing}<p class="hint muted">Tap the compartment where this record is the <b>first one</b> on the left.</p>{/if}
            {#if msg}<p class="hint">{msg}</p>{/if}
          </div>
        {/if}

        {#if data && (data.neighbours.before.length || data.neighbours.after.length)}
          <div class="nb">
            <div class="eyebrow muted">Next to it on the shelf</div>
            <div class="nb-row">
              {#each data.neighbours.before as n (n.id)}
                <button class="nb-item" onclick={() => go(n)}>
                  <span class="mini nocover">{#if n.cover}<img src={n.cover} alt="" />{/if}</span><span class="nb-t">{n.artist}</span>
                </button>
              {/each}
              <span class="nb-here" aria-label="This record">●</span>
              {#each data.neighbours.after as n (n.id)}
                <button class="nb-item" onclick={() => go(n)}>
                  <span class="mini nocover">{#if n.cover}<img src={n.cover} alt="" />{/if}</span><span class="nb-t">{n.artist}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <section class="right">
        <button class="artist" onclick={() => filterBy('artist', it.artist)}>{it.artist}</button>
        <h1>{it.title}</h1>
        <p class="facts">
          {[it.year, data?.details?.country, it.formatText].filter(Boolean).join(' · ')}
          {#if it.pressingYear && it.pressingYear !== it.year}<span class="muted"> · this pressing {it.pressingYear}</span>{/if}
        </p>
        {#if it.labels}<p class="muted label">{it.labels}</p>{/if}

        <div class="tags">
          {#each [...it.genres, ...it.styles] as g (g)}
            <button class="chip" onclick={() => filterBy('genre', g)}>{g}</button>
          {/each}
        </div>

        {#if data?.played?.spins}
          <p class="played">
            ♫ Put on {data.played.spins === 1 ? 'once' : `${data.played.spins} times`}{#if data.played.last}, last {new Date(data.played.last.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} in the {data.played.last.room.toLowerCase()}{/if}
          </p>
        {:else if data}
          <p class="played muted">Not played since Spins started listening.</p>
        {/if}
        {#if it.copies > 1}<p class="notice">You have {it.copies} copies of this release.</p>{/if}

        {#if tracks.length}
          <h2>Tracks</h2>
          <ol class="tracks">
            {#each tracks as t, i (i)}
              {#if t.heading}
                <li class="heading">{t.title}</li>
              {:else}
                <li>
                  <span class="pos muted tabular">{t.position}</span>
                  <span class="tt">{t.title}{#if t.artists}<span class="muted"> – {t.artists}</span>{/if}</span>
                  <span class="dur muted tabular">{t.duration}</span>
                </li>
              {/if}
            {/each}
          </ol>
        {:else if !data?.details}
          <p class="muted">The tracklist comes with the next sync.</p>
        {/if}

        {#if fieldEntries.length}
          <dl class="fields">
            {#each fieldEntries as [k, v] (k)}
              <dt class="muted">{k}</dt>
              <dd>{v}</dd>
            {/each}
          </dl>
        {/if}

        {#if !session.kiosk}
          <p><a href={it.discogsUrl} target="_blank" rel="noreferrer">Open on Discogs ↗</a></p>
        {/if}
      </section>
    </div>
  {:else}
    <div class="center muted">Loading…</div>
  {/if}
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--bg);
    animation: in 0.16s ease-out;
  }
  .close {
    position: absolute;
    top: 14px;
    right: 18px;
    z-index: 2;
    font-size: 1.4rem;
    background: var(--bg-2);
  }
  .center {
    height: 100%;
    display: grid;
    place-content: center;
    gap: 1rem;
    text-align: center;
  }
  .layout {
    height: 100%;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(300px, 44%) minmax(0, 1fr);
    gap: 32px;
    padding: 24px 28px 40px;
    align-items: start;
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 16px;
    position: sticky;
    top: 0;
  }
  .cover {
    width: min(100%, 52vh);
    align-self: center;
    aspect-ratio: 1;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.7);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .where {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
  }
  .where-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }
  .eyebrow {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .big {
    font-size: 1.6rem;
    font-weight: 800;
    line-height: 1.15;
  }
  .code {
    font-size: 2.6rem;
    font-weight: 900;
    color: var(--accent-ink);
    background: var(--accent);
    border-radius: 14px;
    padding: 0.05em 0.35em;
    letter-spacing: -0.03em;
  }
  .where-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hint {
    margin: 0;
    font-size: 0.9rem;
  }
  .nb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .nb-item {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
    padding: 0;
  }
  .mini {
    aspect-ratio: 1;
    border-radius: 6px;
    overflow: hidden;
    opacity: 0.85;
  }
  .mini img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .nb-t {
    font-size: 0.72rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
  }
  .nb-here {
    color: var(--accent);
    font-size: 1.2rem;
  }
  .right {
    padding-top: 8px;
    padding-right: 56px;
    min-width: 0;
  }
  .artist {
    font-size: 1.5rem;
    font-weight: 800;
    color: var(--accent-2);
    padding: 0;
    text-align: left;
  }
  h1 {
    font-size: clamp(2rem, 4vw, 3.2rem);
    margin: 4px 0 10px;
  }
  h2 {
    font-size: 1.2rem;
    margin: 26px 0 8px;
  }
  .facts {
    font-size: 1.1rem;
    margin: 0;
  }
  .label {
    margin: 4px 0 0;
  }
  .played {
    margin: 0 0 12px;
    font-weight: 700;
  }
  .played.muted {
    font-weight: 500;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 16px 0;
  }
  .tracks {
    list-style: none;
    padding: 0;
    margin: 0;
    columns: 2 300px;
    column-gap: 28px;
  }
  .tracks li {
    display: flex;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
    break-inside: avoid;
  }
  .tracks li.heading {
    font-weight: 800;
    border-bottom: 0;
    padding-top: 12px;
  }
  .pos {
    width: 2.6em;
    flex: none;
  }
  .tt {
    flex: 1;
  }
  .fields {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 16px;
    margin-top: 24px;
  }
  .fields dd {
    margin: 0;
  }
  @media (max-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      padding: 16px;
    }
    .left {
      position: static;
    }
    .right {
      padding-right: 0;
    }
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: scale(0.985);
    }
  }
</style>
