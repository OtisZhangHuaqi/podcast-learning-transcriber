class PauseController {
  constructor() {
    this.requested = false;
    this.waiters = [];
  }

  request() { this.requested = true; }

  resume() {
    this.requested = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async checkpoint(onPaused, onResumed) {
    if (!this.requested) return false;
    onPaused?.();
    await new Promise((resolve) => this.waiters.push(resolve));
    onResumed?.();
    return true;
  }
}

module.exports = { PauseController };
