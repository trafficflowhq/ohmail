"use client";

/**
 * THE ONE NUMBER A NATIVE SHELL IS TOLD: the Ohbox's unread count, put on the app's icon by the host
 * (`host.device.badge`) wherever it has one. A headless feeder of the ground: it draws no node.
 *
 * Told from the very count the Ohbox's rail entry draws (`useOhboxUnread`, off the ground alone), so the icon and the
 * rail can never disagree about how much is waiting; and told only once that count may be stated, as the rail draws
 * it. In an effect rather than during a draw, because the one told is outside React: putting a badge on a window
 * while drawing would be a side effect in the middle of one. Moved from the old shell (`shell-keys.tsx`, which told
 * `onUnread`).
 */
import { useEffect } from "react";
import { useOhboxUnread } from "@ohmail/app-logic/ohbox";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useScreener } from "../../screener/contract.js";

export function MailBadge(): null {
  const badge = useFrame().host.device.badge;
  const unread = useOhboxUnread(useScreener().storeSettled);
  useEffect(() => {
    if (badge !== NONE && unread !== null) badge(unread);
  }, [badge, unread]);
  return null;
}
