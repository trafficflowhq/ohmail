/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { enterSearchRoute, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { ARCHIVE_TIMEOUT_MS } from "@ohmail/app-logic/search";

/**
 * "SEARCHING THE WHOLE ARCHIVE…" HAD NO END — the failure-looks-like-healthy family, on screen.
 *
 * What was reported: a query answered "Nothing on this device. … Searching the whole archive…"
 * and that second sentence never resolved. The archive was not the problem — `search-punctuation.pg.test.ts`
 * measures the same subject matching `websearch_to_tsquery` against real Postgres, and it does.
 * The problem was that `searching` was a state only a SETTLED promise could replace: a request
 * that never settles left the sentence up for the rest of the session, and a reader has no way
 * to tell that from a slow archive.
 *
 * A searching state can no longer outlive its request. The ceiling is
 * {@link ARCHIVE_TIMEOUT_MS} and it renders a sentence that says what happened, with the retry
 * this view already offers for a refusal.
 *
 * The stub here never settles — which is the production shape of the fault, not an error: a
 * rejection was always rendered (`scopeFailed`), and this is the case that was not.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-08T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: "registry@dnb.example" },
    to: [], cc: [], date: "2026-09-01T09:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

function baseAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

async function engineWith(rows: EngineMessage[], over: Partial<EngineAdapter> = {}): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({ adapter: baseAdapter(over), store, now: () => NOW });
}

let host: HTMLDivElement;
let root: Root;
let leaveSearch: () => void;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  window.localStorage.clear();
  leaveSearch = enterSearchRoute();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  leaveSearch();
  vi.useRealTimers();
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => { root.render(<RegisteredSearch engine={engine} now={NOW} />); });
  await act(async () => { typeSearch(host, query); });
}

/** Every scope sentence on screen, joined — the line lives in `.results-head` and in `.empty`. */
const scopeText = (): string => host.textContent ?? "";

const CORPUS = [msg("duns", "Your D-U-N-S Number is enclosed.")];

/** A transport that takes the request and never answers it. */
function silentArchive(): { calls: string[]; searchServer: (q: string) => Promise<never> } {
  const calls: string[] = [];
  return {
    calls,
    searchServer: (q: string) => {
      calls.push(q);
      return new Promise<never>(() => {});
    },
  };
}

describe("the archive pass has a ceiling", () => {
  it("says the archive did not answer, instead of searching for ever", async () => {
    const archive = silentArchive();
    const engine = await engineWith(CORPUS, archive as unknown as Partial<EngineAdapter>);
    await render(engine, "D-U-N-S");

    // Past the debounce: the request is out and the sentence is the honest one for that moment.
    // The ceiling is armed when `searching` is SET, i.e. before the debounce runs, so elapsed
    // time is counted from there — a test that advanced the full ceiling AFTER the debounce
    // would be measuring 15.3 s and could not tell an early timeout from a correct one.
    const DEBOUNCE = 300;
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
    expect(archive.calls).toEqual(["D-U-N-S"]);
    expect(scopeText()).toContain("Searching your whole mailbox");

    // One millisecond short of the ceiling it is STILL searching — the ceiling is a ceiling and
    // not a shorter timeout wearing its name.
    await act(async () => { await vi.advanceTimersByTimeAsync(ARCHIVE_TIMEOUT_MS - DEBOUNCE - 1); });
    expect(scopeText()).toContain("Searching your whole mailbox");

    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(scopeText()).toContain("Your server did not answer");
    expect(scopeText()).not.toContain("Searching your whole mailbox");
    // And the retry this view already offers for a refusal is on screen for this state too:
    // a stated dead end with no way out of it is half a sentence.
    const retry = within(host).getByRole("button", { name: "Search again" });
    expect(retry).toBeTruthy();
  });

  it("an archive that answers within the ceiling is never called out", async () => {
    // The positive control. A guard whose only case is the refusal has no evidence it admits
    // the ordinary answer — and this one would fire on every fast search if the timer were not
    // cleared when the promise settles.
    const engine = await engineWith(CORPUS, {
      searchServer: async () => ({ items: [], total: 0, tier: "exact" as const }),
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "D-U-N-S");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(scopeText()).toContain("Searched your whole mailbox");

    // Well past the ceiling: the settled answer stands, and no timeout sentence appears.
    await act(async () => { await vi.advanceTimersByTimeAsync(ARCHIVE_TIMEOUT_MS * 2); });
    expect(scopeText()).toContain("Searched your whole mailbox");
    expect(scopeText()).not.toContain("Your server did not answer");
  });

  it("a LATE answer replaces the timeout — the sentence is about this request, not the session", async () => {
    let settle: ((v: { items: EngineMessage[]; total: number; tier: "exact" }) => void) | null = null;
    const engine = await engineWith(CORPUS, {
      searchServer: () => new Promise((res) => { settle = res as typeof settle; }),
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "D-U-N-S");
    await act(async () => { await vi.advanceTimersByTimeAsync(300 + ARCHIVE_TIMEOUT_MS + 1); });
    expect(scopeText()).toContain("Your server did not answer");

    await act(async () => { settle!({ items: [], total: 0, tier: "exact" }); });
    expect(scopeText()).toContain("Searched your whole mailbox");
    expect(scopeText()).not.toContain("Your server did not answer");
  });
});
