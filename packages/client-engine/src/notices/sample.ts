/**
 * WHAT THIS DEVICE'S COPY SAYS NOW, AS THE GATE COMPARES IT. Read from the letters and drafts the
 * copy holds, and nothing of them leaves here but how many and which ids: the counts are the rail's
 * own, so a notice and the number beside the Ohbox never disagree.
 */
import type { EngineDraft } from "@ohmail/wire";
import { ohboxUnreadIds } from "../ohbox-rows.js";
import { ohboxView, resurfacedThreads, screenerSegments } from "../selectors.js";
import type { EntityReader } from "../store.js";
import type { CalendarSample, NoticeDevices, NoticeSample, SendStanding } from "./gate.js";

/** Where an unsent draft stands. Only a send with an appointment waits; one handed back with its failure went wrong. */
function standingOf(draft: Pick<EngineDraft, "status" | "sendError">): SendStanding {
  if (draft.status === "scheduled") return "waiting";
  return typeof draft.sendError === "string" && draft.sendError !== "" ? "failed" : "draft";
}

/** A whole number from nothing upwards, as a count is: no string, no fraction, nothing negative. */
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * THE ACCOUNT'S NAMED DEVICES, READ CLOSED from the copy's one settings record: its own three
 * members `devicesMade`, `devicesRevoked` and `devices`, each a whole number, or `null`. Null for
 * anything else: no settings record yet or more than one, a record that is no object, a member
 * missing or only inherited, a string or a fraction where a number belongs (an older server sends
 * none of the three). All three or nothing, built new: no other member of the record is read, and
 * nothing of a device but these numbers can come out of here.
 */
export function devicesOf(reader: EntityReader): NoticeDevices | null {
  const records = reader.list<unknown>("settings");
  if (records.length !== 1) return null;
  const record = records[0];
  if (typeof record !== "object" || record === null) return null;
  const own = (name: string): unknown => (Object.hasOwn(record, name) ? (record as Record<string, unknown>)[name] : undefined);
  const made = own("devicesMade");
  const revoked = own("devicesRevoked");
  const live = own("devices");
  return count(made) && count(revoked) && count(live) ? { made, revoked, live } : null;
}

/**
 * The sample of `reader`. `devices` is handed in by the surface, from its engine's own copy
 * ({@link devicesOf}): the copy a surface presents is not always the one that holds the settings
 * record, and a surface that is not told hands `null`. So is `calendar`, the calendar's sample as
 * the page reads it on the reader's clock (`calendarSampleOf`); a surface with no calendar hands `null`.
 */
export function noticeSampleOf(
  reader: EntityReader, devices: NoticeDevices | null = null, calendar: CalendarSample | null = null,
): NoticeSample {
  const sends = new Map<string, SendStanding>();
  for (const draft of reader.list<EngineDraft>("draft")) {
    if (draft.status !== "sent") sends.set(draft.id, standingOf(draft));
  }
  return {
    ohboxUnread: ohboxUnreadIds(resurfacedThreads(reader), ohboxView(reader)).length,
    screenerWaiting: screenerSegments(reader).waitingTotal,
    sends,
    devices,
    calendar,
  };
}

/**
 * THE NAME A DEVICE KEEPS THE NUMBERS IT HAS TOLD OF AN ACCOUNT'S DEVICES UNDER, the account's scope
 * after it (`app-logic/src/notices/told-devices.ts` reads and writes it). Here, beside the reader of
 * the numbers it is compared with, so every surface's sweep names it from the engine, as it names the
 * routing intents'.
 */
export const TOLD_DEVICES_PREFIX = "ohmail.notices.devices.told.";
