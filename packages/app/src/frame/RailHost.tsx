/**
 * THE RAIL, drawn with the kit: the places in the app's order, the way to write, and the foot with the one
 * notice slot, Pull new mail and the account. Where a rail stands upright or at the foot it is the kit's
 * dock; its More opens the whole rail over the app. The model is fed (today's views) or built from the
 * places' registrations.
 */
import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { Dock, Rail, RailEntry, RailFoot, type DockPlace } from "@ohmail/ui/mail";
import type {
  FrameCommands,
  FramePlaces,
  LayoutPlan,
  PlaceEntry,
  PlaceId,
  RailEntryModel,
  RailModel,
  Route,
} from "./contract.js";
import { PLACE_IDS, RAIL_GROUPS } from "./contract.js";
import { isCalendarPlace } from "./product.js";
import { useSignal } from "./feeds.js";
import type { Signal } from "../host/index.js";
import { useText, useTextLookup, type Text } from "../text/index.js";

/**
 * A fed entry. It carries the place's id as the drop target today's rows look for (`data-rail-id`, a tag's as
 * `data-rail-tag-id`), on a box that draws nothing, so the kit's entry stays the kit's.
 */
function Entry({ entry, t }: { entry: RailEntryModel; t: Text }) {
  const { id, label, onPress, shortcut, ...drawn } = entry;
  const target = entry.hue !== undefined ? { "data-rail-tag-id": id } : { "data-rail-id": id };
  const box = useRef<HTMLSpanElement>(null);
  useShortcut(() => box.current?.firstElementChild ?? null, shortcut);
  return (
    <span ref={box} className="fr-railtarget" {...target}>
      <RailEntry
        {...drawn}
        onPress={onPress}
        label={entry.count ? t("rail.counted", { place: label, count: entry.count }) : undefined}
      >
        {label}
      </RailEntry>
    </span>
  );
}

/**
 * A control's key, said to a screen reader (`aria-keyshortcuts`), on the kit's control the frame drew: the kit's rail
 * parts take no such attribute of their own yet.
 */
function useShortcut(control: () => Element | null, shortcut: string | undefined): void {
  useLayoutEffect(() => {
    const el = control();
    if (!el || !shortcut) return;
    el.setAttribute("aria-keyshortcuts", shortcut);
    return () => el.removeAttribute("aria-keyshortcuts");
  });
}

/** A registered place's entry: its words are in its own namespace, its count is its own. */
function PlaceRailEntry({
  place,
  current,
  go,
}: {
  place: PlaceEntry;
  current: boolean;
  go: FrameCommands["go"];
}) {
  const t = useText(place.id);
  const tf = useText("frame");
  const rail = place.rail!;
  const counted = rail.useCount?.() ?? null;
  const label = t(rail.label);
  /* The place's id as the drop target a dragged row looks for, as a fed entry carries it. */
  return (
    <span className="fr-railtarget" data-rail-id={place.id}>
      <RailEntry
        kind="place"
        icon={rail.icon}
        keyHint={rail.keyHint}
        count={counted?.count}
        countHot={counted?.hot}
        current={current}
        label={counted ? tf("rail.counted", { place: label, count: counted.count }) : undefined}
        onPress={() => go({ place: place.id })}
      >
        {label}
      </RailEntry>
    </span>
  );
}

/** Mail's places with a rail entry: the frame's places are mail's sixteen, each registered under its own id. */
function registered(places: FramePlaces): (PlaceEntry & { readonly id: PlaceId })[] {
  return Object.values(places).filter(
    (p): p is PlaceEntry & { readonly id: PlaceId } =>
      p !== "none" && p.rail !== null && !isCalendarPlace(p.id),
  );
}

export interface RailHostProps {
  readonly plan: LayoutPlan;
  /** Today's rail as it is fed: read here, so a new feed draws the rail again and nothing else. */
  readonly feed: Signal<RailModel | null>;
  readonly places: FramePlaces;
  readonly route: Route;
  readonly commands: FrameCommands;
  /** The one notice slot, drawn in the rail's foot where a rail stands. */
  readonly notice: ReactNode;
}

/** The rail at the side: words or icons, by the plan. */
export function SideRail({ feed, places, route, commands, notice }: Omit<RailHostProps, "plan">) {
  const model = useSignal(feed);
  const t = useText("frame");
  const zone = useRef<HTMLDivElement>(null);
  const groups: ReactNode[] = model
    ? model.groups.map((group) => (
        <Fragment key={group.id}>
          {group.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} t={t} />
          ))}
          {group.node}
        </Fragment>
      ))
    : RAIL_GROUPS.map((group) => {
        const entries = registered(places).filter((p) => p.rail!.group === group);
        return entries.length ? (
          <Fragment key={group}>
            {entries.map((p) => (
              <PlaceRailEntry key={p.id} place={p} current={p.id === route.place} go={commands.go} />
            ))}
          </Fragment>
        ) : null;
      }).filter(Boolean);
  const pull = model?.pull
    ? {
        label: model.pull.label,
        keyHint: model.pull.keyHint,
        busy: model.pull.busy,
        onPress: model.pull.onPress,
      }
    : undefined;
  /* The kit's foot always draws an account line; where nobody is known the frame draws the notice and Pull alone. */
  const foot = model?.account ? (
    <RailFoot notice={notice} pull={pull} account={model.account} tools={model.tools} />
  ) : (
    <div className="fr-railfoot">
      {notice}
      {pull ? (
        <RailEntry
          kind="tool"
          icon="pull"
          keyHint={pull.keyHint}
          busy={pull.busy}
          title={pull.label}
          onPress={pull.onPress}
        >
          {pull.label}
        </RailEntry>
      ) : null}
    </div>
  );
  const rail = (
    <Rail
      /* While today's rail is fed, the landmark keeps today's name: what a screen reader finds it by. */
      label={t(model ? "landmark.fedRail" : "landmark.places")}
      write={model ? (model.write ?? undefined) : { label: t("dock.write"), onPress: () => commands.write() }}
      groups={groups}
      foot={foot}
    />
  );
  /* A fed rail stands where the feeder's own keys look for it, in a box that draws nothing. The way to write is the
     rail's first button: the frame hands the kit no switch above it. */
  const writeKey = model?.write?.shortcut;
  useShortcut(() => zone.current?.querySelector("nav button") ?? null, writeKey);
  return model?.mark || writeKey ? (
    <div ref={zone} className={model?.mark ? `fr-railzone ${model.mark}` : "fr-railzone"}>
      {rail}
    </div>
  ) : (
    rail
  );
}

/** The dock: the places that have a sign, More (the whole rail over the app), Search and Write. */
/** Every place's words, read in one fixed order (the list never changes while the frame stands). */
function usePlaceWords(): Readonly<Record<PlaceId, Text>> {
  const lookup = useTextLookup();
  return Object.fromEntries(PLACE_IDS.map((id) => [id, lookup(id)])) as Record<PlaceId, Text>;
}

/** The app's tabs: the places a dock at the foot always shows, in this order. The others stand behind More. */
export const DOCK_TABS: readonly string[] = ["ohbox", "screener", "news", "receipts"];

/** Tabs first, in their order; the dock's own Search is not a place of it. */
function docked(list: DockPlace[]): DockPlace[] {
  const rank = (p: DockPlace) => (DOCK_TABS.includes(p.id) ? DOCK_TABS.indexOf(p.id) : DOCK_TABS.length);
  return list.filter((p) => p.id !== "search").sort((a, b) => rank(a) - rank(b));
}

/** The dock: upright beside the columns with every place that fits, or at the foot with the tabs alone. */
export function DockRail({
  feed,
  places,
  route,
  commands,
  upright,
}: Omit<RailHostProps, "plan" | "notice"> & { upright: boolean }) {
  const model = useSignal(feed);
  const t = useText("frame");
  const words = usePlaceWords();
  const fed = model?.groups.flatMap((g) => g.entries).filter((e) => e.kind === "place" && e.icon) ?? [];
  /* A fed entry is a tab by the place it names; its own id stays its own. */
  const tab = (e: RailEntryModel) => e.place ?? e.id;
  const all = docked(
    model
      ? fed.map((e) => ({
          id: tab(e),
          label: e.label,
          icon: e.icon!,
          count: e.count,
          countHot: e.countHot,
          current: e.current,
          onPress: e.onPress,
        }))
      : registered(places).map((p) => ({
          id: p.id,
          label: words[p.id](p.rail!.label),
          icon: p.rail!.icon,
          current: p.id === route.place,
          onPress: () => commands.go({ place: p.id }),
        })),
  );
  const tabs = all.filter((p) => DOCK_TABS.includes(p.id));
  const shown = upright ? all : tabs;
  /* Where the app stands: the place an entry is marked current for, or else the address's. */
  const here = all.find((p) => p.current)?.id ?? route.place;
  /* The keys a fed rail names are said on the dock's Write and Search too: a keyboard is at hand beside the columns. */
  const box = useRef<HTMLSpanElement>(null);
  const searchKey = model?.groups.flatMap((g) => g.entries).find((e) => tab(e) === "search")?.shortcut;
  useShortcut(() => box.current?.querySelector(".oh-dock-write") ?? null, model?.write?.shortcut);
  useShortcut(() => box.current?.querySelector("[data-search]") ?? null, searchKey);
  return (
    <span ref={box} className="fr-railtarget">
      <Dock
        label={t("landmark.places")}
        places={shown}
        floor={upright ? 1 : shown.length}
        more={{
          label: t("dock.more"),
          /* More stands for every place the dock does not show: it is current where the app stands on one. */
          current: here !== "search" && here !== "write" && !shown.some((s) => s.id === here),
          onPress: () => commands.rail(true),
        }}
        search={{
          label: t("dock.search"),
          current: route.place === "search",
          onPress: () => commands.go({ place: "search" }),
        }}
        write={{ label: t("dock.write"), onPress: model?.write?.onPress ?? (() => commands.write()) }}
      />
    </span>
  );
}
