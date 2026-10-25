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
import type { EmailAddress, EngineDraft, OhmailEngine } from "@ohmail/client-engine";
import { AUTOSAVE_DELAY_MS } from "./compose-autosave";
import {
  STORED_CREATES, copyGoes, createLive, dropCopy, landedOf, landingOf, twins, type CreateClaim,
} from "./draft-creates";
import { readReplyMeta, writeReplyMeta } from "./mail-send";

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
  /** A forward lane (`fwd:<id>`): the original it forwards. The row answers nothing. */
  forwardOf?: string | null;
  /** A forward's kept files once one was removed; `null`: every file. */
  forwardParts?: readonly string[] | null;
}

export interface ReplyRowDoors {
  /** The row this reply is and may write now, or `null` when it holds none. */
  rowOf: (lane: string) => string | null;
  /** A write this lane may not make now: its send is on the way, or a row it cannot write stands. */
  refuses: (lane: string) => boolean;
  /** A write answered: the lane holds the row, with its stored stamp; `text` the body written, `confirmed` or queued; `made` by its create. */
  took: (lane: string, row: string, text: string, confirmed: boolean, made: boolean, revision?: string) => void;
  /** The row version the lane's words are based on, or `null` when not known. */
  baseOf: (lane: string, row: string) => string | null;
  /** The row moved elsewhere since that version: the lane lets go of it (or binds the engine's kept row). */
  changed: (lane: string, row: string) => void;
  /** The words of a row changed elsewhere were written as a new draft (`kept`), or are still only on screen. */
  forked: (lane: string, kept: boolean) => void;
}

/** What a row holds, in the fields the editor writes. */
export type ReplyRowFields = Pick<ReplyDraftForm, "mailboxId" | "subject" | "body" | "html" | "to" | "cc" | "bcc" | "forwardOf" | "forwardParts">;

export interface ReplyAutosave {
  /**
   * The Send press: the text sent is not saved again, and a create still in the air is undone. It
   * answers the undo for a press the door refused: nothing went, so nothing was sealed.
   */
  seal: (lane: string) => () => void;
  /**
   * THE PRESS WENT, carrying the words: every create the outbox still holds for this lane under its
   * current binding (one the pause wrote offline) is taken back, so the send is the reply's one row.
   * Left there, it landed beside the send on reconnect: the sent reply stayed in Drafts, one press
   * from a second copy. A create from before a door bound another row carries other words: it stays.
   */
  sending: (lane: string) => void;
  /** That send was withdrawn before the wire: the words it carried are a draft to keep again. */
  cancelled: (lane: string) => void;
  /** The editor was seeded from this row: a form that shows what it holds writes nothing. */
  baseline: (lane: string, row: ReplyRowFields) => void;
  /** The reply was delivered: the next reply to that message is a new one. */
  forget: (lane: string) => void;
  /** The lane's next form showing `body` writes nothing until it changes. */
  asSaved: (lane: string, body: string) => void;
  /** A door bound the lane to a row it did not create: its creates still waiting are drafts of their own. */
  rebind: (lane: string) => void;
  /** `key` is this lane's own create under its binding, waiting or the write in the air. */
  owns: (lane: string, key: string) => boolean;
  /** `row` is the row a create this lane claims has made. */
  ownsRow: (lane: string, row: string) => boolean;
  /** The lane's stored claims are read back (a reload): each counts once this engine shows it. */
  restore: (lane: string) => void;
  /** A door bound the lane to a create still waiting (`key`, made with `row`): it takes the row when it lands. */
  awaits: (lane: string, key: string, row: ReplyRowFields) => void;
  /** The lane's send confirmed from `sentRow`: a create it took back too late is deleted when it lands. */
  settled: (lane: string, sentRow: string | null) => void;
  /** The lane's send was refused or withdrawn: a create it took back too late is the reply's row again. */
  notSent: (lane: string) => void;
  /** A door bound the row a create this lane claims made: the claim is spent, the binding stays. */
  takeOwn: (lane: string, row: string) => void;
  /** The lane's words, refused over a row changed elsewhere, are written as a new draft. */
  fork: (lane: string) => void;
  /** The keys of the lane's own saves of its row the outbox took, under its binding. */
  waitedOf: (lane: string) => ReadonlySet<string>;
  /** The editor shows the row's words again: the lane's earlier waiting saves are not these words. */
  opened: (lane: string) => void;
}

function signatureOf(f: ReplyDraftForm): string {
  const who = (xs: EmailAddress[]) => xs.map((a) => a.address.toLowerCase()).join(",");
  return JSON.stringify([
    f.mailboxId, f.subject, f.body, f.html, who(f.to), who(f.cc), who(f.bcc),
    ...(f.forwardOf ? [f.forwardOf, f.forwardParts ? [...f.forwardParts].sort() : null] : []),
  ]);
}

/** What the server last confirmed a row holds, as the editor's signature; `null` when not known. */
export function accountSigOf(engine: OhmailEngine, id: string): string | null {
  const d = engine.store?.get<EngineDraft>("draft", id);
  if (d === undefined || d === null || d.status !== "draft") return null;
  return signatureOf({
    ...d, body: d.body ?? "", html: d.html ?? "", lane: "", threadId: null, subjectEdited: false,
    forwardOf: d.forwardOfMessageId ?? null, forwardParts: d.forwardOfMessageId ? d.forwardParts ?? null : null,
  });
}

/** Something the person wrote: a reply's subject is derived, so a create needs text or a retitle. */
export function replyWorthCreating(f: ReplyDraftForm): boolean {
  // A forward's audience is never derived: a typed recipient is the person's own.
  if (f.forwardOf) return f.body.trim() !== "" || f.to.length + f.cc.length + f.bcc.length > 0;
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
  /** Per lane: the binding, moved when a door binds a row the lane did not create (`rebind`). */
  const bound = useRef(new Map<string, number>());
  /** Per lane: bindings a Discard or a confirmed send ended. */
  const ended = useRef(new Map<string, Set<number>>());
  /** Per lane: the row its confirmed send went from — never a copy to delete. */
  const sentRows = useRef(new Map<string, string | null>());
  /** Per lane: writes counted, and the last one confirmed onto the lane's row. */
  const seqs = useRef(new Map<string, number>());
  const reached = useRef(new Map<string, number>());
  /** Per lane: what the lane's row is known to hold, by a confirmed write or the create it was made by. */
  const confirmedSig = useRef(new Map<string, string>());
  /** Per lane: the write on its way, answering whether the row holds its words. */
  const writes = useRef(new Map<string, Promise<boolean>>());
  /** Per lane: the key of the create on its way, with the binding it was made under. */
  const inAir = useRef(new Map<string, { key: string; on: number }>());
  /** The last form each lane showed, for the write its close owes. */
  const lastOf = useRef(new Map<string, ReplyDraftForm>());
  if (form !== null) lastOf.current.set(form.lane, form);
  /** Per lane: a body the next form showing it counts as saved — see `asSaved`. */
  const quiet = useRef(new Map<string, string>());
  if (form !== null && quiet.current.has(form.lane)) {
    if (quiet.current.get(form.lane) === form.body) saved.current.set(form.lane, signatureOf(form));
    quiet.current.delete(form.lane);
  }
  /** Per lane: the creates it claims ({@link CreateClaim}), by key; `sends` counts the lane's presses (`era`). */
  const claims = useRef(new Map<string, Map<string, CreateClaim>>());
  /** Per lane: keys a reload found stored, until this engine shows them live or a drain says they are not. */
  const stored = useRef(new Map<string, Set<string>>());
  const watchRef = useRef<() => void>(() => {});
  /** Lanes whose creates a send took back — owed a write again should that send be cancelled. */
  const taken = useRef(new Set<string>());
  /** Lanes whose send was cancelled after it took their creates back: the close's write may create. */
  const owed = useRef(new Set<string>());
  /** Lanes whose save was refused over a row changed elsewhere: their words go to a new draft next. */
  const forkOwed = useRef(new Set<string>());
  /** See {@link ReplyAutosave.waitedOf}: by lane, with the binding they were written under. */
  const waited = useRef(new Map<string, { on: number; keys: Set<string> }>());
  const bindingOf = (l: string): number => bound.current.get(l) ?? 0;
  /** The lane's claims under its binding, beside its meta: a reload claims them again. */
  const storeClaims = useCallback((l: string) => {
    const keys = [...(claims.current.get(l) ?? [])].filter(([, c]) => c.binding === (bound.current.get(l) ?? 0)).map(([k]) => k);
    const meta = readReplyMeta(l);
    if (keys.length === 0 && meta.creates === undefined) return;
    writeReplyMeta(l, { ...meta, creates: keys.slice(-STORED_CREATES) });
  }, []);
  const claim = useCallback((l: string, key: string, c: CreateClaim) => {
    const keys = claims.current.get(l) ?? new Map<string, CreateClaim>();
    keys.set(key, c);
    claims.current.set(l, keys);
    storeClaims(l);
    watchRef.current();
  }, [storeClaims]);
  const unclaim = useCallback((l: string, key: string) => {
    if (claims.current.get(l)?.delete(key)) storeClaims(l);
  }, [storeClaims]);
  /** Take a create back; `hold`: for a Send, whose ending decides one already on the wire. */
  const takeBack = useCallback((lane: string, key: string, hold: boolean) => {
    const c = claims.current.get(lane)?.get(key);
    if (c === undefined) return;
    if (hold) c.held = true;
    if (typeof engine.withdrawQueued !== "function") { unclaim(lane, key); return; }
    void engine.withdrawQueued(key)
      .then((said) => {
        if (said === "withdrawn" || (said === "gone" && landedOf(engine, key) === null)) unclaim(lane, key);
        resolveRef.current();
      })
      .catch(() => undefined);
  }, [engine, unclaim]);

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

  const write = useCallback(async (f: ReplyDraftForm): Promise<boolean> => {
    const lane = f.lane;
    const row = doorsRef.current.rowOf(lane);
    const at = era.current.get(lane) ?? 0;
    const on = bound.current.get(lane) ?? 0;
    const sig = signatureOf(f);
    const seq = (seqs.current.get(lane) ?? 0) + 1;
    seqs.current.set(lane, seq);
    // A create's key is the lane's before it leaves: a door asks `owns` while it is in the air.
    const key = row === null ? crypto.randomUUID() : undefined;
    if (key !== undefined) {
      inAir.current.set(lane, { key, on });
      claim(lane, key, { sig, binding: on, sends: at, held: false, seq });
    }
    try {
      const stated = row !== null ? doorsRef.current.baseOf(lane, row) : null;
      const result = await engine.mutate({
        kind: "draft_save", draftId: row,
        // The version these words were written on: a row moved off it refuses them.
        ...(stated ? { ifContentRevision: stated } : {}),
        ...(f.mailboxId ? { mailboxId: f.mailboxId } : {}),
        threadId: f.threadId,
        // A forward's row names its original and answers nothing; its kept files only once one was removed.
        ...(f.forwardOf
          ? { forwardOfMessageId: f.forwardOf, ...(f.forwardParts ? { forwardParts: [...f.forwardParts] } : {}) }
          : { inReplyToMessageId: lane }),
        subject: f.subject, body: f.body, html: f.html ? f.html : null,
        to: f.to, cc: f.cc, bcc: f.bcc,
      }, key !== undefined ? { key } : {});
      inAir.current.delete(lane);
      // Answered here: only a create the outbox holds stays claimed.
      if (key !== undefined && result.status !== "queued") unclaim(lane, key);
      if (row !== null && result.status === "queued" && on === bindingOf(lane)) {
        const w = waited.current.get(lane);
        waited.current.set(lane, { on, keys: new Set([...(w?.on === on ? w.keys : []), result.key]) });
      }
      if (result.status === "rolled_back") {
        // The row moved elsewhere: it is the other version's now, and these words become a new draft.
        if (row !== null && result.error?.code === "draft_changed" && on === bindingOf(lane)) {
          doorsRef.current.changed(lane, row);
          forkOwed.current.add(lane);
        }
        return false;
      }
      // Its message ended while it was in the air (a Discard): the row it made is a copy.
      if (key !== undefined && result.status === "confirmed" && result.entityId && ended.current.get(lane)?.has(on)) {
        dropCopy(engine, lane, result.entityId, sentRows.current.get(lane) ?? null);
        return false;
      }
      // A Send pressed while a create was in the air sent without it: the row made here is a copy,
      // and one the outbox holds instead is taken back before it can land.
      const current = on === (bound.current.get(lane) ?? 0);
      if (row === null && current && (era.current.get(lane) ?? 0) !== at) {
        if (result.status === "confirmed" && result.entityId) {
          await engine.mutate({ kind: "draft_discard", draftId: result.entityId });
        } else if (result.status === "queued" && key !== undefined && claims.current.get(lane)?.get(key)?.held !== true) {
          taken.current.add(lane);
          takeBack(lane, key, true);
        }
        return false;
      }
      /* A CREATE THE OUTBOX HOLDS (offline) stays claimed: no row to take until it lands, and the
         lane's send takes it back (`sending`). */
      // A door bound another row while it was in the air: the row made here is a draft of its own.
      if (row === null && !current) return false;
      // A write of a row the lane let go of while it was in the air (the composer took it) binds it no more.
      if (row === null && result.status === "confirmed" && result.entityId) {
        doorsRef.current.took(lane, result.entityId, f.body, true, true, result.revision);
      } else if (row !== null && current) doorsRef.current.took(lane, row, f.body, result.status === "confirmed", false, result.revision);
      saved.current.set(lane, sig);
      if (result.status === "confirmed") {
        reached.current.set(lane, seq);
        confirmedSig.current.set(lane, sig);
      }
      return true;
    } catch {
      /* The text is still in the editor and the scratch; the next change tries again. */
      if (key !== undefined) unclaim(lane, key);
      return false;
    } finally {
      if (key !== undefined && inAir.current.get(lane)?.key === key) inAir.current.delete(lane);
      resolveRef.current();
    }
  }, [engine, claim, unclaim, takeBack]);
  /** Writes `f`; true once the lane's row holds its words (written, queued, or already so). */
  const writeNow = useCallback((f: ReplyDraftForm, allowCreate: boolean): Promise<boolean> => {
    const lane = f.lane;
    if (writes.current.has(lane)) return Promise.resolve(false);
    if (!writable(f, allowCreate)) {
      return Promise.resolve(signatureOf(f) === saved.current.get(lane) && doorsRef.current.rowOf(lane) !== null);
    }
    const p = write(f).finally(() => {
      writes.current.delete(lane);
      inAir.current.delete(lane);
      if (forkOwed.current.has(lane)) forkRef.current(lane);
    });
    writes.current.set(lane, p);
    return p;
  }, [writable, write]);

  /** THE FORK: the lane's last words, written as a new draft now that the other version holds the row. */
  const forkRef = useRef<(lane: string) => void>(() => {});
  forkRef.current = (l: string) => {
    forkOwed.current.delete(l);
    saved.current.delete(l);
    sealed.current.delete(l);
    const f = formRef.current?.lane === l ? formRef.current : lastOf.current.get(l);
    if (f === undefined || f === null || !replyWorthCreating(f)) return;
    void writeNow(f, true).then((kept) => doorsRef.current.forked(l, kept));
  };
  const fork = useCallback((l: string) => { forkRef.current(l); }, []);
  const waitedOf = useCallback((l: string): ReadonlySet<string> => {
    const w = waited.current.get(l);
    return w !== undefined && w.on === bindingOf(l) ? w.keys : new Set<string>();
  }, []);
  const opened = useCallback((l: string) => { waited.current.delete(l); }, []);

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

  /* The pending write of a CLOSED editor goes now, to the row it holds; a close never creates, but
     for words a cancelled send had taken from a create (`cancelled`). */
  useEffect(() => {
    if (lane === null) return;
    return () => {
      const last = lastOf.current.get(lane);
      // A create of this message still on its way is its row once it lands: the close makes no second.
      const live = [...(claims.current.get(lane) ?? [])].some(([k, c]) => c.binding === bindingOf(lane) && createLive(engine, k));
      if (last) void writeNow(last, owed.current.delete(lane) && !live);
    };
  }, [lane, writeNow, engine]);

  const seal = useCallback((l: string) => {
    const before = sealed.current.get(l);
    const f = formRef.current;
    if (f !== null && f.lane === l) sealed.current.set(l, signatureOf(f));
    const at = (era.current.get(l) ?? 0) + 1;
    era.current.set(l, at);
    return () => {
      if (era.current.get(l) === at) era.current.set(l, at - 1);
      if (before === undefined) sealed.current.delete(l);
      else sealed.current.set(l, before);
    };
  }, []);
  const sending = useCallback((l: string) => {
    const on = bindingOf(l);
    const mine = [...(claims.current.get(l) ?? [])].filter(([, c]) => c.binding === on).map(([key]) => key);
    if (mine.length === 0) return;
    // No create holds these words for the account now: the send carries them.
    saved.current.delete(l);
    taken.current.add(l);
    for (const key of mine) takeBack(l, key, true);
  }, [takeBack]);
  const cancelled = useCallback((l: string) => {
    if (!taken.current.delete(l)) return;
    sealed.current.delete(l);
    saved.current.delete(l);
    owed.current.add(l);
  }, []);
  const baseline = useCallback((l: string, row: ReplyRowFields) => {
    saved.current.set(l, signatureOf({ ...row, lane: l, threadId: null, subjectEdited: false }));
  }, []);
  /** The lane's message ended (a confirmed send, a Discard): its creates are taken back, or dropped when they land. */
  const forget = useCallback((l: string) => {
    const was = bindingOf(l);
    const done = ended.current.get(l) ?? new Set<number>();
    done.add(was);
    ended.current.set(l, done);
    for (const [key, c] of [...(claims.current.get(l) ?? [])]) if (c.binding === was) { c.held = false; takeBack(l, key, false); }
    saved.current.delete(l);
    sealed.current.delete(l);
    taken.current.delete(l);
    owed.current.delete(l);
    quiet.current.delete(l);
    reached.current.delete(l);
    confirmedSig.current.delete(l);
    bound.current.set(l, was + 1);
    resolveRef.current();
  }, [takeBack]);
  const rebind = useCallback((l: string) => {
    bound.current.set(l, bindingOf(l) + 1);
    reached.current.delete(l);
    confirmedSig.current.delete(l);
    storeClaims(l);
  }, [storeClaims]);
  const owns = useCallback((l: string, key: string) => {
    const c = claims.current.get(l)?.get(key);
    if (c !== undefined) return c.binding === bindingOf(l);
    const air = inAir.current.get(l);
    return air !== undefined && air.key === key && air.on === bindingOf(l);
  }, []);
  const ownsRow = useCallback((l: string, row: string) => {
    for (const [key, c] of claims.current.get(l) ?? []) {
      if (c.binding === bindingOf(l) && landedOf(engine, key)?.id === row) return true;
    }
    return false;
  }, [engine]);
  const takeOwn = useCallback((l: string, row: string) => {
    for (const [key, c] of [...(claims.current.get(l) ?? [])]) {
      if (c.binding === bindingOf(l) && landedOf(engine, key)?.id === row) unclaim(l, key);
    }
  }, [engine, unclaim]);
  const awaits = useCallback((l: string, key: string, row: ReplyRowFields) => {
    const on = bindingOf(l) + 1;
    bound.current.set(l, on);
    reached.current.delete(l);
    confirmedSig.current.delete(l);
    const was = claims.current.get(l)?.get(key);
    claim(l, key, {
      sig: was?.sig ?? signatureOf({ ...row, lane: l, threadId: null, subjectEdited: false }),
      binding: on, sends: era.current.get(l) ?? 0, held: false, seq: seqs.current.get(l) ?? 0,
    });
    resolveRef.current();
  }, [claim]);
  const restore = useCallback((l: string) => {
    const keys = readReplyMeta(l).creates ?? [];
    if (keys.length === 0) return;
    const set = stored.current.get(l) ?? new Set<string>();
    for (const key of keys) if (!claims.current.get(l)?.has(key)) set.add(key);
    stored.current.set(l, set);
    resolveRef.current();
  }, []);
  const settled = useCallback((l: string, sentRow: string | null) => {
    const done = ended.current.get(l) ?? new Set<number>();
    done.add(bindingOf(l));
    ended.current.set(l, done);
    sentRows.current.set(l, sentRow);
    // Confirmed: a create the press held is decided by the ended message, and dropped.
    for (const c of claims.current.get(l)?.values() ?? []) if (c.held) c.held = false;
    resolveRef.current();
  }, []);
  const notSent = useCallback((l: string) => {
    // Refused or withdrawn: a create the press held is the reply's again, under its binding now.
    for (const c of claims.current.get(l)?.values() ?? []) {
      if (!c.held) continue;
      c.held = false;
      if (ended.current.get(l)?.has(c.binding)) continue;
      c.sends = era.current.get(l) ?? 0;
      c.binding = bindingOf(l);
    }
    storeClaims(l);
    resolveRef.current();
  }, [storeClaims]);

  /**
   * A CLAIMED CREATE HAS LANDED — on the reconnect flush, a boot's replay or its own write — and is
   * decided by {@link landingOf}. A lane that may not write now holds its create until it may.
   */
  const resolveRef = useRef<() => void>(() => {});
  resolveRef.current = () => {
    try { resolveCreates(); } finally { watchRef.current(); }
  };
  const resolveCreates = (): void => {
    for (const [lane, keys] of stored.current) {
      for (const key of [...keys]) {
        if (createLive(engine, key)) {
          keys.delete(key);
          claim(lane, key, {
            sig: "", binding: bindingOf(lane), sends: era.current.get(lane) ?? 0, held: false, seq: -1,
          });
        } else if ((engine.drainsCompleted?.() ?? 0) > 0) keys.delete(key);
      }
      if (keys.size === 0) stored.current.delete(lane);
    }
    for (const [lane, keys] of claims.current) {
      for (const [key, c] of [...keys]) {
        if (inAir.current.get(lane)?.key === key) continue;
        const made = landedOf(engine, key);
        if (made === null) {
          if (!createLive(engine, key)) unclaim(lane, key);
          continue;
        }
        // The row the lane is bound to is that create's own: never a copy of itself.
        if (made.id === doorsRef.current.rowOf(lane)) { unclaim(lane, key); continue; }
        // A claim a reload restored (`seq` -1) is judged beside the row the lane last stored.
        const row = doorsRef.current.rowOf(lane) ?? (c.seq < 0 ? storedRow(lane) : null);
        const at = landingOf(c, {
          binding: bindingOf(lane), ended: ended.current.get(lane) ?? new Set(), sends: era.current.get(lane) ?? 0, row,
        });
        if (at === "wait" || (at === "take" && doorsRef.current.refuses(lane))) continue;
        // A copy holding the very words of the row beside it goes at once, shown or not.
        if (at === "carry" && row !== null && twins(accountSigOf(engine, made.id), accountSigOf(engine, row))) {
          unclaim(lane, key);
          dropCopy(engine, lane, made.id, sentRows.current.get(lane) ?? null);
          continue;
        }
        // Beside a row, the copy waits for the lane's words: shown, or last shown in this page.
        if (at === "carry" && formRef.current?.lane !== lane && !lastOf.current.has(lane)) continue;
        unclaim(lane, key);
        if (at === "keep") continue;
        if (at === "drop") { dropCopy(engine, lane, made.id, sentRows.current.get(lane) ?? null); continue; }
        if (at === "take") {
          doorsRef.current.took(
            lane, made.id, engine.read().get<EngineDraft>("draft", made.id)?.body ?? "", true, true, made.revision ?? undefined,
          );
          if (c.sig !== "") saved.current.set(lane, c.sig);
          reached.current.set(lane, c.seq);
          if (c.sig !== "") confirmedSig.current.set(lane, c.sig);
          const f = formRef.current?.lane === lane ? formRef.current : lastOf.current.get(lane);
          if (f !== undefined && f !== null) void writeNow(f, false);
          continue;
        }
        void carry(lane, c, made.id);
      }
    }
  };
  /** The row the lane last stored, still a draft in the mirror: a reload's empty `rowOf` is not "no row". */
  const storedRow = (lane: string): string | null => {
    const id = readReplyMeta(lane).row?.id;
    return id !== undefined && engine.read().get<EngineDraft>("draft", id)?.status === "draft" ? id : null;
  };
  /** The lane's row takes its newest words, shown or last shown; the copy goes once a later write reached it. */
  const carry = async (lane: string, c: CreateClaim, copy: string): Promise<void> => {
    if (copy === doorsRef.current.rowOf(lane)) return;
    for (let i = 0; i < 8 && writes.current.has(lane); i++) await writes.current.get(lane);
    const f = formRef.current?.lane === lane ? formRef.current : lastOf.current.get(lane);
    if (f !== undefined && f !== null) await writeNow(f, false);
    const row = doorsRef.current.rowOf(lane);
    // Or the server's copy of the row holds every word the copy does (a reload's claim knows no words).
    const same = row !== null && row !== copy && twins(accountSigOf(engine, copy), accountSigOf(engine, row));
    if (same || copyGoes(c, reached.current.get(lane) ?? null, confirmedSig.current.get(lane) ?? null)) {
      dropCopy(engine, lane, copy, sentRows.current.get(lane) ?? null);
    }
  };
  /* A lane shown again decides what waited for its words. */
  useEffect(() => { if (lane !== null) resolveRef.current(); }, [lane]);
  /* Subscribed only while a create is claimed or a stored one is asked about. */
  const createsOff = useRef<(() => void) | null>(null);
  const waits = (): boolean => stored.current.size > 0 || [...claims.current.values()].some((k) => k.size > 0);
  watchRef.current = () => {
    if (createsOff.current === null && waits()) createsOff.current = engine.subscribe(() => resolveRef.current());
    else if (createsOff.current !== null && !waits()) { createsOff.current(); createsOff.current = null; }
  };
  useEffect(() => () => { createsOff.current?.(); createsOff.current = null; }, [engine]);
  const asSaved = useCallback((l: string, body: string) => { quiet.current.set(l, body); }, []);
  return {
    seal, sending, cancelled, baseline, forget, asSaved, rebind, owns, ownsRow, restore, awaits, settled, notSent, takeOwn, fork,
    waitedOf, opened,
  };
}
