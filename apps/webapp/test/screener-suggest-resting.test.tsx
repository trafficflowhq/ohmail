/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { fireEvent, within } from "@testing-library/react";
import { quotedResponse } from "../../../test/support/screener-quote";
import messages from "../messages/en.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import {
  ACCOUNT, act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick,
} from "./fixtures/cloud-confirm-shell";

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-09-04T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-04T09:00:00.000Z",
  };
}

// ── the wire, recorded ────────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: { senders?: string[]; dryRun?: boolean } | null;
  idempotencyKey: string | null;
}

let calls: Recorded[] = [];
let host: HTMLElement | null = null;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** What `GET /screener` answers — the already-bought half, which is the whole queue here. */
let listReply: () => Response;
/** What `POST /screener/suggest` answers next. */
let suggestReply: (body: { senders: string[]; dryRun?: boolean }) => Response;

const dryRuns = () => calls.filter((c) => c.path.startsWith("/screener/suggest") && c.body?.dryRun === true);
const purchases = () => calls.filter((c) => c.path.startsWith("/screener/suggest") && c.body?.dryRun !== true);

function installFetch(autoSuggest: boolean): void {
  const shellFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("/api/consent")) return json({
      seedConfirmedAt: ISO, foldersEnabledAt: ISO, dormancyDays: 60, autoSuggestAt: autoSuggest ? ISO : null,
      counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
    });
    if (url.startsWith("/api/mailboxes")) return json({ items: [{
      id: "mb", address: "owner@example.invalid", status: "active", lastSyncAt: ISO,
      organizerRole: "organizer", organizeConsentedAt: ISO, createdAt: ISO,
    }] });
    if (!/^\/api\/screener(?:\?|$|\/suggest$)/.test(url)) return shellFetch(input, init);
    const path = url.replace(/^\/api/, "");
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Recorded["body"]) : null;
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: raw,
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    if (path.startsWith("/screener/suggest")) {
      const body = raw as { senders: string[]; dryRun?: boolean };
      const response = suggestReply(body);
      return body.dryRun ? quotedResponse(response, body.senders, (sender) =>
        SEVENTY_FOUR.find((letter) => letter.from.address === sender)!.id) : response;
    }
    return listReply();
  }) as typeof fetch;
}

const text = () => host?.textContent ?? "";
const buttons = () => within(host!);
const exactNames = (letters: EngineMessage[]) => letters.map((letter) => letter.from.address);

async function press(name: string | RegExp): Promise<void> {
  const button = within(document.body).getByRole("button", { name });
  await act(async () => { fireEvent.click(button); });
  await tick(0);
}

const pressConfirmAgain = () => press(/^Suggest again for /);

beforeEach(() => {
  resetSessionTruthForTests();
  installConfirmEnv();
  resetStorageOwnerForTest();
  scriptRefresh(refresh204);
  scriptSession(() => sessionFull());
  rememberOwner();
  window.localStorage.clear();
  vi.stubGlobal("innerWidth", 1280);
  calls = [];
  listReply = () => answers([]);
  suggestReply = () => json({ dryRun: true, requested: 0, quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [] });
});
afterEach(async () => {
  window.history.replaceState(null, "", "/");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  resetStorageOwnerForTest();
  await teardownConfirmEnv();
  vi.unstubAllGlobals();
  host = null;
});

const waiting = (count: number) => Array.from({ length: count }, (_, i) =>
  held(`m${String(i).padStart(2, "0")}`, `s${i}@ex.example`, 11 - i % 10));
const TWELVE = waiting(12);
const SEVENTY_FOUR = waiting(74);

function answers(letters: EngineMessage[], answered = letters.length) {
  return json({
    items: letters.map((letter, i) => ({
      id: letter.id, messageId: letter.id, sender: { name: null, address: letter.from.address },
      subject: letter.subject, snippet: letter.snippet, receivedAt: letter.date,
      aiSuggestion: i < answered ? {
        decision: i % 2 === 0 ? "yes" : "no",
        confidence: 0.8,
        rationale: `because ${i}`,
      } : null,
    })),
    nextCursor: null,
    suggestable: { senders: [], credits: 0, maxPerRequest: 50 },
  });
}
const allAnswered = () => answers(TWELVE);

async function mountLive(letters = TWELVE, autoSuggest = false): Promise<void> {
  installFetch(autoSuggest);
  scriptSync(() => json({
    changes: {
      creates: letters.map((entity, i) => ({
        type: "message", op: "create", id: entity.id, seq: i + 1, updatedAt: ISO, entity,
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: "c1", hasMore: false, serverTime: ISO,
  }));
  window.location.hash = "#/ohbox";
  host = await mountCloudShell();
  await tick(2500);
  await act(async () => {
    window.location.hash = "#/screener";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await act(async () => { await vi.dynamicImportSettled(); });
  await tick(2500);
}

describe("a Screener with nothing left to buy still shows the AI surface", () => {
  it("states how many senders have an answer, instead of vanishing", async () => {
    listReply = () => answers(SEVENTY_FOUR);
    await mountLive(SEVENTY_FOUR);
    expect(within(buttons().getByRole("group", { name: "Act on all waiting senders" }))
      .getByRole("status").textContent).toBe("All 74 senders have a suggestion.");
    expect(buttons().queryByRole("button", { name: "All 74 senders have a suggestion." })).toBeNull();
    expect(buttons().queryByRole("button", { name: "Suggest…" })).toBeNull();
  });

  it("offers the re-ask beside it — the one action still true", async () => {
    listReply = allAnswered;
    await mountLive();
    expect(buttons().getByRole("button", { name: "Suggest again…" })).toBeTruthy();
  });

  it("renders NOTHING when there is also nothing to ask about again", async () => {
    await mountLive([]);
    expect(buttons().queryByRole("button", { name: /^Suggest/ })).toBeNull();
    expect(text()).not.toContain("have a suggestion.");
  });

  it("still opens the ordinary buy control while the queue is mixed", async () => {
    listReply = () => answers(TWELVE, 7);
    await mountLive();
    expect(buttons().getByRole("button", { name: "Suggest…" })).toBeTruthy();
    expect(buttons().getByRole("button", { name: "Suggest again…" })).toBeTruthy();
    expect(text()).not.toContain("have a suggestion.");
  });

  it("labels the ladder's largest size off the set it is bound to, not off the buy list", async () => {
    listReply = () => answers(SEVENTY_FOUR);
    const newlyQuoted = exactNames(SEVENTY_FOUR.slice(0, 3));
    suggestReply = (body) => {
      const quoted = body.senders.length === 10 ? 0 : body.senders.filter((sender) => newlyQuoted.includes(sender)).length;
      return json({
        dryRun: true, requested: body.senders.length, quoted, quotedCredits: quoted,
        charged: 0, suggestions: [], skipped: [],
      });
    };
    await mountLive(SEVENTY_FOUR);
    await press("Suggest again…");
    expect(document.body.textContent).toContain("all 74");
    expect(within(document.body).getByRole("dialog", { name: messages.screener.suggest.ariaAgain })).toBeTruthy();
    expect(document.body.textContent).toContain("Suggest again for 3 senders");
    await press("10");
    const menu = within(document.body).getByRole("dialog", { name: messages.screener.suggest.ariaAgain });
    expect(within(menu).getByRole("status").textContent).toBe("No senders in this selection need a new suggestion.");
    expect(within(menu).queryByRole("button", { name: /^Suggest again for / })).toBeNull();
    await press("all 74");
    expect(within(menu).getByRole("button", { name: "Suggest again for 3 senders" })).toBeTruthy();
    expect(purchases()).toHaveLength(0);
  });
});

describe("re-asking enters the EXISTING quote → confirm → purchase flow", () => {
  it("prices the ALREADY-ANSWERED senders on the server before anything is pressable", async () => {
    listReply = allAnswered;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        // The reported shape: one sender has new mail since the answer was bought, eleven do not.
        quoted: 1, quotedCredits: 1, charged: 0, suggestions: [], skipped: [],
      });
    await mountLive();
    expect(buttons().queryByRole("button", { name: "Suggest…" })).toBeNull();
    expect(buttons().getByRole("button", { name: /^Apply 12 —/ })).toBeTruthy();

    await press("Suggest again…");
    // A DRY RUN FIRST, over the senders that HAVE an answer — never the (empty) buy list.
    // RED if `confirm`/`price` slice `addresses`: the posted set is empty and no price arrives.
    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0]!.body?.senders).toHaveLength(12);
    expect(new Set(dryRuns()[0]!.body?.senders)).toEqual(new Set(exactNames(TWELVE)));
    // And nothing was bought to learn the price.
    expect(purchases()).toHaveLength(0);
    // The SERVER's figure, on the confirm — one sender, not the twelve that were asked about.
    expect(within(document.body).getByRole("button", { name: "Suggest again for 1 sender" })).toBeTruthy();
  });

  it("rests beside the filter chips and the apply banner, not in place of them", async () => {
    listReply = allAnswered;
    await mountLive();
    // The report was about the whole strip, not one control. A "fix" that restored the suggest
    // surface by displacing its neighbours would be no fix, and this is what watches for it.
    const tools = within(buttons().getByRole("group", { name: messages.screener.bulkAria }));
    const filter = tools.getByRole("button", { name: /^All/ });
    expect(filter.getAttribute("aria-haspopup")).toBe("menu");
    expect(tools.getByRole("button", { name: /^Apply \d+ —/ })).toBeTruthy();
    expect(tools.getByRole("button", { name: "Suggest again…" })).toBeTruthy();
    expect(text()).toContain("All 12 senders have a suggestion.");
  });

  it("buys the same set on confirm, with an idempotency key", async () => {
    listReply = allAnswered;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: 1, quotedCredits: 1, charged: body.dryRun === true ? 0 : 1,
        suggestions: body.dryRun === true
          ? []
          : [{ sender: body.senders[0], messageId: "m00", decision: "no", destination: "ohmail/Screened", confidence: 0.9, rationale: "re-asked" }],
        skipped: [],
      });
    await mountLive();
    await press("Suggest again…");
    await pressConfirmAgain();

    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body?.senders).toEqual(dryRuns()[0]!.body?.senders);
    expect(new Set(purchases()[0]!.body?.senders)).toEqual(new Set(exactNames(TWELVE)));
    // ONE KEY PER CHUNK — the existing spend rule, reached because this is the existing flow.
    // RED if the re-ask ever grows a path of its own that posts without one: a lost response
    // would then be retried as a second purchase.
    expect(purchases()[0]!.idempotencyKey).toBeTruthy();
    // The fresh answer landed in the same overlay the chips read.
    expect(text()).toContain("re-asked");
  });

  it("says so honestly when the ledger has nothing new to sell", async () => {
    listReply = allAnswered;
    // Every sender's newest mail is the one already bought for, so the server quotes zero and
    // will answer from what it is holding. That is a real answer, not a failure.
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [],
      });
    await mountLive();
    await press("Suggest again…");
    const menu = within(document.body).getByRole("dialog", { name: messages.screener.suggest.ariaAgain });
    expect(within(menu).getByRole("status").textContent).toBe("No senders need a new suggestion.");
    expect(within(menu).queryByRole("button", { name: /^Suggest again for / })).toBeNull();
    expect(purchases()).toHaveLength(0);
  });

  it("never feeds the re-ask list to the AUTOMATIC batch", async () => {
    listReply = allAnswered;
    suggestReply = (body) =>
      json({
        dryRun: body.dryRun === true, requested: body.senders.length,
        quoted: 0, quotedCredits: 0, charged: 0, suggestions: [], skipped: [],
      });
    await mountLive(TWELVE, true);
    expect(calls.some((call) => call.method === "GET" && !call.path.includes("live=1"))).toBe(true);
    expect(buttons().getByRole("button", { name: /^Apply 12 —/ })).toBeTruthy();
    // RED if `io.current.queue` is widened to include the re-ask list. The automatic batch's
    // licence is a figure quoted when the setting was turned on, over senders with no answer;
    // there are none, so it must buy nothing at all rather than spend on twelve unpressed.
    expect(purchases()).toHaveLength(0);
    expect(dryRuns()).toHaveLength(0);
  });
});
