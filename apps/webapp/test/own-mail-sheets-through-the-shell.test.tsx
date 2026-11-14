/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import en from "../messages/en.json";

/**
 * THE SHIPPED SHELL OFFERS NO RULE ABOUT OUR OWN ADDRESS (SENDER-SHEET-OFFERED-ON-OUR-OWN-MAIL).
 * The sheet's own body and the subject sheet's gate are read through the real shell, its mailbox
 * facts naming the account's address: our own note opens the sentence in place of the places, and
 * its title says the sentence instead of opening the subject sheet. A friend's mail is the control.
 */
const ME = "walker@example.invalid";
const FRIEND = "friend@example.invalid";
let seq = 0;

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
const message = (id: string, from: string, subject: string) => create("message", id, {
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null, subject,
  from: { name: null, address: from }, to: [{ name: null, address: ME }], cc: [],
  date: ISO, arrivedAt: ISO, sortAt: ISO, folder: "INBOX", snippet: subject, unread: false,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
});

function syncPage(): Response {
  const creates = [
    create("rule", "rule_friend", {
      id: "rule_friend", kind: "sender", match: FRIEND, destination: "INBOX", priority: 0, provenance: "manual",
      enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
    }),
    message("note", ME, "Note to self"),
    message("fr", FRIEND, "Lunch on Friday"),
  ];
  return new Response(JSON.stringify({
    changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };
const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
const row = (host: HTMLElement, id: string): HTMLElement => {
  const r = host.querySelector<HTMLElement>(`:is(.row, [role=option])[data-id="${id}"]`);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const toasts = (): string[] =>
  [...document.querySelectorAll("[class*=toast]")].map((n) => (n.textContent ?? "").trim()).filter(Boolean);
const SENTENCE = en.screening.toastOwnAddress;

beforeEach(() => {
  installShellEnv();
  seq = 0;
  answerSyncWith(syncPage);
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

describe("the shell on the account's own mail", () => {
  it("the sender sheet on our own note says the sentence and offers no place; a friend's offers five", async () => {
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();
    await click(row(host, "note").querySelector(":is(.av, .oh-row-face)")!);
    const own = document.getElementById("sender-sheet")!;
    expect(own.querySelector(".sm-now")!.textContent).toBe(SENTENCE);
    expect(own.querySelectorAll("[data-dest]")).toHaveLength(0);
    await act(async () => { document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await settle();
    await click(row(host, "fr").querySelector(":is(.av, .oh-row-face)")!);
    expect(document.getElementById("sender-sheet")!.querySelectorAll("[data-dest]")).toHaveLength(5);
  });

  it("our own note's title says the sentence instead of opening the subject sheet; a friend's opens it", async () => {
    const host = await mountShell([mailbox({ address: ME, lastSyncAt: ISO })]);
    await settle();
    await click(row(host, "note"));
    await click(host.querySelector(".subj-rule")!);
    expect(document.querySelector('.senderm[role="dialog"]')).toBeNull();
    expect(toasts().some((t) => t.includes(SENTENCE))).toBe(true);
    await click(row(host, "fr"));
    await click(host.querySelector(".subj-rule")!);
    expect(document.querySelector('.senderm[role="dialog"]')).not.toBeNull();
  });
});
