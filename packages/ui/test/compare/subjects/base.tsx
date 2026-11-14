import {
  Avatar,
  Blank,
  Button,
  Count,
  Dialog,
  Dot,
  Empty,
  Faces,
  Field,
  HintLine,
  InfoMark,
  JumpBack,
  KeyHelp,
  KeyHint,
  Menu,
  MenuItem,
  MenuRule,
  Notice,
  NoticeSlot,
  Opening,
  Page,
  Palette,
  PhoneSheet,
  RadioLines,
  RefusalLine,
  Report,
  Seg,
  Sentence,
  Sign,
  Slot,
  Switch,
  Tag,
  TagDot,
  WaitRow,
  Where,
} from "../../../src/base/index.js";
import type React from "react";
import keyTable from "./base-keys.json" with { type: "json" };
import { force, moving, type KitSubject, type Look } from "../harness.js";

/** One subject for every row of `test/reference/base/states.json`. */

const first = "> *";
/** The states a pointer or a key makes, each alone, as the sheet shows them. A press is drawn with motion on. */
const over = force(first, "hover");
const keyed = force(first, "focus", "focus-visible");
const pressed = moving(force(first, "active"));

/** What only a pointer's window does: on touch nothing takes the keys as a part opens. */
const withPointer =
  (act: NonNullable<KitSubject["act"]>): KitSubject["act"] =>
  async (page) => {
    if ((await page.evaluate(() => document.documentElement.dataset.touch)) === "0") await act(page);
  };

const KINDS = [
  ["ink", "Send", "send", "Sending"],
  ["two", "Attach", "clip", "Loading"],
  ["quiet", "Later", "later", "Loading"],
] as const;

const button: KitSubject[] = [
  ...KINDS.flatMap(([kind, word, icon, working]): KitSubject[] => [
    {
      key: `Button/${kind}`,
      render: () => (
        <Button kind={kind} icon={icon}>
          {word}
        </Button>
      ),
    },
    {
      key: `Button/${kind}-hover`,
      render: () => (
        <Button kind={kind} icon={icon}>
          {word}
        </Button>
      ),
      act: over,
    },
    {
      key: `Button/${kind}-focus`,
      render: () => (
        <Button kind={kind} icon={icon}>
          {word}
        </Button>
      ),
      act: keyed,
    },
    {
      key: `Button/${kind}-pressed`,
      render: () => (
        <Button kind={kind} icon={icon}>
          {word}
        </Button>
      ),
      ...pressed,
    },
    {
      key: `Button/${kind}-held`,
      render: () => (
        <Button kind={kind} icon={icon} pressed>
          {word}
        </Button>
      ),
    },
    {
      key: `Button/${kind}-off`,
      render: () => (
        <Button kind={kind} icon={icon} disabled>
          {word}
        </Button>
      ),
    },
    {
      key: `Button/${kind}-working`,
      render: () => (
        <Button kind={kind} disabled>
          {working}
        </Button>
      ),
    },
  ]),
  { key: "Button/large", render: () => <Button size="l">Agree and start organizing</Button> },
  {
    key: "Button/small-two",
    render: () => (
      <Button kind="two" size="s">
        Check now
      </Button>
    ),
  },
  {
    key: "Button/small-quiet",
    render: () => (
      <Button kind="quiet" size="s">
        Undo
      </Button>
    ),
  },
  { key: "Button/icon", render: () => <Button kind="quiet" icon="more" label="List" /> },
  { key: "Button/icon-small", render: () => <Button kind="quiet" size="s" icon="x" label="Close" /> },
  {
    key: "Button/key",
    render: () => (
      <Button icon="reply" keyHint="r" keyShown>
        Reply
      </Button>
    ),
  },
  {
    key: "Button/key-quiet",
    render: () => (
      <Button kind="quiet" icon="later" keyHint="a" keyShown>
        Later
      </Button>
    ),
  },
];

/** The dot takes its size from the text it ends: here a title's. */
const titled = (kind: "hot" | "ink" | "ring"): KitSubject => ({
  key: `Dot/${kind}`,
  target: ".oh-dot",
  render: () => (
    <span className="oh-display" style={{ fontSize: "var(--t-title)", lineHeight: 1.2 }}>
      Screener
      <Dot kind={kind} />
    </span>
  ),
});
const dot: KitSubject[] = [titled("hot"), titled("ink"), titled("ring")];

const keyHint: KitSubject[] = (
  [
    ["one", "r"],
    ["shift", "⇧r"],
    ["chord", "g s"],
    ["modifier", "Ctrl K"],
  ] as const
).map(([state, key]) => ({ key: `KeyHint/${state}`, render: () => <KeyHint shown>{key}</KeyHint> }));

const sentence: KitSubject[] = [
  {
    key: "Sentence/proposal",
    render: () => (
      <Sentence>
        Lena Kaufmann goes to <Slot kind="fill">Ohbox</Slot>
        <Dot kind="hot" />
      </Sentence>
    ),
  },
  {
    key: "Sentence/choice",
    render: () => (
      <Sentence>
        Organize the last <Slot>year</Slot>
        <Dot kind="ink" />
      </Sentence>
    ),
  },
  {
    key: "Sentence/decided",
    render: () => (
      <Sentence>
        Lena Kaufmann goes to <Slot kind="done">Ohbox</Slot>
        <Dot kind="ink" />
      </Sentence>
    ),
  },
  {
    key: "Sentence/nobody",
    render: () => (
      <Sentence>
        Marco Bianchi goes to <Slot kind="none">a place</Slot>
        <Dot kind="hot" />
      </Sentence>
    ),
  },
  {
    key: "Sentence/blank",
    render: () => (
      <Sentence>
        I&apos;m <Blank label="your name" placeholder="your name" size={9} />
        <Dot kind="ink" />
      </Sentence>
    ),
  },
];

/** A slot in running text: the list's last line. */
const running = (state: string, act?: KitSubject["act"]): KitSubject => ({
  key: `Slot/${state}`,
  target: ".oh-slot",
  act,
  render: () => (
    <p className="oh-text oh-muted">
      Older mail · <Slot>History</Slot>
    </p>
  ),
});
const slot: KitSubject[] = [
  running("quiet"),
  running("hover", force(".oh-slot", "hover")),
  running("focus", force(".oh-slot", "focus", "focus-visible")),
  { key: "Slot/fill", render: () => <Slot kind="fill">News</Slot> },
];

const ME = "Mila Brunner";
/* The sheet's fields take typing; a field without a handler is the kit's read-only one. */
const typed = () => {};
const field: KitSubject[] = [
  {
    key: "Field/rest",
    place: "block",
    width: 240,
    render: () => <Field label="Name" value="" placeholder="Your name" onChange={typed} />,
  },
  {
    key: "Field/filled",
    place: "block",
    width: 240,
    render: () => <Field label="Name" value={ME} onChange={typed} />,
  },
  {
    key: "Field/focus",
    place: "block",
    width: 240,
    render: () => <Field label="Name" value={ME} onChange={typed} />,
    act: force("input", "focus", "focus-visible"),
  },
  {
    key: "Field/hint",
    place: "block",
    width: 240,
    render: () => (
      <Field
        label="App password"
        type="password"
        value="abcdabcdabcdabcd"
        hint="16 letters"
        onChange={typed}
      />
    ),
  },
  {
    key: "Field/refused",
    place: "block",
    width: 320,
    render: () => (
      <Field
        label="App password"
        type="password"
        value="wrong"
        refusal="This provider needs an app password, not the account password."
        onChange={typed}
      />
    ),
  },
  {
    key: "Field/lines",
    place: "block",
    width: 320,
    render: () => <Field label="Signature" lines={3} value={`${ME}\nLichtgrat Studio`} onChange={typed} />,
  },
];

const toggle: KitSubject[] = [
  { key: "Switch/off", render: () => <Switch label="Off" on={false} /> },
  { key: "Switch/on", render: () => <Switch label="On" on /> },
  { key: "Switch/focus", render: () => <Switch label="On" on />, act: keyed },
  { key: "Switch/labelled", render: () => <Switch label="Load images in messages" on={false} labelled /> },
  { key: "Switch/labelled-on", render: () => <Switch label="Block tracking pixels" on labelled /> },
];

const seg: KitSubject[] = [
  {
    key: "Seg/plain",
    render: () => (
      <Seg
        label="Theme"
        value="light"
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "auto", label: "Auto" },
        ]}
      />
    ),
  },
  {
    key: "Seg/counts",
    render: () => (
      <Seg
        label="Sections"
        value="waiting"
        options={[
          { value: "waiting", label: "Waiting", count: 6 },
          { value: "screened", label: "Screened out", count: 3 },
          { value: "spam", label: "Spam", count: 2 },
        ]}
      />
    ),
  },
  {
    key: "Seg/five",
    render: () => (
      <Seg
        label="Text size"
        value="100"
        options={["90", "100", "110", "125", "150"].map((v) => ({ value: v, label: `${v}%` }))}
      />
    ),
  },
];

/* The invented world's people, one for each hue. */
const PEOPLE = [
  { name: "Röstsonntag", address: "hallo@roestsonntag.example", hue: 25 },
  { name: "Anna Odermatt", address: "anna@gartenlokal-rosa.example", hue: 42 },
  { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example", hue: 78 },
  { name: "Cinderlock", address: "no-reply@cinderlock.example", hue: 112 },
  { name: "Nadja Lehner", address: "nadja@erdton-atelier.example", hue: 150 },
  { name: "Hostwerk", address: "support@hostwerk.example", hue: 196 },
  { name: "Petra Wyss", address: "petra@makersfest.example", hue: 250 },
  { name: "Lea Brunner", address: "lea@brunner-familie.example", hue: 318 },
] as const;
const P = PEOPLE[0];
const avatar: KitSubject[] = [
  { key: "Avatar/row", render: () => <Avatar {...P} /> },
  { key: "Avatar/card", render: () => <Avatar {...P} size="l" /> },
  { key: "Avatar/account", render: () => <Avatar {...P} size="s" /> },
  { key: "Avatar/byline", render: () => <Avatar {...P} size="xs" /> },
  { key: "Avatar/unread", render: () => <Avatar {...P} unread /> },
  { key: "Avatar/faces", render: () => <Faces people={PEOPLE.slice(0, 3)} more="+2" /> },
  {
    key: "Avatar/sign",
    render: () => (
      <>
        <Sign icon="folder" />
        <Sign icon="write" />
      </>
    ),
  },
  ...PEOPLE.map((p): KitSubject => ({
    key: `Avatar/hue-${p.hue}`,
    render: () => <Avatar name={p.name} address={p.address} />,
  })),
];

const tag: KitSubject[] = [
  {
    key: "Tag/pile",
    render: () => (
      <>
        <Tag>Later</Tag>
        <Tag>Parked</Tag>
      </>
    ),
  },
  {
    key: "Tag/own",
    render: () => (
      <>
        <Tag hue={150}>Pottery Project</Tag>
        <Tag hue={78}>Paperwork</Tag>
        <Tag hue={25}>Adventures</Tag>
      </>
    ),
  },
  { key: "Tag/where", render: () => <Where>Receipts</Where> },
  {
    key: "Tag/dots",
    render: () => (
      <>
        {PEOPLE.map((p) => (
          <TagDot key={p.hue} hue={p.hue} />
        ))}
      </>
    ),
  },
];

const count: KitSubject[] = [
  {
    key: "Count/plain",
    target: ".oh-count",
    render: () => (
      <h2
        className="oh-text oh-display"
        style={{ display: "flex", fontSize: "var(--t-group)", lineHeight: 1 }}
      >
        <Count>3</Count>
      </h2>
    ),
  },
  { key: "Count/point", render: () => <Count kind="point">1,284</Count> },
];

const rest: KitSubject[] = [
  /* It stands in a line of Settings, on the pane's sheet. */
  { key: "InfoMark/rest", on: "sheet", render: () => <InfoMark label="About storage" /> },
  {
    key: "HintLine/list",
    place: "block",
    width: 420,
    target: ".oh-hintline",
    /* It stands at the foot of the list's column, whose corners are round. */
    render: () => (
      <div
        style={{
          overflow: "hidden",
          borderRadius: "0 0 var(--r-sheet) var(--r-sheet)",
          background: "var(--sheet)",
        }}
      >
        <HintLine
          shown
          hints={[
            { key: "↓", label: "Next message" },
            { key: "←", label: "Menu" },
            { key: "?", label: "Keys" },
          ]}
        />
      </div>
    ),
  },
  {
    key: "JumpBack/top",
    target: ".oh-jumpback",
    on: "sheet",
    render: () => (
      <div
        style={
          {
            position: "relative",
            width: 96,
            height: 96,
            "--oh-soft": "var(--soft-sheet)",
          } as React.CSSProperties
        }
      >
        <JumpBack label="Back to top" title="Back to top · g g" to="top" shown />
      </div>
    ),
  },
  {
    key: "JumpBack/end",
    target: ".oh-jumpback",
    /* In paper the reading column's sheet lies behind it; in ohmarchy the ground. */
    on: (look) => (look.face === "paper" ? "sheet" : "ground"),
    render: () => (
      <div style={{ position: "relative", width: 96, height: 96 }}>
        <JumpBack label="Latest message" title="Latest message · g g" to="end" shown />
      </div>
    ),
  },
  {
    key: "RadioLines/two",
    place: "block",
    on: "sheet",
    /* The card that holds them puts the keys on the first line as it opens. */
    act: withPointer(force('[role="radio"]', "focus", "focus-visible")),
    render: () => (
      <RadioLines
        label="Whose mail"
        value="sender"
        options={[
          { value: "sender", label: "This address", note: "2 messages" },
          { value: "domain", label: "Everyone at terracotta-milano.example", note: "2 messages · 1 sender" },
        ]}
      />
    ),
  },
];

/** A menu as the sheet shows it: open, standing still, as wide as its specimen. On the phone it stays a menu here. */
const menu = (
  state: string,
  width: number | null,
  node: (look: Look) => React.ReactNode,
  act?: KitSubject["act"],
  on?: KitSubject["on"],
): KitSubject => ({
  key: `Menu/${state}`,
  place: "window",
  target: ".oh-menu",
  act,
  on,
  render: (look) => (
    <div style={(width ? { "--oh-menu-width": `${width}px` } : {}) as React.CSSProperties}>{node(look)}</div>
  ),
});
const NOWHERE = { x: 0, y: 0 };
const shut = () => {};
/** What stands behind More beside an open letter: the narrower the window, the more of the bar's verbs. */
const more = ({ device }: Look) => (
  <>
    {device === "fold" || device === "phone" ? (
      <MenuItem icon="replyall" keyHint="⇧r">
        Reply all
      </MenuItem>
    ) : null}
    {device === "fold" || device === "foldl" ? (
      <MenuItem icon="later" keyHint="a">
        Later
      </MenuItem>
    ) : null}
    {device === "desktop" ? null : (
      <MenuItem icon="parked" keyHint="e">
        Park
      </MenuItem>
    )}
    <MenuItem icon="resurface" keyHint="b">
      Resurface
    </MenuItem>
    <MenuItem icon="tags" keyHint="t">
      Tag
    </MenuItem>
    <MenuItem icon="screener" keyHint="s">
      Screening
    </MenuItem>
    <MenuItem icon="move" keyHint="m">
      Move
    </MenuItem>
    {device === "phone" ? (
      <MenuItem icon="read" keyHint="u">
        Mark read
      </MenuItem>
    ) : null}
    <MenuRule />
    <MenuItem icon="spark">Draft reply</MenuItem>
    {device === "fold" || device === "phone" ? <MenuRule /> : null}
    <MenuItem icon="trash" keyHint="d">
      Delete
    </MenuItem>
    <MenuRule />
    <MenuItem icon="calendar" keyHint="v">
      Add to calendar
    </MenuItem>
  </>
);
const overlays: KitSubject[] = [
  /* The keys go to the first item as a menu opens. */
  menu(
    "more",
    null,
    (look) => (
      <Menu open onClose={shut} anchor={NOWHERE} label="More">
        {more(look)}
      </Menu>
    ),
    withPointer(force('[role="menuitem"]', "focus", "focus-visible")),
    "sheet",
  ),
  menu(
    "titled",
    null,
    () => (
      <Menu open onClose={shut} anchor={NOWHERE} label="Resurface" title="Resurface">
        <Field row label="Time" type="time" value="08:00" onChange={shut} />
        <MenuItem>Now</MenuItem>
        <MenuItem note="Wed 11 Nov, 08:00">Tomorrow</MenuItem>
        <MenuItem note="Mon 16 Nov, 08:00">Next week</MenuItem>
        <MenuItem>Pick a date</MenuItem>
        <MenuRule />
        <MenuItem>Cancel</MenuItem>
      </Menu>
    ),
    force('[role="menuitem"]', "focus", "focus-visible"),
    "sheet",
  ),
  menu(
    "place",
    null,
    () => (
      <Menu open onClose={shut} anchor={NOWHERE} label="Lena Kaufmann" title="Lena Kaufmann" kind="context">
        <MenuItem checked note="suggested 92%" keyHint="o">
          Ohbox
        </MenuItem>
        <MenuItem checked={false} keyHint="r">
          News
        </MenuItem>
        <MenuItem checked={false} keyHint="c">
          Receipts
        </MenuItem>
        <MenuItem checked={false} keyHint="n">
          Screen out
        </MenuItem>
        <MenuItem checked={false} keyHint="x">
          Spam
        </MenuItem>
      </Menu>
    ),
    force('[role="menuitemradio"]', "focus", "focus-visible"),
  ),
  menu(
    "field",
    290,
    () => (
      <Menu open onClose={shut} anchor={NOWHERE} label="Later">
        <Field row label="Time" value="08:00" onChange={shut} />
        <MenuItem>Now</MenuItem>
        <MenuItem note="Wed 11 Nov, 08:00">Tomorrow</MenuItem>
        <MenuItem note="Mon 16 Nov, 08:00">Next week</MenuItem>
        <MenuItem>Pick a date</MenuItem>
      </Menu>
    ),
    force("button:nth-of-type(3)", "hover"),
  ),
  menu(
    "context",
    260,
    () => (
      <Menu open onClose={shut} anchor={NOWHERE} label="Message" kind="context">
        <MenuItem icon="reply" keyHint="r">
          Reply
        </MenuItem>
        <MenuItem icon="forward" keyHint="⇧f">
          Forward
        </MenuItem>
        <MenuRule />
        <MenuItem icon="later" keyHint="a">
          Later
        </MenuItem>
        <MenuItem icon="parked" keyHint="e">
          Park
        </MenuItem>
        <MenuItem icon="resurface" keyHint="b">
          Resurface
        </MenuItem>
        <MenuRule />
        <MenuItem icon="unread" keyHint="u">
          Mark unread
        </MenuItem>
        <MenuItem icon="trash" keyHint="d">
          Delete
        </MenuItem>
      </Menu>
    ),
    force("button:nth-of-type(4)", "focus", "focus-visible"),
  ),
  {
    key: "PhoneSheet/more",
    place: "window",
    target: ".oh-menu",
    render: (look) => (
      <PhoneSheet open onClose={shut} label="More">
        {more(look)}
      </PhoneSheet>
    ),
  },
  {
    key: "Dialog/delete",
    place: "window",
    target: ".oh-dialog",
    render: () => (
      <div
        style={
          {
            "--oh-overlay-max": "440px",
            "--oh-scrim-place": "start",
            "--scrim": "transparent",
          } as React.CSSProperties
        }
      >
        <Dialog
          open
          onClose={shut}
          title="Move to Trash"
          line="Your mail server keeps it there."
          confirm={{ label: "Move to Trash", onPress: shut }}
          cancel={{ label: "Cancel" }}
        />
      </div>
    ),
  },
];

/* What stands over the whole window: drawn in the device's window, where the part keeps its own place. */
const standing = (
  key: string,
  node: (look: Look) => React.ReactNode,
  act?: KitSubject["act"],
): KitSubject => ({
  key,
  place: "window",
  target: ".oh-overlay",
  act,
  render: node,
});
const TAGGED = [
  { id: "set", label: "Settings: Tags", icon: "settings" },
  { id: "t1", label: "Tag: Pottery Project…", icon: "tags", keys: ["t"], disabled: true },
  { id: "t2", label: "Tag: Paperwork…", icon: "tags", disabled: true },
  { id: "t3", label: "Tag: Adventures…", icon: "tags", disabled: true },
  { id: "g1", label: "Go to tag: Pottery Project", icon: "tags" },
  { id: "g2", label: "Go to tag: Paperwork", icon: "tags" },
  { id: "g3", label: "Go to tag: Adventures", icon: "tags" },
] as const;
const overWindow: KitSubject[] = [
  standing("Palette/typed", ({ device }) => (
    <Palette
      open
      onClose={shut}
      label="Command palette"
      inputLabel="Command"
      placeholder="Type a command…"
      query="tag"
      onQuery={shut}
      commands={TAGGED}
      onRun={shut}
      empty="No command"
      keyHint={device === "desktop" ? "Ctrl K" : undefined}
      foot={
        device === "desktop"
          ? [
              { keys: ["↑", "↓"], label: "navigate" },
              { keys: ["↵"], label: "run" },
              { keys: ["esc"], label: "close" },
            ]
          : undefined
      }
    />
  )),
  standing("KeyHelp/keys", () => (
    <KeyHelp open onClose={shut} title="Keys" close="Close" columns={keyTable} />
  )),
  standing(
    "Dialog/keys",
    () => (
      <Dialog
        open
        onClose={shut}
        title="Sign out ohmail on a phone"
        hot
        confirm={{ label: "Sign out", onPress: shut, keyHint: "↵" }}
        cancel={{ label: "Cancel", keyHint: "Esc" }}
      />
    ),
    force("button", "focus", "focus-visible"),
  ),
  standing("Dialog/field", () => (
    <Dialog
      open
      onClose={shut}
      title="Delete this account"
      hot
      line="This cannot be undone."
      confirm={{ label: "Delete my account", onPress: shut, keyHint: "↵", disabled: true }}
      cancel={{ label: "Cancel", keyHint: "Esc" }}
    >
      <Field label="Type mila@lichtgrat.example" value="" onChange={shut} />
    </Dialog>
  )),
  standing(
    "Dialog/waiting",
    () => (
      <Dialog
        open
        onClose={shut}
        title="Waiting for the other ohmail"
        hot
        line="The mail stays where it is until then."
        cancel={{ label: "Close", keyHint: "Esc" }}
        list
      >
        <WaitRow
          what="A message to Answer Later"
          about="Giulia Ferrari · Re: Glaze order #2291"
          why="Sent to the other ohmail, waiting for it to apply."
        />
        <WaitRow
          what="Your decision about Lena Kaufmann"
          why="Sent to the other ohmail, waiting for it to apply."
        />
        <WaitRow
          what="Remove the rule for paperbird.example"
          why="Sent to the other ohmail, waiting for it to apply."
        />
        <WaitRow
          what="A message to News"
          about="Hostwerk · Domain renewal"
          why="Not applied, because it sat unanswered too long."
          refused
        />
      </Dialog>
    ),
    force("button", "focus", "focus-visible"),
  ),
  standing(
    "Dialog/store",
    () => (
      <Dialog
        open
        onClose={shut}
        title="ohcal is the calendar beside ohmail"
        product="cal"
        confirm={{ label: "Open Google Play", onPress: shut }}
        cancel={{ label: "Cancel", keyHint: "Esc" }}
      />
    ),
    force("button", "focus", "focus-visible"),
  ),
];

/* The one slot is the rail's foot where a rail stands, and the bar over the list where none does. */
const slotPlace = ({ device }: Look) => (device === "desktop" ? "rail" : "bar");
const full = (look: Look) => (
  <Notice
    place={slotPlace(look)}
    title="Storage 92% full"
    hot
    line="6.1 GB after the import."
    acts={[
      { label: "Storage", onPress: shut },
      { label: "Not now", onPress: shut },
    ]}
  />
);
const SEVERAL = [
  { id: "trial", rank: 72, title: "Trial ends Wed 18 Nov" },
  { id: "storage", rank: 62, title: "Storage 92% full", hot: true },
  { id: "waiting", rank: 43, title: "4 changes wait for the other ohmail", hot: true },
  { id: "unsaved", rank: 30, title: "2 changes could not be saved", hot: true },
  { id: "offline", rank: 10, title: "Offline since 09:24" },
];
const slotOf = (look: Look, open: boolean) => (
  <NoticeSlot
    place={slotPlace(look)}
    notices={SEVERAL}
    onFront={shut}
    more={{ label: "4 more", name: "4 more notices" }}
    open={open}
    onOpen={shut}
  />
);
const ON_SHEET = { "--oh-soft": "var(--soft-sheet)" } as React.CSSProperties;
const said = (state: string, node: React.ReactNode): KitSubject => ({
  key: `Report/${state}`,
  place: "block",
  width: 300,
  render: () => node,
});
const feedback: KitSubject[] = [
  { key: "Notice/full", place: "block", render: full },
  { key: "Notice/calm", place: "block", render: () => <Notice place="rail" title="Offline since 09:24" /> },
  {
    key: "NoticeSlot/several",
    place: "block",
    /* On a foldable and in ohmarchy the notices stand over the reading column's sheet. */
    on: (look) => (look.device !== "desktop" || look.face === "ohmarchy" ? "sheet" : "ground"),
    render: (look) => slotOf(look, false),
  },
  {
    key: "NoticeSlot/listed",
    place: "window",
    target: ".oh-menu",
    render: (look) => slotOf(look, true),
    act: withPointer(force('[role="menuitem"]', "focus", "focus-visible")),
  },
  said("undo", <Report undo={{ label: "Undo", keyHint: "z", onPress: shut }}>Parked</Report>),
  said("plain", <Report>Sent</Report>),
  said(
    "decision",
    <Report undo={{ label: "Undo", keyHint: "z", onPress: shut }}>Lena Kaufmann · Ohbox</Report>,
  ),
  said("selection", <Report undo={{ label: "Undo", keyHint: "z", onPress: shut }}>3 · Later</Report>),
  {
    key: "Report/why",
    place: "block",
    render: () => (
      <Report kind="why" why="ohmail Cloud organizes this mailbox, so piles and returns are set there.">
        Nothing changed
      </Report>
    ),
  },
  { key: "Empty/label", target: ".oh-empty", render: () => <Empty label="All read" /> },
  { key: "Empty/hot", target: ".oh-empty", render: () => <Empty label="5 unread" hot /> },
  {
    key: "Empty/act",
    target: ".oh-empty",
    render: () => <Empty label="No drafts" act={{ label: "Write", icon: "write", onPress: shut }} />,
  },
  { key: "Empty/mark", target: ".oh-empty", render: () => <Empty mark="oh" label="6 decided" /> },
  {
    key: "WaitRow/refused",
    place: "block",
    on: "sheet",
    render: () => (
      <div style={ON_SHEET}>
        <WaitRow
          what="A change to your mailbox"
          why="The server refused it and did not say why."
          refused
          acts={[
            { label: "Try again", onPress: shut },
            { label: "Discard", onPress: shut },
          ]}
        />
      </div>
    ),
    /* In its dialog the keys land on the first button. */
    act: force("button", "focus", "focus-visible"),
  },
  {
    key: "RefusalLine/way",
    place: "block",
    on: "sheet",
    render: () => (
      <div style={ON_SHEET}>
        <RefusalLine way={{ label: "Plans", onPress: shut }}>No AI credits left.</RefusalLine>
      </div>
    ),
  },
  {
    key: "RefusalLine/start",
    place: "block",
    on: "sheet",
    render: () => <RefusalLine start>{"grat-film.mov does not fit. A message takes 19.1 MB."}</RefusalLine>,
  },
];

const pages: KitSubject[] = [
  {
    key: "Page/refused",
    place: "window",
    target: ".oh-page",
    /* The stage is the frame's: it centres ohmarchy's window, and keeps the window's edge around it on a folding phone. */
    render: ({ face, device }) => (
      <div
        style={{
          boxSizing: "border-box",
          height: "100vh",
          display: "grid",
          placeItems: "center",
          padding: face === "ohmarchy" && device !== "desktop" && device !== "phone" ? "var(--edge)" : 0,
        }}
      >
        <Page
          refusal={[
            "This link has expired or was already used. Sign in with your email address and password and we send you a new one.",
          ]}
          line="It is the password you chose when you signed up."
          acts={
            <Button size="l" keyHint="↵">
              Sign in
            </Button>
          }
        >
          <Sentence size="xl">
            Confirm my email address with password{" "}
            <span className="oh-nowrap">
              <Blank label="Password" placeholder="type it" type="password" size={7} />
              <Dot kind="hot" />
            </span>
          </Sentence>
        </Page>
      </div>
    ),
  },
  {
    key: "Opening/window",
    place: "window",
    target: ".oh-opening",
    /* Ohmarchy's window stands inside the screen's edge: the frame's, drawn here by what holds the part. */
    render: ({ face }) => (
      <div
        style={{ boxSizing: "border-box", height: "100vh", padding: face === "ohmarchy" ? "var(--edge)" : 0 }}
      >
        <Opening kind="window" status={{ label: "Updating your local mail store", count: "3 of 7" }} />
      </div>
    ),
  },
  {
    key: "Opening/phone",
    place: "window",
    target: ".oh-opening",
    render: () => (
      <div style={{ height: "100vh" }}>
        <Opening kind="phone" status={{ label: "Updating the mail store on this phone", count: "3 of 12" }} />
      </div>
    ),
  },
];

export const subjects: KitSubject[] = [
  ...overWindow,
  ...feedback,
  ...pages,
  ...rest,
  ...overlays,
  ...button,
  ...dot,
  ...keyHint,
  ...sentence,
  ...slot,
  ...field,
  ...toggle,
  ...seg,
  ...avatar,
  ...tag,
  ...count,
];
