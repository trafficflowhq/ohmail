/**
 * SEARCH'S SEAT: what stands above Search's two columns, and the value of its registration's `Above`. It hands the
 * frame's side and what only a file of this package can read to Search's live hook (`useSearchLive`, called here
 * once), and stands the model, the words beside the list and the reading column's blank (`SearchAbove`). Mounted
 * with Search's columns and unmounted with them. In the shape of the Ohbox's seat.
 *
 * It reads the ground through the live hook's readers and never mounts a piece of it. The field and the scroller are
 * the screen's own: the seat makes their refs and the screen stands them (`model.boxRef`, `model.scrollerRef`).
 */
import { useMemo, useRef, type ReactNode } from "react";
import { useSearchLive, type SearchLiveOwn, type SearchScreenerRow } from "@ohmail/app-logic/search";
import { displayTime, PLACE_LABEL, placeLabel } from "@ohmail/app-logic/text/format";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useFrame } from "../frame/commands.js";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { NONE } from "../host/index.js";
import { useScreener } from "../screener/contract.js";
import { useText, useTimeZone } from "../text/index.js";
import type { SearchBeside } from "./beside.js";
import { blankOf } from "./blank.js";
import { SearchAbove } from "./SearchAbove.js";

/** What only this package can read, as the live hook takes it. */
function useOwn(): SearchLiveOwn {
  const { host } = useFrame();
  const t = useText("search");
  const shortcuts = useText("shortcuts");
  const boxRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  /* The Screener's one model, as the ground stands it: the row that speaks for a sender, read at the press. */
  const screener = useScreener();
  const places = host.features.places;
  const searchBy = host.capabilities.searchBy;
  const junkWire = host.wires.junk !== NONE;
  const zone = useTimeZone();
  return useMemo(
    (): SearchLiveOwn => ({
      t,
      shortcuts,
      boxRef,
      scrollerRef,
      zone,
      searchBy,
      junkWire,
      screenerRows: (segment): readonly SearchScreenerRow[] =>
        segment === "waiting"
          ? screener.waiting
          : segment === "screened"
            ? screener.screenedOut
            : screener.spam.map((r) => r.sender),
      handed: (place) => places[place] !== NONE,
    }),
    [t, shortcuts, zone, searchBy, junkWire, screener, places],
  );
}

export function SearchSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const { plan, commands } = useFrame();
  const t = useText("search");
  const live = useSearchLive(usePlaceLiveArgs(), useOwn());
  const { model, now, placeOf, junk, junkReadable, people } = live;
  const beside: SearchBeside = useMemo(
    () => ({
      words: {
        name: (m) => m.from.name || null,
        address: (m) => displayAddress(m.from.address),
        stamp: (m) => displayTime(m, now),
        /* THE PLACE, NOT THE FOLDER: a letter consent keeps in History is said to be there. */
        place: (m) => {
          const known = placeOf?.has(m.id) === true;
          const presented = known ? placeOf!.get(m.id)! : m.folder;
          return known && presented === null ? t("hitHistory") : placeLabel(presented ?? m.folder);
        },
        placeOfFolder: (key) => PLACE_LABEL[key] ?? key,
      },
      junk: junk ?? NONE,
      junkReadable,
      keysShown: plan.pointer !== "coarse",
      people,
      events: NONE,
      go: { address: (address) => commands.go({ place: "address", sub: address }) },
    }),
    [now, placeOf, t, junk, junkReadable, plan.pointer, people, commands],
  );
  return (
    <SearchAbove model={model} beside={beside} blank={blankOf(model, t)}>
      {children}
    </SearchAbove>
  );
}
