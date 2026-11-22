/**
 * SEARCH'S REGISTERED STATES, drawn by address: Search's list alone on the kit's list sheet, its model from the real
 * behaviour hook over an engine whose mirror holds a few invented letters and whose store answers as the address
 * says, the shell's words beside it. The address carries the reference's words (`q`, `open`, `state`, `who`, `dir`,
 * `unread`, `date`, `where`, `menu`, `all`, `device`, `face`, `scheme`), `lang` and `zoom`. A state that is a press
 * (a place narrowed, a menu open) is pressed here once the answer stands, as a person would. The rail and the
 * reading column are the frame's and the reader's, compared with them; a comparison cuts Search's list out of the
 * reference's picture.
 */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type AddressBookEntry,
  type EngineAdapter,
  type SyncResponse,
} from "@ohmail/client-engine";
import { useSearchList } from "@ohmail/app-logic/search";
import type { LayoutPlan, PaneProps } from "@ohmail/app/frame";
import { NONE } from "@ohmail/app/host";
import { KeymapProvider } from "../../../../test/support/keymap-provider";
import { SearchAbove, SearchList, searchBlankOf, type SearchBeside } from "@ohmail/app/search";
import { fillOver, TextProvider, type Messages } from "@ohmail/app/text";
import { Sheet } from "@ohmail/ui/mail";
import de from "../../messages/de.json";
import en from "../../messages/en.json";
import { searchStateOf } from "./search-states-of.js";

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
const open = q.get("open");
const shown = searchStateOf(q);
const many = q.has("many");
const listBounds = many ? { display: "flex", flexDirection: "column" as const, maxWidth: 420 } : {};

const NOW = new Date("2026-11-10T10:30:00.000Z");
const day = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, d, h - 1, m)).toISOString();

interface Plain {
  id: string;
  from: string;
  address: string;
  subject: string;
  snippet: string;
  date: string;
  folder?: string;
  unread?: boolean;
  file?: boolean;
  to?: { name: string; address: string }[];
}
const letter = (p: Plain): EngineMessage =>
  ({
    id: p.id,
    accountId: "mila",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: p.subject,
    from: { name: p.from, address: p.address },
    to: p.to ?? [],
    cc: [],
    date: p.date,
    folder: p.folder ?? "INBOX",
    snippet: p.snippet,
    unread: p.unread ?? false,
    hasAttachments: p.file ?? false,
    attachmentCount: p.file ? 1 : 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: p.date,
  }) as unknown as EngineMessage;

/* Every person and address is invented. */
const LETTERS: EngineMessage[] = [
  letter({
    id: "giulia-glaze",
    from: "Giulia Rossi",
    address: "giulia@terracotta-milano.example",
    subject: "Re: Glaze order #2291",
    snippet: "Both glazes leave Milano on Thursday.",
    date: day(10, 9, 12),
    unread: true,
    file: true,
  }),
  letter({
    id: "ben-glaze",
    from: "Ben Arnold",
    address: "ben@lichtgrat.example",
    subject: "Celadon glaze for the spring firing",
    snippet: "Can we add the celadon to the order?",
    date: day(9, 16, 40),
  }),
  letter({
    id: "nadja-glaze",
    from: "Nadja Lehner",
    address: "nadja@erdton-atelier.example",
    subject: "Glaze tests, round two",
    snippet: "The tiles came out of the kiln this morning.",
    date: day(6, 11, 5),
    folder: "Archive",
  }),
  letter({
    id: "mila-nadja",
    from: "Mila Brunner",
    address: "mila@lichtgrat.example",
    subject: "Tiles for the kiln room",
    snippet: "Could you glaze twelve more of the blue ones?",
    date: day(8, 14, 20),
    to: [{ name: "Nadja Lehner", address: "nadja@erdton-atelier.example" }],
  }),
  letter({
    id: "hostwerk-invoice",
    from: "Hostwerk",
    address: "billing@hostwerk.example",
    subject: "Your invoice for November",
    snippet: "Your invoice for the domain and the mail plan is attached.",
    date: day(3, 10, 5),
    file: true,
  }),
];

if (many) {
  LETTERS.push(...Array.from({ length: 40 }, (_, i) => ({
    ...LETTERS[0]!,
    id: `glaze-result-${i + 1}`,
    subject: `Glaze sample ${i + 1}`,
    date: day(8, 12, i),
  })));
}

const FACETS = {
  folder: { INBOX: 3, Archive: 1 },
  sender: [
    { address: "giulia@terracotta-milano.example", count: 1 },
    { address: "ben@lichtgrat.example", count: 1 },
    { address: "nadja@erdton-atelier.example", count: 1 },
  ],
  hasAttachments: { true: 1, false: 2 },
  unread: { true: 1, false: 2 },
};

type Wire = NonNullable<Awaited<ReturnType<NonNullable<EngineAdapter["searchServer"]>>>>;

/** The store's answer for the question, as the state asks: a page, a refusal, or a wait that never ends. */
function answer(text: string, filters: Record<string, unknown> | undefined): Promise<Wire> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  let rows = LETTERS.filter((m) => words.every((w) => `${m.subject} ${m.from.name} ${m.snippet}`.toLowerCase().includes(w)));
  if (filters?.folder) rows = rows.filter((m) => m.folder === filters.folder);
  if (filters?.sender) rows = rows.filter((m) => m.from.address === filters.sender);
  if (filters?.to) rows = rows.filter((m) => m.to.some((p) => p.address === filters.to));
  if (filters?.party)
    rows = rows.filter((m) => m.from.address === filters.party || m.to.some((p) => p.address === filters.party));
  if (filters?.unread) rows = rows.filter((m) => m.unread);
  const plain: Wire = { items: rows, total: rows.length, totalExact: true, ms: 12, tier: "exact", facets: FACETS };
  switch (shown.verdict) {
    case "searching":
      return new Promise(() => undefined);
    case "unanswered":
      return Promise.reject(new Error("network"));
    case "failed":
      return Promise.reject(Object.assign(new Error("store refused (500)"), { status: 500 }));
    case "atleast":
      return Promise.resolve({ ...plain, total: 2000, totalExact: false });
    case "about":
      return Promise.resolve({ ...plain, total: 2000, totalExact: false, totalEstimate: 2400 });
    case "synced":
      return Promise.resolve({ ...plain, importing: true });
    case "indexing":
      return Promise.resolve({ ...plain, indexed: { done: 64, total: 100 } });
    case "mirror":
      return Promise.resolve({ ...plain, answeredFrom: "mirror" });
    case "bounded":
      return Promise.resolve({ ...plain, bounded: true });
    case "empty":
      return Promise.resolve({ ...plain, items: [], total: 0 });
    default:
      return Promise.resolve(plain);
  }
}

const mirror = new MemoryMirrorStore();
await mirror.load();
let seq = 0;
await mirror.applyChanges(
  LETTERS.map((m) => ({ type: "message" as const, op: "create" as const, id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
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
  ...(shown.verdict === "nostore"
    ? {}
    : { searchServer: (text: string, opts: { filters?: Record<string, unknown> }) => answer(text, opts.filters) }),
} as EngineAdapter;
const engine = new OhmailEngine({ adapter, store: mirror, now: () => NOW });

const words: Messages = fillOver(
  { search: en.search, screener: en.screener } as Messages,
  lang === "de" ? ({ search: de.search, screener: de.screener } as Messages) : {},
);

/** The list's room as the frame plans it on this device. */
const PLAN: LayoutPlan =
  device === "phone"
    ? { size: "compact", short: false, pointer: "coarse", device: "phone", pose: null, rail: "dock", columns: 1, handles: false }
    : device === "desktop"
      ? { size: "expanded", short: false, pointer: "fine", device: "desktop", pose: null, rail: "words", columns: 2, handles: true }
      : {
          size: "medium",
          short: false,
          pointer: "coarse",
          device: "fold",
          pose: device === "foldl" ? "land" : null,
          rail: "icons",
          columns: 2,
          handles: false,
        };
const PANE: PaneProps = {
  route: { place: "search", sub: null, open, stage: null, words: {} },
  plan: PLAN,
  keysHere: true,
};

const beside: SearchBeside = {
  words: {
    name: (m) => m.from.name || null,
    address: (m) => m.from.address,
    stamp: (m) =>
      new Date(m.date ?? NOW).toLocaleDateString(lang === "de" ? "de-CH" : "en-GB", {
        timeZone: "Europe/Zurich",
        day: "numeric",
        month: "short",
      }),
    place: (m) => (m.folder === "INBOX" ? "Ohbox" : m.folder),
    placeOfFolder: (key) => (key === "ohbox" ? "Ohbox" : key),
  },
  junk: shown.junk ? { named: "Spam" } : NONE,
  junkReadable: shown.junk,
  keysShown: device === "desktop",
  /* The account's own address stays out of the book, as the shell's does. */
  people: () =>
    [...new Map(LETTERS.filter((m) => m.from.address !== "mila@lichtgrat.example").map((m) => [m.from.address, m])).values()].map(
      (m) => ({ address: m.from.address, name: m.from.name ?? "", count: 1, lastSeen: 0 }) as unknown as AddressBookEntry,
    ),
  events: NONE,
  go: { address: () => undefined },
};

/** A press the state is, once the answer stands: the first control named so, pressed once. */
function pressWhenThere(name: string, then?: string): void {
  let tries = 0;
  const look = () => {
    const button = [...document.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().startsWith(name));
    if (!button) {
      if (++tries < 40) setTimeout(look, 50);
      return;
    }
    button.click();
    if (then) setTimeout(() => pressWhenThere(then), 50);
  };
  setTimeout(look, 300);
}

/** A window of days ending today, as the list reads its windows (a week is seven days, a month 31, a year 366). */
const windowDays = (w: "week" | "month" | "year") => {
  const today = new Date();
  const back = { week: 7, month: 31, year: 366 }[w] - 1;
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)), to: day(today) };
};

/** The blank's one word, in the page's language. */
const blankWord = (key: string): string => (lang === "de" ? de : en).search.blankNone ?? key;

function Page() {
  const [query, setQuery] = useState(shown.query);
  const boxRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const model = useSearchList({
    engine,
    scope: "mila",
    query,
    onQuery: setQuery,
    onOpen: () => undefined,
    onExit: "none",
    boxRef,
    scrollerRef,
    t: (k) => k,
    searchBy: "people",
  });
  /* The person and the filters the address sets, as a person set them: once, on the first draw. */
  const setOnce = useRef(false);
  useEffect(() => {
    if (setOnce.current) return;
    setOnce.current = true;
    const who = shown.person;
    if (who !== null) {
      const known = LETTERS.find((m) => m.from.address === who.address);
      model.setPerson({ address: who.address, name: known?.from.name ?? null, dir: who.dir });
    }
    if (shown.unread) model.setUnread(true);
    const d = shown.date;
    if (d !== null) model.setDate("window" in d ? windowDays(d.window) : d);
  }, [model]);
  return (
    <SearchAbove model={model} beside={beside} blank={searchBlankOf(model, blankWord)}>
      <div className="oh-root" style={{ height: "100vh", ...listBounds }}>
        {device === "phone" ? <SearchList {...PANE} /> : <Sheet kind="list">{<SearchList {...PANE} />}</Sheet>}
      </div>
    </SearchAbove>
  );
}

const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
document.documentElement.setAttribute("data-face", look.face);
/* `zoom=1.5`: the web door's Text size, stamped on the page as its setting stamps it. */
const zoom = q.get("zoom");
if (zoom !== null) {
  document.documentElement.style.setProperty("zoom", zoom);
  document.documentElement.style.setProperty("--ui-zoom", zoom);
}
document.documentElement.setAttribute("data-theme", look.scheme);
if (shown.press) pressWhenThere(shown.press.opener, shown.press.choice);

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone="Europe/Zurich">
    <KeymapProvider>
      <Page />
    </KeymapProvider>
  </TextProvider>,
);
