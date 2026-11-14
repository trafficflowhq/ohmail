/**
 * The words the frame reads, in both languages, from their place files: its own namespace, and the mailbox errors'
 * sentences a connection state's line borrows. The two catalogues a test hands the reader.
 */
import type { Messages } from "../../src/text/index.js";
import frameDe from "../../messages/frame.de.json" with { type: "json" };
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };

/** The mailbox sentences the frame borrows: every refusal's (`err_*`) and the one for a sync that stopped. */
export const borrowsFromMailboxes = (key: string): boolean => key.startsWith("err_") || key === "syncError";
const errorsOf = (all: Readonly<Record<string, unknown>>): Messages =>
  Object.fromEntries(Object.entries(all).filter(([key]) => borrowsFromMailboxes(key))) as Messages;

export const FRAME_WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: { frame: frameEn.frame, mailboxes: errorsOf(mailboxesEn.mailboxes) },
  de: { frame: frameDe.frame, mailboxes: errorsOf(mailboxesDe.mailboxes) },
};
