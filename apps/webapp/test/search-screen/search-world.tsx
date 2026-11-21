/**
 * SEARCH'S SCREEN OVER A PLAIN MAILBOX (`@ohmail/app/search`, mounted alone; here, where a test may build a real
 * engine): the real behaviour hook (`useSearchList`) over an engine whose mirror holds plain
 * letters and whose store answers as a case says, the list drawn from its model with the place files' words, beside
 * it what a shell would say. Every store request is written down; a case moves the clock and reads by role and name.
 */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { act, render, type RenderResult } from "@testing-library/react";
import { useRef, useState } from "react";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SearchHit,
  type ServerSearchOpts,
  type SyncResponse,
} from "@ohmail/client-engine";
import { useSearchList } from "@ohmail/app-logic/search";
import type { LayoutPlan, PaneProps, Route } from "@ohmail/app/frame";
import { KeymapProvider } from "../../../../test/support/keymap-provider";
import { NONE } from "@ohmail/app/host";
import { SearchAbove, SearchList, searchBlankOf, type SearchBeside } from "@ohmail/app/search";
import { TextProvider, type Messages } from "@ohmail/app/text";
import de from "../../messages/de.json";
import en from "../../messages/en.json";

export const WORDS: Record<"en" | "de", Messages> = {
  en: { search: en.search, screener: en.screener } as Messages,
  de: { search: de.search, screener: de.screener } as Messages,
};

/** What jsdom lacks that the kit's parts ask for: a media query that answers, an animation that ends. */
export function wideWindow(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
}

export const NOW = new Date("2026-11-16T12:00:00.000Z");

export interface Plain {
  id: string;
  subject: string;
  from?: string | null;
  address?: string;
  folder?: string;
  unread?: boolean;
  file?: boolean;
}

export function letter(p: Plain): EngineMessage {
  return {
    id: p.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: p.subject,
    from: { name: p.from === undefined ? "Giulia Rossi" : p.from, address: p.address ?? "giulia@terra-cotta.example" },
    to: [],
    cc: [],
    date: "2026-11-10T09:00:00.000Z",
    folder: p.folder ?? "INBOX",
    snippet: "the first words",
    unread: p.unread ?? false,
    hasAttachments: p.file ?? false,
    attachmentCount: p.file ? 1 : 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  } as unknown as EngineMessage;
}

/** A store page as the adapter hands it to the engine. */
export type ServerSearchWire = NonNullable<Awaited<ReturnType<NonNullable<EngineAdapter["searchServer"]>>>>;

/** What the store answers a question with: a page, a refusal, or nothing at all (no store on this host). */
export type StoreFn = (q: string, opts: ServerSearchOpts) => ServerSearchWire | Promise<ServerSearchWire>;
type PlaceRead = () => Promise<readonly { folder: string; count: number }[]>;

export type StoreAnswer = StoreFn | "none";

export interface Asked {
  q: string;
  opts: ServerSearchOpts;
}

let seq = 0;
async function engineOf(rows: readonly EngineMessage[], store: StoreAnswer, asked: Asked[], searchPlaces?: PlaceRead): Promise<OhmailEngine> {
  const mirror = new MemoryMirrorStore();
  await mirror.load();
  await mirror.applyChanges(
    rows.map((m) => ({ type: "message" as const, op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  );
  const adapter: EngineAdapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0",
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...(searchPlaces ? { searchPlaces } : {}),
    ...(store === "none"
      ? {}
      : {
          searchServer: async (q: string, opts: ServerSearchOpts) => {
            asked.push({ q, opts });
            return store(q, opts);
          },
        }),
  } as EngineAdapter;
  return new OhmailEngine({ adapter, store: mirror, now: () => NOW });
}

/** A store page of these letters, its count exact. */
export const page =
  (rows: readonly EngineMessage[], more: Partial<ServerSearchWire> = {}): StoreFn =>
  () => ({ items: [...rows], total: rows.length, totalExact: true, ms: 4, tier: "exact", ...more }) as ServerSearchWire;

export const DESKTOP: LayoutPlan = {
  size: "expanded",
  short: false,
  pointer: "fine",
  device: "desktop",
  pose: null,
  rail: "words",
  columns: 2,
  handles: true,
};

const ROUTE: Route = { place: "search", sub: null, open: null, stage: null, words: {} };

export interface Said {
  opened: string[];
  went: string[];
  exits: number;
}

export function besideOf(said: Said, over: Partial<SearchBeside> = {}): SearchBeside {
  return {
    words: {
      name: (m) => m.from.name || null,
      address: (m) => m.from.address,
      stamp: () => "10 Nov",
      place: (m) => (m.folder === "INBOX" ? "Ohbox" : m.folder),
      placeOfFolder: (key) => (key === "ohbox" ? "Ohbox" : key),
    },
    junk: NONE,
    junkReadable: false,
    keysShown: true,
    people: NONE,
    events: NONE,
    go: { address: (a) => said.went.push(a) },
    ...over,
  };
}

function Search({
  engine,
  side,
  said,
  plan,
  open,
  first,
  searchBy,
  readMailboxTotal,
}: {
  engine: OhmailEngine;
  side: SearchBeside;
  said: Said;
  plan: LayoutPlan;
  open: string | null;
  first: string;
  searchBy: "people" | "words";
  readMailboxTotal?: () => Promise<number | null>;
}) {
  const [query, setQuery] = useState(first);
  const boxRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const model = useSearchList({
    engine,
    scope: "acct-1",
    query,
    onQuery: setQuery,
    onOpen: (hit: SearchHit) => said.opened.push(hit.message.id),
    onExit: () => {
      said.exits += 1;
    },
    boxRef,
    scrollerRef,
    t: (key) => key,
    searchBy,
    readMailboxTotal,
    people: side.people === NONE ? undefined : side.people,
  });
  const pane: PaneProps = { route: { ...ROUTE, open }, plan, keysHere: true };
  return (
    <SearchAbove model={model} beside={side} blank={searchBlankOf(model, (key) => key)}>
      <SearchList {...pane} />
    </SearchAbove>
  );
}

export interface World {
  said: Said;
  asked: Asked[];
  view: RenderResult;
}

export async function search(
  rows: readonly EngineMessage[],
  opts: {
    store?: StoreAnswer;
    side?: Partial<SearchBeside>;
    plan?: LayoutPlan;
    lang?: "en" | "de";
    open?: string | null;
    query?: string;
    /** Whether the host's server takes a person, unread and the days. Left out: words, as today's server. */
    searchBy?: "people" | "words";
    readMailboxTotal?: () => Promise<number | null>;
    searchPlaces?: PlaceRead;
  } = {},
): Promise<World> {
  const said: Said = { opened: [], went: [], exits: 0 };
  const asked: Asked[] = [];
  const engine = await engineOf(rows, opts.store ?? page([]), asked, opts.searchPlaces);
  const lang = opts.lang ?? "en";
  let view!: RenderResult;
  await act(async () => {
    view = render(
      <TextProvider locale={lang} messages={WORDS[lang]} timeZone="UTC">
        <KeymapProvider>
          <Search
            engine={engine}
            side={besideOf(said, opts.side)}
            said={said}
            plan={opts.plan ?? DESKTOP}
            open={opts.open ?? null}
            first={opts.query ?? ""}
            searchBy={opts.searchBy ?? "words"}
            readMailboxTotal={opts.readMailboxTotal}
          />
        </KeymapProvider>
      </TextProvider>,
    );
  });
  return { said, asked, view };
}

/** Let the clock run: the settle wait, the store's answer, and the paints after them. */
export async function settle(ms = 800): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
