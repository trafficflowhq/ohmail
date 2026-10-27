/**
 * ONE LIVE WIZARD PER BROWSER. The page that confirms an address used to open /join whatever else was
 * open, so a tab still on "Check your email" and the confirming tab could both walk the setup — and each
 * recovery-code set one of them made deleted the other's. Now the confirming page OFFERS the setup, a
 * waiting tab CLAIMS it, and the page GRANTS one claim inside its window or continues the setup itself.
 * The page alone decides and decides once, so a claim that arrives late is never granted; a waiting tab
 * moves only on a grant that names it. The messages carry random ids and nothing about the account (the
 * tab that moves on asks the server who it is), nothing is stored, and a browser without
 * `BroadcastChannel` behaves as before: the confirming page continues.
 */

const CHANNEL = "ohmail.join.handoff";
/** How long the confirming page waits for a claim before it continues the setup itself. */
export const HANDOFF_WINDOW_MS = 1_000;

type Message =
  | { v: 1; kind: "verified"; nonce: string }
  | { v: 1; kind: "claim" | "granted"; nonce: string; tab: string };

const ID = /^[0-9a-f-]{16,64}$/;

/** A random id, or `null` where this browser has no source of randomness to make one. */
function newId(): string | null {
  const c = globalThis.crypto;
  try {
    if (typeof c?.randomUUID === "function") return c.randomUUID();
    if (typeof c?.getRandomValues === "function") {
      return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch { /* no id, no handoff */ }
  return null;
}

function open(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

/** Post, or `false` where the channel refused it. */
function say(ch: BroadcastChannel, m: Message): boolean {
  try {
    ch.postMessage(m);
    return true;
  } catch {
    return false;
  }
}

/** Exactly the three shapes, or nothing: any other field, kind or id is ignored. */
function read(data: unknown): Message | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(",");
  if (m.v !== 1 || typeof m.nonce !== "string" || !ID.test(m.nonce)) return null;
  if (m.kind === "verified" && keys === "kind,nonce,v") return { v: 1, kind: "verified", nonce: m.nonce };
  if ((m.kind === "claim" || m.kind === "granted") && keys === "kind,nonce,tab,v"
    && typeof m.tab === "string" && ID.test(m.tab)) {
    return { v: 1, kind: m.kind, nonce: m.nonce, tab: m.tab };
  }
  return null;
}

/**
 * The confirming page, once the server answered `enrollment`: `true` when a waiting tab took the setup
 * over (this page then opens nothing), `false` when this page continues it. `signal` ends the offer
 * unanswered, as when the page goes away.
 */
export function offerHandoff(signal?: AbortSignal): Promise<boolean> {
  const nonce = newId();
  if (nonce === null || signal?.aborted) return Promise.resolve(false);
  const ch = open();
  if (ch === null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let decided = false;
    const decide = (granted: boolean): void => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      ch.close();
      resolve(granted);
    };
    const stop = (): void => decide(false);
    const timer = setTimeout(stop, HANDOFF_WINDOW_MS);
    signal?.addEventListener("abort", stop);
    ch.onmessage = (e: MessageEvent) => {
      const m = read(e.data);
      if (decided || m === null || m.kind !== "claim" || m.nonce !== nonce) return;
      // A grant that could not be sent moves nobody: this page continues.
      decide(say(ch, { v: 1, kind: "granted", nonce, tab: m.tab }));
    };
    if (!say(ch, { v: 1, kind: "verified", nonce })) stop();
  });
}

/**
 * A tab waiting on "Check your email": it claims every offer it hears, and `onGranted` runs once, on the
 * first grant that names this tab for one of its claims. Returns the stop, which closes the channel.
 */
export function awaitHandoff(onGranted: () => void): () => void {
  const tab = newId();
  if (tab === null) return () => {};
  const ch = open();
  if (ch === null) return () => {};
  const claimed = new Set<string>();
  let over = false;
  const stop = (): void => {
    if (over) return;
    over = true;
    ch.close();
  };
  ch.onmessage = (e: MessageEvent) => {
    const m = read(e.data);
    if (over || m === null) return;
    if (m.kind === "verified") {
      if (say(ch, { v: 1, kind: "claim", nonce: m.nonce, tab })) claimed.add(m.nonce);
    } else if (m.kind === "granted" && m.tab === tab && claimed.has(m.nonce)) {
      stop();
      onGranted();
    }
  };
  return stop;
}
