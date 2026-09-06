"use client";

/**
 * BACKSPACE AND DELETE MOVE THE FOCUSED MESSAGE TO TRASH — with an Undo in the toast.
 *
 * ══ WHY THE UNDO IS A DELAYED COMMIT AND NOT A REVERSAL ═══════════════════════════════════
 *
 * There is no un-delete on the wire. `message_delete` files the message into the provider's
 * native `\Trash` (never an expunge) and tombstones the row; `EngineMutation` carries nothing
 * that brings it back, and `move` cannot name a deleted row because every living view excludes
 * it. So an Undo offered AFTER the dispatch would be a button for something the product cannot
 * do — which is why the bar's own `d` ceremony asks BEFORE it acts and offers no Undo at all.
 *
 * The Screener reached this exact fork first and answered it (`screener-state.ts`: "the wire has
 * no un-decide endpoint either, so undo is a DELAYED COMMIT"). This is that answer, one verb
 * over: the press hides the row and starts a timer, the toast carries Undo for as long as the
 * timer runs, and the mutation is dispatched only when the window closes. Undo before then
 * cancels a delete that never happened, which is the only kind of undo this wire can honour.
 *
 * {@link UNDO_MS} is imported rather than re-declared: two numbers for "how long Undo is true"
 * is how the toast and the window come apart, and `screener-state.ts` already carries the
 * measurement that fixed the duration.
 *
 * ── THE WINDOW IS DURABLE, WHICH IT WAS NOT ───────────────────────────────────────────────
 *
 * For one revision the only record of a requested delete, for the length of the window, was the
 * timer. A tab closed inside it dropped a delete the toast had already reported — silent, and
 * silent in the direction where the product did not do what it said. `delete-intents.ts` is the
 * fix and it is the Screener's own shape: the intent is written SYNCHRONOUSLY before the timer is
 * armed, Undo removes it, the commit removes it only once the engine has taken the verb, a
 * `pagehide` commits what is still open, and anything that outlives even that is replayed at the
 * next launch. An UNMOUNT commits too ({@link DeleteUndo.flush}) — leaving a view is not asking
 * for the delete back.
 *
 * ══ WHAT A READER DOES INSTEAD ════════════════════════════════════════════════════════════
 *
 * Nothing, and it says so before it does it. A delete is a folder move against mail another
 * install is arranging, and the rule for that is already written once —
 * `screener-state.ts#refuseMove`, whose docstring names deleting explicitly among the moves
 * "refused for EVERY reader, in both modes, because the channel a decision travels carries a
 * decision and nothing else". The server agrees from the other side
 * (`message-service.ts#delete` calls `assertOrganizerRole` before it looks for a Trash folder,
 * so a reader is refused for the reason that is TRUE rather than for a missing folder).
 *
 * The role is asked PER MAILBOX and never of the roster as a whole — `mailboxWriteRole(facts,
 * m.mailboxId)`. `screenerMode`'s account-wide answer is deliberately permissive and is right for
 * a Screener decision, which writes an account-scoped rule; using it here let an account that
 * organizes mailbox A delete from mailbox B, which somebody else organizes (review, 2026-09-06).
 * An UNKNOWN roster refuses too: a destructive verb fails closed, and the sentence says the
 * holder is not known yet rather than claiming one.
 *
 * The refusal is evaluated BEFORE anything else the press would do — nothing held, nothing
 * hidden, no sheet closed, nothing on the wire. `remove` answers whether it acted so the caller
 * can order its own side effects behind that verdict; a control wired to a refusal that arrives
 * as a rollback four seconds later is the failure `ScreenerMode`'s third state was invented to
 * end.
 *
 * A folder-move REQUEST is not an option today and is deliberately not invented here.
 * `REQUEST_KINDS` (`packages/core/src/adapters/organizer-lease.ts`) holds four members —
 * `screener.decide`, `rule.create`, `rule.update`, `rule.delete` — and the column's CHECK is
 * closed on exactly those. A fifth kind is 0.16's own slice.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntityReader, EngineMessage } from "@ohmail/client-engine";
import type { ToastFn } from "@ohmail/ui";
import type { KeyBinding } from "./keymap";
import { isModalOpen } from "./modal-gate";
import { armDeleteIntent, disarmDeleteIntent, takeDeleteIntents } from "./delete-intents";
import { UNDO_MS } from "./screener-state";

export { UNDO_MS };

/**
 * A READER WITH SOME MESSAGES TAKEN OUT — what makes a held delete look like a delete.
 *
 * The row has to leave every list the instant the key is pressed, and the only thing that would
 * otherwise do that is the mutation itself, which is exactly what the window is postponing. So
 * the presentation loses the row and the MIRROR keeps it: `AppShell` composes this over
 * `presented` (the pile source) and never over `reader`, which is the one every mutation, body
 * open and search reads from. That split is `presentationReader`'s own rule — "NEVER use this
 * reader to open a message, to search, or behind a mutation" — and it is what lets Undo restore
 * the row by forgetting an id rather than by re-fetching anything.
 *
 * IDENTITY IS PRESERVED WHEN NOTHING IS HELD, which is the normal case: the base reader is
 * returned unwrapped, so the `useMemo`s downstream keep their inputs and nothing re-derives.
 */
export function hideMessages(base: EntityReader, hidden: ReadonlySet<string>): EntityReader {
  if (hidden.size === 0) return base;
  return {
    version: () => base.version(),
    get<T = unknown>(type: string, id: string): T | undefined {
      if (type === "message" && hidden.has(id)) return undefined;
      return base.get<T>(type, id);
    },
    list<T = unknown>(type: string): T[] {
      const rows = base.list<T>(type);
      if (type !== "message") return rows;
      return rows.filter((r) => !hidden.has((r as unknown as EngineMessage).id));
    },
    entries<T = unknown>(type: string): Array<{ id: string; entity: T }> {
      const rows = base.entries<T>(type);
      if (type !== "message") return rows;
      return rows.filter((r) => !hidden.has(r.id));
    },
  };
}

/** The sentences this module raises. Resolved by the caller, so the catalogue is read once. */
export interface DeleteUndoCopy {
  /** The press succeeded and the window is open. */
  deleted: string;
  /** The toast's action label. */
  undo: string;
  /** Undo was pressed inside the window — nothing was sent. */
  undone: string;
  /** The window closed and the server refused (no Trash folder, a lost row). */
  failed: string;
}

export interface DeleteUndoDeps {
  mutate: (m: { kind: "message_delete"; messageId: string }) => Promise<{ status: string }>;
  toast: ToastFn;
  copy: DeleteUndoCopy;
  /** Called whenever the held set changes, with a NEW set. */
  onHeld: (held: ReadonlySet<string>) => void;
  /**
   * MAY THIS MESSAGE'S MAILBOX BE WRITTEN TO — the sentence to say, or `null` for yes.
   *
   * Takes the MAILBOX ID, because the question is about one mailbox and not about the account:
   * see the header, and `mailboxWriteRole`. A function rather than a value so the roster is read
   * at PRESS time; one captured at construction would answer with the roster the shell had when
   * the view mounted, which for a mailbox that changed hands mid-session is the wrong answer.
   */
  refusal: (mailboxId: string | null | undefined) => string | null;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  /** Epoch ms, for the durable intent's stamp. Injected so the TTL is testable. */
  now?: () => number;
}

/** The message this verb acts on — the id to delete, and the mailbox that decides whether it may. */
export interface DeleteTarget {
  id: string;
  mailboxId?: string | null;
}

export interface DeleteUndo {
  /**
   * Press Backspace/Delete on this message. Idempotent while its window is open.
   *
   * Returns whether the press ACTED. `false` is a refusal — the caller must not run its own side
   * effects (closing the reading sheet, moving a cursor) on a press that did nothing, which is
   * how a refused delete came to close the sheet over the message it had just declined to touch.
   */
  remove: (target: DeleteTarget) => boolean;
  /** Take it back. Silent for an id with no open window — see the guard. */
  undo: (messageId: string) => void;
  /** Commit every open window at once, without waiting. Unmount, and `pagehide`. */
  flush: () => void;
  held: () => ReadonlySet<string>;
}

export function createDeleteUndo(deps: DeleteUndoDeps): DeleteUndo {
  const windowMs = deps.windowMs ?? UNDO_MS;
  const arm = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const disarm = deps.clearTimer ?? ((h) => clearTimeout(h));
  const clock = deps.now ?? (() => Date.now());
  const open = new Map<string, ReturnType<typeof setTimeout>>();

  const publish = () => deps.onHeld(new Set(open.keys()));

  const dispatch = (messageId: string) => {
    /* THE ROW COMES BACK ON A REFUSAL, and the sentence says the message is where it was.
       Nothing hides it any more, the mutation's own optimistic tombstone was rolled back by
       the engine, and the two agree — the honest screen for a delete that cannot happen.

       THE JOURNAL IS CLEARED ONLY ONCE THE ENGINE HAS THE VERB, never before this dispatch:
       the engine writes its durable outbox entry ahead of the wire, so until `mutate` settles
       this intent is the only durable copy of the request. */
    void deps.mutate({ kind: "message_delete", messageId }).then(
      (res) => {
        disarmDeleteIntent(messageId);
        if (res.status === "rolled_back") deps.toast(deps.copy.failed);
      },
      () => { disarmDeleteIntent(messageId); deps.toast(deps.copy.failed); },
    );
  };

  const commit = (messageId: string) => {
    if (!open.delete(messageId)) return;
    publish();
    dispatch(messageId);
  };

  const take = (messageId: string): boolean => {
    const h = open.get(messageId);
    /* NOTHING RESTORED IS NOT AN UNDO — `screener-state.ts`'s rule, and it is reachable here for
       the same reason: the toast's button outlives its own timer in the DOM, so a late press must
       not claim it took something back. */
    if (h === undefined) return false;
    disarm(h);
    open.delete(messageId);
    disarmDeleteIntent(messageId);
    publish();
    deps.toast(deps.copy.undone);
    return true;
  };

  return {
    remove: (target) => {
      /* THE REFUSAL IS THE FIRST THING THAT HAPPENS, and it is asked of THIS message's mailbox.
         Nothing is held, nothing is hidden, no journal entry is written and nothing reaches the
         wire, so there is no flicker to explain afterwards and no side effect for the caller to
         undo — which is why this answers `false` rather than returning silently. */
      const refused = deps.refusal(target.mailboxId);
      if (refused !== null) {
        deps.toast(refused);
        return false;
      }
      /* A SECOND PRESS ON A ROW ALREADY IN FLIGHT IS ONE PRESS. The row is gone from every
         list, so a second press can only come from a key repeat or a stale cursor, and
         re-arming would silently extend a window the person is watching count down. */
      if (open.has(target.id)) return false;
      /* ON DISK BEFORE THE TIMER EXISTS. Between this line and the dispatch there is a window in
         which the request has been reported done and not yet sent; the journal is what survives a
         tab closed inside it. Synchronous, and it cannot throw — see `delete-intents.ts`. */
      armDeleteIntent({ messageId: target.id, at: clock() });
      open.set(target.id, arm(() => commit(target.id), windowMs));
      publish();
      deps.toast(deps.copy.deleted, {
        action: deps.copy.undo,
        duration: windowMs,
        onAction: () => { take(target.id); },
      });
      return true;
    },
    undo: (messageId) => { take(messageId); },
    flush: () => {
      for (const [id, h] of [...open]) { disarm(h); commit(id); }
    },
    held: () => new Set(open.keys()),
  };
}

/**
 * REPLAY WHAT A KILLED TAB LEFT BEHIND — every stranded intent, dispatched once.
 *
 * Called at mount, with the engine's own clock. It does NOT go through the queue: there is no
 * window to reopen and nothing to undo, because the person expressed this before the page went
 * away and the toast that offered to take it back is long gone. The row is already absent from
 * the mirror by then or will be on the next drain; either way the honest act is to finish the
 * request rather than to re-ask a question nobody is looking at.
 *
 * A refusal is silent here, deliberately: a toast about a message the person deleted in a
 * previous session, raised on a screen they have just opened, explains nothing and interrupts
 * something else. The intent is cleared either way, so a delete this account may no longer make
 * (the mailbox changed hands while the tab was closed) is dropped rather than retried for ever.
 */
export function replayDeleteIntents(
  mutate: DeleteUndoDeps["mutate"],
  nowMs: number,
): number {
  const intents = takeDeleteIntents(nowMs);
  for (const intent of intents) {
    void mutate({ kind: "message_delete", messageId: intent.messageId })
      .then(() => disarmDeleteIntent(intent.messageId), () => disarmDeleteIntent(intent.messageId));
  }
  return intents.length;
}

/**
 * THE TWO CHORDS, as the registry's own declarations — a factory so the shell spreads them and
 * a test can drive the real dispatcher over them without mounting the whole shell.
 *
 * ONE LABEL FOR BOTH, deliberately: `ShortcutSheet` folds rows on the label ("two chords that do
 * the same thing … are one instruction with two spellings"), so the sheet prints one row reading
 * `⌫ · ⌦` instead of the same sentence twice.
 *
 * NEITHER IS `inInput`, which is the whole of "never delete from a text field": the dispatcher
 * drops every binding without that flag while `isTypingTarget` holds, and INPUT, TEXTAREA,
 * SELECT and `contenteditable` are exactly what that predicate names. Stated because the guard
 * is an ABSENT field — the cheapest thing in this file to delete by accident, and
 * `test/delete-key.test.tsx` is what makes it fail loudly.
 *
 * ONE FACTORY, TWO CALLERS. The shell declares these over its own `focused`, and
 * `message-verbs.ts` declares them over a split view's `shown`; the chords, the label, the
 * repeat guard and the modal gate are therefore written once. Nine keycaps were dead in three
 * views for exactly the want of that, and `message-verbs.ts`'s own header is the record of it.
 */
export function deleteKeyBindings(input: {
  focused: EngineMessage | null;
  label: string;
  /** The strip's own render gates, resolved by the caller exactly as `d`'s are. */
  canDelete: boolean;
  run: (m: EngineMessage) => void;
}): KeyBinding[] {
  const disabled = input.focused == null || !input.canDelete;
  /**
   * A HELD KEY IS ONE PRESS, AND A QUESTION ON SCREEN OWNS THE KEY. Both are `when` conditions,
   * which is what makes them right rather than merely convenient:
   *
   *  · auto-repeat — Backspace repeats faster than any key somebody leans on, and without this a
   *    resting finger walks a whole pile into Trash one window at a time, each toast replacing the
   *    last so only the final one is still undoable. `d` carries the identical guard;
   *  · the modal gate — it is a DOM read (`isModalOpen`), and a DOM read cannot be a `disabled`
   *    flag: `disabled` is computed while React renders, and the More menu this is meant to catch
   *    opens without the shell re-rendering at all. As a `when` it is evaluated at the keypress,
   *    which is the only moment the answer is true of.
   *
   * A `false` here FALLS THROUGH to the next binding rather than consuming the key, so a press
   * under an open dialog is not `preventDefault`ed and the dialog's own handling is untouched.
   * That is also why neither is folded into `disabled`: the `?` sheet must keep listing the verb,
   * because the key IS bound here — it is simply not the innermost thing being asked.
   */
  const when = (e: KeyboardEvent) =>
    !e.repeat && !isModalOpen(e.view?.document ?? document);
  const run = () => { if (input.focused) input.run(input.focused); };
  return [
    { chord: "Backspace", group: "message", label: input.label, disabled, when, run },
    { chord: "Delete", group: "message", label: input.label, disabled, when, run },
  ];
}

/**
 * THE SHELL'S BINDING — the held set as React state, the queue behind a ref, and the two places a
 * window may not simply evaporate.
 */
export function useDeleteUndo(deps: Omit<DeleteUndoDeps, "onHeld">): {
  held: ReadonlySet<string>;
  remove: (target: DeleteTarget) => boolean;
} {
  const [held, setHeld] = useState<ReadonlySet<string>>(EMPTY);
  /* THE DEPS ARE READ THROUGH A REF, never closed over: `refusal`, `toast` and `copy` change
     identity on most renders, and rebuilding the queue would drop every armed timer — a press
     silently un-deleted by an unrelated re-render. */
  const latest = useRef(deps);
  latest.current = deps;
  const queue = useMemo(
    () => createDeleteUndo({
      mutate: (m) => latest.current.mutate(m),
      toast: (msg, opts) => latest.current.toast(msg, opts),
      get copy() { return latest.current.copy; },
      refusal: (mailboxId) => latest.current.refusal(mailboxId),
      onHeld: setHeld,
      ...(latest.current.now ? { now: () => latest.current.now!() } : {}),
    }),
    [],
  );
  /**
   * LEAVING COMMITS. An unmount is a view change or a sign-out, not a retraction — and `pagehide`
   * is the last moment a closing tab can still act, so the open windows are committed there too.
   *
   * `pagehide` rather than `beforeunload`: it fires on the mobile back/forward cache path where
   * `beforeunload` does not, and it does not risk a browser dialog. The dispatch it starts may not
   * finish before the page goes — which is exactly why `delete-intents.ts` exists and why this is a
   * best effort layered on a durable record rather than the record itself. Whatever this does not
   * get out is replayed at the next launch.
   */
  useEffect(() => {
    const commitAll = () => queue.flush();
    window.addEventListener("pagehide", commitAll);
    return () => {
      window.removeEventListener("pagehide", commitAll);
      commitAll();
    };
  }, [queue]);
  return { held, remove: useCallback((t: DeleteTarget) => queue.remove(t), [queue]) };
}

/**
 * REPLAY, ONCE PER MOUNT — the other half of the durable record.
 *
 * Separate from {@link useDeleteUndo} because it is not part of pressing a key: it is the boot
 * step that finishes what a killed tab started, and a caller that wants the verb without the
 * replay (a surface with no engine to dispatch on) should be able to say so by not calling it.
 */
export function useDeleteIntentReplay(
  mutate: DeleteUndoDeps["mutate"],
  now: () => number,
  enabled = true,
): void {
  const ran = useRef(false);
  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    replayDeleteIntents(mutate, now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

const EMPTY: ReadonlySet<string> = new Set<string>();
