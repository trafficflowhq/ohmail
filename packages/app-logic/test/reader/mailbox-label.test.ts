import { describe, expect, it } from "vitest";
import {
  mailboxLabelKey,
  mailboxLabelResolver,
  type MailboxLabelFact,
} from "../../src/reader/mailbox-label.js";

/**
 * WHICH OF THE ACCOUNT's MAILBOXES A LETTER WAS DELIVERED TO, AS A WORD: the resolver's gate, asked directly. Moved
 * word for word out of `apps/webapp/test/reads-mailbox-label.test.tsx` (its Reads cases stay there, over today's
 * Reads view, until the News place draws the label): the rule is the reader's own (`room-store.ts` hands it to every
 * place), so its cases stand beside its module.
 */

/** Two mailboxes: one labelled, one not — the two faces the resolver has to choose between. */
const TWO: MailboxLabelFact[] = [
  { id: "mb-work", address: "w@x.invalid", displayName: "Work" },
  { id: "mb-home", address: "h@x.invalid", displayName: null },
];
const ONE: MailboxLabelFact[] = [TWO[0]!];

/* ══ THE GATE ITSELF, ASKED DIRECTLY ═══════════════════════════════════════════════════════ */

describe("the resolver gates on the account, not on the caller", () => {
  it("null facts, one mailbox and an empty list all answer null for every id", () => {
    for (const facts of [null, ONE, [] as MailboxLabelFact[]]) {
      const resolve = mailboxLabelResolver(facts);
      expect(resolve("mb-work")).toBeNull();
      expect(resolve("mb-home")).toBeNull();
    }
  });

  it("above one it answers the label, the address without one, and null for a stranger", () => {
    const resolve = mailboxLabelResolver(TWO);
    expect(resolve("mb-work")).toBe("Work");
    expect(resolve("mb-home")).toBe("h@x.invalid");
    expect(resolve("mb-gone"), "an unknown mailbox id must not be rendered as itself").toBeNull();
  });

  it("a whitespace-only displayName is no label — the address answers", () => {
    const resolve = mailboxLabelResolver([
      { id: "a", address: "a@x.invalid", displayName: "   " },
      { id: "b", address: "b@x.invalid" },
    ]);
    expect(resolve("a")).toBe("a@x.invalid");
    expect(resolve("b")).toBe("b@x.invalid");
  });

  it("the memo key moves with a label and holds still for everything else", () => {
    // The key is what keeps a poll that moved `pendingMoves` from rebuilding the map.
    const same = mailboxLabelKey(TWO);
    expect(mailboxLabelKey([...TWO].reverse()), "order must not make a new key").toBe(same);
    expect(mailboxLabelKey(TWO.map((m) => ({ ...m })))).toBe(same);
    expect(mailboxLabelKey([{ ...TWO[0]!, displayName: "Job" }, TWO[1]!])).not.toBe(same);
    expect(mailboxLabelKey(null)).not.toBe(mailboxLabelKey([]));
  });
});
