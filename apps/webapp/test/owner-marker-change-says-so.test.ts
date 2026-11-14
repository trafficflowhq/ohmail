/** @vitest-environment jsdom */
/**
 * ═══ A WINDOW THAT LOST ITS ACCOUNT SAYS SO ══════════════════════════════════════════════
 *
 * The sync gate ADMITS an absent marker: absence at load is silence, not a contradiction. What
 * it does not admit is a marker that CHANGES under a live confirmed window — any change revokes,
 * a round trip back to the same account included.
 */

/**
 * Revocation was correct and SILENT: no pages, a mutation answered `queued` and left queued, and
 * a page that looked healthy while nothing a person pressed reached their mail server. The
 * sentence was withheld because the only one available said "sign in again", stronger than the
 * evidence. It is no longer the only one — `GET /auth/session` mints an absent marker back, so
 * the weak true sentence is also a recovery. That, and that the marker CHANGE is what produces
 * it, is what this file holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type SyncResponse } from "@ohmail/client-engine";
import {
  createSyncGate, startSyncScheduler, type SyncStatus,
} from "@ohmail/app-logic/session/sync-scheduler";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "acct_A";
const B = "acct_B";
const ISO = "2026-09-16T10:00:00.000Z";

const setMarker = (v: string | null): void => {
  document.cookie = v === null ? "tf_owner=; Path=/; Max-Age=0" : `tf_owner=${v}; Path=/`;
};

const emptyPage = (): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "c1", hasMore: false, serverTime: ISO,
});

/** The strip reads its state from the provider, so the state is supplied the way the strip's own
    suite supplies it — the subject here is the sentence, not the plumbing above it. */
const STRIP_QUIET = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null,
  asOf: null, address: null, minutes: null, slow: false, screenerCandidate: false,
  pending: 0, filing: null, settled: true,
} as const;
let stripState: Record<string, unknown> = { ...STRIP_QUIET, key: "ownerLost" };
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: stripState, refresh: () => {} }),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  setMarker(null);
  stripState = { ...STRIP_QUIET, key: "ownerLost" };
  vi.useFakeTimers();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMarker(null);
});

describe("the scheduler publishes the state instead of standing down in silence", () => {
  /** Drive a real gate, a real engine and the real loop; collect what the shell would read. */
  async function run(after: (gate: ReturnType<typeof createSyncGate>) => void): Promise<SyncStatus[]> {
    const adapter: EngineAdapter = {
      sync: async () => emptyPage(),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    };
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const gate = createSyncGate(A);
    const published: SyncStatus[] = [];
    setMarker(A);
    gate.confirm(A);
    const stop = startSyncScheduler(engine, {
      gate, report: (): void => {},
      onStatus: (s) => { published.push(s); },
    });
    await vi.advanceTimersByTimeAsync(0);
    after(gate);
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    return published;
  }

  it("a marker that GOES under a live window publishes `ownerLost`", async () => {
    // The reported sequence: confirmed for A, then the cookie is gone. Absence at LOAD is
    // silence and the gate admits it; absence as a CHANGE under a confirmed window is a
    // revocation, and the loop stops taking pages over it.
    const published = await run(() => { setMarker(null); });
    expect(published.length, "the loop published nothing at all").toBeGreaterThan(0);
    expect(published.some((s) => s.ownerLost), "the gate revoked and the shell was told nothing").toBe(true);
    // NOT the strong claim: nothing was refused and no server said anything.
    expect(published.every((s) => !s.terminal), "a marker change latched the server's own refusal").toBe(true);
  });

  it("THE CONTROL: a window whose marker never moves never claims it", async () => {
    const published = await run(() => {});
    expect(published.length).toBeGreaterThan(0);
    expect(published.some((s) => s.ownerLost), "a healthy window claimed it had lost its account").toBe(false);
  });

  it("a marker naming ANOTHER account is the contradiction, not this state", async () => {
    const published = await run(() => { setMarker(B); });
    // `contradicted` outranks it and keeps its own alert — the mirror is another account's.
    expect(published.some((s) => s.terminal), "a foreign marker no longer latches terminal").toBe(true);
  });
});

describe("the strip says it, and offers the page load that undoes it", () => {
  it("the ladder gives the state its own key, under `stopped` and `failing`", async () => {
    const { deriveMailState } = await import("@ohmail/app-logic/mail-state/mail-state");
    const base = {
      failureStreak: 3,
      mailboxes: null, mirrored: 0, pulled: 0,
      growth: { firstAt: null, firstCount: null, lastAt: null, lastCount: null },
      freshness: { state: "unknown" as const, asOf: null },
      engineFreshness: { state: "unknown" as const, asOf: null },
      now: new Date(ISO), demo: false,
    } as unknown as Parameters<typeof deriveMailState>[0];
    const sync = (over: Partial<SyncStatus>): SyncStatus => ({
      bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false, ...over,
    });

    expect(deriveMailState({ ...base, sync: sync({ ownerLost: true }) }).key).toBe("ownerLost");
    // Precedence, both directions: a server refusal outranks it, a lost marker outranks silence.
    expect(deriveMailState({ ...base, sync: sync({ ownerLost: true, terminal: true }) }).key).toBe("stopped");
    expect(deriveMailState({ ...base, sync: sync({ ownerLost: true, failures: 3 }) }).key).toBe("failing");
    expect(deriveMailState({ ...base, sync: sync({}) }).key).not.toBe("ownerLost");
  });

  it("renders the sentence and the reload, calmly — no alert, no 'sign in again'", async () => {
    const { SyncBar } = await import("../app/shell/SyncBar.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
        children: h(ThemeProvider, { storageKey: null, children: h(SyncBar as never, null) }),
      }));
    });

    const text = host.textContent ?? "";
    expect(text).toContain(messages.sync.ownerLost);
    expect(text).toContain(messages.sync.reload);
    // The recovery is a real page load: `GET /auth/session` re-mints the marker on it.
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/mailbox");
    // Not the terminal state's words, and not its interruption.
    expect(text).not.toContain(messages.sync.stopped);
    expect(text).not.toContain(messages.sync.signIn);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it("THE CONTROL: a quiet strip says none of it", async () => {
    stripState = { ...STRIP_QUIET };
    const { SyncBar } = await import("../app/shell/SyncBar.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
        children: h(ThemeProvider, { storageKey: null, children: h(SyncBar as never, null) }),
      }));
    });
    expect(host.textContent ?? "").not.toContain(messages.sync.ownerLost);
  });
});
