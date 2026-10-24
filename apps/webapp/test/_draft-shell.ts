/**
 * THE REAL SHELL OVER A MIRROR THAT HOLDS DRAFTS — the harness the reply-draft guards share.
 *
 * `AppShell` behind the Cloud providers, an engine over a `MemoryMirrorStore` whose adapter
 * applies each verb's own effects and records it, and an organizer roster so a send is allowed.
 * `refuseSend` answers a `mail_send` the way the route answers a send refused for good — the row
 * the send used or made named in `entityId`. jsdom gaps are stubbed at their narrowest.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import {
  CursorExpiredError,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  mutationEffects,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import type { DraftReplyWire } from "../app/shell/draft-reply";
import { settleEditor, settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
export const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

export const NOW = new Date("2026-09-27T09:00:00.000Z");
const SENDER = "colleague@example.invalid";

export interface DraftShell {
  el: HTMLElement;
  engine: OhmailEngine;
  store: MirrorStore;
  /** Every verb this shell put on the wire, in order. */
  sent: EngineMutation[];
  /**
   * While on, a `mail_send` is refused and names the row it used or made — for good, or unverified.
   * `code`/`status` name the refusal (default `send_failed`, 409); `retryableFirst` answers that
   * many presses retryably first, as the route does while it re-arms a pre-SMTP failure.
   */
  refuseSend: { on: boolean; unverified?: boolean; code?: string; status?: number; retryableFirst?: number };
  /** While set, a `draft_save` waits on it before the server answers — a save still in the air. */
  saveGate: { wait: Promise<void> | null };
  /** Another device's acts, server-side: the next `/sync` drain carries and empties this. */
  remote: SyncChange[];
  /** While on, every verb is refused retryably — no signal — and waits on the outbox. */
  offline: { on: boolean };
  /** While set, a `mail_send` waits on it before the server answers — a send still on the wire. */
  sendGate: { wait: Promise<void> | null };
  /** Rows another device deleted on the server: a save or send naming one is answered 404. */
  serverGone: Set<string>;
  /**
   * A full resync: while `armed`, the next `/sync` answers 410; the re-bootstrap's first page holds
   * the rules and no drafts, with more to come, and its second waits on `gate`, then carries `remote`.
   */
  resync: { armed: boolean; gate: Promise<void> | null; phase: 0 | 1 | 2 };
  /** While on, a `draft_discard` is refused 409 `send_recorded`, as for a row with a send running. */
  refuseDiscard: { on: boolean };
  /** While on, a delivered `mail_send` leaves the row it named `sent`, as the route does: no longer in Drafts. */
  spendSentRow: { on: boolean };
  /** What `POST /sends/withdraw` answers a Cancel while online; `null` (the default) is a server that cannot be asked. */
  withdrawAnswer: { outcome: "withdrawn" | null };
  /**
   * While off (the default), the engine reports its outbox held, so every send waits in its editor —
   * the unhealthy path, today's behaviour, which the editor-line suites pin. On, a healthy press
   * leaves its editor and the sidebar's foot finishes it (`send-handoff.test.tsx`).
   */
  handOff: { on: boolean };
}

let roots: Root[] = [];
let seq = 0;

export function stubDom(opts: { narrow?: boolean } = {}): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: opts.narrow === true && /max-width/.test(query), media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
}

export async function unmountAll(): Promise<void> {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
}

export const message = (id: string, over: Partial<EngineMessage> = {}): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: SENDER, name: "The colleague" },
  to: [{ address: "me@example.invalid", name: "Me" }], cc: [],
  date: "2026-09-27T08:29:00.000Z", unread: false, snippet: `snippet of ${id}`,
  updatedAt: "2026-09-27T08:29:00.000Z",
  ...over,
} as unknown as EngineMessage);

export const replyDraft = (id: string, parent: string, body: string): EngineDraft => ({
  id, mailboxId: "mb1", threadId: `t-${parent}`, inReplyToMessageId: parent,
  subject: `Re: Subject ${parent}`, body,
  to: [{ name: "The colleague", address: SENDER }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft);

async function storeWith(messagesIn: EngineMessage[], drafts: EngineDraft[]): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  const changes: SyncChange[] = [];
  for (const m of messagesIn) {
    changes.push({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m } as SyncChange);
  }
  // One rule for the sender, so the mail presents in the Ohbox rather than at the gate.
  changes.push({
    type: "rule", op: "create", id: "r-colleague", seq: ++seq, updatedAt: NOW.toISOString(),
    entity: {
      id: "r-colleague", kind: "sender", match: SENDER,
      destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
    },
  } as SyncChange);
  for (const d of drafts) {
    changes.push({ type: "draft", op: "create", id: d.id, seq: ++seq, updatedAt: d.updatedAt, entity: d } as SyncChange);
  }
  await s.applyChanges(changes);
  return s;
}

function engineOver(
  s: MirrorStore, sent: EngineMutation[], refuseSend: DraftShell["refuseSend"], saveGate: DraftShell["saveGate"],
  remote: SyncChange[] = [],
  offline: DraftShell["offline"] = { on: false },
  sendGate: DraftShell["sendGate"] = { wait: null },
  serverGone: Set<string> = new Set(),
  resync: DraftShell["resync"] = { armed: false, gate: null, phase: 0 },
  refuseDiscard: DraftShell["refuseDiscard"] = { on: false },
  spendSentRow: DraftShell["spendSentRow"] = { on: false },
  withdrawAnswer: DraftShell["withdrawAnswer"] = { outcome: null },
): OhmailEngine {
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => {
        if (resync.armed) {
          resync.armed = false;
          resync.phase = 1;
          throw new CursorExpiredError();
        }
        if (resync.phase === 1) {
          resync.phase = 2;
          const snap = `snap-${++seq}`;
          // The snapshot's first page: the rules, and not yet the drafts.
          const rule = {
            type: "rule", op: "create", id: "r-colleague", seq: ++seq, updatedAt: NOW.toISOString(),
            entity: {
              id: "r-colleague", kind: "sender", match: SENDER,
              destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
            },
          } as SyncChange;
          return {
            changes: { creates: [rule], updates: [], moves: [], deletes: [] },
            cursor: snap, hasMore: true, serverTime: NOW.toISOString(),
          };
        }
        if (resync.phase === 2) {
          resync.phase = 0;
          if (resync.gate) await resync.gate;
        }
        const changes = remote.splice(0).map((c) => ({ ...c, seq: ++seq }));
        return {
          changes: {
            creates: changes.filter((c) => c.op !== "delete"), updates: [], moves: [],
            deletes: changes.filter((c) => c.op === "delete"),
          },
          cursor: changes.length > 0 ? `remote-${seq}` : s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        if (offline.on) throw new MutationRejectedError("no signal", { code: "network", retryable: true });
        sent.push(m);
        const named = m.kind === "draft_save" || m.kind === "mail_send" ? m.draftId ?? null : null;
        if (named !== null && serverGone.has(named)) {
          throw new MutationRejectedError("draft not found", { status: 404, code: "not_found", retryable: false });
        }
        if (m.kind === "draft_discard" && refuseDiscard.on) {
          throw new MutationRejectedError("this message has a send on record", { status: 409, code: "send_recorded", retryable: false });
        }
        if (m.kind === "draft_save" && saveGate.wait) await saveGate.wait;
        if (m.kind === "mail_send" && sendGate.wait) await sendGate.wait;
        if (m.kind === "mail_send" && refuseSend.on && (refuseSend.retryableFirst ?? 0) > 0) {
          refuseSend.retryableFirst! -= 1;
          throw new MutationRejectedError("not sent yet", {
            status: refuseSend.status ?? 409, code: refuseSend.code ?? "send_failed", retryable: true,
          });
        }
        if (m.kind === "mail_send" && refuseSend.on) {
          // The route's own answer to a send refused for good: the row stays a draft, and the
          // refusal names it — the row the send carried, or the one it made.
          let rowId = m.draftId ?? null;
          if (rowId === null) {
            rowId = `row-${++seq}`;
            await s.applyChanges([{
              type: "draft", op: "create", id: rowId, seq: ++seq, updatedAt: NOW.toISOString(),
              entity: {
                ...replyDraft(rowId, m.inReplyTo ?? "", m.body ?? ""),
                inReplyToMessageId: m.inReplyTo ?? null,
              },
            } as SyncChange]);
          }
          throw new MutationRejectedError("The receiving server refused this message.", {
            status: refuseSend.status ?? 409,
            code: refuseSend.unverified ? "send_unverified" : refuseSend.code ?? "send_failed",
            retryable: false, entityId: rowId,
          });
        }
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        const spent = m.kind === "mail_send" && spendSentRow.on && m.draftId ? s.get<EngineDraft>("draft", m.draftId) : undefined;
        if (spent) {
          changes.push({
            type: "draft", op: "update", id: spent.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: { ...spent, status: "sent" },
          } as unknown as SyncChange);
        }
        await s.applyChanges(changes);
        // A draft write names its row, as the HTTP adapter's does: a create's id is the server's.
        const entityId = m.kind === "draft_save" ? (m.draftId ?? changes[0]?.id) : undefined;
        return { changes, seq: changes[changes.length - 1]?.seq ?? null, ...(entityId ? { entityId } : {}) };
      },
      withdrawSend: async () => (offline.on || withdrawAnswer.outcome === null
        ? { outcome: "unreachable" as const }
        : { outcome: withdrawAnswer.outcome }),
      /* `GET /drafts/:id`: a row another device deleted answers 404, as the route does. */
      fetchDraftBody: async (id: string) => {
        if (serverGone.has(id)) throw new MutationRejectedError("draft not found", { status: 404, code: "not_found", retryable: false });
        return s.get("draft", id) ? "the text of the draft" : "the text of the draft on the server";
      },
      fetchBody: async (id: string) => ({
        text: `the text of ${id}`, html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

/** The account's settings wire; `signatures` is each mailbox's stored signature, as the server echoes it. */
const consentTransportWith = (signatures?: Record<string, string>) => ({
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z",
    screeningResetAt: null, dormancyDays: 90,
    foldersEnabledAt: "2026-09-01T00:00:00.000Z",
    ...(signatures !== undefined ? { signatures } : {}),
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: signatures ?? {} }),
});

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-27T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

/** Rounds of one short macrotask each, so the shell's timers and module loads can land between. */
export async function waitFor(predicate: () => boolean, what: string, rounds = 120): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${rounds} rounds waiting for: ${what}`);
}

/** Mount the shell at `hash` over these messages and drafts. */
export async function mountShell(
  hash: string, messagesIn: EngineMessage[], drafts: EngineDraft[] = [],
  options: {
    draftReplyWire?: DraftReplyWire; signatures?: Record<string, string>; handOff?: boolean;
    /** A second sending address (`mb2`), so a reply dock offers a From pick. */
    secondMailbox?: boolean;
    /** Rows already deleted on the server when the page opens. */
    serverGone?: string[];
  } = {},
): Promise<DraftShell> {
  window.location.hash = hash;
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const store = await storeWith(messagesIn, drafts);
  const sent: EngineMutation[] = [];
  const refuseSend: DraftShell["refuseSend"] = { on: false };
  const saveGate: DraftShell["saveGate"] = { wait: null };
  const remote: SyncChange[] = [];
  const offline: DraftShell["offline"] = { on: false };
  const sendGate: DraftShell["sendGate"] = { wait: null };
  const serverGone = new Set<string>(options.serverGone ?? []);
  const resync: DraftShell["resync"] = { armed: false, gate: null, phase: 0 };
  const refuseDiscard: DraftShell["refuseDiscard"] = { on: false };
  const spendSentRow: DraftShell["spendSentRow"] = { on: false };
  const withdrawAnswer: DraftShell["withdrawAnswer"] = { outcome: null };
  const engine = engineOver(
    store, sent, refuseSend, saveGate, remote, offline, sendGate, serverGone, resync, refuseDiscard, spendSentRow, withdrawAnswer,
  );
  const handOff: DraftShell["handOff"] = { on: options.handOff === true };
  const outboxHeld = engine.outboxHeld.bind(engine);
  engine.outboxHeld = () => !handOff.on || outboxHeld();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false, engine, consentTransport: consentTransportWith(options.signatures),
            mailboxFacts: async () => (options.secondMailbox === true
              ? [...ROSTER, { ...ROSTER[0]!, id: "mb2", address: "me2@example.invalid", createdAt: "2026-09-02T00:00:00.000Z" }]
              : ROSTER),
            ...(options.draftReplyWire !== undefined ? { draftReplyWire: options.draftReplyWire } : {}),
          } as never),
        }),
      }),
    }));
  });
  await settleFirstPaint();
  return {
    el, engine, store, sent, refuseSend, saveGate, remote, offline, sendGate, serverGone, resync, refuseDiscard, spendSentRow,
    withdrawAnswer, handOff,
  };
}

/** A real press: the pointer's three events, then the editor's lazy seam. */
export async function press(target: Element | null, what: string): Promise<void> {
  if (!target) throw new Error(`nothing to press: ${what}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settleEditor();
}

/** The inline reply's editing surface, wherever the message is read. */
export const replySurface = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".read-col .msg .rte-surface, .reader .msg .rte-surface");
