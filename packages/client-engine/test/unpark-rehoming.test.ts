import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  ohboxView,
  type EngineMessage,
  type EntityReader,
  type MessageStateDTO,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * UN-PARKING RE-HOMES A READ ROW AT ITS OWN DATE — not at the top of "Earlier", not lost.
 *
 * ## THE REPORT (owner-ratified, 2026-08-24, the §16 UI wave's item 5)
 *
 * *"When a message leaves Answer Later (unparked/removed), it must land in Ohbox under 'Earlier'
 * at its chronological position — not at the top, not lost."*
 *
 * ## THE MECHANISM, since the arrival ruling (owner 2026-09-18)
 *
 * The POSITION half is now the sort itself: every Ohbox row sits by `sortAt ?? date`, so an
 * un-parked row is at its chronological slot whatever its stamp says. What the re-homing still
 * owns is the reading STATE: the glance that preceded the parking press stamped `lastReadAt`
 * NOW-ish — a reading claim about the parked interlude, not about the mail. Leaving a bottom
 * pile disowns it: `TriageService.setState`'s `none` transition re-stamps
 * `lastReadAt = messages.date` for a READ row, and the overlay (`mutations.ts#triage_set`)
 * writes the same value for the round trip.
 *
 * Scope, asserted below: only the `none` transition, only FROM a bottom pile, only a READ row.
 */

const at = (iso: string) => iso;

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "INBOX",
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}

/** A WHOLE {@link EntityReader}: `entries` and `version` are not optional, and this fixture is
 *  frozen, so the stamp is a constant. Two of the four members were missing while nothing the
 *  overlay reads asked for them — `winningStates` now does, and a partial fake is not a reader. */
function readerOf(byType: Record<string, unknown[]>): EntityReader {
  return {
    list: <T,>(type: string) => (byType[type] ?? []) as T[],
    get: <T,>(type: string, id: string) =>
      (byType[type] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(type: string) => (byType[type] ?? []).map((entity, i) => ({
      id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i,
    })),
    version: () => 1,
  };
}

describe("the overlay — triage_set none re-homes exactly the rows the server will", () => {
  it("un-parking the demo's READ Answer-Later row re-stamps lastReadAt to its own date", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();

    const before = engine.read().get<EngineMessage>("message", "nadja")!;
    expect(before.triage?.state, "the fixture's Answer Later row").toBe("reply_later");
    expect(before.unread).toBe(false);

    await engine.mutate({ kind: "triage_set", messageId: "nadja", state: "none" });

    const after = engine.read().get<EngineMessage>("message", "nadja")!;
    expect(after.triage).toBeNull();
    // The re-homing stamp: read as though at its send instant — its chronological slot.
    expect(after.lastReadAt).toBe(before.date);
    // Back in "Earlier" — never lost, never bold in "New for you".
    const view = ohboxView(engine.read());
    expect(view.previouslySeen.map((m) => m.id)).toContain("nadja");
    expect(view.newForYou.map((m) => m.id)).not.toContain("nadja");
  });

  it("an UNREAD row un-parks back to 'New for you' with NO reading stamp invented", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();

    // Park an unread fixture row, then un-park it.
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "set_aside" });
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "none" });

    const after = engine.read().get<EngineMessage>("message", "petra")!;
    expect(after.unread).toBe(true);
    // No reading ever happened, so none may be claimed.
    expect(after.lastReadAt ?? null).toBeNull();
    expect(ohboxView(engine.read()).newForYou.map((m) => m.id)).toContain("petra");
  });

  it("ENTERING a pile keeps every stamp — only leaving one re-homes", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    const before = engine.read().get<EngineMessage>("message", "nadja")!;
    await engine.mutate({ kind: "triage_set", messageId: "nadja", state: "set_aside" });
    const after = engine.read().get<EngineMessage>("message", "nadja")!;
    expect(after.lastReadAt ?? null).toBe(before.lastReadAt ?? null);
  });
});

describe("the placement — a re-homed stamp files the row chronologically in 'Earlier'", () => {
  /**
   * The ratified sentence's end state, as a positive control: the un-parked row sits at its own
   * date among everything else — below newer mail, above older, never at the top, never lost.
   * Under the arrival ruling (2026-09-18) the ORDER guarantees this with or without the
   * re-homed stamp; the stamp itself is pinned above as state.
   */
  it("at its own date among everything else — below newer mail, never at the top", () => {
    const reader = readerOf({
      message: [
        mkMsg({ id: "fresh", date: at("2026-08-04T08:00:00.000Z"), lastReadAt: at("2026-08-04T09:00:00.000Z") }),
        mkMsg({ id: "recent", date: at("2026-08-03T08:00:00.000Z"), lastReadAt: at("2026-08-03T09:00:00.000Z") }),
        // The un-parked row: three days old, re-stamped at its own date.
        mkMsg({ id: "unparked", date: at("2026-08-01T09:00:00.000Z"), lastReadAt: at("2026-08-01T09:00:00.000Z") }),
        // Read elsewhere: no stamp. Newer by date than `unparked`, so it files ABOVE it now —
        // an unstamped read row sits at its own instant (the 2026-09-18 narrowing).
        mkMsg({ id: "imported", date: at("2026-08-02T09:00:00.000Z") }),
      ],
      message_state: [] as MessageStateDTO[],
    });
    expect(ohboxView(reader).previouslySeen.map((m) => m.id)).toEqual([
      "fresh", "recent", "imported", "unparked",
    ]);
  });
});
