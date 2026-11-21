/**
 * THE PLACES' REGISTERED STATES, drawn by address over the fake host: News, Receipts, the three piles, History, Tags,
 * a folder, an address, Drafts and Trash, each through the real frame, its model from the real behaviour hook over the
 * page's world (`places-world.ts`), the frame's words beside it. The address carries the reference's words (`screen`,
 * `open`, `show`, `state`, `tag`, `shut`, `f`, `address`, `dir`, `run`, `device`, `face`, `scheme`) and `lang`.
 * Nothing here is seated (a place the mail places seat is taken without its seat, as a host that stands its model
 * itself takes it): what the reading column draws in the reader's places is the reader's, and the composer in a
 * column is the writing column's; the comparison declares both.
 */
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useAddressList } from "@ohmail/app-logic/address";
import { useDraftsList, type DraftsDoor } from "@ohmail/app-logic/drafts";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine";
import { useFolderList } from "@ohmail/app-logic/folder";
import { useHistoryList } from "@ohmail/app-logic/history";
import { PilesModelContext, type PileId, type PilesInput } from "@ohmail/app-logic/piles";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import type { StreamInput } from "@ohmail/app-logic/streams";
import { useTagsList } from "@ohmail/app-logic/tags";
import { useTrashList } from "@ohmail/app-logic/trash";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, PlaceId, RailModel } from "../../src/frame/contract.js";
import { routeOf } from "../../src/frame/route.js";
import { AddressAbove, addressPlace } from "../../src/address/index.js";
import { DraftsAbove, draftsPlace } from "../../src/drafts/index.js";
import { FolderAbove, folderPlace } from "../../src/folder/index.js";
import { MailStateProvider } from "../../src/mail-state/MailStateProvider.js";
import { HistoryAbove, historyPlace } from "../../src/history/index.js";
import { NewsAbove, newsPlace } from "../../src/news/index.js";
import { PilesAbove, laterPlace, parkedPlace, resurfacePlace } from "../../src/piles/index.js";
import { ReceiptsAbove, receiptsPlace } from "../../src/receipts/index.js";
import { TagsAbove, tagsPlace } from "../../src/tags/index.js";
import { TrashAbove, trashPlace } from "../../src/trash/index.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeMail } from "../reader/support/fake-mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { unseated } from "../support/unseated.js";
import * as W from "./places-world.js";
import addressDe from "../../messages/address.de.json" with { type: "json" };
import addressEn from "../../messages/address.en.json" with { type: "json" };
import draftsDe from "../../messages/drafts.de.json" with { type: "json" };
import draftsEn from "../../messages/drafts.en.json" with { type: "json" };
import folderDe from "../../messages/folder.de.json" with { type: "json" };
import folderEn from "../../messages/folder.en.json" with { type: "json" };
import historyDe from "../../messages/history.de.json" with { type: "json" };
import historyEn from "../../messages/history.en.json" with { type: "json" };
import newsDe from "../../messages/news.de.json" with { type: "json" };
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import newsEn from "../../messages/news.en.json" with { type: "json" };
import pilesDe from "../../messages/piles.de.json" with { type: "json" };
import pilesEn from "../../messages/piles.en.json" with { type: "json" };
import readerDe from "../../messages/reader.de.json" with { type: "json" };
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import receiptsDe from "../../messages/receipts.de.json" with { type: "json" };
import receiptsEn from "../../messages/receipts.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import tagsDe from "../../messages/tags.de.json" with { type: "json" };
import tagsEn from "../../messages/tags.en.json" with { type: "json" };
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };

/* The page's clock reads the world's Tuesday morning, and runs on from there: a place prints its stamps from it. */
const RealDate = Date;
const offset = RealDate.now() - W.NOW.getTime();
class PageDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() - offset);
    else super(...(args as [string]));
  }
  static override now(): number {
    return RealDate.now() - offset;
  }
}
globalThis.Date = PageDate as DateConstructor;

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const screen = q.get("screen") ?? "news";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
const room = device === "foldl" ? ROOMS.land : (ROOMS[device] ?? ROOMS.desktop);
const state = q.get("state");
const show = q.get("show");
const open = q.get("open") === "none" ? null : q.get("open");
const empty = state === "empty";
const stamp = W.stampOf(lang);

const EN = [
  FRAME_WORDS.en,
  sharedEn,
  newsEn,
  receiptsEn,
  pilesEn,
  historyEn,
  tagsEn,
  folderEn,
  addressEn,
  draftsEn,
  trashEn,
  { ohbox: ohboxEn.ohbox, reader: readerEn.reader },
];
const DE = [
  FRAME_WORDS.de,
  sharedDe,
  newsDe,
  receiptsDe,
  pilesDe,
  historyDe,
  tagsDe,
  folderDe,
  addressDe,
  draftsDe,
  trashDe,
  { ohbox: ohboxDe.ohbox, reader: readerDe.reader },
];
const words: Messages = fillOver(
  Object.assign({}, ...EN) as Messages,
  lang === "de" ? (Object.assign({}, ...DE) as Messages) : {},
);

const NOTHING = () => undefined;

/*
 * THE REFERENCE'S ARRIVAL: where two columns stand and the address names nothing open, the reference opens the
 * place's first row on arrival (the shipped list's first-row fallback, `list-view.tsx`, which these places do not
 * hold yet: owed at the seat). The page stands that state by opening the first row once, in place of the address.
 */
const ARRIVES_OPEN = new Set(["later", "parked", "resurface", "history", "tags", "trash", "address"]);
const arrives = ARRIVES_OPEN.has(screen) && device !== "phone" && !q.has("open") && !q.has("run") && !empty;
function useArrival(address: FakeAddress, base: string, first: string | undefined): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !arrives || first === undefined) return;
    done.current = true;
    address.write(`${base}/m/${first}`, "replace");
  }, [address, base, first]);
}

/* The rail as the shell feeds it today, its current entry the screen's place. */
function railOf(current: string): RailModel {
  const entry = (
    id: string,
    label: string,
    icon: RailModel["groups"][number]["entries"][number]["icon"],
    count?: string,
  ) => ({
    id,
    kind: "place" as const,
    label,
    icon,
    count,
    current: id === current,
    onPress: NOTHING,
  });
  return {
    groups: [
      {
        id: "main",
        entries: [
          entry("ohbox", "Ohbox", "ohbox", "5"),
          entry("news", "News", "news", "5"),
          entry("receipts", "Receipts", "receipts", "2"),
        ],
      },
      { id: "screener", entries: [entry("screener", "Screener", "screener", "6")] },
      {
        id: "later",
        entries: [
          entry("later", "Answer Later", "later", "2"),
          entry("parked", "Parked", "parked", "1"),
          entry("resurface", "Resurface", "resurface", "1"),
        ],
      },
      {
        id: "tags",
        entries: [{ id: "tags", kind: "fold", label: "Tags", expanded: false, onPress: NOTHING }],
      },
      {
        id: "more",
        entries: [
          entry("history", "History", "history"),
          entry("search", "Search", "search"),
          entry("drafts", "Drafts", "drafts", "1"),
          entry("settings", "Settings", "settings"),
        ],
      },
    ],
    write: { label: "Write", onPress: NOTHING },
    account: {
      name: "Mila Brunner",
      address: "mila@lichtgrat.example",
      note: "2 mailboxes",
      title: "Account",
      onPress: NOTHING,
    },
    pull: { label: "Pull new mail", busy: false, onPress: NOTHING },
  };
}

/** A place whose list pane also feeds the rail, as today's views do. */
function fed(entry: PlaceEntry, rail: RailModel): PlaceEntry {
  if (entry.panes.kind !== "columns") return entry;
  const Own = entry.panes.List;
  function List(props: PaneProps) {
    useRailModel(rail);
    return <Own {...props} />;
  }
  return { ...entry, panes: { ...entry.panes, List } as PlaceEntry["panes"] };
}

function useRoute(address: FakeAddress) {
  return routeOf(useSyncExternalStore(address.subscribe, address.read));
}

/* Each screen's seat: its model over the world, the Above it stands, where it starts. */
interface Seat {
  places: Partial<Record<PlaceId, PlaceEntry>>;
  start: string;
  Above: (props: { address: FakeAddress; children: ReactNode }) => ReactNode;
}

const seen = () => true;

/** When the line was drawn: News last on Monday evening, everything at 09:24 once all is seen; Receipts say no hour. */
const lineAt = (place: "news" | "receipts"): { at?: string } =>
  state === "seen"
    ? { at: "2026-11-10T09:24:00.000Z" }
    : place === "news"
      ? { at: "2026-11-09T18:40:00.000Z" }
      : {};

function streamSeat(place: "news" | "receipts"): Seat {
  const letters = place === "news" ? W.NEWS : W.RECEIPTS;
  const fresh = state === "seen" ? 0 : place === "news" ? W.NEWS_FRESH : W.RECEIPTS_FRESH;
  const base = place === "news" ? "#/reads" : "#/receipts";
  const first = show === "open" || q.has("reply") ? (open ?? letters[0]!.id) : open;
  return {
    places: place === "news" ? { news: unseated(newsPlace) } : { receipts: unseated(receiptsPlace) },
    start: first ? `${base}/m/${first}` : base,
    Above: function StreamSeat({ address, children }) {
      const route = useRoute(address);
      const shown = empty ? [] : letters;
      const input: StreamInput = {
        place,
        settled: true,
        owed: false,
        partition: {
          fresh: shown.slice(0, fresh),
          seen: shown.slice(fresh),
          waterline: shown.length > fresh ? { newestSeenId: shown[fresh]!.id, ...lineAt(place) } : null,
          newCount: shown.slice(0, fresh).filter((m) => m.unread).length,
        },
        markSeen: NOTHING,
        onLeaveSeen: NOTHING,
        markUnread: NOTHING,
        markAllRead: NOTHING,
        textOf: W.textOf,
        hydrate: NOTHING,
        onPageHide: () => NOTHING,
        stamp,
        openId: route.open,
        open: (id) => address.write(id === null ? base : `${base}/m/${id}`, "push"),
      };
      return place === "news" ? (
        <NewsAbove input={input}>{children}</NewsAbove>
      ) : (
        <ReceiptsAbove input={input}>{children}</ReceiptsAbove>
      );
    },
  };
}

/** The run of the reference, started once on the first draw, as `f` starts it. */
function RunStarted({ children }: { children: ReactNode }) {
  const model = useContext(PilesModelContext);
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !model || q.get("run") !== "1") return;
    once.current = true;
    model.run.start();
  }, [model]);
  return <>{children}</>;
}

function pileStateEntry(entry: PlaceEntry): PlaceEntry {
  const place = unseated(entry);
  // The states page supplies its own rail counts; this host has no presented mail ground.
  return { ...place, rail: place.rail ? { ...place.rail, useCount: undefined } : null };
}

function pilesSeat(pile: PileId): Seat {
  const base = pile === "later" ? "#/triage" : pile === "parked" ? "#/triage/aside" : "#/triage/resurface";
  const resurface = state === "set" ? W.RESURFACE : W.RESURFACE.slice(1);
  const of = (ms: readonly { message: (typeof W.LATER)[number]; at?: string }[], none: boolean) =>
    none
      ? []
      : ms.map((x) => ({
          messageId: x.message.id,
          memberIds: [x.message.id],
          title: x.message.subject,
          ...(x.at ? { resurfaceAt: x.at } : {}),
        }));
  const piles = {
    replyLater: of(
      W.LATER.map((message) => ({ message })),
      empty && pile === "later",
    ),
    setAside: of(
      W.PARKED.map((message) => ({ message })),
      empty && pile === "parked",
    ),
    resurface: of(resurface, empty && pile === "resurface"),
  };
  const all = [...W.LATER, ...W.PARKED, ...W.RESURFACE.map((x) => x.message)];
  return {
    places: {
      later: pileStateEntry(laterPlace),
      parked: pileStateEntry(parkedPlace),
      resurface: pileStateEntry(resurfacePlace),
    },
    start: open ? `${base}/m/${open}` : base,
    Above: function PilesSeat({ address, children }) {
      const { openId, open, walk, arrival } = useOpen(address, base);
      const firstOf = { later: W.LATER[0], parked: W.PARKED[0], resurface: resurface[0]?.message };
      useArrival(address, base, firstOf[pile]?.id);
      const input: PilesInput = {
        pile,
        piles,
        messageOf: (id) => all.find((m) => m.id === id) ?? null,
        settled: true,
        owed: false,
        openId,
        open,
        walk,
        arrival,
        onAction: NOTHING,
        markSeen: seen,
        write: NOTHING,
        stamp,
      };
      return (
        <PilesAbove input={input}>
          <RunStarted>{children}</RunStarted>
        </PilesAbove>
      );
    },
  };
}

function useOpen(address: FakeAddress, base: string) {
  const route = useRoute(address);
  return {
    openId: route.open,
    open: (id: string | null) => address.write(id === null ? base : `${base}/m/${id}`, "push"),
    markSeen: seen,
    act: NOTHING,
    /* The page opens its letters by address: no hit is opened into a place here. */
    entered: { letter: null, taken: NOTHING },
    /* The page binds no key and stands the reference's arrival itself (`useArrival`, in place of the address). */
    walk: {
      columns: device === "phone" ? (1 as const) : (2 as const),
      list: base,
      labels: { next: "", prev: "", open: "" },
      say: NOTHING,
    },
    arrival: "rest" as const,
    stamp,
    settled: true,
    owed: false,
  };
}

const historySeat = (): Seat => ({
  places: { history: unseated(historyPlace) },
  start: open ? `#/history/m/${open}` : "#/history",
  Above: function HistorySeat({ address, children }) {
    const model = useHistoryList({
      ...useOpen(address, "#/history"),
      messages: empty ? [] : W.HISTORY,
      placeOf: W.placeOf,
      store: { down: false, retry: NOTHING },
    });
    useArrival(address, "#/history", model.list.rows[0]?.id);
    return <HistoryAbove model={model}>{children}</HistoryAbove>;
  },
});

function tagsSeat(): Seat {
  /* Every tag has no address of its own yet (bare `#/tag` is the Ohbox's until the frame's line): the page stands
     the place at a tag's address and hands the model no tag. */
  const tag = q.get("tag");
  const base = `#/tag/${tag ?? "pottery"}`;
  return {
    places: { tags: unseated(tagsPlace) },
    start: open ? `${base}/m/${open}` : base,
    Above: function TagsSeat({ address, children }) {
      const model = useTagsList({
        ...useOpen(address, base),
        tags: empty ? [] : W.TAGS,
        messages: empty ? [] : W.TAGGED,
        tagId: tag,
        rename: NOTHING,
        remove: NOTHING,
      });
      useArrival(address, base, model.list.rows[0]?.id);
      const shut = q.get("shut")?.replace(/^tag-/, "") ?? null;
      const once = useRef(false);
      useEffect(() => {
        if (once.current || shut === null) return;
        once.current = true;
        model.toggle(shut);
      }, [model, shut]);
      return <TagsAbove model={model}>{children}</TagsAbove>;
    },
  };
}

function folderSeat(): Seat {
  const name = q.get("f") ?? "Workshops";
  const folder = W.FOLDERS.find((f) => f.name === name) ?? W.FOLDERS[0]!;
  const base = `#/folder/${folder.id}`;
  return {
    places: { folder: unseated(folderPlace) },
    start: open ? `${base}/m/${open}` : base,
    Above: function FolderSeat({ address, children }) {
      const model = useFolderList({
        ...useOpen(address, base),
        folder,
        folderId: folder.id,
        folders: W.FOLDERS,
        openFolder: (id) => address.write(`#/folder/${id}`, "push"),
        messages: W.IN_FOLDER[folder.id] ?? [],
      });
      return <FolderAbove model={model}>{children}</FolderAbove>;
    },
  };
}

function addressSeat(): Seat {
  const who = q.get("address") ?? W.PETRA;
  const base = `#/address/${encodeURIComponent(who)}`;
  const side = q.get("dir") === "from" ? "from" : q.get("dir") === "to" ? "to" : "all";
  return {
    places: { address: unseated(addressPlace) },
    start: open ? `${base}/m/${open}` : base,
    Above: function AddressSeat({ address, children }) {
      const model = useAddressList({
        ...useOpen(address, base),
        address: who,
        messages: W.BY_ADDRESS,
        side,
        placeOf: W.placeOf,
        /* The reference's person came to the address from the Ohbox. */
        back: { label: "Ohbox", run: NOTHING },
      });
      useArrival(address, base, model.list.rows[0]?.id);
      return <AddressAbove model={model}>{children}</AddressAbove>;
    },
  };
}

const door: DraftsDoor = {
  open: NOTHING,
  decide: () => ({ kind: "go" }),
  withdrawWaiting: async () => "none",
  discard: async () => ({ kind: "applied" }) as Awaited<ReturnType<DraftsDoor["discard"]>>,
  cancelSchedule: NOTHING,
  editScheduled: NOTHING,
  resolve: NOTHING,
  sendAgain: NOTHING,
  repliesHere: () => true,
  heldHere: new Set(state === "held" ? ["draft-nadja"] : []),
  waiting: new Set(),
  notSent: new Map(),
};

const draftsSeat = (): Seat => ({
  places: { drafts: draftsPlace },
  start: open ? `#/drafts/m/${open}` : "#/drafts",
  Above: function DraftsSeat({ children }) {
    const model = useDraftsList({
      drafts: [],
      scheduled: empty ? [] : [W.scheduledDraft(state === "held")],
      settled: true,
      owed: false,
      door,
      report: NOTHING,
      words: {
        discarded: "",
        undo: "",
        changed: "",
        unsupported: "",
        notSent: "",
        refused: () => "",
        queued: () => "",
      },
      stamp,
      appointment: W.appointmentOf(lang),
      now: W.NOW,
    });
    return <DraftsAbove model={model}>{children}</DraftsAbove>;
  },
});

/* The paged window of Trash, as the server answers it; the mail server's own Trash, as its wire answers it. */
const trashBinding: EngineBinding = {
  engine: {
    trashAvailable: () => true,
    onMessagesRemoved: () => () => {},
    listTrash: async () => ({ state: "ready", items: empty ? [] : W.TRASHED, nextCursor: null }),
  } as unknown as OhmailEngine,
  demo: false,
  serverDemo: false,
  sync: { phase: "idle" } as unknown as EngineBinding["sync"],
};

const trashSeat = (): Seat => ({
  places: { trash: unseated(trashPlace) },
  start: open ? `#/trash/m/${open}` : "#/trash",
  Above: function TrashSeat({ address, children }) {
    return (
      <EngineContext.Provider value={trashBinding}>
        <TrashModel address={address}>{children}</TrashModel>
      </EngineContext.Provider>
    );
  },
});

/** Trash's model reads the engine's paged window: it stands inside the binding. */
function TrashModel({ address, children }: { address: FakeAddress; children: ReactNode }) {
  const { openId, open, walk, arrival } = useOpen(address, "#/trash");
  const wire = useMemo(
    () => ({
      list: async () => ({
        mailboxes: [{ id: "mb", address: "mila@lichtgrat.example", window: "ok" as const }],
        items: [],
        nextCursor: null,
      }),
      body: async () => ({ subject: "", text: "" }),
    }),
    [],
  );
  const model = useTrashList({
    held: new Set(),
    landed: 0,
    restored: [],
    restore: () => true,
    markSeen: () => true,
    wire,
    openId,
    open,
    walk,
    arrival,
    stamp,
    placeOf: (f) => (f === "INBOX" ? "Ohbox" : f),
  });
  useArrival(address, "#/trash", W.TRASHED[0]?.id);
  return <TrashAbove model={model}>{children}</TrashAbove>;
}

const SEATS: Record<string, () => Seat> = {
  news: () => streamSeat("news"),
  receipts: () => streamSeat("receipts"),
  later: () => pilesSeat("later"),
  parked: () => pilesSeat("parked"),
  resurface: () => pilesSeat("resurface"),
  history: historySeat,
  tags: tagsSeat,
  folder: folderSeat,
  address: addressSeat,
  drafts: draftsSeat,
  trash: trashSeat,
};

const seat = (SEATS[screen] ?? SEATS.news!)();
const rail = railOf(screen === "folder" || screen === "address" ? "" : screen);
const places = Object.fromEntries(
  Object.entries(seat.places).map(([id, entry]) => [id, fed(entry, rail)]),
) as Partial<Record<PlaceId, PlaceEntry>>;
const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
document.documentElement.setAttribute("data-face", look.face);
document.documentElement.setAttribute("data-theme", look.scheme);
const address = fakeAddress(seat.start);
const mail = fakeMail([
  ...W.NEWS,
  ...W.RECEIPTS,
  ...W.HISTORY,
  ...W.TAGGED,
  ...W.LATER,
  ...W.PARKED,
  ...W.RESURFACE.map(({ message }) => message),
  ...Object.values(W.IN_FOLDER).flat(),
  ...W.BY_ADDRESS,
]);
const Above = seat.Above;
function Ground({ children }: { children: ReactNode }) {
  return (
    <MailStateProvider scope="mila" mirrored={mail.engine.read().list("message").length}>
      <PresentedMirrorContext.Provider value={mail.engine.read()}>
        <Above address={address}>{children}</Above>
      </PresentedMirrorContext.Provider>
    </MailStateProvider>
  );
}
const { host } = fakeHost({
  engine: mail.engine,
  above: Ground,
  service: "managed",
  scope: "mila",
  places,
  window: fakeWindow({ ...room, posture: "flat", reducedMotion: true }),
  address,
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone="UTC">
    <Frame host={host} />
  </TextProvider>,
);
