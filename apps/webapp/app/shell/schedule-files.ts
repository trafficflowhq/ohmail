import { useEffect, useState } from "react";
import type { EngineDraft, OhmailEngine, ScheduleFilesAnswer } from "@ohmail/client-engine";

/** One answer per engine, once one came: a door does not change what it keeps while it runs. */
const said = new WeakMap<OhmailEngine, ScheduleFilesAnswer>();

/**
 * DOES THIS DOOR KEEP A LETTER'S FILES FOR SEND LATER, AND HOW FAR AHEAD (`/hello`, mail 0179, 0180)?
 * Asked only while `asking` (files are attached, or the picker is open); `null` until an answer
 * comes, and on a door that cannot say. The desktop's own engine keeps them with no horizon of its
 * own; a server that keeps them names its days; an older server keeps none.
 */
export function useScheduleFiles(engine: OhmailEngine, asking: boolean): ScheduleFilesAnswer | null {
  const [answer, setAnswer] = useState<ScheduleFilesAnswer | null>(() => said.get(engine) ?? null);
  useEffect(() => {
    if (!asking || answer !== null || typeof engine.scheduleFilesAnnounced !== "function") return undefined;
    let live = true;
    void engine.scheduleFilesAnnounced().then((v) => {
      if (v !== null) said.set(engine, v);
      if (live) setAnswer(v);
    }, () => undefined);
    return () => { live = false; };
  }, [engine, asking, answer]);
  return answer;
}

/**
 * How many files the composer's row was scheduled with and did not keep (mail 0179): a plain draft
 * again whose `sendFiles` stayed as the mark. `null` when there is no such row.
 */
export function filesNotKeptFor(drafts: readonly EngineDraft[], rowId: string | null): number | null {
  const d = rowId === null ? undefined : drafts.find((x) => x.id === rowId);
  return d && d.status === "draft" && d.sendFiles ? d.sendFiles : null;
}
