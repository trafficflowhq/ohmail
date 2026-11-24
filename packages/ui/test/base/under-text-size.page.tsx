/**
 * The page `under-text-size.test.tsx` bundles and mounts in a real browser: one scene a call, each the kit's
 * own parts with their own listeners, and a way to move the scene's state from the test.
 */
import { useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Blank,
  Button,
  Menu,
  MenuItem,
  Page,
  PhoneSheet,
  Report,
  Seg,
  Sentence,
  contextTrigger,
} from "../../src/base/index.js";
import { portalRenderer } from "../../src/base/Overlays/portal-renderer.js";
import { AgendaRow, EventCard } from "../../src/calendar/index.js";
import {
  ActionPanel,
  ColumnHandle,
  Composer,
  DraftControl,
  ListHead,
  ListLine,
  LookPicture,
  MovePicker,
  ReadSquares,
  Recipients,
  Row,
  Rows,
  SettingTile,
  SettingTiles,
  Switcher,
} from "../../src/mail/index.js";

type At = { x: number; y: number } | null;
let step: (() => void) | null = null;

const items = (
  <>
    <MenuItem onPress={() => {}}>Reply</MenuItem>
    <MenuItem onPress={() => {}}>Forward</MenuItem>
  </>
);

function AtControl({ kind }: { kind?: "card" | "sheet" }) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLButtonElement | null>(null);
  return (
    <div style={{ position: "absolute", left: 300, top: 200 }}>
      <Button ref={control} kind="two" opens="menu" expanded={open} onPress={() => setOpen(true)}>
        More
      </Button>
      {kind === "sheet" ? (
        <PhoneSheet open={open} onClose={() => setOpen(false)} label="More">
          {items}
        </PhoneSheet>
      ) : (
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          anchor={control}
          label="More"
          kind={kind}
          title={kind ? "Giulia Ferrari" : undefined}
        >
          {items}
        </Menu>
      )}
    </div>
  );
}

/** The Move menu opened from a control near the window's right edge and foot, asked to end at it and open upwards. */
function MoveAtControl() {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLButtonElement | null>(null);
  return (
    <div style={{ position: "absolute", right: 40, bottom: 60 }}>
      <Button ref={control} kind="two" opens="menu" expanded={open} onPress={() => setOpen(true)}>
        More
      </Button>
      <MovePicker
        open={open}
        onClose={() => setOpen(false)}
        anchor={control}
        up
        right
        label="Move"
        title="Move"
        places={[{ id: "news", label: "News" }]}
        folders={[{ id: "rosa", name: "Gartenlokal Rosa", path: "Kunden › Gastronomie" }]}
      />
    </div>
  );
}

/** A right click on a row, an agenda's row and a plain thing that spreads `contextTrigger`. */
function AtPointer() {
  const [at, setAt] = useState<At>(null);
  const trigger = contextTrigger((to) => setAt("x" in to ? to : null));
  return (
    <div style={{ position: "absolute", left: 240, top: 120, width: 560 }}>
      <div className="oh-rows" role="list" data-scene="row">
        <Row
          who="Petra Wyss"
          people={[]}
          subject="Your talk is on the programme"
          when="08:47"
          onMenu={setAt}
        />
      </div>
      <div data-scene="agenda" style={{ marginTop: 40 }}>
        <AgendaRow mark={{ kind: "calendar", tone: 3 }} title="Rehearsal" time="10:00" onMenu={setAt} />
      </div>
      <div data-scene="trigger" tabIndex={0} style={{ marginTop: 40, height: 60 }} {...trigger} />
      <Menu open={at !== null} onClose={() => setAt(null)} anchor={at ?? undefined} label="Row">
        {items}
      </Menu>
    </div>
  );
}

function Handle() {
  const [width, setWidth] = useState(280);
  return (
    <ColumnHandle column="list" label="List width" value={width} min={120} max={900} onChange={setWidth} />
  );
}

function Swipe() {
  return (
    <div style={{ position: "absolute", left: 0, top: 120, width: 390 }}>
      <div className="oh-rows" role="list">
        <Row
          who="Petra Wyss"
          people={[]}
          subject="Your talk is on the programme"
          when="08:47"
          swipe={{
            right: { label: "Done", icon: "check" },
            left: { label: "Later", icon: "later" },
            pulled: 60,
          }}
        />
      </div>
    </div>
  );
}

/** A listed row with its quick verb: what each press reached is counted on the scene. */
function Quick() {
  const [pressed, setPressed] = useState({ open: 0, done: 0 });
  return (
    <div
      style={{ position: "absolute", left: 240, top: 120, width: 560 }}
      data-pressed={JSON.stringify(pressed)}
    >
      <Rows label="Ohbox">
        <Row
          who="Petra Wyss"
          people={[]}
          subject="Your talk is on the programme"
          when="08:47"
          listing={{ name: "Petra Wyss: Your talk is on the programme", selected: false }}
          onOpen={() => setPressed((was) => ({ ...was, open: was.open + 1 }))}
          quick={{
            label: "Done",
            icon: "check",
            onPress: () => setPressed((was) => ({ ...was, done: was.done + 1 })),
          }}
        />
      </Rows>
    </div>
  );
}

function Sheet() {
  return (
    <div style={{ position: "relative", height: 700, width: 390 }}>
      <EventCard
        still
        frame="sheet"
        title="Rehearsal"
        tone={3}
        when="Thursday 10:00 to 11:00"
        close={{ label: "Close" }}
        notes="Bring the second draft."
      />
    </div>
  );
}

/** The lines on a desktop's page, or across a phone's window. */
function Lines({ phone = false }: { phone?: boolean }) {
  const person = (id: string, name: string) => ({ id, name, remove: `Remove ${name}` });
  return (
    <div style={{ position: "absolute", left: phone ? 16 : 200, top: 160, width: phone ? 300 : 640 }}>
      <Recipients
        lines={[
          {
            id: "to",
            label: "To",
            people: [person("a", "Anna Keller"), person("b", "Ben Arnold")],
            typed: "",
          },
          { id: "cc", label: "Cc", people: [person("c", "Clara Wyss")], typed: "" },
        ]}
      />
    </div>
  );
}

function Squares() {
  const [here, setHere] = useState(0);
  step = () => setHere(4);
  return (
    <div style={{ position: "absolute", left: 300, top: 200 }}>
      <ReadSquares
        squares={["seen", "seen", "unseen", "own", "seen", "unseen"]}
        tips={["First message"]}
        here={here}
        axis="row"
        label="6 messages"
      />
    </div>
  );
}

function Knob() {
  const [current, setCurrent] = useState<"mail" | "cal">("mail");
  step = () => setCurrent("cal");
  return (
    <div style={{ position: "absolute", left: 300, top: 200 }}>
      <Switcher
        kind="pair"
        label="Product"
        current={current}
        mail={{ word: "Mail", label: "Mail" }}
        cal={{ word: "Calendar", label: "Calendar" }}
      />
    </div>
  );
}

/**
 * A page of two columns, its act counted. `tall`: its sentence column is taller than any of the smaller windows.
 * `typing`: it fits until the step says two refusals under the sentence, as a person types in its blank.
 */
function TwoColumns({ tall = false }: { tall?: boolean }) {
  const [typed, setTyped] = useState("");
  const [said, setSaid] = useState(false);
  const [pressed, setPressed] = useState(0);
  step = () => setSaid(true);
  return (
    <div style={{ position: "fixed", inset: 0 }} data-pressed={pressed}>
      <Page
        columns={2}
        trail={<span>Account</span>}
        refusal={
          said
            ? [
                "That address is already the sign-in of another account, so it cannot receive the bill as well.",
                "Write another address, or sign in to the account that has it and send the bill from there.",
              ]
            : undefined
        }
        material={
          <div data-scene="material" style={{ height: 320 }}>
            The plan and what it costs
            <button type="button" data-scene="in-material">
              Compare the plans
            </button>
          </div>
        }
        line="The bill goes to this address each month."
        note="You can change it at any time."
        acts={
          <Button size="l" onPress={() => setPressed((n) => n + 1)}>
            Subscribe
          </Button>
        }
      >
        <Sentence size="xl" level={1}>
          Send the bill to{" "}
          <Blank label="Billing address" placeholder="your address" value={typed} onChange={setTyped} />
        </Sentence>
        {tall ? (
          <>
            <Sentence size="xl">
              Your trial has ended, and the mail you kept stays yours: export it, move it to another server,
              or keep it here for thirty days while you decide what to do with it next.
            </Sentence>
            <Sentence size="xl">
              After those thirty days the mailbox and everything in it are erased for good, the folders, the
              rules and the calendar with them, and nothing of it can be brought back by anyone, us included.
            </Sentence>
            <Sentence size="xl">
              Subscribing keeps all of it exactly where it is, and the address goes on receiving mail as
              before.
            </Sentence>
            <Sentence size="xl">
              The plan is paid each month or each year, it can be ended at any time from the account page, and
              what was paid for a month that has begun is not taken back, nor is anything charged after the
              end.
            </Sentence>
            <Sentence size="xl">
              Whoever writes to this address meanwhile is told nothing: their mail waits here for you to come
              back.
            </Sentence>
          </>
        ) : null}
      </Page>
    </div>
  );
}

/** General's two look tiles, the page's own face chosen first, each picture in the page's scheme. */
function Tiles({ tag = "follows Omarchy" }: { tag?: string }) {
  const [face, setFace] = useState<"paper" | "ohmarchy">("paper");
  const scheme = document.documentElement.dataset.scheme === "dark" ? "dark" : "light";
  const rows = [
    { who: "Giulia Ferrari", address: "giulia@terracotta-milano.example", time: "09:12" },
    { who: "Petra Wyss", address: "petra@makersfest.example", time: "08:47" },
  ] as const;
  return (
    <div style={{ width: 680, maxWidth: "100%", padding: 16 }}>
      <SettingTiles label="Look">
        <SettingTile name="oh" on={face === "paper"} onPress={() => setFace("paper")}>
          <LookPicture face="paper" scheme={scheme} title="Ohbox" rows={rows} />
        </SettingTile>
        <SettingTile name="ohmarchy" tag={tag} on={face === "ohmarchy"} onPress={() => setFace("ohmarchy")}>
          <LookPicture face="ohmarchy" scheme={scheme} title="Ohbox" rows={rows} />
        </SettingTile>
      </SettingTiles>
    </div>
  );
}

/** A place's head whose line of segments is wider than its list: seven years, the fifth the open one. */
function Piles() {
  const [year, setYear] = useState("2022");
  return (
    <div style={{ position: "absolute", left: 0, top: 40, width: 300 }}>
      <ListHead
        title="History"
        below={
          <Seg
            label="Year"
            value={year}
            onChange={setYear}
            options={["2026", "2025", "2024", "2023", "2022", "2021", "2020"].map((y) => ({
              value: y,
              label: y,
            }))}
          />
        }
      />
    </div>
  );
}

/** A letter's foot with the draft control at its end, its words German: the whole, and the fewer it may draw. */
function DraftFoot() {
  return (
    <Composer
      label="Neue Nachricht"
      head={<p>An</p>}
      foot={{
        label: "Zur Nachricht hinzufügen",
        format: { label: "Formatierung zeigen", word: "Aa", pressed: false },
        draft: (
          <DraftControl
            label="Aus deinem Text entwerfen"
            short="Aus Text entwerfen"
            title="Aus deinem Text entwerfen"
          />
        ),
      }}
    >
      <p>Text</p>
    </Composer>
  );
}

/** The reading panel in a narrow column, with a note that is to stay and is longer than the column. */
function PanelNote() {
  return (
    <div id="column" style={{ position: "absolute", left: 0, top: 40, width: 300 }}>
      <ActionPanel
        label="Aktionen"
        items={[
          { note: "Dieses Postfach wird von nichts organisiert", keep: true },
          { id: "boxes", label: "Postfächer", icon: "settings", rank: 0, wordOrder: 1 },
        ]}
      />
    </div>
  );
}

/** A list's lines in a narrow column: a quiet press wider than the column, and one that fits. */
function LineFold() {
  return (
    <div id="column" style={{ position: "absolute", left: 0, top: 40, width: 250 }}>
      <ListLine
        act={{
          label: "Auch den Spam-Ordner deines Mailservers nach passenden Nachrichten durchsuchen",
          quiet: true,
        }}
      >
        Nichts in Junk passt.
      </ListLine>
      <ListLine act={{ label: "Mehr", quiet: true }}>Das ist alles.</ListLine>
    </div>
  );
}

/**
 * A report with its way back. `stepScene` ends its window: it fades, and what holds it takes it away when the
 * part says that it is gone. Every press on the way back is counted where the case reads it.
 */
function ReportLeaving() {
  const [leaving, setLeaving] = useState(false);
  const [there, setThere] = useState(true);
  const [taken, setTaken] = useState(0);
  step = () => setLeaving(true);
  return (
    <div style={{ position: "absolute", left: 40, top: 40 }}>
      <output id="taken">{taken}</output>
      {there ? (
        <Report
          leaving={leaving}
          onGone={() => setThere(false)}
          undo={{ label: "Undo", keyHint: "z", onPress: () => setTaken((n) => n + 1) }}
        >
          Moved to News
        </Report>
      ) : null}
    </div>
  );
}

/**
 * A report over a list, held as a frame's slot holds one: a press on its way back takes it away at once, and so
 * does the end of its fade. Told that it went with the keys on it, the holder puts them on the list's row.
 */
function ReportOverARow() {
  const [leaving, setLeaving] = useState(false);
  const [there, setThere] = useState(true);
  const [told, setTold] = useState(0);
  const row = useRef<HTMLButtonElement>(null);
  step = () => setLeaving(true);
  return (
    <div style={{ position: "absolute", left: 40, top: 40 }}>
      <button ref={row} id="row" type="button">
        A letter in the list
      </button>
      <output id="told">{told}</output>
      {there ? (
        <Report
          leaving={leaving}
          onGone={() => setThere(false)}
          onKeysGone={() => {
            setTold((n) => n + 1);
            row.current?.focus();
          }}
          undo={{ label: "Undo", onPress: () => setThere(false) }}
        >
          Moved to News
        </Report>
      ) : null}
    </div>
  );
}

const SCENES = {
  report: ReportLeaving,
  reportOverARow: ReportOverARow,
  lineFold: LineFold,
  tiles: Tiles,
  piles: Piles,
  draftFoot: DraftFoot,
  panelNote: PanelNote,
  /* A catalogue's longer word beside the name (German says more than English). */
  tilesLong: () => <Tiles tag="übernimmt das Omarchy-Theme" />,
  control: AtControl,
  move: MoveAtControl,
  card: () => <AtControl kind="card" />,
  footSheet: () => <AtControl kind="sheet" />,
  pointer: AtPointer,
  handle: Handle,
  swipe: Swipe,
  quick: Quick,
  sheet: Sheet,
  lines: Lines,
  phoneLines: () => <Lines phone />,
  squares: Squares,
  knob: Knob,
  pageShort: () => <TwoColumns />,
  pageTall: () => <TwoColumns tall />,
};
export type Scene = keyof typeof SCENES;

Object.assign(window, {
  mountScene(host: Element, scene: Scene) {
    const Part = SCENES[scene];
    flushSync(() =>
      createRoot(host).render(
        <portalRenderer.Provider value={createPortal}>
          <Part />
        </portalRenderer.Provider>,
      ),
    );
  },
  stepScene() {
    flushSync(() => step?.());
  },
});
