/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import en from "../messages/en.json";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { forgetOwner, rememberOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { engineOver } from "./_view-shell";
import { WebContactScreening } from "../app/(product)/mailbox/WebContactScreening";

/**
 * THE SHIPPED SHELL OFFERS NO RULE ABOUT OUR OWN ADDRESS (SENDER-SHEET-OFFERED-ON-OUR-OWN-MAIL).
 * The sender sheet shows the refusal in the mounted Web shell, with the account’s own mailbox
 * present. A friend’s sender sheet provides the control.
 */
const ME = "walker@example.invalid";
const FRIEND = "friend@example.invalid";
let seq = 0;
const ACCOUNT = "acct_live_1";

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
const message = (id: string, from: string, subject: string) => create("message", id, {
  id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null, subject,
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
const SENTENCE = en.screening.toastOwnAddress;

beforeEach(() => {
  installShellEnv();
  seq = 0;
  answerSyncWith(syncPage);
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  await teardownShellEnv();
  forgetOwner();
});

async function screeningShell(): Promise<HTMLElement> {
  const store = new MemoryMirrorStore();
  await store.load();
  const { changes } = await syncPage().json() as { changes: { creates: SyncChange[] } };
  await store.applyChanges(changes.creates);
  rememberOwner(ACCOUNT);
  const engine = registerSyncGate(engineOver(store), createSyncGate(ACCOUNT));
  confirmSyncOwner(engine, ACCOUNT);
  const host = await mountShell([mailbox({
    id: "mb_1", address: ME, lastSyncAt: ISO, organizerChecked: true,
    organizerRole: "organizer", organizeConsentedAt: ISO,
  })], { engine, contactScreening: WebContactScreening });
  await settle();
  return host;
}

async function openScreening(host: HTMLElement, subject: string, sender: string) {
  await click(within(host).getByRole("option", { name: new RegExp(subject) }));
  await click(within(host).getByRole("button", { name: en.screening.openFor.replace("{sender}", sender) }));
  return within(screen.getByRole("dialog", { name: /^Screening/ }));
}

async function closeScreening() {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    }));
  });
  await settle();
}

describe("the shell on the account's own mail", () => {
  it("the sender sheet on our own note says the sentence and offers no place; a friend's offers five", async () => {
    const host = await screeningShell();
    const own = await openScreening(host, "Note to self", ME);
    expect(own.getByText(SENTENCE).textContent).toBe(SENTENCE);
    expect(own.queryAllByRole("option")).toHaveLength(0);
    expect(own.queryByRole("button", { name: en.screening.subjectRuleOpen })).toBeNull();
    await closeScreening();
    const friend = await openScreening(host, "Lunch on Friday", FRIEND);
    expect(friend.getAllByRole("option")).toHaveLength(5);
  });

  it("our own note's title says the sentence instead of opening the subject sheet; a friend's opens it", async () => {
    const host = await screeningShell();
    const own = await openScreening(host, "Note to self", ME);
    expect(own.getByText(SENTENCE).textContent).toBe(SENTENCE);
    expect(own.queryByRole("button", { name: en.screening.subjectRuleOpen })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /^Rule on/ })).toBeNull();
    await closeScreening();
    const friend = await openScreening(host, "Lunch on Friday", FRIEND);
    await click(friend.getByRole("button", { name: en.screening.subjectRuleOpen }));
    const dialog = within(screen.getByRole("dialog", {
      name: en.screening.subjectAria.replace("{who}", FRIEND),
    }));
    expect(dialog.getByRole<HTMLInputElement>("textbox", { name: en.screening.subjectEditAria }).value)
      .toBe("Lunch on Friday");
  });
});
