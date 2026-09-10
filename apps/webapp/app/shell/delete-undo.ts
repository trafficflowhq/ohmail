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
import type { DisabledReason, KeyBinding } from "./keymap";
import { isModalOpen } from "./modal-gate";
import { armDeleteIntent, disarmDeleteIntent, takeDeleteIntents, type HeldVerb } from "./delete-intents";
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

/**
 * The sentences this module raises. Resolved by the caller, so the catalogue is read once.
 *
 * SINGULAR AND PLURAL ARE SEPARATE SENTENCES, not one string with a number in it, because the
 * two forms are reached by two different gestures: a key press on the focused message, and a bulk
 * verb over a selection. The singular set is what the key has always said, word for word; the
 * plural set carries the count. A caller that never presses over a set may leave the plural
 * functions out, and the object form never reaches them.
 */
export interface DeleteUndoCopy {
  /** The press succeeded and the window is open. */
  deleted: string;
  /** The toast's action label. */
  undo: string;
  /** Undo was pressed inside the window — nothing was sent. */
  undone: string;
  /** The window closed and the server refused (no Trash folder, a lost row). */
  failed: string;
  /** The same three for a press over MORE THAN ONE message. Optional; see above. */
  deletedMany?: (count: number) => string;
  undoneMany?: (count: number) => string;
  failedMany?: (count: number) => string;
}

/**
 * WHICH VERB THIS WINDOW HOLDS, and the dispatch it commits to.
 *
 * ── WHY THE VERB IS INJECTED RATHER THAN BRANCHED ON ──────────────────────────────────────
 *
 * `createDeleteUndo` used to know one dispatch: `engine.mutate({ kind: "message_delete", … })`.
 * The restore cannot be an `EngineMutation` at all — the engine REJECTS a mutation whose local
 * effects are empty, and a mutation over a tombstoned row has none — so a second window would
 * have needed a second copy of the timer, the journal write, the idempotence-over-the-set rule
 * and the toast ceremony. Two copies of that is how a `pagehide` commit comes to be right for
 * one verb and wrong for the other.
 *
 * So the window is verb-agnostic: it holds ids, it arms a timer, it writes ONE journal row for
 * the press naming this verb, and when the window closes it calls `dispatch` per id. The delete
 * passes a function that calls `engine.mutate`; the restore passes one that calls
 * `engine.restoreFromTrash`. Neither is special-cased here.
 *
 * `dispatch` answers a STATUS STRING and not a boolean, because the two verbs already agree on
 * the vocabulary: `"rolled_back"` is what the engine's mutation outcome says for a refused
 * delete and what {@link RestoreOutcome} was given for a refused restore, precisely so this
 * one comparison covers both.
 */
export type HeldDispatch = (messageId: string) => Promise<{ status: string }>;

export interface DeleteUndoDeps {
  /**
   * The verb this window holds — `"delete"` unless a caller says otherwise, so every existing
   * construction site is unchanged and the journal keeps writing the legacy shape it wrote.
   */
  verb?: HeldVerb;
  /**
   * What the window commits, per message. Kept named `mutate` at every existing call site by
   * being ONE function of an id: the delete's caller passes
   * `(id) => engine.mutate({ kind: "message_delete", messageId: id })`.
   */
  mutate: HeldDispatch;
  toast: ToastFn;
  copy: DeleteUndoCopy;
  /** Called whenever the held set changes, with a NEW set. */
  onHeld: (held: ReadonlySet<string>) => void;
  /**
   * MAY THESE MAILBOXES BE WRITTEN TO — the sentence to say, or `null` for yes.
   *
   * Takes EVERY mailbox the press touches, and is asked ONCE for the whole press. That is not a
   * convenience: a selection spanning a mailbox this install organizes and one it only reads is a
   * single gesture, and answering it per message would delete the half that is permitted and
   * refuse the half that is not — a partial outcome nobody asked for, reported by one toast. The
   * press is refused whole, and the mixed-selection ruling falls out of the signature rather than
   * out of a rule somebody has to remember.
   *
   * A function rather than a value so the roster is read at PRESS time; one captured at
   * construction would answer with the roster the shell had when the view mounted, which for a
   * mailbox that changed hands mid-session is the wrong answer.
   */
  refusal: (mailboxIds: ReadonlyArray<string | null | undefined>) => string | null;
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  /** Epoch ms, for the durable intent's stamp. Injected so the TTL is testable. */
  now?: () => number;
  /** Press ids. Injected so a test can name them; defaults to `crypto.randomUUID()`. */
  pressId?: () => string;
}

/** The message this verb acts on — the id to delete, and the mailbox that decides whether it may. */
export interface DeleteTarget {
  id: string;
  mailboxId?: string | null;
}

export interface DeleteUndo {
  /**
   * ONE PRESS — over the focused message, or over a whole selection.
   *
   * A SET IS ONE PRESS AND NOT N PRESSES, which is the load-bearing half of this signature. One
   * window opens, one toast is shown, one Undo takes the whole selection back, and one durable
   * intent records it — so `pagehide` commits a press atomically instead of landing some of it.
   * N separate windows would give N toasts that replace each other, of which only the last is
   * still undoable, and a tab closed mid-way would delete an arbitrary prefix of the selection.
   *
   * Returns whether the press ACTED. `false` is a refusal or a no-op — the caller must not run
   * its own side effects (closing the reading sheet, clearing a selection) on a press that did
   * nothing, which is how a refused delete came to close the sheet over the message it had just
   * declined to touch.
   */
  remove: (target: DeleteTarget | readonly DeleteTarget[]) => boolean;
  /** Take back the press holding this message. Silent for an id in no open window. */
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
  const mintPress = deps.pressId ?? (() => crypto.randomUUID());

  /** One entry per OPEN PRESS. The ids it holds, and the timer that will commit them. */
  interface Press { ids: string[]; timer: ReturnType<typeof setTimeout> }
  const open = new Map<string, Press>();
  /** Which press holds a message — the reverse index idempotence and Undo both need. */
  const heldBy = new Map<string, string>();

  const publish = () => deps.onHeld(new Set(heldBy.keys()));

  /** The right sentence for a press of this size. Singular is the key's own, word for word. */
  const say = (
    one: string,
    many: ((count: number) => string) | undefined,
    count: number,
  ): string => (count > 1 && many ? many(count) : one);

  const forget = (pressId: string): string[] => {
    const press = open.get(pressId);
    if (!press) return [];
    disarm(press.timer);
    open.delete(pressId);
    for (const id of press.ids) if (heldBy.get(id) === pressId) heldBy.delete(id);
    return press.ids;
  };

  const dispatch = (pressId: string, ids: string[]) => {
    /* THE ROWS COME BACK ON A REFUSAL, and the sentence says the mail is where it was. Nothing
       hides them any more, the mutations' own optimistic tombstones were rolled back by the
       engine, and the two agree — the honest screen for a delete that cannot happen.

       ONE JOURNAL ENTRY FOR THE PRESS, cleared only once EVERY message in it has settled: the
       engine writes its durable outbox entry ahead of the wire, so until the last one settles
       this intent is still the only durable record of the rest. Clearing on the first would
       leave a press that is half on the wire and no longer written down anywhere. */
    let outstanding = ids.length;
    let refused = 0;
    const settled = () => {
      outstanding -= 1;
      if (outstanding > 0) return;
      disarmDeleteIntent(pressId);
      if (refused > 0) deps.toast(say(deps.copy.failed, deps.copy.failedMany, refused));
    };
    for (const messageId of ids) {
      void deps.mutate(messageId).then(
        (res) => { if (res.status === "rolled_back") refused += 1; settled(); },
        () => { refused += 1; settled(); },
      );
    }
  };

  const commit = (pressId: string) => {
    const ids = forget(pressId);
    if (ids.length === 0) return;
    publish();
    dispatch(pressId, ids);
  };

  const take = (pressId: string): boolean => {
    const press = open.get(pressId);
    /* NOTHING RESTORED IS NOT AN UNDO — `screener-state.ts`'s rule, and it is reachable here for
       the same reason: the toast's button outlives its own timer in the DOM, so a late press must
       not claim it took something back. */
    if (!press) return false;
    const count = press.ids.length;
    forget(pressId);
    disarmDeleteIntent(pressId);
    publish();
    deps.toast(say(deps.copy.undone, deps.copy.undoneMany, count));
    return true;
  };

  return {
    remove: (target) => {
      const targets = Array.isArray(target)
        ? (target as readonly DeleteTarget[])
        : [target as DeleteTarget];
      /* THE REFUSAL IS THE FIRST THING THAT HAPPENS, asked ONCE for the whole press and about
         every mailbox it touches. Nothing is held, nothing is hidden, no journal entry is written
         and nothing reaches the wire, so there is no flicker to explain afterwards and no side
         effect for the caller to undo — which is why this answers `false` rather than returning
         silently. A mixed selection is refused WHOLE; see `refusal`. */
      const refused = deps.refusal(targets.map((t) => t.mailboxId));
      if (refused !== null) {
        deps.toast(refused);
        return false;
      }
      /* IDEMPOTENCE OVER THE SET. A message already inside an open window is dropped from this
         press rather than re-armed: re-arming would silently extend a window the person is
         watching count down, and would put one message in two presses, where a replay after a
         crash would delete it twice. A press left holding nothing is not a press. */
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const t of targets) {
        if (!t.id || seen.has(t.id) || heldBy.has(t.id)) continue;
        seen.add(t.id);
        ids.push(t.id);
      }
      if (ids.length === 0) return false;

      const pressId = mintPress();
      /* ON DISK BEFORE THE TIMER EXISTS, and ONE entry for the whole press so `pagehide` commits
         it atomically. Between this line and the dispatch there is a window in which the request
         has been reported done and not yet sent; the journal is what survives a tab closed inside
         it. Synchronous, and it cannot throw — see `delete-intents.ts`. */
      /* THE VERB RIDES THE ROW. `"delete"` is the default, so a caller that says nothing writes
         exactly the shape previous builds wrote and a replay in an OLDER build reads it. */
      armDeleteIntent({ id: pressId, messageIds: ids, at: clock(), kind: deps.verb ?? "delete" });
      const timer = arm(() => commit(pressId), windowMs);
      open.set(pressId, { ids, timer });
      for (const id of ids) heldBy.set(id, pressId);
      publish();
      deps.toast(say(deps.copy.deleted, deps.copy.deletedMany, ids.length), {
        action: deps.copy.undo,
        duration: windowMs,
        onAction: () => { take(pressId); },
      });
      return true;
    },
    undo: (messageId) => {
      const pressId = heldBy.get(messageId);
      if (pressId !== undefined) take(pressId);
    },
    flush: () => {
      for (const pressId of [...open.keys()]) commit(pressId);
    },
    held: () => new Set(heldBy.keys()),
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
  mutate: HeldDispatch,
  nowMs: number,
  /**
   * THE RESTORE'S DISPATCH — and its ABSENCE is a real state, not a missing argument.
   *
   * A surface can have the delete key and no restore transport: the demo, a build talking to a
   * server with no restore route, a shell that never mounts the Trash view. On such a surface a
   * stranded `{kind: "restore"}` row must be DROPPED — cleared from the journal and never
   * dispatched — and it must specifically NOT fall through to `mutate`, which would DELETE the
   * message somebody asked to restore. That is the one outcome in this file that would be worse
   * than losing the request, so it is a separate parameter rather than a branch inside `mutate`:
   * a caller cannot accidentally satisfy it.
   */
  restore?: HeldDispatch,
): number {
  const intents = takeDeleteIntents(nowMs);
  for (const intent of intents) {
    /* DISPATCH BY KIND. A row with no `kind` reads as `delete` (the journal's own default — see
       `DeleteIntent.kind`), so every row a previous build wrote replays exactly as it did. */
    const kind = intent.kind ?? "delete";
    const fn = kind === "restore" ? restore : mutate;
    if (fn === undefined) {
      /* A held restore with nowhere to send it. Cleared, silently, for the reason a refusal is
         silent here: the person expressed this in a previous session and the toast that offered
         to take it back is long gone. Retrying it for ever would be a journal that only grows,
         and replaying it as a DELETE would be the product doing the opposite of what was asked. */
      disarmDeleteIntent(intent.id);
      continue;
    }
    /* THE ENTRY IS CLEARED WHEN THE WHOLE PRESS HAS SETTLED, not per message: a press is the unit
       it was recorded in, and clearing it early would drop the record of the messages still in
       flight. `Promise.allSettled` rather than `all`, because one refusal must not strand the
       rest of the press in the journal for ever. */
    void Promise.allSettled(
      intent.messageIds.map((messageId) => fn(messageId)),
    ).then(() => disarmDeleteIntent(intent.id));
  }
  return intents.length;
}

/**
 * THE RESTORE, AS A {@link HeldDispatch} — one mapping, in the file that owns the vocabulary.
 *
 * `engine.restoreFromTrash` answers `{ state }` and this window branches on `{ status }`, so
 * something has to translate. It is HERE and not at each call site because there are two call
 * sites — the held window's commit and the boot replay — and two copies of a mapping whose
 * whole job is to decide "did that press take effect" is how one of them comes to read a
 * refusal as a success.
 *
 * `unavailable` maps to `rolled_back`, which is the honest answer rather than the literal one:
 * the surface only wires this when `trashAvailable()` is true, so reaching it means the
 * transport went away mid-flight — the press did not take effect, the row must come back, and
 * the failure sentence is the one to say. Mapping it to a success would leave a row missing
 * from the list with the message still in Trash.
 */
export function restoreDispatch(
  restoreFromTrash: (messageId: string) => Promise<{ state: string; restoreTo?: string }>,
  /**
   * WHERE IT WENT, said when the SERVER has said it — and never at the press.
   *
   * The window's own `deleted` sentence is raised the moment the row is hidden, seconds before
   * anything reaches a server, so it cannot name a place: the row was rendered with the origin
   * the LIST knew, and that folder can be deleted between the page and the press. The server
   * resolves the destination and answers with it, and this is the one moment that answer exists.
   *
   * It has to be a callback ON THE DISPATCH rather than a second call at the press site, and
   * that is not a style preference — a second `restoreFromTrash` at the press would ISSUE THE
   * REQUEST THEN, which is precisely what the held window exists to postpone. The whole undo
   * would be gone and the suite would still be green, because the request does go out and the
   * row does leave the list.
   *
   * Only on a real restore. A refusal says nothing here; the window's own `failed` sentence is
   * the one that lands, and it says the mail is still in Trash.
   */
  onRestored?: (restoreTo: string) => void,
): HeldDispatch {
  return async (messageId) => {
    const outcome = await restoreFromTrash(messageId);
    if (outcome.state === "restored") {
      onRestored?.(outcome.restoreTo && outcome.restoreTo !== "" ? outcome.restoreTo : "INBOX");
      return { status: "applied" };
    }
    return { status: "rolled_back" };
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
  /**
   * WHY the keys are inert, for the `?` sheet's row — see `KeyBinding.disabledReason`.
   *
   * The gates above are several and most need no sentence: nothing focused, no row in the mirror.
   * The one that does is Trash, where the keys can never work because the product does not erase
   * mail. Optional, so a caller with nothing to explain says nothing.
   */
  disabledReason?: DisabledReason;
  run: (m: EngineMessage) => void;
}): KeyBinding[] {
  const disabled = input.focused == null || !input.canDelete;
  /**
   * NO CURSOR IS ITS OWN REASON — see `keymap.tsx#DisabledReason`.
   *
   * The whole of the reported defect: a freshly opened list has no cursor, so both chords were
   * `disabled`, and the dispatcher dropped them before the chord was matched. ⌫ on an Ohbox
   * nobody had touched did nothing — no cursor, no sentence, no request. It now places the cursor
   * on the first row and says which verb the next press runs.
   *
   * `focused == null` ALONE, never `disabled`. `canDelete` is the strip's own render gates
   * resolved by the host, and a row it refuses is refused with a cursor on it too — claiming
   * `"no_cursor"` there would place a cursor and promise a second press that cannot work. Where
   * the two overlap (a caller whose `canDelete` folds in `focused != null`, as both callers'
   * does) this is still the honest answer: the cursor is what is missing, and whatever the gates
   * then say about the row the cursor lands on is the same answer a click would have got.
   */
  const noCursor = input.focused == null;
  const parked = noCursor ? ({ disabledReason: "no_cursor" } as const) : {};
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
  /* `no_cursor` FIRST, THE CALLER'S REASON SECOND, and the order is the whole of it.
     With no cursor the cursor IS what is missing, whatever the gates would then say about the row
     one lands on — the rule `parked` is declared under, and the rule the dispatcher acts on. Only
     once a row is focused does the caller's own reason become the operative one, which is the case
     a reader in Trash meets: a row selected, the key inert, and the `?` sheet saying why. Reversing
     these two took `no_cursor` off every cursorless list the moment a caller supplied a reason —
     the first press stopped placing a cursor and the sheet printed the wrong sentence. */
  const reason = noCursor
    ? parked
    : (disabled && input.disabledReason ? ({ disabledReason: input.disabledReason } as const) : {});
  return [
    { chord: "Backspace", group: "message", label: input.label, disabled, ...reason, when, run },
    { chord: "Delete", group: "message", label: input.label, disabled, ...reason, when, run },
  ];
}

/**
 * THE SHELL'S BINDING — the held set as React state, the queue behind a ref, and the two places a
 * window may not simply evaporate.
 */
export function useDeleteUndo(deps: Omit<DeleteUndoDeps, "onHeld">): {
  held: ReadonlySet<string>;
  remove: (target: DeleteTarget | readonly DeleteTarget[]) => boolean;
} {
  const [held, setHeld] = useState<ReadonlySet<string>>(EMPTY);
  /* THE DEPS ARE READ THROUGH A REF, never closed over: `refusal`, `toast` and `copy` change
     identity on most renders, and rebuilding the queue would drop every armed timer — a press
     silently un-deleted by an unrelated re-render. */
  const latest = useRef(deps);
  latest.current = deps;
  const queue = useMemo(
    () => createDeleteUndo({
      mutate: (id) => latest.current.mutate(id),
      ...(latest.current.verb ? { verb: latest.current.verb } : {}),
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
  return {
    held,
    remove: useCallback((t: DeleteTarget | readonly DeleteTarget[]) => queue.remove(t), [queue]),
  };
}

/**
 * REPLAY, ONCE PER MOUNT — the other half of the durable record.
 *
 * Separate from {@link useDeleteUndo} because it is not part of pressing a key: it is the boot
 * step that finishes what a killed tab started, and a caller that wants the verb without the
 * replay (a surface with no engine to dispatch on) should be able to say so by not calling it.
 */
export function useDeleteIntentReplay(
  mutate: HeldDispatch,
  now: () => number,
  enabled = true,
  /**
   * The restore dispatch, when this shell has one. Omitted, a stranded restore is dropped
   * rather than sent — see {@link replayDeleteIntents}, where the reason it is a separate
   * parameter is written out: falling through to `mutate` would delete the message.
   */
  restore?: HeldDispatch,
): void {
  const ran = useRef(false);
  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    replayDeleteIntents(mutate, now(), restore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

const EMPTY: ReadonlySet<string> = new Set<string>();
