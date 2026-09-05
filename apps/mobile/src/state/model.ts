/**
 * The mail screens' row vocabulary — types and the few pure helpers they share.
 *
 * No data lives here. The app renders exactly one world: the connected
 * session's mirror, through the shared client-engine selectors in `live.ts`.
 * An unconnected app renders the connect flow, never sample mail — demo
 * content belongs to the product's website, not to the client.
 *
 * The few WORDS in here — the five destination names and the three pile titles — read from the
 * copy deck rather than from literals in the table below. They are on screen (a decision button, a
 * toast, the pile rail), so they are copy, and a literal here was a string no language but English
 * could reach. The lookups keep their shape: the table maps a destination to a GETTER over the
 * deck, so a language switch is visible on the next read exactly as it is everywhere else.
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
