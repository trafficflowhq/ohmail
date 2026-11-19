"use client";

/**
 * THE WEB'S DOORS OF SETTINGS' SECTIONS, named once for the page's life: what only this host can hand a section of
 * the mail's Settings (`MailPaneParts`). The mail entry makes the sections' registrations itself; a host hands its
 * doors, as hooks, and nothing else.
 *
 * THE MAILBOXES SECTION: the second factor's dialog over the web's step-up door, for the presses the server asks it
 * for (a removal, an erasure, organizing here); the web has no calendar's half of a mailbox.
 *
 * THE ACCOUNT SECTION, the way out: who is signed in, sign this browser out, the way to the page that deletes the
 * account, and the way back to a live session (the session's door, `account-door.ts`); the password form's door
 * (`password-door.ts`) and the second factor's dialog over the web's step-up door, as the join page hands its form
 * the factor. The sentences of a sign-out that stayed are the pane's own.
 */
import { NONE } from "@ohmail/app/host";
import type { MailPaneParts } from "@ohmail/app/mail";
import type { AccountDoor } from "@ohmail/app/account";
import { useAccountDoor } from "./account-door";
import { usePasswordDoor } from "./password-door";
import { StepUp } from "./StepUp";
import { webRecover } from "./web-supplies";

/** The way to the sign-in page: the host's own way back to a live session. */
const toSignIn = (): void => webRecover("signIn");

/** The web's session door of the Account section: one door for the page's life. */
function useWebAccountDoor(): AccountDoor {
  return useAccountDoor(toSignIn);
}

export const WEB_PANE_PARTS: MailPaneParts = {
  mailboxes: { factor: (ask) => <StepUp {...ask} />, calendar: NONE },
  account: {
    useDoor: useWebAccountDoor,
    password: { useDoor: usePasswordDoor, factor: (ask) => <StepUp {...ask} /> },
  },
};
