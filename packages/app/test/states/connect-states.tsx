/**
 * THE ONE CONNECT FORM'S REGISTERED STATES, for the comparison's subjects of the screen `onboarding`: each state of a
 * refused connect the design's registry draws (`state=c-…`, one row of `CONNECT_STATES` each), and the sign-up's
 * mailbox step as `/join` seats it, at the registry's nearest picture of it (`step=provider`). A state is drawn over a
 * stand-in wire that answers the row's refusal, and brought to itself by a person's steps (`stepsOf`): the tile, what
 * is typed, the press. The subjects walk the steps in a real browser (`connect-open.ts`), this page's cases in jsdom.
 */
import { useEffect, type ReactNode } from "react";
import { providerById } from "@ohmail/app-logic/mailboxes/connect/providers";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import {
  CONNECT_STATES,
  type ConnectStateRow,
} from "../../../app-logic/test/mailboxes/connect/refusal-states.js";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import type { Answered, ConnectPurposeKind, Refusal } from "@ohmail/app-logic/mailboxes/connect/types";
import { createFeed, NONE, type ConnectWire } from "../../src/host/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import { JoinPage, type JoinDoor } from "../../src/doors/join/index.js";
import { ConnectForm, type ConnectAsk, type FactorSlot } from "../../src/mailboxes/connect/index.js";
import { EDIT_WORDS, FORM_WORDS, type Word } from "../../src/mailboxes/connect/words.js";
import accountDe from "../../messages/account.de.json" with { type: "json" };
import accountEn from "../../messages/account.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };

export type Lang = "en" | "de";
type Catalogue = Record<string, Record<string, string>>;

/** The words the form and the join's page read, from the three places that hold them. */
export const CONNECT_WORDS: Readonly<Record<Lang, Catalogue>> = {
  en: { ...accountEn, ...doorsEn, ...mailboxesEn } as unknown as Catalogue,
  de: { ...accountDe, ...doorsDe, ...mailboxesDe } as unknown as Catalogue,
};

/** A sentence of the catalogue with its simple values put in, as the form's reader puts them. */
export function say(
  lang: Lang,
  word: { readonly ns: string; readonly key: string },
  values: Readonly<Record<string, string>> = {},
): string {
  const said = CONNECT_WORDS[lang][word.ns]?.[word.key];
  if (said === undefined) throw new Error(`no sentence ${word.ns}.${word.key}`);
  return said.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
}

/** The sign-up's mailbox step as `/join` seats it: the registry draws no join of its own, and this is its nearest. */
export const JOIN_STEP_KEY = "screen=onboarding&step=provider";

/** A row's registered key: the tile it is drawn on (the manual entry's word is `other`), the state, the step. */
export const keyOfRow = (row: ConnectStateRow): string =>
  `provider=${row.preset === "imap" ? "other" : row.preset}&screen=onboarding&state=${row.id}&step=signin`;

/** Every registered key the page draws: the join's step, then the states of a refused connect in the registry's order. */
export const CONNECT_KEYS: readonly string[] = [JOIN_STEP_KEY, ...CONNECT_STATES.map(keyOfRow)];

/**
 * THE CLASSES OF DIFFERENCE THE KEYS ARE DECLARED IN, whole, until their pictures are compared (`declared.json`):
 * what the page draws differs from the reference by construction, for these reasons a person can check against it.
 */
export const DECLARED_CLASSES = {
  alone:
    "The one connect form alone, opened for the state's own purpose (a further mailbox, or a mailbox's edit), on the " +
    "doors' stage. The reference draws the state inside the first run's own page, which that page's seat draws around " +
    "the form, and draws the step as a sentence with blanks where the form is a block of the kit's fields, tiles, " +
    "switches and lines: the studio is asked which the step follows.",
  join:
    "The sign-up's mailbox step as the join seats it: the join's page, its stations and heading, with the one connect " +
    "form in its slot before a tile is chosen. The reference draws no mailbox step of the join; its nearest picture " +
    "is the first run's choice of a provider, on the first run's page, with the providers as a grid of capsules: the " +
    "studio is asked which the step follows.",
} as const;
export const declaredClassOf = (key: string): keyof typeof DECLARED_CLASSES =>
  key === JOIN_STEP_KEY ? "join" : "alone";

export type Drawn = { readonly kind: "join" } | { readonly kind: "row"; readonly row: ConnectStateRow };

/** What an address draws; `null` for a key this page does not draw. */
export function drawnAt(words: URLSearchParams): Drawn | null {
  const key = ["provider", "screen", "state", "step"]
    .filter((word) => words.has(word))
    .map((word) => `${word}=${words.get(word)}`)
    .join("&");
  if (key === JOIN_STEP_KEY) return { kind: "join" };
  const row = CONNECT_STATES.find((state) => keyOfRow(state) === key);
  return row === undefined ? null : { kind: "row", row };
}

/* What the person types: an address, two servers and a password at the reference's own domain, all made here. */
const DOMAIN = "lichtgrat.example";
const ADDRESS = `mila@${DOMAIN}`;
const IMAP = `mail.${DOMAIN}`;
const SMTP = `smtp.${DOMAIN}`;
const PASSWORD = "connect-states-password";
/** What the lookup found for the address's domain, where a state is drawn with the servers found. */
const FOUND = {
  preset: null,
  proton: false,
  imap: { host: `imap.${DOMAIN}`, port: 993, secure: true },
  smtp: { host: `smtp.${DOMAIN}`, port: 587, secure: false },
};

/** A step a person takes: a field by its label, leaving a field, a press by its name, a line ticked by its name. */
export type Step =
  | { readonly into: string; readonly type: string }
  | { readonly leave: string }
  | { readonly press: string }
  | { readonly tick: string };

/** The steps that bring a drawn state to itself, in the page's language. The join's step is drawn as it opens. */
export function stepsOf(drawn: Drawn, lang: Lang): readonly Step[] {
  if (drawn.kind === "join") return [];
  const { row } = drawn;
  const words = FORM_WORDS[row.purpose];
  const said = (word: Word, values?: Readonly<Record<string, string>>): string => say(lang, word, values);
  if (row.purpose === "edit")
    return [
      { into: said(words.password), type: PASSWORD },
      ...(row.own === "port" ? [{ into: said(EDIT_WORDS.imapPort), type: "99999" }] : []),
      { press: said(words.submit) },
    ];
  const preset = providerById(row.preset);
  const tile = preset.manual ? said({ ns: "providerPicker", key: "otherLabel" }) : preset.label;
  return [
    { into: said(words.address), type: ADDRESS },
    ...(row.own === "serversFound" ? [{ leave: said(words.address) }] : []),
    { press: tile },
    ...(preset.manual
      ? [
          { into: said(words.imapHost), type: IMAP },
          { into: said(words.smtpHost), type: SMTP },
        ]
      : []),
    { into: said(words.password), type: PASSWORD },
    { press: said(words.submit) },
    ...(row.own === "plainTicked" ? [{ tick: said({ ns: "mailboxes", key: "insecureConsentLabel" }) }] : []),
    ...(row.own === "trustTicked" ? [{ tick: said({ ns: "mailboxes", key: "trustCertificateLabel" }) }] : []),
  ];
}

const nothing = (): void => {};
/** The server's refusal of a press made while its second-factor window is closed. */
const WINDOW_CLOSED: Refusal = { status: 403, code: "step_up_required", message: "", details: NO_DETAILS };
const NO_ANSWER: Refusal = { status: 0, code: null, message: "", details: NO_DETAILS };

/** A wire that answers every press with the row's refusal (a factor's closed window for the press withdrawn after). */
function wireOf(row: ConnectStateRow | null): ConnectWire {
  const refused =
    row === null ? NO_ANSWER : row.own === "wentBack" ? WINDOW_CLOSED : (row.refusal ?? NO_ANSWER);
  const answer = (): Promise<Answered<never>> => Promise.resolve({ ok: false, refusal: refused });
  return {
    probe: answer,
    connect: answer,
    edit: answer,
    discover: row?.own === "serversFound" ? () => Promise.resolve(FOUND) : NONE,
    signIn: NONE,
    localServerWait: false,
  };
}

/** The second factor's dialog, as a factor that landed after Cancel leaves it: thrown away at once. */
function Discarded({ onDiscarded }: { onDiscarded(): void }): ReactNode {
  useEffect(onDiscarded, [onDiscarded]);
  return null;
}
const discarded: FactorSlot = (ask) => <Discarded onDiscarded={ask.onDiscarded} />;

/** The mailbox an edit is about: the reference's address, on the row's own tile. */
const subjectOf = (row: ConnectStateRow) => ({
  id: mailboxIdOfAnswer("mbx-lichtgrat-1")!,
  address: ADDRESS,
  provider: row.preset,
  signsIn: "password" as const,
});

const askOf = (purpose: ConnectPurposeKind, row: ConnectStateRow | null): ConnectAsk =>
  purpose === "edit" && row !== null
    ? { purpose: { kind: "edit", mailbox: subjectOf(row) }, onDone: nothing }
    : purpose === "join"
      ? {
          purpose: { kind: "join" },
          onDone: nothing,
          guard: { before: () => Promise.resolve(true), said: null, clear: nothing },
          later: nothing,
          help: nothing,
        }
      : { purpose: { kind: purpose === "firstRun" ? "firstRun" : "add" }, onDone: nothing };

/** The join's page at its mailbox step, as the managed web's public path seats it: the one form in its slot. */
function joinDoorOf(lang: Lang): JoinDoor {
  const way = { href: "/" };
  return {
    state: { at: "mailbox" },
    stations: ["account", "verify", "factor", "codes", "plan", "mailbox"],
    note: "managed-open",
    invited: false,
    busy: false,
    refusal: null,
    fields: { code: "", email: "", name: "", password: "", otp: "" },
    suggestion: null,
    pending: {
      said: null,
      act: say(lang, { ns: "account", key: "signOut" }),
      signingOut: false,
      again: nothing,
    },
    type: nothing,
    redeem: nothing,
    register: nothing,
    toInvite: nothing,
    takeSuggestion: nothing,
    changeAddress: nothing,
    signIn: way,
    resend: nothing,
    recheck: nothing,
    addPasskey: nothing,
    useAuthenticator: nothing,
    copyKey: nothing,
    openAuthenticator: nothing,
    activate: nothing,
    leaveAuthenticator: nothing,
    copyCodes: nothing,
    downloadCodes: nothing,
    save: nothing,
    codesDone: nothing,
    retryCodes: nothing,
    accountPage: null,
    later: way,
    open: way,
    retry: nothing,
    leave: way,
    signInAgain: way,
    waitlist: way,
    demo: NONE,
    slots: {
      mailbox: () => <ConnectForm ask={askOf("join", null)} door={wireOf(null)} factor={discarded} />,
      authenticatorQr: () => null,
    },
  };
}

const ROOMS = {
  phone: { width: 390, height: 844, pointer: "coarse" },
  fold: { width: 719, height: 781, pointer: "coarse" },
  foldl: { width: 841, height: 673, pointer: "coarse" },
  desktop: { width: 1440, height: 900, pointer: "fine" },
} as const;

/** The device the doors' stage asks for: the window the address names, the look, and the document's root. */
export function deviceOf(words: URLSearchParams, root: HTMLElement) {
  const room = ROOMS[(words.get("device") as keyof typeof ROOMS | null) ?? "desktop"] ?? ROOMS.desktop;
  const look = {
    face: words.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
    scheme: words.get("scheme") === "dark" ? "dark" : "light",
  } as const;
  return () => ({
    window: createFeed({ ...room, posture: "flat", reducedMotion: false } as never),
    appearance: createFeed(look as never),
    root: {
      read: (name: string) => root.getAttribute(name),
      write: (name: string, value: string | null) =>
        value === null ? root.removeAttribute(name) : root.setAttribute(name, value),
    },
  });
}

/**
 * A drawn state on the doors' stage, the ground the join's page stands on. A state of a refused connect is the form
 * alone, opened for the row's purpose (the first run's page around it is that seat's); the join's step is its page.
 */
export function ConnectState({
  drawn,
  lang,
  device,
}: {
  drawn: Drawn;
  lang: Lang;
  device: ReturnType<typeof deviceOf>;
}): ReactNode {
  return (
    <DoorStage device={device}>
      {drawn.kind === "join" ? (
        <JoinPage door={joinDoorOf(lang)} />
      ) : (
        <ConnectForm ask={askOf(drawn.row.purpose, drawn.row)} door={wireOf(drawn.row)} factor={discarded} />
      )}
    </DoorStage>
  );
}
