/**
 * THE SETTINGS CONTRACT: how a pane registers. Types and three lists; it compiles with no pane built, so the
 * tasks that own a pane (Mailboxes; Devices, Subscription, Storage, Invites, Security, Account; Desktop; the
 * calendar's) build on it while the panes here are still being drawn.
 *
 * A pane's task exports one `SettingsPane` from its own folder, usually through `paneOf` (`./facts.ts`), and
 * imports nothing else of Settings. The record of all panes is total: a forgotten id does not compile.
 */
import type { ComponentType, ReactNode, RefObject } from "react";
import type { IconName } from "@ohmail/ui/base";
import type { LayoutPlan } from "../frame/contract.js";
import type { HostContract, None } from "../host/index.js";

/** Every section, in the menu's order. The route (`#/settings/<id>`) and the frame's route agree with it (a test holds it). */
export const PANE_IDS = [
  "general",
  "notifications",
  "mailboxes",
  "screener",
  "ai",
  "away",
  "rules",
  "tags",
  "folders",
  "signatures",
  "desktop",
  "devices",
  "billing",
  "storage",
  "invites",
  "security",
  "account",
  "about",
  "help",
] as const;
export type PaneId = (typeof PANE_IDS)[number];
export type SettingsPaneId = PaneId | "calaccounts" | "calview" | "calmail";

/** The menu's three groups, in order. */
export const PANE_GROUPS = ["mail", "account", "about"] as const;
export type PaneGroup = (typeof PANE_GROUPS)[number] | "calendar";

/** What a menu entry says beside its name, from what is already in memory. */
export interface PaneSummary {
  readonly value?: string;
  readonly detail?: string;
  readonly count?: string;
  readonly hot?: boolean;
}

export interface PaneBodyProps {
  readonly plan: LayoutPlan;
  /** The pane's column has the keys. */
  readonly keysHere: boolean;
  /** Provided to a section that owns a toolbar, so its model draws the content and footer together. */
  readonly sheet?: PaneSheet;
  /** The reading column the section's contents already scroll in. */
  readonly scroller?: RefObject<HTMLDivElement | null>;
}

/** Places a section’s scrolling content and its current toolbar in the same reading column. */
export type PaneSheet = (body: ReactNode, foot?: ReactNode) => ReactNode;

export interface SettingsPane {
  readonly id: SettingsPaneId;
  readonly group: PaneGroup;
  readonly icon: IconName;
  /** A key in a catalogue namespace, or the words the host says (the desktop's install names itself). */
  readonly label: { readonly namespace: string; readonly key: string } | { readonly said: string };
  /** Whether the menu lists it, from the host's answers alone. */
  readonly listed: (host: HostContract) => boolean;
  readonly Body: ComponentType<PaneBodyProps>;
  /** This section places its own toolbar in the reading column. */
  readonly hasFoot?: boolean;
  /** Only what is in memory; never a server read for the menu. */
  readonly useSummary?: () => PaneSummary | null;
}

/** Every pane, or `none` where nothing registers it yet. Total: a forgotten id does not compile. */
export type SettingsPanes = Readonly<Record<PaneId, SettingsPane | None>>;

/**
 * What the place around the panes hands them: the way between sections. A pane's own leave hold is part of its model,
 * built by its shell hook.
 */
export interface SettingsBeside {
  /** Go to a section, or to the menu (`null`), through the shell's leave hold. */
  go(pane: SettingsPaneId | null): void;
  /** A link's section, read once. */
  readonly startAt: SettingsPaneId | null;
}
