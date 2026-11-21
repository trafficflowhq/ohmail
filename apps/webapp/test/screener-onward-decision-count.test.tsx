/** @vitest-environment jsdom */
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import * as screener from "@ohmail/app/screener";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const far = "far@example.invalid";
const mailboxId = "mb_1";
function held(id: string, address: string): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId, threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address }, to: [], cc: [],
    date: ISO, folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

let settled = false;
let answer: (() => void) | null;
let writes: unknown[];
let recheck: () => void;
let host: HTMLElement;

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  settled = false;
  answer = null;
  writes = [];
});
afterEach(teardownConfirmEnv);

async function open(refused: boolean) {
  const Above = screener.ScreenerAbove;
  vi.spyOn(screener, "ScreenerAbove").mockImplementation((props) => {
    recheck = props.model.rereadWaiting;
    return <Above {...props} />;
  });
  const mail = [held("m0", "a@example.invalid"), held("m1", "b@example.invalid")];
  scriptSync(() => Response.json({
    changes: {
      creates: mail.map((entity, i) => ({ type: "message", op: "create", id: entity.id, seq: i + 1, updatedAt: ISO, entity })),
      updates: [], moves: [], deletes: [],
    },
    cursor: "2", hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "X-Ohmail-Account": ACCOUNT } });
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/mailboxes") return reply({
      items: [{ id: mailboxId, address: "mailbox@example.invalid", status: "connected", organizerRole: "organizer",
        initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO }],
    });
    if (method === "GET" && url.pathname === "/api/screener") {
      if (!url.searchParams.has("live")) return reply({ items: [], nextCursor: null });
      if (url.searchParams.get("cursor") === "n") {
        return reply({
          items: [{ messageId: "far", sender: { address: far, name: "Far" }, receivedAt: "2026-01-01T08:00:00.000Z",
            subject: "An old note", snippet: "old", mailboxId }],
          nextCursor: null, pendingDecisions: [],
        });
      }
      return reply({
        items: mail.map((m) => ({
          messageId: m.id, sender: m.from, receivedAt: ISO, subject: m.subject, snippet: m.snippet, mailboxId,
        })),
        nextCursor: "n", total: settled ? 249 : 250, pendingDecisions: [],
      });
    }
    if (method === "POST" && url.pathname === "/api/screener/far") {
      writes.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => {
        answer = () => {
          if (refused) {
            resolve(reply({ error: { code: "conflict", message: "not decided" } }, 409));
          } else {
            settled = true;
            resolve(reply({ messageId: "far", appliedFolder: "INBOX", createdRuleId: null }));
          }
        };
      });
    }
    if (method === "GET" && url.pathname.endsWith("/body")) return new Response(null, { status: 503 });
    return fixture(input, init);
  };
  window.location.hash = "#/screener";
  host = await mountCloudShell();
  await tick(3000);
}

const page = () => within(host);
const count = (n: number) => page().getByRole("button", { name: `Waiting ${n}` });
const laterSender = () => page().queryByRole("option", { name: /Far.*An old note/ });
const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
  await tick(100);
};
async function press() {
  await click(page().getByRole("button", { name: "Show more senders" }));
  expect(laterSender()).toBeTruthy();
  await click(laterSender()!);
  const actions = page().getByRole("toolbar", { name: "Actions" });
  await click(within(actions).getByRole("button", { name: /^Ohbox/ }));
}
async function settleWrite() {
  expect(writes).toEqual([{ decision: "yes", dest: "INBOX", scope: "sender", applyRetro: false }]);
  expect(answer).not.toBeNull();
  await act(async () => { answer!(); });
  await tick(200);
}

describe("a decision on a sender from a later page", () => {
  it("lowers the count at the press and keeps it lowered until the store's next answer", async () => {
    await open(false);
    await vi.waitFor(() => expect(count(250)).toBeTruthy());
    await press();
    expect(count(249)).toBeTruthy();
    expect(writes).toEqual([]);

    await tick(COMMIT_MS);
    expect(answer).not.toBeNull();
    expect(count(249)).toBeTruthy();
    expect(laterSender()).toBeNull();

    await act(async () => { recheck(); });
    await tick(200);
    expect(count(249)).toBeTruthy();

    await settleWrite();
    expect(count(249)).toBeTruthy();
    expect(laterSender()).toBeNull();
  });

  it("a decision the server refuses puts the sender and the count back", async () => {
    await open(true);
    await press();
    expect(count(249)).toBeTruthy();
    await tick(COMMIT_MS);
    await settleWrite();
    expect(count(250)).toBeTruthy();
    expect(laterSender()).toBeTruthy();
  });
});
