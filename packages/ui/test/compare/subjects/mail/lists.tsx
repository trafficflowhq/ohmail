import type { ReactElement, ReactNode } from "react";
import { Button } from "../../../../src/base/index.js";
import {
  AccountRow,
  Doorbell,
  GroupHeading,
  ListHead,
  ListTail,
  MovePicker,
  ReadSquares,
  Row,
  Rows,
  SelectionBar,
  Sheet,
  type PanelVerb,
  type RowProps,
} from "../../../../src/mail/index.js";
import { force, moving, type KitSubject, type Look } from "../../harness.js";
import * as W from "./world.js";

/** A list's parts stand in the list's own sheet, as wide as the reference draws it. */
const inList = (key: string, node: ReactNode, more: Partial<KitSubject> = {}, width = 420): KitSubject => ({
  key,
  place: "block",
  width,
  target: "[data-list]",
  render: (look) =>
    BARE_ON_PHONE.has(key) && look.device === "phone" ? (
      <div data-list="">{node}</div>
    ) : (
      <div data-list="">
        <Sheet kind="list">{node}</Sheet>
      </div>
    ),
  ...more,
});
/* The sheet draws these specimens on a phone with no sheet behind them: the list stands on the ground. */
const BARE_ON_PHONE = new Set(["Row/unread", "ListHead/hot"]);
/** How wide the list's column is where the reference draws a whole screen. */
export const listWidth = (look: Look): number =>
  look.device === "desktop"
    ? 420
    : look.device === "fold"
      ? 300
      : look.device === "foldl"
        ? 327
        : look.face === "paper"
          ? 390
          : 374;

/** Where the list's first heading stands in the window of a whole screen. */
export const listCorner = (look: Look): { left: number; top: number } => {
  const paper = look.face === "paper";
  if (look.device === "desktop") return paper ? { left: 256, top: 72 } : { left: 250, top: 68 };
  if (look.device === "phone") return paper ? { left: 0, top: 68 } : { left: 8, top: 66 };
  return { left: 88, top: paper ? 76 : 72 };
};

const done = { label: "Done", icon: "check" } as const;
const file = "Has an attachment";
const row = (props: RowProps): ReactElement => <Row {...props} />;
const rows = (
  key: string,
  props: RowProps | RowProps[],
  more: Partial<KitSubject> = {},
  width?: number,
): KitSubject =>
  inList(
    key,
    <Rows>
      {[props].flat().map((p, i) => (
        <Row key={i} {...p} />
      ))}
    </Rows>,
    more,
    width,
  );

const talk: RowProps = {
  who: "Petra Wyss",
  address: W.PETRA.address,
  people: [W.PETRA],
  file,
  when: "08:47",
  subject: "Your talk is on the programme",
  preview:
    "“Wabi-sabi for web people” made the final programme: Saturday at 11:00 in the main hall. Speaker details attached, and there is a dinner on Friday.",
  unread: true,
  quick: done,
};
const techCheck: RowProps = {
  who: "Petra Wyss",
  address: W.PETRA.address,
  people: [W.PETRA],
  when: "08:39",
  subject: "Invitation: Tech check, main hall",
  preview:
    "Petra Wyss invited you: Friday 20 November, 16:00, main hall. Fifteen minutes on stage for mics, slides and the clicker.",
};
const newTime: RowProps = {
  who: "Nadja Lehner",
  address: W.NADJA.address,
  people: [W.NADJA],
  when: "08:35",
  subject: "New time proposed: glaze evening planning call",
  preview: "Nadja proposed Thursday 15:00 instead of 10:00. Same half hour, and she calls you.",
};
const lunch: RowProps = {
  who: "Lea Brunner",
  address: W.LEA.address,
  people: [W.LEA],
  when: "Sun",
  subject: "Sunday lunch at Mum's",
  preview:
    "Mum is making the plum tart, so come hungry. Twelve o'clock, and bring the photos from the ridge if Reto has sent them.",
};
const posters: RowProps = {
  who: "Carla Meier",
  address: W.CARLA.address,
  people: [W.CARLA],
  when: "Sat",
  subject: "The posters went up on Friday",
  preview:
    "Half the neighbourhood asked who made them. See you at the market on Saturday, we kept a raclette for you.",
};
const glaze = (open: boolean): RowProps => ({
  who: "Giulia, Ben",
  people: [W.GIULIA, W.BEN, W.ME],
  peopleMore: "+2",
  peopleLabel: "3 people: Giulia Ferrari, Ben Arnold and you",
  squares: (
    <ReadSquares squares={W.GLAZE} here={open ? 4 : undefined} axis="row" label="5 messages, 2 unread" />
  ),
  file,
  when: "09:12",
  subject: "Re: Glaze order #2291",
  preview:
    "Both glazes leave Milan today and reach the studio on Thursday. The matte white came back in stock, so it is one carton after all.",
  unread: true,
  open,
  quick: done,
});
const tickets: RowProps = {
  who: "Tim Berger",
  address: W.TIM.address,
  people: [W.TIM],
  when: "Sat",
  subject: "Got us tickets for the 21st",
  preview:
    "Row 8, right side, close enough to see the drummer sweat. I will forward the details. You owe me a beer.",
};
const studio: RowProps = {
  who: "Jonas Halter",
  address: W.JONAS.address,
  people: [W.JONAS, W.TOBIAS, W.RAHEL, W.ME],
  peopleMore: "+3",
  peopleLabel: "4 people: Jonas Halter, Tobias Frei, Rahel Beck and you",
  squares: <ReadSquares squares={W.STUDIO} axis="row" label="30 messages, 0 unread" run={W.rowRun(30, -1)} />,
  when: "Fri",
  subject: "Open studio in December: which weekend?",
  preview:
    "The 5th or the 12th, and the printer wants the date on Wednesday. I lean 12th: it shares the weekend with the market.",
};
const renewal: RowProps = {
  who: "Hostwerk",
  address: W.HOSTWERK.address,
  people: [W.HOSTWERK],
  when: "3 Nov",
  subject: "Domain renewal: lichtgrat.example expires 30 November",
  preview:
    "lichtgrat.example renews on 30 November for CHF 19.00 a year. Auto-renew is off, so nothing happens unless you renew it.",
  unread: true,
  quick: done,
};
const photos: RowProps = {
  who: "Reto Frei",
  address: W.RETO.address,
  people: [W.RETO, W.ME, W.LEA, W.TIM],
  peopleMore: "+3",
  peopleLabel: "4 people: Reto Frei, you, Lea Brunner and Tim Berger",
  squares: <ReadSquares squares={W.PHOTOS} axis="row" label="4 messages, 0 unread" />,
  file,
  when: "yesterday",
  subject: "Photos from the ridge",
  preview:
    "The promised photos from the ridge. The sunrise was worth every minute of the four o'clock start. Next time you come along.",
};
const teach: RowProps = {
  who: "Nadja Lehner",
  address: W.NADJA.address,
  people: [W.NADJA],
  where: "Ohbox",
  when: "Fri",
  subject: "Would you teach the December glaze evening?",
  preview:
    "Two hours, twelve people, Thursday the 10th or the 17th. Three people have asked who made the matte white bowls on your table.",
};
const invoice: RowProps = {
  who: "Atelier Erdton",
  address: W.ERDTON.address,
  people: [W.ERDTON],
  file,
  amount: "CHF 240.00",
  subject: "Invoice #091: Glaze & Fire workshop",
  preview: "Workshop «Glaze & Fire», 2 places, 24 October. Payable within 30 days. Invoice attached.",
};
const draft: RowProps = {
  who: "To Nadja Lehner",
  address: W.NADJA.address,
  people: [W.NADJA],
  when: "yesterday",
  subject: "Re: Would you teach the December glaze evening?",
  preview:
    "Yes, gladly. The 17th suits me better. I would bring the matte white and two test tiles per person, and",
};

const picked: PanelVerb[] = [
  { id: "later", label: "Later", icon: "later", keyHint: "a", rank: 1, segment: "defer" },
  { id: "park", label: "Park", icon: "parked", keyHint: "e", rank: 2, segment: "defer" },
  { id: "resurface", label: "Resurface", icon: "resurface", keyHint: "b", rank: 3, segment: "defer" },
  { id: "tag", label: "Tag", icon: "tags", keyHint: "t", rank: 4 },
  { id: "screening", label: "Screening", icon: "screener", keyHint: "s", rank: 5, segment: "file" },
  { id: "move", label: "Move", icon: "move", keyHint: "m", rank: 6, segment: "file" },
  { id: "read", label: "Read", icon: "read", keyHint: "⇧u", rank: 0, segment: "read" },
  { id: "unread", label: "Unread", icon: "unread", keyHint: "u", rank: 0, segment: "read", hotIcon: true },
];

/** A section of Settings in the list, as wide as the list's column draws it: the row alone, on the list's sheet. */
const entry = (key: string, props: (look: Look) => Omit<RowProps, "entry">): KitSubject => ({
  key,
  place: "block",
  on: "sheet",
  target: ".oh-row",
  render: (look) => <Row entry {...props(look)} />,
});
const notifications = (): Omit<RowProps, "entry"> => ({
  who: "Notifications",
  people: [],
  sign: "bell",
  subject: "On",
  preview: "Ohbox · Screener · Scheduled",
});

const bell = <Doorbell count="6" label="6 waiting, Screener" keyHint="g s" />;
const listMenu = <Button kind="quiet" icon="more" label="List" />;

export const lists: KitSubject[] = [
  rows("Row/unread", talk),
  rows("Row/read", techCheck),
  rows("Row/hover", newTime, { act: force(".oh-row", "hover") }),
  rows("Row/cursor", { ...lunch, cursor: true }),
  rows("Row/open", { ...posters, open: true }),
  rows("Row/open-unread", glaze(true)),
  rows("Row/picked", { ...tickets, picked: true }),
  rows("Row/conversation", glaze(false)),
  rows("Row/thirty", studio),
  rows("Row/came-back", renewal),
  rows("Row/file", photos),
  rows("Row/where", teach),
  rows("Row/amount", invoice),
  rows("Row/draft", [
    draft,
    { ...draft, who: "No recipient yet", address: undefined, people: [], sign: "write" },
  ]),
  entry("Row/entry", notifications),
  entry("Row/entry-open", (look) => ({
    who: "General",
    people: [],
    sign: "settings",
    subject: `${look.face === "paper" ? "oh" : "ohmarchy"} · ${look.scheme === "light" ? "Light" : "Dark"}`,
    preview: "English",
    open: true,
  })),
  entry("Row/entry-hot", () => ({
    who: "Mailboxes",
    people: [],
    sign: "mail",
    when: "2",
    subject: "1 full",
    preview: "lichtgrat.example · milabrunner.example",
    unread: true,
  })),

  inList(
    "ListHead/hot",
    <ListHead
      title="Ohbox"
      hot
      aside={
        <>
          {bell}
          <Button kind="quiet" size="s">
            Mark all read
          </Button>
          {listMenu}
        </>
      }
    />,
  ),
  inList("ListHead/ink", <ListHead title="History" aside={listMenu} />),

  { key: "Doorbell/rest", render: () => bell },
  { key: "Doorbell/pressed", render: () => bell, ...moving(force("> *", "active")) },
  { key: "Doorbell/focus", render: () => bell, act: force("> *", "focus", "focus-visible") },

  {
    key: "GroupHeading/hot",
    place: "window",
    /* In the list's column, on its sheet. */
    on: "sheet",
    target: ".oh-groupheading",
    render: (look) => (
      <div style={{ position: "fixed", ...listCorner(look), width: listWidth(look) }}>
        <GroupHeading count="1" hot>
          Resurfaced
        </GroupHeading>
      </div>
    ),
  },
  {
    key: "ListTail/rest",
    place: "block",
    width: 420,
    render: () => <ListTail way={{ label: "History" }}>Older mail</ListTail>,
  },
  {
    key: "SelectionBar/three",
    place: "block",
    width: 404,
    target: ".oh-actionpanel-bar",
    render: () => (
      <SelectionBar
        label="Actions"
        count={{ count: "3", word: "selected", label: "3 selected" }}
        verbs={picked}
        more={{ label: "More", behind: true }}
        folded={["park", "resurface", "tag", "screening", "move"]}
        short={["clear"]}
      />
    ),
  },
  {
    key: "MovePicker/folders",
    place: "window",
    target: ".oh-menu",
    act: force('[role="menuitem"]', "focus", "focus-visible"),
    render: () => (
      <div style={{ ["--oh-menu-width" as string]: "340px" }}>
        <MovePicker
          open
          onClose={() => {}}
          anchor={{ x: 0, y: 0 }}
          label="Move"
          title="Move"
          places={[
            { id: "news", label: "News" },
            { id: "receipts", label: "Receipts" },
            { id: "out", label: "Screened out" },
            { id: "spam", label: "Spam" },
          ]}
          find={{ label: "Move to a folder", placeholder: "Move to a folder…", value: "" }}
          folders={[
            { id: "rosa", name: "Gartenlokal Rosa", path: "Kunden › Gastronomie" },
            { id: "2026", name: "2026", path: "Buchhaltung › Rechnungen" },
            { id: "druck", name: "Druckdaten", path: "Projekte › 2026 › Katalog Frühling" },
            { id: "lind", name: "Wintermarkt Lind", path: "Kunden › Märkte" },
            { id: "typo", name: "Typo Stammtisch", path: "Mailinglisten" },
          ]}
        />
      </div>
    ),
  },
  {
    key: "AccountRow/shut",
    place: "block",
    render: () => (
      <AccountRow
        name={W.ME.address}
        address={W.ME.address}
        facts={["Synced 09:23", "7,912 messages · ohmail Cloud"]}
        state="Connected"
        expanded={false}
      />
    ),
  },
];

export { row };
