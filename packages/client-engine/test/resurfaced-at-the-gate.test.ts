import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  ohboxView,
  presentationReader,
  screenerSegments,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A RESURFACED ROW PHYSICALLY AT THE GATE IS THE PIN ALONE (row RESURFACED-GATE-ROW-IS-IN-TWO-SURFACES).
 *
 * Reachable: History lists a dormant stranger's mail that sits in `ohmail/Screener`, and its `b`
 * books a resurface with no folder check on either end. Kept at that folder the row was pinned in
 * the Ohbox AND held by a waiting row. It now presents in the INBOX, whose pin is its only home.
 * Watch it fail: place the resurfaced row at `m.folder` again in `consentPartition`.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const RECENT = "2026-07-20T09:00:00.000Z";
const OLD = "2024-03-02T09:00:00.000Z";
const GATE: Folder = "ohmail/Screener";

let seq = 0;

function msg(o: { id: string; from: string; date: string; unread: boolean; resurfaced?: boolean }): EngineMessage {
  return {
    id: o.id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${o.id}`, from: { name: null, address: o.from }, to: [], cc: [], date: o.date,
    folder: GATE, snippet: `snippet ${o.id}`, unread: o.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: o.resurfaced
      ? ({ messageId: o.id, state: "resurfaced", bubbleUpAt: null, setAt: RECENT, updatedAt: RECENT } as unknown as EngineMessage["triage"])
      : null,
    labels: [], remoteContent: "none", updatedAt: o.date,
  };
}

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  return store;
}

describe("a resurfaced row that sits in the Screener folder", () => {
  it("is in exactly one visible surface — the pin — over every sender standing", async () => {
    for (const [sender, date, unread] of [
      ["dormant@example.com", OLD, false],
      ["active@example.com", RECENT, true],
      ["quiet-read@example.com", RECENT, false],
    ] as const) {
      const store = await mirrorOf([msg({ id: "pin", from: sender, date, unread, resurfaced: true })]);
      const part = consentPartition(store, { now: NOW });
      const projected = presentationReader(store, part);
      const view = ohboxView(projected);
      const appearances = [
        view.resurfaced, view.newForYou, view.previouslySeen, [...part.history],
        screenerSegments(projected, NOW).waiting.flatMap((w) => w.held),
      ].flat().filter((m) => m.id === "pin");

      expect(appearances, sender).toHaveLength(1);
      expect(view.resurfaced.map((m) => m.id), sender).toEqual(["pin"]);
      expect(part.placeOf.get("pin"), sender).toBe("INBOX");
      expect(projected.get<EngineMessage>("message", "pin")?.physicalFolder, sender).toBe(GATE);
    }
  });

  it("leaves the sender's standing alone: their other gate mail still waits for a decision", async () => {
    const store = await mirrorOf([
      msg({ id: "pin", from: "active@example.com", date: RECENT, unread: true, resurfaced: true }),
      msg({ id: "held", from: "active@example.com", date: RECENT, unread: true }),
    ]);
    const part = consentPartition(store, { now: NOW });
    const segments = screenerSegments(presentationReader(store, part), NOW);

    expect(segments.waiting).toHaveLength(1);
    expect(segments.waiting[0]!.held.map((h) => h.id)).toEqual(["held"]);
    expect(part.placeOf.get("held")).toBe(GATE);
    expect(part.counts.activeUndecidedSenders).toBe(1);
  });
});
