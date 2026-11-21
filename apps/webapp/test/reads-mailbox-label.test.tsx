/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { issue } from "../../../packages/app/test/streams/registered-world.js";
import { mountCheckedStream } from "./stream-check-frame.js";

type MailboxLabelFact = { id: string; address: string; displayName: string | null };

/**
 * ═══ A READS SURFACE SAYS WHICH ADDRESS OF YOURS THE MESSAGE ARRIVED AT ═══════════════════
 *
 * On an account with several mailboxes a Reads row and its card were silent about which of the
 * person's own addresses received the message, so a work message and a private one were the same
 * row. Three things this ships wrong, and a case each:
 *
 *  · **A label on an account that has one address.** "Delivered to <your only address>" under
 *    every row says nothing. The gate is the ABSENCE assertion — the one that regresses quietly.
 *  · **The header read instead of the delivery fact.** To/Cc is silent on a Bcc, names the list on
 *    list mail and misses a plus address. The source is `m.mailboxId`, and the case that shows it
 *    is a message whose To names an address the account does not hold.
 *  · **The recipients ruling relaxed to carry it.** A one-recipient card draws no recipients block
 *    (`reads-recipients.test.tsx`); dropping that gate to fit the mailbox in would ship "To: you"
 *    under every subject. The label is its own node — asserted here as label present AND block
 *    absent on the same card.
 */

/** Two mailboxes: one labelled, one not — the two faces the resolver has to choose between. */
const TWO: MailboxLabelFact[] = [
  { id: "mb-work", address: "w@x.invalid", displayName: "Work" },
  { id: "mb-home", address: "h@x.invalid", displayName: null },
];
const ONE: MailboxLabelFact[] = [TWO[0]!];

const message = (mailboxId: string, to = [{ name: null, address: "w@x.invalid" }]): EngineMessage =>
  issue("m1", 12, {
    mailboxId,
    subject: "The weekly note", from: { name: "Ida Vogt", address: "ida@x.invalid" },
    to, cc: [],
  });

let host: HTMLElement | null = null;

async function mountReads(m: EngineMessage, facts: MailboxLabelFact[] | null, locale: "en" | "de" = "en") {
  const { engine } = fakeMail([m]);
  ({ el: host } = await mountCheckedStream(engine, "#/reads", locale, facts ? async () => facts : undefined));
}

afterEach(() => { host = null; });

const rowButton = (): HTMLElement => screen.getByRole("option", { name: /The weekly note/ });
const card = (): HTMLElement => {
  const el = screen.getByRole("heading", { name: "The weekly note" }).closest<HTMLElement>("article");
  expect(el, "no News card rendered").toBeTruthy();
  return el!;
};
const rowBadges = (): string[] =>
  [...rowButton().querySelectorAll<HTMLElement>(".badge.place")].map((b) => b.textContent ?? "");
const cardBadges = (): string[] =>
  [...card().querySelectorAll<HTMLElement>(".badge.place")].map((b) => b.textContent ?? "");

/* ══ TWO MAILBOXES — both surfaces name the one that received it ═══════════════════════════ */

describe("a two-mailbox account is told which of its addresses received the message", () => {
  it("the row wears the mailbox's own label", async () => {
    await mountReads(message("mb-work"), TWO);
    expect(rowBadges()).toContain("Work");
  });

  it("the card wears it too, in the head", async () => {
    await mountReads(message("mb-work"), TWO);
    expect(cardBadges()).toContain("Work");
    expect(
      card().querySelector(".oh-messagehead .badge.place"),
      "the card's badge is not on the head line",
    ).toBeTruthy();
  });

  it("a mailbox with no label falls back to its ADDRESS, never its id", async () => {
    await mountReads(message("mb-home"), TWO);
    expect(rowBadges()).toContain("h@x.invalid");
    expect(cardBadges()).toContain("h@x.invalid");
    for (const face of [...rowBadges(), ...cardBadges()]) {
      expect(face, "a raw mailbox id reached the surface").not.toContain("mb-");
    }
  });

  it("the DELIVERY mailbox decides, not the To header", async () => {
    // Addressed to a list the account does not hold, delivered to the labelled mailbox: a
    // header-derived answer has nothing to say here, and this is the case the item is about.
    await mountReads(message("mb-work", [{ name: null, address: "list@elsewhere.invalid" }]), TWO);
    expect(rowBadges()).toContain("Work");
    expect(cardBadges()).toContain("Work");
  });

  it("the row SPEAKS the delivery, as a sentence and not a bare word", async () => {
    await mountReads(message("mb-work"), TWO);
    const said = rowButton().getAttribute("aria-description") ?? "";
    expect(said).toContain("Work");
    expect(said).toContain("Delivered to Work");
  });

  it("the German window says it in German", async () => {
    await mountReads(message("mb-work"), TWO, "de");
    expect(rowBadges()).toContain("Work");
    expect(rowButton().getAttribute("aria-description") ?? "").toContain("Zugestellt an Work");
    expect(card().querySelector<HTMLElement>(".oh-messagehead .badge.place")!.getAttribute("title"))
      .toBe("Zugestellt an Work");
  });

  it("the badge carries the whole phrase as its title on both surfaces", async () => {
    await mountReads(message("mb-work"), TWO);
    const titles = [...host!.querySelectorAll<HTMLElement>(".badge.place")]
      .map((b) => b.getAttribute("title"));
    expect(titles.length).toBeGreaterThanOrEqual(2);
    for (const t of titles) expect(t).toBe("Delivered to Work");
  });
});

/* ══ ONE MAILBOX, AND NO FACTS — the surfaces they always were ═════════════════════════════ */

describe("an account with nothing to disambiguate is told nothing", () => {
  it("ONE mailbox: no label on the row and none on the card", async () => {
    await mountReads(message("mb-work"), ONE);
    expect(rowBadges(), "a one-mailbox account grew a delivery badge on its row").toEqual([]);
    expect(cardBadges(), "a one-mailbox account grew a delivery badge on its card").toEqual([]);
    expect(rowButton().getAttribute("aria-description") ?? "").not.toContain("Delivered to");
  });

  it("NO FACTS at all (the demo, a shell with no mailbox probe): no label", async () => {
    await mountReads(message("mb-work"), null);
    expect(rowBadges()).toEqual([]);
    expect(cardBadges()).toEqual([]);
  });

  it("an empty mailbox list is the same silence, not a crash", async () => {
    await mountReads(message("mb-work"), []);
    expect(rowBadges()).toEqual([]);
    expect(cardBadges()).toEqual([]);
  });
});

/* ══ THE RECIPIENTS RULING IS NOT THE ROUTE ════════════════════════════════════════════════ */

describe("the label is its own node, not a relaxed recipients block", () => {
  it("one recipient, two mailboxes: the label renders and the recipients block does NOT", async () => {
    // The card's recipients block is withheld below two recipients (`reads-recipients.test.tsx`).
    // An implementation that dropped that gate to fit the mailbox in reddens here.
    await mountReads(message("mb-work"), TWO);
    expect(cardBadges()).toContain("Work");
    expect(
      card().querySelector(".oh-messagehead-to"),
      "the one-recipient card grew a recipients block — the ruling was relaxed",
    ).toBeNull();
    expect(card().querySelectorAll(".oh-messagehead-person")).toHaveLength(0);
  });
});
