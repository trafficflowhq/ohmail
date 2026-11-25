"use client";

/**
 * THE CONNECTION, FED FOR THE FRAME'S LIFE: the mail state ladder's reading, the browser's own network, when the copy
 * on screen last finished a sync, where a person with no mailbox connects one, and why, in the sentences the sync strip
 * always said (`connectionReason`). The frame says it in its one slot (`useConnectionFeed`). A headless feeder of the
 * ground: it draws no node. Moved from the web shell's feed (`todays-reasons.ts`, `useTodaysConnection`).
 *
 * WHERE ITS WORDS LEAD: an address of the app (a mailbox's place in Settings) is gone to by the frame's own command;
 * the one address outside the app, the host's setup page, is left for by the host's own way there (the first run's
 * `resume`). A package names no address and opens no window.
 */
import { useConnectionFeed, useFrame } from "../../frame/index.js";
import { useMailConnectionReading } from "../../mailboxes/connection.js";

export { MailConnectionDetails } from "../../mailboxes/connection.js";

/** The connection's feeder, standing in the ground for the frame's life. */
export function MailConnection(): null {
  const { route } = useFrame();
  const read = useMailConnectionReading();
  const open = route.place === "settings" && route.sub === "mailboxes" && route.words.mailbox;
  useConnectionFeed(open && open === read.mail?.mailboxId ? { ...read, mail: null } : read);
  return null;
}
