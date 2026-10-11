import { api, type Display } from './api';

const DEFAULT_DISPLAY: Display = { idleSeconds: 180, screensaver: true, keyboard: 'auto', tile: 'm', theme: 'dark' };

function kioskFlag(): boolean {
  // ?kiosk=1 (the device link adds it) is remembered for this browser.
  const q = new URLSearchParams(location.search).get('kiosk');
  try {
    if (q === '1') localStorage.setItem('jplayrecords.kiosk', '1');
    if (q === '0') localStorage.removeItem('jplayrecords.kiosk');
    return localStorage.getItem('jplayrecords.kiosk') === '1';
  } catch {
    return q === '1';
  }
}

class Session {
  role = $state<'admin' | 'viewer' | null>(null);
  name = $state<string | null>(null);
  via = $state<'jplay' | 'device' | 'dev' | null>(null);
  loginUrl = $state<string | null>(null);
  display = $state<Display>(DEFAULT_DISPLAY);
  loaded = $state(false);
  /** Running on the record-room screen (touch, no physical keyboard). */
  kiosk = $state(kioskFlag());

  isAdmin = $derived(this.role === 'admin');
  /** Show the on-screen keyboard instead of relying on a real one. */
  osk = $derived(this.display.keyboard === 'always' || (this.display.keyboard === 'auto' && (this.kiosk || this.via === 'device')));

  async load() {
    try {
      const r = await api.get<{ role: Session['role']; name: string | null; via: Session['via']; loginUrl: string | null; display: Display }>('/session');
      this.role = r.role;
      this.name = r.name;
      this.via = r.via;
      this.loginUrl = r.loginUrl;
      this.display = r.display;
      if (r.via === 'device') this.kiosk = true;
      applyTheme(r.display.theme);
    } catch (e) {
      console.error(e);
    }
    document.body.classList.toggle('kiosk', this.kiosk);
    this.loaded = true;
  }
}

export function applyTheme(theme: string) {
  document.body.classList.remove('dark', 'light', 'retro');
  document.body.classList.add(theme);
  try {
    localStorage.setItem('jplayrecords.theme', theme);
  } catch {
    /* ignore */
  }
}

try {
  applyTheme(localStorage.getItem('jplayrecords.theme') || 'dark');
} catch {
  applyTheme('dark');
}

export const session = new Session();
