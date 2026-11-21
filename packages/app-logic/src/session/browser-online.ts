"use client";

import { useSyncExternalStore } from "react";

/**
 * The browser's own offline fact. `navigator.onLine === false` is the one trustworthy reading —
 * the OS reports no route out; `true` promises nothing (a captive portal reads `true`). Read
 * through a store so a consumer re-renders on the `online`/`offline` events rather than polling,
 * and `true` on the server, where the question has no subject.
 */
export function subscribeBrowserNetwork(onOnline: () => void, onOffline = onOnline): () => void {
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

/** The latest network reading, including at a press before the next subscribed render. */
export function browserOnlineNow(): boolean {
  try {
    return navigator.onLine !== false;
  } catch {
    return true;
  }
}

export function useBrowserOnline(): boolean {
  return useSyncExternalStore(subscribeBrowserNetwork, browserOnlineNow, () => true);
}
