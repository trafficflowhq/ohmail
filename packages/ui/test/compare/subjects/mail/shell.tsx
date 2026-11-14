import type { ReactNode } from "react";
import {
  ColumnHandle,
  Dock,
  FolderFold,
  FolderShelf,
  Rail,
  RailEntry,
  RailFoot,
  Sheet,
  Switcher,
  type DockPlace,
  type FoldFolder,
  type RailEntryProps,
} from "../../../../src/mail/index.js";
import type { IconName } from "../../../../src/base/index.js";
import { force, type KitSubject, type Look } from "../../harness.js";
import * as W from "./world.js";

const mailSide = { word: "ohmail", label: "ohmail", title: "ohmail · g m", keyHint: "g m" };
const calSide = { word: "ohcal", label: "ohcal", title: "ohcal · g c", keyHint: "g c" };

const place = (id: IconName, name: string, count?: string, more: Partial<RailEntryProps> = {}) => (
  <RailEntry
    key={id}
    kind="place"
    icon={id}
    count={count}
    label={count ? `${name}, ${count}` : undefined}
    title={name}
    {...more}
  >
    {name}
  </RailEntry>
);
const groups = (): ReactNode[] => [
  <>
    {place("ohbox", "Ohbox", "5", { current: true })}
    {place("news", "News", "5")}
    {place("receipts", "Receipts", "2")}
  </>,
  <>{place("screener", "Screener", "6", { countHot: true })}</>,
  <>
    {place("later", "Answer Later", "2")}
    {place("parked", "Parked", "1")}
    {place("resurface", "Resurface", "1")}
  </>,
  <>
    <RailEntry kind="fold" expanded={false} title="Tags">
      Tags
    </RailEntry>
  </>,
  <>
    {place("history", "History")}
    {place("search", "Search", undefined, { keyHint: "/", keyStands: true })}
    {place("drafts", "Drafts", "1")}
    {place("settings", "Settings")}
  </>,
];
const foot = (look: Look, busy = false) => (
  <RailFoot
    pull={{ label: "Pull new mail", keyHint: "p", busy }}
    account={{ name: W.ME.name, address: W.ME.address, note: "2 mailboxes", title: "Mailboxes" }}
    tools={[
      { icon: "command", label: "Command palette · Ctrl K" },
      look.scheme === "dark" ? { icon: "sun", label: "Light" } : { icon: "moon", label: "Dark" },
    ]}
  />
);
const pair = <Switcher kind="pair" label="Mail or Calendar" current="mail" mail={mailSide} cal={calSide} />;

/** A part of the rail alone, in a rail as wide as the reference draws it. */
const inRail = (
  key: string,
  target: string,
  width: number | string,
  node: (look: Look) => ReactNode,
  more: Partial<KitSubject> = {},
): KitSubject => ({
  key,
  place: "block",
  target,
  render: (look) => (
    <div className="oh-rail" style={{ width }}>
      {node(look)}
    </div>
  ),
  ...more,
});
const entry = (state: string, node: ReactNode, more: Partial<KitSubject> = {}): KitSubject =>
  inRail(`RailEntry/${state}`, ".oh-railentry", 200, () => node, more);
const news = (
  <RailEntry kind="place" icon="news" count="5" title="News">
    News
  </RailEntry>
);

const tab = (id: IconName, label: string, count?: string, more: Partial<DockPlace> = {}): DockPlace => ({
  id,
  label,
  icon: id,
  count,
  ...more,
});
const tabs = [
  tab("ohbox", "Ohbox", "5", { current: true }),
  tab("screener", "Screener", "6", { countHot: true }),
  tab("news", "News", "5"),
  tab("receipts", "Receipts", "2"),
];
const upright = [
  ...tabs,
  tab("later", "Answer Later", "2"),
  tab("parked", "Parked", "1"),
  tab("resurface", "Resurface", "1"),
  tab("history", "History"),
  tab("drafts", "Drafts", "1"),
  tab("settings", "Settings"),
];
const dock = {
  label: "Places",
  floor: 4,
  more: { label: "More" },
  search: { label: "Search" },
  write: { label: "Write" },
};
const round = (
  <Switcher
    kind="round"
    onRail
    label="Mail or Calendar"
    current="mail"
    mail={mailSide}
    cal={{ ...calSide, wants: true }}
  />
);

export const shell: KitSubject[] = [
  {
    key: "Rail/ohbox",
    place: "window",
    target: ".oh-rail",
    render: (look) => (
      <div
        style={{
          position: "fixed",
          inset: "var(--edge) auto var(--edge) var(--edge)",
          width: "var(--rail)",
          display: "grid",
        }}
      >
        <Rail
          label="Places"
          switcher={pair}
          write={{ label: "Write", keyHint: "c" }}
          groups={groups()}
          foot={foot(look)}
        />
      </div>
    ),
  },
  inRail("RailFoot/rest", ".oh-railfoot", "var(--rail)", (look) => foot(look)),

  entry("rest", news),
  entry("hover", news, { act: force(".oh-railentry", "hover") }),
  entry("focus", news, { act: force(".oh-railentry", "focus", "focus-visible") }),
  entry(
    "current",
    <RailEntry kind="place" icon="ohbox" count="5" title="Ohbox" current>
      Ohbox
    </RailEntry>,
  ),
  entry(
    "key",
    <RailEntry kind="place" icon="screener" count="6" keyHint="g s" keyShown title="Screener">
      Screener
    </RailEntry>,
  ),
  entry(
    "tag",
    <RailEntry kind="sub" hue={150} count="4">
      Pottery Project
    </RailEntry>,
  ),
  entry(
    "working",
    <RailEntry kind="place" icon="pull" busy>
      Pull new mail
    </RailEntry>,
  ),

  {
    key: "Dock/upright",
    place: "window",
    target: ".oh-dock",
    render: () => (
      <div
        style={{
          position: "fixed",
          inset: "var(--edge) auto var(--edge) var(--edge)",
          width: "var(--rail)",
          display: "grid",
        }}
      >
        <Dock {...dock} places={upright} switcher={round} />
      </div>
    ),
  },

  {
    key: "ColumnHandle/rest",
    place: "window",
    target: ".oh-columnhandle",
    render: () => <ColumnHandle column="rail" label="Sidebar width" value={232} min={200} max={360} />,
  },
  inRail("Switcher/mail", ".oh-switcher", 232, () => pair),
  {
    key: "Sheet/plain",
    render: () => (
      <Sheet kind="plain">
        <div style={{ width: 200, height: 96 }} />
      </Sheet>
    ),
  },
  {
    key: "FolderShelf/open",
    place: "block",
    target: ".oh-foldershelf",
    on: "ground",
    render: (look) => (
      <div
        className="oh-rail"
        style={{
          display: "flex",
          flexDirection: "column",
          height: look.face === "paper" ? 430 : 408,
          padding: 0,
        }}
      >
        {/* The places run past the rail's short window, so its scroller fades them at its foot, as the sheet's does. */}
        <div className="oh-rail-scroll" data-clip="bottom">
          <FolderShelf
            label="Folders"
            expanded
            folders={[{ id: "rosa", name: "Gartenlokal Rosa" }]}
            all={{ name: "All folders", label: "All folders, 29 unread", count: "29", expanded: true }}
          >
            <FolderFold
              label="All folders"
              find={{ label: "Find a folder", value: "" }}
              groups={[
                { mailbox: "lichtgrat.example", folders: STUDIO_FOLDERS, add: { label: "New folder" } },
                { mailbox: "milabrunner.example", folders: OWN_FOLDERS, add: { label: "New folder" } },
              ]}
            />
          </FolderShelf>
        </div>
      </div>
    ),
  },
];

/** A mailbox's own folders as the fold lists them: `+` it has folders in it, `:n` its unread mail. */
const tree = (box: string, names: string): FoldFolder[] =>
  names.split("|").map((entry) => {
    const [, plus, name, count] = /^(\+?)([^:]+)(?::(\d+))?$/.exec(entry)!;
    return {
      id: `${box}/${name}`,
      name: name!,
      count,
      label: count ? `${name}, ${count} unread` : undefined,
      branch: plus ? { expanded: false, label: `Open ${name}` } : undefined,
    };
  });
const STUDIO_FOLDERS = tree(
  "studio",
  "+Archive|+Buchhaltung:1|+Importiert aus Thunderbird|+Kunden:2|+Lichtgrat intern|+Mailinglisten:20|Newsletter Entwürfe|Notes|+Presse|Privat (weiterleiten)|+Projekte|+Team:3|Templates|+Veranstaltungen|Vorlagen|+Werkstatt|Wichtig|Zu erledigen",
);
const OWN_FOLDERS = tree(
  "own",
  "+Archive|Einkäufe und Garantien|+Familie:1|+Finanzen|+Gesundheit|Notes|+Reisen|+Vereine:2|+Weiterbildung|+Wohnung",
);
