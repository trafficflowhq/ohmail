/**
 * THE FRAME'S CONTRACT: what a place registers, what the frame's parts take, the one order of the
 * notice slot, and the commands between features. Types, three lists and one table; it compiles with
 * no screen present, so a screen task builds on it before the frame's parts exist.
 */
import type { ComponentType, ReactNode } from "react";
import type { IconName, NoticeAct } from "@ohmail/ui/base";
import type { ToastFn } from "@ohmail/app-logic/press";
import type {
  Appearance,
  HostAddress,
  HostContract,
  HostSession,
  LinkedDraft,
  None,
  Pointer,
  Posture,
  WindowFacts,
} from "../host/index.js";

export type { Appearance, Pointer, Posture, WindowFacts };

export const PLACE_IDS = [
  "ohbox",
  "news",
  "receipts",
  "screener",
  "later",
  "parked",
  "resurface",
  "history",
  "drafts",
  "trash",
  "tags",
  "folder",
  "address",
  "search",
  "write",
  "settings",
] as const;
export type PlaceId = (typeof PLACE_IDS)[number];
export const STAGE_IDS = ["firstRun"] as const;
export type StageId = (typeof STAGE_IDS)[number];
export const RAIL_GROUPS = ["main", "later", "more", "tags", "folders"] as const;
export type RailGroupId = (typeof RAIL_GROUPS)[number];

/** The place a person is in: one object. The shell's address door carries it; a feature never reads the address. */
export interface Route {
  readonly place: AnyPlaceId;
  /** The place's own word: a Screener segment, a tag's, folder's or correspondent's id, a Settings pane. */
  readonly sub: string | null;
  /** The letter open in it. */
  readonly open: string | null;
  readonly stage: { readonly id: AnyStageId; readonly words: Readonly<Record<string, string>> } | null;
  readonly words: Readonly<Record<string, string>>;
}
export type RouteTarget = Pick<Route, "place"> & Partial<Omit<Route, "place">>;

export type SizeClass = "compact" | "medium" | "expanded";
export interface LayoutPlan {
  readonly size: SizeClass;
  readonly short: boolean;
  readonly pointer: Pointer;
  readonly device: "desktop" | "fold" | "phone";
  readonly pose: "land" | null;
  readonly rail: "words" | "icons" | "dock";
  readonly columns: 1 | 2;
  readonly handles: boolean;
}
export interface PaneProps {
  readonly route: Route;
  readonly plan: LayoutPlan;
  readonly keysHere: boolean;
}

export interface PlaceRail {
  readonly group: RailGroupId;
  readonly icon: IconName;
  /** A key in the place's namespace. */
  readonly label: string;
  readonly keyHint?: string;
  readonly useCount?: () => { readonly count: string; readonly hot: boolean } | null;
}
/**
 * A place's panes. `List` draws on the frame's list sheet beside a rail or an upright dock (a sheet never lies
 * on a sheet), and on the ground on a phone's width (`plan.device === "phone"`), where it lays its rows' own.
 * `Reading` and `Wide` draw their own sheets.
 */
export type PlacePanes =
  | {
      readonly kind: "columns";
      readonly List: ComponentType<PaneProps>;
      readonly Reading: ComponentType<PaneProps> | "reader";
      /** An own `Reading` whose verbs go through the frame's one press seam asks for the room (where a reader is). */
      readonly room?: true;
      /**
       * `always`: the reading column stands and has the keys whatever is open, and on a phone it stands over the list
       * with no dock at the foot (a letter being written is the place's whole point). Left out: by the open letter.
       */
      readonly holds?: "always";
      /** What the place stands above both of its columns and nothing else: mounted with them, unmounted with them. */
      readonly Above?: ComponentType<{ readonly children: ReactNode }>;
      /**
       * The place keeps its open letter over a walk to another place and back: the frame remembers the last letter
       * open here for the frame's life and opens it again when a `go` to this place names none, at two columns only,
       * never on one. `open(null)` forgets it. It is never stored, and never carried into another scope.
       */
      readonly keepsOpen?: true;
    }
  | {
      readonly kind: "wide";
      readonly Wide: ComponentType<PaneProps>;
      /**
       * This body is mounted with the frame and stays mounted, hidden and inert, while a place of another body is on
       * screen. At most one entry's body in a host's `places` is kept.
       */
      readonly kept?: true;
    };
/** A place's registration. Places with one `body` share one mounted instance (today's views: "today"). */
export interface PlaceEntry {
  readonly id: AnyPlaceId;
  readonly body: string;
  readonly rail: PlaceRail | null;
  readonly panes: PlacePanes;
}
export interface StageEntry {
  readonly id: AnyStageId;
  readonly Body: ComponentType<PaneProps>;
}
export type FramePlaces = Readonly<Record<PlaceId, PlaceEntry | None>>;
export type FrameStages = Readonly<Record<StageId, StageEntry | None>>;

/** The address bar the frame reads and writes the fragment through (the host's `device.address`). */
export type FrameAddress = HostAddress;
/** The way back to a live session (the host's `session.recover`). `none` withholds the control. */
export type Recover = HostSession["recover"];
/** The frame's host is the contract: places and stages are its features, the address, window and look its device. */
export type FrameHost = HostContract;

export interface ColumnsProps {
  readonly plan: LayoutPlan;
  readonly rail: ReactNode;
  readonly list: ReactNode;
  /** The list has the keys: the face that rings the column with the keyboard rings the list's sheet. */
  readonly listKeys: boolean;
  readonly reading: ReactNode;
  /** A wide pane on screen whose body is not kept. */
  readonly wide: ReactNode | null;
  /** The kept body's pane, drawn at one position whether it is on screen or hidden; null where no body is kept. */
  readonly kept: { readonly pane: ReactNode; readonly shown: boolean } | null;
  /** What the place on screen stands above both of its columns, with the body it is mounted for; null where none. */
  readonly above: {
    readonly Above: ComponentType<{ readonly children: ReactNode }>;
    readonly body: string;
  } | null;
  readonly labels: {
    readonly list: string;
    readonly reading: string;
    readonly railWidth: string;
    readonly listWidth: string;
  };
}
export interface StageProps {
  readonly open: boolean;
  readonly label: string;
  readonly children: ReactNode;
}
export interface RailEntryModel {
  readonly id: string;
  /** The place the entry stands for where its id is not the place's (today's News is fed as `reads`). */
  readonly place?: PlaceId;
  readonly kind: "place" | "sub" | "fold" | "tool";
  readonly label: string;
  readonly icon?: IconName;
  readonly hue?: number;
  readonly count?: string;
  readonly countHot?: boolean;
  readonly keyHint?: string;
  /** The key also stands at rest in the face that prints keys on its controls (Search's `/`). */
  readonly keyStands?: boolean;
  /** Its key in `aria-keyshortcuts`' own spelling ("/", "Shift+F"): said to a screen reader on the entry. */
  readonly shortcut?: string;
  readonly current?: boolean;
  readonly expanded?: boolean;
  readonly depth?: number;
  readonly title?: string;
  readonly onPress: () => void;
}
export interface RailModel {
  readonly groups: readonly {
    readonly id: string;
    readonly entries: readonly RailEntryModel[];
    readonly node?: ReactNode;
  }[];
  readonly write: {
    readonly label: string;
    readonly keyHint?: string;
    /** Its key in `aria-keyshortcuts`' own spelling ("c"): said to a screen reader on the way to write. */
    readonly shortcut?: string;
    readonly onPress: () => void;
  } | null;
  /** The account's line in the rail's foot; null while nobody is known, and the line is withheld. */
  readonly account: {
    readonly name: string;
    readonly address: string;
    readonly note: string;
    readonly title: string;
    readonly onPress: () => void;
  } | null;
  readonly pull: {
    readonly label: string;
    readonly keyHint?: string;
    readonly busy: boolean;
    readonly onPress: () => void;
  } | null;
  /** The quiet tools at the end of the account's line (the command palette, the light and dark switch), as given. */
  readonly tools?: readonly {
    readonly icon: IconName;
    /** Its name, with its key where it has one: "Command palette · Ctrl K". */
    readonly label: string;
    readonly onPress?: () => void;
  }[];
  /**
   * The classes a shell's own key model finds the rail by while it feeds it (today's views: `rail open`). The rail
   * then stands in a box that carries them and draws nothing.
   */
  readonly mark?: string;
}

/**
 * THE ONE ORDER of the notice slot. Lower stands in front. Taken from the simulation's table; the kinds
 * marked * are the shipped app's alone, placed beside their nearest drawn neighbour.
 */
export const NOTICE_RANK = {
  signedOut: 0,
  ownerLost: 1, // *
  noMailbox: 5,
  offline: 10,
  hostQuiet: 11, // *
  mailServerDown: 12,
  reconnecting: 14,
  late: 15, // *
  mailboxPassword: 20,
  mailboxSync: 22,
  notSent: 28,
  sentCopy: 29,
  unsaved: 30,
  notKept: 31, // *
  organizingStopped: 40,
  notOrganizing: 41,
  filingStopped: 42,
  waiting: 43,
  organizedElsewhere: 44,
  reader: 45,
  filingElsewhere: 46,
  gap: 47,
  unscreened: 48,
  filingStuck: 49,
  filingWaits: 50,
  mailboxFull: 60,
  storageFull: 61,
  storage: 62,
  payment: 70,
  grace: 71,
  trial: 72,
  update: 80,
  settingsFound: 81,
  away: 82,
  noMail: 83,
  signInCopies: 84,
  ohmarchy: 85,
  caughtUp: 86,
  sending: 89, // *
  behind: 90,
  firstSync: 91,
  filing: 92,
  desktopOffer: 95, // *
} as const;
export type NoticeKind = keyof typeof NOTICE_RANK;
export interface FrameNotice {
  readonly kind: NoticeKind;
  /** Where one kind stands more than once (one per mailbox): what tells them apart. */
  readonly id?: string;
  readonly title: string;
  readonly hot?: boolean;
  readonly line?: string;
  readonly acts?: readonly [NoticeAct] | readonly [NoticeAct, NoticeAct];
}

/** The few named commands between features. Nothing else crosses a feature's border. */
export interface FrameCommands {
  go(to: RouteTarget): void;
  open(letter: string | null): void;
  write(draft?: LinkedDraft): void;
  rail(open: boolean): void;
  /** A body that stands over the app (a stage not yet registered) holds the frame inert. */
  hold(held: boolean): void;
}
export interface FrameApi {
  readonly host: FrameHost;
  readonly route: Route;
  readonly plan: LayoutPlan;
  readonly commands: FrameCommands;
  readonly report: ToastFn;
}

/*
 * THE NAMESPACE RULE.
 * - A feature reads `useText("<its PlaceId>")` and `useText("shared")`, and nothing else.
 * - Its sentences are `packages/app/messages/<its PlaceId>.en.json` and `.de.json`, both in the same change.
 * - Keys are `thing.state` under that namespace.
 * - It never edits another place's file, `order.json` or the aggregates by hand: it runs
 *   `node packages/app/scripts/catalogue.mjs --write`.
 * - The frame's namespace is `frame`. Reason words are `reason.<list>.<word>` in `reasons.*.json`, which
 *   counts as the core's side.
 */

/*
 * THE CALENDAR'S PART of the contract. A second list of places beside mail's sixteen (which stay as they are), the
 * stage and panels the calendar's root registers, and the one command that opens an event from any view. The
 * calendar's root export (`@ohmail/app/calendar`) is one `CalendarEntry`; a shell hands it in as
 * `FrameSupplies.calendar`, or `none`, and a shell that hands in `none` downloads none of it.
 *
 * In a calendar place the route's fields read: `sub` the anchor day `YYYY-MM-DD` (null: today), or the section in
 * `calsettings`; `open` the event's id, or `eventId@occurrenceKey` for one day of a series; `words.panel` a
 * `CalendarPanelId`; `words.q` the search's words.
 *
 * The calendar reads the namespaces `calendar`, each place's own id, and `event`.
 */
export const CALENDAR_PLACE_IDS = [
  "week",
  "day",
  "month",
  "year",
  "agenda",
  "calsearch",
  "frommail",
  "calsettings",
] as const;
export type CalendarPlaceId = (typeof CALENDAR_PLACE_IDS)[number];
export type AnyPlaceId = PlaceId | CalendarPlaceId;
export const CALENDAR_STAGE_IDS = ["calSetup"] as const;
export type CalendarStageId = (typeof CALENDAR_STAGE_IDS)[number];
export type AnyStageId = StageId | CalendarStageId;
export const CALENDAR_PANEL_IDS = ["agenda", "invitations"] as const;
export type CalendarPanelId = (typeof CALENDAR_PANEL_IDS)[number];
export const PRODUCTS = ["mail", "cal"] as const;
export type Product = (typeof PRODUCTS)[number];

/** One event as a view names it: the event, the day of a series it stands for (null: not a series), and its day. */
export interface EventRef {
  readonly event: string;
  readonly occurrence: string | null;
  /** `YYYY-MM-DD`: the day the view goes to when it opens the event. */
  readonly day: string;
}
/** What the calendar's rail takes, in the plan's form; the switch and the notice slot are the frame's. */
export interface CalendarRailProps {
  readonly plan: LayoutPlan;
  readonly form: "words" | "icons" | "dock";
  readonly route: Route;
  readonly commands: FrameCommands;
  readonly switcher: ReactNode;
  readonly notice: ReactNode;
}
export interface CalendarPanelProps extends PaneProps {
  readonly onClose: () => void;
}
/** The calendar's registration: the root export is one of these. Each slot is the entry or `none`. */
export interface CalendarEntry {
  readonly places: Readonly<Record<CalendarPlaceId, PlaceEntry | None>>;
  readonly stage: StageEntry | None;
  readonly panels: Readonly<Record<CalendarPanelId, ComponentType<CalendarPanelProps> | None>>;
  readonly Rail: ComponentType<CalendarRailProps>;
  /** What stands above the columns while the switch is shown (the calendar's port and keys). */
  readonly Above: ComponentType<{ readonly children: ReactNode }>;
  /** Whether the calendar side has something waiting for the person (the switch's dot). */
  readonly useWants: () => boolean;
}

/* Declaration merging keeps the calendar's two members in this block of their own. */
export interface FrameCommands {
  /**
   * Opens an event, or closes the open one (`null`). In a calendar place it writes the open event into the route; in
   * a mail place it goes to the calendar's place with the event's day. It does nothing where the switch is absent.
   */
  event(ref: EventRef | null): void;
}
export interface FrameApi {
  /** The product the route stands in. */
  readonly product: Product;
}
