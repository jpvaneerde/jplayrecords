<script lang="ts">
  // On-screen keyboard for the kiosk (no physical keyboard; Chromium's own one isn't available under cage).
  let { value = $bindable(''), ondone }: { value?: string; ondone?: () => void } = $props();

  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', 'å'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '-', "'", '&'],
  ];

  function press(k: string) {
    value += k;
  }
  function back() {
    value = value.slice(0, -1);
  }
  // Hold backspace to keep deleting.
  let hold: ReturnType<typeof setTimeout> | undefined;
  function holdStart() {
    back();
    hold = setTimeout(function rep() {
      back();
      hold = setTimeout(rep, 70);
    }, 450);
  }
  function holdEnd() {
    clearTimeout(hold);
  }
</script>

<div class="kb" role="group" aria-label="Keyboard">
  {#each rows as row, r (r)}
    <div class="row">
      {#each row as k (k)}
        <button class="key" onpointerdown={(e) => { e.preventDefault(); press(k); }}>{k}</button>
      {/each}
      {#if r === 3}
        <button class="key wide" aria-label="Backspace" onpointerdown={(e) => { e.preventDefault(); holdStart(); }} onpointerup={holdEnd} onpointerleave={holdEnd} onpointercancel={holdEnd}>⌫</button>
      {/if}
    </div>
  {/each}
  <div class="row">
    <button class="key wide muted" onpointerdown={(e) => { e.preventDefault(); value = ''; }}>Clear</button>
    <button class="key space" onpointerdown={(e) => { e.preventDefault(); press(' '); }} aria-label="Space">space</button>
    <button class="key wide done" onpointerdown={(e) => { e.preventDefault(); ondone?.(); }}>Done</button>
  </div>
</div>

<style>
  .kb {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--bg-2);
    border-top: 1px solid var(--line);
    box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.35);
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .key {
    flex: 1 1 0;
    max-width: 92px;
    height: clamp(48px, 7.2vh, 64px);
    border-radius: 10px;
    background: var(--card-hover);
    border: 1px solid var(--line);
    font-size: 1.35rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .key:active {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .key.wide {
    flex: 1.6 1 0;
    max-width: 150px;
    font-size: 1.05rem;
    text-transform: none;
  }
  .key.space {
    flex: 6 1 0;
    max-width: 560px;
    font-size: 1rem;
    text-transform: none;
    color: var(--muted);
  }
  .key.done {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: transparent;
  }
</style>
