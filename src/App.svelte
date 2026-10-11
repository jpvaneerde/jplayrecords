<script lang="ts">
  import { onMount } from 'svelte';
  import { browse } from './lib/browse.svelte';
  import { idle } from './lib/idle.svelte';
  import { router } from './lib/router.svelte';
  import { session } from './lib/session.svelte';
  import Screensaver from './lib/ui/Screensaver.svelte';
  import Browse from './pages/Browse.svelte';
  import Record from './pages/Record.svelte';
  import Settings from './pages/Settings.svelte';
  import Welcome from './pages/Welcome.svelte';

  let saver = $state(false);

  onMount(async () => {
    await session.load();
    // Drop ?kiosk=1 / ?link=… from the address once read.
    if (router.query.has('kiosk')) router.go(router.path, true);
    if (session.kiosk && session.role) {
      idle.start(session.display.idleSeconds, async () => {
        // Nobody here: back to the start, fresh settings, cover wall.
        if (router.path !== '/settings') {
          browse.clear();
          router.go('/', true);
        }
        await session.load();
        if (session.display.screensaver && router.path !== '/settings') saver = true;
      });
    }
  });

  const recordId = $derived(/^\/r\/(\d+)$/.exec(router.path)?.[1]);
</script>

{#if !session.loaded}
  <div class="boot"></div>
{:else if !session.role}
  <Welcome />
{:else if router.path === '/settings'}
  {#if session.isAdmin}
    <Settings />
  {:else}
    <Welcome />
  {/if}
{:else}
  <Browse />
  {#if recordId}
    {#key recordId}
      <Record id={Number(recordId)} />
    {/key}
  {/if}
{/if}

{#if saver}
  <Screensaver total={browse.facets?.total ?? 0} onwake={() => (saver = false)} />
{/if}

<style>
  .boot {
    height: 100dvh;
  }
</style>
