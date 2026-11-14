/**
 * THE READER'S REGISTERED STATES, drawn by address through the real frame over the fake host: the reading column is
 * the reader with the body's own renderer, over a fake engine holding the reading screen's letters. The address
 * carries the reference's words (`open=lt-…`, `state=…`, `device=…`, `face=ohmarchy`, `scheme=dark`) and `lang`.
 * The list beside it is a stand-in drawn from the kit's rows: the reference's "Reading" list is its own catalogue,
 * no place of the product.
 */
import type { EngineMessage } from "@ohmail/wire";
import { createRoot } from "react-dom/client";
import { GroupHeading, ListHead, Row, Rows } from "@ohmail/ui/mail";
import type { PictureSeam } from "@ohmail/app-logic/reader";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { markSessionDead } from "@ohmail/app-logic/session/session-truth";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { readerEntry, type ReaderFile, type ReaderFiles } from "../../src/reader/index.js";
import { letterBody } from "./reader-body-part.mjs";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeMail } from "../reader/support/fake-mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { engineLetter, GROUPS, LETTERS, NOW } from "./reader-world.js";
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import readerDe from "../../messages/reader.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import screenerDe from "../../messages/screener.de.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };

/* The reference is drawn on Tuesday 10 November 2026: the page's clock starts there and runs on, so the read
   rule's dwell still passes. */
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
const room = device === "foldl" ? ROOMS.land : (ROOMS[device as keyof typeof ROOMS] ?? ROOMS.desktop);
/* The window the picture's row drew, read off the page: the frame lays out the room it is really given. */
const size = { width: window.innerWidth || room.width, height: window.innerHeight || room.height };
const open = q.get("open");
const state = q.get("state");

/* The letters, each with the text state its address names. */
const letters = Object.entries(LETTERS).map(([id, p]) => engineLetter(id, p));
/* `read=1` (the read rule's own case, no reference draws it): a conversation of three unread letters, the first
   one long, so the two after it stand below the fold. */
if (q.get("read") === "1") {
  const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the plan for the open studio.`).join(
    "\n\n",
  );
  for (const [i, id] of ["rd-a", "rd-b", "rd-c"].entries())
    letters.push({
      ...engineLetter(id, {
        from: ["Jonas Halter", "Nadja Lehner", "Flurina Caduff"][i]!,
        address: ["jonas@lichtgrat.example", "nadja@erdton-atelier.example", "flurina@haldenlicht.example"][
          i
        ]!,
        subject: "Open studio: the plan",
        at: ["2026-11-07T09:00", "2026-11-08T09:00", "2026-11-09T09:00"][i]!,
        text: i === 0 ? LONG : "Agreed, see you there.",
      }),
      threadId: "t-plan",
      unread: true,
    } as (typeof letters)[number]);
}
/* `all=1` (the panel's own case, no reference draws it): the opened letter went to two more people, so the panel
   offers Reply all beside every other verb. */
if (q.get("all") === "1")
  for (const m of letters)
    if (m.id === open)
      Object.assign(m, {
        cc: [
          { name: "Jonas Halter", address: "jonas@lichtgrat.example" },
          { name: "Nadja Lehner", address: "nadja@erdton-atelier.example" },
        ],
      });
const WITHHELD: Record<string, string> = {
  "lt-emptied": "storage_cap",
  "lt-junk": "junk_filed",
  "lt-raw": "too_large",
  "lt-expunged": "expunged",
};
const bodies: Record<string, unknown> = {};
for (const m of letters) {
  const withheld = WITHHELD[m.id];
  const slow = m.id === "lt-slow" && (state === "loading" || state === "session" || state === null);
  if (withheld || slow) {
    (m as { body?: string }).body = undefined;
    /* An expunged text leaves no preview either: the server dropped it with the text (1.0's own sentence). */
    if (withheld === "expunged") (m as { snippet: string }).snippet = "";
    bodies[m.id] = withheld
      ? { state: "ready", withheld, text: "" }
      : { state: state === "loading" ? "loading" : "failed" };
  }
  /* Filed to Junk on the mail server: the folder the junk rule reads as filed, so it is no text on its way. */
  if (m.id === "lt-junk") (m as { folder: string }).folder = state === "wait" ? "INBOX" : "ohmail/Quarantine";
}
/* The account's tags: the journal carries one, so the head stands it and the panel offers Tag. */
const TAGS = {
  "tag:t-studio": { id: "t-studio", name: "Studio", hue: "moss" },
  "tag:t-kiln": { id: "t-kiln", name: "Kiln", hue: "clay" },
};
for (const m of letters) (m as { labels: string[] }).labels = LETTERS[m.id]?.tag ? ["t-studio"] : [];
/* `hostile=1` (the requests' own case, no reference draws it): one conversation of four letters whose markup names
   pictures, styles, a typeface and a link on hosts of their own. Ben is let in; the second waits at the gate; the
   third's name claims a company; the fourth's address could not be confirmed. Pictures load by themselves. */
const hostile = q.get("hostile") === "1";
const HOSTILE = ["h-letin", "h-waiting", "h-claims", "h-unconfirmed"] as const;
if (hostile) {
  const markup = (id: string) =>
    `<style>@font-face{font-family:x;src:url(https://font.${id}.example/f.woff2)}` +
    `.b{background:url(https://css.${id}.example/bg.png)}</style>` +
    `<link rel="stylesheet" href="https://css.${id}.example/s.css">` +
    /* Nested layout tables: a designed letter, drawn in its own frame where its pictures are asked for. */
    `<table width="100%"><tr><td><table width="560"><tr><td>` +
    `<p class="b">Hello from ${id}.</p><img src="https://pix.${id}.example/a.png" alt="a" width="200" height="80">` +
    `<img src="https://pix.${id}.example/t.gif" width="1" height="1" alt="">` +
    `<p><a href="https://evil.${id}.example/x">https://bank.example/login</a></p>` +
    `</td></tr></table></td></tr></table>`;
  for (const [i, id] of HOSTILE.entries()) {
    const m = engineLetter(id, {
      from: ["Ben Arnold", "Stranger", "Bank Support", "Unconfirmed"][i]!,
      address: ["ben@kiln.example", "x@stranger.example", "support@bank-help.example", "who@unknown.example"][
        i
      ]!,
      subject: "Pictures, styles and a link",
      at: ["2026-11-06T09:00", "2026-11-07T09:00", "2026-11-08T09:00", "2026-11-09T09:00"][i]!,
      text: `Hello from ${id}.`,
    }) as EngineMessage & Record<string, unknown>;
    m.threadId = "t-hostile";
    m.remoteContent = "blocked";
    (m as { body?: string }).body = undefined;
    if (id === "h-waiting") m.physicalFolder = "ohmail/Screener";
    if (id === "h-claims") m.senderCheck = { reason: "impersonation", brand: "Bank", domainShared: false };
    if (id === "h-unconfirmed") m.senderCheck = { reason: "unverified", brand: "", domainShared: false };
    letters.push(m);
    bodies[id] = { state: "ready", text: `Hello from ${id}.`, html: markup(id) };
  }
}
/* The two designed letters whose reference shows a tracker kept out: their markup carries one, so the body says so. */
for (const id of ["lt-journal", "lt-order"]) {
  const m = letters.find((l) => l.id === id)!;
  const text = LETTERS[id]!.text;
  (m as { body?: string }).body = undefined;
  bodies[id] = {
    state: "ready",
    text,
    html: `<p>${text}</p><img src="https://pix.newsletter.example/open.gif" width="1" height="1" alt="">`,
  };
}
const mail = fakeMail(letters, ["lt-gone"], bodies, TAGS);
/* `state=session`: the server ended the session while the letter's text was on its way. */
if (state === "session") markSessionDead();
/* What the engine was asked to do, for a browser case that reads it. */
(globalThis as { readerMutations?: unknown }).readerMutations = mail.mutations;

/* The files of a letter, in the state the address names. */
/* Each state's fault as the engine names it: the tile's sentence follows the fault's class. */
const FAULTS: Record<string, { code: string | null; status?: number; retryable: boolean }> = {
  ohmail: { code: "internal", retryable: true },
  busy: { code: "mailbox_busy", retryable: true },
  server: { code: "mail_server_unreachable", retryable: true },
  unsecured: { code: "mail_server_not_secured", retryable: false },
  login: { code: "mail_server_login_refused", retryable: false },
  reconnect: { code: "mailbox_reconnect_required", retryable: false },
  signin: { code: "mailbox_not_signed_in", retryable: false },
  gone: { code: "not_found", retryable: false },
  refused: { code: null, status: 403, retryable: false },
  offline: { code: "network", retryable: true },
  session: { code: "unauthorized", retryable: false },
};
/* The sizes the reference's tiles print. */
const SIZES: Record<string, number> = {
  "ledger-2026.csv": 1_400_000,
  "menu-cards-proof-3.pdf": 1_100_000,
  "glaze-recipes.pdf": 240_000,
};
const fileOf = (name: string, i: number): ReaderFile => {
  const fault = i === 1 && state !== null ? FAULTS[state] : undefined;
  return {
    id: `f${i}`,
    filename: name,
    mimeType: name.endsWith(".pdf")
      ? "application/pdf"
      : name.endsWith(".csv")
        ? "text/csv"
        : "application/octet-stream",
    sizeBytes: SIZES[name] ?? 182_000 * (i + 1),
    inline: false,
    state: state === "fetching" && i === 1 ? "loading" : fault ? "failed" : "idle",
    ...(fault ? { code: fault.code, status: fault.status ?? null, retryable: fault.retryable } : {}),
  };
};
const files: ReaderFiles = {
  hold: () => () => undefined,
  itemsOf: (id) => {
    if (id === "lt-files" && state === "list")
      return { state: "failed", code: "failed", retryable: true, onRetry: () => undefined };
    const names = LETTERS[id]?.files ?? [];
    return { state: "ready", items: names.map(fileOf) };
  },
  open: () => undefined,
  ensure: () => undefined,
  downloadAll: () => undefined,
  downloadingAll: () => false,
  cidImagesOf: () => new Map(),
  needCidImages: () => undefined,
};

const REFUSED: Record<string, "gone" | "too_large" | "busy" | "unreachable" | "failed"> = {
  gone: "gone",
  large: "too_large",
  busy: "busy",
  unreachable: "unreachable",
  failed: "failed",
};
const liveBody = (id: string) =>
  state === "loading"
    ? new Promise<never>(() => undefined)
    : Promise.resolve(
        state && REFUSED[state]
          ? { kind: "refused" as const, reason: REFUSED[state] }
          : { kind: "loaded" as const, text: LETTERS[id]?.text ?? "", html: null },
      );

const words: Messages = fillOver(
  {
    ...FRAME_WORDS.en,
    ...(sharedEn as Messages),
    ...(ohboxEn as Messages),
    ...(screenerEn as Messages),
    ...(trashEn as Messages),
    ...(doorsEn as Messages),
    ...(readerEn as Messages),
  },
  lang === "de"
    ? {
        ...FRAME_WORDS.de,
        ...(sharedDe as Messages),
        ...(ohboxDe as Messages),
        ...(screenerDe as Messages),
        ...(trashDe as Messages),
        ...(doorsDe as Messages),
        ...(readerDe as Messages),
      }
    : {},
);

const entry = (
  id: string,
  label: string,
  icon: RailModel["groups"][number]["entries"][number]["icon"],
  count?: string,
) => ({ id, kind: "place" as const, label, icon, count, onPress: () => undefined });
const RAIL: RailModel = {
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

/** The stand-in list: the reference's "Reading" catalogue, drawn from the kit's rows. */
function List({ route }: PaneProps) {
  useRailModel(RAIL);
  return (
    <div className="st-pane">
      <ListHead title="Reading" />
      {GROUPS.map((g) => (
        <section key={g.title}>
          <GroupHeading count={String(g.ids.length)}>{g.title}</GroupHeading>
          <Rows>
            {g.ids.map((id) => {
              const p = LETTERS[id]!;
              return (
                <Row
                  key={id}
                  who={p.from}
                  address={p.address}
                  people={[{ name: p.from, address: p.address }]}
                  subject={p.subject}
                  preview={p.text}
                  when={p.at.slice(11)}
                  file={p.files ? "Has an attachment" : undefined}
                  open={route.open === id}
                />
              );
            })}
          </Rows>
        </section>
      ))}
    </div>
  );
}

/* The shell's picture door where the requests' case asks for it: each letter's pictures under its own id, on the
   page's own origin, as the web's proxy is. Elsewhere none: the reference's letters carry no pictures here. */
const pictures: PictureSeam | "none" = hostile
  ? {
      proxyFor: (id) => (url) =>
        `${location.origin}/img?mid=${encodeURIComponent(id)}&u=${encodeURIComponent(url)}`,
      consented: () => false,
      consent: () => undefined,
      auto: true,
      loadPixels: false,
      resolvedFor: () => new Map(),
      needRemote: () => undefined,
    }
  : "none";
const reader = readerEntry({
  body: letterBody,
  files,
  pictures,
  look: () => undefined,
  sentCopy: "none",
  reply: "none",
  invitation: "none",
});
const place: PlaceEntry = {
  id: "ohbox",
  body: "reading",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading: "reader" },
};

const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
document.documentElement.setAttribute("data-face", look.face);
document.documentElement.setAttribute("data-theme", look.scheme);
const { host } = fakeHost({
  engine: mail.engine,
  service: "managed",
  scope: "mila",
  /* Trash and Settings stand so the gone letter and the emptied one offer their way there; never opened here. */
  places: { ohbox: place, trash: { ...place, id: "trash" }, settings: { ...place, id: "settings" } },
  reader,
  /* The way back to a live session stands, so an ended one offers Sign in. */
  recover: () => undefined,
  wires: { liveBody },
  /* Two mailboxes, as the reference's account has: each letter's head names the one it is in. */
  mailboxes: async () => [
    {
      id: "mb-mila",
      address: "mila@lichtgrat.example",
      addressIsOwn: true,
      status: "active",
      organizerRole: "organizer",
    },
    {
      id: "mb-studio",
      address: "studio@lichtgrat.example",
      displayName: "Studio",
      addressIsOwn: true,
      /* `state=removed`: ohmail no longer reads the mailbox the emptied letter is in. */
      status: state === "removed" ? "disabled" : "connected",
      organizerRole: "organizer",
    },
  ],
  window: fakeWindow({ ...room, ...size, posture: "flat", reducedMotion: true }),
  address: fakeAddress(open ? `#/ohbox/m/${open}` : "#/ohbox"),
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone="Europe/Zurich">
    <PresentedMirrorContext.Provider value={mail.engine.read()}>
      <Frame host={host} />
    </PresentedMirrorContext.Provider>
  </TextProvider>,
);
