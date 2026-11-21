import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import { KeyHint } from "../../base/Primitives/KeyHint.js";
import "./dock.css";

/** One place of the dock. */
export interface DockPlace {
  id: string;
  /** Its name: said to a screen reader, and written where the rail is one of words. */
  label: string;
  icon: IconName;
  /** The tab is named in words on the dock, even where the other tabs are icons. */
  words?: boolean;
  /** How many are unread or waiting there, as a badge. Zero is no badge at all. */
  count?: string;
  /** Somebody is waiting: the badge is hot. */
  countHot?: boolean;
  /** The registration's live count, read beside its own button. */
  useCount?: () => { readonly count: string; readonly hot: boolean } | null;
  current?: boolean;
  onPress?: () => void;
}

export interface DockProps {
  /** The landmark's name: "Places". */
  label: string;
  /** The places, in the rail's order. The first `floor` never leave. */
  places: readonly DockPlace[];
  /** How many places always stand: the tabs of the app. */
  floor: number;
  /** The rest of the places, behind one entry. It is the current one while the open place stands behind it. */
  more: Pick<DockPlace, "label" | "current" | "count" | "countHot" | "onPress"> & {
    expanded?: boolean;
    drawer?: boolean;
  };
  /** The way to search. Left out where the host hands no place to search: the dock draws none. */
  search?: { label: string; current?: boolean; keyHint?: string; onPress?: () => void };
  /** The way to write. Left out where the host hands no place to write: the dock draws none. */
  write?: { label: string; icon?: IconName; keyHint?: string; onPress?: () => void };
  /** The way to the other product, where the rail stands upright: the round button, first. */
  switcher?: ReactNode;
  /**
   * One column in a low room: the dock stands upright beside the column, as it does beside two. The frame says so
   * from the room it laid out; the window's height alone never turns it.
   */
  upright?: boolean;
  /** How many places stand before the rail has measured its height. Left out: all of them. */
  shown?: number;
  /** The places that stand, whenever that changes: the app puts the others behind More. */
  onFit?: (ids: readonly string[]) => void;
}

const useNoCount = () => null;

function DockEntry({ place, hidden }: { place: DockPlace; hidden: boolean }) {
  const useCount = place.useCount ?? useNoCount;
  const counted = useCount();
  const count = counted?.count ?? place.count;
  const hot = counted?.hot ?? place.countHot;
  return (
    <button
      type="button"
      className="oh-control oh-dock-entry"
      data-place={place.id}
      data-words={place.words ? "" : undefined}
      hidden={hidden}
      aria-current={place.current ? "page" : undefined}
      aria-label={count ? `${place.label}, ${count}` : place.label}
      title={place.label}
      onClick={place.onPress}
    >
      {place.words ? null : <Icon name={place.icon} size={20} />}
      <span className="oh-dock-word">{place.label}</span>
      {count ? (
        <span className="oh-dock-count" data-hot={hot ? "" : undefined}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

function useDockFit({
  places,
  floor,
  shown,
  onFit,
  searches,
  writes,
  round,
}: Pick<DockProps, "places" | "floor" | "shown" | "onFit"> & {
  searches: boolean;
  writes: boolean;
  round: boolean;
}) {
  const rail = useRef<HTMLElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const told = useRef("");
  const [foldedCurrent, setFoldedCurrent] = useState(false);
  const tell = useRef(onFit);
  tell.current = onFit;
  /* The way to search and the way to write take room too: the rail fits again when either comes or goes. */

  /* Places leave from the end until the upright rail or the circular dock fits. */
  useLayoutEffect(() => {
    const el = rail.current;
    const row = strip.current;
    if (!el || !row) return;
    const fit = () => {
      const entries = [...el.querySelectorAll<HTMLElement>("[data-place]")];
      const limit = shown === undefined ? entries.length : Math.max(shown, floor);
      const across = round && getComputedStyle(el).flexDirection === "row";
      const tooSmall = () =>
        across ? row.scrollWidth > row.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
      entries.forEach((entry, index) => {
        entry.hidden = index >= limit;
      });
      for (let i = Math.min(limit, entries.length) - 1; i >= floor && tooSmall(); i--)
        entries[i]!.hidden = true;
      setFoldedCurrent(
        entries.some((entry) => entry.hidden && entry.getAttribute("aria-current") === "page"),
      );
      const ids = entries.filter((entry) => !entry.hidden).map((entry) => entry.dataset.place ?? "");
      if (ids.join("\n") === told.current) return;
      told.current = ids.join("\n");
      tell.current?.(ids);
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    watch.observe(row);
    return () => watch.disconnect();
  }, [places, floor, round, shown, searches, writes]);

  return { rail, strip, foldedCurrent };
}

/** The rail on touch: the app's tabs, More, and Search and Write where the host has them. Upright on an unfolded phone, with every place that fits. */
export function Dock({
  label,
  places,
  floor,
  more,
  search,
  write,
  switcher,
  upright,
  shown,
  onFit,
}: DockProps) {
  const round = more.drawer === true && !upright;
  const { rail, strip, foldedCurrent } = useDockFit({
    places,
    floor,
    shown,
    onFit,
    searches: Boolean(search),
    writes: Boolean(write),
    round,
  });
  return (
    <nav
      ref={rail}
      className="oh-dock"
      aria-label={label}
      data-upright={upright ? "" : undefined}
      data-drawer-dock={more.drawer ? "" : undefined}
      data-round={round ? "" : undefined}
    >
      {switcher}
      <div className="oh-dock-places" ref={strip}>
        {places.map((place, index) => (
          <DockEntry
            /* A registered hook belongs to its own mount, separate from an entry with a supplied count. */
            key={`${place.id}:${place.useCount !== undefined}`}
            place={place}
            hidden={shown !== undefined && index >= Math.max(shown, floor)}
          />
        ))}
        <button
          type="button"
          className="oh-control oh-dock-entry"
          aria-current={more.current || foldedCurrent ? "page" : undefined}
          data-drawer-toggle={more.drawer ? "" : undefined}
          aria-haspopup={more.drawer ? "dialog" : "menu"}
          aria-expanded={more.drawer ? undefined : more.expanded}
          aria-label={more.count ? `${more.label}, ${more.count}` : more.label}
          title={more.label}
          onClick={more.onPress}
        >
          <Icon name="more" size={20} />
          <span className="oh-dock-word">{more.label}</span>
          {more.count ? (
            <span className="oh-dock-count" data-hot={more.countHot ? "" : undefined}>
              {more.count}
            </span>
          ) : null}
        </button>
      </div>
      {search || write ? (
        <div className="oh-dock-end">
          {search ? (
            <button
              type="button"
              className="oh-control oh-dock-entry"
              data-search=""
              aria-current={search.current ? "page" : undefined}
              aria-label={search.label}
              title={search.label}
              onClick={search.onPress}
            >
              <Icon name="search" size={20} />
              <span className="oh-dock-word">{search.label}</span>
              {search.keyHint ? (
                <KeyHint shown unsaid>
                  {search.keyHint}
                </KeyHint>
              ) : null}
            </button>
          ) : null}
          {write ? (
            <button
              type="button"
              className="oh-control oh-dock-write"
              aria-label={write.label}
              title={write.label}
              onClick={write.onPress}
            >
              <Icon name={write.icon ?? "write"} size={22} />
              <span className="oh-dock-word">{write.label}</span>
              {write.keyHint ? (
                <KeyHint shown unsaid>
                  {write.keyHint}
                </KeyHint>
              ) : null}
            </button>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
