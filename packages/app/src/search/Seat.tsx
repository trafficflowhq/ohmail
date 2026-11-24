/**
 * SEARCH'S SEAT: what stands above Search's two columns, and the value of its registration's `Above`. It hands the
 * frame's side and what only a file of this package can read to Search's live hook (`useSearchLive`, called here
 * once), and stands the model, the words beside the list and the reading column's blank (`SearchAbove`). Mounted
 * with Search's columns and unmounted with them. In the shape of the Ohbox's seat.
 *
 * It reads the ground through the live hook's readers and never mounts a piece of it. The field and the scroller are
 * the screen's own: the seat makes their refs and the screen stands them (`model.boxRef`, `model.scrollerRef`).
 */
import type { EngineMessage } from "@ohmail/wire";
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchLive, type SearchBy, type SearchLiveOwn } from "@ohmail/app-logic/search";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { displayTime, PLACE_LABEL, placeLabel } from "@ohmail/app-logic/text/format";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useFrame, useSearchQuery } from "../frame/commands.js";
import { ListMoveContext, type ListMove } from "@ohmail/app-logic/reading";
import { usePlaceVerbs } from "@ohmail/app-logic/place-list";
import { usePlaceListOwn } from "../place-list/own.js";
import { useRoomHolds } from "../frame/room.js";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { NONE } from "../host/index.js";
import { useText, useTimeZone } from "../text/index.js";
import { useCalendarMatches } from "../calendar/mail-search.js";
import type { SearchBeside } from "./beside.js";
import { blankOf } from "./blank.js";
import { SearchAbove } from "./SearchAbove.js";

/** A remote native host may discover its server's capability when Search opens. */
function useSearchBy(by: SearchBy | (() => Promise<SearchBy>)): SearchBy {
  const read = typeof by === "function" ? by : undefined;
  const [answer, setAnswer] = useState<{ read: typeof read; value: SearchBy }>();
  useEffect(() => {
    if (!read) return;
    let current = true;
    void read().then(
      (value) => {
        if (current) setAnswer({ read, value });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [read]);
  if (typeof by === "string") return by;
  return answer && answer.read === read ? answer.value : "words";
}

/** What only this package can read, as the live hook takes it. */
function useOwn(): SearchLiveOwn {
  const { host, commands } = useFrame();
  const rememberedQuery = useSearchQuery();
  const holds = useRoomHolds();
  const t = useText("search");
  const shortcuts = useText("shortcuts");
  const boxRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const supply = host.capabilities.searchBy;
  const searchBy = useSearchBy(typeof supply === "object" ? supply.by : supply);
  const junkWire = host.wires.junk !== NONE;
  const readMailboxTotal = typeof supply === "object" ? supply.mailboxTotal : undefined;
  const zone = useTimeZone();
  return useMemo(
    (): SearchLiveOwn => ({
      t,
      shortcuts,
      rememberedQuery,
      holds,
      exit: commands.closeSearch,
      boxRef,
      scrollerRef,
      zone,
      searchBy,
      junkWire,
      readMailboxTotal,
    }),
    [t, shortcuts, rememberedQuery, holds, commands, zone, searchBy, junkWire, readMailboxTotal],
  );
}

export function SearchSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const { plan, commands, route } = useFrame();
  useSwitchEnded(route, true);
  const t = useText("search");
  const args = usePlaceLiveArgs();
  const own = useOwn();
  const live = useSearchLive(args, own);
  const heldPlaces = own.holds.places;
  const { model, archiveHit, now, placeOf, junk, junkReadable, people } = live;
  const { length, slotAt } = model;
  const events = useCalendarMatches();
  const surface = useMemo(() => {
    const rows: EngineMessage[] = [];
    for (let i = 0; i < length; i++) {
      const slot = slotAt(i);
      if (slot.kind === "hit") rows.push(slot.hit.message);
    }
    return rows;
  }, [length, slotAt]);
  const { verbs } = usePlaceVerbs(args, usePlaceListOwn(), surface);
  const { onMessageAction } = verbs;
  const move: ListMove = useStableCallback<ListMove>((message, destination) =>
    onMessageAction(`move:${destination}`, message, "letter"),
  );
  const beside: SearchBeside = useMemo(
    () => ({
      selection: { rows: surface, verbs },
      words: {
        name: (m) => m.from.name || null,
        address: (m) => displayAddress(m.from.address),
        stamp: (m) => displayTime(m, now),
        /* THE PLACE, NOT THE FOLDER: a letter consent keeps in History is said to be there. */
        place: (m) => {
          const filed = heldPlaces.get(m.id);
          if (filed !== undefined) return placeLabel(filed);
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
      events,
      go: { address: (address) => commands.go({ place: "address", sub: address }) },
    }),
    [now, placeOf, heldPlaces, t, junk, junkReadable, plan.pointer, people, events, commands, surface, verbs],
  );
  return (
    <SearchAbove model={model} archiveHit={archiveHit} beside={beside} blank={blankOf(model, t)}>
      <ListMoveContext.Provider value={move}>{children}</ListMoveContext.Provider>
    </SearchAbove>
  );
}
