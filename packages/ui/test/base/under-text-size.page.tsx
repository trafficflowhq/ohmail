/**
 * The page `under-text-size.test.tsx` bundles and mounts in a real browser: one scene a call, each the kit's
 * own parts with their own listeners, and a way to move the scene's state from the test.
 */
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Button, Menu, MenuItem, contextTrigger } from "../../src/base/index.js";
import { AgendaRow, EventCard } from "../../src/calendar/index.js";
import { ColumnHandle, ReadSquares, Recipients, Row, Rows, Switcher } from "../../src/mail/index.js";

type At = { x: number; y: number } | null;
let step: (() => void) | null = null;

const items = (
  <>
    <MenuItem onPress={() => {}}>Reply</MenuItem>
    <MenuItem onPress={() => {}}>Forward</MenuItem>
  </>
);

function AtControl() {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLButtonElement | null>(null);
  return (
    <div style={{ position: "absolute", left: 300, top: 200 }}>
      <Button ref={control} kind="two" opens="menu" expanded={open} onPress={() => setOpen(true)}>
        More
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={control} label="More">
        {items}
      </Menu>
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

const SCENES = {
  control: AtControl,
  pointer: AtPointer,
  handle: Handle,
  swipe: Swipe,
  quick: Quick,
  sheet: Sheet,
  lines: Lines,
  phoneLines: () => <Lines phone />,
  squares: Squares,
  knob: Knob,
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
