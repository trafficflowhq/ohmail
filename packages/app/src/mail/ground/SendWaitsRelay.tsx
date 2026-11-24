"use client";

/**
 * THE RESTART HOLD'S RELAY: while it stands, `app-update`'s "a send waits" is true to the one send machine. A
 * waiting send holds every restart: the update notice offers no Restart and no Reload and says why, and the desktop
 * installs nothing. Without the relay a letter that is queued or on its way would be dropped by an update.
 *
 * Moved word for word from the web shell (`UpdateLine.tsx`), where the old shell alone mounted it. It takes the
 * machine it relays: the composer's one mount hands it, and the relay stands exactly once, beside that mount, for
 * the frame's life. Gone with the frame, it says no send waits.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useComposer } from "@ohmail/app-logic/writing/composer-record";
import { setSendWaits } from "@ohmail/app-logic/doors/app-update";
import {
  COMPOSE_SEND_KEY,
  type MailSendApi,
  type SendLineItem,
  type SendPhase,
} from "@ohmail/app-logic/writing/mail-send";

/** A send waits: a queued or sending item on the sending line, or the composer's send on its way. */
export function sendWaitsOf(items: readonly SendLineItem[], composePhase: SendPhase): boolean {
  if (composePhase === "sending" || composePhase === "queued") return true;
  return items.some((item) => item.state === "sending" || item.state === "queued");
}

/** Keeps `app-update`'s "a send waits" true to the one machine's sends while it is mounted. */
export function SendWaitsRelay({
  api,
}: {
  readonly api: Pick<MailSendApi, "line" | "subscribeLine" | "lineVersion" | "stateOf">;
}): null {
  useSyncExternalStore(api.subscribeLine, api.lineVersion, api.lineVersion);
  const waits = sendWaitsOf(api.line(), api.stateOf(COMPOSE_SEND_KEY).phase);
  useEffect(() => {
    setSendWaits(waits);
  }, [waits]);
  useEffect(() => () => setSendWaits(false), []);
  return null;
}

/** The relay over the one composer's send machine: stood once, beside the composer's mount, inside it. */
export function SendWaitsHold(): ReactNode {
  const { mailSend } = useComposer();
  return <SendWaitsRelay api={mailSend} />;
}
