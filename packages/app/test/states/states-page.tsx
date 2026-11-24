/**
 * THE FRAME'S REGISTERED STATES, drawn by address over the fake host: the page the comparison's subjects open.
 * The address carries the reference's own words (`screen=states&show=full`, `device=phone`, `face=ohmarchy`,
 * `scheme=dark`, `kind=connection&show=offline`, `kind=reports&say=Parked`, `fx=offline,unsaved,…`) and `lang`.
 * What the frame draws is the frame's; the panes are stand-ins, and their rows are declared as other tasks'.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";
import { Frame } from "../../src/frame/Frame.js";
import { useConnectionFeed, useNotice, useRailModel, useReport } from "../../src/frame/commands.js";
import type { FrameNotice, PaneProps, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { PLACE_IDS } from "../../src/frame/contract.js";
import { fillOver, TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import todayDe from "../../messages/frame.de.json" with { type: "json" };
import todayEn from "../../messages/frame.en.json" with { type: "json" };

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
const room = device === "foldl" ? ROOMS.land : ROOMS[device];

const NOTICES: Record<string, FrameNotice> = {
  full: {
    kind: "mailboxFull",
    title: "milabrunner.example is full",
    hot: true,
    line: "Sent copies wait until your mail server has room.",
    acts: [
      { label: "Mailboxes", onPress: () => undefined },
      { label: "Not now", onPress: () => undefined },
    ],
  },
  unsaved: {
    kind: "unsaved",
    title: "2 changes not saved",
    hot: true,
    acts: [{ label: "Show", onPress: () => undefined }],
  },
  waiting: {
    kind: "waiting",
    title: "3 changes wait for ohmail Cloud",
    acts: [{ label: "Show", onPress: () => undefined }],
  },
  storage: {
    kind: "storage",
    title: "Storage 92% full",
    hot: true,
    line: "6.1 GB after the import.",
    acts: [
      { label: "Storage", onPress: () => undefined },
      { label: "Not now", onPress: () => undefined },
    ],
  },
  trial: {
    kind: "trial",
    title: "Trial ends Wed 18 Nov",
    acts: [
      { label: "Subscribe", onPress: () => undefined },
      { label: "Not now", onPress: () => undefined },
    ],
  },
};

/* The rail today's views feed, in the page's language: their own rail and sync words. */
const today_ = lang === "de" ? todayDe : todayEn;
const w = today_.rail;
const entry = (
  id: string,
  label: string,
  icon: RailModel["groups"][number]["entries"][number]["icon"],
  count?: string,
  more: Partial<RailModel["groups"][number]["entries"][number]> = {},
) => ({ id, kind: "place" as const, label, icon, count, onPress: () => undefined, ...more });
const RAIL: RailModel = {
  groups: [
    {
      id: "main",
      entries: [
        entry("ohbox", w.ohbox, "ohbox", "5"),
        entry("news", w.reads, "news", "5"),
        entry("receipts", w.receipts, "receipts", "2"),
      ],
    },
    /* Somebody waits in the Screener: its count is drawn hot. */
    { id: "screener", entries: [entry("screener", w.screener, "screener", "6", { countHot: true })] },
    {
      id: "later",
      entries: [
        entry("later", w.replyLater, "later", "2"),
        entry("parked", w.setAside, "parked", "1"),
        entry("resurface", w.resurface, "resurface", "1"),
      ],
    },
    {
      id: "tags",
      entries: [{ id: "tags", kind: "fold", label: w.tags, expanded: false, onPress: () => undefined }],
    },
    {
      id: "more",
      entries: [
        entry("history", w.history, "history"),
        entry("search", w.search, "search", undefined, { keyHint: "/", keyStands: true }),
        entry("drafts", w.drafts, "drafts", "1"),
        entry("settings", w.settings, "settings"),
      ],
    },
  ],
  write: { label: today_.frame.dock.write, keyHint: "c", onPress: () => undefined },
  account: {
    name: "Mila Brunner",
    address: "mila@lichtgrat.example",
    note: lang === "de" ? "2 Postfächer" : "2 mailboxes",
    title: "Account",
    onPress: () => undefined,
  },
  pull: { label: today_.sync.pull, keyHint: "p", busy: false, onPress: () => undefined },
  /* The foot's two tools as the reference draws them (in the app they are search's and settings'). */
  tools: [
    { icon: "command", label: lang === "de" ? "Befehlspalette · Strg K" : "Command palette · Ctrl K" },
    q.get("scheme") === "dark"
      ? { icon: "sun", label: lang === "de" ? "Hell" : "Light" }
      : { icon: "moon", label: lang === "de" ? "Dunkel" : "Dark" },
  ],
};

const mail = (key: MailState["key"]): MailState =>
  ({
    key,
    clock: false,
    count: 0,
    total: null,
    reason: null,
    errorCode: null,
    asOf: null,
    address: null,
    minutes: null,
    slow: false,
    screenerCandidate: false,
    pending: 0,
    filing: null,
    continuesAtFolder: null,
    settled: true,
    owed: false,
  }) as MailState;

/** An instant today at the given hour and minute in the zone: the simulation's "Offline since 09:24". */
function todayAt(hhmm: string, timeZone: string): string {
  const day = (at: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      at,
    );
  const clock = (at: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  const today = day(new Date());
  for (let hours = -14; hours <= 14; hours++) {
    const at = new Date(Date.parse(`${today}T${hhmm}:00Z`) - hours * 3_600_000);
    if (day(at) === today && clock(at) === hhmm) return at.toISOString();
  }
  throw new Error(`no ${hhmm} today in ${timeZone}`);
}
const ZONE = "Europe/Zurich";
const firstSync = q.get("show") === "firstsync";

/** The stand-in body: it feeds the frame as today's views do, and draws a plain list and reading sheet. */
function Body({ route, plan }: PaneProps) {
  const [syncing, setSyncing] = useState(firstSync);
  useRailModel(RAIL);
  const fx = (q.get("fx") ?? (q.get("show") === "full" ? "full" : "")).split(",");
  useNotice(fx.flatMap((k) => NOTICES[k] ?? []));
  const offline = fx.includes("offline") || (q.get("kind") === "connection" && q.get("show") === "offline");
  useConnectionFeed({
    mail: offline ? mail("stale") : syncing ? { ...mail("importing"), count: 3846 } : null,
    online: !offline,
    copyAsOf: offline ? todayAt("09:24", ZONE) : null,
    setupHref: null,
    follow: () => undefined,
  });
  const report = useReport();
  const say = q.get("kind") === "reports" ? q.get("say") : null;
  useEffect(() => {
    if (say) report(say, { action: "Undo", actionKey: "z", onAction: () => undefined });
  }, [report, say]);
  const finish =
    syncing && q.has("controls") ? (
      <button onClick={() => setSyncing(false)}>Finish first sync</button>
    ) : null;
  /* Beside a rail the list lies on the frame's sheet; on a phone's width it draws its own, under the catalogue's head, as
     the reference's does, and scrolls as the product's list does: a scroller of its own under the dock. */
  if (plan.device === "phone")
    return (
      <div className="st-phone" data-place={route.place}>
        <div className="st-rows">{finish}</div>
      </div>
    );
  return (
    <div className="st-fill" data-place={route.place}>
      {finish}
    </div>
  );
}
const today: PlaceEntry["panes"] = {
  kind: "columns",
  List: Body,
  /* The reference's reading column is the catalogue's: no sheet of its own, its foot's corners rounded. */
  Reading: () => <div className="st-column" />,
};
const places = Object.fromEntries(
  PLACE_IDS.map((id) => [id, { id, body: "states", rail: null, panes: today } satisfies PlaceEntry]),
);

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
  places,
  window: fakeWindow({
    ...room,
    posture: "flat",
    reducedMotion: firstSync ? matchMedia("(prefers-reduced-motion: reduce)").matches : true,
  }),
  /* The reference stands on its own screen, a place the dock does not carry: no entry is current, the dock's More is. */
  address: fakeAddress("#/trash"),
  appearance: fakeAppearance(look),
});

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={fillOver(FRAME_WORDS.en, FRAME_WORDS[lang])} timeZone={ZONE}>
    <Frame host={host} />
  </TextProvider>,
);
