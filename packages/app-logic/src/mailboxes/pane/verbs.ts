/**
 * WHICH VERBS THE MAILBOXES PANE DRAWS, from data alone: the shell's answer of the capability `mailboxes`, its wires
 * and whether its first run can open. One table, and no branch by a platform's name:
 *
 *   here           every verb the wires hand
 *   resyncAndOut   the re-sync, and the way out the shell hands (it changes mailboxes elsewhere)
 *   resyncOnly     the re-sync
 *   none           the pane is not listed
 *
 * A withheld verb is absent, never disabled. The capability is necessary and never sufficient: the server gates.
 */
import { NONE, type None, type PaneCalls } from "./calls.js";

export const PANE_CAPABILITIES = ["here", "resyncAndOut", "resyncOnly", "none"] as const;
export type PaneCapability = (typeof PANE_CAPABILITIES)[number];

export interface VerbFacts {
  readonly capability: PaneCapability;
  readonly wire: PaneCalls | None;
  /** The connect form's wire, read for its edit and its sign-in alone. */
  readonly connect: { readonly edit: unknown; readonly signIn: unknown } | None;
  /** The first run can open here: its add run and its run again. */
  readonly stage: boolean;
}

export interface PaneVerbs {
  /** The pane stands at all. */
  readonly listed: boolean;
  /** "Connect a mailbox": the first run's add run. */
  readonly connect: boolean;
  /** "Run setup again". */
  readonly setupAgain: boolean;
  /** The connect form in a password mailbox's row. */
  readonly edit: boolean;
  /** The connect form in the row of a mailbox that signs in at its provider. */
  readonly reconnect: boolean;
  readonly resync: boolean;
  readonly remove: boolean;
  /** Erasing ohmail's copy: an answer of the removal's own confirmation. */
  readonly erase: boolean;
  /** Who holds a mailbox, read before a take-over is offered. */
  readonly peek: boolean;
  /** Organize it here: a take-over, or a released mailbox taken back. */
  readonly organize: boolean;
  /** Stop organizing it here, or give up a claim left behind. */
  readonly stop: boolean;
  readonly dismissQuiet: boolean;
  /** Check it against the mail server. */
  readonly check: boolean;
  readonly filings: boolean;
  /** The way out where the shell changes mailboxes elsewhere. */
  readonly out: boolean;
}

export const NO_VERBS: PaneVerbs = Object.freeze({
  listed: false,
  connect: false,
  setupAgain: false,
  edit: false,
  reconnect: false,
  resync: false,
  remove: false,
  erase: false,
  peek: false,
  organize: false,
  stop: false,
  dismissQuiet: false,
  check: false,
  filings: false,
  out: false,
});

/** What the pane draws for this shell. */
export function verbsOf(f: VerbFacts): PaneVerbs {
  const { capability, wire, connect, stage } = f;
  if (capability === "none" || wire === NONE) return NO_VERBS;
  const listed = { ...NO_VERBS, listed: true, resync: true };
  if (capability === "resyncOnly") return listed;
  if (capability === "resyncAndOut") return { ...listed, out: wire.out !== NONE };
  const connects = connect !== NONE;
  const removes = wire.remove !== NONE;
  return {
    ...listed,
    connect: connects && stage,
    setupAgain: stage,
    edit: connects && connect.edit !== NONE,
    reconnect: connects && connect.signIn !== NONE,
    remove: removes,
    erase: removes && wire.erase !== NONE,
    peek: wire.organizer !== NONE,
    organize: wire.organizeHere !== NONE,
    stop: wire.stopOrganizing !== NONE,
    dismissQuiet: wire.dismissForwardingNotice !== NONE,
    check: wire.selfCheck !== NONE,
    filings: wire.filings !== NONE,
  };
}
