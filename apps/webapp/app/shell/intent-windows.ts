"use client";

/**
 * WHO OWNS AN OPEN UNDO WINDOW — one tab, asked before another replays it.
 *
 * The journal is per ORIGIN, so a second tab's boot read finds a decision the FIRST tab is still
 * counting down and commits it: the mail is filed, the sender unsubscribed, and the first tab's
 * Undo then reports "Undone — 1 waiting again." over an act that has happened. Measured in jsdom
 * with two mounts over one jar.
 *
 * So a tab that opens a window says so, and a tab about to replay ASKS first — a claim broadcast
 * after the fact cannot reach a tab that was not yet open. Ownership expires with the window
 * itself (the caller passes its own length), which is what keeps a tab that died mid-window from
 * withholding a decision for ever.
 */

/** One open window: the row it holds, and the press it was opened by. */
export interface OpenWindow {
  id: string;
  /** Epoch ms at the press — the same stamp the journal entry carries. */
  at: number;
}

type Wire =
  | { t: "who" }
  | { t: "open"; rows: OpenWindow[] }
  | { t: "closed"; ids: string[] };

export interface IntentWindows {
  /** Answer "who owns an open window" out of this tab's own state. */
  serve(open: () => OpenWindow[]): void;
  /** This tab has opened windows over these rows. */
  claim(rows: OpenWindow[]): void;
  /** They are resolved — committed, or taken back. */
  release(ids: string[]): void;
  /** Ask, and settle once the other tabs have had their moment to answer. */
  ask(): Promise<void>;
  /** Rows another tab still holds open, by this clock and this window length. */
  elsewhere(nowMs: number, windowMs: number): ReadonlySet<string>;
  /**
   * Rows another tab has RESOLVED. A replay must skip them for ever, not merely while the window
   * stands: committed means that tab's outbox holds the verb, taken back means the reader
   * reversed it, and replaying either would act twice on one press.
   */
  resolved(): ReadonlySet<string>;
  close(): void;
}

/** How long a replay waits for the other tabs to answer. */
export const INTENT_ASK_MS = 150;

const CHANNEL = "ohmail.intent-windows";

/**
 * ONE COORDINATOR PER SURFACE, created by the hook rather than held in module scope.
 *
 * A `BroadcastChannel` does not deliver to the channel object that posted, so a module singleton
 * would make two mounts in one document silently deaf to each other — which is exactly the pair a
 * test has to drive. One per hook instance is also what a tab is.
 */
export function createIntentWindows(opts: {
  onChange?: () => void;
  askMs?: number;
  channel?: string;
} = {}): IntentWindows {
  const askMs = opts.askMs ?? INTENT_ASK_MS;
  const open = new Map<string, number>();
  const done = new Set<string>();
  let mine: () => OpenWindow[] = () => [];
  let closed = false;

  const bus: BroadcastChannel | null =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(opts.channel ?? CHANNEL);

  const post = (m: Wire): void => { if (bus && !closed) bus.postMessage(m); };
  const changed = (): void => { opts.onChange?.(); };

  if (bus) {
    bus.onmessage = (e: MessageEvent) => {
      const m = e.data as Wire | null;
      if (m === null || typeof m !== "object") return;
      if (m.t === "who") {
        const rows = mine();
        if (rows.length > 0) post({ t: "open", rows });
        return;
      }
      if (m.t === "open") {
        for (const r of m.rows) {
          if (typeof r?.id === "string" && typeof r.at === "number" && !done.has(r.id)) {
            open.set(r.id, r.at);
          }
        }
        changed();
        return;
      }
      if (m.t === "closed") {
        for (const id of m.ids) {
          if (typeof id !== "string") continue;
          open.delete(id);
          done.add(id);
        }
        changed();
      }
    };
  }

  return {
    serve(get) { mine = get; },
    claim(rows) { if (rows.length > 0) post({ t: "open", rows }); },
    release(ids) { if (ids.length > 0) post({ t: "closed", ids }); },
    async ask() {
      post({ t: "who" });
      // A NO-OP WAIT WHERE THERE IS NO BUS. A surface with one window (the desktop) has nobody to
      // ask, and paying the delay there would postpone every boot replay for nothing.
      if (!bus) return;
      /* THE LENGTH OF THIS WAIT IS NOT UNDER TEST, and it is labelled rather than counted as
         coverage. In a browser an answer is delivered as a TASK while a promise with no timer
         settles as a microtask, so a caller that treated `ask()` as instant would read an empty
         answer — but jsdom delivers sooner than that, and removing this line reddened nothing in
         four orderings. What IS covered is the exchange itself and the gate that waits for it
         (`screener-state.ts`), each watched failing. */
      await new Promise<void>((resolve) => { setTimeout(resolve, askMs); });
    },
    elsewhere(nowMs, windowMs) {
      const live = new Set<string>();
      for (const [id, at] of open) if (nowMs - at <= windowMs) live.add(id);
      return live;
    },
    resolved() { return done; },
    close() {
      closed = true;
      if (bus) { bus.onmessage = null; bus.close(); }
    },
  };
}
