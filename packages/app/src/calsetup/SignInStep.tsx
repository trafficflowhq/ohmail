/**
 * THE SIGN-IN: what a person types to connect a calendar. Every value lives in an uncontrolled field, is read by ref
 * at the press, handed once to the port and cleared at once, on the press and when the step goes. It is never kept
 * in React's state, the stage's words, a stored key, a report, a notice or the console.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Blank, Button, Dot, Page, Sentence } from "@ohmail/ui/base";
import {
  type CalendarSetupPort,
  type ConnectAnswer,
  type ConnectAsk,
  type SteppedWay,
} from "@ohmail/app-logic/calendar/setup";
import { useText } from "../text/index.js";
import { setupFaultKeyOf } from "./setup-fault.js";

/** The blanks each way asks for, in the order the sentence says them. */
const BLANKS = {
  icloud: ["user", "password"],
  caldav: ["server", "user", "password"],
  ics: ["address"],
} as const satisfies Record<SteppedWay, readonly string[]>;
type BlankName = (typeof BLANKS)[SteppedWay][number];

/** iCloud's user is an Apple Account's address; another server's user is whatever that server calls one. */
function kindOf(
  way: SteppedWay,
  name: BlankName,
): { type: "text" | "email" | "password"; mode: "email" | "url" | "text" } {
  if (name === "password") return { type: "password", mode: "text" };
  if (name === "user")
    return way === "icloud" ? { type: "email", mode: "email" } : { type: "text", mode: "text" };
  return { type: "text", mode: "url" };
}

/** The ask from what the fields hold; null where a field is empty. Only a password keeps its spaces. */
function askOf(way: SteppedWay, connectionId: string, read: (name: BlankName) => string): ConnectAsk | null {
  const v = (name: BlankName) => (name === "password" ? read(name) : read(name).trim());
  if (BLANKS[way].some((name) => v(name) === "")) return null;
  if (way === "icloud") return { way, connectionId, user: v("user"), password: v("password") };
  if (way === "caldav")
    return { way, connectionId, server: v("server"), user: v("user"), password: v("password") };
  return { way, connectionId, address: v("address") };
}

type Said = { readonly key: string } | null;

export interface SignInStepProps {
  readonly way: SteppedWay;
  /** The connection a new sign-in is for; null: a new connection. */
  readonly again: string | null;
  readonly port: CalendarSetupPort;
  readonly back: ReactNode;
  readonly trail: ReactNode;
  /** The ask was taken: the reading of this connection follows. */
  readonly taken: (connectionId: string) => void;
}

export function SignInStep({ way, again, port, back, trail, taken }: SignInStepProps) {
  const t = useText("calsetup");
  const fields = useRef<Partial<Record<BlankName, HTMLInputElement | null>>>({});
  /* Every field this step drew. A field's ref is let go and taken again whenever the step draws again, so emptying
     follows the step's own life, never the ref's: a field is emptied at the press and when the step goes. */
  const drawn = useRef(new Set<HTMLInputElement>());
  const asking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const door = again === null ? port.connect : port.signInAgain;

  const clear = () => {
    for (const el of drawn.current) el.value = "";
  };
  useEffect(() => {
    const all = drawn.current;
    return () => {
      for (const el of all) el.value = "";
      all.clear();
    };
  }, []);

  const press = async () => {
    if (asking.current || door === "none") return;
    const connectionId = again ?? crypto.randomUUID();
    const ask = askOf(way, connectionId, (name) => fields.current[name]?.value ?? "");
    clear();
    if (ask === null) {
      setSaid({ key: "signin.empty" });
      return;
    }
    asking.current = true;
    setBusy(true);
    setSaid(null);
    let answer: ConnectAnswer | null = null;
    try {
      answer = await door(ask);
    } catch {
      answer = null;
    }
    asking.current = false;
    setBusy(false);
    if (answer === null) setSaid({ key: "signin.notSent" });
    else if (answer.kind === "refused") setSaid({ key: setupFaultKeyOf(answer.fault, way) });
    else taken(connectionId);
  };

  const blank = (name: BlankName) => (
    <Blank
      key={name}
      label={t(`blank.${way}.${name}`)}
      placeholder={t(`blank.${way}.${name}Hint`)}
      type={kindOf(way, name).type}
      inputMode={kindOf(way, name).mode}
      autoComplete={name === "password" ? "new-password" : "off"}
      size={name === "password" ? 10 : 16}
      onEnter={() => void press()}
      ref={(el) => {
        fields.current[name] = el;
        if (el === null) return;
        drawn.current.add(el);
        el.setAttribute("autocapitalize", "off");
      }}
    />
  );
  const parts = Object.fromEntries(BLANKS[way].map((name) => [name, () => blank(name)]));

  return (
    <Page
      back={back}
      trail={trail}
      refusal={said ? [t(said.key)] : undefined}
      acts={
        door === "none" ? null : (
          <Button kind="ink" size="l" disabled={busy} onPress={() => void press()} keyHint="↵">
            {busy ? t("signin.asking") : t("signin.connect")}
          </Button>
        )
      }
    >
      <Sentence size="xl" level={1}>
        {t.rich(`signin.${way}`, parts)}
        <Dot kind="hot" product="cal" />
      </Sentence>
    </Page>
  );
}
