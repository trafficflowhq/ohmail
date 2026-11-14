/**
 * WHAT THIS DEVICE'S COPY SAYS NOW, AS THE GATE COMPARES IT. Read from the letters and drafts the
 * copy holds, and nothing of them leaves here but how many and which ids: the counts are the rail's
 * own, so a notice and the number beside the Ohbox never disagree.
 */
import { ohboxUnreadIds } from "../ohbox-rows.js";
import { ohboxView, resurfacedThreads, screenerSegments } from "../selectors.js";
import type { EntityReader } from "../store.js";
import type { EngineDraft } from "../types.js";
import type { NoticeSample, SendStanding } from "./gate.js";

/** Where an unsent draft stands. Only a send with an appointment waits; one handed back with its failure went wrong. */
function standingOf(draft: Pick<EngineDraft, "status" | "sendError">): SendStanding {
  if (draft.status === "scheduled") return "waiting";
  return typeof draft.sendError === "string" && draft.sendError !== "" ? "failed" : "draft";
}

/**
 * The sample of `reader`. `devices` is handed in: the copy holds no record of the account's
 * devices, and a surface that is not told hands `null`.
 */
export function noticeSampleOf(reader: EntityReader, devices: number | null = null): NoticeSample {
  const sends = new Map<string, SendStanding>();
  for (const draft of reader.list<EngineDraft>("draft")) {
    if (draft.status !== "sent") sends.set(draft.id, standingOf(draft));
  }
  return {
    ohboxUnread: ohboxUnreadIds(resurfacedThreads(reader), ohboxView(reader)).length,
    screenerWaiting: screenerSegments(reader).waitingTotal,
    sends,
    devices,
  };
}
