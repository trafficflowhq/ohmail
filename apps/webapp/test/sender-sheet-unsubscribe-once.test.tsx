/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { MemoryMirrorStore, type PressForecast } from "@ohmail/client-engine";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SenderMenu } from "../app/components/sender-menu/SenderMenu";
import en from "../messages/en.json";

const senderAddress = "held" + "@" + "example.invalid";
const time = "2026-09-27T12:00:00.000Z";
const message: EngineMessage = {
  id: "held", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Held letter", from: { name: null, address: senderAddress }, to: [], cc: [],
  date: time, folder: "ohmail/Screener", snippet: "", unread: true,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: time,
};

afterEach(cleanup);

async function openSheet(props: Partial<React.ComponentProps<typeof SenderMenu>>) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{ type: "message", op: "create", id: message.id, seq: 1, updatedAt: time, entity: message }]);
  const sender = senderScreening(store, message.id)!;
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <SenderMenu state={{ messageId: message.id, x: 0, y: 0 }} sender={sender}
        onChoose={() => {}} onOpenDetail={() => {}} onClose={() => {}} {...props} />
    </NextIntlClientProvider>,
  ).getByRole("dialog", { name: en.screening.aria.replace("{sender}", senderAddress) });
}

it.each([
  { kind: "spamUnsubscribe", option: /^Spam/, dest: "spam" },
  { kind: "screenOutUnsubscribe", option: /^Screened out/, dest: "screened" },
] as const)("remembers $kind from the reader sender sheet for the current account", async ({ kind, option, dest }) => {
  const onChoose = vi.fn();
  const saved = new Map<string, Set<string>>();
  const remember = vi.fn((account: string, acknowledgement: string) => {
    const kinds = saved.get(account) ?? new Set();
    kinds.add(acknowledgement);
    saved.set(account, kinds);
  });
  const open = (account: string) => openSheet({
    onChoose,
    lettersFor: () => [{ posture: "one_click", authVerdict: "pass" }],
    unsubscribeRecipientsFor: () => ({ ids: ["held"], senders: 1 }),
    unsubscribeAcknowledgements: {
      has: (acknowledgement: string) => saved.get(account)?.has(acknowledgement) ?? false,
      remember: (acknowledgement: string) => remember(account, acknowledgement),
    },
  });
  const press = (sheet: HTMLElement) => fireEvent.click(within(sheet).getByRole("option", { name: option }));

  let sheet = await open("first");
  press(sheet);
  expect(onChoose).not.toHaveBeenCalled();
  fireEvent.click(within(sheet).getByRole("button", { name: /^Cancel/ }));
  expect(remember).not.toHaveBeenCalled();
  press(sheet);
  fireEvent.click(within(sheet).getByRole("button", { name: en.screening.unsubCommit }));
  expect(remember).toHaveBeenCalledTimes(1);
  expect(remember).toHaveBeenCalledWith("first", kind);
  expect(onChoose).toHaveBeenLastCalledWith(dest, "sender", true, true, undefined, ["held"]);
  cleanup();

  sheet = await open("first");
  press(sheet);
  expect(within(sheet).queryByRole("button", { name: en.screening.unsubCommit })).toBeNull();
  expect(onChoose).toHaveBeenCalledTimes(2);
  expect(onChoose).toHaveBeenLastCalledWith(dest, "sender", true, true, undefined, ["held"]);
  expect(remember).toHaveBeenCalledTimes(1);
  cleanup();

  sheet = await open("second");
  press(sheet);
  expect(within(sheet).getByRole("button", { name: en.screening.unsubCommit })).toBeTruthy();
  expect(onChoose).toHaveBeenCalledTimes(2);
});

it("remembers the unsubscribe acknowledgement when committing a rule disagreement", async () => {
  const outcome = { landing: [], writes: [], moves: [], places: new Map(), seedMove: null };
  const forecast: PressForecast = {
    groups: [{
      cause: "term-subject",
      rule: {
        id: "term", kind: "sender", match: senderAddress, destination: "INBOX",
        priority: 0, provenance: "manual", enabled: true, subjectContains: "Updates",
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: time, updatedAt: time,
      },
      place: "INBOX", rows: ["held"],
    }],
    exception: null,
    keep: outcome,
    remove: outcome,
  };
  const onChoose = vi.fn();
  const saved = new Set<string>();
  const remember = vi.fn((kind: string) => { saved.add(kind); });
  const props = {
    onChoose,
    lettersFor: () => [{ posture: "one_click", authVerdict: "pass" }] as const,
    unsubscribeRecipientsFor: () => ({ ids: ["held"], senders: 1 }),
    unsubscribeAcknowledgements: { has: (kind: string) => saved.has(kind), remember },
  };
  const sheet = within(await openSheet({ ...props, forecastFor: () => forecast }));
  const commitName = new RegExp(`^${en.screening.unsubCommit}`);

  fireEvent.click(sheet.getByRole("option", { name: /^Screened out/ }));
  expect(sheet.getByRole("radiogroup", { name: en.screening.resolveChoiceAria })).toBeTruthy();
  expect(sheet.getByText((text) => text.endsWith(en.screening.unsubFine))).toBeTruthy();
  fireEvent.click(sheet.getByRole("button", { name: commitName }));
  expect(onChoose).toHaveBeenCalledWith("screened", "sender", true, true,
    expect.objectContaining({ forecast }), ["held"]);
  expect(remember).toHaveBeenCalledTimes(1);
  expect(remember).toHaveBeenCalledWith("screenOutUnsubscribe");
  cleanup();

  const nextSheet = within(await openSheet(props));
  fireEvent.click(nextSheet.getByRole("option", { name: /^Screened out/ }));
  expect(nextSheet.queryByRole("button", { name: commitName })).toBeNull();
  expect(onChoose).toHaveBeenLastCalledWith("screened", "sender", true, true, undefined, ["held"]);
});
