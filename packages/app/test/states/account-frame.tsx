/**
 * THE FRAME AROUND AN ACCOUNT STATE: Settings on the managed web (on a self-hosted one for Invites, which only that
 * host lists) over the fake host, at the address of the state's section, every section registered: the state's
 * own pane in its section, a stand-in drawing nothing in every other one. The rail is fed as today's views feed it.
 * What the frame, the rail and the menu draw is theirs; the account's states are compared on the section's pane.
 */
import type { ComponentType } from "react";
import type { ConnectionFeed } from "../../src/frame/commands.js";
import { useConnectionFeed, useRailModel } from "../../src/frame/commands.js";
import type { Appearance, FrameHost, PaneProps, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { PANE_IDS, type SettingsBeside, type SettingsPanes } from "../../src/settings/contract.js";
import { paneOf } from "../../src/settings/facts.js";
import { settingsPlace } from "../../src/settings/place.js";
import { madeOf, SETTINGS } from "../settings/frame/hosts.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import todayDe from "../../messages/frame.de.json" with { type: "json" };
import todayEn from "../../messages/frame.en.json" with { type: "json" };
import { ACCOUNT, type Drawn, type Lang, type Slots } from "./account-states.js";

const nothing = (): void => {};
const BESIDE: SettingsBeside = { startAt: null, go: nothing };
const ONLINE: ConnectionFeed = { mail: null, online: true, setupHref: null, copyAsOf: null, follow: nothing };
/** The rooms the reference draws Settings in, by the address's `device`. */
const ROOM_OF = { desktop: ROOMS.desktop, phone: ROOMS.phone, fold: ROOMS.fold, foldl: ROOMS.land } as const;

type Icon = RailModel["groups"][number]["entries"][number]["icon"];

/** The rail today's views feed, in the page's language, as the frame's states page draws it: Settings is current. */
function railOf(lang: Lang, look: Appearance): RailModel {
  const today = lang === "de" ? todayDe : todayEn;
  const w = today.rail;
  const entry = (
    id: string,
    label: string,
    icon: Icon,
    count?: string,
    more: { countHot?: boolean } = {},
  ) => ({
    id,
    kind: "place" as const,
    label,
    icon,
    count,
    onPress: nothing,
    ...more,
  });
  return {
    groups: [
      {
        id: "main",
        entries: [
          entry("ohbox", w.ohbox, "ohbox", "5"),
          entry("news", w.reads, "news", "5"),
          entry("receipts", w.receipts, "receipts", "2"),
        ],
      },
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
        entries: [{ id: "tags", kind: "fold", label: w.tags, expanded: false, onPress: nothing }],
      },
      {
        id: "more",
        entries: [
          entry("history", w.history, "history"),
          { ...entry("search", w.search, "search"), keyHint: "/", keyStands: true },
          entry("drafts", w.drafts, "drafts", "1"),
          entry("settings", w.settings, "settings"),
        ],
      },
    ],
    write: { label: today.frame.dock.write, keyHint: "c", onPress: nothing },
    account: {
      name: "Mila Brunner",
      address: ACCOUNT,
      note: lang === "de" ? "2 Postfächer" : "2 mailboxes",
      title: "Account",
      onPress: nothing,
    },
    pull: { label: today.sync.pull, keyHint: "p", busy: false, onPress: nothing },
    /* The foot's two tools as the reference draws them (in the app they are search's and settings'). */
    tools: [
      { icon: "command", label: lang === "de" ? "Befehlspalette · Strg K" : "Command palette · Ctrl K" },
      look.scheme === "dark"
        ? { icon: "sun", label: lang === "de" ? "Hell" : "Light" }
        : { icon: "moon", label: lang === "de" ? "Dunkel" : "Dark" },
    ],
  };
}

const Empty = () => null;

/** The host that draws one account state in Settings, in the window the address names and the look it asks. */
export function accountFrameHost(
  drawn: Drawn,
  slots: Slots,
  at: { readonly device: string | null; readonly look: Appearance; readonly lang: Lang },
): FrameHost {
  const rail = railOf(at.lang, at.look);
  function Body() {
    /* The pane, for a browser's measures: a wrapper with no box of its own, which moves nothing. */
    return (
      <div data-account-pane="" style={{ display: "contents" }}>
        {drawn.draw(slots)}
      </div>
    );
  }
  const panes = Object.fromEntries(
    PANE_IDS.map((id) => [id, paneOf(id, { Body: id === drawn.section ? Body : Empty })]),
  ) as SettingsPanes;
  const place = settingsPlace(panes, () => BESIDE);
  if (place.panes.kind !== "columns" || place.panes.Reading === "reader")
    throw new Error("Settings draws its two columns itself");
  const { List } = place.panes;
  const Reading: ComponentType<PaneProps> = place.panes.Reading;
  /* Either column feeds the rail and the connection: on a phone's width only the section's column stands. */
  function FedList(props: PaneProps) {
    useRailModel(rail);
    useConnectionFeed(ONLINE);
    return <List {...props} />;
  }
  function FedReading(props: PaneProps) {
    useRailModel(rail);
    useConnectionFeed(ONLINE);
    return <Reading {...props} />;
  }
  const settings: PlaceEntry = { ...place, panes: { kind: "columns", List: FedList, Reading: FedReading } };
  const room = ROOM_OF[(at.device ?? "desktop") as keyof typeof ROOM_OF] ?? ROOM_OF.desktop;
  return madeOf(SETTINGS[drawn.section === "invites" ? "W-s" : "W-m"]!, {
    scope: "mila",
    account: ACCOUNT,
    places: { settings },
    window: fakeWindow({ ...room, posture: "flat", reducedMotion: true }),
    address: fakeAddress(`#/settings/${drawn.section}`),
    appearance: fakeAppearance(at.look),
  }).host;
}
