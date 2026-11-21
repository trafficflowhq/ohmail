/**
 * THE FRAME'S CONTRACT: what a place registers, what the frame's parts take, the one order of the
 * notice slot, and the commands between features. Types, three lists and one table; it compiles with
 * no screen present, so a screen task builds on it before the frame's parts exist.
 */
import type { RailFootModel } from "./rail-model.js";
import type { ComponentType, ReactNode } from "react";
import type { IconName } from "@ohmail/ui/base";
import type { DisabledReason } from "@ohmail/app-logic/keys";
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
import type { OverId } from "./over-contract.js";
export type { Appearance, Pointer, Posture, WindowFacts };
export * from "./notice-contract.js";
export * from "./over-contract.js";

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
/** The rail's groups, in the order the rail draws them: the Screener stands in a group of its own. */
export const RAIL_GROUPS = ["main", "screener", "later", "tags", "folders", "more"] as const;
export type RailGroupId = (typeof RAIL_GROUPS)[number];
/**
 * THE RAIL'S ORDER of the places, taken from the simulation's rail: in its group, in the dock and behind More a
 * place stands where this list has it, whatever order a host's record names its places in.
 */
export const RAIL_ORDER: readonly PlaceId[] = [
  "ohbox",
  "news",
  "receipts",
  "screener",
  "later",
  "parked",
  "resurface",
  "tags",
  "folder",
  "history",
  "search",
  "drafts",
  "trash",
  "address",
  "write",
  "settings",
];

/** The place a person is in: one object. The shell's address door carries it; a feature never reads the address. */
export interface Route {
  readonly place: AnyPlaceId;
  /** The place's own word: a Screener segment, a tag's, folder's or correspondent's id, a Settings pane. */
  readonly sub: string | null;
  /** The letter open in it. */
  readonly open: string | null;
  /** The address names a conversation by a member, without choosing that member for reading. */
  readonly wholeThread?: true;
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
  readonly ribbon?: "push" | "split";
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
  /**
   * The keys that go there, as they are printed. Where they are `g` and one more key ("g o"), the frame binds them
   * to the place for its life, and no two places of a host may print the same. Any other key ("/") is printed here
   * and bound by whoever owns it.
   */
  readonly keyHint?: string;
  /**
   * A key in the `shortcuts` namespace: what the keys do, as the key sheet lists them ("Go to the Ohbox"). Left out,
   * the sheet lists the place by its own label.
   */
  readonly keyLabel?: string;
  /** The key also stands at rest in the face that prints keys on its controls (Search's `/`). */
  readonly keyStands?: true;
  /** Show the rail entry only in its own place. The shortcut and palette remain available elsewhere. */
  readonly whileOpen?: true;
  /** The reason the destination's shortcut and palette offer are unavailable on this host. */
  readonly navigationRefusal?: (host: HostContract) => DisabledReason | undefined;
  readonly useCount?: () => { readonly count: string; readonly hot: boolean; readonly title?: string } | null;
  /** A letter dropped here files so (`move:reads`, `later`): the list runs its own verb (`rail-drag.ts`). None: no drop. */
  readonly drop?: import("@ohmail/app-logic/lists/drag-source").PileDropAction;
}
/**
 * A rail group a place draws itself: a line that folds and what stands under it (the tags; the folders). The frame
 * draws `Body` in that group, after the group's entries, wherever the whole rail stands: at the side and behind More,
 * never in the dock. `Body` draws with the kit's rail entries, reads `useFrame()` and the ground, and keeps what it
 * keeps (a fold shut or open) itself.
 */
export interface PlaceRailGroup {
  readonly group: RailGroupId;
  readonly Body: ComponentType;
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
       * open here (by the place's own word, where it has one) for the frame's life and opens it again when a `go` to
       * this place names none, at two columns only, never on one. A `go` that says `open: null` asks for the list
       * alone. Closing the letter forgets it, by `open(null)` or by an address that names none. It is never stored,
       * and never carried into another scope.
       */
      readonly keepsOpen?: true;
    }
  | {
      readonly kind: "wide";
      readonly Wide: ComponentType<PaneProps>;
    };
/** A place's registration. Places with one `body` share one mounted instance (today's views: "today"). */
export interface PlaceEntry {
  readonly id: AnyPlaceId;
  readonly body: string;
  /** List rows can name the mailbox that received a letter. */
  readonly rowMailboxLabels?: true;
  /** Its entry in the rail, or null: a place the rail names by no entry. */
  readonly rail: PlaceRail | null;
  /** The rail group it draws itself, where it draws one ({@link PlaceRailGroup}). */
  readonly railGroup?: PlaceRailGroup;
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
  /** An open sheet leaves the list visible under a scrim. */
  readonly readingBackdrop?: boolean;
  /** A wide pane on screen. */
  readonly wide: ReactNode | null;
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
export type { RailEntryModel, RailFootModel, RailModel } from "./rail-model.js";

export { NOTICE_RANK, type NoticeKind } from "./notice-rank.js";

/**
 * How a place is gone to, beside where. `entered`: the letter it names is opened as ENTERED (a hit a person chose),
 * taken once by the place that lists it (`useEntered`); never in the address, so a reload, Back or a stored link
 * reads nothing. `replace`: the address is replaced, not pushed, and Back does not come back to the one it replaced.
 */
export interface GoHow {
  /** Opening a dialog remembers its history entry. Dismiss returns to its opener, or uses the given route for a direct link. */
  readonly history?: "open-dialog" | "dismiss-dialog";
  readonly entered?: true;
  readonly replace?: true;
}

/** The few named commands between features. Nothing else crosses a feature's border. */
export interface FrameCommands {
  go(to: RouteTarget, how?: GoHow): void;
  open(letter: string | null, how?: "replace", wholeThread?: true): void;
  closeAddress(): void;
  closeSearch(): void;
  write(draft?: LinkedDraft): void;
  rail(open: boolean): void;
  /** A body that stands over the app (a stage not yet registered) holds the frame inert. */
  hold(held: boolean): void;
  /** Stand one over (closing any other), or none. `go` closes it. */
  over(id: OverId | null): void;
}
export interface FrameApi {
  readonly host: FrameHost;
  readonly route: Route;
  readonly plan: LayoutPlan;
  readonly commands: FrameCommands;
  readonly report: ToastFn;
  /** The over that stands now, or null. */
  readonly over: OverId | null;
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
  readonly accountFoot?: RailFootModel | null;
}
export interface CalendarPanelProps extends PaneProps {
  readonly onClose: () => void;
}
/** The calendar's registration: the root export is one of these. Each slot is the entry or `none`. */
export interface CalendarEntry {
  /** A host without the Calendar product may open one validated notification destination. */
  readonly notice?: { readonly fragment: string; readonly place: PlaceEntry };
  readonly places: Readonly<Record<CalendarPlaceId, PlaceEntry | None>>;
  readonly stage: StageEntry | None;
  readonly panels: Readonly<Record<CalendarPanelId, ComponentType<CalendarPanelProps> | None>>;
  readonly Rail: ComponentType<CalendarRailProps>;
  /** What stands above the columns while the switch is shown (the calendar's port and keys). */
  readonly Above: ComponentType<{ readonly children: ReactNode }>;
  /** Whether the calendar side has something waiting for the person (the switch's dot). */
  readonly useWants: () => boolean;
  /** Whether to show the product switch once the host can offer Calendar. */
  readonly useSwitchOffered?: () => boolean;
  /** A destination that supersedes the remembered view while the calendar needs setup. */
  readonly useSwitchHome?: () => CalendarPlaceId | undefined;
}

/* Declaration merging keeps the calendar's two members in this block of their own. */
export interface FrameCommands {
  /**
   * Opens an event, or closes the open one (`null`). In a calendar place it writes the open event into the route; in
   * a mail place it goes to the calendar's place with the event's day. It does nothing where the switch is absent.
   */
  event(ref: EventRef | null): void;
  switchProduct(to: Product, calendarHome?: CalendarPlaceId): void;
  closeCalendarSettings(): void;
}
export interface FrameApi {
  /** The product the route stands in. */
  readonly product: Product;
  readonly previousProduct?: Product;
}
