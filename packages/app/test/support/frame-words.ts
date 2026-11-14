/**
 * The words the frame reads, in both languages, from their place files: its own namespace, the mailbox errors'
 * sentences a connection state's line borrows, and the sentences of the press seam, which the frame's room stands for
 * the frame's life on a host that hands a ground above the panes or a reader. The two catalogues a test hands the
 * reader.
 */
import type { Messages } from "../../src/text/index.js";
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import frameDe from "../../messages/frame.de.json" with { type: "json" };
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import screenerDe from "../../messages/screener.de.json" with { type: "json" };
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import searchDe from "../../messages/search.de.json" with { type: "json" };
import searchEn from "../../messages/search.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };

/** The mailbox sentences the frame borrows: every refusal's (`err_*`) and the one for a sync that stopped. */
export const borrowsFromMailboxes = (key: string): boolean => key.startsWith("err_") || key === "syncError";
const errorsOf = (all: Readonly<Record<string, unknown>>): Messages =>
  Object.fromEntries(Object.entries(all).filter(([key]) => borrowsFromMailboxes(key))) as Messages;

/** The seven namespaces the press seam says its sentences from, each out of the place file that holds it. */
const SEAM_WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: {
    ohbox: ohboxEn.ohbox,
    screener: screenerEn.screener,
    screening: screenerEn.screening,
    trash: trashEn.trash,
    session: doorsEn.session,
    shortcuts: searchEn.shortcuts,
    place: sharedEn.place,
  },
  de: {
    ohbox: ohboxDe.ohbox,
    screener: screenerDe.screener,
    screening: screenerDe.screening,
    trash: trashDe.trash,
    session: doorsDe.session,
    shortcuts: searchDe.shortcuts,
    place: sharedDe.place,
  },
};

export const FRAME_WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...SEAM_WORDS.en, frame: frameEn.frame, mailboxes: errorsOf(mailboxesEn.mailboxes) },
  de: { ...SEAM_WORDS.de, frame: frameDe.frame, mailboxes: errorsOf(mailboxesDe.mailboxes) },
};
