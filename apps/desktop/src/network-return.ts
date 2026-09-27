/**
 * THE NETWORK CAME BACK, AND THE ENGINE HEARS IT. The local engine re-dials a dead connection on
 * a widening ladder (up to five minutes), so after an outage the mailbox stayed "unreachable"
 * for minutes with the network already back. The webview's own `online` event is the operating
 * system's network monitor on every desktop — WebView2 on Windows, WKWebView on macOS,
 * WebKitGTK on Linux — and this relays it to the engine's retry door, which drops the wait.
 * Door-free: the bridge binding is handed in, so nothing here keeps a door alive by importing it.
 */

/** The local engine's retry door (`apps/sidecar/src/engine.ts`). It exists on no other door. */
export const NETWORK_RETURN_PATH = "/local/mailboxes/connections/retry";

export interface NetworkReturnRelay {
  /** Where the `online` event is heard — the window. */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Whether this window's engine is the local door; the cloud door has no such route. */
  isLocalDoor: () => Promise<boolean>;
  /** The bridge's request, which adds the launch bearer. */
  post: (path: string, init: { method: "POST" }) => Promise<unknown>;
}

/** Arm the relay; the returned function disarms it. A refused or failed post is dropped. */
export function startNetworkReturnRelay(relay: NetworkReturnRelay): () => void {
  const onOnline = (): void => {
    void (async () => {
      try {
        if (!(await relay.isLocalDoor())) return;
        await relay.post(NETWORK_RETURN_PATH, { method: "POST" });
      } catch {
        /* the next poll re-dials on its own ladder; the relay only shortens the wait */
      }
    })();
  };
  relay.target.addEventListener("online", onOnline);
  return () => relay.target.removeEventListener("online", onOnline);
}
