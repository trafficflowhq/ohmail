import { useState } from "react";
import type { Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import {
  REFILE_UNDO_WINDOW_MS,
  pressVerdict,
  tallyVerdicts,
  walkOwed,
  type PressAnswer,
} from "@ohmail/client-engine";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { browserOffline, queuedSentence } from "./queued-sentence.js";
import { organizerRefusalOf, organizerRefusalSentence } from "./organizer-refusal.js";
import { postureRefusal, type RulesPosture } from "./rules-posture.js";
import type { ToastFn, ToastOptions } from "./report.js";
import { pileOf } from "./rule-past-mail.js";
export { pileOf, rulePastMail, ruleRetarget, walkedMailboxes } from "./rule-past-mail.js";
export type RuleWords = (key: string, values?: Record<string, string | number>) => string;

interface RuleActions {
  t: RuleWords;
  tWhy: RuleWords;
  toast: ToastFn;
  close?: () => void;
  posture?: RulesPosture;
  placeName: (folder: Folder) => string;
  pastMail: (rule: RuleDTO, destination: Folder | null) => number | null;
  onRevoke: (id: string) => Promise<PressAnswer>;
  onRetarget: (id: string, folder: Folder, refile: boolean | "walk") => Promise<PressAnswer>;
}

export function useRuleActions({
  t,
  tWhy,
  toast,
  close,
  posture,
  placeName,
  pastMail,
  onRevoke,
  onRetarget,
}: RuleActions) {
  const [refusal, setRefusal] = useState<{ lead: string; why: string | null } | null>(null);
  const whyOf = (err: Parameters<typeof organizerRefusalOf>[0]): string | null =>
    organizerRefusalSentence(organizerRefusalOf(err, { starting: posture?.mode === "starting" }), tWhy);
  /* A pane nothing here can act on says so BEFORE the press, and its controls are unavailable. */
  const lockedWhy = organizerRefusalSentence(postureRefusal(posture), tWhy);
  const report = ruleReporter(t, toast, whyOf, setRefusal);
  const revokeSaid = {
    queued: t("toastRevokeQueued"),
    failing: t("toastRevokeFailing"),
    unsent: t("toastRevokeUnsent"),
  };
  const retargetSaid = {
    queued: t("toastRetargetQueued"),
    failing: t("toastRetargetFailing"),
    unsent: t("toastRetargetUnsent"),
  };

  /**
   * A CHANGE DOES WHAT ITS SENTENCE SAYS. With the switch on it re-files the mail the rule filed in
   * its place (`pileOf`) and nothing else; off, it moves the rule alone. A walk the sender sheet
   * asked for and still owed (`walkOwed`) goes to the new place whole, and Undo asks for it again
   * where it was. The count is read before the press. A re-filing waits out the Undo window, so an
   * Undo ends it before anything moved, and puts back a re-filing that was still waiting.
   */
  const retarget = (rule: RuleDTO, folder: Folder, refile: boolean): void => {
    close?.();
    setRefusal(null);
    const back = canonicalDestination(rule.destination) as Folder;
    const pile = pileOf(rule);
    const from = placeName(pile);
    const place = placeName(folder);
    const walk = walkOwed(rule);
    const moved = refile ? pastMail(rule, folder) : null;
    const said = retargetSentence(t, { refile, walk, moved, place, from, folder, pile });
    // Undo restores a re-filing only where one was waiting before this press, from another place;
    // one under way names the rule's own place, and nothing waits there.
    const restore = refile && rule.retro?.from != null && pile !== back;
    const undo: ToastOptions = {
      action: t("undo"),
      duration: REFILE_UNDO_WINDOW_MS,
      onAction: () => {
        void onRetarget(rule.id, back, walk ? "walk" : restore).then((r) =>
          report(
            r,
            walk
              ? t("toastRetargetUndoneWalk", { place: placeName(back) })
              : restore
                ? t("toastRetargetUndoneRefile", { place: placeName(back), from })
                : t(refile ? "toastRetargetUndoneRetro" : "toastRetargetUndone", { place: placeName(back) }),
            retargetSaid,
            t("toastRetargetFailed"),
          ),
        );
      },
    };
    void onRetarget(rule.id, folder, refile).then((r) =>
      report(r, said, retargetSaid, t("toastRetargetFailed"), undo),
    );
  };

  /**
   * Bulk revoke fans the SAME per-rule mutation over the filtered set and then reports ONE toast
   * that is true of the whole batch. A batch is not confirmed unless every rule confirmed: a
   * single refusal makes it "revoked X of N, the rest are still in place", never a flat success,
   * because the rules that rolled back are exactly as present as before. Nothing refused and
   * something WAITING is its own sentence — those rules are still filing mail.
   */
  const runBulk = (ids: string[]): void => {
    close?.();
    const total = ids.length;
    setRefusal(null);
    void Promise.all(ids.map((id) => onRevoke(id))).then((results) => {
      const vs = results.map(pressVerdict);
      const tally = tallyVerdicts(vs);
      const why = whyOf(tally.firstRefusal);
      const waiting = vs.filter((v) => v.kind === "queued" && v.wait === "organizer").length;
      const failing = vs.filter((v) => v.kind === "queued" && v.failed === true).length;
      if (tally.refused === 0 && tally.applied === total) toast(t("bulkToastRevoked", { count: total }));
      else if (tally.refused === 0 && failing > 0)
        setRefusal({ lead: t("bulkToastFailing", { count: failing }), why: null });
      else if (tally.refused === 0 && waiting > 0) {
        toast(
          tally.holder ? t("toastRuleOrganizer", { name: tally.holder }) : t("toastRuleOrganizerUnknown"),
        );
      } else if (tally.refused === 0) toast(browserOffline() ? t("bulkToastQueued") : t("bulkToastUnsent"));
      else if (tally.applied > 0)
        setRefusal({ lead: t("bulkToastPartial", { ok: tally.applied, count: total }), why });
      else setRefusal({ lead: t("bulkToastFailed"), why });
    });
  };

  /** Let an outranked address rule decide again: the same place, lifted at the write (`enrich`). */
  const lift = (rule: RuleDTO): void => {
    setRefusal(null);
    void onRetarget(rule.id, canonicalDestination(rule.destination) as Folder, false).then((r) =>
      report(r, t("toastLifted"), retargetSaid, t("toastRetargetFailed")),
    );
  };
  function revoke(id: string) {
    close?.();
    setRefusal(null);
    void onRevoke(id).then((r) => report(r, t("toastRevoked"), revokeSaid, t("toastRevokeFailed")));
  }

  return { refusal, lockedWhy, retarget, runBulk, lift, revoke };
}

function ruleReporter(
  t: RuleActions["t"],
  toast: RuleActions["toast"],
  whyOf: (refusal: Parameters<typeof organizerRefusalOf>[0]) => string | null,
  setRefusal: (refusal: { lead: string; why: string | null }) => void,
) {
  return (
    res: PressAnswer,
    ok: string,
    said: { queued: string; failing: string; unsent: string },
    failed: string,
    undo?: ToastOptions,
  ): void => {
    const v = pressVerdict(res);
    // A newer press for this rule replaced this one: it owns the sentence.
    if (v.kind === "silent") return;
    if (v.kind === "refused") {
      setRefusal({ lead: failed, why: whyOf(v.refusal) });
      return;
    }
    if (v.kind === "queued") {
      /* THE WAITS ARE DIFFERENT SENTENCES (`queuedSentence`). An `organizer` request leaves the
         rule STILL FILING MAIL until that install's next pass. A server failure stays on the pane,
         as a refusal does: the rule is still in place. */
      const which = queuedSentence(v, browserOffline());
      if (which === "failing") {
        setRefusal({ lead: said.failing, why: null });
        return;
      }
      toast(
        which === "queued"
          ? said.queued
          : which === "unsent"
            ? said.unsent
            : v.holder
              ? t("toastRuleOrganizer", { name: v.holder })
              : t("toastRuleOrganizerUnknown"),
      );
      return;
    }
    toast(ok, undo);
  };
}

function retargetSentence(
  t: RuleActions["t"],
  {
    refile,
    walk,
    moved,
    place,
    from,
    folder,
    pile,
  }: {
    refile: boolean;
    walk: boolean;
    moved: number | null;
    place: string;
    from: string;
    folder: Folder;
    pile: Folder;
  },
): string {
  return !refile
    ? t("toastRetargeted", { place })
    : walk
      ? moved === null
        ? t("toastRetargetedWalkUncounted", { place, from })
        : moved === 0
          ? t("toastRetargetedWalkNone", { place, from })
          : t("toastRetargetedWalk", { place, count: moved, from })
      : moved === null
        ? t("toastRetargetedRetroUncounted", { place, from })
        : moved === 0
          ? t(
              canonicalDestination(folder) === pile
                ? "toastRetargetedRetroThere"
                : "toastRetargetedRetroNone",
              { place, from },
            )
          : t("toastRetargetedRetro", { place, count: moved, from });
}
