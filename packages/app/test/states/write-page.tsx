/**
 * WRITE'S REGISTERED STATES, drawn by address through the real frame over the fake host: the place `write` with the
 * rich editor, `WriteAbove` standing over the frame as the seating step stands it, over a composition double that
 * holds the letter the reference shows (`write-world.ts`) and answers as the shell's composition answers. The
 * address carries the reference's words (`state`, `send`, `draft`, `note`, `line`, `fromnote`, `from`, `support`,
 * `device`, `face`, `scheme`) and `lang`. What a state needs a press for (the suggestions, the From menu, Send
 * later's card, a pick of files, the quality menu, the draft control) is pressed by the page once it stands, through
 * the same controls a person uses. Nothing is sent: every door of the double keeps its press in memory.
 *
 * The list beside the letter is a stand-in: the Drafts list is the places' (the comparison cuts the letter's parts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ListHead } from "@ohmail/ui/mail";
import { composePlan, type ComposeFields } from "@ohmail/app-logic/writing/compose";
import type { ImageQualityLevel, PicturesPort, SendSurface } from "@ohmail/app-logic/write/files";
import type { ScheduleFiles } from "@ohmail/app-logic/write/later";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PaneProps, RailModel } from "../../src/frame/contract.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import {
  WriteAbove,
  writeEntry,
  writePlace,
  type WriteBeside,
  type WriteDraftControl,
  type WriteForwardFiles,
  type Writing,
} from "../../src/write/index.js";
import { richEditor } from "../../src/write/editor/index.js";
import type { WriteOwnText } from "../../src/write/ports.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import {
  DRAFTED,
  FROM_OPTIONS,
  forwardRowsOf,
  GRAT,
  HELLO,
  letterOf,
  MILA,
  NOW,
  picksOf,
  saidOf,
  SIGNATURE,
  TYPED,
  type Pick,
} from "./write-world.js";
import writeDe from "../../messages/write.de.json" with { type: "json" };
import writeEn from "../../messages/write.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };

/* The page's clock starts on the reference's morning and runs on. */
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
const size = { width: window.innerWidth || room.width, height: window.innerHeight || room.height };
const state = q.get("state") ?? "blank";
const note = q.get("note");
const line = q.get("line");
const said = saidOf(q);
const LETTER = "letter:new";
const ZONE = "Europe/Zurich";
const locale = lang === "de" ? "de-CH" : "en-GB";

/* ------------------------------------------------------------------ words the shell says, as its catalogue does */

const SHELL: Record<"en" | "de", Record<string, string>> = {
  en: {
    lastSession:
      "This message is still being sent from your last session. It will clear here once it has gone out.",
    noModel: "No AI model is set up on this computer. Choose one in Settings → Desktop.",
  },
  de: {
    lastSession:
      "Diese Nachricht wird noch aus deiner letzten Sitzung gesendet. Sie verschwindet hier, sobald sie raus ist.",
    noModel:
      "Auf diesem Computer ist kein KI-Modell eingerichtet. Wähle eines unter Einstellungen → Desktop.",
  },
};

/* ------------------------------------------------------------------ the shell's helpers, as the reference's */

const BOOK = [
  { name: "Ben Arnold", address: "ben@lichtgrat.example", they: false },
  { name: "Rahel Beck", address: "rahel@lichtgrat.example", they: false },
  { name: "Tim Berger", address: "tim@gassenblatt.example", they: false },
  { name: "Nadja Lehner", address: "nadja@erdton-atelier.example", they: false },
];

function fileSize(bytes: number): string {
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (bytes >= 1024 * 1024) return `${n.format(Math.round((bytes / 1024 / 1024) * 10) / 10)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const zurich = (at: string | number): string =>
  new Date(at).toLocaleString(locale, {
    timeZone: ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** An instant at a Zurich wall clock on a day from the page's today (Zurich is an hour ahead in November). */
const zurichAt = (days: number, hour: number): string =>
  new Date(Date.UTC(2026, 10, 10 + days, hour - 1, 0)).toISOString();

const filesAnswer: ScheduleFiles | null =
  note === "laternofiles"
    ? { kept: false, days: null }
    : note === "latercomputer"
      ? { kept: true, days: null }
      : { kept: true, days: 3 };

function pictures(): PicturesPort {
  let level: ImageQualityLevel = "medium";
  return {
    level: () => level,
    setLevel: (next) => {
      level = next;
    },
    compress: async (file, at) => {
      const pick = GRAT.find((g) => g.name === (file as File).name);
      if (!pick?.at || at === "original") return { blob: file, contentType: file.type };
      const bytes = pick.at[at === "low" ? 0 : at === "medium" ? 1 : 2];
      return { blob: new Blob([new Uint8Array(bytes)], { type: file.type }), contentType: file.type };
    },
  };
}

/* The reference's letter carries 19.1 MB of files, the window's own bound; its mailbox announced no ceiling. With
   `note=servermore` the mailbox announces one the window cannot carry. */
const CEILING = 20_027_801;
const surface: SendSurface = CEILING;

const beside: WriteBeside = {
  scope: "mila",
  online: () => true,
  sendLine: (send) => (send.phase === "idle" && send.previous !== true ? null : said.line),
  sendLineValues: () => ({ size: fileSize(256 * 1024) }),
  lines: {
    split: (value) => ({
      chips: value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      tail: "",
    }),
    join: (chips, tail) => [...chips, tail.trim()].filter(Boolean).join(", "),
    move: () => null,
    refused: (_raw, _focused, invalid) => invalid,
  },
  suggest: (typed, taken) =>
    typed.trim() === ""
      ? []
      : BOOK.filter(
          (p) =>
            !taken.includes(p.address) &&
            p.address !== "nadja@erdton-atelier.example" &&
            (p.name
              .toLowerCase()
              .split(" ")
              .some((w) => w.startsWith(typed.toLowerCase())) ||
              p.address.startsWith(typed.toLowerCase())),
        ),
  later: {
    options: () => [
      { id: "evening", at: zurichAt(0, 18) },
      { id: "tomorrow", at: zurichAt(1, 8) },
      { id: "monday", at: zurichAt(6, 8) },
    ],
    floor: (now) => now + 5 * 60_000,
    label: (at) => zurich(at),
    seed: () => "2026-11-13T08:00",
    compose: (value) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
      if (!m) return null;
      const at = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 1, +m[5]!)).toISOString();
      return { at, shifted: null };
    },
    zone: () => ZONE,
    useFiles: (asking) => (asking ? filesAnswer : null),
  },
  size: fileSize,
  signature: (sig, mailboxId, stored) => {
    if (sig.kind === "removed") return null;
    if (sig.kind === "edited") return sig.text.trim() === "" ? null : { text: sig.text, html: null };
    const text = mailboxId === null ? undefined : stored.text[mailboxId];
    return text ? { text, html: stored.html[mailboxId!] ?? null } : null;
  },
  pictures: pictures(),
  surface,
  metered: true,
};

/* ------------------------------------------------------------------ the composition double */

const ownOf = (): Map<string, WriteOwnText> => {
  const yours = { text: TYPED, html: "" };
  const draft = { text: DRAFTED, html: "" };
  if (state === "draft-made" || state === "draft-drafting")
    return new Map([[LETTER, { messageId: LETTER, yours, draft, shown: "draft" }]]);
  if (state === "draft-yours")
    return new Map([[LETTER, { messageId: LETTER, yours, draft, shown: "yours" }]]);
  return new Map();
};

function forwardFiles(compose: ComposeFields): WriteForwardFiles | null {
  const rows = forwardRowsOf(state);
  if (rows.length === 0) return null;
  const total = rows.reduce((n, r) => n + r.sizeBytes, 0);
  return {
    plan: {
      rows: rows.map((r) => ({ ...r, inline: false, removable: compose.forwardOf !== null })),
      line:
        line === "fwdlarge"
          ? { key: "forwardFilesTooLarge", bytes: { limit: CEILING } }
          : { key: "forwardFilesAllGo", bytes: { size: total } },
      refusal: line === "fwdlarge" ? { key: "forwardFilesTooLarge", bytes: { limit: CEILING } } : null,
    },
    onRemove: () => undefined,
    said: line === "fwdlarge",
  };
}

function useWritingDouble(): Writing {
  const [compose, setCompose] = useState<ComposeFields>(() => {
    const first = letterOf(q);
    return note === "laterforward" ? { ...first, forwardOf: "ridge-photos" } : first;
  });
  const own = useMemo(ownOf, []);
  const mailboxId = compose.fromMailboxId ?? MILA;
  const plan = composePlan(compose, mailboxId);
  const control: WriteDraftControl = {
    offered: state !== "draft-off",
    phase: state === "draft-drafting" ? "running" : "closed",
    messageId: state === "draft-drafting" || state === "draft-nomodel" ? LETTER : null,
    cost: 15,
    notice: state === "draft-nomodel" ? SHELL[lang].noModel : null,
    open: () => undefined,
    cancel: () => undefined,
    confirm: () => undefined,
    press: () => undefined,
    fromText: () => undefined,
    letter: () => undefined,
    letterId: LETTER,
    own,
    keep: () => undefined,
  };
  const address = FROM_OPTIONS.find((o) => o.id === mailboxId)!.address;
  const nothing = () => undefined;
  return {
    compose,
    onComposeFields: setCompose,
    plan,
    composeFrom: {
      mailboxId,
      address,
      choices: FROM_OPTIONS,
      substituted: q.get("fromnote") === "substituted",
      substitutedFrom: q.get("fromnote") === "substituted" ? "hello@milabrunner.example" : null,
      maxMessageBytes: note === "servermore" ? 52_428_800 : null,
      domainMatched: q.get("fromnote") === "matched",
    },
    composeElsewhere: null,
    composeSaveRefused: false,
    composeResumed: false,
    composeWaitNote: null,
    composeCloseRefusal: null,
    composeForwardFiles: forwardFiles(compose),
    sendCompose: nothing,
    closeCompose: nothing,
    discardKeepsCompose: () => null,
    replyTo: null,
    replyMode: "reply",
    replyAll: false,
    replyBody: { text: "", html: "" },
    onReplyBody: nothing,
    replyEnvelope: null,
    setReplyEnvelope: nothing,
    replyFromId: null,
    setReplyFromId: nothing,
    replySig: { kind: "following" },
    onReplySig: nothing,
    replySubjectEdit: null,
    onReplySubject: nothing,
    replyAttachments: [],
    setReplyAttachments: nothing,
    replyForwardFiles: null,
    replyBook: [],
    replySendState: () => ({ phase: "idle" }),
    showSend: () => nothing,
    heldReplyRow: () => null,
    sendReply: nothing,
    sendReplyAndDone: () => null,
    openReply: nothing,
    openForward: nothing,
    confirmForward: nothing,
    forwardAsk: null,
    closeReply: nothing,
    discardRefusal: null,
    resolveHeldSend: nothing,
    draftReply: control,
    draftReplyChrome: {
      control,
      pending: null,
      resolve: nothing,
      noCredits: state === "draft-nocredits",
    },
    openDraft: nothing,
    writeTo: nothing,
    reply: null,
    composeSend: said.send,
    composeLocked: said.locked ? { sentence: SHELL[lang].lastSession } : null,
    composeHeld: said.held === null ? null : { draftId: said.held },
    composeFilesNotKept: null,
    signatures: { text: { [MILA]: SIGNATURE, [HELLO]: SIGNATURE }, html: {} },
    discardCompose: nothing,
    discardReply: nothing,
  };
}

/* ------------------------------------------------------------------ the presses a state needs, once it stands */

const tick = (ms = 60) => new Promise((done) => setTimeout(done, ms));

/** A word of write's catalogue in the page's language, by its path under `write`. */
const say = (path: string): string =>
  String(
    path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], words["write"]) ?? path,
  );

/** The control a person would press, by its name or its words. */
function press(name: string | RegExp): void {
  const all = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')];
  const of = (b: HTMLElement) => `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.trim();
  all.find((b) => (typeof name === "string" ? of(b).startsWith(name) : name.test(of(b))))?.click();
}

function type(field: HTMLInputElement | null, value: string): void {
  if (!field) return;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  field.focus();
  set.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function pick(files: readonly Pick[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) return;
  const list = new DataTransfer();
  for (const f of files) list.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
  input.files = list.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await tick(300);
}

async function steps(): Promise<void> {
  await tick(200);
  for (const files of picksOf(q)) await pick(files);
  if (state === "suggest") type(document.querySelector<HTMLInputElement>('input[aria-label="To"]'), "be");
  if (state === "from") press(/mila@lichtgrat\.example/);
  if (state === "later" || state === "pick" || (note?.startsWith("later") ?? false)) press(say("later.verb"));
  if (state === "pick") {
    await tick();
    document
      .querySelector<HTMLElement>('[role="menu"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true }));
  }
  if (state === "draft-ask") press(say("draft.letterVerb"));
  if (state === "quality" || line === "quality") {
    press(say("files.level.medium"));
    await tick();
    if (line === "quality") {
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')]
        .find((m) => (m.textContent ?? "").startsWith(say("files.level.high")))
        ?.click();
    }
  }
  await tick(200);
  document.documentElement.setAttribute("data-ready", "1");
}

/* ------------------------------------------------------------------ the frame */

const words: Messages = fillOver(
  { ...FRAME_WORDS.en, ...(writeEn as Messages), ...(sharedEn as Messages) },
  lang === "de" ? { ...FRAME_WORDS.de, ...(writeDe as Messages), ...(sharedDe as Messages) } : {},
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
        entry("drafts", "Drafts", "drafts", "1", true),
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

/** The Drafts list's stand-in, feeding the rail the way today's views do. */
function List(_: PaneProps) {
  useRailModel(RAIL);
  return <ListHead title="Drafts" />;
}

const editor = richEditor({
  href: (raw) => (/^https?:\/\//.test(raw) ? raw : null),
  useRendered: () => undefined,
});
const write = writePlace(writeEntry({ editor }), List);

function Page() {
  const writing = useWritingDouble();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void steps();
  }, []);
  return (
    <WriteAbove writing={writing} beside={beside}>
      <Frame host={host} />
    </WriteAbove>
  );
}

const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
document.documentElement.setAttribute("data-face", look.face);
document.documentElement.setAttribute("data-theme", look.scheme);
/* The person's text size, as the web door stamps it on the root: `zoom=1.5` for 150 %. */
const zoom = Number(q.get("zoom") ?? "1");
if (zoom !== 1) {
  document.documentElement.style.setProperty("zoom", String(zoom));
  document.documentElement.style.setProperty("--ui-zoom", String(zoom));
}
const { host } = fakeHost({
  engine: NO_ENGINE,
  service: "managed",
  scope: "mila",
  places: { write },
  window: fakeWindow({ ...room, ...size, posture: "flat", reducedMotion: true }),
  address: fakeAddress("#/compose"),
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone={ZONE}>
    <Page />
  </TextProvider>,
);
