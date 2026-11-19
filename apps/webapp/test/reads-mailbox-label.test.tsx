/** @vitest-environment jsdom */
import type { EngineMessage, MessageBody, TagEntity as TagDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { FeedPartition } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { KeymapProvider } from "../../../test/support/keymap-provider";
import { ReadsView } from "../app/views/ReadsView";
import { mailboxLabelResolver, type MailboxLabelFact } from "../app/shell/mailbox-label";

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

const ISO = "2026-08-04T09:00:00.000Z";
const tags: TagDTO[] = [];
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Two mailboxes: one labelled, one not — the two faces the resolver has to choose between. */
const TWO: MailboxLabelFact[] = [
  { id: "mb-work", address: "w@x.invalid", displayName: "Work" },
  { id: "mb-home", address: "h@x.invalid", displayName: null },
];
const ONE: MailboxLabelFact[] = [TWO[0]!];

const message = (mailboxId: string, to = [{ name: null, address: "w@x.invalid" }]): EngineMessage =>
  ({
    id: "m1", accountId: "a", mailboxId, threadId: null, messageIdHeader: null,
    subject: "The weekly note", from: { name: "Ida Vogt", address: "ida@x.invalid" },
    to, cc: [], date: ISO, folder: "INBOX", physicalFolder: "INBOX",
    snippet: "the opening line of the issue",
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const body = (m: EngineMessage): MessageBody =>
  ({ text: m.snippet, state: "snippet", html: null, loadedRemoteContent: false,
     unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

let roots: Root[] = [];
let host: HTMLElement | null = null;

/**
 * Mounted through the REAL resolver, never a hand-written stub: the gate under test lives inside
 * `mailboxLabelResolver`, so a mount that passed its own `() => "Work"` would be measuring the
 * wiring while the thing that decides went unasked.
 */
async function mountReads(
  m: EngineMessage,
  facts: MailboxLabelFact[] | null,
  locale: "en" | "de" = "en",
): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const partition: FeedPartition = { waterline: null, fresh: [m], seen: [], newCount: 0 };
  await act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>
          <ReadsView settled owed={false}
            partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
            aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
            bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}}
            onAction={() => {}}
            mailboxLabelOf={mailboxLabelResolver(facts)}
          />
        </KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
}

afterEach(async () => {
  await act(async () => { for (const r of roots) r.unmount(); });
  roots = [];
  host?.remove();
  host = null;
});

const rowButton = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>(".row");
  expect(el, "no Reads row rendered").toBeTruthy();
  return el!;
};
const card = (): HTMLElement => {
  const el = host!.querySelector<HTMLElement>(".scast");
  expect(el, "no Reads card rendered").toBeTruthy();
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
      card().querySelector(".sc-line .badge.place"),
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
    expect(card().querySelector<HTMLElement>(".sc-line .badge.place")!.getAttribute("title"))
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
      card().querySelector(".msg-rcpts"),
      "the one-recipient card grew a recipients block — the ruling was relaxed",
    ).toBeNull();
    expect(card().querySelectorAll(".rcpt-chip")).toHaveLength(0);
  });
});
