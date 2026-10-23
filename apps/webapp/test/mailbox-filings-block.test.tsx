/** @vitest-environment jsdom */
/**
 * SETTINGS → MAILBOXES SHOWS THE FILINGS THAT WAIT. The strip sent the person here and the pane
 * said nothing: no mailbox, no folder, no reason, no action. Each mailbox with waiting filings now
 * gets a block — how many, since when, into which folder, why — and two presses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { ApiError } from "../app/api-client";
import type { FilingFacts, MailboxFacts } from "../app/shell/mail-state";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = Date.parse("2026-10-23T18:15:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

let facts: MailboxFacts[] = [];
const refresh = vi.fn(async () => {});
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailboxFacts: () => facts,
  useMailState: () => ({ state: null, refresh }),
}));

const { MailboxFilings } = await import("../app/shell/MailboxFilings");

const resting: FilingFacts = {
  due: 0, deferred: 0, oldestPendingAt: null, nextAttemptAt: null, attempts: 0,
  lastRefusalClass: null, asOf: new Date(NOW).toISOString(), lastCycleAt: null, stuck: 0, stuckSince: null, stuckRefusalClass: null,
};
const mbx = (id: string, displayName: string | null, filing: Partial<FilingFacts>, over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id, address: `${id}@example.invalid`, displayName, status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: ago(MIN), initialImportCompletedAt: ago(600 * MIN),
  createdAt: ago(900 * MIN), pendingMoves: (filing.due ?? 0) + (filing.deferred ?? 0), filing: { ...resting, ...filing }, ...over,
});
const group = (over: Record<string, unknown> = {}) => ({
  folder: "ohmail/Receipts", count: 6, deferred: 0, stuck: 6, since: ago(345 * MIN), through: ago(300 * MIN),
  nextAttemptAt: null, at: "ohmail/Reads", reasons: [{ reason: "refused", count: 6 }], ...over,
});
const answer = (id: string, groups: unknown[]) => ({ mailboxId: id, asOf: new Date(NOW).toISOString(), more: false, groups });

let api: { read: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };
let root: Root | null = null;
let el: HTMLDivElement;

beforeEach(() => {
  refresh.mockClear();
  api = {
    read: vi.fn(async (id: string) => answer(id, [group()])),
    retry: vi.fn(async () => ({ reset: 6, skipped: 0 })),
    leave: vi.fn(async () => ({ settled: 6, remaining: 0 })),
  };
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  window.location.hash = "#/settings/mailboxes";
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

async function render(locale: "en" | "de" = "en"): Promise<HTMLDivElement> {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC", now: new Date(NOW),
      children: h(MailboxFilings, { api }),
    }));
  });
  await act(async () => { await Promise.resolve(); });
  return el;
}

const button = (label: string): HTMLButtonElement => {
  const b = [...el.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
};

async function press(label: string): Promise<void> {
  await act(async () => { button(label).click(); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe("the waiting filings block", () => {
  it("says how many, into which folder, why and where they are, with both presses", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    const text = (await render()).textContent ?? "";
    expect(api.read).toHaveBeenCalledWith("mbx1");
    expect(text).toContain("Work");
    expect(text).toContain("6 messages wait to be filed into Receipts since");
    expect(text).toContain("the last try did not go through");
    expect(text).toContain("They are in News on your mail server.");
    expect(text).not.toContain("refused it");
    expect(button("Try again now")).toBeTruthy();
    expect(button("Leave them where they are")).toBeTruthy();
  });

  it("counts each reason when they are mixed, and names the next try", async () => {
    facts = [mbx("mbx1", "Work", { deferred: 3, stuck: 0 })];
    api.read.mockResolvedValue(answer("mbx1", [group({
      count: 3, deferred: 2, stuck: 1, at: null, nextAttemptAt: new Date(NOW + 3_600_000).toISOString(),
      reasons: [{ reason: "read_only", count: 2 }, { reason: null, count: 1 }],
    })]));
    const text = (await render()).textContent ?? "";
    expect(text).toContain("the folder will not take it (2)");
    expect(text).toContain("no refusal is recorded (1)");
    expect(text).toMatch(/Next try at \d\d:\d\d/);
    expect(text).not.toContain("on your mail server.");
  });

  it("the mailbox the strip named takes the focus", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 }), mbx("mbx2", "Home", { deferred: 2 })];
    window.location.hash = "#/settings/mailboxes?mailbox=mbx2";
    await render();
    expect(document.activeElement?.textContent).toContain("Home");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("Try again now asks the server, refreshes and says what it did", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    await render();
    await press("Try again now");
    expect(api.retry).toHaveBeenCalledWith("mbx1", "ohmail/Receipts");
    expect(refresh).toHaveBeenCalled();
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[role="status"]')?.textContent).toBe("6 messages will be tried again on the next pass.");
  });

  it("Leave them where they are names the read's bound and refreshes", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    await render();
    await press("Leave them where they are");
    expect(api.leave).toHaveBeenCalledWith("mbx1", "ohmail/Receipts", ago(300 * MIN));
    expect(refresh).toHaveBeenCalled();
    expect(el.querySelector('[role="status"]')?.textContent).toBe("6 messages stay where they are.");
  });

  it("a waiting delete offers no Leave and sends nobody to Restore, which cannot bring it back; a mixed group keeps Leave", async () => {
    facts = [mbx("mbx1", "Work", { due: 2, stuck: 2 })];
    api.read.mockResolvedValue(answer("mbx1", [group({ folder: "Trash", count: 2, deletes: 2, at: "INBOX" })]));
    const text = (await render()).textContent ?? "";
    expect(text).toContain("You deleted them.");
    expect(text).not.toContain("Restore");
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Try again now"]);
    api.read.mockResolvedValue(answer("mbx1", [group({ count: 3, deletes: 1 })]));
    await press("Try again now");
    expect(el.textContent).toContain("1 of them you deleted.");
    expect(el.textContent).not.toContain("Restore");
    expect(button("Leave them where they are")).toBeTruthy();
  });

  it("a failed press changes nothing and says so; another install organizing it says that", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    await render();
    api.retry.mockRejectedValueOnce(new Error("offline"));
    await press("Try again now");
    expect(el.querySelector('[role="status"]')?.textContent).toBe("That did not go through. Nothing was changed.");
    api.leave.mockRejectedValueOnce(new ApiError(409, "organized_elsewhere", "no"));
    await press("Leave them where they are");
    expect(el.querySelector('[role="status"]')?.textContent).toBe("Another install organizes this mailbox now. Nothing was changed.");
  });

  it("an unreadable list keeps the count from the facts and offers no press", async () => {
    facts = [mbx("mbx1", "Work", { due: 4, stuck: 4 })];
    api.read.mockRejectedValue(new Error("offline"));
    const text = (await render()).textContent ?? "";
    expect(text).toContain("4 messages wait to be filed.");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("no block for a reader, a removed mailbox, or one with nothing waiting", async () => {
    facts = [
      mbx("r", "Reader", { due: 2, stuck: 2 }, { organizerRole: "reader" }),
      mbx("d", "Gone", { due: 2, stuck: 2 }, { status: "disabled" }),
      mbx("q", "Quiet", { due: 1, stuck: 0 }),
    ];
    expect((await render()).textContent).toBe("");
    expect(api.read).not.toHaveBeenCalled();
  });

  it("is German in German", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    const text = (await render("de")).textContent ?? "";
    expect(text).toContain("der letzte Versuch ging nicht durch");
    expect(button("Jetzt erneut versuchen")).toBeTruthy();
  });
});
