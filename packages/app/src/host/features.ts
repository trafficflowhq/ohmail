import type { None } from "./contract.js";

/**
 * The build-time half. Each feature is its own entry; a shell imports the entries it mounts and
 * hands them over in one total record, the entry or `none`. What a shell does not import is not
 * in its download.
 */
export const FEATURE_NAMES = [
  "account", "mailboxes", "ai", "subscription", "storage", "storageCard", "accountStrip", "invites",
  "security", "about", "desktop", "devices", "defaultMail", "stageCard", "screener", "help",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

declare const entryOf: unique symbol;
/** A feature's entry. Opaque here: the frame says what an entry is when it takes them. */
export interface FeatureEntry {
  readonly [entryOf]: FeatureName;
}

/**
 * Replaces, key by key: `accountSection`, `mailboxSection`, `aiSection`, `billingSection`
 * (`subscription`), `storageSection`, `storageCard`, `accountNotice` (`accountStrip`),
 * `invitesSection`, `securitySection`, `aboutSection`, `desktopSection`, `devicesSection`,
 * `defaultMailSection`, `stageCard`, `screeningSection` (`screener`: one entry on every shell,
 * each control withheld where its own wire is `none`). `help` replaces no input: the pane is
 * drawn today wherever `support` is handed in.
 */
export type HostFeatures = Readonly<Record<FeatureName, FeatureEntry | None>>;
