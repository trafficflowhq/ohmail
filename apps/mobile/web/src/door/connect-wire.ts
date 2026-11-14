/**
 * THE PHONE'S CONNECT WIRE: the one connect form's calls on the door's page, where a phone opens its own mailbox.
 * It is the one place on this page where a sealed password is opened: into the body of the door's `open`, once a
 * press, and nowhere else. Nothing here keeps it, and nothing that comes back is allowed to repeat it: a refusal is
 * handed to the form as its code and the server field it is about, and no word that crossed with it is taken.
 *
 * It never rejects. A bridge that refuses, a deadline, an answer it cannot read and a body it cannot open are each
 * "no answer"; only an answer that says so in full is a mailbox opened.
 *
 * The phone's engine opens with the credentials, so there is no test apart from the open; a mailbox this phone
 * organizes is edited on the scoped page; and no lookup and no provider's sign-in runs from a page with no session.
 */
import { NONE, type ConnectWire } from "@ohmail/app/host";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { reveal } from "@ohmail/app-logic/mailboxes/connect/secret";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/mailbox-id";
import type { Answered, Connected, ConnectInput, Refusal } from "@ohmail/app-logic/mailboxes/connect/types";
import type { DoorRequests, OpenField, OpenInput } from "../../../src/shell/door-kinds";
import type { RequestOptions } from "../channel";

type Open = DoorRequests["open"];

/** The one request of the door this wire sends. A door's handle answers it by structure. */
export interface OpensMailbox {
  ask(kind: "open", ask: Open["ask"], opts?: RequestOptions): Promise<Open["answer"]>;
}

/**
 * How long an open may take. Native answers after the mail server did and after the system's question about
 * notices, which a person reads: longer than a request to a server waits.
 */
export const OPEN_DEADLINE_MS = 10 * 60_000;

/**
 * The port a server is dialled on where the form named none: the provider table's two for a server it does not
 * know, which the phone's own form offered. The phone's engine walks no ladder of ports and refuses an absent one.
 */
export const OPEN_PORTS = Object.freeze({ imap: 993, smtp: 587 });

const NO_ANSWER: Answered<never> = Object.freeze({
  ok: false,
  refusal: Object.freeze({ status: 0, code: null, message: "", details: NO_DETAILS }),
});

/** A refusal's code as native names one: a plain key, never a path and never a name every object carries. */
const CODE = /^[a-z][A-Za-z0-9]{0,63}$/;
const FIELDS: readonly OpenField[] = ["imapHost", "imapPort", "smtpHost", "smtpPort"];

/** The body of `open`, from the form's: the login is the address, and each server is a name and a port. */
function openInputOf(input: ConnectInput): OpenInput {
  return {
    address: input.address,
    // THE ONE LINE where a mailbox's password is opened on this page: into this body, for this one request.
    pass: reveal(input.imap.pass),
    name: input.displayName ?? null,
    imap: { host: input.imap.host, port: input.imap.port ?? OPEN_PORTS.imap },
    smtp: input.smtp === undefined ? null : { host: input.smtp.host, port: input.smtp.port ?? OPEN_PORTS.smtp },
  };
}

/** What native answered, read field by field. Its words (`args`) are not read at all. */
function answeredOf(answer: unknown): Answered<Connected> {
  if (typeof answer !== "object" || answer === null) return NO_ANSWER;
  const a = answer as { readonly ok?: unknown; readonly mailboxId?: unknown; readonly code?: unknown; readonly field?: unknown };
  if (a.ok === true) {
    const mailboxId = mailboxIdOfAnswer(a.mailboxId);
    return mailboxId === null ? NO_ANSWER : { ok: true, value: { mailboxId, address: null } };
  }
  if (a.ok !== false || typeof a.code !== "string" || !CODE.test(a.code) || a.code in Object.prototype)
    return NO_ANSWER;
  const field = FIELDS.find((known) => known === a.field) ?? null;
  const refusal: Refusal = { status: 0, code: a.code, message: "", details: { ...NO_DETAILS, field } };
  return { ok: false, refusal };
}

export function phoneConnectWire(door: OpensMailbox): ConnectWire {
  return {
    probe: NONE,
    /* This phone opens one mailbox, its own: the mode names nothing here. */
    connect: async (input, _mode) => {
      try {
        return answeredOf(await door.ask("open", { input: openInputOf(input) }, { deadlineMs: OPEN_DEADLINE_MS }));
      } catch {
        // What was thrown is never read: a bridge's refusal names no cause a person could act on, and an error's text is not a sentence.
        return NO_ANSWER;
      }
    },
    edit: NONE,
    discover: NONE,
    signIn: NONE,
    localServerWait: false,
  };
}
