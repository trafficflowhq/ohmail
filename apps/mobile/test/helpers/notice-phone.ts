/**
 * A PHONE AS THE NOTICES' TESTS SEE IT: the native poster as a recorder, the door's facts as one record a case
 * changes one member of, and the page's bridge joined to the real native host with the act answered by the real
 * door. The platform's message channel and the native module are the only doubles.
 */
import { noticeDoor, type NoticeDoorDeps } from "../../src/notices/notice-door";
import type { NoticesNative } from "../../src/notices/notices-port";
import { BridgeHost } from "../../src/shell/bridge-host";
import { createBridge, type Bridge } from "../../web/src/bridge";
import type { PagePort } from "../../web/src/port";

/** Two pairings, by their local ids. */
export const A = "pmb3k2x9aq1z7";
export const B = "pzz9k2x9aq1z7";

/** The native poster as a recorder: every call it was asked, and what it answers. */
export function recordingNative(answer: () => boolean | Promise<boolean> = () => true) {
  const posts: unknown[][] = [];
  const lives: (string | null)[] = [];
  const native: NoticesNative = {
    post: async (...args) => { posts.push(args); return answer(); },
    setLive: async (instance) => { lives.push(instance); return answer(); },
  };
  return { native, posts, lives };
}

/** The phone as a door sees it. Each case changes one thing of a phone that draws. */
export function phone(over: Partial<NoticeDoorDeps> = {}) {
  const made = recordingNative();
  const deps: NoticeDoorDeps = {
    platform: "android", app: "ohmail", native: made.native, instance: A,
    live: () => true, permission: () => "granted", inFront: () => false, ...over,
  };
  return { ...made, deps };
}

/**
 * The page's bridge joined to the native end, the act answered by the door: the platform's channel the one double.
 * `wake` is the native end of the page's word on its wake registration, where a case gives one.
 */
export function pageOver(
  deps: NoticeDoorDeps, origin = "https://appassets.androidplatform.net", wake: (wanted: boolean) => void = () => {},
): Bridge {
  const door = noticeDoor(deps);
  const toPage = new Set<(text: string) => void>();
  const host = new BridgeHost({
    post: (_epoch, text) => queueMicrotask(() => toPage.forEach((take) => take(text))),
    config: () => null,
    http: { request: async () => ({ refused: "notReady" as const }) } as never,
    act: async (a) => {
      if (a.act === "notices.post") return door.post(a.notice);
      if (a.act === "wake.want") wake(a.wanted);
      return {};
    },
    openHeld: async () => false,
    ready: () => {},
    place: () => {},
    note: () => {},
    oldCopy: { page: async () => ({ refused: "notReady" as const }), done: async () => ({ refused: "notReady" as const }) },
    app: deps.app,
  });
  host.begin("e1");
  const port: PagePort = {
    post: (text) => host.receive({ epoch: "e1", origin, mainFrame: true, data: text }),
    listen: (take) => (toPage.add(take), () => void toPage.delete(take)),
  };
  return createBridge(port, "e1");
}

/** The act as the page sends it. */
export const post = (bridge: Bridge, notice: object) =>
  bridge.request("act", { act: "notices.post", notice } as never);
