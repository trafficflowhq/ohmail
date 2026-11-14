import type { RuleWords } from "./rule-management.js";
import { useMemo } from "react";
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import type { WaitingOnOrganizerView, QueuedRuleWrite } from "@ohmail/client-engine";
import { displayRuleMatch } from "../text/idn.js";
import { placeLabel } from "../text/format.js";
import { actingRules, outrankOf, sharedProviderInert, twinsDiffer, waitingByRow } from "./rules-standing.js";
import { ruleDate, ruleSentence } from "./rule-list.js";

export function useRuleDescriptions(
  allRules: readonly RuleDTO[],
  waiting: readonly WaitingOnOrganizerView[],
  queued: readonly QueuedRuleWrite[],
  published: boolean,
  t: RuleWords,
  mailboxLabel?: (id: string) => string | null,
) {
  const { shown: rules, copies, others } = useMemo(() => actingRules(allRules), [allRules]);
  const { onRow, apart } = useMemo(() => waitingByRow(waiting, rules, allRules), [waiting, rules, allRules]);
  const queuedOn = useMemo(() => new Map(queued.map((q) => [q.ruleId, q])), [queued]);
  const whatOf = (rule: RuleDTO) => ruleSentence(rule, t);
  /** The holder's name, or the words for an unnamed one. */
  const holderOf = (w: WaitingOnOrganizerView): string => w.holder.name ?? t("theOrganizer");
  /** What a request said and where it stands, in one line — null for a row nothing waits on. */
  const waitingLine = (w: WaitingOnOrganizerView | undefined, onARow = false): string | null => {
    if (!w) return null;
    const holder = holderOf(w);
    if (w.state === "refused") {
      return w.refusedReason === "no_such_rule"
        ? t("refusedGone", { holder })
        : t("refusedOther", { holder });
    }
    const date = ruleDate(w.decidedAt);
    const dest = (w.target as { destination?: string }).destination;
    // On the organizer's list a create riding a row it already has is a change to that row.
    const create = w.kind === "rule.create" && !(published && onARow);
    const said =
      w.kind === "rule.delete"
        ? t("waitingRemoval", { holder, date })
        : dest
          ? t(create ? "waitingCreate" : "waitingChange", { holder, place: placeLabel(dest), date })
          : t("waitingRemoval", { holder, date });
    return w.slow ? `${said} ${t("waitingSlow", { holder })}` : said;
  };
  /** A request about a rule this page does not list: removed here, or not yet made there. */
  const apartLine = (w: WaitingOnOrganizerView): { what: string; line: string } => {
    const r = (
      w.target as {
        rule?: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null };
      }
    ).rule;
    const what = r
      ? whatOf({
          kind: r.kind,
          match: r.match,
          subjectContains: r.subjectContains,
          bodyContains: r.bodyContains,
        } as RuleDTO)
      : t("theOrganizer");
    // On the organizer's list a removal with no row is still waiting there, not done here.
    if (w.state !== "refused" && w.kind === "rule.delete" && !published) {
      return {
        what,
        line: t("waitingRemovedHere", {
          holder: holderOf(w),
          mailbox: (w.mailboxId ? mailboxLabel?.(w.mailboxId) : null) ?? t("theMailbox"),
          date: ruleDate(w.decidedAt),
        }),
      };
    }
    return { what, line: waitingLine(w) ?? "" };
  };
  function factsOf(rule: RuleDTO) {
    const what = whatOf(rule);
    const origin = rule.byOhmail === true ? t("origin.byOhmail") : t(`origin.${rule.provenance}`);
    const meta = rule.enabled
      ? t("meta", { origin, date: ruleDate(rule.createdAt) })
      : t("metaPaused", { origin, date: ruleDate(rule.createdAt) });
    const waits = waitingLine(onRow.get(rule.id), true);
    // A verb on this browser's queue: the row is the rule as it runs, and its controls wait with it.
    const q = queuedOn.get(rule.id);
    const queuedLine =
      q === undefined
        ? null
        : t(
            q.verb === "revoke"
              ? q.serverFailed
                ? "queuedRevokeFailing"
                : "queuedRevokeUnsent"
              : q.serverFailed
                ? "queuedRetargetFailing"
                : "queuedRetargetUnsent",
          );
    const rank = outrankOf(rule, allRules);
    const twins = copies.get(rule.id) ?? 0;
    const behind = others.get(rule.id) ?? [];
    const inert = sharedProviderInert(rule);
    // Twins filing elsewhere, or paused where this row runs, are rules of their own: named, not counted.
    const twinNote =
      twins === 0
        ? null
        : twinsDiffer(rule, behind)
          ? t("otherTwins", {
              count: behind.length,
              list: behind
                .map((o) => t(o.enabled ? "twinPlace" : "twinPaused", { place: placeLabel(o.destination) }))
                .join("; "),
            })
          : t("copies", { count: twins });
    return { what, meta, waits, q, queuedLine, rank, inert, twinNote, twins };
  }
  return { rules, apart, queuedOn, apartLine, factsOf };
}
