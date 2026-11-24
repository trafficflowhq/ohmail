/**
 * A LONG CONVERSATION IN THE READING COLUMN, drawn by address through the real frame over the fake host: the reader
 * with the body's own renderer, the conversation's squares beside its letters (on a phone, in the bar over the
 * column), as the host hands them. The share reader-1's page for the squares' cases in a real browser
 * (`apps/webapp/test/squares-in-a-browser.test.ts`): the reader's states page holds no conversation longer than four
 * letters. The address carries `n=` (the letters, oldest first, an hour apart, each from a sender of its own, every
 * third unread), `open=` (the index of the first unread letter for cases that exercise a particular landing;
 * without it the link selects the newest), `firstUnread=` for an independent first unread index,
 * `whole=1` for the conversation without a chosen message, `device=`,
 * `face=ohmarchy`, `scheme=dark` and `motion=full` (the window as a person who did not ask for less motion has it).
 * Nothing leaves the page: the engine is the fake one.
 */
import type { EngineMessage } from "@ohmail/wire";
import { Fragment, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ListHead } from "@ohmail/ui/mail";
import {
  ListMeetingContext,
  PresentedMirrorContext,
  useReaderVisit,
  type ListMeeting,
} from "@ohmail/app-logic/reading";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame, useRailModel } from "../../src/frame/commands.js";
import type { CalendarEntry, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { NONE, type ReaderEntry } from "../../src/host/index.js";
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
const switchProducts = q.has("switch");
const latePictures = q.has("latePictures");
const embeddedPicture = q.has("embeddedPicture");
const lateBody = q.has("lateBody");
const newsletter = q.has("newsletter");
const lateNewsletter = newsletter && lateBody;
const readerEdges = q.has("readerEdges");
const waitsForOpen =
  switchProducts || latePictures || embeddedPicture || lateBody || newsletter || readerEdges;
const device = (q.get("device") ?? "desktop") as "desktop" | "phone";
const room = ROOMS[device] ?? ROOMS.desktop;
const size = { width: window.innerWidth || room.width, height: window.innerHeight || room.height };
const n = Math.max(2, Math.min(200, Number(q.get("n") ?? 40) || 40));
const openAt = Math.max(0, Math.min(n - 1, Number(q.get("open") ?? n - 1)));
const firstUnread = Number(q.get("firstUnread") ?? (q.has("open") ? openAt : 0));

/* The conversation: `n` letters a day apart, oldest first, every third unread; each a few lines long. */
const LINES = "A line of the letter that runs on for a while. ".repeat(6).trim();
const letters: EngineMessage[] = Array.from({ length: n }, (_, i) => {
  const day = new Date(Date.UTC(2026, 9, 1, 9) + i * 3_600_000);
  const m = engineLetter(`w${i}`, {
    from: `Sender ${i}`,
    address: `s${i}@example.invalid`,
    subject: "Q3 plan",
    at: day.toISOString().slice(0, 16),
    text: switchProducts ? `${LINES}\n\nOn Monday, a teammate wrote:\n${`> ${LINES}\n`.repeat(5)}` : LINES,
  } as Parameters<typeof engineLetter>[1]);
  return {
    ...m,
    threadId: "T",
    unread: i === firstUnread || (i > firstUnread && i % 3 === 0),
    ...(latePictures && (i === 0 || i === n - 1) && { body: undefined }),
    ...(embeddedPicture && i === n - 2 && { body: undefined }),
    ...(readerEdges && i === 3 && { body: undefined }),
    ...((lateBody || newsletter || readerEdges) && i === n - 1 && { body: undefined }),
    ...((latePictures || readerEdges) && i === n - 1 && { hasAttachments: true, attachmentCount: 1 }),
  } as EngineMessage;
});
const newestId = `w${n - 1}`;
function framedLetter(content: string, loadedRemoteContent = true) {
  const text = "Here is the project update.";
  return {
    state: "ready",
    text,
    html: `<table cellspacing="0" cellpadding="0"><tr><td><table cellspacing="0" cellpadding="0"><tr><td><p>${text}</p>${content}</td></tr></table></td></tr></table>`,
    loadedRemoteContent,
  };
}
function picturedLetter(name: string, extra = "") {
  return framedLetter(
    `<img src="https://pictures.example/${name}.png" alt="Project photo" width="360">${extra}`,
  );
}
const newsletterBody = picturedLetter("below", `<p>${LINES}</p>`.repeat(40));
const embeddedId = `w${n - 2}`;
const mail = fakeMail(letters, [], {
  ...(latePictures && {
    w0: picturedLetter(
      "above",
      '<img src="https://pictures.example/sized.png" alt="Project sketch" width="360" height="280">',
    ),
    [`w${n - 1}`]: q.has("short") ? picturedLetter("below") : newsletterBody,
  }),
  ...(newsletter && !lateNewsletter && { [newestId]: newsletterBody }),
  ...(readerEdges && {
    w3: framedLetter('<img src="cid:missing" alt="Unavailable logo" width="150">', false),
    [newestId]: {
      state: "ready",
      text: "Here is the project update.",
      html: '<table cellspacing="0" cellpadding="0"><tr><td><table cellspacing="0" cellpadding="0"><tr><td><p>Here is the project update.</p><img src="https://pictures.example/icon.png" alt="Project icon" width="24"><img src="https://pictures.example/sized-icon.png" alt="Sized icon" width="24" height="48" style="height:auto"></td></tr></table></td></tr></table>',
    },
  }),
  ...(embeddedPicture && {
    [embeddedId]: {
      state: "ready",
      text: "Here is the project sketch.",
      html: '<p>Here is the project sketch.</p><p><img src="cid:sketch" alt="Inline sketch" width="90" height="70"></p><p><img src="cid:logo" alt="Inline logo" width="360"><img src="cid:missing" alt="Missing part"></p>',
    },
  }),
});
if (latePictures) {
  Object.assign(window, {
    deliverEarlierBody: () => mail.patch("w1", { body: `Earlier details\n\n${LINES.repeat(12)}` }),
  });
}
if (lateBody) {
  Object.assign(window, {
    deliverLatestBody: () => {
      if (lateNewsletter) mail.putBody(newestId, newsletterBody);
      else mail.patch(newestId, { body: `${LINES}\n\n`.repeat(40) });
    },
  });
}
let pictureConsent = false;
let embeddedImages = new Map<string, string>();
const embeddedBytes = Promise.withResolvers<void>();
if (embeddedPicture) {
  Object.assign(window, {
    deliverEmbeddedImages: (sketch: string, logo: string) => {
      embeddedImages = new Map([
        ["sketch", sketch],
        ["logo", logo],
      ]);
      mail.patch(embeddedId, {});
      embeddedBytes.resolve();
    },
  });
}
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
  itemsOf: (id) => ({
    state: "ready",
    items:
      (latePictures || readerEdges) && id === newestId
        ? [
            {
              id: "plan",
              filename: "Project plan.pdf",
              mimeType: "application/pdf",
              sizeBytes: 2048,
              state: "idle",
              inline: false,
            },
          ]
        : [],
  }),
  open: () => undefined,
  ensure: () => undefined,
  downloadAll: () => undefined,
  downloadingAll: () => false,
  cidImagesOf: (id) => (id === embeddedId ? embeddedImages : new Map()),
  needCidImages: (id) => (id === embeddedId ? embeddedBytes.promise : undefined),
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
  const { commands } = useFrame();
  return (
    <div className="st-pane">
      <ListHead title="Reading" />
      {waitsForOpen && <button onClick={() => commands.open(`w${openAt}`)}>Q3 plan</button>}
    </div>
  );
}

const readerParts = readerEntry({
  body: letterBody,
  files,
  pictures:
    latePictures || readerEdges || newsletter
      ? {
          proxyFor: () => (url) => `${location.origin}/img?name=${new URL(url).pathname.slice(1)}`,
          consented: () => pictureConsent,
          consent: () => {
            pictureConsent = true;
            mail.patch(newestId, {});
          },
          auto: latePictures || newsletter,
          loadPixels: false,
          resolvedFor: () => new Map(),
          needRemote: () => undefined,
        }
      : "none",
  look: () => undefined,
  sentCopy: "none",
  reply: "none",
  invitation: readerEdges
    ? ({ messageId }) => (messageId === newestId ? <div>Project invitation</div> : null)
    : "none",
});
// Test the column control under touch without changing the foldable's normal placement.
const reader: ReaderEntry = q.has("column")
  ? {
      ...readerParts,
      Reading: (pane) => <readerParts.Reading {...pane} plan={{ ...pane.plan, device: "desktop" }} />,
    }
  : readerParts;
const place: PlaceEntry = {
  id: "ohbox",
  body: "reading",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading: "reader" },
};

const calendar: CalendarEntry = {
  Above: Fragment,
  Rail: ({ switcher }) => <nav aria-label="Calendar">{switcher}</nav>,
  places: {
    week: { id: "week", body: "week", panes: { kind: "wide", Wide: () => <h1>Calendar week</h1> } },
    day: NONE,
    month: NONE,
    year: NONE,
    agenda: NONE,
    calsearch: NONE,
    frommail: NONE,
    calsettings: NONE,
  },
  stage: NONE,
  panels: { agenda: NONE, invitations: NONE },
  useWants: () => false,
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
  ...(switchProducts && { calendar, products: "both" }),
  reader,
  window: fakeWindow({
    ...room,
    ...size,
    pointer: q.has("fine") ? "fine" : room.pointer,
    posture: "flat",
    reducedMotion: q.get("motion") !== "full",
  }),
  address: fakeAddress(waitsForOpen ? "#/ohbox" : `#/ohbox/${q.has("whole") ? "t" : "m"}/w${openAt}`),
  appearance: fakeAppearance(look),
});

const noop = () => undefined;
const disabledStep = { disabled: true, run: noop, label: "" };
function FixtureVisit({ children }: { children: ReactNode }) {
  const { wiring } = useReaderVisit({ shown: readerEdges ? letters.at(-1)! : null, markSeen: noop });
  if (wiring === null) return children;
  const meeting: ListMeeting = {
    blank: null,
    visit: {
      openId: newestId,
      unread: false,
      wiring: { ...wiring, look: "tint" },
      readSet: [],
      act: noop,
      step: { up: disabledStep, down: disabledStep },
    },
  };
  return <ListMeetingContext.Provider value={meeting}>{children}</ListMeetingContext.Provider>;
}

createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={words} timeZone="Europe/Zurich">
    <PresentedMirrorContext.Provider value={mail.engine.read()}>
      <FixtureVisit>
        <Frame host={host} />
      </FixtureVisit>
    </PresentedMirrorContext.Provider>
  </TextProvider>,
);
