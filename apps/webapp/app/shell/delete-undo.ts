"use client";

/**
 * Backspace and Delete move the focused message to Trash — with an Undo in the toast. The undo is a
 * DELAYED COMMIT, not a reversal: there is no un-delete on the wire (`message_delete` files into the
 * provider's native `\Trash` and tombstones the row), so the press hides the row and starts a
 * timer, the toast carries Undo while it runs, and the mutation dispatches only when the window
 * closes — the Screener's own answer, one verb over ({@link UNDO_MS} is imported, never a second
 * number). The window is durable (`delete-intents.ts`): the intent is written synchronously before
 * the timer, Undo removes it, `pagehide` commits what is open, survivors replay at launch, and an
 * unmount commits too ({@link DeleteUndo.flush}) — leaving a view is not asking for the delete back.
 */

/**
 * A reader does nothing, and is told so before anything happens. A delete is a folder move against
 * mail another install is arranging — `screener-state.ts#refuseMove` names deleting among the moves
 * refused for every reader, and the server agrees (`message-service.ts#delete` calls
 * `assertOrganizerRole` before looking for a Trash folder). The role is asked PER MAILBOX
 * (`mailboxWriteRole(facts, m.mailboxId)`), never of the roster — the account-wide answer let an
 * account organizing mailbox A delete from mailbox B; an unknown roster refuses too. The refusal is
 * evaluated BEFORE anything else the press would do, and `remove` answers whether it acted. A
 * folder-move REQUEST is not invented here: `REQUEST_KINDS` is closed by CHECK on four members.
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
 * A reader with some messages taken out — what makes a held delete look like a delete. The row has
 * to leave every list the instant the key is pressed, and the only thing that would otherwise do
 * that is the mutation the window is postponing. So the presentation loses the row and the MIRROR
 * keeps it: `AppShell` composes this over `presented` (the pile source) and never over `reader` —
 * `presentationReader`'s own rule ("never use this reader to open a message, to search, or behind
 * a mutation") — which lets Undo restore the row by forgetting an id. Identity is preserved when
 * nothing is held: the base reader returns unwrapped, so downstream `useMemo`s keep their inputs.
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
  /**
   * THE JAR REFUSED THE RECORD, so the delete went at once and no undo was offered.
   *
   * Required rather than optional: a caller that has not been taught about the degradation would
   * otherwise offer an undo it cannot honour, silently — which is the defect. A compile error at
   * every call site is the point of it. Read from `session` (the "what this browser can keep"
   * namespace) so the Screener and the delete key say one sentence.
   */
  noUndo: string;
  /** The same three for a press over MORE THAN ONE message. Optional; see above. */
  deletedMany?: (count: number) => string;
  undoneMany?: (count: number) => string;
  failedMany?: (count: number) => string;
}

/**
 * Which verb this window holds, and the dispatch it commits to. The verb is injected, not branched on: the
 * restore cannot be an `EngineMutation` at all (the engine rejects a mutation whose local effects are empty,
 * and a mutation over a tombstoned row has none), so a second window would have needed a second copy of the
 * timer, the journal write, the idempotence rule and the toast ceremony — two copies is how a `pagehide` commit
 * comes to be right for one verb and wrong for the other. The window holds ids, arms a timer, writes ONE
 * journal row naming the verb, and calls `dispatch` per id when it closes; delete passes `engine.mutate`,
 * restore passes `engine.restoreFromTrash`. `dispatch` answers a status string, not a boolean: `"rolled_back"`
 * is the vocabulary both verbs already share, so one comparison covers both.
 */
export type HeldDispatch = (
  messageId: string,
  /**
   * THE PRESS THIS MESSAGE BELONGS TO — the id `delete-intents.ts` journalled, so a dispatch can
   * name one intent on the wire. The restore's `Idempotency-Key` is built from it: the same press
   * replayed at the next launch carries the same id, and a later press carries a different one.
   * Every existing dispatch ignores it, which is what keeps the delete's call sites unchanged.
   */
  pressId: string,
) => Promise<{ status: string }>;

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
   * May these mailboxes be written to — the sentence to say, or `null` for yes. Takes EVERY mailbox
   * the press touches and is asked once for the whole press: a selection spanning a mailbox this
   * install organizes and one it only reads is a single gesture, and answering per message would
   * delete the permitted half and refuse the rest — a partial outcome reported by one toast. The
   * press is refused whole; the mixed-selection ruling falls out of the signature. A function
   * rather than a value so the roster is read at PRESS time — one captured at construction answers
   * with the roster the shell had at mount, wrong for a mailbox that changed hands mid-session.
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
   * One press — over the focused message, or a whole selection. A set is ONE press and not N: one
   * window opens, one toast shows, one Undo takes the whole selection back, one durable intent
   * records it — so `pagehide` commits a press atomically. N windows would give N toasts replacing
   * each other, only the last undoable, and a tab closed mid-way would delete an arbitrary prefix.
   * Returns whether the press ACTED: `false` is a refusal or no-op, and the caller must not run its
   * own side effects on it — a refused delete once closed the sheet over the message it had just
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
      void deps.mutate(messageId, pressId).then(
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
      const written = armDeleteIntent({ id: pressId, messageIds: ids, at: clock(), kind: deps.verb ?? "delete" });
      /* A REFUSED JAR TAKES THE UNDO AWAY, NOT THE DELETE.
         The window is only reversible because nothing has been sent yet, and the only thing that
         made it safe to postpone was the record on disk. With no record, a tab closed inside the
         window drops a delete the toast has already reported — so the press acts at once and the
         sentence says there is no undo, rather than offering one that cannot be honoured. */
      if (written === "lost") {
        dispatch(pressId, ids);
        deps.toast(`${say(deps.copy.deleted, deps.copy.deletedMany, ids.length)} ${deps.copy.noUndo}`);
        return true;
      }
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
      /* THE JOURNALLED PRESS ID TRAVELS WITH THE REPLAY, and it is the whole of the restore's
         idempotency: this is the request whose first response was lost, so it must arrive under
         the key the first attempt used rather than as a second press. */
      intent.messageIds.map((messageId) => fn(messageId, intent.id)),
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
  restoreFromTrash: (
    messageId: string, opts: { intentId: string },
  ) => Promise<{ state: string; restoreTo?: string }>,
  /**
   * WHERE IT IS GOING, said when the SERVER has answered — and never at the press. The answer is
   * a queued intent, so the sentence the caller raises says "Restoring", not "Restored".
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
  return async (messageId, pressId) => {
    const outcome = await restoreFromTrash(messageId, { intentId: pressId });
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
      mutate: (id, pressId) => latest.current.mutate(id, pressId),
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
