import type { ConnectedSession } from "../net/pairing";
import type { Sender } from "./sender";
import type { SwitchNative } from "./switch-port";

export interface MailCalendarPort {
  native: SwitchNative;
  sender: Sender;
}

export function mailCalendarPort(_session: ConnectedSession | null): MailCalendarPort | null {
  return null;
}
