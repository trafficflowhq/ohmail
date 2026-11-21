/** Screen the senders named by the selected letters. */
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { FOLDER_OF_VIEW, landingOfMoves, pressGained } from "@ohmail/client-engine";
import { readerMoveRefusal } from "../mail-state/mail-state.js";
import { PLACE_LABEL } from "../text/format.js";
import { shellConsentOptions } from "./consent-options.js";
import { screeningShown } from "./press-verdict.js";
import {
  movesAtLanding,
  planScreeningChange,
  senderScreening,
  type ScreeningDest,
  type ScreeningPlan,
} from "./sender-screening.js";
import { mailboxesOf, setRead, type VerbContext } from "./verb-context.js";

export interface BulkScreeningPlan {
  senders: number;
  messages: number;
  rules: number;
  mutations: EngineMutation[];
  subject: EngineMessage[];
}

/** Count every eligible letter from the selected senders before confirming the move. */
export function planBulkScreening(cx: VerbContext, ids: string[], dest: ScreeningDest): BulkScreeningPlan {
  const seen = new Set<string>();
  const plans: EngineMutation[] = [];
  const subject: EngineMessage[] = [];
  let senders = 0;
  let messages = 0;
  let rules = 0;
  const read = setRead(cx);
  const planned: ScreeningPlan[] = [];
  for (const id of ids) {
    const s = senderScreening(read, id);
    if (!s || seen.has(s.key)) continue;
    seen.add(s.key);
    planned.push(planScreeningChange(s, dest, "sender", false));
    subject.push(...s.scopes.sender.messages);
  }
  /* THE MOVES THE LISTS WILL SHOW AT THE PLACE (`movesAtLanding`), over ONE partition for the whole selection; the
     demo's lists are not partitioned, so every candidate lands there. */
  const wanted = FOLDER_OF_VIEW[dest];
  const landing =
    cx.demo || !wanted
      ? null
      : landingOfMoves(
          read,
          shellConsentOptions(cx.consent, cx.nowAt(), cx.ownAddresses, cx.firstImportDoneAt),
          planned.flatMap((p) => p.outOfPlace),
          wanted,
        );
  const forecast = landing === null ? null : { keep: { landing }, remove: { landing } };
  for (const plan of planned) {
    const moves = movesAtLanding(plan, forecast);
    if (plan.mutations.length === 0 && moves.length === 0) continue;
    senders++;
    messages += plan.moved + moves.length;
    if (plan.rule) rules++;
    plans.push(...plan.mutations, ...moves);
  }
  return { senders, messages, rules, mutations: plans, subject };
}

/**
 * Commit the screening. SCREENING A SET IS FILING IT, so it answers a reader install the way every other filing verb
 * does: at the press, once, with nothing dispatched and the selection kept (`false`).
 */
export function screenBulk(cx: VerbContext, ids: string[], dest: ScreeningDest): boolean {
  const { engine, t } = cx;
  const refused = readerMoveRefusal(cx.press.rosterRef.current, mailboxesOf(cx, ids), cx.press.refusalCopy);
  if (refused !== null) {
    cx.toast(refused);
    return false;
  }
  const plan = planBulkScreening(cx, ids, dest);
  const moves = plan.mutations.flatMap((mutation) => (mutation.kind === "move" ? [mutation.messageId] : []));
  if (moves.length > 0) {
    const moveRefusal = readerMoveRefusal(
      cx.press.rosterRef.current,
      mailboxesOf(cx, moves),
      cx.press.refusalCopy,
    );
    if (moveRefusal !== null) {
      cx.toast(moveRefusal);
      return false;
    }
  }
  const place = PLACE_LABEL[dest] ?? dest;
  if (plan.mutations.length === 0) {
    cx.toast(t("screening.toastBulkNothing", { place }));
    return true;
  }
  // The count said after is what the lists gained there, read before the press and at the answer.
  const facts = {
    consent: cx.demo ? null : cx.consent,
    now: cx.nowAt(),
    ownAddresses: cx.ownAddresses,
    firstImportDoneAt: cx.firstImportDoneAt,
  };
  const before = screeningShown(engine.verbRead(), plan.subject, dest, facts);
  const gained = () => pressGained(before, screeningShown(engine.verbRead(), plan.subject, dest, facts));
  void cx.press.mutateSetAndReport(plan.mutations, () =>
    plan.rules > 0
      ? t("screening.toastBulkRuled", { place, senders: plan.senders, count: gained(), rules: plan.rules })
      : t("screening.toastBulkMoved", { place, senders: plan.senders, count: gained() }),
  );
  return true;
}
