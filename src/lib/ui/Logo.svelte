<script lang="ts">
  // JPlay family logo (equalizer bars + heavy wordmark) with "Records".
  let { height = '2em' }: { height?: string } = $props();
</script>

<svg viewBox="0 0 270 44" role="img" aria-label="JPlay Records" style:height>
  <g fill="var(--accent)">
    <rect x="2" y="22" width="7" height="16" rx="3.5" />
    <rect x="13" y="8" width="7" height="30" rx="3.5" />
    <rect x="24" y="15" width="7" height="23" rx="3.5" />
  </g>
  <text x="42" y="35" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="32" font-weight="800" letter-spacing="-0.5" fill="currentColor"
    >J<tspan fill="var(--accent)" dx="2">Play</tspan><tspan dx="10" font-weight="600" fill="var(--muted)">Records</tspan></text
  >
</svg>

<style>
  svg {
    display: block;
    width: auto;
    overflow: visible;
  }
</style>
