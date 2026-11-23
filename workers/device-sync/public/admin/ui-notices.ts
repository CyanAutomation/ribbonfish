export function createTransientNotice({
  duration = 5000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onExpire = () => {},
  nowFn = Date.now,
} = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = duration;
  let startedAt: number | null = null;
  let active = false;
  const schedule = () => {
    startedAt = nowFn();
    timer = setTimeoutFn(() => {
      timer = null;
      remaining = 0;
      active = false;
      onExpire();
    }, remaining);
  };
  return {
    start() {
      if (timer !== null) clearTimeoutFn(timer);
      remaining = duration;
      active = true;
      schedule();
    },
    pause() {
      if (!active || timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
      remaining = Math.max(0, remaining - Math.max(0, nowFn() - (startedAt ?? nowFn())));
    },
    resume() {
      if (!active || timer !== null) return;
      if (remaining === 0) {
        active = false;
        onExpire();
        return;
      }
      schedule();
    },
    clear() {
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      remaining = duration;
      startedAt = null;
      active = false;
    },
  };
}

export function createRetryableLoadOnce() {
  let loaded = false;
  let pending: Promise<unknown> | null = null;
  return {
    get loaded() { return loaded; },
    load<T>(loader: () => T | Promise<T>): Promise<T | undefined> {
      if (loaded) return Promise.resolve(undefined);
      if (!pending) {
        pending = Promise.resolve()
          .then(loader)
          .then((value) => {
            loaded = true;
            return value;
          })
          .finally(() => { pending = null; });
      }
      return pending as Promise<T>;
    },
  };
}
