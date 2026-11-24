/**
 * WHAT THE FIRST RUN IS MADE OF BESIDE ITS OWN SCREENS. Two kinds, kept apart:
 *
 * - THE PARTS A HOST ALONE CAN HAND (`FirstRunParts`): what are other features' or the host's own (the doors'
 *   second-factor dialog, the pairing panel, the desktop's model form, the calendar's half), each a function or
 *   `none`. A host names all four, once, and they are the same for the life of its page.
 * - THE GROUND'S FACTS, as one hook. On the mail ground that is the stage's own seat (`useFirstRunSeat`), which the
 *   mail's stages name; no host fills it. A test or a states page hands its own.
 *
 * `FirstRunSlots` is both: what the registration is made of. Made once, never inline.
 */
import type { ReactNode } from "react";
import type { FirstRunGround } from "@ohmail/app-logic/mailboxes/first-run/ground";
import type { None } from "../../host/index.js";
import type { CalendarHalfSlot, FactorSlot } from "../connect/contract.js";

/** The pairing panel: the devices' own (the code to scan and the same-network switch). */
export type PairSlot = () => ReactNode;
/** The model form of a shell whose install keeps its own model: one write path, shared with Settings → AI. */
export type AiProviderSlot = () => ReactNode;

/** What a host alone can hand the first run. */
export interface FirstRunParts {
  /** The doors' second-factor dialog. `none`: a refusal that asks for it says to sign in again, and nothing is parked. */
  readonly factor: FactorSlot | None;
  /** `none`: this shell does not pair, and the step is not offered. */
  readonly pair: PairSlot | None;
  /** `none` wherever the model is not this install's to choose. */
  readonly aiProvider: AiProviderSlot | None;
  /** The calendar's half of a mailbox just connected; `none` until the calendar's task fills it. */
  readonly calendar: CalendarHalfSlot | None;
}

export interface FirstRunSlots extends FirstRunParts {
  /**
   * The ground's facts. A hook, called once a render while a run is on screen: it reads the ground's readers (the
   * mail state, the consent row, the Screener's model), never a value of a shell.
   */
  readonly ground: () => FirstRunGround;
}
