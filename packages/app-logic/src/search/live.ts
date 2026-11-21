/**
 * SEARCH, LIVE: what Search's seat calls once (`packages/app/src/search/Seat.tsx`). It assembles the list's input
 * (`SearchListInput`) from the frame's side (`args`), the mail ground's readers and the engine, calls the list's
 * behaviour (`useSearchList`) once, and hands the seat what is said beside the list. In the shape of the Ohbox's
 * `live.ts`.
 *
 * WHERE EACH INPUT COMES FROM. The frame (`args`): the scope the order is kept under, the commands a result is
 * opened with. The ground, each reader throwing where none stands: the presented mirror and the partition (where a
 * letter is presented, the account's own addresses), the consent row (folders), the mail state (the mailboxes whose
 * Junk folder no pass reaches). The engine: the list's passes.
 * What only a file of `packages/app` can read (`own`): the words, the field and the scroller, what the
 * host's server takes, the Screener's rows, which places the host hands.
 *
 * A RESULT OPENS WHERE IT IS PRESENTED (`live-open.ts`), entered, through the frame's commands: never spelled here.
 * The question asked starts the search mark (`beginSearch`), which the device's first paint ends.
 */
import { useEffect, useMemo, useState, type RefObject } from "react";
import { type AddressBookEntry, type SearchHit } from "@ohmail/client-engine";
import { useConsent } from "../consent/consent-row.js";
import { usePartition } from "../consent/partition.js";
import { useDemoMode, useDerivedVersion, useEngine } from "../engine/context.js";
import { useZoneNav } from "../keys/zone-nav.js";
import { junkFolderSaid } from "../lists/folders.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { usePeople } from "./people.js";
import { useStableCallback } from "../press/stable-callback.js";
import { usePresented } from "../reading/presented-mirror.js";
import { useDayClock } from "../session/day-clock.js";
import { beginSearch } from "../session/ui-vitals.js";
import type { Translator } from "../text/translator.js";
import { useSearchOpen, type SearchOpenOwn } from "./live-open.js";
import { useSearchList } from "./search-list.js";
import type { SearchListInput, SearchListModel } from "./types.js";

/** What only Search's seat can read: the words, the field and the scroller, the host's answers. */
export interface SearchLiveOwn extends SearchOpenOwn {
  readonly rememberedQuery: { current: string };
  readonly exit: () => void;
  /** Search's own words (`search`), which its keys are listed under too. */
  readonly t: Translator;
  /** The names the key sheet lists the keyboard's zones under. */
  readonly shortcuts: Translator;
  readonly boxRef: RefObject<HTMLInputElement | null>;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  /** The zone the reader's clock runs in. */
  readonly zone: string;
  /** What the host's server takes (`HostCapabilities.searchBy`). */
  readonly searchBy: "people" | "words";
  /** The host hands a Junk window: the empty answer may point to it. */
  readonly junkWire: boolean;
  readonly readMailboxTotal?: SearchListInput["readMailboxTotal"];
}

/** What the seat stands beside the list: the model and the facts its words are said from. */
export interface SearchLive {
  readonly model: SearchListModel;
  readonly archiveHit: SearchHit["message"] | null;
  /** The day the stamps beside the list are said from. */
  readonly now: Date;
  /** Where each letter is presented (`null`: History); absent where no partition stands (the demo). */
  readonly placeOf: ReadonlyMap<string, string | null> | null;
  /** What the empty answer says of the provider's Junk folder, which no pass reaches; null says nothing. */
  readonly junk: { readonly named: string } | "unnamed" | null;
  readonly junkReadable: boolean;
  /** The address book for a person-first question, built when asked, once per mirror version. */
  readonly people: () => readonly AddressBookEntry[];
}

export function useSearchLive(args: PlaceLiveArgs, own: SearchLiveOwn): SearchLive {
  const engine = useEngine();
  const demo = useDemoMode();
  const presented = usePresented(); // throws where no ground stands above
  const { consentView, ownAddresses } = usePartition(); // throws where no ground stands above
  const { foldersEnabled } = useConsent(); // throws where no ground stands above
  const { mailboxes } = useMailState();
  const now = useDayClock(null, own.zone);
  const [query, setQuery] = useState(() => own.rememberedQuery.current);
  const onQuery = useStableCallback((q: string) => {
    beginSearch();
    own.rememberedQuery.current = q;
    setQuery(q);
  });
  const placeOf = consentView?.placeOf ?? null;
  const [carried, carry] = useState<SearchHit["message"] | null>(null);
  const openId = args.route.open;
  useEffect(() => {
    carry((hit) => (hit?.id === openId ? hit : null));
  }, [openId]);
  const onOpen = useSearchOpen(args, { engine, presented, placeOf, foldersEnabled, now }, own, carry);
  const people = usePeople(presented, ownAddresses);
  const model = useSearchList({
    engine,
    scope: args.scope,
    query,
    onQuery,
    onOpen,
    onExit: own.exit,
    boxRef: own.boxRef,
    scrollerRef: own.scrollerRef,
    t: own.t,
    searchBy: own.searchBy,
    readMailboxTotal: own.readMailboxTotal,
    people,
  });
  /* Search's keys are inert where the rail holds the keyboard. */
  useZoneNav(own.shortcuts, {});
  const junk = useMemo(() => junkFolderSaid(mailboxes ?? []), [mailboxes]);
  return {
    model,
    archiveHit: carried?.id === openId ? carried : null,
    now,
    placeOf,
    junk,
    junkReadable: !demo && foldersEnabled && own.junkWire,
    people,
  };
}
