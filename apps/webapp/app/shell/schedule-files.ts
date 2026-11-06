import { useEffect, useState } from "react";
import type { EngineDraft, OhmailEngine } from "@ohmail/client-engine";

/** One answer per engine, once one came: a door does not change what it keeps while it runs. */
const said = new WeakMap<OhmailEngine, boolean>();

/**
 * DOES THIS DOOR KEEP A LETTER'S FILES FOR SEND LATER (`/hello` `features.scheduleFiles`, mail 0179)?
 * Asked only while `asking` (files are attached, or the picker is open); `null` until an answer
 * comes, and on a door that cannot say. `true` is the desktop's own engine; Cloud says `false`.
 */
export function useScheduleFiles(engine: OhmailEngine, asking: boolean): boolean | null {
  const [answer, setAnswer] = useState<boolean | null>(() => said.get(engine) ?? null);
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
