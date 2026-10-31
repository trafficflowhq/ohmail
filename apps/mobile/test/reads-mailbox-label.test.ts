import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { mailboxLabelOf, type MailboxLabelRow } from "../src/state/live";

/**
 * ═══ THE PHONE NAMES THE MAILBOX A MESSAGE ARRIVED IN ════════════════════════════════════════
 *
 * Parity with the browser's News surfaces: above one mailbox a News card and the message screen
 * say which of the person's own addresses received the message. The derivation is the same shape
 * as `apps/webapp/app/shell/mailbox-label.ts` and gated the same way — INSIDE, so no screen
 * re-derives "does this account have more than one address" — and the FACE is the same too, which
 * is the point of reading `displayName` off the roster at all: one mailbox, one word, every
 * surface. The projection carries it (`WorldMail.mailboxLabel`); nothing new goes on the wire.
 */

const TWO: MailboxLabelRow[] = [
  { id: "mb-work", address: "w@x.invalid", displayName: "Work" },
  { id: "mb-home", address: "h@x.invalid" },
];

describe("the phone labels a delivery only where there is something to disambiguate", () => {
  it("two mailboxes: the label is the mailbox's own, the address where it has none", () => {
    expect(mailboxLabelOf(TWO, "mb-work")).toBe("Work");
    expect(mailboxLabelOf(TWO, "mb-home")).toBe("h@x.invalid");
  });

  it("ONE mailbox says nothing — the card is the card it was", () => {
    expect(mailboxLabelOf([TWO[0]!], "mb-work")).toBeUndefined();
  });

  it("nothing read yet (`mailboxes.known` false) says nothing either", () => {
    expect(mailboxLabelOf(undefined, "mb-work")).toBeUndefined();
    expect(mailboxLabelOf([], "mb-work")).toBeUndefined();
  });

  it("an unknown mailbox id is not rendered as itself", () => {
    expect(mailboxLabelOf(TWO, "mb-gone")).toBeUndefined();
  });

  it("removed copies of the one address are no second mailbox; a removed mailbox of another address is", () => {
    const A = TWO[1]!;
    const copies = [{ ...A, id: "mb-home-1" }, { ...A, id: "mb-home-2" }, A];
    expect(mailboxLabelOf(copies, A.id)).toBeUndefined();
    expect(mailboxLabelOf(copies, "mb-home-1")).toBeUndefined();
    expect(mailboxLabelOf([...copies, { id: "mb-c", address: "c@x.invalid" }], "mb-c")).toBe("c@x.invalid");
  });

  it("a whitespace-only label is no label", () => {
    expect(mailboxLabelOf([{ id: "a", address: "a@x.invalid", displayName: " " }, TWO[1]!], "a"))
      .toBe("a@x.invalid");
  });
});

describe("the sentence is a delivery claim, in both languages", () => {
  it("English and German differ, and both name the label", () => {
    expect(EN.deliveredTo("Work")).toBe("Delivered to Work");
    expect(DE.deliveredTo("Work")).toBe("Zugestellt an Work");
    expect(EN.deliveredTo("Work")).not.toBe(DE.deliveredTo("Work"));
    expect(Copy.deliveredTo("Work")).toContain("Work");
  });

  it("it is a DELIVERY claim and never a To-header one — the two cannot be read as the same", () => {
    // The phone's message screen shows no recipients at all, so the wording is the only thing
    // that says which question this answers.
    for (const said of [EN.deliveredTo("Work"), DE.deliveredTo("Work")]) {
      expect(said.toLowerCase()).not.toContain("to:");
      expect(said.toLowerCase()).not.toContain("cc");
    }
  });
});
