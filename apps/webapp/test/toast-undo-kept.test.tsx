/** @vitest-environment jsdom */
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COMMIT_MS, UNDO_MS } from "@ohmail/app-logic/screener/screener-state";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const FILED = "Ohbox — filed";
const SUMMARY = "1 suggestion · 1 credit used";
const UNDONE = /^Undone — 1 waiting again$/;

const msg = (id: string): EngineMessage => ({
  id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `Subject ${id}`, from: { name: null, address: `${id}@fixture.example` }, to: [], cc: [],
  date: ISO, folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
});

let host: HTMLElement | null = null;
let mounted = false;
let finishPurchase: (() => void) | null = null;
let purchases = 0;
let decisions: string[] = [];

beforeAll(warmCloudShell);
afterEach(async () => {
  if (mounted) await teardownConfirmEnv();
  mounted = false;
  host = null;
  vi.unstubAllGlobals();
});

async function mount(initial: EngineMessage[], autoSuggest = false) {
  installConfirmEnv();
  mounted = true;
  purchases = 0;
  decisions = [];
  finishPurchase = null;
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  vi.stubGlobal("innerWidth", 1280);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];

  const mail = [...initial];
  scriptSync(() => Response.json({
    changes: {
      creates: mail.map((entity, index) => ({
        type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
      })),
      deletes: [], updates: [], moves: [],
    },
    cursor: String(mail.length), hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));

  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: "mailbox@fixture.example", status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO, providerConfirms: true,
      }] });
    }
    if (method === "GET" && url.pathname === "/api/consent") {
      const facts = await (await fixture(input, init)).json();
      return Response.json({ ...facts, autoSuggestAt: autoSuggest ? ISO : null, blockAutoUnsubscribeAt: ISO });
    }
    if (method === "GET" && url.pathname === "/api/account/access") {
      return Response.json({ metered: true, aiEnabled: true });
    }
    if (method === "GET" && url.pathname === "/api/screener" && !url.searchParams.has("live")) {
      return Response.json({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } });
    }
    if (method === "POST" && url.pathname === "/api/screener/suggest") {
      const { senders, dryRun } = JSON.parse(String(init?.body)) as { senders: string[]; dryRun?: boolean };
      const reply = Response.json({
        dryRun: dryRun === true, requested: senders.length, quoted: senders.length,
        quotedCredits: senders.length, charged: dryRun ? 0 : senders.length, skipped: [],
        ...(dryRun ? { quoteGrant: {
          proof: "fixture-quote",
          pairs: senders.map((sender, i) => ({ sender, messageId: "m-" + i })),
        } } : {}),
        suggestions: dryRun ? [] : senders.map((sender) => ({
          sender, messageId: mail.find(({ from }) => from.address === sender)!.id,
          decision: "yes", confidence: 0.9, rationale: "r",
        })),
      });
      if (dryRun) return reply;
      purchases++;
      return new Promise<Response>((resolve) => { finishPurchase = () => resolve(reply); });
    }
    const id = /^\/api\/screener\/([^/]+)$/.exec(url.pathname)?.[1];
    if (method === "POST" && id !== undefined) {
      decisions.push(id);
      const { dest } = JSON.parse(String(init?.body)) as { dest: string };
      return Response.json({ messageId: id, appliedFolder: dest, createdRuleId: null });
    }
    const body = { text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null };
    if (method === "GET" && url.pathname === "/api/messages/bodies") {
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      return Response.json({ items: ids.map((messageId) => ({ messageId, ...body })) });
    }
    if (method === "GET" && url.pathname.endsWith("/body")) return Response.json(body);
    return fixture(input, init);
  };

  window.location.hash = "#/ohbox";
  host = await mountCloudShell();
  await tick(3000);
  await go("Screener");
  await tick(1000);
  return async (letter: EngineMessage) => {
    mail.push(letter);
    await act(() => { window.dispatchEvent(new Event("online")); });
    await tick(3000);
  };
}

const screen = () => within(host!);
const rail = () => within(screen().getByRole("navigation", { name: "Places" }));
const go = async (where: "Ohbox" | "Screener") => {
  const item = rail().getByRole("button", { name: (label) => label === where || label.startsWith(`${where} `) });
  await act(() => { fireEvent.click(item); });
};
const waiting = () => screen().queryByRole("listbox", { name: "Screener" });
const waitingRows = () => {
  const list = waiting();
  return list ? within(list).queryAllByRole("option") : [];
};
const press = async (key: string) => {
  const panel = screen().getByRole("toolbar", { name: "Actions" });
  const button = within(panel).getByRole("button", { name: key === "o" ? "Ohbox" : "Screen out" });
  await act(() => { fireEvent.click(button); });
};
const reportSlot = () => host!.querySelector<HTMLElement>(".fr-report")!;
const report = () => reportSlot().querySelector<HTMLElement>('[role="status"]:not([data-leaving])');
const reportText = () => {
  const message = report()?.cloneNode(true) as HTMLElement | undefined;
  message?.querySelectorAll("button, kbd").forEach((node) => node.remove());
  return message?.textContent?.trim() ?? null;
};
const undoButton = () => within(reportSlot()).queryByRole("button", { name: /^Undo/ });
const undo = async () => {
  const button = undoButton();
  expect(button).not.toBeNull();
  await act(() => { fireEvent.click(button!); });
};
const answer = async () => {
  expect(finishPurchase).not.toBeNull();
  await act(() => { finishPurchase!(); });
  await tick(0);
};

/** A sender arrives, automatic advice starts, then the person decides before it answers. */
async function startDecision(id: string, key = "o") {
  const deliver = await mount([], true);
  await deliver(msg(id));
  expect(waitingRows()).toHaveLength(1);
  expect(purchases, "the automatic batch started for the arrival").toBe(1);
  await press(key);
}

// The frame has one report slot: the summary waits while that slot offers Undo.
describe("on a fake server: the decision's Undo beside the suggestion summary", () => {
  it("(a)/(c) the row leaves, the summary shows beneath, and the Undo holds its whole window", async () => {
    await startDecision("arrival");
    await tick(200);
    await answer();
    await tick(400);
    expect(waitingRows(), "the row left").toHaveLength(0);
    expect(reportText()).toContain(FILED);
    expect(reportSlot().textContent).not.toContain(SUMMARY);

    await tick(1400);
    expect(undoButton(), "Undo is still offered two seconds in").not.toBeNull();
    await tick(UNDO_MS - 2001);
    expect(undoButton(), "the full window, to the millisecond").not.toBeNull();
    expect(decisions, "nothing sent inside the window").toEqual([]);
    await tick(COMMIT_MS - UNDO_MS + 1);
    expect(decisions, "committed at the end of the window").toEqual(["arrival"]);
    expect(undoButton()).toBeNull();
    expect(reportText(), "the advice report follows the decision in the shared slot").toBe(SUMMARY);
    expect(report()?.querySelector(".oh-nowrap > .oh-dot")).toBeTruthy();
    await tick(3000);
    expect(reportSlot().textContent).not.toContain(SUMMARY);
  });

  it("(a) Undo pressed two seconds in, beside the summary: the decision is not sent", async () => {
    await startDecision("arrival");
    await tick(200);
    await answer();
    await tick(1800);
    expect(reportText()).toContain(FILED);
    expect(reportSlot().textContent).not.toContain(SUMMARY);
    await undo();
    expect(undoButton(), "Undo dismissed its own capsule").toBeNull();
    expect(reportText()).toMatch(UNDONE);
    expect(report()?.querySelector(".oh-nowrap > .oh-dot")).toBeTruthy();
    expect(waitingRows(), "the sender is back").toHaveLength(1);
    await tick(COMMIT_MS * 2);
    expect(decisions, "an undone decision is never sent").toEqual([]);
  });
});

describe("on a fake server: the Undo's own sentence outlives the suggestion summary", () => {
  it("'Undone' holds its window with the batch answering inside it, and the summary follows", async () => {
    await startDecision("arrival", "n");
    await tick(549);
    await undo();
    expect(reportText()).toMatch(UNDONE);
    expect(report()?.querySelector(".oh-nowrap > .oh-dot")).toBeTruthy();
    await tick(1558 - 549);
    await answer();
    await tick(2000 - 1558);
    expect(reportText(), "the confirmation is not replaced").toMatch(UNDONE);
    expect(reportSlot().textContent, "the summary waits").not.toContain(SUMMARY);

    await tick(549 + 2600 + 300 - 2000 + 1);
    expect(reportText(), "then the summary is said, never dropped").toBe(SUMMARY);
    expect(report()?.querySelector(".oh-nowrap > .oh-dot")).toBeTruthy();
    expect(waitingRows(), "the sender is back").toHaveLength(1);
    await tick(COMMIT_MS * 2);
    expect(decisions, "an undone decision is never sent").toEqual([]);
  });
});

describe("the window is the guard's, not the capsule's", () => {
  it("a second decision replaces the first capsule and leaves the first decision's commit time as it was", async () => {
    await mount([msg("a"), msg("b")]);
    const whose = () => /\b([ab])@fixture\.example/.exec(reportText() ?? "")?.[1] ?? "none";
    await press("o");
    const first = whose();
    await tick(1000);
    await press("o");
    const second = whose();
    expect([first, second].sort(), "the second capsule replaced the first").toEqual(["a", "b"]);
    expect(within(reportSlot()).getAllByRole("button", { name: /^Undo/ })).toHaveLength(1);

    await tick(COMMIT_MS - 1000 - 1);
    expect(decisions, "the first not sent before its own window closed").toEqual([]);
    await tick(1);
    expect(decisions, "the first at its own commit time, its capsule long replaced").toEqual([first]);
    await tick(999);
    expect(decisions).toEqual([first]);
    await tick(1);
    expect(decisions, "the second at its own commit time").toEqual([first, second]);
  });
});

describe("an Undo whose window closed early is withdrawn, never left above its outcome", () => {
  it("leaving the Screener commits the pending decision and takes its capsule with it", async () => {
    await mount([msg("a")]);
    await press("o");
    expect(undoButton(), "the premise: Undo is offered").not.toBeNull();
    expect(decisions).toEqual([]);
    await go("Ohbox");
    await tick(100);
    expect(window.location.hash).toBe("#/ohbox");
    expect(decisions, "committed at once").toEqual(["a"]);
    expect(undoButton(), "a dead Undo is not left on screen").toBeNull();
  });
  // The delete window is tested at its own ground press.
});
