"use client";

import { useSyncExternalStore } from "react";

/**
 * The browser's own offline fact. `navigator.onLine === false` is the one trustworthy reading —
 * the OS reports no route out; `true` promises nothing (a captive portal reads `true`). Read
 * through a store so a consumer re-renders on the `online`/`offline` events rather than polling,
 * and `true` on the server, where the question has no subject.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
