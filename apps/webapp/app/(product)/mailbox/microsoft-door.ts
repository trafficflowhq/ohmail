"use client";

/**
 * THE MICROSOFT SIGN-IN DOOR — the redirect ceremony, for both screens that open it: Settings → Mailboxes
 * and the sign-up wizard's mailbox step. The availability read, the start and the rule for when the
 * Microsoft tile signs in live here once; the device-code flow stays in `MailboxSection`. Cloud-only, like
 * the rest of this folder: it needs `app/api-client`.
 */

import { useEffect, useState } from "react";
import { apiConfigured, mailboxes as mailboxApi } from "../../api-client";
import { rememberOAuthLanding, rememberOAuthOwner, type OAuthLanding } from "./oauth-return";

/** `available` is the redirect ceremony; `device` the device-code flow (a self-hosted server's door). */
export interface MicrosoftDoor {
  available: boolean;
  device: boolean;
}

export const DOOR_SHUT: MicrosoftDoor = Object.freeze({ available: false, device: false });

/**
 * Whether this deployment can run either Microsoft ceremony. It FAILS CLOSED: an unread or unreadable
 * answer is a shut door, because a sign-in button on a deployment whose registration is disabled or
 * half-entered answers a raw 503 the moment it is pressed. Only an explicit `true` opens either door, and
 * a field an older server does not send is a door it does not have.
 */
export async function readMicrosoftDoor(): Promise<MicrosoftDoor> {
  try {
    const { available, device } = await mailboxApi.oauthAvailability();
    return { available: available === true, device: device === true };
  } catch {
    return DOOR_SHUT;
  }
}

/**
 * The door as a screen holds it: shut until read, read once per mount. A deployment fact, which flips only
 * when an operator saves the admin form, so it is never polled.
 */
export function useMicrosoftDoor(): MicrosoftDoor {
  const [door, setDoor] = useState<MicrosoftDoor>(DOOR_SHUT);
  useEffect(() => {
    if (!apiConfigured()) return;
    let live = true;
    void readMicrosoftDoor().then((d) => { if (live) setDoor(d); });
    return () => { live = false; };
  }, []);
  return door;
}

/**
 * THE MICROSOFT TILE CONNECTS BY SIGN-IN where a door the screen can run is armed: no address, no host, no
 * password, because Microsoft states the address in the token it issues. The app-password fields are the
 * secondary path, for a tenant that blocks the sign-in, reached by an explicit "use an app password
 * instead" (`appPassword`). `armed` is the caller's: Settings runs either ceremony, the wizard only the
 * redirect.
 */
export function connectsBySignIn(providerId: string | undefined, armed: boolean, appPassword: boolean): boolean {
  return providerId === "microsoft" && armed && !appPassword;
}

/**
 * Where each landing asks the server to return. The bounce itself always comes back to `/` (an internal
 * rewrite target such as `/mailbox` would only add a hop); the server checks the path, stores it on the
 * ceremony and returns it from `complete`. Routing on the way back reads the landing this tab recorded.
 */
const RETURN_TO: Record<OAuthLanding, string> = { settings: "/", join: "/join", "first-run": "/" };

/**
 * BEGIN the Microsoft consent — one call, then a TOP-LEVEL navigation. `window.location.assign` and not a
 * `fetch` that follows a redirect: a fetch cannot change the top-level document, Microsoft's consent screen
 * refuses to be framed, and a popup is blocked in the common case. `mailboxId` is a reconnect's, and only
 * preselects the account at the consent screen; the address in Microsoft's `id_token` decides which row is
 * written. Refusals are thrown for the caller to say in the server's own words (a 503 `oauth_unconfigured`
 * is an operator who has not finished the registration, never "Microsoft refused you").
 *
 * Before leaving, it WRITES DOWN WHOSE CEREMONY THIS IS and WHERE IT LANDS, both keyed by the `state` the
 * server issued: the return comes back minutes later, and the account that started it, not whoever the jar
 * names then, is the one the completion is sent for (see `rememberOAuthOwner`). `owner` is read after the
 * start answers. `stillWanted` answering false means the press was retired while the server answered, and
 * nothing is recorded and nothing navigates. Resolves `true` once the browser is leaving.
 */
export async function startMicrosoftSignIn(o: {
  landing: OAuthLanding;
  owner: () => string | null;
  mailboxId?: string;
  stillWanted?: () => boolean;
}): Promise<boolean> {
  const { authorizeUrl, state } = await mailboxApi.oauthStart({
    ...(o.mailboxId ? { mailboxId: o.mailboxId } : {}),
    returnTo: RETURN_TO[o.landing],
  });
  if (o.stillWanted && !o.stillWanted()) return false;
  rememberOAuthOwner(state, o.owner());
  rememberOAuthLanding(o.landing, state);
  if (typeof window !== "undefined") window.location.assign(authorizeUrl);
  return true;
}
