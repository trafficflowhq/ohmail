/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/react";
import { enterSearchRoute, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * the search empty state offers the address door when its two scopes apply.
 *
 * There is no typed operator in the pipeline (the tokenizer splits on non-alphanumerics and
 * parses no prefix), so the only address scopes that exist live behind `#/address/<addr>`:
 * everything the address sent, or anything from or to it. The empty state is the moment a
 * person searching an address needs that door, and the offer is a LINK whose sentence names
 * both scopes — for an address-shaped query only, because anywhere else it would be noise.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "ohmail/News",
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

async function engineWith(rows: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({
    adapter: baseAdapter({
      /* The store answers as a real one: the rows whose sender or words match. */
      searchServer: async (q: string) => {
        const hit = rows.filter((m) => `${m.subject} ${m.from.address}`.toLowerCase().includes(q.toLowerCase()));
        return { items: hit, total: hit.length, tier: "exact" as const };
      },
    } as unknown as Partial<EngineAdapter>),
    store,
    now: () => NOW,
  });
}

let host: HTMLDivElement;
let root: Root;
let leaveSearch: () => void;

beforeEach(() => {
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
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => { root.render(<RegisteredSearch engine={engine} now={NOW} />); });
  await act(async () => { typeSearch(host, query); });
}

/** Past the 250 ms archive debounce, plus the microtasks its promise resolves through. */
async function settleArchive(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
}

const CORPUS = [msg("studio", "Notes from the studio", "ben@lichtgrat.example")];

const door = () => within(host).queryByRole("button", { name: "Everything from and to them" });

describe("the empty state's address door", () => {
  it("offers the address door for an address-shaped query, naming both scopes", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "hallo@quarzwerk.zzz");
    await settleArchive();

    const a = door();
    expect(a).not.toBeNull();
    expect(host.textContent).toContain(
      "An address is its own search — everything hallo@quarzwerk.zzz sent, or anything from or to them.",
    );
    await act(async () => { fireEvent.click(a!); });
    expect(window.location.hash).toBe(`#/address/${encodeURIComponent("hallo@quarzwerk.zzz")}`);
  });

  it("stays silent on a non-address empty query", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "quarzwerk");
    await settleArchive();

    // The empty state itself is up — only the door is withheld.
    const result = within(host).getByText(/^nothing matched · [1-9]\d* ms$/);
    expect(result.parentElement?.textContent).toBe(`Searched your whole mailbox — ${result.textContent}`);
    expect(door()).toBeNull();
  });

  it("stays out of a query that has results", async () => {
    const engine = await engineWith(CORPUS);
    await render(engine, "ben@lichtgrat.example");
    await settleArchive();

    expect(within(host).getAllByRole("button", { name: /Notes from the studio/ }).length).toBeGreaterThan(0);
    expect(door()).toBeNull();
  });
});
