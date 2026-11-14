/**
 * THE CONNECT FORM'S WIRE OVER A SHELL'S THROWING FIRST-RUN VERBS: the desktop's local door (`FirstRunHost.probe`,
 * `connect`, `discover`) answered as `ConnectWire`. It is a wire adapter, so it is the one place here that opens the
 * sealed password: into the old verb's input, for one call. It never rejects: a throw is read field by field into a
 * refusal, and an id is minted only from the answer.
 */
import type { FirstRunMailboxInput, FirstRunProbeOk } from "@ohmail/app-logic/doors/first-run-host";
import { echoes, reveal, type Secret } from "@ohmail/app-logic/mailboxes/connect/secret";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import { refusalOfThrown } from "@ohmail/app-logic/mailboxes/connect/thrown";
import type {
  Answered,
  ConnectInput,
  ConnectProbed,
  Connected,
} from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire } from "../../host/index.js";

/** The first-run verbs this adapter takes: each resolves on success and throws on every refusal. */
export interface ThrowingFirstRun {
  probe(input: FirstRunMailboxInput): Promise<FirstRunProbeOk>;
  connect(input: FirstRunMailboxInput, mode: "seed" | "add"): Promise<{ id: string }>;
  discover?: (body: { domain: string }, signal: AbortSignal) => Promise<unknown>;
  localServerWait?: boolean;
}

/** No mailbox in the answer: a create that named no id is not a connect. */
const NO_ID = Symbol("no id");

/** A verb's answer. `pass`: the password the verb carried; a sentence that repeats it is not taken, asked whole. */
async function answered<T>(call: () => Promise<T>, pass: Secret): Promise<Answered<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (thrown) {
    const repeats = (text: string): boolean => echoes(pass, text);
    return { ok: false, refusal: refusalOfThrown(thrown === NO_ID ? null : thrown, repeats) };
  }
}

/** A server of the body with its seal opened, each key where the form put it and no other. */
function opened<S extends { readonly pass?: ConnectInput["imap"]["pass"] }>(
  server: S,
): Omit<S, "pass"> & { pass?: string } {
  if (server.pass === undefined) return server as Omit<S, "pass">;
  return { ...server, pass: reveal(server.pass) };
}

/** The old verbs' input: the form's body as it stood, the password opened into its two `pass` fields. */
function inputOf(input: ConnectInput): FirstRunMailboxInput {
  const { pass, ...imap } = input.imap;
  return {
    address: input.address,
    provider: input.provider,
    imap: { ...imap, pass: reveal(pass) },
    ...(input.smtp ? { smtp: opened(input.smtp) } : {}),
  };
}

/** What a passed test proved, the answer's own fields and no other. */
function probedOf(r: FirstRunProbeOk): ConnectProbed {
  return {
    host: r.host,
    user: r.user,
    folders: typeof r.folders === "number" ? r.folders : null,
    ...(r.sending ? { sending: r.sending } : {}),
  };
}

export function connectWireOver(old: ThrowingFirstRun): ConnectWire {
  const discover = old.discover;
  return {
    probe: (input) => answered(async () => probedOf(await old.probe(inputOf(input))), input.imap.pass),
    /* The mode is the caller's, stated: `seed` reconfigures the install, `add` writes a row beside it. */
    connect: (input, mode) =>
      answered(async (): Promise<Connected> => {
        const made = await old.connect(inputOf(input), mode);
        const mailboxId = mailboxIdOfAnswer((made as { id?: unknown } | null)?.id);
        if (mailboxId === null) throw NO_ID;
        return { mailboxId, address: null };
      }, input.imap.pass),
    edit: NONE,
    /* The domain alone; a lookup that fails is no guess. */
    discover:
      discover === undefined ? NONE : (domain, signal) => discover({ domain }, signal).catch(() => null),
    signIn: NONE,
    localServerWait: old.localServerWait === true,
  };
}
