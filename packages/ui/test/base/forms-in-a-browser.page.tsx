/**
 * The page `forms-in-a-browser.test.tsx` bundles and mounts in a real browser: the kit's fields, buttons and tiles
 * inside forms, with React running, so that real keys can be typed into them. What a form reads at its press it
 * tells the case as a yes, a no or a count: nothing typed is ever written anywhere.
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Blank, Button, ChoiceTiles, Field } from "../../src/base/index.js";

/** What the forms tell the case. */
export interface Told {
  /** How often each form was sent, by the form's name. */
  sent: Record<string, number>;
  /** Whether the press read what was typed, by the form's name. */
  read: Record<string, boolean>;
}
const told: Told = { sent: {}, read: {} };

/** A form that keeps what is typed, with a control that shows the password as text and hides it again. */
function Keeping({ typed }: { typed: string }) {
  const [held, setHeld] = useState("");
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLInputElement | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        told.read.keeping = box.current?.value === typed && held === typed;
      }}
    >
      {shown ? (
        <Field label="Kept password" type="text" value={held} onChange={setHeld} ref={box} />
      ) : (
        <Field label="Kept password" type="password" value={held} onChange={setHeld} ref={box} />
      )}
      <Button onPress={() => setShown(!shown)}>Show kept</Button>
      <Button type="submit">Sign in kept</Button>
    </form>
  );
}

/** The same in a sentence's blank. */
function KeepingBlank() {
  const [held, setHeld] = useState("");
  const [shown, setShown] = useState(false);
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <Blank
        label="Blank password"
        placeholder="password"
        type={shown ? "text" : "password"}
        value={held}
        onChange={setHeld}
      />
      <Button onPress={() => setShown(!shown)}>Show blank</Button>
    </form>
  );
}

/** A form that hands the field no value and takes what was typed through the field itself at its press. */
function Own({ typed }: { typed: string }) {
  const box = useRef<HTMLInputElement | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        told.read.own = box.current?.value === typed;
      }}
    >
      <Field label="Own password" type="password" ref={box} />
      <Field label="Own user" value="" onChange={() => {}} />
      <Button type="submit">Sign in own</Button>
    </form>
  );
}

/** A form that keeps what the browser, or a password manager, fills in. */
function Filled({ typed }: { typed: string }) {
  const [held, setHeld] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        told.read.filled = held === typed;
      }}
    >
      <Field label="Filled password" type="password" value={held} onChange={setHeld} />
      <Field label="Filled user" value="" onChange={() => {}} />
      <Button type="submit">Sign in filled</Button>
    </form>
  );
}

/** A form of one field, or two, whose submit button is under way, off, or neither. */
function Code({ name, submit, two }: { name: string; submit: "busy" | "off" | "ready"; two?: boolean }) {
  const [code, setCode] = useState("");
  const [more, setMore] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        told.sent[name] = (told.sent[name] ?? 0) + 1;
      }}
    >
      <Field label={`Code ${name}`} value={code} onChange={setCode} />
      {two ? <Field label={`More ${name}`} value={more} onChange={setMore} /> : null}
      <Button type="submit" busy={submit === "busy"} disabled={submit === "off"}>
        {`Verify ${name}`}
      </Button>
    </form>
  );
}

function Tiles() {
  const [taken, setTaken] = useState<string | null>(null);
  return (
    <>
      <Button>Before the tiles</Button>
      <ChoiceTiles
        label="Mail providers"
        value={taken}
        onChange={setTaken}
        options={["Gmail", "Microsoft", "iCloud", "Yahoo"].map((name) => ({
          value: name,
          label: name,
          dim: name === "Yahoo",
        }))}
      />
      <Button>After the tiles</Button>
    </>
  );
}

function mountForms(host: Element, typed: string): void {
  createRoot(host).render(
    <>
      <Keeping typed={typed} />
      <KeepingBlank />
      <Own typed={typed} />
      <Filled typed={typed} />
      <Code name="busy" submit="busy" />
      <Code name="off" submit="off" />
      <Code name="ready" submit="ready" />
      <Code name="two" submit="busy" two />
      <Tiles />
    </>,
  );
}

Object.assign(window, { mountForms, told });
