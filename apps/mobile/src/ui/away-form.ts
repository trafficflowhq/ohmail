/**
 * The away responder's rules on this phone — pure, so the census and the tests drive them as
 * data (`reader-verbs.ts`'s posture). Three facts live here and nowhere else: what the switch's
 * state SAYS, what a save may send, and what the phone is not offering to change.
 *
 * `PUT /away-responder` IS A FULL REPLACE — it defaults every field the body omits, so a partial
 * write silently resets what it left out. This phone edits three of the seven and sends back the
 * OTHER FOUR as it read them, which makes a successful read a precondition of a save: saving over
 * a read that never landed would narrow the audience and the pile scope on somebody's behalf.
 */

import { Copy } from "../copy";

/** The holder turned this install's last away change down, as the read says (`change`). */
export interface AwayRefusal {
  holder: string | null;
  unreadable: boolean;
}

/** The sentence for a refusal the read carries — the web's `settings.screening.refused*`. */
export function awayRefusalLine(r: AwayRefusal | null): string | null {
  if (r === null) return null;
  return r.holder !== null ? Copy.awayRefused(r.holder, r.unreadable) : Copy.awayRefusedUnknown(r.unreadable);
}

/** The single per-account row, as `GET/PUT /away-responder` serve it. */
export interface AwayRow {
  enabled: boolean;
  /** The reply's text. `null` and "" are both "nothing written" to the server. */
  body: string | null;
  startsAt: string | null;
  /** When the responder stops — the end of the chosen day where the reader is, or open-ended. */
  endsAt: string | null;
  /** Who gets a reply. Read-only on this phone; carried back verbatim on every save. */
  audience: string;
  /** How often one person may be answered. Read-only here; carried back verbatim. */
  throttle: string;
  /** WHICH piles get a reply, as FOLDER names. Read-only here; carried back verbatim. */
  piles: string[];
  updatedAt: string | null;
}

/** The three fields this phone edits. Everything else on the row travels back untouched. */
export interface AwayEdits {
  enabled: boolean;
  body: string;
  endsAt: string | null;
}

/**
 * THE PUT BODY — the row that was read, with this phone's three edits over it.
 *
 * `null` where there is no read, which is a refusal and not an empty save: see the header. The
 * body is trimmed to `null` when nothing is written, which is what the server stores for an
 * empty message and keeps a save from turning "" and null into two different rows.
 */
export function awaySaveBody(read: AwayRow | null, edits: AwayEdits): AwayRow | null {
  if (read === null) return null;
  return {
    ...read,
    enabled: edits.enabled,
    body: edits.body.trim() === "" ? null : edits.body,
    endsAt: edits.endsAt,
  };
}

/**
 * WHAT THE SWITCH'S STATE SAYS — five, and each is a different fact about what is being sent.
 *
 * `expired` is the one worth naming apart: an end date already past with the responder still on
 * is a row the away pass has not reached yet, so nothing is being sent AND the reader is about to
 * be refused by the server if they save it as it stands. `on`/`onUntil` are the states that send
 * mail, and `off` is silence.
 */
export type AwaySay = "off" | "on" | "onUntil" | "expired";

export function awaySay(enabled: boolean, endsAt: string | null, now: Date): AwaySay {
  if (!enabled) return "off";
  if (endsAt === null) return "on";
  const at = Date.parse(endsAt);
  /* An unparseable instant reads as OPEN-ENDED rather than expired: "the end date passed" is a
     claim about a date, and a date nobody can read is not evidence for it. */
  if (!Number.isFinite(at)) return "on";
  return at <= now.getTime() ? "expired" : "onUntil";
}

/**
 * Can this edit be saved as it stands? The server refuses an end date already past while the
 * responder is on (`away.ts`'s own 400), so the form refuses it first and says which it is.
 */
export function awaySaveBlocked(edits: AwayEdits, now: Date): boolean {
  return awaySay(edits.enabled, edits.endsAt, now) === "expired";
}

/**
 * THE SWITCH'S SENTENCE STATES THE SAVED ROW, never the edit: "On. Replies to new mail" over a
 * responder that is still off is what somebody reads before closing the screen for a holiday.
 * `null` while there is no read — the line says nothing rather than a default.
 */
export function awayStatedLine(read: AwayRow | null): string | null {
  if (read === null) return null;
  return read.enabled ? Copy.awayOn : Copy.awayOff;
}

/**
 * DO THE EDITS DIFFER FROM THE SAVED ROW? Compared as the save would write them (an empty message
 * is `null`, an instant by its time), so typing and deleting a word is no change. Drives the
 * unsaved sentence and the question on leaving.
 */
export function awayUnsaved(read: AwayRow | null, edits: AwayEdits): boolean {
  if (read === null) return false;
  const at = (v: string | null): number | null => (v === null ? null : Date.parse(v));
  const body = edits.body.trim() === "" ? null : edits.body;
  return read.enabled !== edits.enabled
    || (read.body?.trim() ? read.body : null) !== body
    || at(read.endsAt) !== at(edits.endsAt);
}

/** The sentence for an unsaved change: what the SAVED responder keeps doing until the save. */
export function awayUnsavedLine(read: AwayRow): string {
  return read.enabled ? Copy.awayUnsavedStillOn : Copy.awayUnsavedStillOff;
}

/** The folder names the phone has words for, and the word for each. */
const PILE_WORD: Readonly<Record<string, "ohbox" | "reads" | "receipts" | "screener">> = {
  "INBOX": "ohbox",
  "ohmail/News": "reads",
  "ohmail/Receipts": "receipts",
  "ohmail/Screener": "screener",
};

/**
 * WHAT THE STORED SCOPE IS, for the sentence that says who will be answered.
 *
 * An unrecognised folder is carried through VERBATIM rather than dropped. Filtering it would make
 * this surface report a NARROWER scope than the pass acts on — the exact failure the responder
 * service's own narrowing comment names — and on a phone that is a person reading "only your
 * Ohbox is answered" while a fourth pile is going out in their name. The phone offers no control
 * over this set; it states it.
 */
export function awayPileWords(piles: readonly string[]): { known: string[]; verbatim: string[] } {
  const known: string[] = [];
  const verbatim: string[] = [];
  for (const p of piles) {
    const word = PILE_WORD[p];
    if (word === undefined) verbatim.push(p);
    else known.push(word);
  }
  return { known, verbatim };
}

/** Is this the narrow audience? Unknown members read as the WIDE one — see {@link awayAudienceWide}. */
export function awayAudienceWide(audience: string): boolean {
  /* NOT `=== "everyone"`. A member this build has never heard of is a member somebody widened the
     audience to, and reporting it as "people I've let in" would understate who is being told this
     address is read — the one irreversible thing this feature does. Unknown fails WIDE, so the
     sentence claims less protection than the row might give, never more. */
  return audience !== "screened_in";
}
