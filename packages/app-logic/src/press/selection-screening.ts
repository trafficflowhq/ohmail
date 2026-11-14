/**
 * SCREENING A SELECTION: grouped by SENDER, because that is what screening is about. A selection routinely mixes two
 * cases: a sender still WAITING is decided through the Screener's own door, which promotes a rule that governs all
 * their future mail; a sender whose mail has left the Screener is a composition of moves with no lasting effect. So
 * the plan returns the counts SEPARATELY and the surface states them before committing.
 */
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

/**
 * `planScreeningChange` per sender, never a bulk shortcut: forty senders decided through a path that skips the
 * Screener's decision would fork the consent record. THE COUNT IS DELIBERATE: the plan moves every message the
 * mirror holds from that sender, not only the ones that were picked. That IS what screening a sender means, and it
 * is why the number has to be on screen before the button commits.
 */
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
    /* `makeRule: false`, EXPLICITLY. The single sender's sheet makes a rule by default; a selection does not: its
       confirmation promises that no rule is made, and counts only the senders the SCREENER will rule on. */
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
  const place = PLACE_LABEL[dest] ?? dest;
  if (plan.mutations.length === 0) {
    cx.toast(t("screening.toastBulkNothing", { place }));
    return true;
  }
  // The count said after is what the lists gained there, read before and at the answer.
  const facts = {
    consent: cx.demo ? null : cx.consent,
    now: cx.nowAt(),
    ownAddresses: cx.ownAddresses,
    firstImportDoneAt: cx.firstImportDoneAt,
  };
  const before = screeningShown(engine.verbRead(), plan.subject, dest, facts);
  const gained = () => pressGained(before, screeningShown(engine.verbRead(), plan.subject, dest, facts));
  /* Two sentences because there are two outcomes, and the second one is permanent. Through the set seam: a plan
     where the service refused everything is a refusal, said once, rather than a count of senders nothing was
     decided about. */
  void cx.press.mutateSetAndReport(plan.mutations, () =>
    plan.rules > 0
      ? t("screening.toastBulkRuled", { place, senders: plan.senders, count: gained(), rules: plan.rules })
      : t("screening.toastBulkMoved", { place, senders: plan.senders, count: gained() }),
  );
  return true;
}
