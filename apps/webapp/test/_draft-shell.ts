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
import { sendFingerprint } from "@ohmail/client-engine/send-fingerprint";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import type { DraftReplyWire } from "../app/shell/draft-reply";
import { settleEditor, settleFirstPaint } from "./_first-paint.js";
import { typeInto } from "./fixtures/rich-editor-driver";

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
   * many presses retryably first, as the route does while it re-arms a pre-SMTP failure; `saveFirst`:
   * the send's own save answers before each of those (its row takes the words, and the engine is told).
   */
  refuseSend: { on: boolean; unverified?: boolean; code?: string; status?: number; retryableFirst?: number; saveFirst?: boolean };
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
  /**
   * With `versions` mounted: each row's version on the server. A save or a send stating another
   * version is refused 409 `draft_changed`, as the route does, unless it restates the row's words.
   */
  versions: Map<string, string>;
  /** Another device saves `patch` into a row: the server's version moves; the next `/sync` carries it. */
  editElsewhere: (id: string, patch: Partial<EngineDraft>) => Promise<void>;
  /** While on, a `mail_send` is delivered and its answer lost; a later press under that key is answered from the reservation. */
  loseSendAnswer: { on: boolean };
  /** Rows whose saves the server refuses for good (400 `validation_failed`), as it refuses an edit it cannot take. */
  refuseSave: Set<string>;
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

/**
 * ONE ACCOUNT'S DRAFTS ON A SERVER TWO DEVICES SHARE: rows, a change log, and the drafts and send
 * routes' answers. Device A is a mounted shell (`mountShell(..., { server })`), device B a headless
 * engine over the same server ({@link DraftServer.device}). A sent row's text is withheld from the log.
 */
export class DraftServer {
  rows = new Map<string, EngineDraft>();
  log: SyncChange[] = [];
  constructor(seed: EngineDraft[] = []) {
    for (const d of seed) this.commit({ ...d, contentRevision: `rev-${++seq}` }, "create");
  }
  private commit(d: EngineDraft, op: "create" | "update" | "delete"): SyncChange {
    if (op === "delete") this.rows.delete(d.id);
    else this.rows.set(d.id, d);
    const entity = op === "delete" ? null
      : d.status === "sent" ? { ...d, body: null, html: null, bodyOmitted: "sent" } : d;
    const c = { type: "draft", op, id: d.id, seq: ++seq, updatedAt: NOW.toISOString(), entity } as unknown as SyncChange;
    this.log.push(c);
    return c;
  }
  /** The log after `cursor`, as `/sync` pages it. */
  since(cursor: string | null | undefined): { changes: SyncChange[]; cursor: string } {
    const from = Number(/^srv-(\d+)$/.exec(cursor ?? "")?.[1] ?? 0);
    return { changes: this.log.slice(from), cursor: `srv-${this.log.length}` };
  }
  /**
   * The routes: a create; an update with the version check, and on a sent row only an unstated
   * restatement of its words (200, no seq), else 409 `draft_sent`; a delete; a send moves a draft to
   * `sent`, and any other row answers 409 `conflict`. Other verbs are not this server's (`null`).
   */
  answer(m: EngineMutation): { changes: SyncChange[]; seq: number | null; entityId?: string; revision?: string } | null {
    const refuse = (status: number, code: string): never => {
      throw new MutationRejectedError(code, { status, code, retryable: false });
    };
    const at = NOW.toISOString();
    if (m.kind === "draft_save") {
      const fields = {
        subject: m.subject, body: m.body, html: m.html ?? null, to: m.to, cc: m.cc, bcc: m.bcc,
        ...(m.mailboxId ? { mailboxId: m.mailboxId } : {}),
      };
      if (m.draftId === null) {
        const id = `srv-row-${++seq}`;
        const d = {
          id, mailboxId: "mb1", threadId: m.threadId ?? null, inReplyToMessageId: m.inReplyToMessageId ?? null,
          rationale: null, status: "draft", createdAt: at, updatedAt: at, contentRevision: `rev-${++seq}`, ...fields,
        } as unknown as EngineDraft;
        const c = this.commit(d, "create");
        return { changes: [c], seq: c.seq, entityId: id, revision: d.contentRevision! };
      }
      const row = this.rows.get(m.draftId) ?? refuse(404, "not_found");
      const who = (xs: readonly { address: string }[]): string => xs.map((a) => a.address.toLowerCase()).join(",");
      const same = row.subject === m.subject && row.body === m.body && who(row.to) === who(m.to);
      if (row.status === "sent") {
        if (m.ifContentRevision === undefined && same) return { changes: [], seq: null, entityId: row.id };
        refuse(409, "draft_sent");
      }
      if (row.status !== "draft") refuse(409, "send_recorded");
      if (m.ifContentRevision !== undefined && m.ifContentRevision !== row.contentRevision) refuse(409, "draft_changed");
      const d = { ...row, ...fields, updatedAt: at, contentRevision: `rev-${++seq}` } as EngineDraft;
      const c = this.commit(d, "update");
      return { changes: [c], seq: c.seq, entityId: row.id, revision: d.contentRevision! };
    }
    if (m.kind === "draft_discard") {
      const row = this.rows.get(m.draftId) ?? refuse(404, "not_found");
      const c = this.commit(row, "delete");
      return { changes: [c], seq: c.seq };
    }
    if (m.kind === "mail_send") {
      const row = m.draftId ? this.rows.get(m.draftId) : undefined;
      if (m.draftId && row?.status !== "draft") refuse(409, "conflict");
      const id = row?.id ?? `srv-row-${++seq}`;
      const d = {
        ...(row ?? { id, threadId: null, inReplyToMessageId: m.inReplyTo, rationale: null, createdAt: at }),
        mailboxId: m.mailboxId ?? row?.mailboxId ?? "mb1", subject: m.subject ?? row?.subject ?? "", body: m.body,
        html: m.html ?? null, to: m.to ?? row?.to ?? [], cc: m.cc ?? row?.cc ?? [], bcc: m.bcc ?? row?.bcc ?? [],
        status: "sent", updatedAt: at,
      } as unknown as EngineDraft;
      const c = this.commit(d, row ? "update" : "create");
      return { changes: [c], seq: c.seq };
    }
    return null;
  }
  /** Device B: a headless engine over this server, drained once. */
  async device(): Promise<OhmailEngine> {
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({
      store, now: () => NOW,
      adapter: {
        sync: async ({ since }: { since: string | null }) => {
          const page = this.since(since);
          return {
            changes: {
              creates: page.changes.filter((c) => c.op === "create"), updates: page.changes.filter((c) => c.op === "update"),
              moves: [], deletes: page.changes.filter((c) => c.op === "delete"),
            },
            cursor: page.cursor, hasMore: false, serverTime: NOW.toISOString(),
          };
        },
        mutate: async (m: EngineMutation) => this.answer(m) ?? { changes: [], seq: null },
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
      },
    } as never);
    await engine.start();
    return engine;
  }
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
  versions: Map<string, string> | null = null,
  loseSendAnswer: DraftShell["loseSendAnswer"] = { on: false },
  replayDeadlineMs?: number,
  server?: DraftServer,
  refuseSave: Set<string> = new Set(),
  parts = false,
): OhmailEngine {
  const delivered = new Set<string>();
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    ...(replayDeadlineMs !== undefined ? { outboxReplayDeadlineMs: replayDeadlineMs } : {}),
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
        if (server !== undefined) {
          const page = server.since(s.getCursor());
          const all = [...page.changes, ...remote.splice(0).map((c) => ({ ...c, seq: ++seq }))];
          return {
            changes: { creates: all.filter((c) => c.op !== "delete"), updates: [], moves: [], deletes: all.filter((c) => c.op === "delete") },
            cursor: page.cursor, hasMore: false, serverTime: NOW.toISOString(),
          };
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
      mutate: async (m: EngineMutation, o?: {
        idempotencyKey?: string; onDraftRow?: (row: { id: string; revision: string | null; fingerprint: string }) => Promise<void>;
      }) => {
        if (offline.on) throw new MutationRejectedError("no signal", { code: "network", retryable: true });
        sent.push(m);
        const sendKey = m.kind === "mail_send" ? o?.idempotencyKey ?? null : null;
        if (sendKey !== null && delivered.has(sendKey)) {
          return { changes: [], seq: null, firstSend: { status: "sent", at: NOW.toISOString() } };
        }
        const named = m.kind === "draft_save" || m.kind === "mail_send" ? m.draftId ?? null : null;
        if (named !== null && serverGone.has(named)) {
          throw new MutationRejectedError("draft not found", { status: 404, code: "not_found", retryable: false });
        }
        if (m.kind === "draft_save" && named !== null && refuseSave.has(named)) {
          throw new MutationRejectedError("this draft cannot take that edit", { status: 400, code: "validation_failed", retryable: false });
        }
        if (m.kind === "draft_discard" && refuseDiscard.on) {
          throw new MutationRejectedError("this message has a send on record", { status: 409, code: "send_recorded", retryable: false });
        }
        if (m.kind === "draft_save" && saveGate.wait) await saveGate.wait;
        if (m.kind === "mail_send" && sendGate.wait && server !== undefined) await sendGate.wait;
        // The shared server answers the drafts and send routes; the mirror takes what it answered.
        const served = server?.answer(m);
        if (served != null) {
          const local = m.kind === "mail_send"
            ? mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` })
              .filter((e) => e.type !== "draft")
              .map((e) => ({
                type: e.type, op: e.entity === null ? "delete" : "update", id: e.id, seq: ++seq,
                updatedAt: NOW.toISOString(), entity: e.entity,
              }) as unknown as SyncChange)
            : [];
          await s.applyChanges([...local, ...served.changes]);
          if (sendKey !== null) delivered.add(sendKey);
          return {
            changes: [...local, ...served.changes], seq: served.seq,
            ...(served.entityId ? { entityId: served.entityId } : {}), ...(served.revision ? { revision: served.revision } : {}),
          };
        }
        // The route's version check: a row moved off the stated version refuses the edit.
        const stated = m.kind === "draft_save" || m.kind === "mail_send" ? m.ifContentRevision : undefined;
        if (versions !== null && named !== null && stated !== undefined && versions.has(named) && versions.get(named) !== stated) {
          const held = s.get<EngineDraft>("draft", named);
          const same = m.kind === "draft_save" && held !== undefined && held.subject === m.subject && held.body === m.body;
          if (same) return { changes: [], seq: null, entityId: named, revision: versions.get(named)! };
          throw new MutationRejectedError("this draft was changed elsewhere", {
            status: 409, code: "draft_changed", retryable: false, ...(m.kind === "mail_send" ? { entityId: named } : {}),
          });
        }
        if (m.kind === "mail_send" && sendGate.wait) await sendGate.wait;
        if (m.kind === "mail_send" && refuseSend.on && (refuseSend.retryableFirst ?? 0) > 0) {
          refuseSend.retryableFirst! -= 1;
          const row = refuseSend.saveFirst === true && m.draftId ? s.get<EngineDraft>("draft", m.draftId) : undefined;
          if (row !== undefined) {
            // The route's save before the send: the row holds the press's words, and the adapter reports it.
            const revision = versions !== null ? `rev-${++seq}` : null;
            if (revision !== null) versions!.set(row.id, revision);
            await s.applyChanges([{
              type: "draft", op: "update", id: row.id, seq: ++seq, updatedAt: NOW.toISOString(),
              entity: {
                ...row, subject: m.subject ?? "", body: m.body, html: m.html ?? null, to: m.to ?? [], cc: m.cc ?? [], bcc: m.bcc ?? [],
                ...(revision !== null ? { contentRevision: revision } : {}),
              },
            } as unknown as SyncChange]);
            await o?.onDraftRow?.({ id: row.id, revision, fingerprint: sendFingerprint(m) });
          }
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
        // A draft write names its row, as the HTTP adapter's does: a create's id is the server's.
        const entityId = m.kind === "draft_save" ? (m.draftId ?? changes[0]?.id) : undefined;
        let revision: string | undefined;
        if (versions !== null && entityId) {
          revision = `rev-${++seq}`;
          versions.set(entityId, revision);
          for (const c of changes) if (c.id === entityId && c.entity) (c.entity as { contentRevision?: string }).contentRevision = revision;
        }
        await s.applyChanges(changes);
        if (sendKey !== null) delivered.add(sendKey);
        if (sendKey !== null && loseSendAnswer.on) {
          throw new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
        }
        return { changes, seq: changes[changes.length - 1]?.seq ?? null, ...(entityId ? { entityId } : {}), ...(revision ? { revision } : {}) };
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
      // Each message's three files, and a server that announces forward parts.
      ...(parts ? {
        listAttachments: async (id: string) => FORWARD_PARTS.map((p) => ({ ...p, messageId: id })),
        fetchAttachment: async () => new Blob(["x"]),
        forwardPartsAnnounced: async () => true,
      } : {}),
    },
  } as never);
}

/** The files `mountShell(..., { parts: true })` lists on every message. */
export const FORWARD_PARTS = [
  { id: "a0000000-0000-4000-8000-000000000001", filename: "plan.pdf", contentType: "application/pdf", sizeBytes: 1000, inline: false },
  { id: "b0000000-0000-4000-8000-000000000002", filename: "logo.png", contentType: "image/png", sizeBytes: 200, inline: true },
  { id: "c0000000-0000-4000-8000-000000000003", filename: "budget.xlsx", contentType: "application/octet-stream", sizeBytes: 3000, inline: false },
];

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
    /** Rows carry server versions (`contentRevision`), and the route's version check runs. */
    versions?: boolean;
    /** The store a page before this one left: a reload over the same browser. */
    store?: MirrorStore;
    /** The outbox's replay deadline, short so a hung save arms the hold within a test. */
    outboxReplayDeadlineMs?: number;
    /** A server another device shares: its rows seed this mirror, and its routes answer the draft verbs. */
    server?: DraftServer;
    /** No signal from the first moment: a boot's replay cannot reach the routes. */
    startOffline?: boolean;
    /** A send gate set before the engine starts, so a restored send's replay waits on it. */
    sendGate?: DraftShell["sendGate"];
    /** Every message carries three files (`FORWARD_PARTS`), and the server takes a forward's kept list. */
    parts?: boolean;
  } = {},
): Promise<DraftShell> {
  window.location.hash = hash;
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const versions = options.versions === true ? new Map<string, string>() : null;
  if (versions !== null) for (const d of drafts) versions.set(d.id, d.contentRevision ?? `rev-${d.id}`);
  const seeded = options.server !== undefined ? [...options.server.rows.values()]
    : versions === null ? drafts : drafts.map((d) => ({ ...d, contentRevision: versions.get(d.id)! }));
  const store = options.store ?? await storeWith(messagesIn, seeded);
  const sent: EngineMutation[] = [];
  const refuseSend: DraftShell["refuseSend"] = { on: false };
  const saveGate: DraftShell["saveGate"] = { wait: null };
  const remote: SyncChange[] = [];
  const offline: DraftShell["offline"] = { on: options.startOffline === true };
  const sendGate: DraftShell["sendGate"] = options.sendGate ?? { wait: null };
  const serverGone = new Set<string>(options.serverGone ?? []);
  const resync: DraftShell["resync"] = { armed: false, gate: null, phase: 0 };
  const refuseDiscard: DraftShell["refuseDiscard"] = { on: false };
  const spendSentRow: DraftShell["spendSentRow"] = { on: false };
  const withdrawAnswer: DraftShell["withdrawAnswer"] = { outcome: null };
  const loseSendAnswer: DraftShell["loseSendAnswer"] = { on: false };
  const refuseSave = new Set<string>();
  const engine = engineOver(
    store, sent, refuseSend, saveGate, remote, offline, sendGate, serverGone, resync, refuseDiscard, spendSentRow, withdrawAnswer,
    versions, loseSendAnswer, options.outboxReplayDeadlineMs, options.server, refuseSave, options.parts === true,
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
  const editElsewhere = async (id: string, patch: Partial<EngineDraft>): Promise<void> => {
    const now = store.get<EngineDraft>("draft", id)!;
    const revision = `rev-${++seq}`;
    versions?.set(id, revision);
    remote.push({
      type: "draft", op: "update", id, seq: 0, updatedAt: NOW.toISOString(),
      entity: { ...now, ...patch, contentRevision: revision },
    } as unknown as SyncChange);
  };
  return {
    el, engine, store, sent, refuseSend, saveGate, remote, offline, sendGate, serverGone, resync, refuseDiscard, spendSentRow,
    withdrawAnswer, handOff, versions: versions ?? new Map(), editElsewhere, loseSendAnswer, refuseSave,
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

/** The inline forward's dock (the reply dock in forward mode), on the open message. */
export const forwardDock = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(".read-col .reply[data-reply-for]");

/** Open message `id` (unless one is open) and press Forward in its menu. */
export async function openForward(s: DraftShell, id = "m1"): Promise<void> {
  if (s.el.querySelector(".read-col .msg") == null) {
    await waitFor(() => s.el.querySelector(`.view-ohbox .row[data-id='${id}']`) != null, "the row");
    await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), "the row");
  }
  const panel = s.el.querySelector<HTMLElement>(".read-col .conv-focus") ?? s.el.querySelector<HTMLElement>(".read-col .msg")!;
  await act(async () => { panel.querySelector<HTMLElement>(".msg-more")!.click(); });
  await press([...panel.querySelectorAll<HTMLElement>(".mmenu button")].find((b) => b.textContent?.trim() === "Forward") ?? null, "Forward");
}

/** Type `value` into the forward dock's To row. */
export async function typeForwardTo(s: DraftShell, value: string): Promise<void> {
  const input = forwardDock(s.el)!.querySelector<HTMLInputElement>(".rcp-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Forward on `m1`, `to` in the To row, the third file removed, `note` typed. */
export async function fillForward(s: DraftShell, to: string, note: string): Promise<void> {
  await openForward(s);
  await waitFor(() => forwardDock(s.el) != null, "the forward dock");
  await typeForwardTo(s, `${to}, `);
  await waitFor(() => forwardDock(s.el)!.querySelectorAll("[data-forward-part]").length === 3, "the three files listed");
  const remove = forwardDock(s.el)!.querySelectorAll<HTMLButtonElement>("[data-forward-part] .compose-attach-remove");
  await act(async () => { remove[2]!.click(); });
  await act(async () => { typeInto(forwardDock(s.el)!.querySelector<HTMLElement>(".rte-surface")!, note); });
}

/** The inline reply's editing surface, wherever the message is read. */
export const replySurface = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".read-col .msg .rte-surface, .reader .msg .rte-surface");
