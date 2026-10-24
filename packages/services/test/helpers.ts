import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, changeLog, learningSignals, rules } from "@trafficflow/db";
import { and, asc, eq } from "drizzle-orm";
import type { AdapterPort, NativeLocator } from "@trafficflow/core";
import type {
  AlreadyGoneResult, MoveRequestResult, MoveResult, RuleCreation, RuleMutation, RuleRequestResult, ServiceContext,
} from "../src/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  NARROW A ROUTED RESULT TO THE ARM THAT WROTE HERE, AND REFUSE THE OTHER ONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `rulesService.create` / `update` and `MessageService.move` / `delete` answer a UNION now that a
 * press on a mailbox another install organizes travels instead of being refused: a mutation that
 * landed locally, or a `pending` request that deliberately wrote nothing here. Both arms are
 * exercised on purpose — `rules-fan-out.test.ts` and `reader-move-request.test.ts` own the
 * request arm.
 *
 * A case that runs as the ORGANIZER wants the local arm, and wants to be TOLD when it does not get
 * one. `as RuleMutation` reads the same and is not the same thing: it hands back a request whose
 * `rule` is absent, and the first property access is then `undefined` at run time with nothing
 * naming the reason. These narrow on the union's own discriminator and throw with the destination
 * in the message.
 */
export function mutated<M extends RuleMutation | RuleCreation>(r: M | RuleRequestResult): M {
  if ("pending" in r) {
    throw new Error(
      "expected a rule mutation written on this install, got a request travelling to "
      + JSON.stringify(r.travel),
    );
  }
  return r;
}

export function movedHere(r: MoveResult | MoveRequestResult | AlreadyGoneResult): MoveResult {
  if ("pending" in r) {
    throw new Error(
      "expected a move written on this install, got a request waiting on "
      + JSON.stringify(r.holder),
    );
  }
  if ("alreadyGone" in r) throw new Error("expected a move written on this install, got an already-gone answer");
  return r;
}

/** Records every move; returns a fresh native locator in the destination folder. */
export class FakeAdapter implements AdapterPort {
  moves: Array<{ from: string; to: string }> = [];
  private uid = 9000;
  async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
    this.moves.push({ from: locator.folder, to: String(to) });
    return { folder: String(to), ref: `1:${++this.uid}` };
  }
}

export async function makeCtx(now = new Date("2026-07-28T12:00:00Z")): Promise<{
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
  ctx: ServiceContext;
}> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@lichtgrat.example" }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => now, requestId: "r" };
  return { db, accountId, mailboxId: mb.id, ctx };
}

/**
 * A SECOND ACCOUNT with its own mailbox — the production shape for a negative control about
 * account isolation. Mail 0118 keys every child row to `(parent_id, account_id)`, so a
 * counter-example can no longer be a bare mismatched id: the database refuses that row, and a
 * double that cannot exist in production measures nothing.
 */
export async function otherAccount(
  db: Awaited<ReturnType<typeof makeTestDb>>, address = "someone@elsewhere.test",
): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address }).returning();
  return { accountId, mailboxId: mb!.id };
}

export interface SeedMessageOpts {
  from?: string;
  subject?: string;
  snippet?: string;
  folder?: string;          // observed folder (native location)
  desired?: string;         // desired folder (defaults to `folder`)
  unread?: boolean;
  date?: Date;
  ref?: string;
  /** The display name the sender chose — read by the deterministic sender check. */
  fromName?: string | null;
  /** `messages.auth_verdict`. NULL is the state of every row until that column is wired. */
  authVerdict?: string | null;
}

export async function seedMessage(
  db: Awaited<ReturnType<typeof makeTestDb>>,
  accountId: string,
  mailboxId: string,
  opts: SeedMessageOpts = {},
): Promise<string> {
  const {
    from = "stranger@example.com", subject = "hello", snippet = "hi there",
    folder = "ohmail/Screener", desired = folder, unread = true,
    date = new Date("2026-07-28T09:00:00Z"), ref = `1:${Math.floor(Math.random() * 1e6)}`,
    fromName = null, authVerdict = null,
  } = opts;
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject, fromAddress: from, fromName, authVerdict, date, nativeLocator: { folder, ref },
    snippet, unread,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: desired, observedFolder: folder,
    lastSetBy: "us", reconcileStatus: desired === folder ? "reconciled" : "pending", conflict: false,
  });
  return m!.id;
}

/**
 * A sender a PERSON screened out on this account — what `applyScreenerDecision` writes for a press:
 * the promoted rule with mail 0128's `person_decided_at`, AND the person's Screener signal for the
 * key. The automatic unsubscribe arm acts on nothing else (an imported stamp has no signal here), so
 * every fixture that models a screen-out writes both; a placement without them is one nobody pressed.
 */
export async function personScreenedOut(
  db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string, match: string,
  opts: { kind?: "sender" | "domain"; destination?: string; at?: Date } = {},
): Promise<void> {
  const kind = opts.kind ?? "sender";
  const key = match.trim().toLowerCase();
  const destination = opts.destination ?? "ohmail/Screened";
  await db.insert(rules).values({
    accountId, kind, match: key, destination, provenance: "promoted",
    personDecidedAt: opts.at ?? new Date("2026-07-28T08:00:00Z"),
  });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `screener:fixture:${randomUUID()}`, kind: "screener",
    ...(kind === "domain" ? { senderDomain: key } : { senderAddress: key }), destination, label: "positive",
  });
}

/** All change_log rows for an account, ascending by seq. */
export async function changesFor(db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string) {
  return db.select().from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
}

export { and, eq };
