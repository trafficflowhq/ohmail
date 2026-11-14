"use client";

/**
 * THE WEB'S MAILBOXES WIRE: the Mailboxes pane's own calls over the server client, each the route the shipped pane
 * called, with the body it sent. It never rejects: what the server refused is read field by field, its sentence the
 * one the shipped pane said (`messageOf`). An id that percent-encoding would change reaches no path, and a row is
 * narrowed at this seam (`toMailboxRow`); one whose id is none is dropped. Cloud-only, like the rest of this folder.
 */
import { refusalOf } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { reveal } from "@ohmail/app-logic/mailboxes/connect/secret";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/subject";
import type { Answered, MailboxId, Refusal } from "@ohmail/app-logic/mailboxes/connect/types";
import type {
  ConnectAllowance, MailboxErased, MailboxRow, OrganizerPeek,
} from "@ohmail/app-logic/mailboxes/pane-contract";
import { NONE, type MailboxesWire } from "@ohmail/app/host";
import { account, auth, mailboxes as mailboxApi, messageOf, type MailboxDTO } from "../../api-client";
import { toMailboxFacts } from "./mailbox-facts";

const SENTENCE_MAX = 600;

/** What a call threw, as a refusal: the typed fields, and the sentence the shipped pane said for it. */
function refusalOfThrown(thrown: unknown): Refusal {
  const read = refusalOf(thrown);
  return { ...read, message: messageOf(thrown).slice(0, SENTENCE_MAX) };
}

async function answered<T>(call: () => Promise<T>): Promise<Answered<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (thrown) {
    return { ok: false, refusal: refusalOfThrown(thrown) };
  }
}

/** An id that is no id: refused before any request, with no sentence to say. */
const NOT_AN_ID: Answered<never> = Object.freeze({
  ok: false,
  refusal: Object.freeze({ ...refusalOf(null), message: "" }),
});
const byId = <T>(id: MailboxId, call: () => Promise<T>): Promise<Answered<T>> =>
  mailboxIdOfAnswer(id) === null ? Promise.resolve(NOT_AN_ID) : answered(call);

/** One row of the server's list, narrowed for the pane; `null` where its id is none. */
export function toMailboxRow(m: MailboxDTO): MailboxRow | null {
  const id = mailboxIdOfAnswer(m.id);
  if (id === null) return null;
  return {
    ...toMailboxFacts(m),
    id,
    provider: m.provider,
    ...(typeof m.messageCount === "number" ? { messageCount: m.messageCount } : {}),
    ...(m.erasure ? { erasure: { remaining: m.erasure.remaining } } : {}),
    ...("failedAt" in m ? { failedAt: m.failedAt ?? null } : {}),
    ...(typeof m.retryCount === "number" ? { retryCount: m.retryCount } : {}),
    ...(typeof m.setAside === "number" ? { setAside: m.setAside } : {}),
  };
}

const rowsOf = (items: readonly MailboxDTO[]): MailboxRow[] =>
  items.map(toMailboxRow).filter((r): r is MailboxRow => r !== null);

/** The answer about the mailbox asked, or none: a receipt that names another is refused. */
function erasedOf(asked: MailboxId, r: { erasing: boolean; mailboxId: string; messages: number; drafts: number; draftsUnanchored: number }): MailboxErased {
  if (r.mailboxId !== asked) throw new TypeError("another mailbox");
  return { erasing: r.erasing, mailboxId: asked, messages: r.messages, drafts: r.drafts, draftsUnanchored: r.draftsUnanchored };
}

/**
 * Whether another mailbox may be connected: the session's proven address (a session not yet whole is unknown) and the
 * server's fresh verdict (an unmetered host has nothing to block on). Each unreadable half is unknown, never a block.
 */
async function allowance(): Promise<ConnectAllowance> {
  const [session, access] = await Promise.allSettled([auth.session(), account.access({ fresh: true })]);
  const proven = session.status === "fulfilled" && session.value.scope === "full" ? session.value.user.emailVerified : null;
  const a = access.status === "fulfilled" ? access.value : null;
  return {
    emailVerified: typeof proven === "boolean" ? proven : null,
    access: a === null ? null : a.metered ? { canAddMailbox: a.canAddMailbox, mailboxes: a.mailboxes } : { canAddMailbox: true, mailboxes: null },
  };
}

export function webMailboxesWire(): MailboxesWire {
  return {
    list: ({ counts }) => answered(async () => rowsOf((await mailboxApi.list(counts ? { counts: true } : {})).items)),
    allowance: () => answered(allowance),
    resync: (id) => byId(id, async () => (await mailboxApi.resync(id), null)),
    remove: (id) => byId(id, async () => (await mailboxApi.remove(id), null)),
    erase: (id, typed) => byId(id, async () => erasedOf(id, await mailboxApi.erase(id, typed))),
    organizer: (id) =>
      byId(id, async (): Promise<OrganizerPeek> => {
        const p = await mailboxApi.organizer(id);
        return { state: p.state, holders: p.holders.map((h) => ({ ...h })), unreadable: p.unreadable };
      }),
    organizeHere: (id, { password }) =>
      byId(id, async () => {
        // The pane sends what the shipped pane sent (no body: the hosted door reads it as a take-over); a password
        // rides only where one was typed.
        const body = password === undefined ? ([] as const) : ([{ imap: { pass: reveal(password) } }] as const);
        const r = await mailboxApi.organize(id, ...body);
        return { outcome: r.outcome };
      }),
    stopOrganizing: (id) => byId(id, async () => ({ outcome: (await mailboxApi.release(id)).outcome })),
    dismissForwardingNotice: (id) =>
      byId(id, async () => {
        const row = toMailboxRow(await mailboxApi.dismissInboundQuiet(id));
        if (row === null || row.id !== id) throw new TypeError("another mailbox");
        return row;
      }),
    selfCheck: (id) => byId(id, () => mailboxApi.selfCheck(id)),
    filings: {
      read: (id) => byId(id, () => mailboxApi.filings(id)),
      retry: (id, folder) => byId(id, () => mailboxApi.retryFilings(id, folder)),
      leave: (id, folder, through) => byId(id, () => mailboxApi.leaveFilings(id, folder, through)),
    },
    // This shell changes mailboxes here.
    out: NONE,
  };
}
