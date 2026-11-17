/**
 * THE ACCOUNT GROUP'S CONTRACT: what the six panes of Settings' Account group (Devices, Subscription, Storage,
 * Invites, Security, Account) and the "handled in your browser" card share. Types and four lists; it compiles with no
 * pane built.
 *
 * A pane draws a model. Its hook steps pure transitions through a typed door in the pane's own folder, and a shell
 * fills that door. A door answers WORDS: never a status, never an address of the server, never a server's sentence.
 * Dates, sizes and amounts arrive as the reader says them; a pane formats nothing.
 */
import type { ReactNode } from "react";

/** The six panes, by Settings' ids, in the menu's order. The pane whose id is `billing` is Subscription. */
export const ACCOUNT_PANES = ["devices", "billing", "storage", "invites", "security", "account"] as const;
export type AccountPaneId = (typeof ACCOUNT_PANES)[number];

/** The eight doors: one per pane, the password form's (the wall mounts it alone), and the card's. */
export const ACCOUNT_DOORS = [
  "devices",
  "invites",
  "security",
  "password",
  "account",
  "subscription",
  "storage",
  "wayOut",
] as const;
export type AccountDoorName = (typeof ACCOUNT_DOORS)[number];

/**
 * What a door's verb answers. `factor`: the server asked for a fresh second factor. `sign_in`: signing in again is
 * the remedy. `said`: the shell's own sentence for a refusal this client raised (offline, the browser's marker gone).
 * `W` is the door's own closed set of refusal words; `minutes` rides the one word that names a wait.
 */
export type Answer<T, W extends string = never> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly word: W | "factor" | "sign_in"; readonly minutes?: number }
  | { readonly ok: false; readonly word: "said"; readonly said: string };

/**
 * What a place that parked an act hands the factor's dialog: the dialog's own three answers, and the place's line
 * about what happens the moment the factor verifies.
 */
export interface GatedAsk {
  readonly line?: string;
  /** The factor verified: the parked act is sent, once. */
  onVerified(): void;
  /** Cancel, Esc or the scrim: the parked act is dropped. */
  onCancel(): void;
  /** A factor landed after Cancel and was thrown away: nothing ran, and the place says so. */
  onDiscarded(): void;
}

/** The factor's dialog, filled by the shell: a pane draws `model.ask ? factor(model.ask) : null` and imports no dialog. */
export type FactorSlot = (ask: GatedAsk) => ReactNode;

/** The picture of a link to scan, filled by the shell until the kit has a part for it. `label` names it to a screen reader. */
export type QrSlot = (value: string, label: string) => ReactNode;

/**
 * A state a pane builds: its address in the comparison's registry, or `null` where no picture draws it. `B` is for
 * the two panes a host's answers give more than one body (Storage, Account): such a state says which body draws it,
 * and one that says none is drawn by the pane whole.
 */
export interface AccountState<M, B extends string = never> {
  readonly address: string | null;
  readonly model: M;
  readonly body?: B;
}

/** A sentence, by its catalogue key. */
export interface CatalogueKey {
  readonly namespace: string;
  readonly key: string;
}

/** The refusals of the change of the account's password that are its own. */
export type PasswordWord =
  /** What was typed as the current one is not the account's. */
  | "wrong_current"
  /** Too many wrong ones from this browser: it carries the minutes to wait. */
  | "locked"
  /** The server slows this account's checks down after many failed tries. */
  | "slowed"
  /** Another session changed it a moment ago. */
  | "conflict"
  /** Any other refusal of the server's. */
  | "refused";
/** Nobody is signed in on this browser. */
export type AccountWord = "signed_out";
/** How a sign-out ended: it left; the copy is still here; this browser will not say what it holds. */
export type SignOutOutcome = "left" | "blocked" | "unverified";
/** The plans and prices could not be read. */
export type SubscriptionWord = "plans_unavailable";
/** How the press that opens the account page ended: it left; no page is served; the address could not be made. */
export type ManageOutcome = "left" | "nowhere" | "failed";
/** The plan's change: the address is not confirmed yet; the page could not be opened. */
export type StorageWord = "unverified" | "failed";

const at = (namespace: string, key: string): CatalogueKey => ({ namespace, key });

/**
 * THE CLOSED LIST OF REFUSAL WORDS, door by door, each with the catalogue key that says it today. A failure of these
 * panes is one of these words or `said`. By door, because two words are said twice: `unverified` is the sign-out
 * that could not prove its wipe and the plan's change on an unconfirmed address; `failed` is the account page that
 * could not be opened from Subscription and from Storage. `sign_in` keeps the key each pane says it by; Storage
 * says a second refusal of its change as "could not open", never as a way back in.
 */
export const ACCOUNT_REFUSALS = {
  devices: { sign_in: at("devices", "stepUpExpired") },
  invites: { sign_in: at("invites", "stepUpExpired") },
  security: { sign_in: at("security", "stepUpExpired") },
  password: {
    sign_in: at("devices", "stepUpExpired"),
    wrong_current: at("passwordChange", "wrongCurrent"),
    locked: at("passwordChange", "locked"),
    slowed: at("passwordChange", "slowed"),
    conflict: at("passwordChange", "conflict"),
    refused: at("passwordChange", "refused"),
  },
  account: {
    signed_out: at("account", "signedOutBody"),
    blocked: at("account", "signOutBlocked"),
    unverified: at("account", "signOutUnverified"),
  },
  subscription: {
    plans_unavailable: at("accountSubscription", "plansUnavailable"),
    failed: at("settings", "subscriptionManageFailed"),
  },
  storage: {
    sign_in: at("settings", "storageChangeFailed"),
    unverified: at("accessLock", "mintUnverified"),
    failed: at("settings", "storageChangeFailed"),
  },
  wayOut: {},
} as const satisfies {
  readonly devices: Readonly<Record<"sign_in", CatalogueKey>>;
  readonly invites: Readonly<Record<"sign_in", CatalogueKey>>;
  readonly security: Readonly<Record<"sign_in", CatalogueKey>>;
  readonly password: Readonly<Record<"sign_in" | PasswordWord, CatalogueKey>>;
  readonly account: Readonly<Record<AccountWord | Exclude<SignOutOutcome, "left">, CatalogueKey>>;
  readonly subscription: Readonly<Record<SubscriptionWord | Extract<ManageOutcome, "failed">, CatalogueKey>>;
  readonly storage: Readonly<Record<"sign_in" | StorageWord, CatalogueKey>>;
  readonly wayOut: Readonly<Record<never, CatalogueKey>>;
};

/** One member of a door: the server's routes it asks, and whether an account the service has refused is still answered. */
export interface ClosedReach {
  /** `<METHOD> <pattern>`, in the order asked; empty for a member that asks the server nothing. */
  readonly asks: readonly string[];
  readonly answered: boolean;
}

const reached = (...asks: string[]): ClosedReach => ({ asks, answered: true });
const refused = (...asks: string[]): ClosedReach => ({ asks, answered: false });

/**
 * WHICH ACTS OF THESE PANES THE SERVER STILL ANSWERS FOR A CLOSED ACCOUNT, member by member. The server keeps the
 * identity's own routes open (the password, the factors, pairing and its removals, sign-out, the erase), the way back
 * to paying and the read of the account's standing; it refuses the lists, the storage mails and the plan's change.
 * So behind the wall a person has: change the password, the way to the delete page, the way back to paying, sign
 * out; and no pane of Settings.
 *
 * The plans' read is not mounted by the server yet: its row is refused until it is.
 */
export const CLOSED_ACCOUNT_REACH = {
  devices: {
    read: refused("GET /devices", "GET /pair"),
    groupsWebSessions: reached("GET /hello"),
    add: reached("POST /pair"),
    revokeCode: reached("DELETE /pair/:id"),
    remove: reached("DELETE /devices/:id"),
    signOutWeb: reached("POST /devices/revoke-web-sessions"),
    copy: reached(),
  },
  invites: {
    read: refused("GET /pair"),
    make: reached("POST /pair"),
    revoke: reached("DELETE /pair/:id"),
    copy: reached(),
  },
  security: {
    read: reached("GET /auth/session"),
    newCodes: reached("POST /auth/2fa/recovery-codes"),
    startAuthenticator: reached("POST /auth/2fa/totp/enroll"),
    activate: reached("POST /auth/2fa/totp/activate"),
    removeAuthenticator: reached("DELETE /auth/2fa/totp"),
  },
  password: { change: reached("POST /auth/password") },
  account: {
    who: reached("GET /auth/session"),
    /* The sign-out's own door. The wake registration it takes down first is best effort and holds nothing back. */
    signOut: reached("POST /auth/refresh/logout"),
    /* A way to the delete page, which asks its own erase there. */
    toErase: reached(),
    toSignIn: reached(),
  },
  subscription: {
    status: reached("GET /account/access"),
    plans: refused("GET /account/plans"),
    manage: reached("POST /account/manage-link"),
  },
  storage: {
    figures: reached("GET /account/access"),
    setMail: refused("PATCH /account/storage", "GET /account/access"),
    change: refused("POST /account/manage-link/change"),
  },
  wayOut: { open: reached() },
} as const satisfies Readonly<Record<AccountDoorName, Readonly<Record<string, ClosedReach>>>>;
