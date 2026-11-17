import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./dock.css";

/** One place of the dock. */
export interface DockPlace {
  id: string;
  /** Its name: said to a screen reader, and written where the rail is one of words. */
  label: string;
  icon: IconName;
  /** How many are unread or waiting there, as a badge. Zero is no badge at all. */
  count?: string;
  /** Somebody is waiting: the badge is hot. */
  countHot?: boolean;
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
  more: { label: string; current?: boolean; expanded?: boolean; onPress?: () => void };
  /** The way to search. Left out where the host hands no place to search: the dock draws none. */
  search?: { label: string; current?: boolean; onPress?: () => void };
  /** The way to write. Left out where the host hands no place to write: the dock draws none. */
  write?: { label: string; onPress?: () => void };
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
  const rail = useRef<HTMLElement>(null);
  const told = useRef("");
  const tell = useRef(onFit);
  tell.current = onFit;
  /* The way to search and the way to write take room too: the rail fits again when either comes or goes. */
  const searches = Boolean(search);
  const writes = Boolean(write);

  /* Upright, places leave from the end until the rail fits its height. */
  useLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    const fit = () => {
      const entries = [...el.querySelectorAll<HTMLElement>("[data-place]")];
      for (const entry of entries) entry.hidden = false;
      for (let i = entries.length - 1; i >= floor && el.scrollHeight > el.clientHeight + 1; i--)
        entries[i]!.hidden = true;
      const ids = entries.filter((entry) => !entry.hidden).map((entry) => entry.dataset.place ?? "");
      if (ids.join("\n") === told.current) return;
      told.current = ids.join("\n");
      tell.current?.(ids);
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [places, floor, upright, searches, writes]);

  return (
    <nav ref={rail} className="oh-dock" aria-label={label} data-upright={upright ? "" : undefined}>
      {switcher}
      <div className="oh-dock-places">
        {places.map((place, index) => (
          <button
            key={place.id}
            type="button"
            className="oh-control oh-dock-entry"
            data-place={place.id}
            hidden={shown !== undefined && index >= Math.max(shown, floor)}
            aria-current={place.current ? "page" : undefined}
            aria-label={place.count ? `${place.label}, ${place.count}` : place.label}
            title={place.label}
            onClick={place.onPress}
          >
            <Icon name={place.icon} size={20} />
            <span className="oh-dock-word">{place.label}</span>
            {place.count ? (
              <span className="oh-dock-count" data-hot={place.countHot ? "" : undefined}>
                {place.count}
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          className="oh-control oh-dock-entry"
          aria-current={more.current ? "page" : undefined}
          aria-haspopup="menu"
          aria-expanded={more.expanded}
          aria-label={more.label}
          title={more.label}
          onClick={more.onPress}
        >
          <Icon name="more" size={20} />
          <span className="oh-dock-word">{more.label}</span>
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
              <Icon name="write" size={22} />
              <span className="oh-dock-word">{write.label}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
