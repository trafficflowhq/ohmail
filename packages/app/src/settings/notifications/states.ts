/** Notifications' registered states, as models (`screen=settings&sec=notifications`, `&state=denied`). */
import type { NotificationsModel } from "./model.js";

const still = () => undefined;

export function notificationsState(at: { denied?: boolean } = {}): NotificationsModel {
  const channels = {
    master: true,
    ohbox: true,
    screener: true,
    scheduled: false,
    pairing: true,
  };
  return {
    channels,
    permission: at.denied ? "denied" : "granted",
    live: !at.denied,
    carries: ["ohbox", "screener", "scheduled", "pairing"],
    osHolds: false,
    delivery: null,
    pressMaster: still,
    set: still,
  };
}

export const NOTIFICATIONS_STATES: Readonly<Record<string, () => NotificationsModel>> = {
  "": () => notificationsState(),
  denied: () => notificationsState({ denied: true }),
};
