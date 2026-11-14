/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { HELD_FOLDERS } from "@trafficflow/core/destinations";
import { autoLoadsImages } from "@ohmail/app-logic/reader/remote-images";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { act, message as shellLetter, mountShell, stubDom, unmountAll } from "./_draft-shell.js";
import { ohboxRow } from "./ohbox/_finders.js";
import { mountPanel } from "./_reader-1-panel.js";

/**
 * THE IDENTITY FACT ON EVERY SURFACE THAT NAMES A SENDER (mail 0148, acceptance 16): the list row's
 * chip, the open letter's sentence, and the one default-read term that keeps a marked message's pictures for a
 * press. Each beside the unmarked control.
 *
 * RE-POINTED (share reader-1, the switch's older tests): the list row is the seated Ohbox's, through the new
 * shell's test door (`_draft-shell.ts`'s `mountShell`); the open letter is the new reader's, through the share's
 * door (`_reader-1-panel.tsx`); the picture door is read from its home (`@ohmail/app-logic/reader/remote-images`).
 * The chip and the sentence are found by their words, never by today's class names. The new row draws no chip and
 * the new reader's head no check line: those cases are red by their rows (`GAP`), each expectation as it stood. The
 * Screener's cases (the sentence's forms, the guided first decision, the sender sheet) moved, as they stood, to
 * `identity-surfaces-screener.test.tsx`: their place is not mounted yet.
 */

/** A sender at the brand's own domain whose provider did not confirm it (`reason: "unverified"`). */
const UNVERIFIED = { reason: "unverified" as const, brand: "PayPal", domainShared: false };

/** The phish's sender: a fixture at a shared provider, whose address anyone can register. */
const PHISH = personalAt("fixture.mila", "gmail.com");

/** The Ohbox's one let-in sender (the test door's rule), under a name that claims a company. */
const LET_IN = "colleague@example.invalid";

beforeEach(() => {
  stubDom();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(async () => {
  cleanup();
  await unmountAll();
});

/** The seated Ohbox over one letter `m1` with these fields; its row once listed. */
async function ohboxWith(over: Partial<EngineMessage>): Promise<HTMLElement> {
  await mountShell("#/ohbox", [shellLetter("m1", over)]);
  const deadline = Date.now() + 10_000;
  while (ohboxRow(document, "m1") === null) {
    if (Date.now() > deadline) throw new Error("the Ohbox never listed its letter");
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  return ohboxRow(document, "m1")!;
}

/** The chip a row draws: its face by its words. */
const chipOf = (row: HTMLElement, face: string): HTMLElement | null => within(row).queryByText(face);

describe("the identity fact on the web", () => {
  it("the list row draws the chip first, with the sentence as its title and in what the row says", async () => {
    const row = await ohboxWith({
      from: { name: "PostFinance", address: LET_IN }, subject: "Bitte bestätigen",
      senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: false },
    } as Partial<EngineMessage>);
    const chip = chipOf(row, "Not PostFinance");
    expect(chip?.textContent).toBe("Not PostFinance");
    expect(chip?.getAttribute("title")).toContain("This message claims to be from PostFinance");
    expect(row.getAttribute("aria-description")).toContain("This message claims to be from PostFinance");
  });

  it("the chip sits on the sender line after the name, before the address; the subject's line keeps its room", async () => {
    const row = await ohboxWith({
      from: { name: "PostFinance", address: LET_IN }, subject: "Bitte bestätigen",
      senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: false },
    } as Partial<EngineMessage>);
    const chip = chipOf(row, "Not PostFinance");
    expect(chip, "the row draws no chip").not.toBeNull();
    /* The sender's line: the name, then the chip, then the address; the subject's line holds no chip. */
    const name = within(row).getByText("PostFinance");
    const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(name, chip!)).toBe(true);
    const address = within(row).queryByText(LET_IN);
    expect(address !== null && follows(chip!, address)).toBe(true);
    expect(within(row).getByText("Bitte bestätigen").contains(chip)).toBe(false);
  });

  it("CONTROL: a row with no fact draws no chip", async () => {
    const row = await ohboxWith({ from: { name: "Anna", address: LET_IN }, subject: "Hi" } as Partial<EngineMessage>);
    expect(within(row).queryByText(/^Not /)).toBeNull();
    expect(row.getAttribute("aria-description") ?? "").not.toMatch(/claims to be from|did not confirm|the check failed/);
  });

  it("the open message says the sentence under the sender's address; an unmarked one says nothing", async () => {
    /* The letter as the old case opened it; the line is found by its words (the sentence's family), its shield by
       the picture it draws. */
    const open = (senderCheck: EngineMessage["senderCheck"], authVerdict: string | null = null): string | null => {
      cleanup();
      mountPanel({
        subject: "Bitte bestätigen", from: { name: "PostFinance", address: PHISH },
        to: [{ name: null, address: "me@firma.example" }], senderCheck, authVerdict,
      } as Partial<EngineMessage>);
      const line = screen.queryAllByText(/^(This message (claims|says)|Your mail provider checked)/)[0] ?? null;
      if (line !== null) expect(line.querySelector("svg") ?? line.parentElement?.querySelector("svg"), "the reader's line draws the shield").not.toBeNull();
      return line?.textContent ?? null;
    };
    expect(open({ reason: "impersonation", brand: "PostFinance", domainShared: true }))
      .toBe("This message claims to be from PostFinance, but anyone can register a gmail.com address.");
    expect(open(null)).toBeNull();
    // An unconfirmed sender at the brand's own domain: its own line, and never the claim's.
    expect(open(UNVERIFIED)).toBe("This message says it is from PayPal. Your mail provider did not confirm that.");
    expect(screen.queryByText(/claims to be from/)).toBeNull();
    // A letter its provider failed says so, whatever its name claims.
    expect(open({ reason: "impersonation", brand: "PostFinance", domainShared: true }, "fail"))
      .toBe(`Your mail provider checked whether this message is from ${PHISH}, and the check failed.`);
  });

  it("a marked message's pictures wait for a press on an account that loads them on open", () => {
    expect(autoLoadsImages({ auto: true }, { senderCheck: { reason: "impersonation", brand: "UBS", domainShared: true } })).toBe(false);
    expect(autoLoadsImages({ auto: true }, { senderCheck: null })).toBe(true);
    expect(autoLoadsImages({ auto: false }, {})).toBe(false);
    expect(autoLoadsImages(undefined, {})).toBe(false);
  });

  it("an unconfirmed line holds nothing back: the pictures load as the account says", () => {
    expect(autoLoadsImages({ auto: true }, { senderCheck: UNVERIFIED })).toBe(true);
    expect(autoLoadsImages({ auto: false }, { senderCheck: UNVERIFIED })).toBe(false);
  });

  it("a sender not let in waits for a press: held where it is shown or where it is filed", () => {
    for (const folder of HELD_FOLDERS) expect(autoLoadsImages({ auto: true }, { folder }), folder).toBe(false);
    // Shown as filed in a press's undo window, still held on the server.
    expect(autoLoadsImages({ auto: true }, { folder: "INBOX", physicalFolder: "ohmail/Screener" })).toBe(false);
    expect(autoLoadsImages({ auto: true }, { folder: "INBOX" })).toBe(true);
    expect(autoLoadsImages({ auto: true }, { folder: "ohmail/News", physicalFolder: "INBOX" })).toBe(true);
  });
});
