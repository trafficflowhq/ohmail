import { describe, expect, it } from "vitest";
import { mailboxIdOfAnswer, subjectOf } from "../../../src/mailboxes/connect/subject.js";
import type { MailboxId } from "../../../src/mailboxes/connect/types.js";

const id = (raw: string): MailboxId => mailboxIdOfAnswer(raw)!;
const ROWS = [
  { id: id("mbx-1"), address: "a@example.org" },
  { id: id("mbx-2"), address: "b@example.org" },
] as const;

describe("a mailbox id is the account's own", () => {
  it("a wire's answer mints one from a plain id, and from nothing else", () => {
    expect(mailboxIdOfAnswer("0d3a8f1e-52c4-4c0e-9a7b-1f2e3d4c5b6a")).toBe(
      "0d3a8f1e-52c4-4c0e-9a7b-1f2e3d4c5b6a",
    );
    for (const odd of [
      "",
      "../mailboxes",
      "a/b",
      "a b",
      "a?x=1",
      "a#b",
      "%2e%2e",
      "ä",
      "a\nb",
      "x".repeat(5000),
      "..",
      ".",
      7,
      null,
      undefined,
      { id: "mbx-1" },
      ["mbx-1"],
    ])
      expect(mailboxIdOfAnswer(odd)).toBeNull();
  });

  it("an id that percent-encoding would change is no id: a path holds it as it stands", () => {
    for (const raw of ["mbx-1", "A_b-9.c~d"]) expect(encodeURIComponent(mailboxIdOfAnswer(raw)!)).toBe(raw);
  });
});

describe("the mailbox a route's word names", () => {
  it("is the row that holds the word, and the id handed on is that row's own", () => {
    const { mailbox, state } = subjectOf(ROWS, "mbx-2", "run");
    expect(state).toBe("mailbox");
    expect(mailbox).toBe(ROWS[1]);
  });

  it.each([
    "mbx-9",
    "../mbx-1",
    "mbx-1/..",
    "MBX-1",
    "__proto__",
    "constructor",
    "mbx-1?x",
    " mbx-1",
    "x".repeat(5000),
  ])("a word no row holds is no mailbox: %s", (word) => {
    expect(subjectOf(ROWS, word, "run")).toEqual({ mailbox: null, state: "vanished" });
    expect(subjectOf(ROWS, word, "add")).toEqual({ mailbox: null, state: "pending" });
  });

  it("with no rows read, no subject resolves", () => {
    expect(subjectOf(null, "mbx-1", "run")).toEqual({ mailbox: null, state: "none" });
  });

  it("with no word: the one row stands in, several ask, and an add run waits for its own", () => {
    expect(subjectOf([ROWS[0]], null, "run")).toEqual({ mailbox: ROWS[0], state: "mailbox" });
    expect(subjectOf(ROWS, null, "run")).toEqual({ mailbox: null, state: "choose" });
    expect(subjectOf(ROWS, null, "add")).toEqual({ mailbox: null, state: "pending" });
  });
});
