/**
 * WRITE'S REGISTERED STATES, drawn by address through the real frame over the fake host: the place `write` with the
 * rich editor, `WriteAbove` standing over the frame as the seating step stands it, over a composition double that
 * holds the letter the reference shows (`write-world.ts`) and answers as the shell's composition answers. The
 * address carries the reference's words (`state`, `send`, `draft`, `note`, `line`, `fromnote`, `from`, `support`,
 * `device`, `face`, `scheme`) and `lang`. `discard=sent-elsewhere` adds the narrow-column check's discard reason.
 * What a state needs a press for (the suggestions, the From menu, Send
 * later's card, a pick of files, the quality menu, the draft control) is pressed by the page once it stands, through
 * the same controls a person uses. Nothing is sent: every door of the double keeps its press in memory.
 *
 * The list beside the letter is a stand-in: the Drafts list is the places' (the comparison cuts the letter's parts).
 */
import { SignaturesPane, SignatureEditor, signaturesState } from "../../src/settings/signatures/index.js";
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import sigEn from "../../messages/settings-signatures.en.json" with { type: "json" };
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionPanel, ListHead, Sheet } from "@ohmail/ui/mail";
import { composePlan, type ComposeFields } from "@ohmail/app-logic/writing/compose";
import type { ImageQualityLevel, PicturesPort, SendSurface } from "@ohmail/app-logic/write/files";
import type { ScheduleFiles } from "@ohmail/app-logic/write/later";
import { InlineReply } from "../../src/reader/parts.js";
import "../../src/reader/column.css";
import { keySheetOver } from "../../src/keys/sheet/index.js";
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
import { fakeAddress, fakeAppearance, fakeWindow, movable, ROOMS } from "../support/fake-window.js";
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
import draftsDe from "../../messages/drafts.de.json" with { type: "json" };
import draftsEn from "../../messages/drafts.en.json" with { type: "json" };
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
const inline = q.get("inline");
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
  const savedHtml = sessionStorage.getItem("signature-html");
  const [compose, setCompose] = useState<ComposeFields>(() => {
    const first = letterOf(q);
    return note === "laterforward" ? { ...first, forwardOf: "ridge-photos" } : first;
  });
  const [replyBody, onReplyBody] = useState({ text: "", html: "" });
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
  const composeFrom = {
    mailboxId,
    address,
    choices: FROM_OPTIONS,
    substituted: q.get("fromnote") === "substituted",
    substitutedFrom: q.get("fromnote") === "substituted" ? "hello@milabrunner.example" : null,
    maxMessageBytes: note === "servermore" ? 52_428_800 : null,
    domainMatched: q.get("fromnote") === "matched",
  };
  return {
    compose,
    onComposeFields: setCompose,
    plan,
    composeFrom,
    composeElsewhere:
      q.get("discard") === "sent-elsewhere"
        ? { why: "sent", typedSince: true, earlier: false, kept: false }
        : null,
    composeSaveRefused: false,
    composeResumed: false,
    composeWaitNote: null,
    composeCloseRefusal: null,
    composeForwardFiles: forwardFiles(compose),
    sendCompose: () => {
      if (q.has("help")) document.documentElement.setAttribute("data-letter-sent", "");
    },
    closeCompose: nothing,
    discardKeepsCompose: () => null,
    replyTo: inline ? LETTER : null,
    replyMode: inline === "forward" ? "forward" : "reply",
    replyAll: inline === "reply-all",
    replyBody,
    onReplyBody,
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
    reply: inline
      ? {
          messageId: LETTER,
          mode: inline === "forward" ? "forward" : "reply",
          audience:
            inline === "forward"
              ? "forward"
              : { to: [BOOK[0]!], cc: inline === "reply-all" ? [BOOK[1]!] : [] },
          seed: { to: BOOK[0]!.address, cc: "", bcc: "" },
          invalid: { to: [], cc: [], bcc: [] },
          from: composeFrom,
          subject: { value: "Workshop notes", editable: false },
          send: { phase: "idle" },
          refusal: q.has("overlimit") ? "too_long" : null,
          held: null,
        }
      : null,
    loadQuotedHistory: async () => ["Can you send the workshop notes?"],
    composeSend: said.send,
    composeReopenedSending: false,
    composeLocked: said.locked ? { sentence: SHELL[lang].lastSession } : null,
    composeHeld: said.held === null ? null : { draftId: said.held },
    composeFilesNotKept: null,
    signatures: {
      text: { [MILA]: sessionStorage.getItem("signature-text") ?? SIGNATURE, [HELLO]: SIGNATURE },
      html: savedHtml ? { [MILA]: savedHtml } : {},
    },
    discardCompose: nothing,
    discardReply: nothing,
    removeComposeSig: nothing,
    removeReplySig: nothing,
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
    press(say("later.pick"));
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
  {
    ...settingsEn,
    ...sigEn,
    ...FRAME_WORDS.en,
    ...(draftsEn as Messages),
    ...(writeEn as Messages),
    ...(sharedEn as Messages),
  },
  lang === "de"
    ? { ...FRAME_WORDS.de, ...(draftsDe as Messages), ...(writeDe as Messages), ...(sharedDe as Messages) }
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
const entryParts = writeEntry({ editor });
function Conversation({ keysHere, plan }: PaneProps) {
  const verbs = entryParts.reply.useVerbs();
  return (
    <div className="rd-column" data-read-column="">
      <Sheet
        kind="reading"
        flushFoot
        back={plan.device === "phone" ? { word: "Back", onPress: () => undefined } : undefined}
        label="Conversation"
        foot={
          <ActionPanel label="Letter actions" items={verbs ?? []} more={{ label: "More", behind: true }} />
        }
      >
        <article style={{ minHeight: "100dvh" }}>Can you send the workshop notes?</article>
        <InlineReply reply={entryParts.reply} letters={[LETTER]} keysHere={keysHere} />
      </Sheet>
    </div>
  );
}
function SignatureSettings() {
  const model = signaturesState();
  const mailbox = model.mailboxes[0]!;
  const [stored, setStored] = useState(() => ({
    text: sessionStorage.getItem("signature-text") ?? mailbox.stored.text,
    html: sessionStorage.getItem("signature-html") ?? "",
  }));
  return (
    <Sheet kind="reading" label="Signatures" back={device === "phone" ? { word: "Settings" } : undefined}>
      <SignaturesPane
        model={{
          ...model,
          mailboxes: [{ ...mailbox, stored }],
          editor: (props) => <SignatureEditor {...props} editor={editor} />,
          write: async (id, text, html) => {
            const plain =
              text ?? new DOMParser().parseFromString(html ?? "", "text/html").body.textContent ?? "";
            sessionStorage.setItem("signature-text", plain);
            sessionStorage.setItem("signature-html", html ?? "");
            setStored({ text: plain, html: html ?? "" });
            return model.write(id, plain, html);
          },
        }}
      />
    </Sheet>
  );
}
const write = writePlace(
  {
    ...entryParts,
    Letter: q.has("signature") ? SignatureSettings : inline ? Conversation : entryParts.Letter,
  },
  List,
);

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
const { host: webHost } = fakeHost({
  engine: NO_ENGINE,
  service: "managed",
  scope: "mila",
  places: { write },
  overs: q.has("help") ? { keys: keySheetOver } : undefined,
  window: fakeWindow({ ...room, ...size, posture: "flat", reducedMotion: true }),
  address: fakeAddress("#/compose"),
  appearance: fakeAppearance(look),
});

const keyboard = movable({ height: 0 });
const host = q.has("native") ? { ...webHost, signals: { ...webHost.signals, keyboard } } : webHost;
if (q.has("native")) {
  document.addEventListener("test-keyboard", (event) => {
    keyboard.set({ height: (event as CustomEvent<number>).detail });
  });
}

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone={ZONE}>
    <Page />
  </TextProvider>,
);
