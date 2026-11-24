/**
 * A LONG CONVERSATION OF FRAMED REPLIES WHOSE EMBEDDED PICTURES ARRIVE AFTER THE OPEN, drawn through the real frame,
 * reader and letter body over the fake host. Eight letters, each a framed reply: a short own part over booking
 * tables, its embedded pictures, then a quoted history nested a few levels deep (the body folds it). The earliest
 * letters stand several thousand pixels tall; the newest is short (`newest=short`) or taller than the pane
 * (`newest=tall`), its own part holding one width-only embedded picture.
 *
 * The embedded pictures come through the reader's file door as the engine delivers them: after the letter's file
 * list, one automatic part at a time for the mailbox, `lat=` ms each, the letter's map replaced once per pass. An ask
 * marked `first` (the letter on screen) goes to the front of the line, as the engine's own line does. `lat=0` holds every part back.
 * `consent=blocked` keeps the remote pictures blocked; `face=`, `device=`. Every name, address and line is invented.
 * Nothing leaves the page but the proxied remote pictures, which the test routes.
 */
import type { EngineMessage } from "@ohmail/wire";
import { createRoot } from "react-dom/client";
import { ListHead } from "@ohmail/ui/mail";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame, useRailModel } from "../../src/frame/commands.js";
import type { PlaceEntry, RailModel } from "../../src/frame/contract.js";
import type { ReaderEntry } from "../../src/host/index.js";
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
const consentAuto = q.get("consent") !== "blocked";
const tallNewest = q.get("newest") === "tall";
const lat = Number(q.get("lat") ?? 400);
const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);
/** What arrived when: `asked <id>`, `cid <id>`, `open`. */
const events: { t: number; e: string }[] = [];
Object.assign(window, { pictureEvents: events, pageStart: t0 });

const PEOPLE = [
  ["Lena Hartmann", "lena@hartmann.example"],
  ["Orso Travel Desk", "desk@orso-travel.example"],
  ["Mila Brunner", "mila@lichtgrat.example"],
  ["Orso Travel Desk", "desk@orso-travel.example"],
  ["Lena Hartmann", "lena@hartmann.example"],
  ["Orso Travel Desk", "desk@orso-travel.example"],
  ["Mila Brunner", "mila@lichtgrat.example"],
  ["Lena Hartmann", "lena@hartmann.example"],
] as const;

/** One booking as a table-built block, the way a booking desk's mail lays it out. */
function booking(n: number): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 8px;font:14px Arial,sans-serif;color:#555;width:140px">${label}</td><td style="padding:6px 8px;font:14px Arial,sans-serif;color:#222">${value}</td></tr>`;
  return (
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:12px 0;border:1px solid #dde3e8">` +
    `<tr><td colspan="2" style="padding:8px;background:#f1f4f7;font:bold 15px Arial,sans-serif">Booking ${1000 + n}</td></tr>` +
    row("Arrival", `Thursday ${1 + (n % 27)} October, 15:00`) +
    row("Departure", `Sunday ${2 + (n % 26)} October, 11:00`) +
    row("Room", n % 2 ? "Double room, garden side" : "Single room, quiet floor") +
    row("Guests", String(1 + (n % 3))) +
    row("Rate", `${120 + n} per night, breakfast included`) +
    `</table>`
  );
}
const bookings = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => booking(from + i)).join("");

/** A quoted history `depth` levels deep, a booking or two at each level. */
function history(i: number, depth: number): string {
  if (depth === 0) return "";
  const [name, address] = PEOPLE[(i + depth) % PEOPLE.length]!;
  return (
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, ${depth} Oct 2026 at 09:${10 + depth}, ${name} &lt;${address}&gt; wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
    `<div dir="ltr"><p>The earlier note at level ${depth}.</p>${bookings(i * 100 + depth * 10, 2)}${history(i, depth - 1)}</div>` +
    `</blockquote></div>`
  );
}

/** The embedded pictures each letter carries: the three shapes senders write. */
type Shape = { cid: string; tag: string; w: number; h: number };
function shapes(i: number, count: number): Shape[] {
  return Array.from({ length: count }, (_, k) => {
    const cid = `pic${k}.l${i}@mail.example`;
    switch (k % 3) {
      case 0:
        return {
          cid,
          w: 507,
          h: 421,
          tag: `<img src="cid:${cid}" width="507" style="width:507px;height:auto;max-width:100%" alt="">`,
        };
      case 1:
        return { cid, w: 234, h: 138, tag: `<img src="cid:${cid}" width="234" height="138" alt="">` };
      default:
        return { cid, w: 180, h: 108, tag: `<img src="cid:${cid}" alt="">` };
    }
  });
}

const REMOTE =
  `<p><img src="https://pictures.example/banner.png" style="width:600px;max-width:100%" alt="Banner"></p>` +
  `<p><img src="https://pictures.example/strip.png" style="width:200px" alt="Strip"></p>` +
  `<div style="display:none"><img src="https://pictures.example/open.gif" width="1" height="0" alt=""></div>`;

/** Bookings in each earlier letter's own part (thousands of pixels), and its embedded pictures. */
const OWN = [
  { bookings: 16, pictures: 1 },
  { bookings: 45, pictures: 2 },
  { bookings: 22, pictures: 1 },
  { bookings: 70, pictures: 5 },
  { bookings: 10, pictures: 3 },
  { bookings: 30, pictures: 8 },
  { bookings: 6, pictures: 12 },
];
const NEWEST = OWN.length;
const sized = new Map<string, Shape>();
function letterHtml(i: number): string {
  const own =
    i === NEWEST
      ? tallNewest
        ? `<p>Thanks, here is the plan for the stay.</p>${"<p>We arrive on Thursday afternoon and leave on Sunday morning. The garden room suits us well, and breakfast on the terrace sounds lovely.</p>".repeat(6)}`
        : `<p>Thanks, see the plan below.</p>`
      : `<p>Here are the bookings so far.</p>${bookings(i * 100, OWN[i]!.bookings)}${i === 5 ? REMOTE : ""}`;
  const pictures = shapes(i, i === NEWEST ? 1 : OWN[i]!.pictures);
  for (const p of pictures) sized.set(p.cid, p);
  /* Nested borderless tables around the own part, as a desk's mail client writes them: a laid-out letter, framed. */
  return (
    `<table cellspacing="0" cellpadding="0"><tr><td><table cellspacing="0" cellpadding="0"><tr><td>` +
    `<div dir="ltr">${own}${pictures.map((p) => `<p>${p.tag}</p>`).join("")}<p>Best regards</p></div>` +
    `</td></tr></table></td></tr></table>` +
    history(i, 2 + (i % 5))
  );
}

const letters: EngineMessage[] = PEOPLE.map(([name, address], i) => ({
  ...engineLetter(`tp${i}`, {
    from: name,
    address,
    subject: "Autumn stay",
    at: `2026-10-0${1 + Math.floor(i / 3)}T${String(8 + i).padStart(2, "0")}:00`,
    text: "Here are the bookings so far.",
  }),
  threadId: "T",
  body: undefined,
}));
const latestId = `tp${NEWEST}`;
const bodies = Object.fromEntries(
  letters.map((m, i) => [
    m.id,
    {
      state: "ready",
      text: "Here are the bookings so far.",
      html: letterHtml(i),
      loadedRemoteContent: false,
    },
  ]),
);
const mail = fakeMail(letters, [], bodies);

/** A picture of the size the sender declared, or a plausible one where it declared none. */
function picture(cid: string): string {
  const s = sized.get(cid) ?? { w: 180, h: 108 };
  const c = document.createElement("canvas");
  c.width = s.w;
  c.height = s.h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c9d6e2";
  g.fillRect(0, 0, s.w, s.h);
  return c.toDataURL("image/png");
}

/* The mailbox's line: one automatic part fetch at a time, in ask order; a `first` ask goes to the front. */
const line: Array<() => void> = [];
let fetching = false;
const pump = () => {
  if (fetching) return;
  const go = line.shift();
  if (!go) return;
  fetching = true;
  go();
};
const turn = (first: boolean) =>
  new Promise<void>((done) => {
    const go = () =>
      setTimeout(() => {
        fetching = false;
        pump();
        done();
      }, lat);
    if (first) line.unshift(go);
    else line.push(go);
    pump();
  });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const maps = new Map<string, ReadonlyMap<string, string>>();
const passes = new Map<string, Promise<void>>();
const files: ReaderFiles = {
  hold: () => () => undefined,
  itemsOf: () => ({ state: "ready", items: [] }),
  open: () => undefined,
  ensure: () => undefined,
  downloadAll: () => undefined,
  downloadingAll: () => false,
  cidImagesOf: (id) => maps.get(id) ?? new Map(),
  needCidImages: (id: string, cids: string[], opts?: { first?: boolean }) => {
    const running = passes.get(id);
    if (running) return running;
    const want = [...new Set(cids)].filter((c) => !maps.get(id)?.has(c));
    if (want.length === 0) return undefined;
    if (lat <= 0) return new Promise<void>(() => undefined);
    events.push({ t: since(), e: `asked ${id}` });
    const pass = (async () => {
      await sleep(lat); // the letter's file list
      const minted: [string, string][] = [];
      for (const cid of want) {
        await turn(opts?.first === true);
        minted.push([cid, picture(cid)]);
      }
      maps.set(id, new Map([...(maps.get(id) ?? []), ...minted]));
      events.push({ t: since(), e: `cid ${id}` });
      mail.patch(id, {});
    })().finally(() => passes.delete(id));
    passes.set(id, pass);
    return pass;
  },
};

/** Remote pictures: the proxy is the test's route; consent stays as the address says. */
const reader: ReaderEntry = readerEntry({
  body: letterBody,
  files,
  pictures: {
    proxyFor: () => (url) => `${location.origin}/img?name=${new URL(url).pathname.slice(1)}`,
    consented: () => consentAuto,
    consent: () => undefined,
    auto: consentAuto,
    loadPixels: false,
    resolvedFor: () => new Map(),
    needRemote: () => undefined,
  },
  look: () => undefined,
  sentCopy: "none",
  reply: "none",
  invitation: "none",
});

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
function List() {
  useRailModel(RAIL);
  const { commands } = useFrame();
  return (
    <div className="st-pane">
      <ListHead title="Reading" />
      <button
        onClick={() => {
          events.push({ t: since(), e: "open" });
          commands.open(latestId);
        }}
      >
        Autumn stay
      </button>
    </div>
  );
}
const place: PlaceEntry = {
  id: "ohbox",
  body: "reading",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading: "reader" },
};
const face = q.get("face") === "ohmarchy" ? "ohmarchy" : "paper";
document.documentElement.setAttribute("data-face", face);
document.documentElement.setAttribute("data-theme", "light");
const { host } = fakeHost({
  engine: mail.engine,
  service: "managed",
  scope: "mila",
  places: { ohbox: place },
  reader,
  window: fakeWindow({ ...room, ...size, pointer: room.pointer, posture: "flat", reducedMotion: true }),
  address: fakeAddress("#/ohbox"),
  appearance: fakeAppearance({ face, scheme: "light" }),
});
createRoot(document.getElementById("root")!).render(
  <TextProvider locale="en" messages={words} timeZone="Europe/Zurich">
    <PresentedMirrorContext.Provider value={mail.engine.read()}>
      <Frame host={host} />
    </PresentedMirrorContext.Provider>
  </TextProvider>,
);
