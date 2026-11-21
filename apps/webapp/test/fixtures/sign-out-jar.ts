/** A minimal Web Locks manager: exclusive, FIFO, and an abort of the WAIT honoured. */
export function installSessionLocks(): void {
  const queues = new Map<string, Array<() => void>>();
  const busy = new Set<string>();
  const request = async (name: string, opts: { signal?: AbortSignal }, fn: () => Promise<unknown>): Promise<unknown> => {
    if (busy.has(name)) {
      await new Promise<void>((resolve, reject) => {
        const waiter = (): void => resolve();
        const queue = queues.get(name) ?? [];
        queue.push(waiter);
        queues.set(name, queue);
        opts.signal?.addEventListener("abort", () => {
          const q = queues.get(name) ?? [];
          const at = q.indexOf(waiter);
          if (at >= 0) q.splice(at, 1);
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      });
    }
    busy.add(name);
    try {
      return await fn();
    } finally {
      busy.delete(name);
      (queues.get(name) ?? []).shift()?.();
    }
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
}

export function markPendingSignOut(account: string) {
  const family = "fixture-family";
  document.cookie = `tf_family=${family}; Path=/`;
  document.cookie = "tf_owner=signed_out_pending; Path=/";
  localStorage.setItem("ohmail.session.pendingSignOut", JSON.stringify({
    press: "fixture-press", account, family,
  }));
}

export function clearSignOutJar() {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_family=; Path=/; Max-Age=0";
}
