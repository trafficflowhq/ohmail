/**
 * WHAT A PRESS ON A CALENDAR NOTICE MAY DO: THE UNLOCK RULE. A notice lies on a locked screen,
 * where whoever holds the device can press it. So a press that changes a calendar is done only
 * when the device is unlocked and the account signed in is the one the notice was made under.
 * Otherwise nothing is written and the app is opened instead, which asks for the person. A press
 * that only opens the app is never refused. Under another account the app opens at its own place:
 * an event of the account left is never carried into the one signed in.
 *
 * Whatever handles a press on a phone (a notification's button, a widget) asks {@link decidePress}
 * at the moment of the press and does what it answers, and gives every press that
 * {@link pressWrites} the platform's own "needs the device unlocked" mark as well. On the web and
 * the desktop a notice has one press, opening the app.
 */
import { NOTICE_ACTS, type NoticeAct } from "./kinds.js";
import { scopeOf } from "./shapes.js";

/**
 * Every press a notice can carry: the notice itself (`open`), an alert's two acts, the three
 * answers to an invitation, and the two for something found in a letter. Closed words.
 */
export const NOTICE_PRESSES = ["open", "join", "again", "yes", "maybe", "no", "add", "dismiss"] as const;
export type NoticePress = (typeof NOTICE_PRESSES)[number];

/**
 * Whether a press changes a calendar or what it rings. Total: a press added to the list does not
 * compile until it says. `join` opens the app, whose own link gate opens the call; `again` moves
 * the alarm; the answers, `add` and `dismiss` write to the calendar.
 */
export const NOTICE_PRESS_WRITES: Readonly<Record<NoticePress, boolean>> = {
  open: false,
  join: false,
  again: true,
  yes: true,
  maybe: true,
  no: true,
  add: true,
  dismiss: true,
};

/** An alert's acts are presses: the list above holds each of them. */
const ACTS_ARE_PRESSES: readonly NoticePress[] = NOTICE_ACTS satisfies readonly NoticeAct[];
void ACTS_ARE_PRESSES;

/** Does `press` change a calendar: the platform is told it needs the device unlocked. */
export function pressWrites(press: NoticePress): boolean {
  return NOTICE_PRESS_WRITES[press] === true;
}

/** What the device says at the moment of a press. */
export interface PressedOn {
  /** The device is locked. Only an exact `false` is unlocked: a platform that cannot say is locked. */
  readonly locked: boolean | null;
  /** The account signed in now, by its scope; `null` for nobody. */
  readonly live: string | null;
}

export type NoticePressAnswer =
  /** Do what the press says, to the event the notice names. */
  | { readonly do: "act" }
  /** Change nothing and open the app: on the notice's event, or at the app's own place under another account. */
  | { readonly do: "app"; readonly at: "event" | "home" }
  /** No press this app knows: nothing happens. */
  | { readonly do: "nothing" };

/**
 * What `press` on a notice made under the account `setUnder` does, on a device that says `on`.
 */
export function decidePress(press: unknown, setUnder: string, on: PressedOn): NoticePressAnswer {
  if (typeof press !== "string" || !(NOTICE_PRESSES as readonly string[]).includes(press)) return { do: "nothing" };
  const own = scopeOf(setUnder) !== null && on.live === setUnder;
  if (own && on.locked === false && pressWrites(press as NoticePress)) return { do: "act" };
  return { do: "app", at: own ? "event" : "home" };
}
