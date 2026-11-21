/**
 * A LONG CONVERSATION IN THE READING COLUMN, drawn by address through the real frame over the fake host: the reader
 * with the body's own renderer, the conversation's squares beside its letters (on a phone, in the bar over the
 * column), as the host hands them. The share reader-1's page for the squares' cases in a real browser
 * (`apps/webapp/test/squares-in-a-browser.test.ts`): the reader's states page holds no conversation longer than four
 * letters. The address carries `n=` (the letters, oldest first, an hour apart, each from a sender of its own, every
 * third unread), `open=` (the index of the letter the link opens; the newest by default), `device=`,
 * `face=ohmarchy`, `scheme=dark` and `motion=full` (the window as a person who did not ask for less motion has it).
 * Nothing leaves the page: the engine is the fake one.
 */
import type { EngineMessage } from "@ohmail/wire";
import { createRoot } from "react-dom/client";
import { ListHead } from "@ohmail/ui/mail";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { readerEntry, type ReaderFiles } from "../../src/reader/index.js";
import { letterBody } from "./reader-body-part.mjs";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeMail } from "../reader/support/fake-mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { engineLetter } from "./reader-world.js";
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };

const q = new URLSearchParams(location.search);
const device = (q.get("device") ?? "desktop") as "desktop" | "phone";
const room = ROOMS[device] ?? ROOMS.desktop;
const size = { width: window.innerWidth || room.width, height: window.innerHeight || room.height };
const n = Math.max(2, Math.min(200, Number(q.get("n") ?? 40) || 40));
const openAt = Math.max(0, Math.min(n - 1, Number(q.get("open") ?? n - 1)));

/* The conversation: `n` letters a day apart, oldest first, every third unread; each a few lines long. */
const LINES = "A line of the letter that runs on for a while. ".repeat(6).trim();
const letters: EngineMessage[] = Array.from({ length: n }, (_, i) => {
  const day = new Date(Date.UTC(2026, 9, 1, 9) + i * 3_600_000);
  const m = engineLetter(`w${i}`, {
    from: `Sender ${i}`,
    address: `s${i}@example.invalid`,
    subject: "Q3 plan",
    at: day.toISOString().slice(0, 16),
    text: LINES,
  } as Parameters<typeof engineLetter>[1]);
  return { ...m, threadId: "T", unread: i % 3 === 0 && i !== openAt } as EngineMessage;
});
const mail = fakeMail(letters, [], {});
(window as unknown as { addEarlier: () => void }).addEarlier = () => {
  mail.add({
    ...letters[0]!,
    id: "earlier",
    date: "2026-09-01T09:00:00.000Z",
    arrivedAt: "2026-09-01T09:00:00.000Z",
  });
};

const files: ReaderFiles = {
  hold: () => () => undefined,
  itemsOf: () => ({ state: "ready", items: [] }),
  open: () => undefined,
  ensure: () => undefined,
  downloadAll: () => undefined,
  downloadingAll: () => false,
  cidImagesOf: () => new Map(),
  needCidImages: () => undefined,
};

const words: Messages = fillOver(
  {
    ...FRAME_WORDS.en,
    ...(sharedEn as Messages),
    ...(ohboxEn as Messages),
    ...(doorsEn as Messages),
    ...(readerEn as Messages),
  },
  {},
);

const RAIL: RailModel = {
  groups: [
    {
      id: "main",
      entries: [{ id: "ohbox", kind: "place", label: "Ohbox", icon: "ohbox", onPress: () => undefined }],
    },
  ],
  write: { label: "Write", onPress: () => undefined },
  account: {
    name: "Mila Brunner",
    address: "mila@lichtgrat.example",
    note: "",
    title: "Account",
    onPress: () => undefined,
  },
  pull: { label: "Pull new mail", busy: false, onPress: () => undefined },
};

/** The list beside the column: a head and nothing else; the squares' cases read the reading column. */
function List() {
  useRailModel(RAIL);
  return (
    <div className="st-pane">
      <ListHead title="Reading" />
    </div>
  );
}

const reader = readerEntry({
  body: letterBody,
  files,
  pictures: "none",
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
  places: { ohbox: place },
  reader,
  window: fakeWindow({ ...room, ...size, posture: "flat", reducedMotion: q.get("motion") !== "full" }),
  address: fakeAddress(`#/ohbox/m/w${openAt}`),
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={words} timeZone="Europe/Zurich">
    <PresentedMirrorContext.Provider value={mail.engine.read()}>
      <Frame host={host} />
    </PresentedMirrorContext.Provider>
  </TextProvider>,
);
