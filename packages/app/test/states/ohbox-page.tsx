/**
 * THE OHBOX'S REGISTERED STATES, drawn by address over the fake host: the Ohbox's place through the real frame,
 * its model from the real behaviour hook over a plain world (the reference's people, letters and nine conversations,
 * one table with the reader's states page: `reader-world.ts`), the shell's words beside it. The address carries the
 * reference's words (`open=none`, `show=pick`, `show=end`, `show=menu`, `state=clear`, `device=phone`,
 * `face=ohmarchy`, `scheme=dark`, `hold=1`, `show=allfiles`) and `lang`. Both columns are drawn: the host hands the
 * reader (`readerEntry` with the body's own renderer, over a fake engine holding the page's letters, their files and
 * the account's tags and mailboxes), which draws the open conversation and, while none is open, the blank the list
 * hands it. What the rail lists is the frame's fed model. `hold=1` is the read rule held: the open letter stays as
 * the world has it; without it the open letter is read, as the reference draws it once opened. The presses a key
 * names in the reading column (`at=`, `hist=`, a menu) are the opener's (`reader-pages.ts`), as a person makes them.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { ResurfacedThreadRow, ThreadMark } from "@ohmail/client-engine";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { OhboxAbove, OhboxList, ohboxPlace, type OhboxBeside } from "../../src/ohbox/index.js";
import { readerEntry, type ReaderFile, type ReaderFiles } from "../../src/reader/index.js";
import { letterBody } from "./reader-body-part.mjs";
import { fakeMail } from "../reader/support/fake-mail.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import readerDe from "../../messages/reader.de.json" with { type: "json" };
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import screenerDe from "../../messages/screener.de.json" with { type: "json" };
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import { CONVERSATIONS, conversationLetters, NOW, PEOPLE, TAGS, type Who } from "./reader-world.js";

/* The reference is drawn on Tuesday 10 November 2026: the page's clock starts there and runs on, as the reader's
   states page holds it, so every stamp the reader prints reads from that day. */
const Real = Date;
const SHIFT = NOW.getTime() - Real.now();
globalThis.Date = class extends Real {
  constructor(...args: ConstructorParameters<typeof Date>) {
    super(...((args.length > 0 ? args : [Real.now() + SHIFT]) as [number]));
  }
  static now(): number {
    return Real.now() + SHIFT;
  }
} as DateConstructor;

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
/* A posture of a folding phone is no window the page stands: it draws the computer's (its states are declared). */
const room = device === "foldl" ? ROOMS.land : (ROOMS[device as keyof typeof ROOMS] ?? ROOMS.desktop);
const show = q.get("show");
const clear = q.get("state") === "clear";
const open = q.get("open") === "none" ? null : q.get("open");
/* The read rule held: the open letter stays unread as the world has it. */
const hold = q.get("hold") === "1";
/* The product's own states (no reference draws them): an empty Ohbox, one still loading, no mailbox, and a mailbox
   nothing organizes yet. */
const own = q.get("own") as "empty" | "loading" | "nomailbox" | "notorganizing" | null;
const none = own === "empty" || own === "loading" || own === "nomailbox";

/* Times as the reference prints them: the comparison's browser reads the clock in UTC (`reader-world.ts`). */
const today = (h: number, m: number) => new Date(Date.UTC(2026, 10, 10, h, m)).toISOString();
const daysAgo = (d: number, h = 16) => new Date(Date.UTC(2026, 10, 10 - d, h, 0)).toISOString();
/* The mailbox every letter of the page is in: the account's studio mailbox, as its heads name it. */
const MAILBOX = "mb-studio";

interface Plain {
  id: string;
  who: Who;
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
    mailboxId: MAILBOX,
    threadId: p.thread ?? null,
    messageIdHeader: null,
    subject: p.subject,
    from: { name: PEOPLE[p.who].name, address: PEOPLE[p.who].address },
    to: [{ name: PEOPLE.mila.name, address: PEOPLE.mila.address }],
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
    /* What the reader draws as the letter's text: its first words, or its subject where it has none. */
    body: p.snippet || p.subject,
  }) as unknown as EngineMessage;

/* The nine conversations the reference's keys open, each letter as the reference's scenes hold it. Without `hold=1`
   the open letter is read: the reader read it, as the reference draws it once opened. */
const CONVERSED = new Map<string, EngineMessage[]>(
  Object.keys(CONVERSATIONS).map((id) => [
    id,
    conversationLetters(id, MAILBOX).map((m) =>
      m.id === open && !hold ? ({ ...m, unread: false, lastReadAt: m.date } as EngineMessage) : m,
    ),
  ]),
);
/** A letter of the nine, as the world holds it. */
const said = (conversation: string, id = conversation): EngineMessage =>
  CONVERSED.get(conversation)!.find((m) => m.id === id)!;

const hostwerk = { ...said("hostwerk-renewal"), triage: { state: "resurfaced" } } as unknown as EngineMessage;
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
  said("giulia-glaze"),
  said("giulia-glaze", "ben-glaze"),
  said("petra-talk"),
  said("ben-kiln"),
  said("ben-kiln", "ben-kiln-11"),
];
const EARLIER: EngineMessage[] = [
  said("petra-techcheck"),
  said("nadja-newtime"),
  letter({
    id: "cinderlock-code",
    who: "cinderlock",
    subject: "Your verification code",
    snippet: "",
    date: today(8, 31),
    protectedCode: true,
  }),
  said("anna-menu"),
  said("reto-photos"),
  letter({
    id: "flurina-workshop",
    who: "flurina",
    subject: "Saturday's workshop is full",
    snippet:
      "All twelve places are booked, and two people already asked about a second date. Shall we plan one for January?",
    date: daysAgo(1, 9),
  }),
  letter({
    id: "lea-lunch",
    who: "lea",
    subject: "Sunday lunch at Mum's",
    snippet:
      "Mum is making the plum tart, so come hungry. Twelve o'clock, and bring the photos from the ridge if Reto has sent them.",
    date: daysAgo(2, 19),
  }),
  letter({
    id: "tim-tickets",
    who: "tim",
    subject: "Got us tickets for the 21st",
    snippet:
      "Row 8, right side, close enough to see the drummer sweat. I will forward the details. You owe me a beer.",
    date: daysAgo(3, 18),
  }),
  letter({
    id: "carla-posters",
    who: "carla",
    subject: "The posters went up on Friday",
    snippet:
      "Half the neighbourhood asked who made them. See you at the market on Saturday, we kept a raclette for you.",
    date: daysAgo(3, 10),
  }),
  letter({
    id: "nadja-teach",
    who: "nadja",
    subject: "Would you teach the December glaze evening?",
    snippet:
      "Two hours, twelve people, Thursday the 10th or the 17th. Three people have asked who made the matte white bowls on your table.",
    date: daysAgo(4, 15),
  }),
  said("jonas-openstudio"),
  letter({
    id: "rahel-template",
    who: "rahel",
    subject: "Invoice template, final",
    snippet:
      "Final version attached, with the new bank details and the VAT line moved under the total. Use this one from Monday.",
    date: daysAgo(5, 16),
    file: true,
  }),
  ...(
    [
      ["old-carla-proofs", "carla", "Poster proofs, second round", 19, 14],
      ["old-tim-schedule", "tim", "Kiln schedule for October", 22, 9],
      ["old-lea-birthday", "lea", "Mum turns seventy", 25, 18],
      ["old-rahel-shelving", "rahel", "Shelving quote", 27, 11],
    ] as const
  ).map(([id, who, subject, d, h]) =>
    letter({ id, who, subject, snippet: "A few lines about it.", date: daysAgo(d, h) }),
  ),
];
/* `many=N`: N more rows in Earlier, every fifth a conversation of three letters, to hold the window in a real browser. */
const many = Math.max(0, Math.min(10_000, Number(q.get("many") ?? 0) || 0));
const MANY: EngineMessage[] = Array.from({ length: many }, (_, i) => {
  const date = new Date(Date.parse(daysAgo(30, 9)) - i * 60_000).toISOString();
  const base = {
    who: "tim" as const,
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
      who: "rahel",
      subject: "Re: The studio roof, again",
      snippet: "Another note about the roof.",
      date: today(9, 25),
      unread: true,
      file: true,
    }),
  );
}
/* The conversations as they stand: the nine of the reference, each letter of the account's own among them. */
const conversationOf = (id: string): readonly EngineMessage[] => {
  const thread = [...NEW, ...EARLIER].find((m) => m.id === id)?.threadId;
  return thread ? (CONVERSED.get(thread) ?? []) : [];
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
/* Each conversation's squares: the account's own letters, then read or not, as the world holds them. */
const MARKS: Record<string, ThreadMark[]> = {
  ...Object.fromEntries(builtMarks),
  ...Object.fromEntries(
    [...CONVERSED].map(([id, letters]): [string, ThreadMark[]] => [
      id,
      letters.map((m): ThreadMark =>
        m.from.address === PEOPLE.mila.address ? "mine" : m.unread ? "unread" : "read",
      ),
    ]),
  ),
};

const words: Messages = fillOver(
  /* The reader's words, and the namespaces its parts read (a sender's screening, the way to Trash, the session's). */
  {
    ...FRAME_WORDS.en,
    ...(ohboxEn as Messages),
    ...(sharedEn as Messages),
    ...(readerEn as Messages),
    ...(screenerEn as Messages),
    ...(trashEn as Messages),
    ...(doorsEn as Messages),
  },
  lang === "de"
    ? {
        ...FRAME_WORDS.de,
        ...(ohboxDe as Messages),
        ...(sharedDe as Messages),
        ...(readerDe as Messages),
        ...(screenerDe as Messages),
        ...(trashDe as Messages),
        ...(doorsDe as Messages),
      }
    : {},
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
    name: PEOPLE.mila.name,
    address: PEOPLE.mila.address,
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
/* The Ohbox's registration without its seat and its rail count, which read the mail ground: this page stands the
   list's model above the frame itself and feeds the rail it draws. */
const ohbox: PlaceEntry = { ...ohboxPlace, rail: null, panes: { kind: "columns", List, Reading: "reader" } };

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
            timeZone: "UTC",
            hour: "2-digit",
            minute: "2-digit",
          }),
        };
      if (days === 1) return { when: lang === "de" ? "gestern" : "yesterday" };
      return {
        when: d.toLocaleDateString(lang === "de" ? "de-CH" : "en-GB", {
          timeZone: "UTC",
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
      ? { every: true, mailboxes: [{ id: MAILBOX, address: PEOPLE.mila.address }] }
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
    /* What a visit of the row marks read, as today's shell reads it: the unread letters of its conversation. */
    readSetFor: (id) => {
      const members = conversationOf(id);
      const own = [hostwerk, ...NEW, ...EARLIER].filter((m) => m.id === id);
      return (members.length > 0 ? members : own).filter((m) => m.unread).map((m) => m.id);
    },
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
/* The mirror the reader reads: every letter of the list, and the members of its conversations. */
const MIRRORED = new Map<string, EngineMessage>();
for (const m of [hostwerk, ...NEW, ...EARLIER, ...[...CONVERSED.values()].flat()]) MIRRORED.set(m.id, m);
/* The account's tags, as the reading head names them. */
const TAG_ROWS = Object.fromEntries(
  Object.entries(TAGS).map(([id, tag]) => [`tag:${id}`, { id, name: tag.name, hue: tag.hue }]),
);
const mail = fakeMail([...MIRRORED.values()], [], {}, TAG_ROWS);
/* The files of the nine conversations' letters, as the reference's tiles print them; each is here, none loads. */
const FILES = new Map(
  Object.values(CONVERSATIONS).flatMap((c) =>
    c.letters.map((l): [string, typeof l.files] => [l.id, l.files]),
  ),
);
const mimeOf = (name: string): string =>
  name.endsWith(".pdf")
    ? "application/pdf"
    : name.endsWith(".jpg")
      ? "image/jpeg"
      : name.endsWith(".txt")
        ? "text/plain"
        : "application/octet-stream";
const files: ReaderFiles = {
  hold: () => () => undefined,
  itemsOf: (id) => ({
    state: "ready",
    items: (FILES.get(id) ?? []).map((f, i): ReaderFile => ({
      id: `f${i}`,
      filename: f.name,
      mimeType: mimeOf(f.name),
      sizeBytes: f.size,
      inline: false,
      state: "idle",
    })),
  }),
  open: () => undefined,
  ensure: () => undefined,
  downloadAll: () => undefined,
  /* `show=allfiles`: the person pressed Download all, and it is under way. */
  downloadingAll: () => show === "allfiles",
  cidImagesOf: () => new Map(),
  needCidImages: () => undefined,
};
/* The reader as a host hands it: the body's own renderer, the letters' files and a look at them; this world keeps
   no pictures and answers nothing: no reply's sheet, no invitation's note. */
const reader = readerEntry({
  body: letterBody,
  files,
  pictures: "none",
  look: () => undefined,
  sentCopy: "none",
  reply: "none",
  invitation: "none",
});

const { host } = fakeHost({
  engine: mail.engine,
  service: "managed",
  scope: "mila",
  places: { ohbox },
  reader,
  /* The account's two mailboxes: the letters are in the studio's, which each reading head names. */
  mailboxes: async () => [
    {
      id: "mb-mila",
      address: PEOPLE.mila.address,
      addressIsOwn: true,
      status: "active",
      organizerRole: "organizer",
    },
    {
      id: MAILBOX,
      address: "studio@lichtgrat.example",
      displayName: "Studio",
      addressIsOwn: true,
      status: "active",
      organizerRole: "organizer",
    },
  ],
  window: fakeWindow({ ...room, posture: "flat", reducedMotion: true }),
  address: fakeAddress(open ? `#/ohbox/m/${open}` : "#/ohbox"),
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone="Europe/Zurich">
    <PresentedMirrorContext.Provider value={mail.engine.read()}>
      <Page />
    </PresentedMirrorContext.Provider>
  </TextProvider>,
);
