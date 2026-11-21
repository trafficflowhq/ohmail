/**
 * A LETTER'S VERBS FROM A LIST: every press on one row or one open letter that a list runs (a key on the cursor row,
 * the row's menu, the open letter's panel through the list's visit). A row stands for its conversation: a pile press
 * takes the row whole, Done releases every pin of it, a Move takes what other people sent in it.
 *
 * Each arm leaves through the frame's one seam, and its sentence follows the seam's answer.
 */
import type { EngineMessage, OhmailView } from "@ohmail/wire";
import { FOLDER_OF_VIEW, inverseMutations } from "@ohmail/client-engine";
import { readerMoveRefusal } from "../mail-state/mail-state.js";
import { dayStamp, PLACE_LABEL, resurfaceLabel, tomorrowAt } from "../text/format.js";
import type { MessageAction, MoveSubject } from "./actions.js";
import { decidesAtGate, fileThroughRouting, planMoveToPlace } from "./move-to-place.js";
import { pressMoveSet, removeSpending, runBulkAction } from "./selection-verbs.js";
import { dispatchScreeningChange, moveSubjectIds, screeningToast } from "./sender-screening.js";
import { rowOf, withRow, type MoveContext, type VerbContext } from "./verb-context.js";

/** Move one row to a place: the sender's routing, held for the Undo window, and the row's own letters moved now. */
function moveToPlace(cx: MoveContext, m: EngineMessage, view: OhmailView, subject: MoveSubject): void {
  const { engine, t } = cx;
  /* A CONVERSATION WHOSE NEWEST LETTER IS OURS moves the letters other people sent in it (`moveSubjectIds`): one
     sender's on this arm, several senders' through the selection's. A row pressed on stands for its letter, so the
     seed is the reply facing that row; a letter reached by a link, a search or opened unread and then answered
     seeds itself. */
  const seed = subject === "letter" || cx.offOhbox ? m : (cx.ownFaceFor?.(m) ?? m);
  const subjects =
    subject === "letter"
      ? [m.id]
      : moveSubjectIds(withRow(engine.verbRead(), seed), seed.id, cx.ownAddresses);
  const senders = new Set(
    subjects.map((id) =>
      engine.verbRead().get<EngineMessage>("message", id)?.from.address.trim().toLowerCase(),
    ),
  );
  if (senders.size > 1) {
    pressMoveSet(cx, view, subjects);
    return;
  }
  const planned =
    subjects[0] === m.id
      ? planMoveToPlace(cx, m.id, view, new Set([m.id]), m, subject === "letter" ? "leave" : "decide")
      : planMoveToPlace(cx, subjects[subjects.length - 1]!, view, new Set(subjects));
  /* The pressed row is its own seed, so there is always a sender to route. */
  if (!planned) return;
  /* NO EMPTY-PLAN SHORTCUT: a plan with nothing in it dispatches nothing and `screeningToast` answers "already ruled"
     off the rule's state alone, so the one path already speaks for the press that changes nothing. */
  const place = PLACE_LABEL[view] ?? view;
  const said = screeningToast(planned.plan, null, planned.moves.length);
  const sentence = t(`screening.${said}`, { sender: planned.who, place, count: planned.plan.moved });
  /* A DECIDE KEEPS ITS OWN PATH (`fileThroughRouting`'s note): its sentence is the one the server earned, awaited. */
  if (decidesAtGate(planned.plan)) {
    void dispatchScreeningChange(planned.plan, planned.moves, (mu) =>
      cx.press.fileAndRefresh(engine.mutate(mu)),
    ).then((key) => {
      if (key === null) return;
      cx.toast(t(`screening.${key}`, { sender: planned.who, place, count: planned.plan.moved }));
    });
    return;
  }
  fileThroughRouting(cx, { plans: [planned], view, sentence, undone: t("screening.toastRoutingUndone") });
}

/** Resurface on a message; on a pile row, or in the Ohbox on its row, every message of the row, as one press. */
function resurfaceRow(
  cx: VerbContext,
  messageId: string,
  state: "bubbled_up" | "resurfaced",
  when: string | null,
  said: string,
): void {
  const set = cx.pileSetFor?.(messageId, !cx.offOhbox) ?? [messageId];
  const ms = (set.length > 1 ? set : [messageId]).map((id) => ({
    kind: "triage_set" as const,
    messageId: id,
    state,
    ...(when ? { bubbleUpAt: when } : {}),
  }));
  if (ms.length > 1) void cx.press.mutateSetAndReport(ms, () => said);
  else void cx.press.mutateAndReport(ms[0]!, said);
}

/**
 * ANSWER LATER AND PARK ARE TOGGLES, the way OUT of a pile: the verb that put a message IN a pile takes it out
 * again, and the sentence states the direction each press actually took. ONE PILE PRESS: a pile row, or an Ohbox row
 * (our reply too, so the row leaves), as one set.
 */
function pressPile(cx: VerbContext, action: "later" | "aside", m: EngineMessage): void {
  const { t } = cx;
  const { mutateAndReport, mutateSetAndReport } = cx.press;
  const state = action === "later" ? ("reply_later" as const) : ("set_aside" as const);
  const set = cx.pileSetFor?.(m.id, !cx.offOhbox) ?? [];
  if (set.length > 1) {
    const holds = (id: string) => rowOf(cx, id)?.triage?.state === state;
    const off = set.every(holds);
    void mutateSetAndReport(
      set
        .filter((id) => off || !holds(id))
        .map((messageId) => ({
          kind: "triage_set" as const,
          messageId,
          state: off ? ("none" as const) : state,
        })),
      (applied) =>
        off
          ? t(state === "reply_later" ? "ohbox.toastUnqueued" : "ohbox.toastUnparked")
          : t(state === "reply_later" ? "ohbox.toastBulkLater" : "ohbox.toastBulkAside", { count: applied }),
    );
  } else if (m.triage?.state === state) {
    void mutateAndReport(
      { kind: "triage_set", messageId: m.id, state: "none" },
      t(state === "reply_later" ? "ohbox.toastUnqueued" : "ohbox.toastUnparked"),
    );
  } else {
    void mutateAndReport(
      { kind: "triage_set", messageId: m.id, state },
      t(state === "reply_later" ? "ohbox.toastQueued" : "ohbox.toastAside"),
    );
  }
}

/**
 * THE READ TOGGLE'S FALLBACK ARM. On the Ohbox a slot whose face says Mark as read writes the conversation set it
 * was drawn from (`readSetFor`); otherwise `!m.unread` is the DESIRED state, the flip in the direction the
 * per-message face shows. Off the Ohbox a read here is a read in ohmail: the engine sends it as an open read when the
 * row stands in New. No hold: nothing keeps it.
 */
function pressUnread(cx: VerbContext, m: EngineMessage): void {
  const set = cx.readSetFor?.(m.id);
  if (set && set.length > 0) runBulkAction(cx, "read", set);
  else void cx.markSeen([m.id], !m.unread, undefined, cx.offOhbox && m.unread ? m.id : undefined);
}

/**
 * The horizon-less Resurface: the keyboard's `b`. A message already scheduled CLEARS its booking rather than being
 * silently re-dated; else TOMORROW at the account's resurface time, the picker's own first dated preset.
 */
function pressResurface(cx: VerbContext, m: EngineMessage): void {
  const { t, nowAt } = cx;
  if (m.triage?.state === "bubbled_up") {
    const row = cx.pileSetFor?.(m.id, false) ?? [m.id];
    if (row.length > 1) {
      void cx.press.mutateSetAndReport(
        row.map((messageId) => ({ kind: "triage_set" as const, messageId, state: "none" as const })),
        () => t("ohbox.toastResurfaceCleared"),
      );
      return;
    }
    void cx.press.mutateAndReport(
      { kind: "triage_set", messageId: m.id, state: "none" },
      t("ohbox.toastResurfaceCleared"),
    );
    return;
  }
  const when = tomorrowAt(nowAt(), cx.consent.resurfaceTime).iso;
  resurfaceRow(
    cx,
    m.id,
    "bubbled_up",
    when,
    t("ohbox.toastResurface", { when: resurfaceLabel(when, nowAt()) }),
  );
}

/**
 * THE DELIBERATE RELEASE: "Done" on a resurfaced or scheduled message. For a pinned message it is one mutation: a
 * deliberate read spends the pin in the same act, and the row files back at its arrival slot. For a scheduled
 * message the booking is cleared FIRST, then the same deliberate read files it. THE SENTENCE FOLLOWS THE ANSWER: a
 * refused clear means the schedule is intact, so the read that would file the row is never sent.
 */
function pressDone(cx: VerbContext, m: EngineMessage): void {
  // A conversation's pins, or its booked row: the row's Done releases all of them.
  const released = cx.doneSetFor?.(m.id) ?? [m.id];
  if (released.length > 1) {
    runBulkAction(cx, "done", released);
    return;
  }
  const release = async (): Promise<void> => {
    /* Both halves' inverses, off the pre-press mirror: the deliberate read's (re-pin a spent pin, unread back) and
       the booking clear's (re-book at its own date). A row is pinned OR booked, never both. */
    const pre = cx.engine.verbRead();
    const inverses = [
      ...inverseMutations(pre, { kind: "mark_seen", messageIds: [m.id], unread: false }),
      ...(m.triage?.state === "bubbled_up"
        ? inverseMutations(pre, { kind: "triage_set", messageId: m.id, state: "none" })
        : []),
    ];
    if (
      m.triage?.state === "bubbled_up" &&
      !(await cx.press.mutateAndReport({ kind: "triage_set", messageId: m.id, state: "none" }, null))
    )
      return;
    /* WHERE IT WENT, named: Earlier is one chronology, so a ten-day-old row files ten days down. */
    if (await cx.markSeen([m.id], false)) {
      cx.press.toastWithUndo(cx.t("ohbox.toastResurfaceDone", { when: dayStamp(m.date) }), inverses);
    }
  };
  void release();
}

/**
 * `move:<view>`: the destination travels with the action. A READER INSTALL MOVES NOTHING, AND HEARS SO BEFORE
 * ANYTHING LEAVES: asked at the press, before the wire, in the roster's own words.
 */
export function pressMove(cx: MoveContext, view: OhmailView, m: EngineMessage, subject: MoveSubject): void {
  /* The destination has to BE one: an unknown view is the only thing this cannot act on. */
  if (!FOLDER_OF_VIEW[view]) return;
  const refusedMove = readerMoveRefusal(
    cx.press.rosterRef.current,
    [m.mailboxId ?? ""],
    cx.press.refusalCopy,
  );
  if (refusedMove !== null) {
    cx.toast(refusedMove);
    return;
  }
  moveToPlace(cx, m, view, subject);
}

/** Run `action` on `m`. */
export function runMessageAction(
  cx: VerbContext,
  action: MessageAction,
  m: EngineMessage,
  moveSubject: MoveSubject = "conversation",
): void {
  const { t, nowAt } = cx;
  switch (action) {
    case "reply":
    case "reply_all":
    case "forward":
    case "draft":
      /* THE ONE COMPOSER'S DOORS, as the place's host hands them: Reply and Reply all toggle the editor over the
         letter, Forward asks before an original that may not be forwarded, the drafter opens over the reply it has
         raised. One open, one refusal, one scratch lane: none of them is spelled here. */
      cx.answer(action, m);
      return;
    case "later":
    case "aside":
      pressPile(cx, action, m);
      return;
    case "unread":
      pressUnread(cx, m);
      return;
    case "resurface":
      pressResurface(cx, m);
      return;
    case "delete": {
      const current = rowOf(cx, m.id);
      if (current === undefined) return;
      /* A move to the provider's own Trash, NEVER an expunge, held for its Undo window (`delete-undo.ts`). THE
         REFUSAL DECIDES FIRST, and the letter over the list closes only if the press acted, and only over ITS own
         message: reversed, a refused delete closed the letter it had just declined to touch. */
      if (
        removeSpending(cx, [{ id: current.id, mailboxId: current.mailboxId }]) &&
        cx.letterUp === current.id
      )
        cx.closeLetterUp();
      return;
    }
    case "restore":
      /* Held exactly as the delete is: the row leaves Trash at the press and the restore goes out when the window
         closes; the place is named by the SERVER, afterwards. */
      if (cx.press.restoring.remove({ id: m.id, mailboxId: m.mailboxId }) && cx.letterUp === m.id)
        cx.closeLetterUp();
      return;
    case "resurface_now":
      /* "NOW" IS A STATE, NOT A DATE: the mutation asks for the state the schedule exists to reach. */
      resurfaceRow(cx, m.id, "resurfaced", null, t("ohbox.toastResurfaceNow"));
      return;
    case "resurface_done":
      pressDone(cx, m);
      return;
    default: {
      // RESURFACE AT A CHOSEN INSTANT: the chooser feeds the day here.
      if (action.startsWith("resurface:")) {
        const when = action.slice("resurface:".length);
        resurfaceRow(
          cx,
          m.id,
          "bubbled_up",
          when,
          t("ohbox.toastResurface", { when: resurfaceLabel(when, nowAt()) }),
        );
        return;
      }
      pressMove(cx, action.slice("move:".length) as OhmailView, m, moveSubject);
    }
  }
}
