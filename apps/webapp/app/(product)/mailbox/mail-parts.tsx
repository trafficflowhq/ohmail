"use client";

/**
 * WHAT ONLY THE WEB CAN HAND THE MAIL (`MailHostParts`), named once for the page's life. The mail entry makes the
 * places, the stages and Settings' sections itself; a host hands its reader, made once, and its own doors and slots,
 * and nothing else.
 *
 * THE FIRST RUN: the second factor's dialog over the web's step-up door, as the join page hands its form the
 * factor; the web pairs nothing in setup and chooses no model there.
 * SETTINGS: the Account section's doors (`pane-parts.tsx`).
 */
import { BROWSER_READER, NO_STAGE_PARTS, type MailHostParts } from "../../shell/browser-mail";
import { WEB_PANE_PARTS } from "./pane-parts";
import { StepUp } from "./StepUp";

export const WEB_MAIL_PARTS: MailHostParts = {
  reader: BROWSER_READER,
  stageParts: { firstRun: { ...NO_STAGE_PARTS.firstRun, factor: (ask) => <StepUp {...ask} /> } },
  paneParts: WEB_PANE_PARTS,
};
