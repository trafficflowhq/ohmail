import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useText } from "../../text/index.js";
import type { NoticePermission, NotificationChannels } from "@ohmail/client-engine";
import {
  channelsAreLive,
  DEFAULT_CHANNELS,
  useNoticesVersion,
} from "@ohmail/app-logic/notices/browser-channels";
import { isDemoOwned } from "@ohmail/app-logic/storage/storage-owner";
import { NONE, type DeviceNotifications, type None } from "../../host/index.js";
import type { NotificationsModel } from "../notifications/index.js";
import type { DurableWrite } from "@ohmail/app-logic/storage/durable";
import type { PushSyncOutcome } from "../../host/device.js";

export interface NotificationPreferences {
  readChannels(scope: string | null): NotificationChannels;
  writeChannels(next: NotificationChannels, scope: string | null): DurableWrite;
  onReturn?: (refresh: () => void) => () => void;
  subscriptionWanted(channels: NotificationChannels, permission: NoticePermission): boolean;
  applyWakeIntent?: (
    door: DeviceNotifications,
    wanted: boolean,
    body: string,
    scope: string | null,
  ) => Promise<PushSyncOutcome | null>;
}

const CHANNEL_KEYS = Object.keys(DEFAULT_CHANNELS) as (keyof NotificationChannels)[];

function deliveryNote(outcome: PushSyncOutcome | null): NotificationsModel["delivery"] {
  if (
    outcome === "no_server_key" ||
    outcome === "row_remains" ||
    outcome === "not_registered" ||
    outcome === "unsupported"
  ) {
    return outcome;
  }
  return null;
}

/** One device's switches, its platform's answer, and the server's last word about waking this browser. */
export function useNotificationSettings(
  door: DeviceNotifications | None,
  scope: string | null,
  visible: boolean,
  { applyWakeIntent, onReturn, readChannels, subscriptionWanted, writeChannels }: NotificationPreferences,
): NotificationsModel {
  const t = useText("settings");
  const [channels, setChannels] = useState(() => readChannels(scope));
  const [permission, setPermission] = useState<NoticePermission>(() =>
    door === NONE ? "unsupported" : door.permission(),
  );
  const [delivery, setDelivery] = useState<NotificationsModel["delivery"]>(null);
  const lastDelivery = useRef<NotificationsModel["delivery"]>(null);
  const revision = useRef(0);
  const alive = useRef(false);
  // A failed store write still counts for this visit, until a newer stored preference appears.
  const unwritten = useRef<{
    scope: string | null;
    stored: NotificationChannels;
    channels: NotificationChannels;
  } | null>(null);
  const readCurrent = useCallback(() => {
    const stored = readChannels(scope);
    const local = unwritten.current;
    if (local?.scope === scope && CHANNEL_KEYS.every((key) => stored[key] === local.stored[key]))
      return local;
    unwritten.current = null;
    return { stored, channels: stored };
  }, [readChannels, scope]);
  const body = t("notifyClosedBody");
  const owns = useCallback(() => {
    if (door === NONE || scope === null || isDemoOwned(scope)) return false;
    return !door.liveNoticeScope || door.liveNoticeScope() === scope;
  }, [door, scope]);

  function showDelivery(outcome: PushSyncOutcome | null, at: number) {
    if (!alive.current || revision.current !== at || !owns()) return;
    const note = deliveryNote(outcome);
    if (note === lastDelivery.current) return;
    lastDelivery.current = note;
    setDelivery(note);
  }

  const enterPane = useStableCallback(() => {
    alive.current = true;
    const at = ++revision.current;
    if (applyWakeIntent && door !== NONE && owns()) {
      // A pane visit retries the stored intent. Only the bounded wake owner can arm the worker.
      const wanted = subscriptionWanted(readChannels(scope), door.permission());
      void applyWakeIntent(door, wanted, body, scope).then((outcome) => showDelivery(outcome, at));
    }
    return () => {
      alive.current = false;
      revision.current++;
    };
  });
  // The language can change without making another registration. A press uses the current words.
  useEffect(() => enterPane(), [door, scope, enterPane]);

  const preferenceVersion = useNoticesVersion(0);
  const refresh = useCallback(() => {
    if (door === NONE || !owns()) return;
    const next = readCurrent().channels;
    setChannels((current) => (CHANNEL_KEYS.every((key) => current[key] === next[key]) ? current : next));
    setPermission(door.permission());
  }, [door, owns, readCurrent]);
  useLayoutEffect(() => refresh(), [refresh, preferenceVersion, visible]);

  useEffect(() => onReturn?.(refresh), [onReturn, refresh]);

  function write(update: (current: NotificationChannels) => NotificationChannels, at: NoticePermission) {
    if (door === NONE || !alive.current || !owns()) return;
    const { stored, channels: current } = readCurrent();
    const next = update(current);
    setChannels(next);
    setPermission(at);
    unwritten.current = writeChannels(next, scope) === "lost" ? { scope, stored, channels: next } : null;
    const request = ++revision.current;
    if (applyWakeIntent) {
      const wanted = subscriptionWanted(next, at);
      void applyWakeIntent(door, wanted, body, scope).then((outcome) => showDelivery(outcome, request));
    }
  }
  async function pressMaster(want: boolean) {
    if (door === NONE || !alive.current || !owns()) return;
    let state = door.permission();
    if (want && state === "default") {
      const prompt = ++revision.current;
      state = await door.request();
      if (!alive.current || revision.current !== prompt || !owns()) return;
    }
    if (!want || state === "granted") write((current) => ({ ...current, master: want }), state);
    else setPermission(state);
  }
  return {
    channels,
    permission,
    live: channelsAreLive(channels, permission),
    carries: door === NONE || door.emitter === NONE ? [] : door.emitter.carries,
    osHolds: door !== NONE && door.osHoldsPermission === true,
    delivery,
    pressMaster,
    set: (next) =>
      write(
        (current) => {
          // The pane hands back its rendered choices with one edit. Apply just that edit to the current record.
          const updated = { ...current };
          for (const key of CHANNEL_KEYS) {
            if (key !== "master" && next[key] !== channels[key]) updated[key] = next[key];
          }
          return updated;
        },
        door === NONE ? "unsupported" : door.permission(),
      ),
  };
}
