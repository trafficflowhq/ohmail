/**
 * WHAT A SHELL HANDS THE FIRST RUN: the parts that are other features' (the doors' second-factor dialog, the pairing
 * panel, the desktop's model form, the calendar's half), each a function or `none`, and the ground's facts as one
 * reader the host fills from the ground's readers. Made once, never inline.
 */
import type { ReactNode } from "react";
import type { FirstRunGround } from "@ohmail/app-logic/mailboxes/first-run/ground";
import type { None } from "../../host/index.js";
import type { CalendarHalfSlot, FactorSlot } from "../connect/contract.js";

/** The pairing panel: the devices' own (the code to scan and the same-network switch). */
export type PairSlot = () => ReactNode;
/** The model form of a shell whose install keeps its own model: one write path, shared with Settings → AI. */
export type AiProviderSlot = () => ReactNode;

export interface FirstRunSlots {
  /** The doors' second-factor dialog. `none`: a refusal that asks for it says to sign in again, and nothing is parked. */
  readonly factor: FactorSlot | None;
  /** `none`: this shell does not pair, and the step is not offered. */
  readonly pair: PairSlot | None;
  /** `none` wherever the model is not this install's to choose. */
  readonly aiProvider: AiProviderSlot | None;
  /** The calendar's half of a mailbox just connected; `none` until the calendar's task fills it. */
  readonly calendar: CalendarHalfSlot | None;
  /**
   * The ground's facts. A hook, called once a render: the host's fill reads the ground's readers (the mail state, the
   * consent row, the Screener's model), never a value of the old shell.
   */
  readonly ground: () => FirstRunGround;
}
