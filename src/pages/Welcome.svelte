<script lang="ts">
  import { session } from '../lib/session.svelte';
  import Logo from '../lib/ui/Logo.svelte';
  const invalid = new URLSearchParams(location.search).get('link') === 'invalid';
</script>

<div class="welcome">
  <Logo height="3rem" />
  <div class="card box">
    {#if invalid}
      <p class="notice error">That device link doesn't work (any more). Create a new one in Settings.</p>
    {/if}
    <h1>This screen isn't linked yet</h1>
    <p class="muted">
      Sign in with your JPlay account to browse and change settings. For the record-room screen, create a device link under
      Settings → Kiosk screens and open it there once.
    </p>
    {#if session.loginUrl}
      <a class="btn primary big" href={session.loginUrl}>Sign in with JPlay</a>
      <p class="muted small">Then come back to this page.</p>
    {:else}
      <p class="notice">Sign-in isn't set up on this server (JPLAY_API).</p>
    {/if}
  </div>
</div>

<style>
  .welcome {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    padding: 20px;
  }
  .box {
    max-width: 520px;
    padding: 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: flex-start;
  }
  h1 {
    font-size: 1.7rem;
  }
  p {
    margin: 0;
  }
  .small {
    font-size: 0.85rem;
  }
</style>
