/**
 * SIGNING OUT ENDS THE SESSION IN EVERY TAB OF THIS BROWSER. The tab that signs out, erases the
 * account or learns its session was revoked posts one message; every other tab showing that
 * account's mail drops it and leaves for the landing page (`useSignedOutElsewhere`). Per ORIGIN
 * like the jar, so the channel name carries the account (`storageOwner()`). Where there is no
 * `BroadcastChannel` a storage event carries it instead, written and removed in the same call.
 * A tab never obeys its own post: the tab signing out still has a sentence of its own to say.
 */

type Wire = { t: "signed-out"; from: string };

/** The channel name, and the transient storage key where there is no channel. */
export const SIGNED_OUT_SIGNAL = "ohmail.signed-out";

export function signedOutChannel(owner: string): string {
  return `${SIGNED_OUT_SIGNAL}.${owner}`;
}

function mintTabId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** This document's name for itself. One per page load, which is what a tab is. */
let thisTab = mintTabId();

const isWire = (m: unknown): m is Wire =>
  typeof m === "object" && m !== null && (m as Wire).t === "signed-out"
  && typeof (m as Wire).from === "string";

/** Tell every other tab of this account that the session here has ended. Never throws. */
export function postSignedOut(owner: string | null): void {
  if (owner === null || typeof window === "undefined") return;
  const message: Wire = { t: "signed-out", from: thisTab };
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const bus = new BroadcastChannel(signedOutChannel(owner));
      bus.postMessage(message);
      bus.close();
      return;
    } catch {
      /* a channel that cannot be opened falls through to the storage event */
    }
  }
  try {
    const key = signedOutChannel(owner);
    window.localStorage.setItem(key, JSON.stringify(message));
    window.localStorage.removeItem(key);
  } catch {
    /* storage refused: the tabs that missed this ask the server when they are next looked at */
  }
}

/** Hear another tab's post for `owner`. Returns the unsubscribe. */
export function listenSignedOut(owner: string, onSignal: () => void): () => void {
  const self = thisTab;
  const heard = (m: unknown): void => {
    if (isWire(m) && m.from !== self) onSignal();
  };
  let bus: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      bus = new BroadcastChannel(signedOutChannel(owner));
      bus.onmessage = (e: MessageEvent) => heard(e.data);
    } catch {
      bus = null;
    }
  }
  const key = signedOutChannel(owner);
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== key || e.newValue === null) return;
    try {
      heard(JSON.parse(e.newValue));
    } catch {
      /* not ours */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    bus?.close();
    window.removeEventListener("storage", onStorage);
  };
}

/** Where a signed-out tab goes: the landing page, replacing the entry that held the mailbox. */
let leave = (): void => {
  window.location.replace("/");
};

export function leaveSignedOutTab(): void {
  leave();
}

/** Test seams: jsdom cannot navigate, and two shells in one document are two tabs only by name. */
export function setSignedOutLeaveForTest(fn: (() => void) | null): void {
  leave = fn ?? (() => { window.location.replace("/"); });
}

export function setThisTabForTest(id: string | null): void {
  thisTab = id ?? mintTabId();
}
