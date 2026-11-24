/** @vitest-environment jsdom */
/**
 * SETTINGS → MAILBOXES SHOWS THE FILINGS THAT WAIT. The strip sent the person here and the pane
 * said nothing: no mailbox, no folder, no reason, no action. Each mailbox with waiting filings now
 * gets a block — how many, since when, into which folder, why — and two presses.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { createElement } from "react";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO } from "../app/api-client";
import type { FilingFacts } from "@ohmail/app-logic/mail-state/mail-state";

import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const NOW = Date.parse(ISO);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

let facts: MailboxDTO[] = [];

const resting: FilingFacts = {
  due: 0, deferred: 0, oldestPendingAt: null, nextAttemptAt: null, attempts: 0,
  lastRefusalClass: null, asOf: new Date(NOW).toISOString(), lastCycleAt: null, stuck: 0, stuckSince: null, stuckRefusalClass: null,
};
const mbx = (id: string, displayName: string | null, filing: Partial<FilingFacts>, over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id, provider: "imap", organizerRole: "organizer", organizeConsentedAt: ago(600 * MIN), address: `${id}@example.invalid`, displayName, status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: ago(MIN), initialImportCompletedAt: ago(600 * MIN),
  createdAt: ago(900 * MIN), pendingMoves: (filing.due ?? 0) + (filing.deferred ?? 0), filing: { ...resting, ...filing }, ...over,
});
const group = (over: Record<string, unknown> = {}) => ({
  folder: "ohmail/Receipts", count: 6, deferred: 0, stuck: 6, since: ago(345 * MIN), through: ago(300 * MIN),
  nextAttemptAt: null, at: "ohmail/Reads", reasons: [{ reason: "refused", count: 6 }], ...over,
});
const answer = (id: string, groups: unknown[]) => ({ mailboxId: id, asOf: new Date(NOW).toISOString(), more: false, groups });

let api: { read: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };
let el: HTMLElement;
let rosterReads: number;
const scroll = vi.fn();

beforeAll(warmCloudShell);
beforeEach(async () => {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  (await import("../app/api-client")).bindApiOwner(null);
  rosterReads = 0;
  scroll.mockClear();
  Element.prototype.scrollIntoView = scroll;
  api = {
    read: vi.fn(async (id: string) => answer(id, [group()])),
    retry: vi.fn(async () => ({ reset: 6, skipped: 0 })),
    leave: vi.fn(async () => ({ settled: 6, remaining: 0 })),
  };
  window.location.hash = "#/settings/mailboxes";
});

afterEach(async () => {
  await teardownConfirmEnv();
  (await import("../app/api-client")).bindApiOwner(null);
});

function mailboxRow(pane: HTMLElement, mailbox: MailboxDTO, expanded: boolean): HTMLElement {
  return within(pane).getByRole("button", { name: (name) => name.includes(mailbox.address), expanded });
}

async function render(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/account/access") return Response.json({ metered: false });
    if (path === "/api/mailboxes" && method === "GET") {
      rosterReads += 1;
      return Response.json({ items: facts });
    }
    const filing = /^\/api\/mailboxes\/([^/]+)\/filings(?:\/(retry|leave))?$/.exec(path);
    if (filing) {
      const [, id, action] = filing;
      try {
        if (!action && method === "GET") return Response.json(await api.read(id));
        if (method === "POST") {
          const { folder, through } = JSON.parse(String(init?.body)) as { folder: string; through?: string };
          if (action === "retry") return Response.json(await api.retry(id, folder));
          if (action === "leave") return Response.json(await api.leave(id, folder, through));
        }
      } catch (error) {
        const elsewhere = error instanceof Error && error.message === "organized_elsewhere";
        return Response.json(
          { error: { code: elsewhere ? "organized_elsewhere" : "internal", message: "The operation did not go through." } },
          { status: elsewhere ? 409 : 500 },
        );
      }
    }
    return fetch(input, init);
  };
  const words = locale === "de" ? de : en;
  const named = new URLSearchParams(window.location.hash.split("?")[1]).has("mailbox");
  const frame = await mountCloudShell(locale === "de"
    ? (shell) => createElement(NextIntlClientProvider, { locale, messages: de, timeZone: "UTC", children: shell })
    : undefined);
  await tick(3000);
  el = within(frame).getByRole("region", { name: words.settings.mailboxes });
  if (!named) {
    for (const mailbox of facts) {
      await act(async () => { mailboxRow(el, mailbox, false).click(); });
      await tick(100);
    }
  }
  return el;
}

const button = (name: string): HTMLElement => within(el).getByRole("button", { name });
const filingButtons = (): HTMLElement[] =>
  within(el).queryAllByRole("button", { name: /^(Try again now|Leave them where they are)$/ });
const status = (): Array<string | null> => within(el).getAllByRole("status").map((line) => line.textContent);

async function press(label: string): Promise<void> {
  await act(async () => { button(label).click(); });
  await tick(100);
}

describe("the waiting filings block", () => {
  it("says how many, into which folder, why and where they are, with both presses", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    const text = (await render()).textContent ?? "";
    expect(api.read).toHaveBeenCalledWith("mbx1");
    expect(within(el).getByRole("heading", { name: "Waiting to be filed · Work" })).toBeTruthy();
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
    expect(document.activeElement).toBe(within(el).getByRole("heading", { name: "Waiting to be filed · Home" }));
    expect(scroll).toHaveBeenCalled();
  });

  it("Try again now asks the server, refreshes and says what it did", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    await render();
    const before = rosterReads;
    await press("Try again now");
    expect(api.retry).toHaveBeenCalledWith("mbx1", "ohmail/Receipts");
    expect(rosterReads).toBeGreaterThan(before);
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(status()).toContain("6 messages will be tried again on the next pass.");
  });

  it("Leave them where they are names the read's bound and refreshes", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    await render();
    const before = rosterReads;
    await press("Leave them where they are");
    expect(api.leave).toHaveBeenCalledWith("mbx1", "ohmail/Receipts", ago(300 * MIN));
    expect(rosterReads).toBeGreaterThan(before);
    expect(status()).toContain("6 messages stay where they are.");
  });

  it("a waiting delete offers no Leave and sends nobody to Restore, which cannot bring it back; a mixed group keeps Leave", async () => {
    facts = [mbx("mbx1", "Work", { due: 2, stuck: 2 })];
    api.read.mockResolvedValue(answer("mbx1", [group({ folder: "Trash", count: 2, deletes: 2, at: "INBOX" })]));
    const text = (await render()).textContent ?? "";
    expect(text).toContain("You deleted them.");
    expect(text).not.toContain("Restore");
    expect(filingButtons().map((b) => b.textContent)).toEqual(["Try again now"]);
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
    expect(status()).toContain("That did not go through. Nothing was changed.");
    api.leave.mockRejectedValueOnce(new Error("organized_elsewhere"));
    await press("Leave them where they are");
    expect(status()).toContain("Another install organizes this mailbox now. Nothing was changed.");
  });

  it("an unreadable list keeps the count from the facts and offers no press", async () => {
    facts = [mbx("mbx1", "Work", { due: 4, stuck: 4 })];
    api.read.mockRejectedValue(new Error("offline"));
    const text = (await render()).textContent ?? "";
    expect(text).toContain("4 messages wait to be filed.");
    expect(filingButtons()).toHaveLength(0);
  });

  it("no block for a reader, a removed mailbox, or one with nothing waiting", async () => {
    facts = [
      mbx("r", "Reader", { due: 2, stuck: 2 }, { organizerRole: "reader" }),
      mbx("d", "Gone", { due: 2, stuck: 2 }, { status: "disabled" }),
      mbx("q", "Quiet", { due: 1, stuck: 0 }),
    ];
    expect((await render()).textContent).not.toMatch(/messages wait to be filed/);
    expect(filingButtons()).toHaveLength(0);
    expect(api.read).not.toHaveBeenCalled();
  });

  it("is German in German", async () => {
    facts = [mbx("mbx1", "Work", { due: 6, stuck: 6 })];
    const text = (await render("de")).textContent ?? "";
    expect(text).toContain("der letzte Versuch ging nicht durch");
    expect(button("Jetzt erneut versuchen")).toBeTruthy();
  });
});
