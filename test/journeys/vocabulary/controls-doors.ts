import type { CatalogueKey } from "./catalogue.js";
import type { Control } from "./controls.js";
import type { AriaRole } from "./places.js";

/**
 * THE DOORS' CONTROLS: the sign-in page's second factor, the join page's fields, the authenticator's key and
 * code, the invite's link. Found like every control, by role and whole name. These rows pass to the doors'
 * seat when it seats; until then they stand here, apart from the rows the seats own (`controls.ts`).
 */
export type DoorRole = AriaRole | "code" | "menuitemradio";
export type DoorControl = Omit<Control, "role"> & { role: DoorRole };

const d = (id: string, role: DoorRole, key: CatalogueKey | null, more: Partial<DoorControl> = {}): [string, DoorControl] =>
  [id, { id, role, key, ...more }];

const entries: Array<[string, DoorControl]> = [
  // The sign-in page, after the password.
  d("login-factor-choice", "button", "login.factorPasskey"),
  d("login-code-instead", "menuitemradio", "login.factorCode"),
  d("login-code", "textbox", "login.totpLabel"),
  d("login-code-verify", "button", "login.totpVerify"),

  // The invite's own page: the account it makes.
  d("invite-email", "textbox", "joinInvite.emailLabel"),
  d("invite-name", "textbox", "joinInvite.nameLabel"),
  d("invite-password", "textbox", "joinInvite.passwordLabel"),
  d("invite-create", "button", "joinInvite.createAccount"),

  // The join page, the setup's steps.
  d("join-invite", "textbox", "join.inviteLabel"),
  d("join-email", "textbox", "join.emailLabel"),
  d("join-name", "textbox", "join.nameLabel"),
  d("join-password", "textbox", "join.passwordLabel"),
  d("join-create", "button", "join.continue"),
  d("join-use-totp", "radio", "join.factorApp"),
  /** The authenticator's key, as the page writes it for a person to type into their app. */
  d("join-key", "code", null, { nameFrom: "none" }),
  d("join-code", "textbox", "join.totpLabel"),
  d("join-activate", "button", "join.activate"),

  // The invite, once made in Settings.
  d("invite-link-copy", "button", "invites.copyLink", { within: "settings-pane" }),
];

export const DOOR_CONTROLS: Readonly<Record<string, DoorControl>> = Object.freeze(Object.fromEntries(entries));
