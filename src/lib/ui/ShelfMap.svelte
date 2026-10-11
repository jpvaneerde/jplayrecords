<script lang="ts">
  // A drawing of the shelf (e.g. 6 BESTÅ frames stacked = 6 rows × 2 compartments), with the record marked.
  import type { Grid, Position } from '../api';

  let {
    grid,
    position = null,
    onpick,
    compact = false,
  }: { grid: Grid; position?: Position | null; onpick?: (index: number) => void; compact?: boolean } = $props();

  const cw = 100;
  const ch = 48;
  const gap = 6;
  const w = $derived(grid.cols * cw + (grid.cols + 1) * gap);
  const h = $derived(grid.rows * ch + (grid.rows + 1) * gap);
  const max = $derived(Math.max(1, ...grid.compartments.map((c) => c.count)));
</script>

<svg viewBox="0 0 {w} {h}" class:compact role="img" aria-label="Shelf map of {grid.name}">
  <rect x="0" y="0" width={w} height={h} rx="6" class="frame" />
  {#each grid.compartments as c (c.index)}
    {@const x = gap + c.col * (cw + gap)}
    {@const y = gap + c.row * (ch + gap)}
    {@const on = position?.compartment === c.index}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <g
      class="cell"
      class:on
      class:pick={!!onpick}
      role={onpick ? 'button' : undefined}
      tabindex={onpick ? 0 : undefined}
      onclick={() => onpick?.(c.index)}
      onkeydown={(e) => e.key === 'Enter' && onpick?.(c.index)}
    >
      <rect {x} {y} width={cw} height={ch} rx="3" class="box" />
      <!-- how full: records drawn as a fill from the left -->
      {#if c.count}
        <rect x={x + 3} y={y + 6} width={(cw - 6) * Math.min(1, c.count / max)} height={ch - 12} rx="2" class="fill" />
      {/if}
      <text x={x + cw / 2} y={y + ch / 2 + 5} class="lbl">{c.label}</text>
      {#if on && position?.at != null}
        {@const mx = x + 3 + (cw - 6) * position.at}
        <rect x={mx - 2.5} y={y + 2} width="5" height={ch - 4} rx="2" class="marker" />
      {/if}
    </g>
  {/each}
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    max-height: 46vh;
  }
  svg.compact {
    max-height: 30vh;
  }
  .frame {
    fill: var(--bg-2);
    stroke: var(--line);
  }
  .box {
    fill: color-mix(in srgb, var(--text) 4%, transparent);
    stroke: var(--line);
  }
  .fill {
    fill: color-mix(in srgb, var(--muted) 22%, transparent);
  }
  .lbl {
    text-anchor: middle;
    font-size: 15px;
    font-weight: 800;
    fill: var(--muted);
  }
  .on .box {
    stroke: var(--accent);
    stroke-width: 2.5;
    fill: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .on .lbl {
    fill: var(--text);
  }
  .marker {
    fill: var(--accent-2);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .pick {
    cursor: pointer;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
</style>
