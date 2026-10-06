/**
 * THE PAIRED PAGE'S ENGINE — the one composition `HostGate` mounts, here so it can be driven.
 * The shared `HttpAdapter` in bearer mode over the manager's fetch (root-relative, no cookie),
 * the desktop's window, the mirror in memory and the queued changes in this browser
 * (`outbox-store.ts`). Nothing stands between this page and its host but the wire, so a dropped
 * request is the host out of reach and a change waiting on it a day is shown as unsaved.
 */
import { HttpAdapter, OhmailEngine } from "@ohmail/client-engine";
/* A type-only leaf (see `store-windows.ts`'s header): importing the constant costs this bundle
   nothing and cannot convey the engine door the host-client scan refuses. */
import { DESKTOP_WINDOW } from "../../../webapp/app/shell/store-windows.js";
import type { BearerManager } from "./bearer.js";
import { HostOutboxStore } from "./outbox-store.js";

export interface HostClientEngineOptions {
  /** The pairing this engine serves — `BearerManager.pairScope()` when it was built. */
  scope: string | null;
  /** Where the queued changes are kept: the browser's own IndexedDB; injectable for tests. */
  factory?: IDBFactory | null;
  /** This browser will not keep them — the gate says so once. */
  onUnkept?: () => void;
}

let saidNoWebLocks = false;
/** A browser without Web Locks gives no waiting send an owner: every tab replays it. Said once. */
function sayNoWebLocks(): void {
  const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks;
  if (saidNoWebLocks || typeof locks?.request === "function") return;
  saidNoWebLocks = true;
  console.warn("ohmail: outbox_owner_absent — no Web Locks here, so every tab replays every waiting send");
}

export function createHostClientEngine(
  bearer: BearerManager,
  opts: HostClientEngineOptions,
): OhmailEngine {
  if (opts.scope !== null) sayNoWebLocks();
  return new OhmailEngine({
    adapter: new HttpAdapter({
      baseUrl: "",
      headers: () => bearer.headers(),
      fetch: bearer.fetch,
    }),
    store: new HostOutboxStore({
      scope: opts.scope,
      live: () => opts.scope !== null && bearer.pairScope() === opts.scope,
      ...(opts.factory !== undefined ? { factory: opts.factory } : {}),
      ...(opts.onUnkept ? { onUnkept: opts.onUnkept } : {}),
    }),
    storePolicy: DESKTOP_WINDOW,
    outboxTransportIsUnreachable: true,
    // A desktop host without the Cancel route, said once per send.
    onWithdrawUnsupported: () => console.warn("ohmail: send_withdraw_unsupported — this server has no Cancel route"),
  });
}
