import { useSyncExternalStore } from "react";
import {
  DEFAULT_CHANNELS,
  noticeChoicesOf,
  type CalendarNoticeKind,
  type NoticeChoices,
  type NoticePermission,
  type NotificationChannels,
} from "@ohmail/client-engine";
import { scopeMayMount } from "../storage/scope.js";
import { isDemoOwned } from "../storage/storage-owner.js";
import { localStorageDoor, type DurableWrite } from "../storage/durable.js";

export { channelsAreLive, DEFAULT_CHANNELS } from "@ohmail/client-engine";

/** One key, one JSON object — so a partial write cannot leave two switches disagreeing. */
export const NOTIFICATION_CHANNELS_KEY = "ohmail.notifications.channels";
const preferences = localStorageDoor("notifications.channels");

/** Legacy install-wide records did not identify who wrote them. They stay at their original keys. */
function preferenceKey(base: string, scope: string | null): string | null {
  return scopeMayMount(scope) && !isDemoOwned(scope) ? `${base}.${scope}` : null;
}

/**
 * Read this account's switches on this install, falling back to {@link DEFAULT_CHANNELS}.
 * A failed read reads as the DEFAULTS — not off, not on: the defaults are
 * what a fresh install believes, so a browser with storage blocked behaves
 * like a fresh install rather than like an account that turned everything
 * off (which silently disables a feature the user enabled, with nothing on
 * screen to explain it). Unknown keys are dropped and missing ones
 * defaulted field by field: a newer build's catalogue must not make an
 * older one throw, and a boolean that is not a boolean is not a preference.
 */
export function readChannels(scope: string | null): NotificationChannels {
  const key = preferenceKey(NOTIFICATION_CHANNELS_KEY, scope);
  const raw = key === null ? null : preferences.get(key);
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
export function writeChannels(next: NotificationChannels, scope: string | null): DurableWrite {
  const key = preferenceKey(NOTIFICATION_CHANNELS_KEY, scope);
  if (key === null) return "lost";
  const record = storedBeside(key);
  for (const k of Object.keys(DEFAULT_CHANNELS) as (keyof NotificationChannels)[]) record[k] = next[k];
  // The in-memory value still drives this session; the refusal is no longer silent.
  const written = preferences.set(key, JSON.stringify(record));
  choicesWritten();
  return written;
}

/**
 * The calendar's record of this device's notice choices: its kinds, whether a notice or a widget shows an event's
 * title, when the day's summary rings. Read whole and handed to `noticeChoicesOf`, which reads it member by member.
 */
export const CALENDAR_NOTICES_KEY = "ohmail.notices.calendar";

/** The calendar's stored record as it stands, or `null` where none is stored or it cannot be read: the start values hold. */
export function readCalendarNotices(scope: string | null): unknown {
  const key = preferenceKey(CALENDAR_NOTICES_KEY, scope);
  if (key === null) return null;
  try {
    const raw = preferences.get(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeCalendarNotice(
  key: CalendarNoticeKind | "showTitles",
  value: boolean,
  scope: string | null,
): DurableWrite {
  const storageKey = preferenceKey(CALENDAR_NOTICES_KEY, scope);
  if (storageKey === null) return "lost";
  const held = readCalendarNotices(scope);
  const record = typeof held === "object" && held !== null && !Array.isArray(held) ? held : {};
  const written = preferences.set(storageKey, JSON.stringify({ ...record, [key]: value }));
  choicesWritten();
  return written;
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
  if (
    event.key === null ||
    event.key.startsWith(`${NOTIFICATION_CHANNELS_KEY}.`) ||
    event.key.startsWith(`${CALENDAR_NOTICES_KEY}.`)
  )
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
function storedBeside(key: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(preferences.get(key) ?? "null");
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
export const storedNoticeChoices = (scope: string | null): NoticeChoices =>
  noticeChoicesOf(readChannels(scope), readCalendarNotices(scope), { ohcalPhone: false });

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
