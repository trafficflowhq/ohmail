/** @vitest-environment jsdom */
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { UNDO_MS } from "@ohmail/app-logic/press";
import { SCREENER_INTENTS_PREFIX, screenerIntentsKey } from "@ohmail/app-logic/screener/screener-intents";
import { resetStorageOwnerForTest, storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

let sent: unknown[];

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  sent = [];
});
afterEach(async () => {
  await teardownConfirmEnv();
  resetStorageOwnerForTest();
  localStorage.clear();
});

async function mountScreener() {
  const mail: EngineMessage = {
    id: "held-letter", accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: "Held subject", from: { name: "Sender", address: "sender@example.invalid" }, to: [], cc: [],
    date: ISO, folder: "ohmail/Screener", snippet: "Held snippet", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
  scriptSync(() => Response.json({
    changes: {
      creates: [{ type: "message", op: "create", id: mail.id, seq: 1, updatedAt: ISO, entity: mail }],
      updates: [], moves: [], deletes: [],
    },
    cursor: "1", hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));

  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") return Response.json({
      items: [{ id: "mb_1", address: "mailbox@example.invalid", status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO }],
    });
    if (method === "POST" && path === "/api/screener/held-letter") {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ messageId: mail.id, appliedFolder: "ohmail/News", createdRuleId: null });
    }
    if (method === "GET" && path.endsWith("/body")) return new Response(null, { status: 503 });
    return fixture(input, init);
  };
  window.location.hash = "#/screener";
  const host = await mountCloudShell();
  await tick(3000);
  const row = within(host).getByRole("option", { name: /Held subject/ });
  await act(async () => { row.click(); });
  await tick(100);
  return host;
}

function journals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)!;
    if (!k.startsWith(SCREENER_INTENTS_PREFIX)) continue;
    const held = JSON.parse(window.localStorage.getItem(k) ?? "[]") as unknown;
    out[k] = Array.isArray(held) ? held.length : Object.keys(held as object).length;
  }
  return out;
}

describe("a Screener decision pressed in the shell is journalled under the scope of the shell's own mount", () => {
  it("holds the decision in this account's journal through its Undo window, and in no other journal", async () => {
    const host = await mountScreener();
    expect(storageOwner(), "the mount is this account's").toBe(ACCOUNT);
    expect(within(host).getByRole("option", { name: /Held subject/ })).toBeTruthy();
    expect(journals(), "a journal before any press").toEqual({});

    const actions = within(host).getByRole("toolbar", { name: "Actions" });
    await act(async () => { within(actions).getByRole("button", { name: "News" }).click(); });
    await tick(100);

    expect(sent, "nothing reaches the wire inside the Undo window").toEqual([]);
    expect(journals(), "the decision stands in this account's journal and in no other")
      .toEqual({ [screenerIntentsKey(ACCOUNT)]: 1 });

    await tick(UNDO_MS + 2000);

    expect(sent, "the decision went out once its window closed").toHaveLength(1);
    const left = journals();
    expect(Object.keys(left).filter((k) => k !== screenerIntentsKey(ACCOUNT)), "another journal was written").toEqual([]);
    expect(left[screenerIntentsKey(ACCOUNT)] ?? 0, "the sent decision is spent in its own journal").toBe(0);
  });
});
