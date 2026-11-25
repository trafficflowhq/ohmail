import { useLayoutEffect, useState } from "react";
import { type LinkedDraft } from "../host/index.js";
import {
  NO_CONNECTION,
  type CalendarDraftSeed,
  type ConnectionFeed,
  type EnteredTarget,
  type ReaderPosition,
  type SearchPosition,
} from "./commands.js";
import { type FrameHost, type RailFootModel, type RailModel } from "./contract.js";
import { createFeed } from "./feeds.js";
import { createNoticeStore } from "./notice-store.js";
import { createOfferStore } from "./offers.js";
import type { Dragging } from "./rail-drag.js";
import { owedFeed } from "./stage-entry.js";

const sameReason = (a: ConnectionFeed["reason"], b: ConnectionFeed["reason"]) =>
  a === b || (!!a && !!b && a.title === b.title && a.line === b.line && a.href === b.href);
const sameFeed = (a: ConnectionFeed, b: ConnectionFeed) =>
  a.mail === b.mail &&
  a.online === b.online &&
  a.setupHref === b.setupHref &&
  a.follow === b.follow &&
  sameReason(a.reason, b.reason);

export function useFrameStores(address: FrameHost["device"]["address"]) {
  const [inner] = useState(() => ({
    notices: createNoticeStore(),
    rail: createFeed<RailModel | null>(null),
    foot: createFeed<RailFootModel | null>(null),
    connection: createFeed<ConnectionFeed>(NO_CONNECTION, sameFeed),
    draft: { current: null as LinkedDraft | null },
    calendarInvitation: { current: null as import("../calendar/faces.js").CalendarEventFace | null },
    calendarDraftSeed: { current: null as CalendarDraftSeed | null },
    entered: createFeed<EnteredTarget | null>(null),
    readerPosition: { current: null as ReaderPosition | null },
    searchQuery: { current: "" },
    searchPosition: { current: null as SearchPosition | null },
    ohboxSearchPosition: { current: null as { address: string; top: number } | null },
    bars: createFeed<readonly string[]>([]),
    owed: owedFeed(),
    offers: createOfferStore(),
    drag: createFeed<Dragging | null>(null),
  }));
  /* A history or external address change can leave a chosen hit before its local row arrives. */
  useLayoutEffect(
    () =>
      address.subscribe(() => {
        const target = inner.entered.read();
        if (target && target.fragment !== address.read()) inner.entered.set(null);
      }),
    [address, inner],
  );
  return inner;
}
