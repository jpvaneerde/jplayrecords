// Notices when nobody has touched the screen for a while.

class Idle {
  idle = $state(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seconds = 0;
  private onIdle: () => void = () => {};

  start(seconds: number, onIdle: () => void) {
    this.seconds = seconds;
    this.onIdle = onIdle;
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, this.poke, { passive: true, capture: true });
    }
    this.poke();
  }

  poke = () => {
    this.idle = false;
    clearTimeout(this.timer);
    if (this.seconds > 0) {
      this.timer = setTimeout(() => {
        this.idle = true;
        this.onIdle();
      }, this.seconds * 1000);
    }
  };
}

export const idle = new Idle();
