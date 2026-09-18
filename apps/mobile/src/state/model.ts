/**
 * The mail screens' row vocabulary — types and the few pure helpers they share. No data lives
 * here: the app renders exactly one world, the connected session's mirror, through the shared
 * selectors in `live.ts`; an unconnected app renders the connect flow, never sample mail. The
 * few words in here — the five destination names and the three pile titles — read from the copy
 * deck rather than literals: they are on screen, so they are copy, and a literal here was a
 * string no language but English could reach. The table maps a destination to a getter over the
 * deck, so a language switch is visible on the next read exactly as everywhere else.
 */
import { Copy } from "../copy";

/* ------------------------------------------------------------------ types */

export type Place = "ohbox" | "reads" | "receipts";
export type Destination = Place | "screened" | "spam";
export type Scope = "sender" | "domain";
export type PileKind = "replyLater" | "setAside" | "resurface";
export type ScreenerSeg = "waiting" | "screened" | "spam";

export interface Address {
  name: string;
  address: string;
}

/** One message inside a held bag or a conversation. Always its own identity. */
export interface Held {
  id: string;
  subject: string;
  time: string;
  body: string;
  trackerNote?: string;
  seen: boolean;
}

/**
 * Protected content metadata, as the engine's wire carries it: a class of mail
 * (verification codes) whose body is stored redacted — there is nothing to
 * render behind the dots, and the policy sentence is the promise verbatim.
 */
export interface ProtectedInfo {
  kind: string;
  label: string;
  redactedNote: string;
  policy: string;
}

export interface Mail {
  id: string;
  place: Place;
  from: Address;
  subject: string;
  time: string;
  body: string;
  snippet?: string;
  unread: boolean;
  rationale?: string;
  trackerNote?: string;
  amount?: string;
  protected?: ProtectedInfo;
  /**
   * WHERE THIS MAIL ACTUALLY IS, set exactly when the surface showing it is HISTORY.
   *
   * History is a presentation over the mailbox rather than a folder, so nothing in it has moved:
   * the row wears the server's own folder as its place chip, and the message screen titles itself
   * History off this field's presence (`place` would say Ohbox about mail that is not there).
   * Absent everywhere else — every other list on this phone groups BY location, so there is
   * nothing for a chip to correct.
   */
  historyPlace?: string;
  /**
   * THE SERVER IS HOLDING THIS AT THE GATE — set exactly when the message's physical folder is
   * `ohmail/Screener`, whatever place it is being presented in.
   *
   * {@link Place} has three values and the Screener is not one of them, so gate-held mail fell
   * to the ohbox default and the reading screen titled it "Ohbox" — about mail the person is
   * being asked to make a decision on. The correction {@link historyPlace} makes for History,
   * this makes for the gate: the two are the only surfaces that show mail somewhere other than
   * where it lives, and both have to say so.
   */
  gateHeld?: true;
  /**
   * HOW MANY UNREAD MESSAGES ARRIVED SINCE THE PIN WENT UP — a resurfaced conversation's badge,
   * absent everywhere else. Set only by `liveOhbox`, from the engine's own `resurfacedThreads`,
   * so the phone and the web app answer the question once. Absent and zero are ONE state: a
   * conversation nobody wrote to has nothing to say, and a "0 new" chip on every pin is noise.
   */
  newSince?: number;
  /**
   * HOW MANY MESSAGES THE CONVERSATION HOLDS — absent where this row stands for one message.
   *
   * From the engine's own `threadSizeIndex` (the server's thread length where the mirror holds
   * the thread row), so the number beside a subject is the same one the web app's row shows.
   * `earlier` cannot answer it in a list: only the reading view fills that, which is why the
   * count was 0 on every row of every list.
   */
  threadCount?: number;
  /**
   * The rest of the conversation, oldest → newest, excluding this message.
   * Rendered in full in the reading view — never summarised into a count.
   */
  earlier: Held[];
}

export interface PileItem {
  id: string;
  messageId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}

export type ThemePref = "system" | "light" | "dark";

/* ---------------------------------------------------------------- helpers */

const DEST_LABEL: Record<Destination, () => string> = {
  ohbox: () => Copy.placeOhbox,
  reads: () => Copy.placeReads,
  receipts: () => Copy.placeReceipts,
  screened: () => Copy.destScreenOut,
  spam: () => Copy.placeSpam,
};

/** Past-tense name used in toasts and the suggestion line. */
export function destDone(d: Destination): string {
  return d === "screened" ? Copy.segScreened : DEST_LABEL[d]();
}
export function destLabel(d: Destination): string {
  return DEST_LABEL[d]();
}
export const DESTINATIONS: Destination[] = ["ohbox", "reads", "receipts", "screened", "spam"];

export function isPlace(d: Destination): d is Place {
  return d === "ohbox" || d === "reads" || d === "receipts";
}

export function domainOf(addr: string): string {
  return addr.split("@").pop() ?? addr;
}

export function pileTitle(kind: PileKind): string {
  return kind === "replyLater" ? Copy.replyLater : kind === "setAside" ? Copy.setAside : Copy.resurface;
}
