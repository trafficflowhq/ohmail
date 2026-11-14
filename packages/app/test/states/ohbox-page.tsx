/**
 * THE OHBOX'S REGISTERED STATES, drawn by address over the fake host: the Ohbox's place through the real frame,
 * its model from the real behaviour hook over a plain world (the reference's people and letters), the shell's
 * words beside it. The address carries the reference's words (`open=none`, `show=pick`, `show=end`, `show=menu`,
 * `state=clear`, `device=phone`, `face=ohmarchy`, `scheme=dark`) and `lang`. What the reading column draws once a
 * letter is open, and its blank while none is, are the reader's (the list hands it the blank); what the rail lists
 * is the frame's fed model.
 */
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { EngineMessage, ResurfacedThreadRow, ThreadMark } from "@ohmail/client-engine";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { OhboxAbove, OhboxList, ohboxPlace, type OhboxBeside } from "../../src/ohbox/index.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
const room = device === "foldl" ? ROOMS.land : ROOMS[device];
const show = q.get("show");
const clear = q.get("state") === "clear";
const open = q.get("open") === "none" ? null : q.get("open");
/* The product's own states (no reference draws them): an empty Ohbox, one still loading, no mailbox, and a mailbox
   nothing organizes yet. */
const own = q.get("own") as "empty" | "loading" | "nomailbox" | "notorganizing" | null;
const none = own === "empty" || own === "loading" || own === "nomailbox";

const NOW = new Date("2026-11-10T10:30:00.000Z");
const today = (h: number, m: number) => new Date(Date.UTC(2026, 10, 10, h - 1, m)).toISOString();
const daysAgo = (d: number, h = 16) => new Date(Date.UTC(2026, 10, 10 - d, h - 1, 0)).toISOString();

interface Plain {
  id: string;
  from: string;
  address: string;
  subject: string;
  snippet: string;
  date: string;
  unread?: boolean;
  thread?: string;
  file?: boolean;
  protectedCode?: boolean;
}
const letter = (p: Plain): EngineMessage =>
  ({
    id: p.id,
    accountId: "mila",
    mailboxId: "mb",
    threadId: p.thread ?? null,
    messageIdHeader: null,
    subject: p.subject,
    from: { name: p.from, address: p.address },
    to: [],
    cc: [],
    date: p.date,
    folder: "INBOX",
    snippet: p.snippet,
    unread: p.unread ?? false,
    hasAttachments: p.file ?? false,
    attachmentCount: p.file ? 1 : 0,
    protected: p.protectedCode ? { kind: "code" } : null,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: p.date,
  }) as unknown as EngineMessage;

const hostwerk = {
  ...letter({
    id: "hostwerk-renewal",
    from: "Hostwerk",
    address: "billing@hostwerk.example",
    subject: "Domain renewal: lichtgrat.example expires 30 Nov",
    snippet: "Renew before the end of the month to keep the domain.",
    date: daysAgo(7, 9),
    unread: true,
  }),
  triage: { state: "resurfaced" },
} as unknown as EngineMessage;
const RESURFACED: ResurfacedThreadRow[] = [
  {
    key: "msg:hostwerk-renewal",
    threadId: null,
    members: [hostwerk],
    pinned: [hostwerk],
    openTarget: hostwerk,
    count: 1,
    countFromThread: false,
    resurfacedAt: null,
    newSince: [],
    badge: false,
    pulledForward: false,
  },
];
const NEW: EngineMessage[] = [
  letter({
    id: "giulia-glaze",
    thread: "glaze",
    from: "Giulia Rossi",
    address: "giulia@terra-cotta.example",
    subject: "Re: Glaze order #2291",
    snippet: "Both glazes leave Milano on Thursday.",
    date: today(9, 12),
    unread: true,
    file: true,
  }),
  letter({
    id: "ben-glaze",
    thread: "glaze",
    from: "Ben Arnold",
    address: "ben@kiln.example",
    subject: "Re: Glaze order #2291",
    snippet: "Can we add the celadon?",
    date: today(8, 59),
    unread: true,
  }),
  letter({
    id: "petra-talk",
    from: "Petra Wyss",
    address: "petra@makersfest.example",
    subject: "Your talk is on the programme",
    snippet: "“Wabi-sabi for the rest of us” made the final programme.",
    date: today(8, 47),
    unread: true,
    file: true,
  }),
  letter({
    id: "ben-kiln",
    thread: "kiln",
    from: "Ben Arnold",
    address: "ben@kiln.example",
    subject: "Kiln is fixed, and Friday pizza",
    snippet: "The new element is in and it reaches temperature.",
    date: today(7, 58),
    unread: true,
  }),
  letter({
    id: "jonas-kiln",
    thread: "kiln",
    from: "Jonas Halter",
    address: "jonas@kiln.example",
    subject: "Re: Kiln is fixed, and Friday pizza",
    snippet: "Pizza from the wood oven, I bring the dough.",
    date: today(7, 41),
    unread: true,
  }),
];
const EARLIER: EngineMessage[] = [
  letter({
    id: "petra-techcheck",
    from: "Petra Wyss",
    address: "petra@makersfest.example",
    subject: "Invitation: Tech check, main hall",
    snippet: "Petra Wyss invited you to the tech check.",
    date: today(8, 39),
  }),
  letter({
    id: "nadja-glaze",
    from: "Nadja Lehner",
    address: "nadja@erdton-atelier.example",
    subject: "New time proposed: glaze evening planning call",
    snippet: "Thursday 18:00 works better for the studio.",
    date: today(8, 35),
  }),
  letter({
    id: "cinderlock-code",
    from: "Cinderlock",
    address: "no-reply@cinderlock.example",
    subject: "Your verification code",
    snippet: "",
    date: today(8, 31),
    protectedCode: true,
  }),
  letter({
    id: "anna-menu",
    thread: "menu",
    from: "Anna Odermatt",
    address: "anna@odermatt.example",
    subject: "Re: The new menu cards",
    snippet: "The cards arrived and they look great.",
    date: daysAgo(1, 17),
  }),
  letter({
    id: "reto-photos",
    thread: "ridge",
    from: "Reto Frei",
    address: "reto@frei.example",
    subject: "Photos from the ridge",
    snippet: "The promised photos from Saturday.",
    date: daysAgo(1, 15),
    file: true,
  }),
  letter({
    id: "flurina-pottery",
    from: "Flurina Caduff",
    address: "flurina@caduff.example",
    subject: "Pottery project: next steps",
    snippet: "Shall we meet at the studio on Monday?",
    date: daysAgo(1, 11),
  }),
  ...[
    "Atelier Ahorn",
    "Tonwerk",
    "Glasurhaus",
    "Ofenbau",
    "Werkraum",
    "Kursbuero",
    "Marktplatz",
    "Paketpost",
    "Rahmenwerk",
    "Holzlager",
  ].map((from, i) =>
    letter({
      id: `earlier-${i}`,
      from,
      address: `${from.split(" ")[0]!.toLowerCase()}@post.example`,
      subject: [
        "Studio hours over the holidays",
        "Clay delivery on Friday",
        "Workshop photos",
        "Invoice 2026-114",
        "Your order has shipped",
        "Kiln schedule for December",
        "Market stall in January",
        "The glaze recipe you asked for",
        "Course feedback",
        "Shelf for the drying room",
      ][i]!,
      snippet: "A few lines about it.",
      date: daysAgo(2 + i),
    }),
  ),
];
/* `many=N`: N more rows in Earlier, every fifth a conversation of three letters, to hold the window in a real browser. */
const many = Math.max(0, Math.min(10_000, Number(q.get("many") ?? 0) || 0));
const MANY: EngineMessage[] = Array.from({ length: many }, (_, i) => {
  const date = new Date(Date.parse(daysAgo(12, 9)) - i * 60_000).toISOString();
  const base = {
    from: `Sender ${i}`,
    address: `sender${i}@post.example`,
    subject: `Letter ${i}`,
    snippet: "A few lines about it.",
    date,
  };
  if (i % 5 !== 0) return [letter({ id: `many-${i}`, ...base })];
  return [0, 1, 2].map((k) =>
    letter({
      id: `many-${i}-${k}`,
      thread: `many-${i}`,
      ...base,
      date: new Date(Date.parse(date) - k * 1_000).toISOString(),
    }),
  );
}).flat();
EARLIER.push(...MANY);
/* `long=N`: a conversation of N letters at the top of New, the last three unread (its squares are the thread's
   marks): longer than the row's room, its squares stand a run. */
const long = Math.max(0, Math.min(200, Number(q.get("long") ?? 0) || 0));
if (long > 1) {
  NEW.unshift(
    letter({
      id: "long-newest",
      thread: "long",
      from: "Kathrin Baumgartner",
      address: "kathrin@baumgartner.example",
      subject: "Re: The studio roof, again",
      snippet: "Another note about the roof.",
      date: today(9, 25),
      unread: true,
      file: true,
    }),
  );
}
/* The conversations as they stand: who is in each, the reference's people, the account's own letters among them. */
const ME = { from: "Mila Brunner", address: "mila@lichtgrat.example" };
const sent = (id: string, thread: string, subject: string, date: string): EngineMessage =>
  ({
    ...letter({ id, thread, subject, snippet: "", date, ...ME }),
    folder: "Sent",
  }) as unknown as EngineMessage;
const by = (id: string): EngineMessage => [...NEW, ...EARLIER].find((m) => m.id === id)!;
const CONVERSATIONS: Record<string, () => EngineMessage[]> = {
  glaze: () => [
    sent("mila-glaze", "glaze", "Re: Glaze order #2291", daysAgo(1, 9)),
    by("giulia-glaze"),
    by("ben-glaze"),
  ],
  kiln: () => [
    sent("mila-kiln", "kiln", "Re: Kiln is fixed, and Friday pizza", daysAgo(1, 8)),
    letter({
      id: "tobias-kiln",
      thread: "kiln",
      from: "Tobias Frei",
      address: "tobias@kiln.example",
      subject: "Re: Kiln is fixed, and Friday pizza",
      snippet: "",
      date: daysAgo(1, 10),
    }),
    letter({
      id: "rahel-kiln",
      thread: "kiln",
      from: "Rahel Beck",
      address: "rahel@kiln.example",
      subject: "Re: Kiln is fixed, and Friday pizza",
      snippet: "",
      date: daysAgo(1, 11),
    }),
    by("jonas-kiln"),
    by("ben-kiln"),
  ],
  menu: () => [sent("mila-menu", "menu", "Re: The new menu cards", daysAgo(1, 16)), by("anna-menu")],
  ridge: () => [
    letter({
      id: "tim-ridge",
      thread: "ridge",
      from: "Tim Berger",
      address: "tim@berger.example",
      subject: "Photos from the ridge",
      snippet: "",
      date: daysAgo(2, 9),
    }),
    letter({
      id: "lea-ridge",
      thread: "ridge",
      from: "Lea Brunner",
      address: "lea@brunner.example",
      subject: "Photos from the ridge",
      snippet: "",
      date: daysAgo(2, 10),
    }),
    sent("mila-ridge", "ridge", "Re: Photos from the ridge", daysAgo(1, 14)),
    by("reto-photos"),
  ],
};
const conversationOf = (id: string): readonly EngineMessage[] => {
  const thread = [...NEW, ...EARLIER].find((m) => m.id === id)?.threadId;
  return thread && CONVERSATIONS[thread] ? CONVERSATIONS[thread]() : [];
};
const builtMarks: [string, ThreadMark[]][] = [
  ...(long > 0
    ? [
        ["long", Array.from({ length: long }, (_, i): ThreadMark => (i >= long - 3 ? "unread" : "read"))] as [
          string,
          ThreadMark[],
        ],
      ]
    : []),
  ...Array.from({ length: many }, (_, i) => i)
    .filter((i) => i % 5 === 0)
    .map((i): [string, ThreadMark[]] => [`many-${i}`, ["read", "read", "read"]]),
];
const MARKS: Record<string, ThreadMark[]> = {
  ...Object.fromEntries(builtMarks),
  glaze: ["read", "read", "read", "unread", "unread"],
  kiln: ["read", "read", "read", "read", "read", "read", "read", "read", "unread", "unread"],
  menu: ["read", "read", "mine"],
  ridge: ["read", "read", "read", "mine"],
};

const words: Messages = fillOver(
  { ...FRAME_WORDS.en, ...(ohboxEn as Messages), ...(sharedEn as Messages) },
  lang === "de" ? { ...FRAME_WORDS.de, ...(ohboxDe as Messages), ...(sharedDe as Messages) } : {},
);

const entry = (
  id: string,
  label: string,
  icon: RailModel["groups"][number]["entries"][number]["icon"],
  count?: string,
  current?: boolean,
) => ({ id, kind: "place" as const, label, icon, count, current, onPress: () => undefined });
const RAIL: RailModel = {
  groups: [
    {
      id: "main",
      entries: [
        entry("ohbox", "Ohbox", "ohbox", clear ? undefined : "5", true),
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
      entries: [{ id: "tags", kind: "fold", label: "Tags", expanded: false, onPress: () => undefined }],
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
  write: { label: "Write", onPress: () => undefined },
  account: {
    name: "Mila Brunner",
    address: "mila@lichtgrat.example",
    note: "2 mailboxes",
    title: "Account",
    onPress: () => undefined,
  },
  pull: { label: "Pull new mail", busy: false, onPress: () => undefined },
};

/** The list as the frame mounts it, feeding the rail the way today's views do. */
function List(props: PaneProps) {
  useRailModel(RAIL);
  return <OhboxList {...props} />;
}
const ohbox: PlaceEntry = { ...ohboxPlace, panes: { ...ohboxPlace.panes, List } as PlaceEntry["panes"] };

const beside: OhboxBeside = {
  words: {
    name: (m) => m.from.name ?? m.from.address,
    address: (m) => m.from.address,
    stamp: (m) => {
      const d = new Date(m.date ?? NOW);
      const days = Math.floor(
        (NOW.getTime() - d.getTime()) / 86_400_000 + (d.getUTCHours() > NOW.getUTCHours() ? 1 : 0),
      );
      if (days === 0)
        return {
          when: d.toLocaleTimeString("en-GB", {
            timeZone: "Europe/Zurich",
            hour: "2-digit",
            minute: "2-digit",
          }),
        };
      if (days === 1) return { when: lang === "de" ? "gestern" : "yesterday" };
      return {
        when: d.toLocaleDateString(lang === "de" ? "de-CH" : "en-GB", {
          timeZone: "Europe/Zurich",
          day: "numeric",
          month: "short",
        }),
      };
    },
    sentTo: () => null,
    mailbox: (a) => a,
    tag: (m) =>
      m.id === "hostwerk-renewal"
        ? { name: "Paperwork", hue: 45 }
        : m.id === "reto-photos"
          ? { name: "Adventures", hue: 10 }
          : null,
  },
  mail: { mailboxes: own === "nomailbox" ? 0 : 2, screenerCandidate: true, arrived: 0 },
  doorbell: { count: none ? 0 : 6, settled: true },
  notOrganizing:
    own === "notorganizing"
      ? { every: true, mailboxes: [{ id: "mb", address: "mila@lichtgrat.example" }] }
      : null,
  pull: { busy: show === "pull", run: () => undefined },
  keysShown: false,
  go: {
    screener: () => undefined,
    history: () => undefined,
    mailboxes: () => undefined,
    organize: () => undefined,
  },
};

function Page() {
  const input: OhboxListInput = {
    demo: false,
    resurfacedRows: clear || none ? [] : RESURFACED,
    newForYou: clear || none ? [] : NEW,
    previouslySeen: none ? [] : EARLIER,
    threadMarksOf: (t) => MARKS[t],
    conversationOf,
    threadSubject: () => null,
    tags: [],
    now: NOW,
    selectedId: open,
    onSelect: () => undefined,
    onEnterReader: () => undefined,
    onMarkSeen: () => undefined,
    readerId: null,
    readSetFor: (id) => [id],
    doorbellInitials: [],
    doorbellCount: none ? 0 : 6,
    settled: own !== "loading",
    owed: own === "loading",
    onDoorbell: () => undefined,
    onAction: () => undefined,
    onAddTag: () => undefined,
    onMarkAllRead: () => undefined,
    bulk: {
      run: () => true,
      tag: () => undefined,
      screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }),
      screen: () => true,
    },
    t: (k) => k,
    columnHidden: () => device === "phone",
    /* A registered state keeps no choice: the after-verb choice is the default, as for a list drawn in no shell. */
    afterVerb: () => DEFAULT_AFTER_VERB,
    rowSelector: "[data-id]",
    avatarSelector: null,
    anchors: { pickTag: () => null, row: () => null },
    readColRef: { current: null },
    senderName: (m) => m.from.name ?? m.from.address,
    sentLabelOf: () => null,
  };
  const model = useOhboxList(input);
  /* The pick of the reference: three rows of New, picked once, on the first draw (a toggle again would let go). */
  const pickedOnce = useRef(false);
  useEffect(() => {
    if (show !== "pick" || pickedOnce.current) return;
    pickedOnce.current = true;
    for (const id of ["giulia-glaze", "petra-talk", "ben-kiln"]) model.togglePick(id);
  }, [model]);
  useEffect(() => {
    if (show !== "end") return;
    const scroller = document.querySelector<HTMLElement>(".ob-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);
  useEffect(() => {
    if (show !== "menu") return;
    document
      .querySelector<HTMLElement>(`[data-id="${open ?? "giulia-glaze"}"]`)
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 420, clientY: 280 }));
  }, []);
  return (
    <OhboxAbove model={model} beside={beside}>
      <Frame host={host} />
    </OhboxAbove>
  );
}

const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
document.documentElement.setAttribute("data-face", look.face);
document.documentElement.setAttribute("data-theme", look.scheme);
const { host } = fakeHost({
  engine: NO_ENGINE,
  service: "managed",
  scope: "mila",
  places: { ohbox },
  window: fakeWindow({ ...room, posture: "flat", reducedMotion: true }),
  address: fakeAddress(open ? `#/ohbox/m/${open}` : "#/ohbox"),
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone="Europe/Zurich">
    <Page />
  </TextProvider>,
);
