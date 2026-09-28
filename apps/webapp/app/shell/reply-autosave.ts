"use client";

/**
 * The inline reply becomes a row on the account, as the compose form does: the same `draft_save`
 * door, the same two-second pause, the same ceiling. One reply is one row — a lane writes the row
 * it holds (`rowOf`), creates one only when it holds none and nothing refuses it (`refuses`: a
 * send on its way, a held row, a row it cannot read), and takes the created id (`took`). The
 * scratch buffer stays the unsent-text cushion; the row is the record another device opens.
 */

import { useCallback, useEffect, useRef } from "react";
import { draftOverCeiling } from "@trafficflow/core/outbound-text";
import type { EmailAddress, OhmailEngine } from "@ohmail/client-engine";
import { AUTOSAVE_DELAY_MS } from "./compose-autosave";

/** What the open reply editor would store — `null` while no reply editor is open. */
export interface ReplyDraftForm {
  /** The answered message's id: the reply's lane and its `inReplyToMessageId`. */
  lane: string;
  threadId: string | null;
  mailboxId: string | null;
  subject: string;
  /** The subject is the person's own edit, not the derived `Re:` one. */
  subjectEdited: boolean;
  body: string;
  html: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
}

export interface ReplyRowDoors {
  /** The row this reply is and may write now, or `null` when it holds none. */
  rowOf: (lane: string) => string | null;
  /** A write this lane may not make now: its send is on the way, or a row it cannot write stands. */
  refuses: (lane: string) => boolean;
  /** A create confirmed: the lane holds the row, with its stored stamp. */
  took: (lane: string, row: string) => void;
}

/** What a row holds, in the fields the editor writes — its html is not in the mirror. */
export type ReplyRowFields = Pick<ReplyDraftForm, "mailboxId" | "subject" | "body" | "to" | "cc" | "bcc">;

export interface ReplyAutosave {
  /** The Send press: the text sent is not saved again, and a create still in the air is undone. */
  seal: (lane: string) => void;
  /** The editor was seeded from this row: a form that shows what it holds writes nothing. */
  baseline: (lane: string, row: ReplyRowFields) => void;
  /** The reply was delivered: the next reply to that message is a new one. */
  forget: (lane: string) => void;
}

function signatureOf(f: ReplyDraftForm): string {
  const who = (xs: EmailAddress[]) => xs.map((a) => a.address.toLowerCase()).join(",");
  return JSON.stringify([f.mailboxId, f.subject, f.body, f.html, who(f.to), who(f.cc), who(f.bcc)]);
}

/** Something the person wrote: a reply's subject is derived, so a create needs text or a retitle. */
export function replyWorthCreating(f: ReplyDraftForm): boolean {
  return f.body.trim() !== "" || (f.subjectEdited && f.subject.trim() !== "");
}

export function useReplyAutosave(
  engine: OhmailEngine, form: ReplyDraftForm | null, doors: ReplyRowDoors,
): ReplyAutosave {
  const formRef = useRef(form);
  formRef.current = form;
  const doorsRef = useRef(doors);
  doorsRef.current = doors;
  /** Per lane: what the row holds as far as this tab knows, and the text a Send press took. */
  const saved = useRef(new Map<string, string>());
  const sealed = useRef(new Map<string, string>());
  const era = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  /** The last form each lane showed, for the write its close owes. */
  const lastOf = useRef(new Map<string, ReplyDraftForm>());
  if (form !== null) lastOf.current.set(form.lane, form);

  /** Whether `f` is a write this lane may make now — asked when the pause is armed and when it ends. */
  const writable = useCallback((f: ReplyDraftForm, allowCreate: boolean): boolean => {
    const sig = signatureOf(f);
    if (sig === saved.current.get(f.lane) || sig === sealed.current.get(f.lane)) return false;
    if (draftOverCeiling(f.body, f.html)) return false;
    if (doorsRef.current.refuses(f.lane)) return false;
    const row = doorsRef.current.rowOf(f.lane);
    if (row !== null) return true;
    return allowCreate && f.mailboxId !== null && replyWorthCreating(f);
  }, []);

  const writeNow = useCallback(async (f: ReplyDraftForm, allowCreate: boolean): Promise<void> => {
    const lane = f.lane;
    if (inFlight.current.has(lane) || !writable(f, allowCreate)) return;
    const row = doorsRef.current.rowOf(lane);
    const at = era.current.get(lane) ?? 0;
    const sig = signatureOf(f);
    inFlight.current.add(lane);
    try {
      const result = await engine.mutate({
        kind: "draft_save", draftId: row,
        ...(f.mailboxId ? { mailboxId: f.mailboxId } : {}),
        threadId: f.threadId, inReplyToMessageId: lane,
        subject: f.subject, body: f.body, ...(f.html ? { html: f.html } : {}),
        to: f.to, cc: f.cc, bcc: f.bcc,
      });
      if (result.status === "rolled_back") return;
      // A Send pressed while a create was in the air sent without it: the row made here is a copy.
      if (row === null && (era.current.get(lane) ?? 0) !== at) {
        if (result.status === "confirmed" && result.entityId) {
          await engine.mutate({ kind: "draft_discard", draftId: result.entityId });
        }
        return;
      }
      if (row === null && result.status === "confirmed" && result.entityId) doorsRef.current.took(lane, result.entityId);
      else if (row !== null) doorsRef.current.took(lane, row);
      saved.current.set(lane, sig);
    } catch {
      /* The text is still in the editor and the scratch; the next change tries again. */
    } finally {
      inFlight.current.delete(lane);
    }
  }, [engine, writable]);

  const signature = form === null ? null : signatureOf(form);
  const lane = form?.lane ?? null;
  useEffect(() => {
    const f = formRef.current;
    if (f === null || lane === null || !writable(f, true)) return;
    const timer = window.setTimeout(() => {
      const now = formRef.current;
      if (now !== null && now.lane === lane) void writeNow(now, true);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lane, signature, writable, writeNow]);

  /* The pending write of a CLOSED editor goes now, to the row it holds; a close never creates. */
  useEffect(() => {
    if (lane === null) return;
    return () => {
      const last = lastOf.current.get(lane);
      if (last) void writeNow(last, false);
    };
  }, [lane, writeNow]);

  const seal = useCallback((l: string) => {
    const f = formRef.current;
    if (f !== null && f.lane === l) sealed.current.set(l, signatureOf(f));
    era.current.set(l, (era.current.get(l) ?? 0) + 1);
  }, []);
  const baseline = useCallback((l: string, row: ReplyRowFields) => {
    saved.current.set(l, signatureOf({ ...row, lane: l, threadId: null, subjectEdited: false, html: "" }));
  }, []);
  const forget = useCallback((l: string) => {
    saved.current.delete(l);
    sealed.current.delete(l);
  }, []);
  return { seal, baseline, forget };
}
