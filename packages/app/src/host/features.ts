import type { ReactNode } from "react";
import type { CalendarEntry, FrameNotice, FramePlaces, FrameStages } from "../frame/contract.js";
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

/**
 * A feature's entry: what it draws where the frame mounts it, and what it has to say in the notice slot. `render` is
 * called in render, never a component type made inline (an inline type mounts the pane again on every render).
 */
export interface FeatureEntry {
  readonly name: FeatureName;
  readonly render: () => ReactNode;
  /**
   * What it has to say in the notice slot now; empty when nothing. The frame calls it once per render of a part it
   * mounts for this entry, so it may use hooks; a view never calls it.
   */
  readonly notice?: () => readonly FrameNotice[];
}

/**
 * Replaces, key by key: `accountSection`, `mailboxSection`, `aiSection`, `billingSection`
 * (`subscription`), `storageSection`, `storageCard`, `accountNotice` (`accountStrip`),
 * `invitesSection`, `securitySection`, `aboutSection`, `desktopSection`, `devicesSection`,
 * `defaultMailSection`, `stageCard`, `screeningSection` (`screener`: one entry on every shell,
 * each control withheld where its own wire is `none`). `help` replaces no input: the pane is
 * drawn today wherever `support` is handed in.
 */
export type HostFeatures = Readonly<Record<FeatureName, FeatureEntry | None>> & {
  /** The places a shell mounts, each the entry it imports or `none` (the frame imports no place). */
  readonly places: FramePlaces;
  /** The bodies that stand over the app. */
  readonly stages: FrameStages;
  /** The calendar's root export (`@ohmail/app/calendar`), handed in by a shell that mounts it; `none`: no calendar here. */
  readonly calendar: CalendarEntry | None;
};
