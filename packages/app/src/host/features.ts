import type { ComponentType, ReactNode } from "react";
import type { SenderSuggestion } from "@ohmail/app-logic/screener/screener-suggest";
import type { ConversationShown } from "@ohmail/app-logic/reader";
import type { EngineMessage } from "@ohmail/wire";
import type { MessageClip, MessageHeadProps } from "@ohmail/ui/mail";
import type { CalendarEntry, FrameNotice, FrameOvers, FramePlaces, FrameStages, PaneProps } from "../frame/contract.js";
import type { HeldParts } from "../screener/ports.js";
import type { ContactScreeningProps } from "../reader/contact/Contact.js";
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

export interface OwnSuggestionProps {
  readonly senders: string[];
  readonly absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
}

export interface ScreenerEntry extends FeatureEntry {
  /** The unmetered control over a model configured on this computer, sharing the Screener's queue and overlay. */
  readonly ownSuggest?: (props: OwnSuggestionProps) => ReactNode;
}

/**
 * The reading column a shell imports (`@ohmail/app/reader`) and hands over: the frame draws `Reading` where a place's
 * panes say `Reading: "reader"`, and never imports it.
 */
export interface ReaderEntry {
  readonly Reading: ComponentType<PaneProps>;
  /** The shared header for a folded stream card, with no body or file access. */
  readonly PreviewHead?: ComponentType<{
    message: EngineMessage;
    hideBodyNotice?: boolean;
    selection?: MessageHeadProps["selection"];
  }>;
  /** The cached markup of a folded card, with remote pictures and reader actions unavailable. */
  readonly PreviewBody?: ComponentType<{ message: EngineMessage; children: ReactNode }>;
  readonly Screening?: ComponentType<ContactScreeningProps>;
  readonly copy?: (text: string) => Promise<boolean>;
  /** The whole letter, with its pictures and files, inside a stream card the person opened. */
  readonly OpenCard?: ComponentType<{
    message: EngineMessage;
    opened: boolean;
    clip?: MessageClip;
    conversation?: ConversationShown;
    scroller?: HTMLElement | null;
    onEnter?: () => void;
  }>;
  /** The same body, pictures and files used to show a held letter. */
  readonly useHeldParts?: () => HeldParts;
  /** The action panel for one letter, where a list draws a letter in place. */
  readonly Actions: ComponentType<{
    readonly messageId: string;
    /** The stream's immediate Delete shortcut follows its keyboard selection. */
    readonly deleteKeyId?: string;
    readonly canDeleteKey?: (id: string) => boolean;
    readonly canAnswerKey?: (id: string) => boolean;
    readonly keysHere?: boolean;
    readonly focus?: boolean;
    readonly showPanel?: boolean;
    readonly markUnread?: (id: string) => void;
  }>;
  /** The writing surface under the selected letter where a place draws its own cards. */
  readonly useInlineReply?: (
    items: readonly EngineMessage[],
  ) => {
    readonly messageId: string | null;
    readonly sheet: (keysHere: boolean) => ReactNode;
    readonly conversations: ReadonlyMap<string, ConversationShown>;
  } | null;
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
  readonly screener: ScreenerEntry | None;
  /** The bodies that stand over the app. */
  readonly stages: FrameStages;
  /** The reading column, or `none`: a place that names it then draws an empty column. */
  readonly reader: ReaderEntry | None;
  /**
   * What a shell stands above every pane, once per mounted frame, under the scope: the providers its places read.
   * `none`: nothing stands there (a host with no old shell; the fake host).
   */
  readonly above: ComponentType<{ readonly children: ReactNode }> | None;
  /** What stands over every place (the palette, the key sheet), each the entry it imports or `none`. */
  readonly overs: FrameOvers;
  /** The calendar's root export (`@ohmail/app/calendar`), handed in by a shell that mounts it; `none`: no calendar here. */
  readonly calendar: CalendarEntry | None;
};
