/**
 * The page `under-text-size.test.tsx` bundles and mounts in a real browser: one scene a call, each the kit's
 * own parts with their own listeners, and a way to move the scene's state from the test.
 */
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Blank,
  Button,
  Menu,
  MenuItem,
  Page,
  PhoneSheet,
  Sentence,
  contextTrigger,
} from "../../src/base/index.js";
import { AgendaRow, EventCard } from "../../src/calendar/index.js";
import {
  ColumnHandle,
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
          swipe={{ right: { label: "Done", icon: "check" }, left: { label: "Later", icon: "later" } }}
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

const SCENES = {
  tiles: Tiles,
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
    flushSync(() => createRoot(host).render(<Part />));
  },
  stepScene() {
    flushSync(() => step?.());
  },
});
