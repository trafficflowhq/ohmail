import { useSyncExternalStore } from "react";
import {
  DEFAULT_CHANNELS,
  noticeChoicesOf,
  type NoticeChoices,
  type NoticePermission,
  type NotificationChannels,
} from "@ohmail/client-engine";
import { localStorageDoor, type DurableWrite } from "../storage/durable.js";

export { channelsAreLive, DEFAULT_CHANNELS } from "@ohmail/client-engine";

/** One key, one JSON object — so a partial write cannot leave two switches disagreeing. */
export const NOTIFICATION_CHANNELS_KEY = "ohmail.notifications.channels";
const preferences = localStorageDoor("notifications.channels");

/**
 * Read this install's switches, falling back to {@link DEFAULT_CHANNELS}.
 * A failed read reads as the DEFAULTS — not off, not on: the defaults are
 * what a fresh install believes, so a browser with storage blocked behaves
 * like a fresh install rather than like an account that turned everything
 * off (which silently disables a feature the user enabled, with nothing on
 * screen to explain it). Unknown keys are dropped and missing ones
 * defaulted field by field: a newer build's catalogue must not make an
 * older one throw, and a boolean that is not a boolean is not a preference.
 */
export function readChannels(): NotificationChannels {
  const raw = preferences.get(NOTIFICATION_CHANNELS_KEY);
  if (raw === null) return { ...DEFAULT_CHANNELS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CHANNELS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CHANNELS };
  const src = parsed as Record<string, unknown>;
  const out = { ...DEFAULT_CHANNELS };
  for (const k of Object.keys(DEFAULT_CHANNELS) as (keyof NotificationChannels)[]) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

/**
 * Write them. Best-effort by construction: a blocked store is not a reason to refuse the press,
 * because the switch still governs this session and the pane still reads back what it holds.
 */
export function writeChannels(next: NotificationChannels): DurableWrite {
  const record: Record<string, unknown> = { ...storedBeside() };
  for (const k of Object.keys(DEFAULT_CHANNELS) as (keyof NotificationChannels)[]) record[k] = next[k];
  // The in-memory value still drives this session; the refusal is no longer silent.
  const written = preferences.set(NOTIFICATION_CHANNELS_KEY, JSON.stringify(record));
  choicesWritten();
  return written;
}

/**
 * The calendar's record of this device's notice choices: its kinds, whether a notice or a widget shows an event's
 * title, when the day's summary rings. Read whole and handed to `noticeChoicesOf`, which reads it member by member.
 */
export const CALENDAR_NOTICES_KEY = "ohmail.notices.calendar";

/** The calendar's stored record as it stands, or `null` where none is stored or it cannot be read: the start values hold. */
export function readCalendarNotices(): unknown {
  try {
    const raw = preferences.get(CALENDAR_NOTICES_KEY);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/*
 * WHEN THIS DEVICE'S CHOICES ARE WRITTEN. The notices' caller reads the choices at each settle of the copy; a switch
 * pressed with no mail moving must reach it at once too, or an alert a surface already holds would ring until the next
 * settle. Moved by a press here and by another tab's write of either record.
 */
let choicesStamp = 0;
const choicesHeard = new Set<() => void>();
function choicesWritten(): void {
  choicesStamp += 1;
  for (const heard of [...choicesHeard]) heard();
}
function choicesStored(event: StorageEvent): void {
  if (event.key === null || event.key === NOTIFICATION_CHANNELS_KEY || event.key === CALENDAR_NOTICES_KEY)
    choicesWritten();
}
function hearChoices(heard: () => void): () => void {
  if (choicesHeard.size === 0) globalThis.addEventListener?.("storage", choicesStored);
  choicesHeard.add(heard);
  return () => {
    choicesHeard.delete(heard);
    if (choicesHeard.size === 0) globalThis.removeEventListener?.("storage", choicesStored);
  };
}
const choicesNow = (): number => choicesStamp;
const choicesBeforeHydration = (): number => 0;
export const noticeChoicesVersion = { read: choicesNow, subscribe: hearChoices };

/** The version the notices' caller is handed: the copy's, moved again whenever this device's choices are written. */
export function useNoticesVersion(copy: number): number {
  return copy + useSyncExternalStore(hearChoices, choicesNow, choicesBeforeHydration);
}

/**
 * The members the stored record holds beside this build's own: an older install's switch, or a
 * newer build's. Kept as they are and read by nothing, so a write here never changes a record
 * another build of this device still reads.
 */
function storedBeside(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(preferences.get(NOTIFICATION_CHANNELS_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const beside: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed))
      if (!(k in DEFAULT_CHANNELS) && k !== "__proto__") beside[k] = v;
    return beside;
  } catch {
    return {};
  }
}

/**
 * THIS INSTALL'S SWITCHES AS THE NOTICES' GATE READS THEM: {@link readChannels} at every call, so a switch pressed a
 * moment ago counts at the next settle. The calendar's record belongs to this same device.
 */
export const storedNoticeChoices = (): NoticeChoices =>
  noticeChoicesOf(readChannels(), readCalendarNotices(), { ohcalPhone: false });

/**
 * Should this browser have a push subscription at all? Pure, and separated from every call it
 * drives, because it is the whole policy. A subscription exists only to wake a browser that is
 * CLOSED: while a window is open the app syncs on its own and applies every per-event switch with
 * the mirror in front of it. So the question is "is there something worth starting this browser
 * up for", and the only such event is new mail — turning NEW MAIL off drops the subscription
 * while the other switches keep working for an open window (stated in the pane). Happy
 * consequence: "fully off" needs no cooperation from the push service — no subscription, nothing
 * to dial, nothing delivered-then-discarded.
 */
export function subscriptionWanted(channels: NotificationChannels, permission: NoticePermission): boolean {
  return permission === "granted" && channels.master && channels.ohbox;
}
