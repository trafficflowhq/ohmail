/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  deriveMailState, seedGrowth, type FilingFacts, type MailState, type MailStateInputs, type MailboxFacts,
} from "../app/shell/mail-state";

/**
 * THE STUCK STRIP COUNTS WHAT IS STUCK, UNDER ITS OWN CLOCK, FOR THE REASON ON RECORD.
 *
 * Reported: "1 message has not been filed for 75 minutes · your mail server would
 * not say why" over a filing nothing had refused, and "2 messages … 62 minutes" while a
 * seconds-old Screener move sat beside the old one. The derivation and the render are driven
 * together here; the controls keep a real refusal's class and an older server's sentence.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let current: MailState | null = null;
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: current, refresh: () => {} }),
}));

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

const NOW = Date.parse("2026-09-27T01:12:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const resting: FilingFacts = {
  due: 0, deferred: 0, oldestPendingAt: null, nextAttemptAt: null, attempts: 0,
  lastRefusalClass: null, asOf: new Date(NOW).toISOString(), lastCycleAt: ago(20_000),
};

const mailbox = (filing: Partial<FilingFacts>): MailboxFacts => ({
  id: "mb1", address: "person@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: ago(30_000),
  initialImportCompletedAt: ago(600_000), createdAt: ago(900_000),
  filing: { ...resting, ...filing },
});

const inputs = (filing: Partial<FilingFacts>): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false },
  failureStreak: 3, mailboxes: [mailbox(filing)], mirrored: 495, growth: seedGrowth(495),
  freshness: { state: "current" as const, asOf: ago(30_000) },
  engineFreshness: { state: "current" as const, asOf: ago(30_000) },
  now: NOW, demo: false,
} as MailStateInputs);

async function strip(filing: Partial<FilingFacts>, locale: "en" | "de" = "en"): Promise<string> {
  return (await stripOf([mailbox(filing)], locale)).text;
}

/** The strip over several mailboxes: its text and the link it offers. */
async function stripOf(mbs: MailboxFacts[], locale: "en" | "de" = "en"): Promise<{ text: string; hrefs: string[] }> {
  current = deriveMailState({ ...inputs({}), mailboxes: mbs });
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC", now: new Date(NOW),
      children: h(SyncBar, null),
    }));
  });
  return {
    text: container.textContent ?? "",
    hrefs: [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? ""),
  };
}

const named = (id: string, displayName: string | null, filing: Partial<FilingFacts>, address = `${id}@example.invalid`): MailboxFacts =>
  ({ ...mailbox(filing), id, address, displayName });

describe("the stuck filing sentence", () => {
  it("a filing nothing refused is not blamed on the mail server", async () => {
    const text = await strip({
      due: 1, oldestPendingAt: ago(75 * MIN), stuck: 1, stuckSince: ago(75 * MIN), stuckRefusalClass: null,
    });
    expect(text).toContain("1 message has not been filed for 1 hour");
    expect(text, "a filing nothing refused was blamed on the server").not.toContain("would not say why");
    expect(text).not.toContain("refused");
    expect(text).toContain("no refusal is recorded");
  });

  it("a seconds-old move beside a stuck one is not counted under the old one's clock", async () => {
    const text = await strip({
      due: 2, oldestPendingAt: ago(62 * MIN), stuck: 1, stuckSince: ago(62 * MIN), stuckRefusalClass: null,
    });
    expect(text, "the fresh move was counted as stuck").toContain("1 message has not been filed for 1 hour");
    expect(text).not.toContain("2 messages");
  });

  it("the clock is the stuck rows' own, and the reason is theirs", async () => {
    // The oldest outstanding row (40 min, never refused) and a refused row stuck on its attempts
    // (3 min old): the count and the clock name the stuck row, never the other one.
    const text = await strip({
      due: 1, deferred: 1, attempts: 2, oldestPendingAt: ago(4 * MIN), lastRefusalClass: "over_quota",
      stuck: 1, stuckSince: ago(3 * MIN), stuckRefusalClass: "over_quota",
    });
    expect(text).toContain("1 message has not been filed for 3 minutes");
    expect(text).toContain("the mailbox is full");
  });

  it.each([
    ["stale_locator", "ohmail lost track of it on your mail server"],
    ["unconfirmed", "ohmail could not confirm the move"],
  ])("a failure on our side (%s) names itself, never the unknown reason", async (cls, words) => {
    const text = await strip({
      due: 1, attempts: 2, oldestPendingAt: ago(75 * MIN), lastRefusalClass: cls,
      stuck: 1, stuckSince: ago(75 * MIN), stuckRefusalClass: cls,
    });
    expect(text).toContain(words);
  });

  it("CONTROL — a real refusal still reads its class", async () => {
    const text = await strip({
      deferred: 1, attempts: 3, oldestPendingAt: ago(10 * MIN), lastRefusalClass: "read_only",
      nextAttemptAt: new Date(NOW + 3_600_000).toISOString(),
      stuck: 1, stuckSince: ago(10 * MIN), stuckRefusalClass: "read_only",
    });
    expect(text).toContain("1 message has not been filed for 10 minutes");
    expect(text).toContain("the folder will not take it");
  });

  it("CONTROL — a seconds-old move alone is filing, not stuck", async () => {
    const text = await strip({ due: 1, oldestPendingAt: ago(20_000), stuck: 0, stuckSince: null, stuckRefusalClass: null });
    expect(text).toContain("Filing 1 message on your mail server");
    expect(text).not.toContain("not been filed");
  });

  it("CONTROL — an older server without the stuck fields keeps the old count", async () => {
    const text = await strip({ due: 2, oldestPendingAt: ago(62 * MIN) });
    expect(text).toContain("2 messages have not been filed for 1 hour");
    expect(text).toContain("no refusal is recorded");
  });

  it("is German in German", async () => {
    const text = await strip({
      due: 1, oldestPendingAt: ago(75 * MIN), stuck: 1, stuckSince: ago(75 * MIN), stuckRefusalClass: null,
    }, "de");
    expect(text).toContain("1 Nachricht wurde seit 1 Stunde nicht einsortiert");
    expect(text).toContain("keine Ablehnung verzeichnet");
    expect(text).not.toContain("nennt keinen Grund");
  });
});

/**
 * THE STRIP NAMES THE MAILBOX AND ITS OWN REASON, AND SAYS NOTHING THE SERVER DID NOT SAY.
 *
 * Reported: "6 messages have not been filed for 345 minutes · your mail server refused it ·
 * Settings → Mailboxes" while Settings looked fine. The six were on one mailbox, the class was the
 * catch-all a dropped connection lands in, and the link opened the list, not the mailbox.
 */
describe("the stuck and waiting sentences name the mailbox and the reason on record", () => {
  const reported = { due: 6, attempts: 1, oldestPendingAt: ago(345 * MIN), lastRefusalClass: "refused",
    stuck: 6, stuckSince: ago(345 * MIN), stuckRefusalClass: "refused" };

  it("the reported case: hours, the mailbox by name, neutral words, one link to that mailbox", async () => {
    const r = await stripOf([named("mbx1", "Work", reported)]);
    expect(r.text).toContain("6 messages have not been filed for 5 hours");
    expect(r.text).toContain("Work · the last try did not go through");
    expect(r.text).not.toContain("refused it");
    expect(r.text.split("Settings → Mailboxes").length - 1, "the pane was named twice").toBe(1);
    expect(r.hrefs).toEqual(["#/settings/mailboxes?mailbox=mbx1"]);
  });

  it("two mailboxes with different reasons say so, and link to the first", async () => {
    const r = await stripOf([
      named("mbx1", "Work", { due: 1, oldestPendingAt: ago(80 * MIN), stuck: 1, stuckSince: ago(80 * MIN), stuckRefusalClass: null }),
      named("mbx2", "Home", {
        deferred: 5, attempts: 3, oldestPendingAt: ago(30 * MIN), lastRefusalClass: "read_only",
        nextAttemptAt: new Date(NOW + 3_600_000).toISOString(), stuck: 5, stuckSince: ago(30 * MIN), stuckRefusalClass: "read_only",
      }),
    ]);
    expect(r.text).toContain("6 messages have not been filed for 1 hour");
    expect(r.text).toContain("2 mailboxes · the reasons differ by mailbox");
    expect(r.text).not.toContain("the folder will not take it");
    expect(r.hrefs).toEqual(["#/settings/mailboxes?mailbox=mbx1"]);
  });

  it("two mailboxes with the same reason name it", async () => {
    const full = { deferred: 1, attempts: 2, oldestPendingAt: ago(9 * MIN), lastRefusalClass: "over_quota",
      nextAttemptAt: new Date(NOW + 600_000).toISOString(), stuck: 1, stuckSince: ago(9 * MIN), stuckRefusalClass: "over_quota" };
    const r = await stripOf([named("mbx1", "Work", full), named("mbx2", "Home", full)]);
    expect(r.text).toContain("2 mailboxes · the mailbox is full");
  });

  it("waiting: the mailbox, the reason and the next try, and no 'was refused'", async () => {
    const r = await stripOf([named("mbx2", "Home", {
      deferred: 2, attempts: 1, oldestPendingAt: ago(2 * MIN), lastRefusalClass: "no_such_folder",
      nextAttemptAt: new Date(NOW + 3_600_000).toISOString(), stuck: 0, stuckSince: null, stuckRefusalClass: null,
    })]);
    expect(r.text).toContain("2 messages wait for the next try");
    expect(r.text).toMatch(/Home · the folder is not there · next try at \d\d:\d\d/);
    expect(r.text).not.toContain("was refused");
    expect(r.hrefs).toEqual(["#/settings/mailboxes?mailbox=mbx2"]);
  });

  it("a mailbox with no display name is named by its address, decoded", async () => {
    const r = await stripOf([named("mbx3", null, reported, "post@xn--bcher-kva.example")]);
    expect(r.text).toContain("post@bücher.example · the last try did not go through");
  });

  it("is German in German", async () => {
    const r = await stripOf([named("mbx1", "Work", reported)], "de");
    expect(r.text).toContain("6 Nachrichten wurden seit 5 Stunden nicht einsortiert");
    expect(r.text).toContain("Work · der letzte Versuch ging nicht durch");
    expect(r.text).not.toContain("abgewiesen");
  });
});
