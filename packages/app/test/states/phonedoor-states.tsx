/**
 * THE PHONE'S WAYS IN, BY THE REFERENCE'S ADDRESS: each state of the screen `phonedoor` and the phone's own steps of
 * `onboarding` (the first screen, the scan), drawn over a door in memory that answers only what the state needs. A
 * state of the mailbox step is the one connect form over a stand-in wire that answers the state's refusal, brought to
 * itself by a person's steps (`stepsOf`): the subjects walk them in a real browser (`phonedoor-open.ts`), this page's
 * cases in jsdom. A typed pairing code and a password are made-up markers, typed into their blanks as a person types
 * them: the page draws them as dots, and holds them nowhere else.
 */
import { useMemo, type ReactNode } from "react";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { standaloneAuthHint } from "@ohmail/app-logic/mailboxes/connect/standalone-said";
import type { Answered, Connected } from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire } from "../../src/host/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import { ConnectForm, type ConnectAsk } from "../../src/mailboxes/connect/index.js";
import {
  ONBOARDING_PHONE_STATE_DATA,
  PHONE_DOOR_STATE_DATA,
  PhoneDoorPage,
  type OnboardingPhoneStateId,
  type PhoneDoor,
  type PhoneDoorState,
  type PhoneDoorStateId,
  type StateData,
  type WayInSeed,
} from "../../src/phone-door/index.js";
import { fillOver, type Messages } from "../../src/text/index.js";
import accountDe from "../../messages/account.de.json" with { type: "json" };
import accountEn from "../../messages/account.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };
import phoneDe from "../../messages/phone.de.json" with { type: "json" };
import phoneEn from "../../messages/phone.en.json" with { type: "json" };
import { deviceOf } from "./connect-states.js";

export type Lang = "en" | "de";
const EN = { ...accountEn, ...doorsEn, ...mailboxesEn, ...phoneEn } as unknown as Messages;
/** The words the ways in and the one form read, German filled over English as a shell hands them. */
export const PHONE_DOOR_WORDS: Readonly<Record<Lang, Messages>> = {
  en: EN,
  de: fillOver(EN, { ...accountDe, ...doorsDe, ...mailboxesDe, ...phoneDe } as unknown as Messages),
};

/** The markers a person types: made up, no server knows them. They are drawn as dots, never as themselves. */
export const MARK = "zq-MARKER";
export const TYPED_CODE = `${MARK}-code-3Wd7`;
export const IN_THE_HIDDEN_FIELD = `${MARK}-form-8Kv2`;

/* The reference's made-up places, as its draft draws them. */
const SERVER = "oh.lichtgrat.example";
const TYPED_AT: Partial<Record<PhoneDoorStateId, string>> = {
  notaddress: "my server",
  cleartext: "http://mila.example",
  numeric: "192.168.1.24",
  dns: "oh.lichtgart.example",
  nothing: "mila.example:8443",
  notencrypted: "mila.example:8080",
};
const OFFERS = {
  computer: { what: "computer", address: "https://192.168.1.24:47800", key: "7F3A 91C2 5D0E 6BE4" },
  server: { what: "server", address: `https://${SERVER}`, key: null },
  hosted: { what: "hosted", address: "https://api.ohmail.app", key: null },
} as const;
const TICKET = "0".repeat(32);

export type Drawn =
  | { readonly screen: "phonedoor"; readonly id: PhoneDoorStateId }
  | { readonly screen: "onboarding"; readonly id: OnboardingPhoneStateId };

/** What an address draws; `null` for a key this page does not draw (the first run's own steps, the postures). */
export function drawnAt(words: URLSearchParams): Drawn | null {
  const state = words.get("state");
  const device = words.get("device");
  if (device === "duo" || device === "book") return null;
  if (words.get("screen") === "phonedoor") {
    const id = `${state ?? "server"}${words.get("os") === "ios" ? "&os=ios" : ""}`;
    return id in PHONE_DOOR_STATE_DATA ? { screen: "phonedoor", id: id as PhoneDoorStateId } : null;
  }
  if (words.get("screen") !== "onboarding" || words.has("os")) return null;
  const step = words.get("step");
  /* The first screen on a phone; the desktop's and the foldable's first screens are the first run's. */
  if (step === null)
    return device === "phone" && state === null ? { screen: "onboarding", id: "welcome" } : null;
  if (step !== "scan") return null;
  const id = state ?? "scan";
  return id in ONBOARDING_PHONE_STATE_DATA
    ? { screen: "onboarding", id: id as OnboardingPhoneStateId }
    : null;
}

const dataOf = (drawn: Drawn): StateData =>
  drawn.screen === "phonedoor" ? PHONE_DOOR_STATE_DATA[drawn.id] : ONBOARDING_PHONE_STATE_DATA[drawn.id];

/** Where the page opens for a state: its step, its phase, its refusal, the address as the reference draws it. */
export function seedOf(drawn: Drawn): WayInSeed {
  const data = dataOf(drawn);
  const id = drawn.id;
  const offers = "offers" in data ? data.offers : undefined;
  const phase = "phase" in data ? data.phase : undefined;
  const said = "said" in data ? data.said : undefined;
  switch (data.step) {
    case "server":
      return {
        step: "server",
        phase,
        said,
        address: phase || said ? (TYPED_AT[id as PhoneDoorStateId] ?? SERVER) : undefined,
        apiUnder: phase === "reachedApi" ? `${SERVER}/api` : null,
      };
    case "hand":
      return {
        step: "hand",
        said,
        address: id === "hand" ? undefined : id === "handaddress" ? "my server" : SERVER,
      };
    case "confirm":
      return {
        step: "confirm",
        phase,
        offer: offers ? { ticket: TICKET, facts: OFFERS[offers] } : undefined,
      };
    default:
      return { step: data.step, phase, said };
  }
}

/** A person's step: a blank by its label, a press by its name. */
export type Step = { readonly into: string; readonly type: string } | { readonly press: string };

/** The steps that bring a state to itself after the page drew its seed. */
export function stepsOf(drawn: Drawn, lang: Lang): readonly Step[] {
  const data = dataOf(drawn);
  const w = PHONE_DOOR_WORDS[lang] as unknown as {
    phoneDoor: { form: Record<string, string>; hand: Record<string, string> };
    providerPicker: Record<string, string>;
  };
  const F = w.phoneDoor.form;
  if (data.step === "hand" && drawn.id !== "hand" && drawn.id !== "handempty")
    return [{ into: w.phoneDoor.hand.tokenLabel!, type: TYPED_CODE }];
  if (data.step !== "mailbox" || drawn.id === "form") return [];
  const other = { press: w.providerPicker.otherLabel! };
  if (drawn.id === "formhost") return [other];
  return [
    { into: F.addressLabel!, type: "mila@lichtgrat.example" },
    other,
    { into: F.imapHost!, type: "mail.lichtgrat.example" },
    { into: F.smtpHost!, type: "mail.lichtgrat.example" },
    { into: F.passwordLabel!, type: IN_THE_HIDDEN_FIELD },
    { into: F.nameLabel!, type: "Mila Brandt" },
    { press: F.connect! },
  ];
}

/** The stand-in of the phone's connect wire: the state's refusal as the wire hands it, or no answer yet. */
function standInWire(data: StateData): ConnectWire {
  const form = "form" in data ? data.form : undefined;
  return {
    probe: NONE,
    connect: (): Promise<Answered<Connected>> =>
      form === undefined
        ? new Promise(() => {})
        : Promise.resolve({
            ok: false,
            refusal: {
              status: 0,
              code: form.code,
              message: "",
              details: { ...NO_DETAILS, field: form.field, authHint: standaloneAuthHint(form.code) },
            },
          }),
    edit: NONE,
    discover: NONE,
    signIn: NONE,
    localServerWait: false,
  };
}

const STATE: PhoneDoorState = {
  session: "none",
  migrating: null,
  said: null,
  openId: null,
  syncing: false,
  syncSaid: null,
  syncStopped: null,
  pinned: false,
  total: null,
  paired: [],
  after: null,
};
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

/** A door that answers only what the state needs: whether the camera runs. Every press waits. */
function stateDoor(data: StateData, lang: Lang): PhoneDoor {
  const config = "config" in data ? data.config : {};
  const wire = standInWire(data);
  const camera = { camera: "phase" in data && data.phase === "cameraOff" ? "off" : "on" } as const;
  return {
    config: {
      app: "ohmail",
      os: "android",
      pad: false,
      language: lang,
      organizes: "offered",
      canPin: true,
      ...config,
    },
    state: { read: () => STATE, subscribe: () => () => {} },
    ask: never,
    scan: {
      start: () => Promise.resolve(camera),
      move: () => Promise.resolve(camera),
      stop: () => {},
      allow: never,
      listen: () => () => {},
    },
    hand: never,
    pair: never,
    dismiss: () => {},
    connect: (ask: ConnectAsk): ReactNode => <ConnectForm ask={ask} door={wire} factor={NONE} />,
    go: () => {},
    back: { subscribe: () => () => {} },
  };
}

/** A drawn state on the doors' stage, as the door's page stands it. */
export function PhoneDoorStateDrawn({
  drawn,
  lang,
  device,
}: {
  drawn: Drawn;
  lang: Lang;
  device: ReturnType<typeof deviceOf>;
}): ReactNode {
  const data = dataOf(drawn);
  const door = useMemo(() => stateDoor(data, lang), [data, lang]);
  return (
    <DoorStage device={device}>
      <PhoneDoorPage door={door} from={seedOf(drawn)} />
    </DoorStage>
  );
}

/**
 * THE CLASSES OF DIFFERENCE THE KEYS ARE DECLARED IN, whole, until the asks they wait on land and their pictures are
 * compared (`declared.json`). Every other key the page draws is compared as it stands.
 */
export const DECLARED_CLASSES = {
  form:
    "The mailbox on this phone is the one connect form, opened for the purpose standalone: a block of the kit's " +
    "fields, tiles and lines on the doors' stage, with the incoming and the outgoing server on the manual entry as on " +
    "every purpose, and a refusal said by the form alone. The reference draws the step as two sentences with blanks " +
    "(the address and the password, the name), a host tag that opens the server fields, the app password's help " +
    "under a refused sign-in and a suggested host: the form draws the help as its own links under the refusal, " +
    "and the studio is asked which the step follows.",
  named:
    "What answered, at which address, with which key, as the kit's setting lines on the doors' sheet: the doors' " +
    "named facts (the reference's three rows of a name and its value, the key set apart) are asked of the doors.",
  servers:
    "The first screen carries a quiet third way, Servers, which the reference's first screen does not draw yet " +
    "(ruled; asked of the studio).",
} as const;
export type DeclaredClass = keyof typeof DECLARED_CLASSES;

/** The class a state's key is declared in, or null for a key compared as it stands. */
export function declaredClassOf(drawn: Drawn): DeclaredClass | null {
  const data = dataOf(drawn);
  if (drawn.screen === "onboarding") return drawn.id === "welcome" ? "servers" : null;
  if (data.step === "mailbox") return "form";
  if (data.step === "confirm") return "named";
  return null;
}
