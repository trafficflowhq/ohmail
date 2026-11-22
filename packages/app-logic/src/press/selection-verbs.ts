/**
 * THE SELECTION'S VERBS. The vocabulary is a letter's own (the same three horizons, the same filing verbs, the same
 * read state), each over a set, each saying ONE sentence at the end: a report per message over a selection of forty
 * is no feedback. Everything dispatches through the frame's one seam.
 *
 * Each answers whether the selection SURVIVES the press: `true` means dispatched (clear the pick), `false` means
 * refused at the press (keep it). A reader install moves nothing, and hears so here, before the wire, once: Read,
 * Unread, Tag and the three horizons are not folder moves and are never refused.
 */
import type { EngineMessage, EngineMutation, OhmailView } from "@ohmail/wire";
import {
  FOLDER_OF_VIEW,
  MARK_SEEN_CHUNK,
  chunkMarkSeen,
  inverseMutations,
  triageSubjectIds,
} from "@ohmail/client-engine";
import { readerMoveRefusal } from "../mail-state/mail-state.js";
import { dayStamp, PLACE_LABEL, resurfaceLabel, tomorrowAt } from "../text/format.js";
import type { BulkAction, BulkActionOptions } from "./actions.js";
import {
  decidesAtGate,
  fileThroughRouting,
  planMoveToPlace,
  type RoutingPressPlan,
} from "./move-to-place.js";
import { dispatchScreeningChange, moveSubjectIds } from "./sender-screening.js";
import { mailboxesOf, rowOf, setRead, type MoveContext, type VerbContext } from "./verb-context.js";

/**
 * A DELETE WAITS OUT ITS WINDOW, and the engine spends a filed pin's row when the delete is sent; the row is spent at
 * the press instead, so it leaves with the letter, and the window's Undo puts it back. Answers whether the press
 * acted: a reader's delete is refused by the window itself, in the seam's words.
 */
export function removeSpending(
  cx: VerbContext,
  targets: Array<{ id: string; mailboxId?: string | null | undefined }>,
): boolean {
  const { engine } = cx;
  const { fileAndRefresh, deleting } = cx.press;
  const spent = (cx.pinsSpentFor?.(targets.map((x) => x.id)) ?? []).map((messageId): EngineMutation => ({
    kind: "triage_set",
    messageId,
    state: "none",
  }));
  const pre = engine.verbRead();
  const back = spent.flatMap((mu) => inverseMutations(pre, mu));
  const acted = deleting.remove(
    targets,
    back.length === 0
      ? undefined
      : () => {
          for (const mu of back) void fileAndRefresh(engine.mutate(mu));
        },
  );
  if (acted) for (const mu of spent) void fileAndRefresh(engine.mutate(mu));
  return acted;
}

/**
 * Read or unread over a set: one request per 200 ids (the route's cap), one intent, and the sentence waits for every
 * chunk's verdict. The inverse is read ONCE before the first dispatch and chunked alike, so Undo flips back exactly
 * the ids this press flipped, and a press over the cap that partly lands offers an Undo for the chunks that landed.
 */
function markSet(cx: VerbContext, unread: boolean, ids: string[], via?: "glance"): boolean {
  const { t } = cx;
  const pre = setRead(cx);
  /* A folded row hands in every member: a read takes them all, and Mark unread leaves our own reply read beside its
     letter (own mail is ingested read). */
  const marked = unread ? triageSubjectIds(pre, ids) : ids;
  const chunks: string[][] = [];
  for (let i = 0; i < marked.length; i += MARK_SEEN_CHUNK) chunks.push(marked.slice(i, i + MARK_SEEN_CHUNK));
  const inverses = chunks.map((c) =>
    chunkMarkSeen(inverseMutations(pre, { kind: "mark_seen", messageIds: c, unread, via })),
  );
  void Promise.all(chunks.map((c) => cx.markSeen(c, unread, via))).then((oks) => {
    const done = chunks.filter((_, i) => oks[i]).reduce((n, c) => n + c.length, 0);
    if (done === 0) return;
    const undo = inverses.filter((_, i) => oks[i]).flat();
    cx.press.toastWithUndo(
      done === marked.length
        ? t(unread ? "ohbox.toastBulkUnread" : "ohbox.toastBulkRead", { count: marked.length })
        : t(unread ? "ohbox.toastBulkUnreadPartial" : "ohbox.toastBulkReadPartial", {
            done,
            count: marked.length,
          }),
      undo,
    );
  });
  return true;
}

/**
 * THE CONVERSATION'S RELEASE: the row's Done, over every member carrying a pin. Two halves in order: the BOOKINGS go
 * first (a read left under a schedule is a message read out of a pile it is still in), then ONE deliberate read
 * over the whole set spends the pins. A refused clear stops the read: half a release is worse than none.
 */
function releaseSet(cx: VerbContext, ids: string[]): boolean {
  const rows = ids.map((id) => rowOf(cx, id)).filter((m): m is EngineMessage => m != null);
  const booked = rows.filter((m) => m.triage?.state === "bubbled_up").map((m) => m.id);
  void (async () => {
    /* Both halves' inverses off the pre-press mirror, so one Undo re-books the booked and re-pins the pinned. */
    const pre = setRead(cx);
    const inverses = [
      ...inverseMutations(pre, { kind: "mark_seen", messageIds: ids, unread: false }),
      ...booked.flatMap((messageId) =>
        inverseMutations(pre, { kind: "triage_set", messageId, state: "none" }),
      ),
    ];
    if (booked.length > 0) {
      // A clear queued to be sent again stands, as the single arm's does: the read follows it.
      const stood = await cx.press.mutateSetAndReport(
        booked.map((messageId) => ({ kind: "triage_set" as const, messageId, state: "none" as const })),
        () => null,
      );
      if (stood === 0) return;
    }
    if (await cx.markSeen(ids, false)) {
      // The conversation's newest member names the slot: the date its row wears.
      const newest = rows.reduce<string | null>(
        (best, r) => (r.date && (!best || r.date > best) ? r.date : best),
        null,
      );
      cx.press.toastWithUndo(cx.t("ohbox.toastResurfaceDone", { when: dayStamp(newest) }), inverses);
    }
  })();
  return true;
}

/** Answer later, Park and Resurface over a set: each row whole in the Ohbox (our reply too), else the letter alone. */
function pileSet(cx: VerbContext, action: "later" | "aside" | "resurface", ids: string[]): boolean {
  const { t, nowAt, pileSetFor } = cx;
  const state = action === "later" ? "reply_later" : action === "aside" ? "set_aside" : "bubbled_up";
  // The same default the single-message verb uses: the picker's first dated preset, at the account's own hour.
  const when = action === "resurface" ? tomorrowAt(nowAt(), cx.consent.resurfaceTime, cx.zone).iso : null;
  const subjects =
    !cx.offOhbox && pileSetFor
      ? [...new Set(ids.flatMap((id) => pileSetFor(id, true)))]
      : triageSubjectIds(setRead(cx), ids);
  void cx.press.mutateSetAndReport(
    subjects.map((messageId) => ({
      kind: "triage_set" as const,
      messageId,
      state,
      ...(when ? { bubbleUpAt: when } : {}),
    })),
    (applied) =>
      action === "resurface"
        ? t("ohbox.toastBulkResurface", { count: applied, when: resurfaceLabel(when!, nowAt(), cx.zone) })
        : t(action === "later" ? "ohbox.toastBulkLater" : "ohbox.toastBulkAside", { count: applied }),
  );
  return true;
}

/**
 * THE GATE'S OWN SENDERS KEEP THE PATH THEY HAVE ALWAYS TAKEN (`fileThroughRouting` says why a decision may not be
 * held): dispatched and awaited, ONE sentence when every one of them has answered, and the two counts are what
 * APPLIED, never what was picked. The rest speak at the press, because their rules have not been sent: the counts
 * are what this press NAMED, and the window corrects the sentence per sender when it closes.
 */
function fileSenders(
  cx: MoveContext,
  view: OhmailView,
  plans: readonly RoutingPressPlan[],
  place: string,
): void {
  const { engine, t } = cx;
  const decided = plans.filter((p) => decidesAtGate(p.plan));
  const held = plans.filter((p) => !decidesAtGate(p.plan));
  if (decided.length > 0) {
    void Promise.all(
      decided.map((p) =>
        dispatchScreeningChange(p.plan, p.moves, (mu) => cx.press.fileAndRefresh(engine.mutate(mu))).then(
          (key) => ({ key, moved: p.plan.moved }),
        ),
      ),
    ).then((answers) => {
      const done = answers.filter((a) => a.key !== "toastRuleFailed" && a.key !== "toastDecideRefused");
      const moved = done.reduce((n, a) => n + a.moved, 0);
      cx.toast(
        done.length === 0
          ? t("ohbox.toastBulkMoveFailed")
          : t("ohbox.toastBulkMovedSenders", { count: moved, place }),
      );
    });
  }
  if (held.length > 0) {
    fileThroughRouting(cx, {
      plans: held,
      view,
      sentence: t("ohbox.toastBulkMovedSenders", {
        count: held.reduce((n, p) => n + p.plan.moved, 0),
        place,
      }),
      undone: t("screening.toastRoutingUndone"),
    });
  }
}

/**
 * `move:<view>` over a set: THE SAME VERB THE SINGLE ROW USES, once per sender. It writes the ROUTING
 * (`planMoveToPlace` per sender, narrowed to that sender's picked messages) and names both numbers, because a
 * selection spanning senders changes where mail from every one of them goes from now on.
 */
function moveSet(cx: MoveContext, view: OhmailView, ids: string[], gate: "decide" | "leave"): boolean {
  const { engine, t } = cx;
  /* The destination has to BE one: the single arm's own guard, asked here too. */
  const wanted = FOLDER_OF_VIEW[view];
  if (!wanted) return false;
  const bySender = new Map<string, string[]>();
  const unheld: EngineMutation[] = [];
  for (const id of ids) {
    const m = rowOf(cx, id);
    /* A row neither the mirror nor a page holds is still moved, by id: the server answers. */
    if (!m) {
      unheld.push({ kind: "move", messageId: id, folder: wanted });
      continue;
    }
    const key = m.from.address.trim().toLowerCase();
    const held = bySender.get(key);
    if (held) held.push(id);
    else bySender.set(key, [id]);
  }
  const plans = [...bySender.values()]
    .map((of) => planMoveToPlace(cx, of[0]!, view, new Set(of), undefined, gate))
    .filter((x): x is RoutingPressPlan => x !== null);
  const place = PLACE_LABEL[view] ?? view;
  if (plans.length === 0) {
    void cx.press.mutateSetAndReport(unheld, (applied) =>
      t("ohbox.toastBulkMovedPlain", { count: applied, place }),
    );
    return true;
  }
  for (const mu of unheld) void cx.press.fileAndRefresh(engine.mutate(mu));
  fileSenders(cx, view, plans, place);
  return true;
}

/** Run a verb over the ids. `false`: refused at the press, nothing dispatched, the selection is kept. */
export function runBulkAction(
  cx: VerbContext,
  action: BulkAction,
  ids: string[],
  options?: BulkActionOptions,
): boolean {
  if (ids.length === 0) return false;
  if (action === "delete") {
    /* ONE WINDOW, ONE REPORT, ONE UNDO FOR THE SET (`delete-undo.ts`, keyed by press). The reader's refusal is the
       window's own, resolved at the press, so this arm does not repeat it. */
    return removeSpending(
      cx,
      ids.map((id) => ({ id, mailboxId: rowOf(cx, id)?.mailboxId })),
    );
  }
  if (action === "read" || action === "unread") return markSet(cx, action === "unread", ids, options?.via);
  if (action === "done") return releaseSet(cx, ids);
  if (action === "later" || action === "aside" || action === "resurface") return pileSet(cx, action, ids);
  return pressMoveSet(cx, action.slice("move:".length) as OhmailView, ids, {
    conversationIds: options?.conversationIds,
  });
}

export function pressMoveSet(
  cx: MoveContext,
  view: OhmailView,
  pickedIds: string[],
  selection?: { conversationIds?: ReadonlySet<string> },
): boolean {
  // A single-message row supplies its own id. Only folded rows can move their conversation's other letters.
  const read = setRead(cx);
  const ids = [
    ...new Set(
      pickedIds.flatMap((id) =>
        selection?.conversationIds?.has(id) ? moveSubjectIds(read, id, cx.ownAddresses) : [id],
      ),
    ),
  ];
  /* A READER MOVES NOTHING, and hears so before anything leaves: asked of EVERY mailbox this selection spans,
     through the three-state roster. The WHOLE press is refused. */
  const refused = readerMoveRefusal(
    cx.press.rosterRef.current,
    mailboxesOf(cx, [...pickedIds, ...ids]),
    cx.press.refusalCopy,
  );
  if (refused !== null) {
    cx.toast(refused);
    return false;
  }
  // The single-row path may still decide a sender at the gate. A selection only names letters.
  return moveSet(cx, view, ids, selection === undefined ? "decide" : "leave");
}
