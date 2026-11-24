/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { GapOffer, MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { mountNoticeSlot } from "./_mailbox-notice-slot.js";

/**
 * THE GAP OFFER NAMES BOTH NUMBERS (mail 0158). Letters the person's rules file, letters from
 * senders they have not decided about, or both: three sentences, and the press carries the pair
 * the person was shown, so the server can refuse a pair that moved. Strangers are never filed "by
 * your rules"; their sentence says the Screener.
 *
 * RE-POINTED (the switch's older tests, sorted once): today's `GapLettersNotice` is drawn by no host. The offer is
 * the Mailboxes entry's (`useGapNotices`, `packages/app-logic/src/mailboxes/pane/notices.ts`), said in the frame's
 * one notice slot as every host hands it (`mailboxesNotices`), over the facts that carry the offer (a mailbox this
 * install organizes, with its gap's two counts) and the gap's wire; in German over the same slot
 * (`_mailbox-notice-slot.tsx`: the new shell's door speaks English only). The block is found by its role
 * (a status in the slot), its sentence is the block's words, a press is a button in it. Every expectation is as it
 * stood.
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** The facts that carry `offer`: a mailbox this install organizes, its gap's two counts. */
const factsOf = (offer: GapOffer): MailboxFacts => ({
  id: offer.id,
  address: offer.address,
  status: "connected",
  organizerRole: "organizer",
  gapLetters: offer.count,
  gapStrangers: offer.strangers,
} as MailboxFacts);

async function show(offer: GapOffer, locale: "en" | "de" = "en") {
  const sent: Array<{ id: string; answer: { file: boolean; count: number; strangers: number } }> = [];
  const slot = await mountNoticeSlot({
    facts: [factsOf(offer)],
    gapLetters: async (id, answer) => { sent.push({ id, answer }); },
    locale,
  });
  const block = slot.blocks()[0];
  const text = block?.querySelector("p")?.textContent ?? "";
  const buttons = [...(block?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  return { el: slot.el, text, buttons, sent };
}

describe("the gap offer's three sentences", () => {
  it("rules only: no device organized the letters, and File sends strangers 0", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 2, strangers: 0 });
    expect(v.text).toBe("2 letters arrived in me@x.test, and no device organized them. File them by your rules?");
    expect(v.buttons.map((b) => b.textContent)).toEqual(["File them", "Leave them"]);
    await act(async () => { v.buttons[0]!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(v.sent).toEqual([{ id: "mb", answer: { file: true, count: 2, strangers: 0 } }]);
  });

  it("strangers only: the Screener, never the rules, and the press carries the stranger count", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 0, strangers: 3 });
    expect(v.text).toContain("3 letters from senders you have not decided about");
    expect(v.text).toContain("Screener");
    expect(v.text).not.toMatch(/rules/);
    expect(v.buttons.map((b) => b.textContent)).toEqual(["Screen them", "Leave them"]);
    await act(async () => { v.buttons[0]!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(v.sent).toEqual([{ id: "mb", answer: { file: true, count: 0, strangers: 3 } }]);
  });

  it("both: names each number, and Leave sends the pair too", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 1, strangers: 2 });
    expect(v.text).toMatch(/^1 letter for your rules and 2 from senders you have not decided about arrived in me@x\.test/);
    expect(v.text).toContain("Screener");
    await act(async () => { v.buttons[1]!.click(); for (let i = 0; i < 12; i++) await Promise.resolve(); });
    expect(v.sent).toEqual([{ id: "mb", answer: { file: false, count: 1, strangers: 2 } }]);
  });

  it("German names both numbers too", async () => {
    const v = await show({ id: "mb", address: "me@x.test", count: 1, strangers: 2 }, "de");
    expect(v.text).toMatch(/^1 Mail für deine Regeln und 2 von Absendern, über die du nie entschieden hast,/);
    const only = await show({ id: "mb2", address: "me@x.test", count: 0, strangers: 1 }, "de");
    expect(only.text).toContain("In den Screener legen?");
    expect(only.buttons[0]!.textContent).toBe("In den Screener");
  });

  /* A letter another device took in while the holder's last pass had not reached it is offered too
     (mail 0169), so no sentence says nothing was organizing the mailbox when the letters arrived. */
  it("every sentence, in both languages, says no device organized the letters, never that none was organizing", async () => {
    for (const [locale, said] of [["en", "and no device organized"], ["de", "und kein Gerät hat sie organisiert"]] as const) {
      for (const [count, strangers] of [[2, 0], [0, 1], [1, 2]]) {
        const v = await show({ id: `mb-${locale}-${count}-${strangers}`, address: "me@x.test", count: count!, strangers: strangers! }, locale);
        expect(v.text).toContain(said);
        expect(v.text).not.toMatch(/while no device was organizing|während kein Gerät/);
      }
    }
  });
});
