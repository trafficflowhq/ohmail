/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { mailMount, type Shell } from "../src/doors.js";

/**
 * THE MAIL ON SCREEN IS THE MAILBOX'S — driven, not described.
 *
 * `desktop-shell.test.ts` asserts what the declarations say and `desktop-doors.test.ts` asserts
 * what happens when somebody fills the door form in. This file asserts the thing between them:
 * given an engine that is serving, does the window actually run the client against it?
 *
 * ── WHY IT MOUNTS THE REAL COMPONENT RATHER THAN CHECKING THE DECISION ALONE ─────────────────
 *
 * {@link mailMount} is a pure function and its table is checked below, which is worth having and
 * is not enough on its own: the decision could be right and the wiring wrong, and the wiring is
 * one prop. A window that mounted the sample mailbox over a real one would look completely normal
 * — a rail, a list, mail in it — and would be showing somebody else's invented correspondence to
 * a person who came to read their own.
 *
 * So the assertion is about REQUESTS. The sample mailbox issues none, ever; a real client's first
 * act is to drain the mail. Counting what crossed the bridge therefore separates the two with no
 * reference to what either one draws, and it goes red for the mutation that matters — flip the
 * mount back to the sample world and the bridge sees nothing at all.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: (cb: unknown, once?: boolean) => number };
}

const host = globalThis as unknown as Host;

const SERVING: EngineStatus = {
  state: "serving",
  mode: "local",
  address: "someone@example.test",
  mailboxId: "mbx-1",
  credentialState: "ready",
};

/** One `engine_request` answer, framed exactly as the shell frames one. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/** An empty, settled mailbox: one page of no changes, and the drain is done. */
const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});

/**
 * An empty, settled SNAPSHOT: the cold-start read, with nothing in it.
 *
 * `asOfSeq: 0` is the honest answer for a mailbox with no change log yet, and the client commits
 * `"0"` from it — so a snapshot that answers this is indistinguishable, in cursor terms, from the
 * `since=0` bootstrap it replaces. Which of the two was TAKEN is the thing under test, and that is
 * read off the recorded URLs rather than off the mirror.
 */
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0,
  changes: [],
  nextCursor: null,
  window: { days: 90, minRows: 500 },
});

/**
 * `GET /mailboxes`, as the engine answers it — one connected mailbox that has finished its first
 * import. The window reads this to decide what its sync line is entitled to say.
 */
const MAILBOX_LIST = JSON.stringify({
  items: [{
    id: "mbx-1",
    address: "someone@example.test",
    status: "connected",
    errorCode: null,
    disabledReason: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt: "2026-01-01T00:00:00.000Z",
    initialImportCompletedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2025-12-01T00:00:00.000Z",
  }],
});

/**
 * A shell that reports one serving mailbox and records every URL the bridge is asked for.
 *
 * `null` for `status` is the case the render check and a development server are in: the runtime's
 * command channel is not there at all, so the window has no shell to ask.
 */
function shell(status: EngineStatus | null): string[] {
  return shellWithMenu(status).urls;
}

/**
 * The same fake, plus the half the menu needs: a callback registry, so a test can deliver a menu
 * event the way the runtime does and watch what the window does with it.
 */
function shellWithMenu(status: EngineStatus | null): {
  urls: string[];
  emit(event: string, payload: unknown): void;
} {
  const urls: string[] = [];
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, number>();
  let next = 1;
  if (status === null) {
    delete host.__TAURI_INTERNALS__;
    return { urls, emit: () => undefined };
  }
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => {
      const id = next++;
      callbacks.set(id, cb as (payload: unknown) => void);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "plugin:event|listen") {
        listeners.set(String(payload?.event ?? ""), payload?.handler as number);
        return null;
      }
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        urls.push(url);
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, MAILBOX_LIST);
        return encode(200, EMPTY_PAGE);
      }
      // `set_badge` and `notify` — granted, and nothing to answer with.
      return null;
    },
  };
  return {
    urls,
    emit(event, payload) {
      const handler = listeners.get(event);
      if (handler === undefined) throw new Error(`nothing is listening for ${event}`);
      callbacks.get(handler)!({ event, id: 1, payload });
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  // The status call, the engine's first drain and the effects that follow all settle on the
  // microtask queue and a timer turn or two. Waiting on a fixed number of turns rather than on a
  // condition keeps a failure a failure instead of a hang.
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return mountPoint;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
});

describe("mailMount — which mail the window shows", () => {
  const status = (over: Partial<EngineStatus>): Shell => ({
    kind: "status",
    status: { ...SERVING, ...over },
  });

  it("runs the real client against a serving engine, named after the mailbox", () => {
    expect(mailMount(status({}), null)).toEqual({ kind: "engine", key: "mbx-1" });
  });

  it("shows the sample mailbox only when there is no shell to ask", () => {
    expect(mailMount({ kind: "none" }, null)).toEqual({ kind: "sample" });
    // …and never once a shell has answered, whatever it answered.
    for (const state of ["serving", "starting", "stopped", "failed", "not_configured"] as const) {
      expect(mailMount(status({ state }), null).kind).not.toBe("sample");
      expect(mailMount(status({ state }), "mbx-1").kind).not.toBe("sample");
    }
  });

  it("keeps the client mounted while the engine behind it restarts", () => {
    for (const state of ["starting", "restarting", "stopped"] as const) {
      expect(mailMount(status({ state }), "mbx-1")).toEqual({ kind: "engine", key: "mbx-1" });
      // Nothing on screen yet ⇒ nothing to keep, and no guess is made.
      expect(mailMount(status({ state }), null)).toEqual({ kind: "opening" });
    }
  });

  it("takes the mail off the screen when the install stops having a mailbox", () => {
    // A sign-out, a build with no engine, a keystore that will not answer, an engine that died.
    // Every one of them means the client on screen is showing mail this install no longer has a
    // door to — so the previous mount is NOT carried over, even though one exists.
    for (const state of ["not_configured", "absent", "no_key", "failed"] as const) {
      expect(mailMount(status({ state }), "mbx-1")).toEqual({ kind: "opening" });
    }
    expect(mailMount({ kind: "unreachable", reason: "no answer" }, "mbx-1")).toEqual({ kind: "opening" });
  });

  it("switches clients when the mailbox does", () => {
    expect(mailMount(status({ mailboxId: "mbx-2" }), "mbx-1")).toEqual({ kind: "engine", key: "mbx-2" });
  });

  it("waits rather than name a client after a mailbox the engine has not announced", () => {
    const { mailboxId: _drop, ...rest } = SERVING;
    expect(mailMount({ kind: "status", status: rest }, null)).toEqual({ kind: "opening" });
  });
});

describe("the window against a serving engine", () => {
  it("drains the mailbox over the bridge", async () => {
    const urls = shell(SERVING);
    await render();
    // THE ASSERTION THE FILE EXISTS FOR. The sample mailbox issues no requests at all, so one
    // `/sync` here is proof the client is running against the engine on this machine.
    expect(urls.filter((u) => u.startsWith("/sync"))).not.toHaveLength(0);
  });

  /**
   * THE COLD START TAKES THE SNAPSHOT, WHICH IS WHAT PUTS THE NEWEST MAIL ON SCREEN FIRST.
   *
   * This used to assert the opposite, and correctly: the capability was withheld on this
   * transport because the hosted door forwarded `GET /sync/snapshot` to the account and answered
   * with a cursor counted in a sequence the next `/sync` knows nothing about. Both doors now
   * answer the route from the database their deltas come from, so the withholding is gone and the
   * bootstrap is the newest-first one every other client takes.
   *
   * Asserted on the ORDER, not merely on the presence: a snapshot that ran after a `since=0`
   * replay would be a second bootstrap rather than a faster one, and the whole benefit — the
   * first paint being the mail somebody opened the app to read — depends on it going first.
   */
  it("bootstraps from the snapshot, newest first, rather than replaying the log", async () => {
    const urls = shell(SERVING);
    await render();
    const snapshotAt = urls.findIndex((u) => u.startsWith("/sync/snapshot"));
    expect(snapshotAt, "the cold-start read was never asked for").toBeGreaterThanOrEqual(0);
    const replayAt = urls.findIndex((u) => u.startsWith("/sync?since=0"));
    if (replayAt >= 0) expect(snapshotAt).toBeLessThan(replayAt);
  });

  /**
   * THE SYNC LINE'S FIRST QUESTION, ASKED AT LAST.
   *
   * The shared shell decides what to say about a sync from a ladder whose first step is "can we see
   * this account's mailboxes?", and its honest answer to "no" is to say nothing at all. This window
   * used to supply no way to ask, so the answer was permanently "no" and a first sync ran to
   * completion in silence — no progress, no counts, nothing between the door chooser and a full
   * mailbox. Both doors serve this read out of the database on this machine, so the only thing that
   * was missing was the asking.
   */
  it("asks which mailbox it opens, so the sync line has something to say", async () => {
    const urls = shell(SERVING);
    await render();
    expect(urls.some((u) => u.startsWith("/mailboxes"))).toBe(true);
  });

  /**
   * ⌘N REACHES THE CLIENT, which is the half a unit test of the parser cannot show.
   *
   * The menu emits a command id and this window maps it onto something the client already does.
   * Between those two there is a switch, and a switch that names a route the client does not have
   * fails exactly like a menu item that was never wired: silently. So the assertion is made on the
   * screen, after the event, rather than on the mapping.
   */
  it("opens the compose view when the menu asks for a new message", async () => {
    const shell = shellWithMenu(SERVING);
    const el = await render();
    try {
      await act(async () => {
        shell.emit("menu:command", "compose");
        // `go` writes the location hash and the shell routes off `hashchange`, which is a TASK
        // rather than a microtask — so the render that answers it is one turn of the loop away.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(el.textContent ?? "").toMatch(/Kept in this browser until you send it/i);
    } finally {
      // The hash is per-document and this file renders more than once into it.
      window.location.hash = "";
    }
  });

  it("says nothing about invented mail while it is showing somebody's own", async () => {
    shell(SERVING);
    const el = await render();
    const text = el.textContent ?? "";
    expect(text).not.toMatch(/invented mail/i);
    expect(text).not.toMatch(/nothing leaves this tab/i);
  });

  it("shows the sample mailbox, and touches no bridge, when there is no shell", async () => {
    const urls = shell(null);
    const el = await render();
    expect(urls).toEqual([]);
    expect(el.textContent ?? "").toMatch(/invented mail/i);
  });
});
