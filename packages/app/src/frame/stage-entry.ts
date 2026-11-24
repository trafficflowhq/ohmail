/**
 * WHICH STAGE STANDS OVER THE APP. A stage stands while the address names it, or while a part that lives for the
 * frame's life says it is owed (`useStageOwed`): the address is then left as it is, and the stage's body is drawn
 * with no stage named in its route, so it knows which of the two brought it. It leaves when neither holds.
 *
 * An address that names a stage wins over what is owed. Where more than one is owed, the order of the stages' list
 * (`STAGE_IDS`) decides. A stage the host does not hand is stood by nothing.
 */
import { NONE, type None } from "../host/contract.js";
import type { StageOwing } from "./commands.js";
import { STAGE_IDS, type CalendarEntry, type FrameHost, type Route, type StageEntry } from "./contract.js";
import { createFeed, useSignal, type Feed } from "./feeds.js";

/** The words of the parts that owe a stage, for one mounted frame: none at its start. */
export const owedFeed = (): Feed<readonly StageOwing[]> => createFeed<readonly StageOwing[]>([]);

/** The stage over the app now, or `none`: the one the address names, else the first one owed that the host hands. */
export function useStageEntry(
  host: FrameHost,
  route: Route,
  calendar: CalendarEntry | null,
  owed: Feed<readonly StageOwing[]>,
): StageEntry | None {
  const owing = useSignal(owed);
  const stages = host.features.stages;
  if (route.stage) return route.stage.id === "calSetup" ? (calendar?.stage ?? NONE) : stages[route.stage.id];
  for (const id of STAGE_IDS) {
    const entry = stages[id];
    if (entry !== NONE && owing.some((word) => word.id === id)) return entry;
  }
  return NONE;
}
