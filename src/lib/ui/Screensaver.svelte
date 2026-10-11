<script lang="ts">
  // When nobody is in the room: a slow drifting wall of covers. Any touch wakes it.
  import { onMount } from 'svelte';
  import { api, type ListItem } from '../api';

  let { onwake, total = 0 }: { onwake: () => void; total?: number } = $props();
  let items = $state<ListItem[]>([]);
  let time = $state(clock());

  function clock() {
    return new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  }

  onMount(() => {
    api.get<{ items: ListItem[] }>('/records/wall?n=72').then((r) => (items = r.items)).catch(() => {});
    const t = setInterval(() => (time = clock()), 10_000);
    // Swap the wall every few minutes so it doesn't burn in.
    const s = setInterval(() => api.get<{ items: ListItem[] }>('/records/wall?n=72').then((r) => (items = r.items)).catch(() => {}), 240_000);
    return () => {
      clearInterval(t);
      clearInterval(s);
    };
  });
</script>

<button class="saver" onpointerdown={onwake} aria-label="Wake up">
  <div class="wall">
    {#each [...items, ...items] as it, i (i)}
      <img src={it.cover} alt="" style:animation-delay="{(i % 12) * 0.4}s" />
    {/each}
  </div>
  <div class="hud">
    <div class="time tabular">{time}</div>
    <div class="hint">Touch to browse {total ? `${total.toLocaleString('sv-SE')} records` : 'the collection'}</div>
  </div>
</button>

<style>
  .saver {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: #000;
    overflow: hidden;
    padding: 0;
    display: block;
  }
  .wall {
    position: absolute;
    inset: -10% -10%;
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 6px;
    transform: rotate(-8deg);
    animation: drift 120s linear infinite alternate;
    opacity: 0.55;
  }
  .wall img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    animation: fade 9s ease-in-out infinite;
  }
  .hud {
    position: absolute;
    left: 50%;
    bottom: 8vh;
    translate: -50% 0;
    text-align: center;
    color: #fff;
    text-shadow: 0 4px 30px rgba(0, 0, 0, 0.9);
  }
  .time {
    font-size: 6rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
  }
  .hint {
    font-weight: 700;
    opacity: 0.8;
  }
  @keyframes drift {
    from {
      translate: 0 0;
    }
    to {
      translate: -6% -30%;
    }
  }
  @keyframes fade {
    50% {
      opacity: 0.6;
    }
  }
</style>
