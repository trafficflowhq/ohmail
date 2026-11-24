/**
 * The browser says it has no network, so a request made now cannot leave this device. Only a
 * browser's own word: where there is no word (a phone's engine, a test), nothing is known.
 */
export const knownOffline = (): boolean =>
  (globalThis as { navigator?: { onLine?: unknown } }).navigator?.onLine === false;
