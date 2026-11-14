/**
 * THE ONE CONNECT FORM, AS A MACHINE. Pure: it reaches no wire and holds no clock. {@link connectStep} takes the
 * state and one event and answers the state after it, the press to send now (if any), what the form ended with (if
 * anything) and whether the password field is to forget what it holds. What it holds and hears is `state.ts`.
 *
 * A hook keeps the state in one place, applies each event where it arrives and sends what a step hands back. It
 * never steps inside a state updater: those may run twice, and a press a step handed back would be sent twice.
 */
import {
  afterRefusal,
  offersOfProbed,
  offersOfRefusal,
  withOffers,
  withTick,
  NO_CONSENTS,
} from "./consents.js";
import { GATED_IDLE, gatedStep, type GatedAnswer } from "./gate.js";
import { movedPressEnds } from "./gate-moved.js";
import { sameVanityParent } from "./hosts.js";
import { hostsFor, providerById } from "./providers.js";
import {
  gateOf,
  nothingRanSaid,
  probeReasonOf,
  probeTlsOf,
  reasonCodeOf,
  saidOf,
  signInSaid,
  type SaidContext,
} from "./refusal.js";
import { wayOf } from "./sign-in.js";
import {
  hostsNow,
  initialState,
  presetOf,
  type ConnectEvent,
  type ConnectFacts,
  type ConnectOutcome,
  type ConnectState,
  type Parked,
  type Stepped,
} from "./state.js";
import type { Answered, Connected, ConnectProbed, MailboxId } from "./types.js";

export * from "./state.js";

/** What the table that words a refusal needs to know of this form. */
export function contextOf(state: ConnectState, facts: ConnectFacts, afterFactor: boolean): SaidContext {
  const preset = presetOf(state.typed, facts);
  const edits = facts.purpose === "edit" || facts.purpose === "reconnect";
  return {
    purpose: facts.purpose,
    preset: preset?.id ?? null,
    manual: preset?.manual === true,
    ports: edits,
    signInArmed: wayOf(preset?.id ?? null, facts.ways, facts.code, false) !== null,
    afterFactor,
    factor: facts.factor,
  };
}

const still = (state: ConnectState): Stepped => ({ state, send: null, done: null, forget: false });

/**
 * WHAT A PRESS WOULD SEND HAS CHANGED: a press waiting on the second factor is withdrawn, and the test's verdict
 * goes with the form it described. Either a parked press equals what the form would send now, or there is none.
 * A press still on its way cannot be called back: the form remembers that it moved, and no factor is asked for it.
 */
function changed(state: ConnectState): ConnectState {
  const gate = state.gate.at === "asking" ? gatedStep(state.gate, { kind: "cancelled" }).state : state.gate;
  return { ...state, gate, moved: state.gate.at === "trying" ? true : state.moved, tested: null };
}

/** A server's name or port changed, or the provider: everything known about the old server goes. */
const forgetServer = (state: ConnectState): ConnectState => ({
  ...state,
  consents: NO_CONSENTS,
  suggestion: null,
  offerHosts: false,
});

function provider(state: ConnectState, id: string | null, byHand: boolean): ConnectState {
  const base = forgetServer(changed({ ...state, signIns: state.signIns + 1, leaving: false }));
  const calm = base.shown?.calm === true ? null : base.shown;
  if (id === null)
    return {
      ...base,
      shown: calm,
      typed: { ...base.typed, provider: null, byHand: false, byPassword: false },
    };
  const next = providerById(id);
  const previous = base.typed.provider === null ? null : providerById(base.typed.provider);
  // A named preset imposes its hosts; the manual entry keeps only what was typed on it (`hostsFor`).
  const hosts = hostsFor(next, { imapHost: base.typed.imapHost, smtpHost: base.typed.smtpHost }, previous);
  return {
    ...base,
    shown: calm,
    typed: {
      ...base.typed,
      provider: next.id,
      byHand,
      imapHost: hosts.imapHost,
      smtpHost: hosts.smtpHost,
      byPassword: false,
    },
  };
}

/** The wire answered the press on its way. */
function answered(state: ConnectState, answer: Answered<unknown>, facts: ConnectFacts): Stepped {
  if (state.gate.at !== "trying") return still(state);
  const { act, afterFactor } = state.gate;
  if (answer.ok) {
    const gate = gatedStep(state.gate, { kind: "answered", answer: { ok: true } }).state;
    if (act.verb === "test") {
      const ok = answer.value as ConnectProbed;
      // The sending leg's own offer opens from the test, as it would from the connect.
      const consents = withOffers(state.consents, offersOfProbed(ok, act.sent));
      return still({
        ...state,
        gate: GATED_IDLE,
        consents,
        tested: ok,
        shown: null,
        authHint: null,
        offerHosts: false,
      });
    }
    // The password leaves the form the moment the server has it, and everything typed goes with the form it described.
    const cleared: ConnectState = {
      ...initialState(null, facts),
      seq: state.seq,
      signIns: state.signIns,
      gate: gate.at === "done" ? GATED_IDLE : gate,
    };
    const done: ConnectOutcome =
      act.verb === "edit"
        ? // The mailbox that was asked: an answer names none.
          { kind: "saved", mailboxId: act.subject as MailboxId }
        : {
            kind: "connected",
            mailboxId: (answer.value as Connected).mailboxId,
            address: (answer.value as Connected).address,
            created: true,
          };
    return { state: cleared, send: null, done, forget: true };
  }
  const refusal = answer.refusal;
  const asks = gateOf(refusal);
  // With no dialog to ask, a closed window is the sign-in sentence and nothing is parked.
  const word: GatedAnswer<never> =
    asks === "factor" && facts.factor
      ? { ok: false, word: "factor" }
      : asks !== "other"
        ? { ok: false, word: "sign_in" }
        : { ok: false, word: "said", said: "" };
  // The form moved while this press was on its way: the factor is asked only for a press that equals what the form
  // would send now. Nothing ran, and the next press tries the form as it stands.
  const ended = movedPressEnds(state.gate, state.moved, word);
  if (ended !== null)
    return still({
      ...state,
      gate: ended,
      moved: false,
      shown: { said: nothingRanSaid(facts.purpose), calm: facts.purpose !== "join" },
    });
  const gate = gatedStep<Parked, never>(state.gate, { kind: "answered", answer: word }).state;
  if (gate.at === "asking") return still({ ...state, gate, shown: null });
  const reason = probeReasonOf(refusal);
  const tls = probeTlsOf(refusal);
  const preset = presetOf(state.typed, facts);
  return still({
    ...state,
    // A refused press is over: its frozen body, and the seal in it, goes with the answer.
    gate: { at: "idle", nothingRan: gate.nothingRan },
    shown: {
      said:
        gate.at === "refused" && gate.refusal.word === "sign_in"
          ? signInSaid(facts.purpose)
          : saidOf(refusal, contextOf(state, facts, afterFactor)),
      calm: false,
    },
    consents: afterRefusal(state.consents, offersOfRefusal(refusal, act.sent)),
    suggestion:
      tls?.kind === "hostname_mismatch" && tls.suggestedHost !== null
        ? { leg: tls.transport, host: tls.suggestedHost }
        : null,
    offerHosts: preset?.manual === true && (reason === "connect" || reason === "timeout"),
    authHint: reason === "auth" ? refusal.details.authHint : null,
    lastReason: reasonCodeOf(refusal),
    tested: null,
  });
}

/**
 * A SIGN-IN'S PRESS. The browser may leave for the provider on it, so the password leaves its field in this step,
 * before the shell is asked anything; and a press that is over leaves no body behind, its seal with it.
 */
function signInPressed(state: ConnectState): Stepped {
  return {
    state: {
      ...state,
      gate: state.gate.at === "refused" || state.gate.at === "done" ? GATED_IDLE : state.gate,
      signIns: state.signIns + 1,
      shown: null,
      leaving: false,
    },
    send: null,
    done: null,
    forget: true,
  };
}

/** One event, applied. */
export function connectStep(state: ConnectState, event: ConnectEvent, facts: ConnectFacts): Stepped {
  switch (event.kind) {
    case "typed": {
      const typed = { ...state.typed, [event.field]: event.value };
      const next = changed({ ...state, typed });
      // An address, a username and a name are no server's: what is known of the servers stays.
      const noServers = event.field === "address" || event.field === "user" || event.field === "displayName";
      return still(noServers ? next : forgetServer(next));
    }
    case "provider":
      return still(provider(state, event.id, event.byHand));
    case "password":
      return still(changed(state));
    case "byPassword":
      return still(
        changed({
          ...state,
          typed: { ...state.typed, byPassword: true },
          shown: null,
          signIns: state.signIns + 1,
          leaving: false,
        }),
      );
    case "tick":
      return still(
        changed({
          ...state,
          consents: withTick(
            state.consents,
            event.consent,
            event.leg,
            event.on,
            hostsNow(state.typed, facts),
          ),
        }),
      );
    case "suggestionTaken": {
      const s = state.suggestion;
      if (s === null) return still(state);
      // The vanity pair (mail.… and smtp.… of one parent) is corrected in one press; otherwise the refused leg alone.
      const both = sameVanityParent(state.typed.imapHost, state.typed.smtpHost);
      const typed = {
        ...state.typed,
        imapHost: s.leg === "imap" || both ? s.host : state.typed.imapHost,
        smtpHost: s.leg === "smtp" || both ? s.host : state.typed.smtpHost,
      };
      // It rewrites a host, so everything learned about the old one goes: the verdict, the consents, the offers.
      return still({ ...forgetServer(changed({ ...state, typed })), shown: null });
    }
    case "hostsTaken": {
      const typed = {
        ...state.typed,
        imapHost: event.imap ?? state.typed.imapHost,
        smtpHost: event.smtp ?? state.typed.smtpHost,
      };
      return still({ ...forgetServer(changed({ ...state, typed })), shown: null });
    }
    case "press": {
      const stepped = gatedStep(state.gate, { kind: "try", act: event.act });
      if (stepped.run === null) return still(state);
      const seq = state.seq + 1;
      return {
        state: { ...state, gate: stepped.state, seq, moved: false, shown: null },
        send: { ...stepped.run, seq },
        done: null,
        forget: false,
      };
    }
    case "answered":
      return event.seq === state.seq ? answered(state, event.answer, facts) : still(state);
    case "guarded":
      // The caller's guard said no: nothing was sent, and the caller says why. The press is over.
      return event.seq === state.seq && state.gate.at === "trying"
        ? still({ ...state, gate: GATED_IDLE })
        : still(state);
    case "factor": {
      const stepped = gatedStep(state.gate, { kind: event.answer });
      if (stepped.run !== null) {
        const seq = state.seq + 1;
        return {
          state: { ...state, gate: stepped.state, seq, moved: false, shown: null },
          send: { ...stepped.run, seq },
          done: null,
          forget: false,
        };
      }
      // The join's wizard said it at the press, as a refusal is said; the other mounts as a settled outcome.
      const shown =
        stepped.state.nothingRan && !state.gate.nothingRan
          ? { said: nothingRanSaid(facts.purpose), calm: facts.purpose !== "join" }
          : state.shown;
      return still({ ...state, gate: stepped.state, shown });
    }
    case "said":
      return still({
        ...state,
        shown: event.shown,
        lastReason: event.reason === undefined ? state.lastReason : event.reason,
      });
    case "signIn":
      if (event.at === "pressed") return signInPressed(state);
      return still({ ...state, leaving: event.at === "leaving" });
  }
}
