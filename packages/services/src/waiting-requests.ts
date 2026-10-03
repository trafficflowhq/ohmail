import { and, eq, inArray } from "drizzle-orm";
import {
  listRequestsForSurface, mailboxes, messages, MOVE_DESTINATIONS, WAITING_REQUESTS_READ_MAX,
  type OrganizerRequestRow, type Tx,
} from "@trafficflow/db";
import { bridgeTx, type ServiceContext } from "./context.js";

/**
 * WHAT WAITS ON THE ORGANIZER, as a surface lists it: this install's requests to the install that
 * organizes a mailbox, still in flight or resolved within a day. One list, one source, for the web
 * Rules page and the phone's waiting sheet. The payload column is NEVER served: each kind's target
 * is projected (a profile change by its field names only, never their values).
 */
export interface WaitingRequestDTO {
  id: string;
  kind: string;
  state: "pending" | "sent" | "applied" | "expired" | "refused";
  mailboxId: string;
  /** The install holding the mailbox now, by the name it advertises; `null` when it names none. */
  holder: { name: string | null };
  decidedAt: string;
  resolvedAt: string | null;
  /** Why the organizer said no — only in `refused`. */
  refusedReason: string | null;
  target: WaitingTarget;
}

export type WaitingTarget =
  | {
    rule: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null };
    /** Where a create or change asks the rule to file, a folder path. */
    destination?: string;
  }
  | { messageId: string | null; folder: string | null }
  | { scope: string; match: string }
  | { fields: string[] }
  | { unknown: true };

type Payload = Record<string, unknown>;
const obj = (v: unknown): Payload | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const pathOf = (word: unknown): string | undefined => {
  const w = str(word);
  if (w === null) return undefined;
  return MOVE_DESTINATIONS.get(w) ?? undefined;
};

function ruleTarget(p: Payload): WaitingTarget {
  const key = obj(p.key);
  if (!key || str(key.kind) === null || str(key.match) === null) return { unknown: true };
  const set = obj(p.set);
  const destination = pathOf(p.destination) ?? pathOf(set?.destination);
  return {
    rule: {
      kind: key.kind as string, match: key.match as string,
      subjectContains: str(key.subjectContains), bodyContains: str(key.bodyContains),
    },
    ...(destination === undefined ? {} : { destination }),
  };
}

/** The read the route serves. Bounded by {@link WAITING_REQUESTS_READ_MAX}. */
export async function listWaitingOnOrganizer(ctx: ServiceContext): Promise<WaitingRequestDTO[]> {
  const tx: Tx = bridgeTx(ctx.db);
  const rows = await listRequestsForSurface(tx, ctx.accountId, ctx.now());
  if (rows.length === 0) return [];
  const holders = new Map((await tx.select({ id: mailboxes.id, name: mailboxes.organizedByName })
    .from(mailboxes).where(eq(mailboxes.accountId, ctx.accountId))).map((m) => [m.id, m.name ?? null]));

  // A move names its message by the key both installs share; this install's own row is the id.
  const moveKeys = rows.flatMap((r) => (r.kind === "message.move" ? [str(obj(r.payload)?.dedupKey)] : []))
    .filter((k): k is string => k !== null);
  const idOf = new Map<string, string>();
  if (moveKeys.length > 0) {
    // scoped-by: the account; bounded by the list's own read (WAITING_REQUESTS_READ_MAX).
    for (const m of await tx.select({ id: messages.id, dedupKey: messages.dedupKey, mailboxId: messages.mailboxId })
      .from(messages).where(and(eq(messages.accountId, ctx.accountId), inArray(messages.dedupKey, moveKeys)))) {
      idOf.set(`${m.mailboxId}\u0000${m.dedupKey}`, m.id);
    }
  }

  return rows.map((r: OrganizerRequestRow): WaitingRequestDTO => {
    const p = obj(r.payload) ?? {};
    let target: WaitingTarget;
    if (r.kind.startsWith("rule.")) target = ruleTarget(p);
    else if (r.kind === "message.move") {
      const key = str(p.dedupKey);
      target = { messageId: key === null ? null : idOf.get(`${r.mailboxId}\u0000${key}`) ?? null, folder: pathOf(p.destination) ?? null };
    } else if (r.kind === "screener.decide" && str(p.scope) !== null && str(p.match) !== null) {
      target = { scope: p.scope as string, match: p.match as string };
    } else if (r.kind === "profile.update") target = { fields: Object.keys(p).sort() };
    else target = { unknown: true };
    return {
      id: r.id, kind: r.kind, state: r.state, mailboxId: r.mailboxId,
      holder: { name: holders.get(r.mailboxId) ?? null },
      decidedAt: r.decidedAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null,
      refusedReason: r.state === "refused" ? r.refusedReason : null, target,
    };
  });
}
