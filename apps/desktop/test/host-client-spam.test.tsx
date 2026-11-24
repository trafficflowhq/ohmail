/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { EngineMessage } from "@ohmail/wire";
import { BearerManager } from "../../../test/support/paired-mail-fixtures.js";
import { HostGate } from "../../../test/support/paired-mail-fixtures.js";
import { en as messages } from "../../../test/support/web-catalogues.js";

const NOW = "2026-08-18T09:00:00.000Z";
const ACCOUNT = "mirror-account";
const OTHER = "other-account";
const noop = () => undefined;
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  localStorage.clear();
  window.history.replaceState(null, "", "/#/screener");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media, matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop,
  }));
  vi.stubGlobal("IntersectionObserver", class {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
  });
  Element.prototype.scrollIntoView ??= noop;
  vi.stubGlobal("fetch", async () => { throw new Error("the paired frame only uses its bearer transport"); });
});

afterEach(() => {
  cleanup();
  resetStorageOwnerForTest();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mail = (id: string, accountId: string, folder: EngineMessage["folder"], hour: number): EngineMessage => ({
  id, subject: id, accountId, mailboxId: "paired-mailbox", folder,
  date: new Date(Date.parse(NOW) - hour * 3_600_000).toISOString(),
  updatedAt: NOW, threadId: null, messageIdHeader: null, to: [], cc: [],
  from: { name: "Weekly lists", address: "weekly@lists.example.invalid" },
  snippet: id, unread: true, attachmentCount: 0, hasAttachments: false, triage: null, labels: [],
  remoteContent: "none",
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
});

function snapshot(account: string, prefix: string): Response {
  const rows = [
    mail(`${prefix} held`, account, "ohmail/Screener", 0),
    mail(`${prefix} Inbox`, account, "INBOX", 1),
    mail("Foreign held", account === ACCOUNT ? OTHER : ACCOUNT, "ohmail/Screener", 2),
    mail("Foreign Inbox", account === ACCOUNT ? OTHER : ACCOUNT, "INBOX", 3),
  ];
  return Response.json({
    asOfSeq: 5, nextCursor: null, window: { days: 90, minRows: 500 },
    changes: rows.map((entity) => ({
      seq: 5, id: entity.id, type: "message", op: "create", entity, updatedAt: NOW,
    })),
  }, { headers: { "x-ohmail-mirror-account": account } });
}

function setup(answerSnapshot: (scope: string | null) => Response | Promise<Response>) {
  const filing: Array<{ scope: string | null; path: string; body: unknown }> = [];
  const bearer: BearerManager = new BearerManager({
    storage: localStorage,
    idb: null,
    fetchImpl: async (url, init): Promise<Response> => {
      const path = new URL(url, window.location.origin).pathname;
      const { method, body } = (init ?? {}) as RequestInit;
      if (path === "/sync/snapshot") return answerSnapshot(bearer.pairScope());
      if (method === "POST" && (/^\/screener\/[^/]+$/.test(path) || path.endsWith("/move") || path === "/rules")) {
        filing.push({ scope: bearer.pairScope(), path: decodeURIComponent(path), body: JSON.parse(String(body)) });
        return Response.json({});
      }
      if (path === "/mailboxes") return Response.json({ items: [{
        id: "paired-mailbox", address: "receiver@example.invalid", status: "connected", lastSyncAt: NOW,
        organizerRole: "organizer", organizeConsentedAt: NOW, providerConfirms: false,
      }] });
      if (path === "/consent") return Response.json({ seedConfirmedAt: NOW, dormancyDays: 60, counts: {} });
      return Response.json({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "5", hasMore: false, serverTime: NOW,
      });
    },
  });
  const pair = (fixture: string) => {
    bearer.adopt({ accessToken: fixture, refreshToken: fixture }, { fresh: true });
    return bearer.pairScope();
  };
  const frame = () => (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ThemeProvider><ToastHost><HostGate bearer={bearer} /></ToastHost></ThemeProvider>
    </IntlProvider>
  );
  return { filing, pair, frame };
}

async function pressSpam(container: HTMLElement, prefix: string) {
  const ui = within(container);
  await advance(300);
  const row = ui.getByRole("option", { name: new RegExp(`${prefix} held`) });
  await act(async () => { row.click(); });
  await advance(50);
  const reading = within(ui.getByRole("region", { name: "Reading" }));
  expect(reading.getAllByText(`${prefix} Inbox`, { exact: true }).length).toBeGreaterThan(0);
  const panel = within(ui.getByRole("toolbar", { name: messages.screener.place.panel }));
  const spam = panel.getByRole("button", { name: /^Spam\b/ });
  expect(spam).toHaveProperty("disabled", false);
  await act(async () => { spam.click(); });
  await advance(COMMIT_MS + 300);
}

function expectedFiling(scope: string | null, prefix: string) {
  return [
    { scope, path: `/screener/${prefix} held`, body: {
      decision: "no", dest: "ohmail/Quarantine", scope: "confirmed_sender",
      confirmedIds: [`${prefix} held`], applyRetro: false,
    } },
    { scope, path: `/messages/${prefix} Inbox/move`, body: {
      folder: "ohmail/Quarantine", from: "INBOX", pressRule: true,
    } },
  ];
}

it("files the paired browser's inspected Spam on the mirror account only", async () => {
  const { frame, pair, filing } = setup(() => snapshot(ACCOUNT, "First"));
  const scope = pair("first");
  expect(scope).not.toBeNull();
  expect(scope).not.toBe(ACCOUNT);
  const view = render(frame());
  await pressSpam(view.container, "First");
  expect(filing).toEqual(expectedFiling(scope, "First"));
});

it("discards a snapshot that arrives after the browser pairs to another account", async () => {
  let release!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => { release = resolve; });
  let askedFirst = false;
  let first: string | null;
  const { frame, pair, filing } = setup((scope) => {
    if (scope !== first) return snapshot(OTHER, "Second");
    askedFirst = true;
    return late;
  });
  first = pair("first");
  const view = render(frame());
  await advance(300);
  expect(askedFirst).toBe(true);

  const second = pair("second");
  expect(second).not.toBe(first);
  view.rerender(frame());
  await advance(300);
  await act(async () => { release(snapshot(ACCOUNT, "First")); });
  await pressSpam(view.container, "Second");
  expect(filing).toEqual(expectedFiling(second, "Second"));
});
