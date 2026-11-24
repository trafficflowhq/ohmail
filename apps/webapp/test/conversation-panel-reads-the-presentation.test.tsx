/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

/**
 * THE WEB PANEL READS THE PRESENTATION, through the shipped shell and the real engine. A reply sits
 * physically in INBOX, threaded into Lena's conversation by its headers, while the presentation holds
 * it: its sender is undecided, or a screened-out rule for them has landed and not been carried out.
 * The phone's reader (the presented mirror) leaves it out; the web panel and its attachment asks must
 * too. Mutation: hand the reader the raw mirror (`engine.read()`) as its presented one: the panel shows x2.
 */

const ME = "walker@example.invalid";
const LENA = { name: "Lena", address: "lena@example.invalid" };
const STRANGER = { name: "S", address: "s@elsewhere.invalid" };
const OLDER = "2026-08-03T08:00:00.000Z";
const MIDDLE = "2026-08-03T08:30:00.000Z";
const NEWER = "2026-08-03T09:00:00.000Z";
let seq = 0;

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
const message = (id: string, at: string, over: Record<string, unknown>) => create("message", id, {
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: "T", messageIdHeader: null,
  subject: "Q3 plan", from: LENA, to: [{ name: null, address: ME }], cc: [], date: at, arrivedAt: at, sortAt: at,
  folder: "INBOX", snippet: `the words of ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
});
const rule = (address: string, destination: string) => create("rule", `rule_${address}`, {
  id: `rule_${address}`, kind: "sender", match: address, destination, priority: 0,
  provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});
const thread = (ids: string[]) => create("thread", "T", {
  id: "T", accountId: "acct_live_1", rootMessageIdHeader: null, subject: "Q3 plan", messageIds: ids,
  lastMessageAt: NEWER, participants: [], updatedAt: ISO,
});
const pageOf = (creates: unknown[]) => (): Response => new Response(
  JSON.stringify({ changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: ISO }),
  { status: 200, headers: { "content-type": "application/json" } },
);

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };
const click = async (el: Element | null | undefined, what: string): Promise<void> => {
  expect(el, `nothing to click: ${what}`).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
const rowOf = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[role="listbox"] [role=option][data-id="${id}"]`);
const panels = (host: HTMLElement): string[] =>
  [...host.querySelectorAll<HTMLElement>('[role="region"][aria-label="Open message"] [data-conv-id]')].map((p) => p.dataset.convId!);
/** The attachment-list asks the wire saw, by message id. */
const listAsks = (id: string): number =>
  (globalThis.fetch as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls
    .filter(([input]) => String(input).includes(`/messages/${id}/attachments`)).length;

/** Lena's two placed messages and x2, opened at a2 from its Ohbox row. */
async function openWith(x2: Record<string, unknown>, extra: unknown[] = []): Promise<HTMLElement> {
  answerSyncWith(pageOf([
    rule(LENA.address, "INBOX"), ...extra,
    message("a1", OLDER, { hasAttachments: true, attachmentCount: 1 }),
    message("x2", MIDDLE, { from: STRANGER, hasAttachments: true, attachmentCount: 1, ...x2 }),
    message("a2", NEWER, { unread: true }),
    thread(["a1", "x2", "a2"]),
  ]));
  const host = await mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO })]);
  await settle();
  await click(rowOf(host, "a2"), "the Ohbox row a2");
  await click(rowOf(host, "a2"), "the Ohbox row a2");
  expect(panels(host), "the premise: the conversation opened").toContain("a1");
  return host;
}

beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);

beforeEach(() => {
  installShellEnv();
  seq = 0;
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

describe("a reply the presentation holds is in no web panel and no attachment ask", () => {
  it("an undecided sender's reply still physically in INBOX", async () => {
    const host = await openWith({});
    expect(panels(host)).toEqual(["a1", "a2"]);
    expect(listAsks("x2"), "x2's file list was asked").toBe(0);
    expect(listAsks("a1"), "the positive control: a placed sibling's list is asked").toBeGreaterThan(0);
  }, 30_000);

  it("a screened-out rule landed and not yet carried out", async () => {
    const host = await openWith({}, [rule(STRANGER.address, "ohmail/Screened")]);
    expect(panels(host)).toEqual(["a1", "a2"]);
    expect(listAsks("x2")).toBe(0);
  }, 30_000);

  it("the account's own mail physically at the gate stands in it, as its Ohbox row does", async () => {
    const host = await openWith({ folder: "ohmail/Screener", from: { name: null, address: ME }, to: [LENA] });
    expect(panels(host)).toEqual(["a1", "x2", "a2"]);
  }, 30_000);

  it("CONTROL: the person's pin keeps a gate row in the conversation", async () => {
    const pin = { messageId: "x2", state: "resurfaced", bubbleUpAt: null, setAt: ISO, updatedAt: ISO };
    const host = await openWith({ folder: "ohmail/Screener", triage: pin });
    expect(panels(host)).toEqual(["a1", "x2", "a2"]);
  }, 30_000);
});
