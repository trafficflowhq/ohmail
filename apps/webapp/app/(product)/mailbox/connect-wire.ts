"use client";

/**
 * THE WEB'S CONNECT WIRE: the one connect form's calls over the server client. It never rejects: a call answers,
 * and what the server refused is read field by field (`refusalOf`), never handed on whole. It is the one place on
 * the web where a sealed password is opened, as the request's body is written.
 *
 * The provider's sign-in is this file's whole: which ceremonies the server runs, the start, whose ceremony it is,
 * where it lands and what came back. The form says what it was opened for and never names a landing; {@link
 * LANDING_OF} maps it, from a closed table. Cloud-only, like the rest of this folder: it needs `app/api-client`.
 */
import { NO_DETAILS, refusalOf } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { echoes, reveal, type Secret } from "@ohmail/app-logic/mailboxes/connect/secret";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import {
  SIGN_IN_FAILURES, SIGN_IN_REFUSALS, type Answered, type ConnectInput, type ConnectPurposeKind, type Refusal,
  type SignInFailureReason, type SignInProvider, type SignInRefusalReason, type SignInReturn,
} from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire, type ProviderSignInWire, type Signal } from "@ohmail/app/host";
import { ApiError, mailboxes as mailboxApi, messageOf, type MailboxDTO } from "../../api-client";
import { SessionBusyError } from "../../session-refresh";
import { readMicrosoftDoor } from "./microsoft-door";
import {
  oauthOutcome, rememberOAuthLanding, rememberOAuthOwner, subscribeOAuthOutcome, takeJoinOAuthOutcome,
  type JoinOAuthOutcome, type OAuthLanding, type OAuthOutcome,
} from "./oauth-return";

/**
 * WHERE A SIGN-IN LANDS, by what the form was opened for. The join returns to the join; everything else to
 * Settings → Mailboxes. The landing `first-run` stays in the return's closed set and stays unstarted, as it was.
 */
export const LANDING_OF: Readonly<Record<ConnectPurposeKind, OAuthLanding>> = Object.freeze({
  join: "join", firstRun: "settings", add: "settings", edit: "settings", reconnect: "settings",
});

/** What each landing asks the server to return to. Never read from the address, a parameter or a field. */
export const RETURN_TO: Readonly<Record<OAuthLanding, string>> = Object.freeze({ settings: "/", join: "/join", "first-run": "/" });

/** The one origin a start may leave for, per provider: the provider's own. */
export const PROVIDER_ORIGIN: Readonly<Record<SignInProvider, string>> = Object.freeze({
  microsoft: "https://login.microsoftonline.com",
});

const NO_ANSWER: Refusal = Object.freeze({ status: 0, code: null, message: "", details: NO_DETAILS });
const WORD = /^[a-z0-9_]{1,48}$/;
const SENTENCE_MAX = 600;

/**
 * What a call threw, as a refusal. A server's answer is read field by field. This client's own refusals (it could
 * not reach the server; this browser now holds another account; another tab holds the session's lock) carry no
 * status and are its own sentences, said as every surface says them. Anything else is no answer, and its text is
 * never taken. `pass`: the password the call carried; a server's sentence that repeats it is not taken, asked whole.
 */
function refusalOfThrown(thrown: unknown, pass?: Secret): Refusal {
  if (thrown instanceof ApiError && thrown.status === 0)
    return { status: 0, code: WORD.test(thrown.code) ? thrown.code : null, message: thrown.message.slice(0, SENTENCE_MAX), details: NO_DETAILS };
  if (thrown instanceof SessionBusyError)
    return { status: 0, code: thrown.code, message: messageOf(thrown).slice(0, SENTENCE_MAX), details: NO_DETAILS };
  return refusalOf(thrown, pass === undefined ? undefined : (text) => echoes(pass, text));
}

async function answered<T>(call: () => Promise<T>, pass?: Secret): Promise<Answered<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (thrown) {
    return { ok: false, refusal: refusalOfThrown(thrown, pass) };
  }
}
const refused: Answered<never> = Object.freeze({ ok: false, refusal: NO_ANSWER });

/** Does any text this value holds, at any depth, repeat what was sent? Asked of each text itself, never of its JSON. */
function holds(value: unknown, repeats: (text: string) => boolean): boolean {
  if (typeof value === "string") return repeats(value);
  return typeof value === "object" && value !== null && Object.values(value).some((inner) => holds(inner, repeats));
}

/**
 * WHAT A LISTENER IS HANDED OF A REFUSED CONNECT: the server's answer as the client read it. Where its sentence or its
 * details repeat the password that was sent, its status and code alone; and of a fault that is no server's answer,
 * nothing: neither may carry what was typed to a page.
 */
function heardOf(thrown: unknown, pass: Secret): unknown {
  if (!(thrown instanceof ApiError)) return null;
  const repeats = (text: string): boolean => echoes(pass, text);
  return repeats(thrown.message) || holds(thrown.details, repeats) ? new ApiError(thrown.status, thrown.code, "") : thrown;
}

/** A listener's own fault is never the connect's answer. */
function told(tell: () => void): void {
  try {
    tell();
  } catch {
    /* the form is answered as the server answered */
  }
}

/** A server of a body with its seal opened, each key where the form put it. */
function opened<S extends { readonly pass?: ConnectInput["imap"]["pass"] }>(server: S): Omit<S, "pass"> & { pass?: string } {
  return server.pass === undefined ? (server as Omit<S, "pass">) : { ...server, pass: reveal(server.pass) };
}

/** Is this where the provider itself signs people in? https, no user part, exactly its origin. */
function isProviders(address: string, provider: SignInProvider): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.origin === PROVIDER_ORIGIN[provider];
  } catch {
    return false;
  }
}

const refusalReason = (raw: string): SignInRefusalReason =>
  (SIGN_IN_REFUSALS as readonly string[]).includes(raw) ? (raw as SignInRefusalReason) : "consent_failed";
const failureReason = (raw: string | null): SignInFailureReason | null =>
  raw !== null && (SIGN_IN_FAILURES as readonly string[]).includes(raw) ? (raw as SignInFailureReason) : null;

/** What the page's own return store holds, as the form reads it: reasons narrowed, nothing raw. */
function ofPage(outcome: OAuthOutcome | null): SignInReturn | null {
  if (outcome === null) return null;
  if (outcome.kind === "running") return { kind: "running" };
  if (outcome.kind === "connected") return { kind: "connected", created: outcome.created, address: outcome.address };
  if (outcome.kind === "refused") return { kind: "refused", reason: refusalReason(outcome.reason) };
  return { kind: "failed", reason: null, message: outcome.message.slice(0, SENTENCE_MAX) };
}

/** What the join was handed back: its kind and reason, never an address. A join's sign-in connects a first mailbox. */
function ofJoin(outcome: JoinOAuthOutcome | null): SignInReturn | null {
  if (outcome === null) return null;
  if (outcome.kind === "connected") return { kind: "connected", created: true, address: null };
  if (outcome.kind === "refused") return { kind: "refused", reason: refusalReason(outcome.reason) };
  return { kind: "failed", reason: failureReason(outcome.reason), message: outcome.message?.slice(0, SENTENCE_MAX) ?? null };
}

/**
 * WHAT A SIGN-IN STARTED EARLIER CAME BACK WITH. On the page it is the return's own store, read as it stands. On
 * the join it is what the return handed back to `/join`, taken once at the first read and then gone from the tab.
 * A read answers the same value until the store changes.
 */
function returnedOf(where: "join" | "page"): Signal<SignInReturn | null> {
  if (where === "join") {
    let taken: { readonly value: SignInReturn | null } | null = null;
    return {
      subscribe: () => () => undefined,
      read: () => (taken ??= { value: ofJoin(takeJoinOAuthOutcome()) }).value,
    };
  }
  let last: OAuthOutcome | null | undefined;
  let value: SignInReturn | null = null;
  return {
    subscribe: subscribeOAuthOutcome,
    read: () => {
      const now = oauthOutcome();
      if (now !== last) {
        last = now;
        value = ofPage(now);
      }
      return value;
    },
  };
}

function signInOf(o: WebConnectWire): ProviderSignInWire {
  return {
    /* Fails closed: an unread or unreadable answer is a shut door, and only an explicit yes opens one. */
    ways: async () => {
      const door = await readMicrosoftDoor();
      return { microsoft: { redirect: door.available === true, device: door.device === true } };
    },
    /**
     * One call, then a top-level navigation. Before leaving, whose ceremony this is and where it lands are written
     * down, keyed by the state the server issued; a press retired while the server answered writes nothing and
     * leaves nowhere. It leaves only for the provider's own origin.
     */
    start: ({ provider, purpose, mailboxId, stillWanted }) =>
      answered(async () => {
        const landing = LANDING_OF[purpose];
        const { authorizeUrl, state } = await mailboxApi
          .oauthStart({ ...(mailboxId ? { mailboxId } : {}), returnTo: RETURN_TO[landing] })
          .catch((thrown: unknown) => {
            // The start carries no password: the server's refusal is handed on as it was read.
            told(() => o.heard?.refused(thrown instanceof ApiError ? thrown : null, { resent: false }));
            throw thrown;
          });
        if (!stillWanted()) return "retired" as const;
        if (typeof authorizeUrl !== "string" || typeof state !== "string" || !isProviders(authorizeUrl, provider)) throw NO_ANSWER;
        rememberOAuthOwner(state, o.owner());
        rememberOAuthLanding(landing, state);
        (o.leave ?? ((url: string) => window.location.assign(url)))(authorizeUrl);
        return "leaving" as const;
      }),
    returned: returnedOf(o.returned),
    /* The sign-in by a code is still the Mailboxes pane's own ceremony, with its own record in the tab: it comes to
       this wire in the change that replaces that pane, so that one ceremony never has two holders. */
    code: NONE,
  };
}

export interface WebConnectWire {
  /** The account a ceremony started here is for, written down before the browser leaves. */
  readonly owner: () => string | null;
  /** Where this wire's form stands: on the join, whose return was handed back to it, or on the app's page. */
  readonly returned: "join" | "page";
  /** How the browser leaves for the provider; the window's own navigation unless said. */
  readonly leave?: (url: string) => void;
  /**
   * FOR A PAGE OF THIS SHELL WITH A CEREMONY OF ITS OWN (the join's wizard): what a connect answered, as the server
   * gave it. The created row, before the form hears of it; and the server's refusal of a connect, or of a provider's
   * sign-in at its start, as this client read it (`null` for a fault that is no server's answer), with whether this
   * same press had been sent before (the form sends a press again once, after the second factor). The form is
   * answered as ever, and nothing of the request is handed on: a refusal that repeats the password is handed as its
   * status and code alone.
   */
  readonly heard?: {
    connected(row: MailboxDTO): void;
    refused(thrown: unknown, press: { readonly resent: boolean }): void;
  };
}

export function webConnectWire(o: WebConnectWire): ConnectWire {
  /* The presses a connect was refused for, by the body itself: the form re-sends that same value, never a copy. */
  const refusedOnce = new WeakSet<object>();
  return {
    probe: (input) =>
      answered(async () => {
        const smtp = input.smtp;
        /* What the connect dials, the outgoing server without its password: the service tries the incoming one. */
        const r = await mailboxApi.probe({
          address: input.address,
          imap: opened(input.imap) as Parameters<typeof mailboxApi.probe>[0]["imap"],
          smtp: {
            host: smtp?.host ?? "",
            ...(smtp?.port === undefined ? {} : { port: smtp.port }),
            ...(smtp?.secure === undefined ? {} : { secure: smtp.secure }),
            ...(smtp?.user === undefined ? {} : { user: smtp.user }),
            ...(smtp?.allowInsecure === true ? { allowInsecure: true } : {}),
          },
        });
        return { host: r.host, user: r.user, folders: r.folders, ...(r.sending ? { sending: r.sending } : {}) };
      }, input.imap.pass),
    /* Both modes are the one route on this door: a hosted account has no install to reconfigure. */
    connect: (input, _mode) =>
      answered(async () => {
        const dto = await mailboxApi.create({
          provider: input.provider,
          address: input.address,
          imap: { ...opened(input.imap), user: input.imap.user ?? input.address } as Parameters<typeof mailboxApi.create>[0]["imap"],
          ...(input.smtp ? { smtp: opened(input.smtp) } : {}),
        }).catch((thrown: unknown) => {
          const resent = refusedOnce.has(input);
          refusedOnce.add(input);
          told(() => o.heard?.refused(heardOf(thrown, input.imap.pass), { resent }));
          throw thrown;
        });
        const mailboxId = mailboxIdOfAnswer((dto as { id?: unknown } | null)?.id);
        if (mailboxId === null) throw NO_ANSWER;
        told(() => o.heard?.connected(dto));
        const address = (dto as { address?: unknown }).address;
        return { mailboxId, address: typeof address === "string" ? address : null };
      }, input.imap.pass),
    edit: async (mailboxId, patch) => {
      // An id that percent-encoding would change reaches no path.
      if (mailboxIdOfAnswer(mailboxId) === null) return refused;
      return answered(async () => {
        await mailboxApi.update(mailboxId, { imap: opened(patch.imap), ...(patch.smtp ? { smtp: opened(patch.smtp) } : {}) } as Parameters<typeof mailboxApi.update>[1]);
        return null;
      }, patch.imap.pass);
    },
    discover: (domain, signal) => mailboxApi.discover({ domain }, signal).catch(() => null),
    signIn: signInOf(o),
    localServerWait: false,
  };
}
