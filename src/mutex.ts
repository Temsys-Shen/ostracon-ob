class Mutex {
  private locks = new Map<string, Promise<void>>();

  async acquire(key: string, timeoutMs = 30000): Promise<() => void> {
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.locks.get(key) || Promise.resolve();

    const timer = window.setTimeout(() => {
      this.locks.delete(key);
      throw new Error(`Mutex timeout: ${key}`);
    }, timeoutMs);

    this.locks.set(key, next);
    await prev;
    window.clearTimeout(timer);

    const _release = release!;
    return () => { _release(); };
  }
}

export { Mutex };
