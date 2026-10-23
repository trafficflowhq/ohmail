/**
 * THE STEPS THE HAND-OFF SUITES SHARE, on `_draft-shell.ts`'s real shell: a send held on the wire,
 * the sidebar's foot line and the toasts read as text, the doors back to a message, and what a
 * press put on the wire.
 */
import { expect } from "vitest";
import type { ComposeAttachment, EmailAddress, EngineDraft, EngineMutation, SyncChange } from "@ohmail/client-engine";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { act, press, replySurface, waitFor, type DraftShell } from "./_draft-shell.js";

export const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
export const discards = (s: DraftShell): string[] => s.sent
  .filter((m): m is Extract<EngineMutation, { kind: "draft_discard" }> => m.kind === "draft_discard")
  .map((m) => m.draftId);

/** Every row the rail's foot line holds, as one string. */
export const footLine = (): string =>
  [...document.querySelectorAll(".rail-sync.sending-line")].map((n) => n.textContent ?? "").join(" | ");
export const toasts = (): string =>
  [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
/** A button of the rail's foot line, by its label. */
export const footButton = (label: string): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>(".rail-sync.sending-line .sl-act")]
    .find((b) => b.textContent === label) ?? null;

export const composeSend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".view-compose .send-row button")]
    .find((b) => /^(Send|Sending|Sent)/.test((b.textContent ?? "").trim()) && !/later/i.test(b.textContent ?? ""));
export const composeLine = (el: HTMLElement): string => el.querySelector(".view-compose .send-status")?.textContent ?? "";
export const composeSubject = (el: HTMLElement): string | null =>
  el.querySelector<HTMLInputElement>("#compose-subject")?.value ?? null;
export const replySend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));
export const dock = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(".read-col .reply, .reader .reply");

/** Hold the next `mail_send` on the wire; the returned function lets it answer. */
export const holdTheWire = (s: DraftShell): (() => void) => {
  let release!: () => void;
  s.sendGate.wait = new Promise<void>((r) => { release = r; });
  return () => { s.sendGate.wait = null; release(); };
};
/** The server's own write to a draft row, dated now, carried by the next drain. */
export async function drainRow(s: DraftShell, row: EngineDraft): Promise<void> {
  const at = new Date().toISOString();
  s.remote.push({ type: "draft", op: "update", id: row.id, seq: 0, updatedAt: at, entity: { ...row, updatedAt: at } } as unknown as SyncChange);
  await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
}
/** The harness keeps a send's client-side `sending` row as if the server wrote it; no server does. */
export async function dropSendOverlay(s: DraftShell, keep: string): Promise<void> {
  const ghosts = s.engine.read().list<EngineDraft>("draft").filter((d) => d.status === "sending" && d.id !== keep);
  for (const g of ghosts) {
    s.remote.push({ type: "draft", op: "delete", id: g.id, seq: 0, updatedAt: new Date().toISOString(), entity: null } as unknown as SyncChange);
  }
  if (ghosts.length > 0) await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
}
export const navigate = async (hash: string): Promise<void> => {
  await act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });
};
export const rounds = async (n: number, ms = 25): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};
export async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}

/** Open a Drafts row into its editor (the composer, or a reply's dock), from `#/drafts`. */
export async function openDraftRow(s: DraftShell, id: string): Promise<void> {
  await waitFor(() => s.el.querySelector(`.draft-row[data-id='${id}'] .draft-open`) != null, `${id} in Drafts`);
  await press(s.el.querySelector(`.draft-row[data-id='${id}'] .draft-open`), `open ${id}`);
}
/** …and wait for the composer to hold it. */
export async function composerOn(s: DraftShell, id: string, subject: string): Promise<void> {
  await openDraftRow(s, id);
  await waitFor(() => composeSubject(s.el) === subject, `the composer on ${id}`);
}

/** Select a row in the Ohbox and open its dock with `k` (r, R, F). */
export async function dockOn(s: DraftShell, id: string, k = "r", shiftKey = false): Promise<void> {
  await waitFor(() => s.el.querySelector(`.view-ohbox .row[data-id='${id}']`) != null, `the row ${id}`);
  await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), `the row ${id}`);
  await key(k, shiftKey ? { shiftKey: true } : {});
  await waitFor(() => replySurface(s.el) != null, `the dock on ${id}`);
}
export async function replyOn(s: DraftShell, id: string, words: string): Promise<void> {
  await dockOn(s, id);
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

export async function typeRecipient(el: HTMLElement, label: string, text: string): Promise<void> {
  const l = [...dock(el)!.querySelectorAll<HTMLLabelElement>(".reply-rcpt label")].find((x) => x.textContent === label)!;
  const input = document.getElementById(l.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}
export async function pickFrom(el: HTMLElement, mailboxId: string): Promise<void> {
  const select = [...dock(el)!.querySelectorAll<HTMLSelectElement>("select")]
    .find((x) => [...x.options].some((o) => o.value === mailboxId));
  expect(select, "a From pick is offered").toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select!, mailboxId);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
/** Attach a small file through the editor's own Attach input inside `scope`. */
export async function attach(scope: HTMLElement, name: string): Promise<void> {
  const input = scope.querySelector<HTMLInputElement>('.compose-attach input[type="file"]');
  expect(input, "the editor offers Attach").not.toBeNull();
  const file = new File([new Uint8Array(512)], name, { type: "text/plain" });
  Object.defineProperty(input!, "files", { value: [file], configurable: true });
  await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
  await rounds(8, 20);
}

type Wire = EngineMutation & {
  to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[]; mailboxId?: string; attachments?: ComposeAttachment[];
};
/** What a press put on the wire that the person chose: audience, sending mailbox, files. */
export const shape = (m: EngineMutation | undefined): string => {
  if (m === undefined) return "(none)";
  const w = m as Wire;
  const who = (xs: EmailAddress[] | undefined): string => (xs ?? []).map((x) => x.address).join(",");
  const files = (w.attachments ?? []).map((a) => a.filename).join(",");
  return `to=${who(w.to)} cc=${who(w.cc)} bcc=${who(w.bcc)} from=${w.mailboxId ?? "(unset)"} files=${files}`;
};

export const letter = (id: string, subject: string, body: string, to = { name: "Mila", address: "mila@example.invalid" }): EngineDraft => ({
  id, mailboxId: "mb1", threadId: null, inReplyToMessageId: null, subject, body,
  to: [to], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft);
