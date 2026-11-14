/** @vitest-environment jsdom */
import { createElement } from "react";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleShell } from "../app/(product)/LocaleShell";
import { fillFrom } from "../app/shell/locale";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";

const build = vi.hoisted(() => ({ selfHost: false }));
vi.mock("../app/hello", async (load) => ({
  ...await load<typeof import("../app/hello")>(),
  get SELF_HOST_BUILD() { return build.selfHost; },
}));

const CREDIT_WORDS = { en: /credit|AI budget/i, de: /Punkt|Guthaben|KI-Budget/i } as const;
type Locale = keyof typeof CREDIT_WORDS;

beforeEach(installConfirmEnv);
afterEach(teardownConfirmEnv);

async function mountQuote(
  hash: "#/screener" | "#/settings/screener",
  locale: Locale,
  managed: boolean,
  count: number,
) {
  build.selfHost = !managed;
  rememberOwner();
  scriptSession(sessionFull);
  scriptRefresh(refresh204);
  const receivedAt = "2026-09-04T12:30:00Z";
  const queue = Array.from({ length: count }, (_, index) => {
    const id = `held-${index + 1}`;
    return {
      messageId: id,
      mailboxId: "mb_1",
      sender: { name: id, address: `${id}@example.invalid` },
      receivedAt,
      subject: `Letter ${index + 1}`,
      snippet: "A held letter",
    };
  });
  scriptSync(() => Response.json({
    changes: {
      creates: queue.map((letter, index) => ({
        type: "message", op: "create", id: letter.messageId, seq: index + 1, updatedAt: receivedAt,
        entity: {
          id: letter.messageId, accountId: ACCOUNT, mailboxId: letter.mailboxId, threadId: null,
          subject: letter.subject, from: letter.sender, to: [], cc: [], date: receivedAt, sortAt: receivedAt,
          folder: "ohmail/Screener", snippet: letter.snippet,
          unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {}, labels: [],
        },
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: "held", hasMore: false, serverTime: ISO,
  }));

  const quoteRequests: number[] = [];
  const fallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/account/access") return Response.json({ metered: managed, aiEnabled: true });
    if (path === "/api/consent") return Response.json({
      seedConfirmedAt: "2026-09-04T11:00:00Z", screeningResetAt: null, dormancyDays: 60,
      autoSuggestAt: null,
      counts: { decidedSenders: 0, activeUndecidedSenders: count, dormantUndecidedSenders: 0 },
    });
    if (path === "/api/account/screening") return Response.json({
      ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "",
    });
    if (path === "/api/screener") return Response.json({ items: queue, total: count, nextCursor: null });
    if (path === "/api/screener/suggest") {
      const ask = JSON.parse(String(init?.body)) as { dryRun?: boolean; senders: string[] };
      expect(ask.dryRun).toBe(true);
      quoteRequests.push(ask.senders.length);
      const senders = ask.senders.length;
      return Response.json({
        dryRun: true, requested: senders, quoted: senders, quotedCredits: managed ? senders : 0,
        charged: 0, suggestions: [], skipped: [],
      });
    }
    if (path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: "owner@example.invalid", status: "connected",
        organizerRole: "organizer", organizeConsentedAt: "2026-09-04T11:00:00Z", lastSyncAt: "2026-09-04T12:30:00Z",
      }] });
    }
    return fallback(input, init);
  };

  window.location.hash = hash;
  const catalogue = locale === "en" ? en : de;
  const container = await mountCloudShell((shell) => createElement(LocaleShell, {
    initialLocale: locale,
    initialMessages: fillFrom(en as never, catalogue as never) as never,
    children: shell,
  }));
  const view = within(container);
  await tick(1_000);
  const offer = hash === "#/screener"
    ? view.getByRole("button", { name: catalogue.screener.suggest.open })
    : view.getByRole("switch", { name: catalogue.screener.suggest.autoTitle });
  await act(async () => { offer.click(); });
  if (hash === "#/settings/screener") {
    expect(quoteRequests).toEqual([]);
    const approve = view.getByRole("button", { name: catalogue.screener.suggest.autoQuoteApprove });
    await act(async () => { approve.click(); });
  }
  await tick(1_000);
  expect(quoteRequests).toEqual([count]);
  return container;
}

describe("the auto-suggest confirm", () => {
  it("CONTROL — a managed host states the cost sentence and the quote's credits", async () => {
    const view = within(await mountQuote("#/settings/screener", "en", true, 3));
    expect(view.getByText(en.screener.suggest.autoCost).textContent).toBe(en.screener.suggest.autoCost);
    expect(view.getByText("3 senders · 3 credits")).toBeTruthy();
  });

  it.each(["en", "de"] as const)("%s: an unmetered host counts senders and names no credits", async (locale) => {
    const container = await mountQuote("#/settings/screener", locale, false, 3);
    expect(within(container).getByText(locale === "en" ? "3 senders" : "3 Absender")).toBeTruthy();
    expect(container.textContent).not.toMatch(CREDIT_WORDS[locale]);
  });
});

describe("the Screener's suggest quote", () => {
  it("CONTROL — a managed host quotes senders and credits", async () => {
    const view = within(await mountQuote("#/screener", "en", true, 4));
    expect(view.getByText("4 senders · 4 credits")).toBeTruthy();
  });

  it.each(["en", "de"] as const)("%s: an unmetered host quotes senders only", async (locale) => {
    const container = await mountQuote("#/screener", locale, false, 4);
    expect(within(container).getByText(locale === "en" ? "4 senders" : "4 Absender")).toBeTruthy();
    expect(container.textContent).not.toMatch(CREDIT_WORDS[locale]);
  });
});
