/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextProvider } from "@ohmail/app/text";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import {
  MemoryMirrorStore, OhmailEngine, consentPartition, presentationReader,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * THE BUY LIST MAY ONLY NAME SENDERS THE ENDPOINT CAN ANSWER FOR.
 *
 * The Screener's queue is built from the PROJECTED mirror, so it holds rows for senders whose
 * mail is physically in the INBOX — the cutline presents an active undecided sender at the gate
 * because a decision about them is genuinely wanted. Those rows are minted on an INBOX
 * representative and marked `gatePhysical:false` (#116), and their DECISION works: the commit
 * path re-reads the raw mirror and routes them past the gate as a rule with `applyRetro`.
 *
 * `POST /screener/suggest` cannot be routed past anything. It resolves senders through
 * `heldRows`, which requires `desired_folder = 'ohmail/Screener'`, so a past-the-gate sender
 * comes back in `skipped` with `not_held` — and `toSkips` drops `not_held` on the floor by
 * design, because there is no chip to render for a sender who is not at the gate.
 *
 * ── WHY THAT WAS A LOOP RATHER THAN A WASTED SLOT ─────────────────────────────────────────
 *
 * The refusal leaves no trace on the row. The sender still has `ai == null`, so they are still
 * "unsuggested" on the next pass, so they are in the next batch — and auto-suggest runs batches
 * automatically once it is opted into. Every run spent slots out of the user's quoted batch on
 * senders the server had already said it cannot speak for, for ever.
 *
 * The fix is one predicate on the buy list. The row stays, the manual decision stays, and the
 * spender stops being handed a sender the endpoint will refuse. The server's `heldRows` is
 * deliberately NOT widened to match: that is the wire contract for what the gate resolves, and
 * changing it changes what a decide means for every caller.
 *
 * ── WHAT THIS FILE MOUNTS ────────────────────────────────────────────────────────────────
 *
 * `useScreenerState` over a real engine and a REAL projection — `presentationReader` over
 * `consentPartition`, exactly as `AppShell` composes them. Nothing here fakes the flag under
 * test: `screenerSegments` derives it from where the representative actually sits.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T09:00:00.000Z");
/** Comfortably inside the 60-day window, so every sender below is ACTIVE on recency. */
const RECENT = "2026-07-28T09:00:00.000Z";

let seq = 0;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const msg = (o: { id: string; from: string; folder: Folder; unread?: boolean }): EngineMessage => ({
  id: o.id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: `subject of ${o.id}`, from: { name: null, address: o.from }, to: [], cc: [],
  date: RECENT, folder: o.folder, snippet: `snippet of ${o.id}`, unread: o.unread ?? true,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
});

/**
 * Three active undecided senders, and the only difference between them is WHERE their mail is.
 *
 * `gate@` is at the gate and buyable. `stray@` has mail only in the INBOX — the row the cutline
 * mints past the gate. `mixed@` has both, and its row is minted on the GATE message, so it stays
 * buyable: the fix must exclude senders the gate cannot resolve, not senders who happen to have
 * INBOX mail.
 */
async function engineWithWorld(): Promise<OhmailEngine> {
  const rows: EngineMessage[] = [
    msg({ id: "gate1", from: "gate@example.invalid", folder: "ohmail/Screener" }),
    msg({ id: "stray1", from: "stray@example.invalid", folder: "INBOX" }),
    msg({ id: "mix-gate", from: "mixed@example.invalid", folder: "ohmail/Screener" }),
    msg({ id: "mix-inbox", from: "mixed@example.invalid", folder: "INBOX" }),
  ];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

interface Observed {
  unsuggested: string[];
  waiting: Array<{ address: string; gatePhysical: boolean | undefined }>;
}

async function mountProbe(engine: OhmailEngine): Promise<Observed> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  let seen: Observed | null = null;

  function Probe(): React.ReactElement {
    // The shell's own composition, verbatim: the queue from the projection, the mutations from
    // the raw mirror. A projection built any other way would not carry `physicalFolder`.
    const reader = engine.read();
    const view = consentPartition(reader, { now: NOW });
    const presented = presentationReader(reader, view);
    const state = useScreenerState(engine, null, 0, (() => {}) as never, useScreenerWords(), undefined, presented);
    seen = {
      unsuggested: state.unsuggestedSenders,
      waiting: state.waiting.map((x) => ({ address: x.from.address, gatePhysical: x.gatePhysical })),
    };
    return h("div");
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(TextProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(Probe),
    }));
  });
  await settleFirstPaint();
  return seen!;
}

describe("the Screener's buy list", () => {
  beforeEach(async () => { await engineWithWorld(); });
  afterEach(async () => {
    if (root) await act(() => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  it("offers no sender the gate holds nothing for, and still offers the ones it does", async () => {
    const seen = await mountProbe(await engineWithWorld());

    // The fixture is what this test says it is. Without this, a projection that stopped marking
    // rows would make every assertion below pass by producing nothing to exclude.
    const flags = new Map(seen.waiting.map((w) => [w.address, w.gatePhysical]));
    expect(flags.get("stray@example.invalid"), "the fixture produced no past-the-gate row").toBe(false);
    expect(flags.get("gate@example.invalid")).toBe(true);
    expect(flags.get("mixed@example.invalid"), "a mixed-residence row must be minted on its GATE mail").toBe(true);

    // THE PROPERTY. `stray@` would be answered `not_held`, silently, on every batch for ever.
    expect(seen.unsuggested).not.toContain("stray@example.invalid");
    // …and the fix is a filter, not a switch: everything the endpoint CAN answer for is offered.
    expect(seen.unsuggested).toContain("gate@example.invalid");
    expect(seen.unsuggested).toContain("mixed@example.invalid");
    expect(seen.unsuggested).toHaveLength(2);
  });

  it("keeps the past-the-gate sender DECIDABLE — the #116 row is not withdrawn", async () => {
    const seen = await mountProbe(await engineWithWorld());

    // The first cut of the cutline suppressed these rows entirely and that was the #116 vanish:
    // a sender reachable only by search, whose re-screening silently did nothing. Excluding them
    // from the BUY list must not put them back there. The row exists; only the purchase is off.
    expect(seen.waiting.map((w) => w.address)).toContain("stray@example.invalid");
  });
});
