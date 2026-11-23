"use client";

/**
 * THE ONE CONNECT FORM'S HOOK: the machine of `model.ts` over the wire a mount hands in, with the address-first
 * helper and the provider's sign-in beside it. It returns what the form draws and the presses it offers.
 *
 * THE PASSWORD IS NOT HERE. It lives in the password field's own box and nowhere above it; this hook holds a handle
 * to that field and asks it for the seal at the press. What the hook returns, what it keeps for a caller and what it
 * hands on when the form ends hold no password.
 */
import { useMemo, useSyncExternalStore, type RefObject } from "react";
import { localTestPending } from "../../doors/local-server-host.js";
import { hostFieldOf, useAddressFirst } from "./address-first.js";
import { inputOf, patchOf, validPort } from "./body.js";
import { NONE, type ConnectFormInput, type PasswordHandle } from "./calls.js";
import { claimsOf, linesOf, type ConsentLine, type HostsNow } from "./consents.js";
import {
  PROTON,
  PROVIDERS,
  appPasswordPresetFor,
  providerById,
  type DiscoveredServer,
  type ProviderPreset,
} from "./providers.js";
import { PORT_INVALID } from "./refusal.js";
import { secretIsEmpty } from "./secret.js";
import { senderNameOf } from "./sender-name.js";
import { codeElsewhere, wayOf } from "./sign-in.js";
import { NAME_REFUSED } from "./standalone-said.js";
import {
  hostsNow,
  presetOf,
  type ConnectFacts,
  type ConnectState,
  type Parked,
  type TypedField,
} from "./state.js";
import type { CodeCeremony, SignInProvider } from "./types.js";
import { useMachine, type Machine } from "./use-machine.js";
import { useSignInPress, useSignInReturn, useWays } from "./use-sign-in.js";

export type { ConnectCalls, ConnectFormInput, PasswordHandle } from "./calls.js";

/** The mode a connect states, by what the form was opened for. An edit connects nothing. */
export const MODE_OF: Readonly<Record<"join" | "firstRun" | "add" | "standalone", "seed" | "add">> =
  Object.freeze({
    join: "seed",
    firstRun: "seed",
    add: "add",
    standalone: "seed",
  });

export interface ConnectForm {
  readonly state: ConnectState;
  readonly facts: ConnectFacts;
  /** The tiles, in the table's order, and the tile chosen. */
  readonly presets: readonly ProviderPreset[];
  readonly preset: ProviderPreset | null;
  /** The provider whose mail reaches other apps only through its own bridge, and whether the typed address is its. */
  readonly bridgeLabel: string;
  readonly bridged: boolean;
  /** The mailbox an edit is about signs in with an app password that a changed account password ends. */
  readonly appPasswordSubject: boolean;
  /** How the chosen tile, or an edit's mailbox, connects here when not by password. */
  readonly way: { readonly provider: SignInProvider; readonly by: "redirect" | "code" } | null;
  /** The provider's sign-in by code exists on this server and is run elsewhere, after setup. */
  readonly codeElsewhere: boolean;
  /** A password stands refused on a tile whose provider signs people in here: that sign-in may be offered beside it. */
  readonly signInInstead: boolean;
  readonly signInReturnedWithoutConnection: boolean;
  /** A sign-in by code, as the shell says to draw it. */
  readonly code: CodeCeremony | null;
  readonly hosts: HostsNow;
  readonly lines: readonly ConsentLine[];
  /** The press on its way. */
  readonly busy: "test" | "connect" | "edit" | "signIn" | null;
  /** The press parked behind the second factor, with its three answers. */
  readonly asking: {
    readonly verb: Parked["verb"];
    onVerified(): void;
    onCancel(): void;
    onDiscarded(): void;
  } | null;
  readonly ready: boolean;
  /** A lookup of who hosts this domain's mail is out. */
  readonly looking: boolean;
  /** The servers the lookup found, as two host fields would hold them, where the fields do not hold them yet. */
  readonly found: { readonly imap: string | null; readonly smtp: string | null } | null;
  /** The test waits on a server on this computer, which may take minutes. */
  readonly longWait: boolean;
  /** The field's handle is attached here. */
  readonly password: RefObject<PasswordHandle | null>;
  /** Only presence and the number of edits to the password field. */
  readonly passwordInput: Machine["passwordInput"];
  type(field: TypedField, value: string): void;
  choose(id: string): void;
  /** The password field changed: whether it holds anything now. Never what. */
  passwordChanged(filled: boolean): void;
  byPassword(): void;
  tick(line: ConsentLine, on: boolean): void;
  takeSuggestion(): void;
  takeFound(): void;
  lookUp(): void;
  test(): void;
  submit(): void;
  signIn(): void;
  stopCode(): void;
}

const filled = (value: string): boolean => value.trim() !== "";

/** A found server as one host field holds it, where the field does not hold it already. */
function foundFor(
  server: DiscoveredServer | null | undefined,
  kind: "imap" | "smtp",
  field: string,
): string | null {
  if (!server) return null;
  const value = hostFieldOf(server, kind);
  return value === field.trim() ? null : value;
}

/**
 * THE PRESS, built once from the form as it stands and frozen: parked behind the second factor, it is re-sent as
 * this value. The password is sealed at this moment and nowhere else; with none typed there is no press.
 */
function pressOf(verb: Parked["verb"], machine: Machine, facts: ConnectFacts): Parked | null {
  const { typed, consents } = machine.held.current;
  const pass = machine.password.current?.take();
  if (pass === undefined || secretIsEmpty(pass)) return null;
  const hosts = hostsNow(typed, facts);
  const claims = claimsOf(consents, hosts);
  if (verb === "edit") {
    if (facts.subject === null) return null;
    const body = patchOf(typed, pass, claims);
    const sent = Object.freeze({ imap: hosts.imap, smtp: body.smtp ? hosts.smtp : null });
    return Object.freeze({ verb, subject: facts.subject.id, mode: null, body, sent });
  }
  const preset = presetOf(typed, facts);
  if (preset === null || facts.purpose === "edit" || facts.purpose === "reconnect") return null;
  const mode = verb === "connect" ? MODE_OF[facts.purpose] : null;
  const body = inputOf(typed, preset, pass, claims, facts.purpose === "standalone");
  return Object.freeze({ verb, subject: null, mode, body, sent: Object.freeze({ ...hosts }) });
}

/**
 * The parked press's three answers, bound to that press: a factor of an older ceremony moves nothing newer. A late
 * "thrown away" of a ceremony already over still says that nothing ran, where no newer press waits.
 */
function askingOf(machine: Machine): ConnectForm["asking"] {
  const gate = machine.state.gate;
  if (gate.at !== "asking") return null;
  const parkedAt = machine.state.seq;
  const answer = (said: "verified" | "cancelled" | "discarded"): void => {
    const now = machine.held.current;
    const same = now.seq === parkedAt && now.gate.at === "asking";
    const over = said === "discarded" && now.gate.at !== "asking" && now.gate.at !== "trying";
    if (same || over) machine.dispatch({ kind: "factor", answer: said });
  };
  return {
    verb: gate.act.verb,
    onVerified: () => answer("verified"),
    onCancel: () => answer("cancelled"),
    onDiscarded: () => answer("discarded"),
  };
}

/** Whether the form holds enough to press: an edit its password; a new connection its tile, address, servers and password. */
function readyOf(machine: Machine, facts: ConnectFacts, door: ConnectFormInput["door"]): boolean {
  if (!machine.passwordInput.filled) return false;
  if (facts.purpose === "edit" || facts.purpose === "reconnect") return door.edit !== NONE;
  const { typed } = machine.state;
  const preset = presetOf(typed, facts);
  if (preset === null || !filled(typed.address)) return false;
  return (
    preset.manual !== true ||
    (filled(typed.imapHost) && (door.incomingOnly === true || filled(typed.smtpHost)))
  );
}

export function useConnectForm(input: ConnectFormInput): ConnectForm {
  const { door, purpose, subject } = input;
  const longWait =
    useSyncExternalStore(localTestPending.subscribe, localTestPending.read, localTestPending.read) &&
    door.localServerWait;
  const edits = purpose === "edit" || purpose === "reconnect";
  const ways = useWays(door.signIn);
  const runsCode = door.signIn !== NONE && door.signIn.code !== NONE;
  const facts = useMemo(
    (): ConnectFacts => ({ purpose, subject, factor: input.factor, ways, code: runsCode }),
    [purpose, subject, input.factor, ways, runsCode],
  );
  const machine = useMachine(input, facts);
  const { state, dispatch } = machine;
  const preset = presetOf(state.typed, facts);
  /* On an edit the mailbox's own way in decides; on a new connection, the tile's. */
  const way = edits
    ? subject?.signsIn === "provider"
      ? wayOf(subject.provider, ways, runsCode, false)
      : null
    : wayOf(preset?.id ?? null, ways, runsCode, state.typed.byPassword);

  /* THE ADDRESS FIRST: its domain preselects a tile the person can change. An edit has no tile. */
  const lookup = door.discover;
  const addressFirst = useAddressFirst({
    address: edits ? "" : state.typed.address,
    ...(lookup === NONE || edits
      ? {}
      : { lookup: (body: { domain: string }, signal: AbortSignal) => lookup(body.domain, signal) }),
    chosen: state.typed.provider,
    chosenByHand: state.typed.byHand,
    choose: (id) => dispatch({ kind: "provider", id, byHand: false }),
  });
  const signInReturnedWithoutConnection = useSignInReturn(input, machine);
  /* The tile's own sign-in, where the password way was taken on it: what a refused password there is answered by. */
  const instead = !edits && state.typed.byPassword ? wayOf(preset?.id ?? null, ways, runsCode, false) : null;
  const signIn = useSignInPress(input, machine, way, instead);

  const press = (verb: Parked["verb"]): void => {
    // A submit event can arrive even when the button is disabled.
    if (door.localServerWait && localTestPending.read()) return;
    const act = pressOf(verb, machine, facts);
    if (act !== null) dispatch({ kind: "press", act });
  };
  const offered = !edits && preset?.manual === true && state.offerHosts;
  const found = {
    imap: offered ? foundFor(addressFirst.guess?.imap, "imap", state.typed.imapHost) : null,
    smtp: offered ? foundFor(addressFirst.guess?.smtp, "smtp", state.typed.smtpHost) : null,
  };
  const gate = state.gate;
  const hosts = hostsNow(state.typed, facts);
  const submit = (): void => {
    if (way !== null) return signIn.signIn();
    // A name that cannot be stored sends nothing and says so; only the mount that asks for one can hold one.
    if (senderNameOf(state.typed.displayName ?? "") === undefined)
      return dispatch({ kind: "said", shown: { said: NAME_REFUSED, calm: false } });
    const separatePorts = edits || (facts.purpose === "standalone" && preset?.manual === true);
    const bad = (port: string): boolean => filled(port) && !validPort(port.trim());
    if (separatePorts && (bad(state.typed.imapPort) || bad(state.typed.smtpPort)))
      return dispatch({ kind: "said", shown: { said: PORT_INVALID, calm: false } });
    press(edits ? "edit" : "connect");
  };

  return {
    state,
    facts,
    presets: PROVIDERS,
    preset,
    bridgeLabel: PROTON.label,
    bridged: !edits && addressFirst.guess?.proton === true,
    appPasswordSubject:
      subject !== null &&
      (providerById(subject.provider).authHints === true ||
        appPasswordPresetFor(subject.address)?.authHints === true),
    way,
    codeElsewhere: !edits && codeElsewhere(preset?.id ?? null, ways, runsCode),
    signInInstead:
      instead !== null && state.shown !== null && !state.shown.calm && state.lastReason === "auth",
    signInReturnedWithoutConnection,
    code: signIn.code,
    hosts,
    lines: linesOf(state.consents, hosts),
    busy: signIn.signingIn ? "signIn" : gate.at === "trying" ? gate.act.verb : null,
    asking: askingOf(machine),
    ready: !longWait && readyOf(machine, facts, door),
    looking: !edits && addressFirst.looking,
    found: found.imap !== null || found.smtp !== null ? found : null,
    longWait,
    password: machine.password,
    passwordInput: machine.passwordInput,
    type: (field, value) => dispatch({ kind: "typed", field, value }),
    choose: (id) => {
      addressFirst.pick(id);
      dispatch({ kind: "provider", id, byHand: true });
    },
    passwordChanged: machine.passwordChanged,
    // The password way, and the servers the lookup found: each a new way in, and the caller's sentence goes with the old.
    byPassword: () => {
      dispatch({ kind: "byPassword" });
      input.guard?.clear();
    },
    tick: (line, on) => dispatch({ kind: "tick", consent: line.kind, leg: line.legs, on }),
    takeSuggestion: () => dispatch({ kind: "suggestionTaken" }),
    takeFound: () => {
      dispatch({ kind: "hostsTaken", imap: found.imap, smtp: found.smtp });
      input.guard?.clear();
    },
    lookUp: addressFirst.lookUp,
    // A shell with no test has no test press, and a press of none sends nothing.
    test: () => {
      if (door.probe !== NONE) press("test");
    },
    submit,
    signIn: signIn.signIn,
    stopCode: signIn.stopCode,
  };
}

/** What support may be told of this form: the tile's id and the last refusal's closed word. Nothing typed. */
export function helpFacts(form: ConnectForm): {
  readonly provider: string | null;
  readonly reason: string | null;
} {
  return { provider: form.preset?.id ?? null, reason: form.state.lastReason };
}
