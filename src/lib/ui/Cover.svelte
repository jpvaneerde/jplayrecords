<script lang="ts">
  import type { ListItem } from '../api';
  let { item, onopen }: { item: ListItem; onopen: (id: number) => void } = $props();
  let failed = $state(false);
</script>

<button class="tile" onclick={() => onopen(item.id)}>
  <div class="art nocover">
    {#if item.cover && !failed}
      <img src={item.cover} alt="" loading="lazy" decoding="async" onerror={() => (failed = true)} />
    {/if}
  </div>
  <div class="meta">
    <div class="artist">{item.artist}</div>
    <div class="title">{item.title}</div>
    <div class="sub muted">{[item.year, item.format].filter(Boolean).join(' · ')}</div>
  </div>
</button>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    text-align: left;
    min-width: 0;
    padding: 0;
    border-radius: 12px;
    transition: transform 0.1s;
    content-visibility: auto;
    contain-intrinsic-size: auto 300px;
  }
  .tile:active {
    transform: scale(0.97);
  }
  .art {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .meta {
    padding: 8px 2px 4px;
    min-width: 0;
    line-height: 1.25;
  }
  .artist,
  .title,
  .sub {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .artist {
    font-weight: 800;
  }
  .title {
    font-size: 0.92em;
  }
  .sub {
    font-size: 0.8em;
    margin-top: 2px;
  }
</style>
