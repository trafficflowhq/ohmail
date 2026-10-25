/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";
import { UNDO_MS } from "../app/shell/screener-state";

/**
 * THE PANEL IN VIEW AT OPEN IS THE PANEL THE BAR ACTS ON, through the shipped shell and the real engine.
 * The Ohbox row opens `a1` under a newer `x2` of each kind `conversation-bar-forward.test.tsx` names; the
 * ringed panel is `a1`, and the bar's Delete reaches the wire for `a1` alone, Later for `a1` and the row's
 * own reply beside it (the row is taken whole). A wheel on the stack
 * moves nothing the bar reads. Mutation: rebind the bar to the conversation's last member — red at the id.
 */

const ME = "walker@example.invalid";
const LENA = { name: "Lena", address: "lena@example.invalid" };
const OLDER = "2026-08-03T08:00:00.000Z";
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
const consent = (address: string) => create("rule", `rule_${address}`, {
  id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
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

const rowA1 = () => message("a1", OLDER, { unread: true, hasAttachments: true, attachmentCount: 1 });
const OURS = { from: { name: null, address: ME }, to: [LENA], folder: "Sent" };
const laterX2: Record<string, Record<string, unknown>> = {
  "our away answer": { ...OURS, subject: "Re: Q3 plan", autoReplyByUs: true },
  "our calendar acknowledgement": { ...OURS, subject: "Accepted: Q3 plan", itipReplyHeader: true },
  "our own reply": { ...OURS, subject: "Re: Q3 plan" },
  "a stranger's reply held in the Screener": { from: { name: "S", address: "s@elsewhere.invalid" }, folder: "ohmail/Screener" },
  "a member filed to Junk": { from: { name: "J", address: "j@elsewhere.invalid" }, folder: "ohmail/Quarantine" },
};

const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };
const click = async (el: Element | null | undefined, what: string): Promise<void> => {
  expect(el, `nothing to click: ${what}`).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
const rowOf = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[role="listbox"] .row[data-id="${id}"]`);
/** A row press, as a person makes it at this width: the first click selects, the second opens. */
const openRow = async (host: HTMLElement, id: string): Promise<void> => {
  await click(rowOf(host, id), `the Ohbox row ${id}`);
  await click(rowOf(host, id), `the Ohbox row ${id}`);
};
/** The ringed panel — the one the reader's anchor scrolls to. */
const anchored = (host: HTMLElement): string | null =>
  host.querySelector<HTMLElement>('.read-col [data-conv-id][aria-current="true"]')?.dataset.convId ?? null;
const docked = (host: HTMLElement): string | null =>
  host.querySelector<HTMLElement>(".reply[data-reply-for]")?.dataset.replyFor ?? null;
/** Every request the engine made, as method and path. */
const wire = (): Array<{ method: string; url: string }> =>
  (globalThis.fetch as unknown as { mock: { calls: Array<[unknown, RequestInit | undefined]> } }).mock.calls
    .map(([input, init]) => ({ method: (init?.method ?? "GET").toUpperCase(), url: String(input) }));
const deletesOf = (id: string): number =>
  wire().filter((w) => w.method === "DELETE" && w.url.includes(`/messages/${id}`)).length;
const triagesOf = (id: string): number =>
  wire().filter((w) => w.method === "POST" && w.url.includes(`/messages/${id}/triage`)).length;

/** The bar's Delete, as a person presses it: More, Delete, then the ask's own Delete. */
const pressBarDelete = async (host: HTMLElement): Promise<void> => {
  await click(host.querySelector(".read-col .abar .abar-more"), "the bar's More");
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((b) => (b.textContent ?? "").trim().startsWith("Delete"));
  await click(item, "Delete in the bar's menu");
  await click(host.querySelector(".read-col .abar-delete .abar-danger"), "the ask's Delete");
  await tick(UNDO_MS * 2);
};

async function mountOpenedAtA1(over: Record<string, unknown>): Promise<HTMLElement> {
  answerSyncWith(pageOf([consent(LENA.address), rowA1(), message("x2", NEWER, over), thread(["a1", "x2"])]));
  /* The row's mailbox is on the roster: a delete over a mailbox the roster does not name is refused. */
  const host = await mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO })]);
  await settle();
  await openRow(host, "a1");
  // A held x2 (the gate, Junk) stands in no conversation a header threaded it into: no panel, and
  // the bar still has only a1 to act on. Every other x2 is a panel beside it.
  const held = over.folder === "ohmail/Screener" || over.folder === "ohmail/Quarantine";
  expect(Boolean(host.querySelector('.read-col article.pm[data-conv-id="x2"]')), "the premise: x2 is a panel unless it is held").toBe(!held);
  // Held, x2 leaves a1 alone: one message, no conversation panels, nothing to ring.
  expect(anchored(host), "the ringed panel is the one the row opened").toBe(held ? null : "a1");
  return host;
}

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);

beforeEach(() => {
  installShellEnv();
  seq = 0;
  window.location.hash = "#/ohbox";
});
afterEach(async () => { await teardownShellEnv(); });

describe("the bar acts on the panel the conversation opened at", () => {
  for (const [label, over] of Object.entries(laterX2)) {
    it(`with ${label} newer than a1, Delete takes a1 and leaves x2 standing`, async () => {
      const host = await mountOpenedAtA1(over);
      await pressBarDelete(host);
      expect(deletesOf("a1"), "a1's delete reached the wire").toBe(1);
      expect(deletesOf("x2"), "x2 was deleted").toBe(0);
    }, 30_000);

    // Our own reply is a member of the row, which Later takes whole; nothing else beside a1 is.
    const rowTakesX2 = label === "our own reply";
    it(`with ${label} newer than a1, Later files ${rowTakesX2 ? "a1 and our reply" : "a1 alone"}`, async () => {
      const host = await mountOpenedAtA1(over);
      await click(host.querySelector(".read-col .abar .abar-later"), "the bar's Later");
      expect(triagesOf("a1"), "a1's Later reached the wire").toBe(1);
      expect(triagesOf("x2"), "x2's filing").toBe(rowTakesX2 ? 1 : 0);
    }, 30_000);
  }

  it("the ringed panel, Delete's id and Forward's id are one id", async () => {
    const host = await mountOpenedAtA1(laterX2["our own reply"]!);
    const ringed = anchored(host);
    await click(host.querySelector(".read-col .abar-fwd button"), "the bar's Forward");
    expect(docked(host)).toBe(ringed);
    await pressBarDelete(host);
    expect(deletesOf(ringed!)).toBe(1);
    expect(deletesOf("x2")).toBe(0);
  }, 30_000);

  it("a wheel on the stack before Delete moves nothing the bar reads", async () => {
    const host = await mountOpenedAtA1(laterX2["our away answer"]!);
    await act(async () => {
      host.querySelector(".read-col .conv")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 600, bubbles: true }));
    });
    await settle();
    await pressBarDelete(host);
    expect(deletesOf("a1")).toBe(1);
    expect(deletesOf("x2")).toBe(0);
  }, 30_000);
});
