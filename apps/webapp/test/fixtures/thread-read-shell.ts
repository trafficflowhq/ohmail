/**
 * A CONVERSATION IN THE SHIPPED SHELL, with the read wire recorded — the harness the thread-read
 * guards share (`conversation-read-slot`, `conversation-seen-on-scroll-runaway`). One page of mail
 * is served until the first read is written (later drains are empty, so a stale echo cannot undo it),
 * every `PATCH /messages` body is kept, and the server refuses what a real one refuses: more than
 * 200 ids (413) and an id it does not hold (404).
 */
import { expect, vi } from "vitest";
import { ISO, act, answerSyncWith, mailbox, mountShell, tick } from "./live-walk-shell.js";
import { resetResumeLaneForTests } from "../../app/shell/resume-lane";

export const ME = "walker@example.invalid";
export const LENA = { name: "Lena", address: "lena@example.invalid" };
let seq = 0;

const create = (type: string, id: string, entity: Record<string, unknown>) => ({
  type, op: "create", id, seq: ++seq, updatedAt: ISO, entity,
});
/** A message of thread T (or `over.threadId`), minute `n` after 08:00 on 2026-08-03. */
export const msg = (id: string, n: number, over: Record<string, unknown> = {}) => {
  const at = new Date(Date.UTC(2026, 7, 3, 8, n)).toISOString();
  return create("message", id, {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: "T", messageIdHeader: null,
    subject: "Q3 plan", from: LENA, to: [{ name: null, address: ME }], cc: [], date: at, arrivedAt: at, sortAt: at,
    folder: "INBOX", snippet: `the words of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
  });
};
export const pinOf = (id: string) => {
  const pin = { id: `ms_${id}`, messageId: id, state: "resurfaced", bubbleUpAt: null, setAt: ISO, updatedAt: ISO };
  return { pin, row: create("message_state", `ms_${id}`, pin) };
};
const consent = (address: string) => create("rule", `rule_${address}`, {
  id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
  provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});
const thread = (tid: string, ids: string[]) => create("thread", tid, {
  id: tid, accountId: "acct_live_1", rootMessageIdHeader: null, subject: "Q3 plan", messageIds: ids,
  lastMessageAt: ISO, participants: [], updatedAt: ISO,
});
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type ReadPatch = { ids: string[]; unread: boolean; via?: string };
/** Every `PATCH /messages` the engine sent, in order. */
export let patches: ReadPatch[] = [];
/** An id the server does not hold: a PATCH naming it answers 404. */
let staleId: string | null = null;
export const serverLacks = (id: string | null): void => { staleId = id; };

export const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await tick(50); };

/** Serve `messages` (thread T, consented sender) once, record the read wire, mount the shell. */
export async function mountThread(messages: unknown[]): Promise<HTMLElement> {
  resetResumeLaneForTests();
  seq = 0;
  patches = [];
  staleId = null;
  const byThread = new Map<string, string[]>();
  for (const m of messages as Array<{ type: string; id: string; entity: { threadId?: string } }>) {
    if (m.type !== "message") continue;
    const tid = m.entity.threadId ?? "T";
    byThread.set(tid, [...(byThread.get(tid) ?? []), m.id]);
  }
  const creates = [consent(LENA.address), ...messages, ...[...byThread].map(([tid, ids]) => thread(tid, ids))];
  // The page stands until the client writes its first read; after that the drains are empty.
  let served = 0;
  answerSyncWith(() => json({
    changes: { creates: patches.length === 0 ? creates : [], updates: [], moves: [], deletes: [] },
    cursor: `c${seq}-${++served}`, hasMore: false, serverTime: ISO,
  }));
  const base = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "PATCH" && /\/messages(\?|$)/.test(String(input))) {
      const body = JSON.parse(String(init!.body)) as ReadPatch;
      patches.push(body);
      if (body.ids.length > 200) return json({ error: "too_many_ids" }, 413);
      if (staleId !== null && body.ids.includes(staleId)) return json({ error: "not_found" }, 404);
      return json({});
    }
    return base(input as RequestInfo, init);
  }) as unknown as typeof globalThis.fetch;
  const host = await mountShell([mailbox({ id: "mb_1", address: ME, lastSyncAt: ISO })]);
  await settle();
  return host;
}

export const click = async (el: Element | null | undefined, what: string): Promise<void> => {
  expect(el, `nothing to click: ${what}`).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
};
export const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};
/** The conversation's one Ohbox row. */
export const theRow = (host: HTMLElement): HTMLElement | null =>
  host.querySelector<HTMLElement>('[role="listbox"] .row');
/** A row press, as a person makes it: at a split width the first click selects and the second opens. */
export const openTheRow = async (host: HTMLElement): Promise<void> => {
  await click(theRow(host), "the conversation's row");
  if (!document.querySelector(".reader .conv")) await click(theRow(host), "the conversation's row");
};
/** The read slot of the bar in `scope` (the column or the sheet). */
export const readSlot = (scope: ParentNode): HTMLElement | null => scope.querySelector<HTMLElement>(".abar .abar-read");
export const toastText = (): string =>
  [...document.querySelectorAll<HTMLElement>(".toast")].map((t) => t.textContent ?? "").join(" | ");
