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
 * ── THE WINDOW IS OPEN, AND SO IS ITS ONE HOLE ────────────────────────────────────────────
 *
 * A tab closed inside the window loses the delete: the timer dies with the page and nothing is
 * sent. That is the SAFE direction for the least reversible verb in the product — the mail is
 * still in the mailbox and the next drain shows it — but it is a real gap between what the toast
 * said and what happened, and it is named here rather than left for somebody to discover. The
 * Screener closes the same hole with a durable `localStorage` intent (`armScreenerIntent`);
 * doing the same for a delete is a follow-up, not something this module pretends it has.
 * An UNMOUNT is different and is handled: {@link DeleteUndo.flush} commits every open window,
 * because leaving the view is not asking for the delete back.
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
 * So the caller resolves the role with `readerHolder(screenerMode(facts))` — the one narrowing
 * that exists so it is written once — and passes the refusal in. This module never re-derives
 * it, and it refuses at the PRESS: a control wired to a refusal that arrives as a rollback four
 * seconds later is the failure `ScreenerMode`'s third state was invented to end.
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
   * THE READER REFUSAL, resolved by the caller — `null` on an install that organizes.
   *
   * A function rather than a boolean so the caller's own `role` is read at PRESS time; a value
   * captured at construction would answer with the role the shell had when the view mounted.
   */
  refusal: () => string | null;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

export interface DeleteUndo {
  /** Press Backspace/Delete on this message. Idempotent while its window is open. */
  remove: (messageId: string) => void;
  /** Take it back. Silent for an id with no open window — see the guard. */
  undo: (messageId: string) => void;
  /** Commit every open window at once, without waiting. Used on unmount. */
  flush: () => void;
  held: () => ReadonlySet<string>;
}

export function createDeleteUndo(deps: DeleteUndoDeps): DeleteUndo {
  const windowMs = deps.windowMs ?? UNDO_MS;
  const arm = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const disarm = deps.clearTimer ?? ((h) => clearTimeout(h));
  const open = new Map<string, ReturnType<typeof setTimeout>>();

  const publish = () => deps.onHeld(new Set(open.keys()));

  const commit = (messageId: string) => {
    if (!open.delete(messageId)) return;
    publish();
    /* THE ROW COMES BACK ON A REFUSAL, and the sentence says the message is where it was.
       Nothing hides it any more, the mutation's own optimistic tombstone was rolled back by
       the engine, and the two agree — the honest screen for a delete that cannot happen. */
    void deps.mutate({ kind: "message_delete", messageId }).then(
      (res) => { if (res.status === "rolled_back") deps.toast(deps.copy.failed); },
      () => { deps.toast(deps.copy.failed); },
    );
  };

  return {
    remove: (messageId) => {
      const refused = deps.refusal();
      if (refused !== null) {
        /* BEFORE THE PRESS TAKES EFFECT, not after. Nothing is held, nothing is hidden and
           nothing reaches the wire, so there is no flicker to explain afterwards. */
        deps.toast(refused);
        return;
      }
      /* A SECOND PRESS ON A ROW ALREADY IN FLIGHT IS ONE PRESS. The row is gone from every
         list, so a second press can only come from a key repeat or a stale cursor, and
         re-arming would silently extend a window the person is watching count down. */
      if (open.has(messageId)) return;
      open.set(messageId, arm(() => commit(messageId), windowMs));
      publish();
      deps.toast(deps.copy.deleted, {
        action: deps.copy.undo,
        duration: windowMs,
        onAction: () => {
          const h = open.get(messageId);
          /* NOTHING RESTORED IS NOT AN UNDO — `screener-state.ts`'s rule, and it is reachable
             here for the same reason: the toast's button outlives its own timer in the DOM, so
             a late press must not claim it took something back. */
          if (h === undefined) return;
          disarm(h);
          open.delete(messageId);
          publish();
          deps.toast(deps.copy.undone);
        },
      });
    },
    undo: (messageId) => {
      const h = open.get(messageId);
      if (h === undefined) return;
      disarm(h);
      open.delete(messageId);
      publish();
      deps.toast(deps.copy.undone);
    },
    flush: () => {
      for (const [id, h] of [...open]) { disarm(h); commit(id); }
    },
    held: () => new Set(open.keys()),
  };
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
 */
export function deleteKeyBindings(input: {
  focused: EngineMessage | null;
  label: string;
  /**
   * SOMETHING IS OPEN OVER THE DECK. The shell answers from `escapeLayers` — the one list that
   * already decides what Escape closes — so a dialog added later cannot be missing from here
   * without also being missing from Escape, which is visible on first use.
   */
  modalOpen: boolean;
  /** The strip's own render gates, resolved by the shell exactly as `d`'s are. */
  canDelete: boolean;
  run: (m: EngineMessage) => void;
}): KeyBinding[] {
  const disabled = input.focused == null || input.modalOpen || !input.canDelete;
  /* A HELD KEY IS ONE PRESS — the same guard `d` carries, and it matters more here: Backspace
     auto-repeats, and a finger resting on it would walk a whole pile into Trash one window at a
     time while each toast replaced the last. */
  const when = (e: KeyboardEvent) => !e.repeat;
  const run = () => { if (input.focused) input.run(input.focused); };
  return [
    { chord: "Backspace", group: "message", label: input.label, disabled, when, run },
    { chord: "Delete", group: "message", label: input.label, disabled, when, run },
  ];
}

/** The shell's binding: the held set as React state, the queue in a ref, flushed on unmount. */
export function useDeleteUndo(deps: Omit<DeleteUndoDeps, "onHeld">): {
  held: ReadonlySet<string>;
  remove: (messageId: string) => void;
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
      refusal: () => latest.current.refusal(),
      onHeld: setHeld,
    }),
    [],
  );
  useEffect(() => () => queue.flush(), [queue]);
  return { held, remove: useCallback((id: string) => queue.remove(id), [queue]) };
}

const EMPTY: ReadonlySet<string> = new Set<string>();
