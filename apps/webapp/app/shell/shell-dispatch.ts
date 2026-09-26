"use client";

/**
 * THE SHELL'S DISPATCH SPINE — every press that changes mail leaves the interface through here.
 *
 * One seam rather than a `void engine.mutate(…)` at each verb: the sentence a press raises has to
 * wait for the ANSWER, because the service can refuse, the engine rolls its overlay back, and a
 * sentence written on the next line stands over mail that never moved. The delete and restore
 * windows, the routing window, the organizer's refusal vocabulary and the one armed Undo are the
 * same question asked in different words, so they live together. Lifted out of `AppShell.tsx`
 * unchanged (ARCH-022); it closes over nothing derived from the mirror.
 */
import { useMemo, useRef, type MutableRefObject } from "react";
import type { useTranslations } from "next-intl";
import {
  inverseMutations,
  PRESS_THREW,
  pressVerdict,
  tallyVerdicts,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type MutationRejectedError,
  type OhmailEngine,
  type PressVerdict,
} from "@ohmail/client-engine";
import { type ToastFn } from "@ohmail/ui";
import { readerMoveRefusal, type RosterState } from "./mail-state";
/* Backspace/Delete → Trash, and the window in which it has not happened yet. See the module. */
import { restoreDispatch, UNDO_MS, useDeleteIntentReplay, useDeleteUndo } from "./delete-undo";
/* Move/File/Junk → the mail now, the sender's routing after the window. See the module. */
import { useRoutingUndo } from "./routing-undo";
import { usePressWatch, type PressWatch } from "./press-watch";
import { placeLabel } from "./format";
import { useStableCallback } from "./stable-callback";

/**
 * WHAT THE SPINE IS HANDED. Every field is required and none has a default: a forgotten `demo`
 * would leave the replay and the routing window enabled in the fixture world, which is the shape
 * of an absent configuration selecting the live branch. `refreshFacts` has a constant identity (a
 * ref at the provider), and `reader` is the render's own `engine.read()` — handed in rather than
 * re-read here, so a press asks the mirror the shell last rendered against.
 */
export interface ShellDispatchInput {
  engine: OhmailEngine;
  reader: EntityReader;
  toast: ToastFn;
  t: ReturnType<typeof useTranslations>;
  demo: boolean;
  refreshFacts: () => void;
}

/** What the shell composes with: the two windows, the four report doors and the armed Undo. */
export interface ShellDispatch {
  fileAndRefresh: <T>(dispatch: Promise<T>) => Promise<T>;
  rosterRef: MutableRefObject<RosterState>;
  deleting: ReturnType<typeof useDeleteUndo>;
  restoring: ReturnType<typeof useDeleteUndo>;
  refusalCopy: { named: (name: string) => string; unknown: () => string };
  routing: ReturnType<typeof useRoutingUndo>;
  /** A sender-sheet press waiting on its backlog pass, told once when it finishes. */
  pressWatch: PressWatch;
  refusalSentence: (err: MutationRejectedError | undefined) => string;
  dispatchPress: (mutation: EngineMutation) => Promise<PressVerdict>;
  queuedSentence: (holder: string | null) => string;
  runArmedUndo: () => boolean;
  toastWithUndo: (
    sentence: string,
    inverses: readonly EngineMutation[],
    held?: { cancel: () => boolean; undone: string },
  ) => void;
  mutateAndReport: (mutation: EngineMutation, okSentence: string | null) => Promise<boolean>;
  mutateSetAndReport: (
    mutations: readonly EngineMutation[],
    say: (applied: number) => string | null,
  ) => Promise<number>;
  mailboxesOf: (ids: readonly string[]) => string[];
}

export function useShellDispatch({
  engine, reader, toast, t, demo, refreshFacts,
}: ShellDispatchInput): ShellDispatch {
  /**
   * Every filing dispatch goes through here. A filing decision writes `folder_state`; the strip
   * reports the outstanding work from `GET /mailboxes`, which is polled every 30 s and on
   * nothing else — so the sentence after a press was up to thirty seconds stale. A helper rather
   * than a call at each door because there are five doors with five shapes
   * (`test/filing-refresh-on-decision.test.tsx` pins every filing dispatch to it). Chained AFTER
   * the settle, never at the press — a press-time read reports the pre-decision number. A
   * rejection still refreshes: the rolled-back overlay leaves exactly what a fresh read says.
   * `refreshFacts` has a constant identity (a ref at the provider).
   */
  const fileAndRefresh = useStableCallback(<T,>(dispatch: Promise<T>): Promise<T> => {
    dispatch.then(refreshFacts, refreshFacts);
    return dispatch;
  });
  /**
   * Delete, with the window in which it has not happened yet — see `delete-undo.ts` for why
   * Undo on this verb is a delayed commit. Declared here, above `presented`, because the held
   * ids are what that projection subtracts: the row leaves every pile on the press, and the
   * mutation that would do that is what the window postpones. The roster rides a ref written in
   * an EFFECT: assigning during render publishes a value a concurrent render may discard — a
   * role that never committed, exposed to a key handler that did. The refusal asks about THIS
   * MESSAGE'S mailbox, never the account (`readerMoveRefusal`); `[mailboxId]` so single and
   * bulk arms are one code path.
   */
  /* THE STATE, not the array. `mailboxes: null` collapses "no probe on this shell" (the desktop,
     the demo) with "the probe has not answered", and those are opposite answers for a write gate
     — see `rosterStateOf`. The resting value is `pending`, which refuses: a shell that HAS a probe
     starts there, and one that has none is corrected by the effect on its first commit. */
  const rosterRef = useRef<RosterState>({ kind: "pending" });
  const deleting = useDeleteUndo({
    /* THE FIFTH DOOR, WRAPPED AT THE DEP AND NOT AT THE PRESS. The delete arm below opens a
       window rather than dispatching, so the mutation leaves from `delete-undo.ts` — after the
       undo window closes, and for a selection in a batch. Wrapping the injected dispatcher is
       the only place that covers both, and `test/filing-refresh-on-decision.test.tsx` pins this
       line by name: nothing conflicts here, so a census that only read this file would have gone
       vacuous for `message_delete` instead of red. */
    mutate: (messageId) => fileAndRefresh(engine.mutate({ kind: "message_delete", messageId })),
    toast,
    copy: {
      deleted: t("ohbox.toastDeleted"),
      undo: t("screener.toastUndo"),
      undone: t("ohbox.deleteUndone"),
      failed: t("ohbox.deleteFailed"),
      /* THE ONE SENTENCE THIS ROW WAS WAITING FOR — the key has been in both catalogues since the
         202 work and nothing read it, so a reader install's delete kept saying "Deleted". */
      queued: t("screening.deleteQueuedForOrganizer"),
      queuedMany: (count) => t("ohbox.deleteQueuedMany", { count }),
      /* SAID WHEN THE JAR REFUSED THE RECORD — the press acts at once and offers no undo.
         `session` rather than `ohbox`: it is the same sentence the Screener says. */
      noUndo: t("session.noUndoHere"),
      /* THE PLURAL SET, for a press over a selection. Separate sentences rather than one string
         with a number in it: the singular is what the key has said since it shipped, and it stays
         word for word so nothing about the one-message press moves. */
      deletedMany: (count) => t("ohbox.toastDeletedMany", { count }),
      undoneMany: (count) => t("ohbox.deleteUndoneMany", { count }),
      failedMany: (count) => t("ohbox.deleteFailedMany", { count }),
    },
    /* EVERY mailbox the press touches, asked once. A nullish id becomes `""`, which the predicate
       refuses as an id no roster row carries — the same answer, reached without a second branch
       here that could drift from the one inside it. */
    refusal: (mailboxIds) => readerMoveRefusal(
      rosterRef.current,
      mailboxIds.map((id) => id ?? ""),
      refusalCopy,
    ),
  });
  /**
   * Restore, held the same way the delete is — a second window over the same machinery. Two
   * windows, not one queue: a held delete subtracts from `presented`, a held restore subtracts
   * from the TRASH page, which is off-mirror — one shared held set would make each surface hide
   * the other's rows. The refusal is the same organizer question, asked at the press. The
   * dispatch is `restoreDispatch` over `engine.restoreFromTrash` — NOT `engine.mutate`, which
   * rejects a mutation over a tombstoned row (`delete-undo.ts` has the argument). The toast
   * names the SERVER's answer (`restoreTo` off the response): the origin folder can disappear
   * between the page and the press.
   */
  const restoring = useDeleteUndo({
    verb: "restore",
    /* THE DISPATCH RAISES THE PLACE SENTENCE, because that is the one moment the place is known
       — see `restoreDispatch`, where the alternative (a second call at the press) is named as
       the thing that would silently cancel the undo window.
       AND IT SAYS "Restoring", never "Restored": the server's answer is a QUEUED intent
       (`pending`), the mail server performs the move on the organizer's next turn, and the row
       comes back when that landing is observed. The sentence this used to say claimed a
       completed restore seconds before anything had moved, so an outage left the person told
       their mail was back while it sat in Trash. The place is still the server's answer. */
    mutate: (messageId, pressId) => fileAndRefresh(
      restoreDispatch(
        (id, opts) => engine.restoreFromTrash(id, opts),
        (restoreTo) => toast(t("trash.toastRestoringTo", { place: placeLabel(restoreTo) })),
      )(messageId, pressId),
    ),
    toast,
    copy: {
      /* THE PLACE IS NOT KNOWN AT THE PRESS. The window's `deleted` sentence is said the moment
         the row is hidden, and the destination arrives with the server's answer seconds later —
         so this one says what is TRUE then ("Restoring…") and the arm that reads the response
         says where it went. A sentence naming a place before the server has answered would be
         the false-state failure this whole seam exists to avoid. */
      deleted: t("trash.restoring"),
      undo: t("screener.toastUndo"),
      undone: t("trash.toastRestoreUndone"),
      failed: t("trash.toastRestoreFailed"),
      /* THE SAME SENTENCE THE DELETE WINDOW SAYS: a refused jar takes the undo away, not the
         restore. Required by `DeleteUndoCopy` so no window can offer an undo it cannot honour. */
      noUndo: t("session.noUndoHere"),
    },
    refusal: (mailboxIds) => readerMoveRefusal(
      rosterRef.current,
      mailboxIds.map((id) => id ?? ""),
      refusalCopy,
    ),
  });

  /**
   * WHAT A KILLED TAB LEFT BEHIND, finished at the next launch. The other half of the durable
   * record `delete-intents.ts` keeps; without it the journal would grow and nothing would act on
   * it, which is a durable record of nothing. Demo excluded: the fixture world has no server to
   * carry a delete to, and replaying one there would mutate a demo somebody is looking at.
   */
  useDeleteIntentReplay({
    /* THROUGH `fileAndRefresh`, LIKE EVERY OTHER FILING DISPATCH: a replayed delete moves mail,
       so the count the filing strip renders is stale until the facts are re-read. */
    /* AND IT IS `replayDelete`, NOT `mutate`: by this launch the row may be gone from the mirror
       because the WINDOW evicted it. The door tells the two absences apart — a tombstone this
       device holds settles with no round trip, anything else asks the mailbox under the press's
       own id, so the re-ask is that press and not a second one. `filing-refresh-on-decision`
       reads this line by the CALL, since no `kind:` literal is left here to find it by. */
    mutate: (messageId, pressId) => fileAndRefresh(engine.replayDelete(messageId, { intentId: pressId })),
    now: () => Date.now(),
    enabled: !demo,
    /* THE MIRROR'S OWN FACT, AWAITED BEFORE ANYTHING IS DISPATCHED. `hydrate()` is single-flight,
       so this coalesces with the sync scheduler's own call and starts no second read; what it
       buys is that a delete replayed at mount is no longer refused by an empty mirror and then
       struck off the journal. Never an interval — see `ReplayEnv.hydrated`. */
    hydrated: () => engine.hydrate(),
    tell: toast,
    /* THE SENTENCE IS RESOLVED FROM THE ROW'S OWN VERB: one journal holds both, and a refused
       restore told in the delete's words would name the opposite of what the person did. */
    copy: {
      retrying: (verb, count) => t(
        verb === "restore" ? "trash.restoreReplayRetrying" : "ohbox.deleteReplayRetrying",
        { count },
      ),
      failed: (verb, count) => t(
        verb === "restore" ? "trash.restoreReplayFailed" : "ohbox.deleteReplayFailed",
        { count },
      ),
    },
    /* THE RESTORE'S REPLAY, wired only where the transport exists. Omitted, `delete-undo.ts`
       DROPS a stranded restore rather than sending it — never falling through to the delete,
       which would delete the message somebody asked to put back. `trashAvailable()` is the same
       answer the palette row and the chord read, so the surface cannot offer a verb whose
       replay would be dropped. */
    restore: engine.trashAvailable()
      ? (messageId, pressId) => fileAndRefresh(
          /* THE PRESS ID IS THE REPLAY'S WHOLE POINT HERE: this dispatch runs at the next launch
             for a press whose response was lost, so it goes out under that press's own key and
             the server answers it as already applied instead of "not in Trash". */
          restoreDispatch((id, opts) => engine.restoreFromTrash(id, opts))(messageId, pressId),
        )
      : undefined,
  });
  const pressWatch = usePressWatch(reader);
  const refusalCopy = useMemo(
    () => ({
      named: (name: string) => t("screener.readerMoveRefused", { name }),
      unknown: () => t("screener.readerMoveRefusedUnknown"),
    }),
    [t],
  );
  /**
   * THE ROUTING VERBS' OWN WINDOW. Move, File and Junk write a sender's ROUTING, and no rule
   * mutation has a wire inverse — so the mail moves at the press and the rule is HELD for
   * `UNDO_MS`, cancelled by Undo, sent unchanged when the window closes. Demo excluded, for
   * `useDeleteIntentReplay`'s reason.
   */
  const routing = useRoutingUndo({
    read: () => engine.verbRead(),
    /* THROUGH `fileAndRefresh`, LIKE EVERY OTHER FILING DISPATCH — a rule landing re-places the
       sender's mail, so the filing strip's counts are stale until the facts are re-read. */
    send: (m) => fileAndRefresh(engine.mutate(m)),
    toast,
    enabled: !demo,
    copy: useMemo(() => ({
      gone: t("screening.toastRuleSeedGone"),
      expired: (count: number) => t("screening.toastRuleExpired", { count }),
      correction: (key, note) =>
        t(`screening.${key}`, { sender: note.sender, place: note.place, count: note.count }),
    }), [t]),
  });


  /**
   * THE REFUSAL, IN THE PERSON'S OWN LANGUAGE. `MutationRejectedError.message` is server English
   * and rendering it puts an untranslated protocol sentence inside a translated interface, so the
   * branch is on `code`. `organized_elsewhere` is the one this seam exists for: a reader install's
   * triage, park and resurface are refused per mailbox, and the holder's name rides the refusal's
   * own details. Anything else — a message that has gone, an outage — gets the sentence that is
   * true of all of them: nothing changed.
   */
  /**
   * What one dispatch answered. A discriminated union rather than an optional refusal: "applied"
   * and "refused for a reason nobody named" are different answers, and an optional field would
   * collapse them the first time a caller read it.
   */
  type PressOutcome = PressVerdict;

  const refusalSentence = useStableCallback((err: MutationRejectedError | undefined): string => {
    if (err?.code !== "organized_elsewhere") return t("ohbox.refusedPress");
    const by = (err.details as { by?: { name?: string | null } } | null | undefined)?.by;
    const name = by?.name && by.name.trim() ? by.name.trim() : null;
    return name ? t("ohbox.refusedOrganized", { name }) : t("ohbox.refusedOrganizedUnknown");
  });

  /**
   * A PRESS IS REPORTED FROM ITS ANSWER — the shell's one dispatch seam.
   *
   * Every verb here used to be `void engine.mutate(…)` with its sentence raised on the next line:
   * the service refused, the engine rolled the overlay back, and the sentence stood over mail that
   * had not changed. So the sentence waits for the outcome. `rolled_back` renders the refusal and
   * answers `false`, which lets a caller withhold the follow-up half of a two-verb press. Nothing
   * is undone here — the overlay is the engine's own, already rolled back by the time this
   * resolves; the interface is simply told the truth about it.
   */
  const dispatchPress = useStableCallback((mutation: EngineMutation): Promise<PressOutcome> =>
    engine.mutate(mutation).then(
      pressVerdict,
      /* `mutate` resolves with a verdict rather than rejecting, so a throw here is this client
         failing — still a press that did nothing, and still owed a sentence. */
      () => PRESS_THREW,
    ));

  /**
   * THE SENTENCE A WAIT GETS. `organizer` is a request the SERVER recorded for the install that
   * organizes this mailbox: nothing here advances it and nothing here may report it done — the
   * arm that made this seam say "Done" over a recorded request. `retry` is this client's own
   * outbox, where the optimistic view standing is truthful, so it keeps the caller's sentence.
   */
  const queuedSentence = useStableCallback((holder: string | null): string =>
    (holder ? t("ohbox.pressQueuedOrganized", { name: holder }) : t("ohbox.pressQueuedOrganizedUnknown")));

  /** How many of a set are waiting on the ORGANIZER — a retry-queued press keeps the caller's
   *  sentence, because the optimistic view standing is truthful for it. */
  const organizerWaits = (outs: readonly PressVerdict[]): number =>
    outs.filter((o) => o.kind === "queued" && o.wait === "organizer").length;

  /**
   * ONE UNDO FOR EVERY VERB (the 0.20 review) — the toast carries Undo wherever the engine can build
   * the wire's own reversal (`inverseMutations`, read BEFORE the dispatch), and `z` presses the
   * same offer. Undo dispatches the inverses through the ordinary seam, so the overlay, the outbox
   * and the refusal vocabulary all apply — never a local state hack. Bounded by `UNDO_MS`, the
   * Screener's own window; a late press takes nothing back and claims nothing (the armed offer is
   * consumed before it fires, so it fires at most once).
   */
  const undoArm = useRef<{ fire: () => void; at: number } | null>(null);
  const runArmedUndo = useStableCallback((): boolean => {
    const arm = undoArm.current;
    if (!arm || Date.now() - arm.at > UNDO_MS) return false;
    undoArm.current = null;
    arm.fire();
    return true;
  });
  /**
   * AND A ROUTING PRESS TAKES BACK A SECOND THING, which is the one shape an inverse cannot
   * carry: the rule it was about has not been sent yet, so Undo CANCELS it rather than reversing
   * it (`routing-undo.ts`). `held.cancel` answers whether it actually took — a window that has
   * already closed did not, and the sentence must not say "no rule was made" over a rule that
   * was. Both halves ride ONE press, and `z` presses the same offer as the button.
   */
  const toastWithUndo = useStableCallback((
    sentence: string,
    inverses: readonly EngineMutation[],
    held?: { cancel: () => boolean; undone: string },
  ) => {
    if (inverses.length === 0 && !held) { toast(sentence); return; }
    const fire = () => {
      /* THE CANCEL GOES FIRST, and synchronously: the window is racing a timer, and a cancel
         behind an awaited dispatch is a cancel that can lose to it. */
      const cancelled = held ? held.cancel() : false;
      if (inverses.length === 0) {
        toast(cancelled && held ? held.undone : t("ohbox.toastUndoExpired"));
        return;
      }
      void Promise.all(inverses.map((mu) => dispatchPress(mu))).then((outs) => {
        const tally = tallyVerdicts(outs);
        /* THE MAIL CAME BACK. Only a cancel that TOOK may add "and no rule was made" — past the
           window the rule is on its way and the honest sentence is the plain one. */
        if (tally.applied > 0) { toast(cancelled && held ? held.undone : t("ohbox.toastUndone")); return; }
        if (tally.refused === 0 && organizerWaits(outs) > 0) { toast(queuedSentence(tally.holder)); return; }
        toast(refusalSentence(tally.firstRefusal));
      });
    };
    undoArm.current = { fire, at: Date.now() };
    toast(sentence, {
      action: t("ohbox.undo"),
      duration: UNDO_MS,
      onAction: () => { undoArm.current = null; fire(); },
    });
  });

  const mutateAndReport = useStableCallback(
    (mutation: EngineMutation, okSentence: string | null): Promise<boolean> => {
      /* Read before the dispatch — the inverse names the state this press is about to leave.
         Skipped on the silent paths (`okSentence === null`): no toast, nothing to carry Undo. */
      const inverses = okSentence !== null ? inverseMutations(engine.verbRead(), mutation) : [];
      return dispatchPress(mutation).then((out) => {
        if (out.kind === "refused") { toast(refusalSentence(out.refusal)); return false; }
        if (out.kind === "queued" && out.wait === "organizer") { toast(queuedSentence(out.holder)); return false; }
        if (okSentence !== null) toastWithUndo(okSentence, inverses);
        return true;
      });
    },
  );

  /**
   * THE SAME RULE OVER A SET, and the reason it is not a loop over the one above: a toast per
   * refused message over a selection of forty is not feedback, it is a denial of service on your
   * own screen. So the set speaks ONCE — and it speaks the WHOLE press: a set of seven where
   * three applied and four were refused used to say three and never mention the four, which is
   * better than the count of what was picked and is not yet the truth. What is waiting on the
   * organizer is counted separately again, because nothing has happened to it.
   */
  const mutateSetAndReport = useStableCallback(
    (mutations: readonly EngineMutation[], say: (applied: number) => string | null): Promise<number> => {
      /* One pre-press read for the whole set; the undo covers exactly the mutations that APPLIED
         — an inverse of a refused press would change state the press never touched. */
      const preRead = engine.verbRead();
      const inversesOf = mutations.map((mu) => inverseMutations(preRead, mu));
      return Promise.all(mutations.map((mu) => dispatchPress(mu))).then((outs) => {
        const tally = tallyVerdicts(outs);
        const waiting = organizerWaits(outs);
        if (tally.applied === 0 && outs.length > 0) {
          if (tally.refused === 0 && waiting > 0) { toast(queuedSentence(tally.holder)); return 0; }
          toast(refusalSentence(tally.firstRefusal));
          return 0;
        }
        const sentence = say(tally.applied);
        /* Undo only when the WHOLE set applied: on a partial press the extra sentence below is
           the one left standing (the host renders one toast), and it must not wipe a live offer. */
        const whole = tally.refused === 0 && waiting === 0;
        if (sentence !== null && whole) {
          toastWithUndo(sentence, outs.flatMap((o, i) => (o.kind === "applied" ? inversesOf[i]! : [])));
        } else if (sentence !== null) {
          toast(sentence);
        }
        /* THE PART THAT DID NOT HAPPEN, SAID BESIDE IT. One extra sentence at most, and only
           when the press was partial: a count of what applied is a true number under which four
           refused messages are invisible. */
        if (tally.refused > 0) toast(t("ohbox.pressPartlyRefused", { count: tally.refused }));
        else if (waiting > 0) toast(t("ohbox.pressPartlyQueued", { count: waiting }));
        return tally.applied;
      });
    },
  );

  /** Which mailboxes a set of messages lives in — first-seen order, de-duplicated. An
   *  unresolvable message contributes `""`, which the predicate refuses as an unknown id. */
  const mailboxesOf = useStableCallback(
    (ids: readonly string[]): string[] => {
      const out: string[] = [];
      for (const id of ids) {
        const mb = reader.get<EngineMessage>("message", id)?.mailboxId ?? "";
        if (!out.includes(mb)) out.push(mb);
      }
      return out;
    },
  );

  return {
    fileAndRefresh,
    rosterRef,
    deleting,
    restoring,
    refusalCopy,
    routing,
    pressWatch,
    refusalSentence,
    dispatchPress,
    queuedSentence,
    runArmedUndo,
    toastWithUndo,
    mutateAndReport,
    mutateSetAndReport,
    mailboxesOf,
  };
}
