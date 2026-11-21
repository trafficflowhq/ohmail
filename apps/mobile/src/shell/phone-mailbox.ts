import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/mailbox-id";
import { refusalOf, withoutEcho } from "@ohmail/app-logic/mailboxes/connect/refusal";
import type { MailboxRow } from "@ohmail/app-logic/mailboxes/pane-contract";
import { liveMailboxRows, mailboxSessionWithSignal, patchLocalMailbox, readMailboxCheck, readMailboxes, type PhoneMailbox } from "../net/mailboxes";
import type { ShellSession } from "../net/pairing";
import type { HttpDoor } from "./http-door";
import type { PhoneMailboxRequest, Refused, Requests } from "./bridge-kinds";

function rowOf(row: PhoneMailbox): MailboxRow | null {
  const id = mailboxIdOfAnswer(row.id);
  if (id === null || row.status === null) return null;
  return {
    id, address: row.address, status: row.status, provider: row.provider ?? "",
    createdAt: row.createdAt ?? "", displayName: row.displayName, authKind: row.authKind === "password" || row.authKind === "oauth" ? row.authKind : undefined, messageCount: row.messageCount,
    errorCode: row.errorCode ?? null, disabledReason: null, syncBlockedReason: null,
    syncBlockedSince: row.syncBlockedSince ?? null, lastSyncAt: row.lastSyncAt ?? null,
    initialImportCompletedAt: row.initialImportCompletedAt, addressIsOwn: row.addressIsOwn,
    organizerRole: row.organizerRole ?? undefined, organizeConsentedAt: row.organizeConsentedAt,
    organizerParkedAt: row.organizerParkedAt, organizerState: row.organizerState,
    organizedBy: row.organizedBy && { ...row.organizedBy, since: null }, fetching: row.fetching,
  };
}

export function readPhoneRoster(
  http: HttpDoor, scope: string, profile: ShellSession["profile"], signal: AbortSignal,
): Promise<PhoneMailbox[] | null> {
  return readMailboxes({
    profile,
    fetch: async () => {
      const answer = await http.request({ scope, method: "GET", path: "/mailboxes", headers: [], body: null }, signal);
      if ("refused" in answer || answer.status !== 200 || answer.body?.as !== "text") {
        return new Response(null, { status: 503 });
      }
      return new Response(answer.body.text, { status: answer.status });
    },
  });
}

type MailboxAnswer = Requests["phone.mailbox"]["answer"] | { readonly refused: Refused };

export async function answerPhoneMailbox(
  request: PhoneMailboxRequest,
  session: Pick<ShellSession, "standalone" | "boundAccount" | "profile" | "fetch">,
  live: () => boolean,
  signal: AbortSignal,
): Promise<MailboxAnswer> {
  const allowed = () => !signal.aborted && live() && session.boundAccount() === session.profile.accountId;
  if (!allowed()) return { refused: "cancelled" };
  if (!session.standalone) return { refused: "notReady" };

  const scoped = mailboxSessionWithSignal(session, signal);
  const roster = await readMailboxes(scoped, request.do === "list" && request.counts);
  if (!allowed()) return { refused: "cancelled" };
  if (roster === null) return { refused: "notReady" };
  const rows = liveMailboxRows(roster).filter((row) => row.addressIsOwn !== false);
  if (request.do === "list") return { rows: rows.map(rowOf).filter((row) => row !== null) };
  if (!rows.some((row) => row.id === request.mailboxId)) return { refused: "foreignScope" };

  if (request.do === "check") {
    const answer = await readMailboxCheck(scoped, request.mailboxId);
    if (!allowed()) return { refused: "cancelled" };
    return answer === null ? { refused: "notReady" } : { checked: answer.check };
  }

  const response = await patchLocalMailbox(scoped, request.mailboxId, request.patch);
  if (!allowed()) return { refused: "cancelled" };
  if (response.ok) return { edited: { ok: true, value: null } };
  const body = await response.json().catch(() => null) as { error?: { code?: unknown; details?: unknown } } | null;
  if (!allowed()) return { refused: "cancelled" };
  // Only known diagnostic fields cross back; an error message can contain the credentials just typed.
  const { imap, smtp } = request.patch;
  const error = withoutEcho(
    refusalOf({ status: response.status, code: body?.error?.code, details: body?.error?.details }),
    (text) => text.includes(imap.pass) || (smtp !== undefined && text.includes(smtp.pass)),
  );
  const tls = error.details.tls;
  return {
    edited: { ok: false, refusal: {
      ...error,
      details: { ...error.details, tls: tls && { ...tls, plaintext: null, certificate: null } },
    } },
  };
}
