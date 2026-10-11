// Tiny history-based router.

class Router {
  path = $state(location.pathname);
  query = $state(new URLSearchParams(location.search));

  constructor() {
    window.addEventListener('popstate', () => this.sync());
  }

  private sync() {
    this.path = location.pathname;
    this.query = new URLSearchParams(location.search);
  }

  go(to: string, replace = false) {
    if (to === location.pathname + location.search) return;
    if (replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    this.sync();
  }

  back(fallback = '/') {
    if (history.length > 1 && history.state !== null) history.back();
    else this.go(fallback, true);
  }

  /** Use as onclick on <a href="/…"> for in-app links. */
  link = (e: MouseEvent) => {
    const a = e.currentTarget as HTMLAnchorElement;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    const url = new URL(a.href);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    this.go(url.pathname + url.search);
  };
}

export const router = new Router();
