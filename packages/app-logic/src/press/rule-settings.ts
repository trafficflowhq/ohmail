import { useMemo } from "react";
import {
  FOLDER_OF_VIEW,
  PROFILE_RULES_SENT_MAX,
  canonicalDestination,
  outrankCoveringDomains,
  pressRules,
  rulesShown,
  walkOwed,
} from "@ohmail/client-engine";
import type { Folder } from "@ohmail/wire";
import { atStamp, useDerivedVersion, useEngine } from "../engine/context.js";
import type { RulesPosture } from "./rules-posture.js";
import { ruleRetarget } from "./rule-past-mail.js";
import { SCREENING_DESTS } from "./sender-screening.js";

export { PROFILE_RULES_SENT_MAX, canonicalDestination, walkOwed };

export function ruleDestinationPile(folder: Folder) {
  return SCREENING_DESTS.find((dest) => FOLDER_OF_VIEW[dest] === canonicalDestination(folder));
}

export function useRuleSettings(posture: RulesPosture, nowAt: () => Date) {
  const engine = useEngine();
  const version = useDerivedVersion();
  const readerOnly = posture.mode !== "organizer";
  const data = useMemo(() => {
    const queued = engine.queuedRuleWrites();
    const shown = rulesShown(engine.read(), {
      readerOnly,
      queued,
      applied: engine.appliedRuleRequests(),
      now: nowAt(),
    });
    const waiting = engine.waitingOnOrganizer().filter((row) => row.kind.startsWith("rule."));
    return atStamp(version, { ...shown, queued, waiting });
  }, [engine, readerOnly, nowAt, version]);
  const travels = posture.mode === "pending";
  const planAtPress = () =>
    pressRules(engine.read(), {
      travels,
      queued: engine.queuedRuleWrites(),
      applied: engine.appliedRuleRequests(),
      unsettled: engine.unsettledRulePresses(),
      now: nowAt(),
    });
  function retarget(id: string, dest: Folder, refile: boolean | "walk") {
    const change = ruleRetarget(id, dest, refile);
    return engine.mutate(travels ? outrankCoveringDomains(planAtPress(), change) : change);
  }
  return { data, planAtPress, retarget };
}
