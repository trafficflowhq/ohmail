/**
 * SOMEBODY IS AT THE WINDOW, AND THE CLOUD DOOR HEARS IT. The door's poll climbs from 8 s to a minute
 * while no person's request reaches it (`apps/sidecar/src/cloud-mirror.ts`), and reading mail the
 * window already holds sends none, so new mail took up to 45 s to appear while somebody read. This
 * relays a person's input (a press, a key, a wheel or scroll, the window's focus) to the door, at most
 * once per {@link ATTENTION_SIGNAL_GAP_MS}: an empty POST over the same-machine bridge, never Cloud.
 * Door-free like `network-return.ts`: the bridge binding is handed in.
 */

/** The door's route (`apps/sidecar/src/window-report.ts`). */
export const WINDOW_ATTENTION_PATH = "/local/window/attention";

/** At most one signal per this long: half the door's 8 s step, so a reading person keeps it there. */
export const ATTENTION_SIGNAL_GAP_MS = 4_000;

/** Input a person makes on purpose; a pointer passing over the window is not one. */
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "scroll", "focus"] as const;

export interface WindowAttentionRelay {
  /** Where input is heard — the window, in the capture phase so a scroll or focus inside counts. */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Whether this window's engine is a Cloud door; the local door has no poll to reset. */
  isCloudDoor: () => Promise<boolean>;
  /** The bridge's request, which adds the launch bearer. */
  post: (path: string, init: { method: "POST" }) => Promise<unknown>;
  now?: () => number;
}

/** Arm the relay; the returned function disarms it. A refused or failed post is dropped. */
export function startWindowAttentionRelay(relay: WindowAttentionRelay): () => void {
  const now = relay.now ?? (() => performance.now());
  let lastAt = Number.NEGATIVE_INFINITY;
  const onInput = (): void => {
    const at = now();
    if (at - lastAt < ATTENTION_SIGNAL_GAP_MS) return;
    lastAt = at;
    void (async () => {
      try {
        if (!(await relay.isCloudDoor())) return;
        await relay.post(WINDOW_ATTENTION_PATH, { method: "POST" });
      } catch {
        /* the poll goes on at its own pace; the signal only shortens the wait */
      }
    })();
  };
  const opts = { capture: true, passive: true };
  for (const kind of INPUT_EVENTS) relay.target.addEventListener(kind, onInput, opts);
  return () => {
    for (const kind of INPUT_EVENTS) relay.target.removeEventListener(kind, onInput, opts);
  };
}
