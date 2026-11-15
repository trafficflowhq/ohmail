import { accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, rules, organizerRequests } from "@trafficflow/db";
import { ScreenerService } from "@trafficflow/services/mail";
import {
  deriveRequestKey,
  type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage, type MetaRecordsList,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";
import { listedOf } from "./_meta-list.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE TWO-WORLD READER-DECIDES RIG (THE named test)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `apps/worker/test/reader-two-worlds.imap.test.ts` is the LIVE version of this shape — a real
 * GreenMail server, a real second IMAP connection, "skipped loudly with no server" (its own
 * header). That infrastructure is unavailable in this environment (no docker), so this file
 * proves the SAME property — the "Organize-in-place" invariant, "only the organizer moves": a reader's decision becomes a
 * rule only after the organizer's own pass, never before — against a shared in-memory `RequestIo`
 * standing in for `ohmail/_meta`, driving the REAL production functions on both sides:
 *
 *   · `ScreenerService.decide` (the reader's own HTTP door) — the actual validate + role-branch +
 *     `organizer_requests` insert, not a hand-rolled stand-in.
 *   · `driveOutstandingRequests` (the reader's own cycle) — the actual signed append, and the
 *     actual settlement against the organizer's acknowledgement.
 *   · `applyMetaRequests` (the organizer's own drain) — the actual verify, apply, ack and expunge.
 *
 * ── THESE ARE THE PRODUCTION ENTRY POINTS, NOT UNGUARDED TWINS ──────────────────────────────
 *
 * The channel shipped INERT in 0.14.1's first cut, behind a flag, so this rig had to drive
 * unguarded variants and could prove only the SEQUENCING property — never that a reader's decision
 * reaches an organizer at all. Both twins are gone, and the precondition they stood in for is a
 * fact: a shared secret exists for this mailbox.
 *
 * This rig satisfies it exactly as production does, and the way it does so is the point. It does
 * not hand a key to either side. It DERIVES one, twice, from the mailbox password — and the two
 * derivations agree because the password is the same. That is what makes a local install a
 * first-class participant: it never contacts the hosted service, and it does not have to.
 *
 * The IMAP-specific claims `reader-two-worlds.imap.test.ts` proves — `ohmail/*` never created on
 * a reader, the mailbox untouched at the protocol level — are NOT re-proven here; this file is
 * the request/drain SEQUENCING property, one level up from the wire.
 */

/** ONE folder, two role objects over it — the shape `ohmail/_meta` has for two installs. */
function sharedMeta(): {
  store: Map<number, string>; reader: RequestReaderIo; organizer: RequestOrganizerIo;
} {
  const store = new Map<number, string>();
  let nextUid = 1;
  const list = async (): Promise<MetaRecordsList> =>
    listedOf([...store.entries()].map(([ref, raw]) => ({ ref, raw })));
  return {
    store,
    reader: {
      listMetaRecords: list,
      async append(raw: string): Promise<void> { store.set(nextUid++, raw); },
    },
    organizer: {
      listMetaRecords: list,
      async ack(raw: string): Promise<void> { store.set(nextUid++, raw); },
      async remove(refs: readonly unknown[]): Promise<void> {
        for (const r of refs) if (typeof r === "number") store.delete(r);
      },
    },
  };
}

const readerAdapter = (m: ReturnType<typeof sharedMeta>): MailboxAdapter =>
  ({ requestReaderIo: () => m.reader }) as unknown as MailboxAdapter;
const organizerAdapter = (m: ReturnType<typeof sharedMeta>): MailboxAdapter =>
  ({ requestOrganizerIo: () => m.organizer }) as unknown as MailboxAdapter;

const ACCT_PREFIX = "00000000-0000-0000-0000-0000000001";
const READER_SELF = { installId: "the-desktop", kind: "local" as const };

describe("the two-world reader-decides rig", () => {
  it("a reader's decision becomes a rule ONLY after the organizer's own pass, never before", async () => {
    const db = await makeTestDb();
    const accountId = `${ACCT_PREFIX}01`;
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "shared@x.example",
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
      organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    }).returning({ id: mailboxes.id });
    const mailboxId = mb!.id;
    const [msg] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
      subject: "s", fromAddress: "person@example.com", unread: true,
    }).returning({ id: messages.id });
    await db.insert(folderState).values({
      messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });

    // BOTH WORLDS DERIVE THE SAME KEY, and neither is told it. That is the whole reason a local
    // install can take part: the secret is HKDF over the mailbox password, which both sides hold
    // because both can open the mailbox, and nothing has to be delivered anywhere.
    const requestKey = deriveRequestKey({
      auth: { user: "shared@x.example", pass: "the-shared-mailbox-password" }, address: "shared@x.example",
    });
    expect(requestKey).not.toBeNull();

    // ── WORLD 1: the reader presses "yes" ──────────────────────────────────────────────────
    const svc = new ScreenerService({});
    const ctx = { db, accountId, userId: null, now: () => new Date("2026-09-03T12:00:00.000Z"), requestId: "r" };
    const decided = await svc.decide(ctx, msg!.id, { decision: "yes" });
    expect("pending" in decided && decided.pending).toBe(true);

    // Still no rule, still held — the ONE assertion this whole rig exists for.
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toEqual([]);
    const [heldBefore] = await db.select().from(folderState).where(eq(folderState.messageId, msg!.id));
    expect(heldBefore?.desiredFolder).toBe("ohmail/Screener");

    // ── WORLD 1's OWN CYCLE: append the request to the shared mailbox ──────────────────────
    const meta = sharedMeta();
    const sendResult = await driveOutstandingRequests(
      db, { mailboxId, accountId, adapter: readerAdapter(meta), requestKey }, READER_SELF,
      new Date("2026-09-03T12:00:01.000Z"), () => undefined,
    );
    expect(sendResult.sent).toBe(1);
    expect(meta.store.size).toBe(1);

    // STILL no rule — the record sitting in the shared folder is not itself an effect.
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toEqual([]);

    // ── WORLD 2: the organizer's own pass drains the SAME shared folder ────────────────────
    //
    // The single db stands in for BOTH worlds, so it must show each world its own row: on the
    // ORGANIZER's database this mailbox reads `organizer`, and since the account-wide decision
    // ruling (0.20) `applyScreenerDecision` re-reads every mailbox's role under lock and writes
    // only where it reads `organizer` — the drain applying against a `reader` row is exactly the
    // demoted-organizer write that lock exists to refuse. Flipped here, flipped back below.
    await db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, mailboxId));
    const drainResult = await applyMetaRequests(
      db, { mailboxId, accountId, installId: "organizer-install", adapter: organizerAdapter(meta), requestKey },
      new Date("2026-09-03T12:00:02.000Z"), () => undefined,
    );
    expect(drainResult).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });
    // The request is expunged; what is left in the folder is the organizer's ANSWER.
    expect([...meta.store.values()].filter((r) => r.includes("X-Ohmail-Request: 1"))).toHaveLength(0);
    expect([...meta.store.values()].filter((r) => r.includes("X-Ohmail-Ack: 1"))).toHaveLength(1);

    // NOW the rule exists, and the mail is re-routed.
    const createdRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(createdRules).toHaveLength(1);
    expect(createdRules[0]?.match).toBe("person@example.com");
    expect(createdRules[0]?.destination).toBe("INBOX");
    const [heldAfter] = await db.select().from(folderState).where(eq(folderState.messageId, msg!.id));
    expect(heldAfter?.desiredFolder).toBe("INBOX");

    // Back to WORLD 1's view of the same row — the reader's own database still says `reader`.
    await db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, mailboxId));

    // ── WORLD 1's NEXT CYCLE: reads the ANSWER, not the absence ────────────────────────────
    //
    // The record being gone is NOT what moves this row — a refused record is equally gone. What
    // moves it is the signed acknowledgement the organizer left in its place, which is the whole
    // difference between "your decision was carried out" and "something happened to it".
    const observeResult = await driveOutstandingRequests(
      db, { mailboxId, accountId, adapter: readerAdapter(meta), requestKey }, READER_SELF,
      new Date("2026-09-03T12:00:03.000Z"), () => undefined,
    );
    expect(observeResult.applied).toBe(1);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.mailboxId, mailboxId));
    expect(row?.state).toBe("applied");
  });

  it("the sender leaves the reader's own queue immediately — before the organizer has done anything", async () => {
    const db = await makeTestDb();
    const accountId = `${ACCT_PREFIX}02`;
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "shared2@x.example",
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
      organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    }).returning({ id: mailboxes.id });
    const mailboxId = mb!.id;
    const [msg] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
      subject: "s", fromAddress: "person@example.com", unread: true,
    }).returning({ id: messages.id });
    await db.insert(folderState).values({
      messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });

    const svc = new ScreenerService({});
    const ctx = { db, accountId, userId: null, now: () => new Date("2026-09-03T12:00:00.000Z"), requestId: "r" };

    const before = await svc.list(ctx, {});
    expect(before.items).toHaveLength(1);

    await svc.decide(ctx, msg!.id, { decision: "yes" });

    // Gone from the queue immediately — no APPEND has even happened yet.
    const after = await svc.list(ctx, {});
    expect(after.items).toEqual([]);
    expect(after.pendingDecisions).toHaveLength(1);
    expect(after.pendingDecisions[0]).toMatchObject({ subject: "person@example.com", sent: false });
  });
});
