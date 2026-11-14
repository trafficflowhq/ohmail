"use client";

/**
 * THE MAIL'S NOTICES, FED FOR THE FRAME'S LIFE: what is true for the whole app and belongs to no place, said in the
 * frame's one notice slot (`useNotice`, one feed: the slot ranks its notices itself). A piece of the ground that
 * draws nothing (the list "Show them" opens is mounted once, by the composer's mount: `UnsavedList`), and a walk
 * between places never mounts it again.
 *
 * STANDING: the storage-refused notice (a browser that keeps no decisions between reloads, said once per session);
 * the update notice (`update-notice.ts`); the three lines of the one send machine (`send-notices.ts`): what could
 * not be saved or has not gone through (`unsaved`), a letter not sent, on its way or just sent (`notSent`,
 * `sending`), and each letter that went out without its copy in Sent (`sentCopy`, until its Dismiss), read off the
 * composer's one record, so this piece stands inside the composer's mount.
 *
 * The web's desktop download offer follows the send notices. The slot's ranks decide what is drawn first.
 */
import { dismissDurabilityLost } from "@ohmail/app-logic/storage/durable";
import { useDurabilityLost } from "@ohmail/app-logic/storage/durability-lost";
import { useNotice, type FrameNotice } from "../../frame/index.js";
import { useText } from "../../text/index.js";
import { useDesktopOffer } from "./desktop-offer.js";
import { useSendingNotices, useUnsavedNotice } from "./send-notices.js";
import { updateNotice, useRestartHold, useUpdateOffer } from "./update-notice.js";

/** A durable write this browser refused, said once per session, until the person puts it away. */
function useNotKeptNotice(): FrameNotice | null {
  const t = useText("session");
  const lost = useDurabilityLost();
  return lost
    ? {
        kind: "notKept",
        title: t("storageRefused"),
        acts: [{ label: t("storageRefusedDismiss"), onPress: dismissDurabilityLost }],
      }
    : null;
}

/** The update notice while an offer stands, else null. */
function useUpdateNotice(): FrameNotice | null {
  const t = useText("update");
  const offer = useUpdateOffer();
  const hold = useRestartHold();
  return offer === null ? null : updateNotice(t, offer, hold);
}

export function MailNotices(): null {
  const notices = [
    useNotKeptNotice(),
    useUpdateNotice(),
    useUnsavedNotice(),
    ...useSendingNotices(),
    useDesktopOffer(),
  ].filter((notice): notice is FrameNotice => notice !== null);
  useNotice(notices);
  return null;
}
