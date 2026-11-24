/**
 * NEWS, RECEIPTS AND THE PILES OVER PLAIN LETTERS: the real places through the real `Frame` over the fake host, their
 * models fed what a shell would hand them, every write the place makes counted. A test moves the address and reads
 * by role and name.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, render } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import type { TriagePiles } from "@ohmail/client-engine";
import type { PilesInput } from "@ohmail/app-logic/piles";
import type { StreamInput, StreamLeaveCommit } from "@ohmail/app-logic/streams";
import type { PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { routeOf } from "../../src/frame/route.js";
import { NewsAbove, newsPlace } from "../../src/news/index.js";
import { ReceiptsAbove, receiptsPlace } from "../../src/receipts/index.js";
import { PilesAbove, laterPlace, parkedPlace, resurfacePlace } from "../../src/piles/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { NO_ENGINE, fakeHost } from "../support/fake-host.js";
import {
  fakeAddress,
  fakeWindow,
  movable,
  type FakeAddress,
  type FakeWindow,
  type MovableSignal,
} from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { letter } from "../reader/support/fake-mail.js";
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import newsEn from "../../messages/news.en.json" with { type: "json" };
import newsDe from "../../messages/news.de.json" with { type: "json" };
import receiptsEn from "../../messages/receipts.en.json" with { type: "json" };
import receiptsDe from "../../messages/receipts.de.json" with { type: "json" };
import pilesEn from "../../messages/piles.en.json" with { type: "json" };
import pilesDe from "../../messages/piles.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };

export { letter };

export const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: { ...FRAME_WORDS.en, ...sharedEn, ...newsEn, ...receiptsEn, ...pilesEn, ...ohboxEn } as Messages,
  de: { ...FRAME_WORDS.de, ...sharedDe, ...newsDe, ...receiptsDe, ...pilesDe, ...ohboxDe } as Messages,
};

/**
 * A place's registration without its seat and its rail count, which read the mail ground: this world stands the place's
 * model above the frame itself, over a host that hands no ground.
 */
function standing(place: PlaceEntry): PlaceEntry {
  return {
    ...place,
    rail: place.rail === null ? null : { ...place.rail, useCount: undefined },
    panes: place.panes.kind === "columns" ? { ...place.panes, Above: undefined } : place.panes,
  };
}

export interface StreamSaid {
  seen: string[][];
  leaves: StreamLeaveCommit[];
  unread: string[];
  all: string[][];
  hydrated: string[][];
}

/** What a shell hands a stream place: the letters in order, `fresh` of them above the line. */
export function streamInput(
  letters: readonly EngineMessage[],
  said: StreamSaid,
  over: Partial<Omit<StreamInput, "place" | "openId" | "open">> & {
    fresh?: number;
    text?: (id: string) => string | null;
  } = {},
): Omit<StreamInput, "place" | "openId" | "open"> {
  const fresh = over.fresh ?? letters.length;
  return {
    settled: true,
    owed: false,
    partition: {
      fresh: letters.slice(0, fresh),
      seen: letters.slice(fresh),
      waterline: fresh < letters.length ? { newestSeenId: letters[fresh]!.id } : null,
      newCount: letters.slice(0, fresh).filter((m) => m.unread).length,
    },
    markSeen: (ids) => said.seen.push([...ids]),
    onLeaveSeen: (c) => said.leaves.push(c),
    markUnread: (id) => said.unread.push(id),
    markAllRead: (ids) => said.all.push([...ids]),
    textOf: over.text ?? ((id) => `The words of ${id}.`),
    hydrate: (ids) => said.hydrated.push([...ids]),
    onPageHide: () => () => {},
    stamp: (iso) => iso.slice(11, 16),
    ...over,
  };
}

export const said = (): StreamSaid => ({ seen: [], leaves: [], unread: [], all: [], hydrated: [] });

function useRoute(address: FakeAddress) {
  const fragment = useSyncExternalStore(address.subscribe, address.read);
  return routeOf(fragment);
}

type Fed = Omit<StreamInput, "place" | "openId" | "open">;

function StreamSeat({
  address,
  place,
  feed,
  children,
}: {
  address: FakeAddress;
  place: "news" | "receipts";
  feed: MovableSignal<Fed>;
  children: ReactNode;
}) {
  const route = useRoute(address);
  const input = useSyncExternalStore(feed.subscribe, feed.read);
  const base = place === "news" ? "#/reads" : "#/receipts";
  const full = {
    ...input,
    openId: route.open,
    open: (id: string | null) => address.write(id === null ? base : `${base}/m/${id}`, "push"),
  };
  return place === "news" ? (
    <NewsAbove input={full}>{children}</NewsAbove>
  ) : (
    <ReceiptsAbove input={full}>{children}</ReceiptsAbove>
  );
}

export function mountStream(o: {
  place: "news" | "receipts";
  input: Omit<StreamInput, "place" | "openId" | "open">;
  open?: string;
  search?: PlaceEntry;
  window?: FakeWindow;
  lang?: "en" | "de";
}) {
  const base = o.place === "news" ? "#/reads" : "#/receipts";
  const address = fakeAddress(o.open ? `${base}/m/${o.open}` : base);
  const feed = movable<Fed>(o.input);
  const Above = ({ children }: { children: ReactNode }) => (
    <StreamSeat address={address} place={o.place} feed={feed}>
      {children}
    </StreamSeat>
  );
  const seated = (place: PlaceEntry): PlaceEntry => {
    const stood = standing(place);
    return stood.panes.kind === "columns" ? { ...stood, panes: { ...stood.panes, Above } } : stood;
  };
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: {
      ...(o.place === "news" ? { news: seated(newsPlace) } : { receipts: seated(receiptsPlace) }),
      ...(o.search ? { search: o.search } : {}),
    },
    window: o.window ?? fakeWindow("desktop"),
    address,
  });
  const lang = o.lang ?? "en";
  const view = render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  /** A new pile, as the engine hands it after a write. */
  const repile = (letters: readonly EngineMessage[], fresh = letters.length) =>
    act(() =>
      feed.set({
        ...feed.read(),
        partition: { ...feed.read().partition, fresh: letters.slice(0, fresh), seen: letters.slice(fresh) },
      }),
    );
  return { address, view, repile };
}

export interface PilesSaid {
  actions: Array<[string, string]>;
  opened: string[];
  written: string[];
  seen: string[][];
}

function PilesSeat({
  address,
  input,
  said,
  children,
}: {
  address: FakeAddress;
  input: Pick<PilesInput, "piles" | "messageOf">;
  said: PilesSaid;
  children: ReactNode;
}) {
  const route = useRoute(address);
  const pile = route.place === "parked" || route.place === "resurface" ? route.place : "later";
  const base = pile === "later" ? "#/triage" : pile === "parked" ? "#/triage/aside" : "#/triage/resurface";
  const full: PilesInput = {
    ...input,
    pile,
    settled: true,
    owed: false,
    openId: route.open,
    open: (id) => {
      if (id !== null) said.opened.push(id);
      address.write(id === null ? base : `${base}/m/${id}`, "push");
    },
    onAction: (action, m) => said.actions.push([action, m.id]),
    markSeen: (ids) => said.seen.push(ids),
    write: (id) => said.written.push(id),
    stamp: (iso) => `at ${iso.slice(11, 16)}`,
    walk: {
      columns: 2,
      list: "the list",
      labels: { next: "Next", prev: "Previous", open: "Open" },
      say: () => undefined,
    },
    arrival: "rest",
  };
  return <PilesAbove input={full}>{children}</PilesAbove>;
}

export function pilesOf(
  p: Partial<Record<keyof TriagePiles, readonly EngineMessage[]>>,
  resurfaceAt?: string,
): TriagePiles {
  const entries = (ms: readonly EngineMessage[] = []) =>
    ms.map((m) => ({
      messageId: m.id,
      memberIds: [m.id],
      title: m.subject,
      ...(resurfaceAt ? { resurfaceAt } : {}),
    }));
  return {
    replyLater: entries(p.replyLater),
    setAside: entries(p.setAside),
    resurface: entries(p.resurface),
  };
}

export function mountPiles(o: {
  piles: TriagePiles;
  letters: readonly EngineMessage[];
  at?: string;
  lang?: "en" | "de";
  window?: FakeWindow;
}) {
  const address = fakeAddress(o.at ?? "#/triage");
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: {
      later: standing(laterPlace),
      parked: standing(parkedPlace),
      resurface: standing(resurfacePlace),
    },
    window: o.window ?? fakeWindow("desktop"),
    address,
  });
  const byId = new Map(o.letters.map((m) => [m.id, m]));
  const s: PilesSaid = { actions: [], opened: [], written: [], seen: [] };
  const input = { piles: o.piles, messageOf: (id: string) => byId.get(id) ?? null };
  const lang = o.lang ?? "en";
  const view = render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <PilesSeat address={address} input={input} said={s}>
        <Frame host={host} />
      </PilesSeat>
    </TextProvider>,
  );
  return { address, view, said: s, host };
}
