/**
 * THE CALENDAR'S REST, ITS REGISTERED STATES, drawn by address through the real frame over the fake host: the
 * Invitations panel beside a view, From mail as its place, the setup's steps as its stage, and the two settings
 * panes. The address carries the reference's own words (`screen=invitations|frommail|calsettings|calsetup`, `open`,
 * `over`, `state`, `sec`, `zone2`, `step`, `provider`, `device`, `face`, `scheme`) and `lang`; the world is
 * `calrest-world.ts`. A settings pane stands alone in the sheet's place under its name: Settings' menu lists the
 * calendar's panes once its registration names them, and is compared then.
 */
import { createRoot } from "react-dom/client";
import { calendar } from "../../src/calendar/entry.js";
import { calendarAccountsPane, calendarViewPane } from "../../src/calsettings/index.js";
import { SetupPortProvider } from "../../src/calsetup/index.js";
import { Frame } from "../../src/frame/Frame.js";
import type { CalendarEntry, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { PaneColumn, settingsPlace, type SettingsPane } from "../../src/settings/index.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { NOW_MS, worldOf, ZONE } from "./calrest-world.js";
import agendaDe from "../../messages/agenda.de.json" with { type: "json" };
import agendaEn from "../../messages/agenda.en.json" with { type: "json" };
import calendarDe from "../../messages/calendar.de.json" with { type: "json" };
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import calsettingsDe from "../../messages/calsettings.de.json" with { type: "json" };
import calsettingsEn from "../../messages/calsettings.en.json" with { type: "json" };
import calsetupDe from "../../messages/calsetup.de.json" with { type: "json" };
import calsetupEn from "../../messages/calsetup.en.json" with { type: "json" };
import dayDe from "../../messages/day.de.json" with { type: "json" };
import dayEn from "../../messages/day.en.json" with { type: "json" };
import eventDe from "../../messages/event.de.json" with { type: "json" };
import eventEn from "../../messages/event.en.json" with { type: "json" };
import frommailDe from "../../messages/frommail.de.json" with { type: "json" };
import frommailEn from "../../messages/frommail.en.json" with { type: "json" };
import invitationsDe from "../../messages/invitations.de.json" with { type: "json" };
import invitationsEn from "../../messages/invitations.en.json" with { type: "json" };
import monthDe from "../../messages/month.de.json" with { type: "json" };
import monthEn from "../../messages/month.en.json" with { type: "json" };
import settingsDe from "../../messages/settings.de.json" with { type: "json" };
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import weekDe from "../../messages/week.de.json" with { type: "json" };
import weekEn from "../../messages/week.en.json" with { type: "json" };

/* The reference's clock for every reader of the time, before anything draws. */
Date.now = () => NOW_MS;
/* The page is served from a stand-in address, which the browser does not count as a secure place: a new
   connection's id comes from here, as it does from the browser's own on the product's pages. */
if (typeof crypto.randomUUID !== "function")
  Object.defineProperty(crypto, "randomUUID", { value: () => "00000000-0000-4000-8000-000000000001" });

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
/* A device the page has no room for (the reference's book and duo) is drawn in the desktop's. */
const room = device === "foldl" ? ROOMS.land : (ROOMS[device] ?? ROOMS.desktop);
const screen = q.get("screen") ?? "invitations";
const state = q.get("state");
const open = q.get("open");

const WORDS: Record<"en" | "de", Messages> = {
  en: {
    ...FRAME_WORDS.en,
    ...({ settings: settingsEn.settings } as unknown as Messages),
    ...(calendarEn as unknown as Messages),
    ...(eventEn as unknown as Messages),
    ...(weekEn as unknown as Messages),
    ...(dayEn as unknown as Messages),
    ...(monthEn as unknown as Messages),
    ...(agendaEn as unknown as Messages),
    ...(invitationsEn as unknown as Messages),
    ...(frommailEn as unknown as Messages),
    ...(calsetupEn as unknown as Messages),
    ...(calsettingsEn as unknown as Messages),
  },
  de: {
    ...FRAME_WORDS.de,
    ...({ settings: settingsDe.settings } as unknown as Messages),
    ...(calendarDe as unknown as Messages),
    ...(eventDe as unknown as Messages),
    ...(weekDe as unknown as Messages),
    ...(dayDe as unknown as Messages),
    ...(monthDe as unknown as Messages),
    ...(agendaDe as unknown as Messages),
    ...(invitationsDe as unknown as Messages),
    ...(frommailDe as unknown as Messages),
    ...(calsetupDe as unknown as Messages),
    ...(calsettingsDe as unknown as Messages),
  },
};

/** The day each invitation the reference opens stands on. */
const DAY_OF: Readonly<Record<string, string>> = {
  "ev-techcheck": "2026-11-20",
  "ev-planning-call": "2026-11-12",
  "ev-catalogue-weekly-2026-11-17": "2026-11-17",
};

/** The reference's words for the setup's steps, in this build's: its `calendar` step is the choice of a way. */
function setupAddress(): string {
  const step = q.get("step");
  const from = q.get("from") === "settings" ? "&from=settings" : "";
  const way = q.get("provider") === "icloud" ? "icloud" : null;
  if (step === "signin" && way) return `#/cal/cal-setup?step=signin&way=${way}${from}`;
  if (step === "calendars" && ["finding", "slow", "arriving", "failed"].includes(state ?? ""))
    return `#/cal/cal-setup?step=calendars&connection=google${from}`;
  if (step === "calendars" || step === "default" || step === "wait")
    return `#/cal/cal-setup?step=${step}&way=icloud&connection=icloud${from}`;
  return `#/cal/cal-setup?step=way${from}`;
}

function addressOf(): string {
  if (screen === "frommail") return open ? `#/cal/from-mail/e/${open}` : "#/cal/from-mail";
  if (screen === "mail-settings") return "#/settings/calaccounts";
  if (screen === "calsettings") return "#/cal/calendars";
  if (screen === "calsetup") return setupAddress();
  if (screen === "day" || screen === "week") return `#/cal/${screen}/2026-11-10`;
  const view = q.get("over") === "day" ? "day" : q.get("over") === "month" ? "month" : "week";
  if (open) return `#/cal/${view}/${DAY_OF[open] ?? "2026-11-10"}/e/${open}?panel=invitations`;
  return `#/cal/${view}/2026-11-10?panel=invitations`;
}

/** The two panes' names, which Settings' menu will say once it lists them. */
const PANE_NAMES = {
  en: { accounts: "Calendar accounts", view: "View" },
  de: { accounts: "Kalenderkonten", view: "Ansicht" },
} as const;

/** A settings pane in its column, alone in the sheet's place, under the name Settings' menu will give it. */
function paneAlone(): PlaceEntry {
  const view = q.get("sec") === "calendar";
  const pane = {
    id: "general",
    group: "account",
    icon: "calendar",
    label: { said: PANE_NAMES[lang][view ? "view" : "accounts"] },
    listed: () => true,
    ...(view ? calendarViewPane : calendarAccountsPane),
  } as unknown as SettingsPane;
  const Wide = ({ plan, keysHere }: PaneProps) => (
    <PaneColumn pane={pane} plan={plan} keysHere={keysHere} back={null} />
  );
  return { id: "calsettings", body: "calsettings", rail: null, panes: { kind: "wide", Wide } };
}

const world = worldOf({
  state,
  signedOut: state === "signin",
  secondZone: q.get("zone2") === "1",
  refused: state === "error",
  extraAccounts: screen === "mail-settings" ? 20 : 0,
});
const entry: CalendarEntry = { ...calendar, places: { ...calendar.places, calsettings: paneAlone() } };
const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
document.documentElement.setAttribute("data-face", look.face);
document.documentElement.setAttribute("data-theme", look.scheme);
document.documentElement.setAttribute("lang", lang);
const made = fakeHost({
  engine: world.engine,
  service: "managed",
  scope: "mila",
  calendar: entry,
  places:
    screen === "mail-settings"
      ? { settings: settingsPlace(null, () => ({ go: () => undefined, startAt: "calaccounts" })) }
      : undefined,
  products: "both",
  wires: { calendar: world.port },
  window: fakeWindow({ ...room, posture: "flat", reducedMotion: q.get("motion") !== "full" }),
  address: fakeAddress(addressOf()),
  appearance: fakeAppearance(look),
});
/* Her own addresses, as the host reads her mailboxes: what tells an invitation from an event she organizes. */
const host = {
  ...made.host,
  reads: { ...made.host.reads, mailboxes: async () => [{ address: "mila@lichtgrat.example" }] },
};

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={fillOver(WORDS.en, WORDS[lang])} timeZone={ZONE}>
    <SetupPortProvider value={world.setup}>
      <Frame host={host} />
    </SetupPortProvider>
  </TextProvider>,
);
