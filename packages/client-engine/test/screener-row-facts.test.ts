import type { EngineMessage, Folder, ScreenerSenderDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  mutationEffects,
  screenerSegments,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * THE TWO FACTS A SCREENER ROW CARRIES ABOUT ITSELF, AND THE ONE VOCABULARY IT SAYS THEM IN.
 *
 * on an account with more than one mailbox a row did not say
 * which of the reader's addresses the stranger wrote to, and could not: the fact was on the
 * message all along and no row carried it.
 *
 * `screenedOn` had two producers in two vocabularies: a
 * `${day} ${month}` band no other row wears, and `iso.slice(0, 10)` from the optimistic press.
 * The sheet then guessed between them by the SHAPE of the string.
 *
 * The cases below are written so the OLD code and the NEW code disagree. A screened-out sender
 * whose newest mail is from a previous year is the discriminator for the stamp — both spellings
 * answer "22 Jul" for a date inside this year, which is why the existing derived-row case could
 * not see the defect and did not move when it was fixed.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function msg(o: {
  id: string; from: string; name?: string; folder: Folder; mailboxId?: string; date?: string;
}): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: o.mailboxId ?? "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: o.name ?? null, address: o.from },
    to: [],
    cc: [],
    date: o.date ?? "2026-08-02T09:00:00.000Z",
    folder: o.folder,
    snippet: `snippet ${o.id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: SyncChange[] = messages.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  }));
  await store.applyChanges(changes);
  return store;
}

describe("a Screener row names the mailbox the stranger wrote to", () => {
  /**
   * TWO MAILBOXES WHOSE ADDRESSES DIFFER. A fixture where they agree measures alignment, not the
   * property: every row would name the right one by accident. These are two ids, and the rows are
   * asserted to carry the id of the mailbox their own representative is in.
   */
  it("carries the representative's own mailbox, per sender", async () => {
    const store = await mirrorOf([
      msg({ id: "w1", from: "one@stranger.example", folder: "ohmail/Screener", mailboxId: "mbx-work" }),
      msg({ id: "w2", from: "two@stranger.example", folder: "ohmail/Screener", mailboxId: "mbx-home" }),
      msg({ id: "s1", from: "cold@outreach.example", folder: "ohmail/Screened", mailboxId: "mbx-home" }),
      msg({ id: "q1", from: "win@jackpot.example", folder: "ohmail/Quarantine", mailboxId: "mbx-work" }),
    ]);
    const seg = screenerSegments(store, NOW);

    const byAddress = new Map(seg.waiting.map((s) => [s.from.address, s.mailboxId]));
    expect(byAddress.get("one@stranger.example")).toBe("mbx-work");
    expect(byAddress.get("two@stranger.example")).toBe("mbx-home");
    // The other two segments carry it too — a decision is taken on those sheets as well.
    expect(seg.screenedOut[0]!.mailboxId).toBe("mbx-home");
    expect(seg.spam[0]!.mailboxId).toBe("mbx-work");

    // AND THE TWO ROWS DISAGREE. Without this the case passes for a derivation that hands every
    // row one constant — the defect wearing a different shape.
    expect(byAddress.get("one@stranger.example")).not.toBe(byAddress.get("two@stranger.example"));
  });

  /** A sender's newest GATE mail is the representative, so its mailbox is the one named. */
  it("names the newest held message's mailbox when one sender wrote to both", async () => {
    const store = await mirrorOf([
      msg({ id: "a", from: "both@stranger.example", folder: "ohmail/Screener", mailboxId: "mbx-home", date: "2026-08-01T09:00:00.000Z" }),
      msg({ id: "b", from: "both@stranger.example", folder: "ohmail/Screener", mailboxId: "mbx-work", date: "2026-08-02T09:00:00.000Z" }),
    ]);
    const seg = screenerSegments(store, NOW);
    expect(seg.waiting).toHaveLength(1);
    expect(seg.waiting[0]!.id).toBe("b");
    expect(seg.waiting[0]!.mailboxId).toBe("mbx-work");
  });
});

describe("one stamp vocabulary on the Screener", () => {
  /**
   * THE DISCRIMINATOR. The old mint was `${day} ${month}` with no year band at all, so a sender
   * screened out in a PREVIOUS year read as this year's — "22 Jul", indistinguishable from mail
   * three weeks old. `messageStamp` carries the year exactly there and nowhere else, so this is
   * the case that separates the two spellings.
   */
  it("a sender screened out last year is stamped with its year", async () => {
    const store = await mirrorOf([
      msg({ id: "s1", from: "cold@outreach.example", folder: "ohmail/Screened", date: "2025-07-22T09:00:00.000Z" }),
    ]);
    const seg = screenerSegments(store, NOW);
    expect(seg.screenedOut[0]!.screenedOn).toBe("22 Jul 2025");
    // The row's own stamp and this one are the same derivation — not merely both non-empty.
    expect(seg.screenedOut[0]!.screenedOn).toBe(seg.screenedOut[0]!.time);
  });

  /** Inside the week the band is a weekday and a clock — the third form the old mint never had. */
  it("a sender screened out this week is stamped in the week band", async () => {
    const store = await mirrorOf([
      msg({ id: "s1", from: "cold@outreach.example", folder: "ohmail/Screened", date: "2026-07-30T09:00:00.000Z" }),
    ]);
    const seg = screenerSegments(store, NOW);
    expect(seg.screenedOut[0]!.screenedOn).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/);
    expect(seg.screenedOut[0]!.screenedOn).toBe(seg.screenedOut[0]!.time);
  });

  /**
   * AND THE PRESS MINTS NOTHING. It wrote `2026-09-22` — a shape no other stamp on the screen
   * wears — into a DURABLE entity, and the sheet read the shape back and printed "today", which
   * it went on saying for as long as the row lived. A mutation has no zone and no locale and
   * cannot form a stamp; the row keeps the one it already has.
   */
  it("screening a sender out does not stamp the row", async () => {
    /* The `screener_sender` ENTITY path — the one branch that mints this field. A mirror holding
       only messages takes the derived branch instead, which writes no row at all, so seeding the
       entity is what puts the case on the code under test rather than beside it. */
    const store = await mirrorOf([
      msg({ id: "m1", from: "cold@outreach.example", folder: "ohmail/Screener", date: "2026-07-22T09:00:00.000Z" }),
    ]);
    const seg = screenerSegments(store, NOW);
    const derived = seg.waiting[0]!;
    expect(derived).toBeDefined();
    const sender: ScreenerSenderDTO = { ...derived, id: "sender-1", derived: undefined } as ScreenerSenderDTO;
    await store.applyChanges([{
      type: "screener_sender", op: "create", id: sender.id, seq: ++seq,
      updatedAt: sender.updatedAt, entity: sender,
    } as unknown as SyncChange]);

    const effects = mutationEffects(store, {
      kind: "screener_decide",
      senderId: sender.id,
      decision: "no",
      destination: "ohmail/Screened",
      scope: "sender",
    } as never, { now: () => NOW, uuid: () => "rule-1" });

    const row = effects.find((e) => e.type === "screener_sender");
    expect(row).toBeDefined();
    const dto = row!.entity as ScreenerSenderDTO;
    expect(dto.segment).toBe("screened_out");
    // Not "an ISO-looking string": NO stamp, so nothing downstream has a shape to guess from.
    expect(dto.screenedOn).toBeUndefined();
    // The stamp it keeps is the derivation's, and it is the one the settled row will show too.
    expect(dto.time).toBe(derived.time);
  });
});
