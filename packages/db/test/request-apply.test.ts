import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { accounts, folderState, mailboxes, messages, threads, changeLog, organizerRequests } from "../src/schema.js";
import { LEGACY_NEWS_FOLDER } from "../src/screener-apply.js";
import {
  MOVE_DESTINATIONS, MOVE_DEDUP_KEY_MAX, validateMovePayload, applyMessageMove,
  AWAY_PILES, validateProfileUpdatePayload, TRAVELLING_SIGNATURE_HTML_MAX_BYTES,
  TRAVELLING_OHBOX_BAR_MAX_BYTES, exportPendingMovesOnStandDown,
} from "../src/request-apply.js";
import { effectForDestination } from "@trafficflow/core/mail";
import { AWAY_ANSWERABLE_PILES } from "@trafficflow/core/away-scope";
import type { Tx } from "../src/change-log.js";

/**
 * THE `message.move` APPLIER (mail 0094) — the organizer's side of a reader's move.
 *
 * PGlite here, and the CONCURRENCY half is deliberately NOT here: two cycles racing one record on
 * one `dedup_key` is a real-Postgres question and PGlite cannot answer it (three production bugs
 * were invisible to it). That case lives in `request-apply-dedup-race.pg.test.ts`.
 */

const ACCT = "00000000-0000-0000-0000-0000000000da";

async function world(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<{
  mailboxId: string; messageId: string; dedupKey: string;
}> {
  await db.insert(accounts).values({ id: ACCT, name: "move" }).onConflictDoNothing();
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${randomUUID()}@example.test`,
  }).returning({ id: mailboxes.id });
  const [th] = await db.insert(threads).values({ accountId: ACCT, subject: "s" }).returning({ id: threads.id });
  const dedupKey = randomUUID().replace(/-/g, "");
  const [msg] = await db.insert(messages).values({
    accountId: ACCT, mailboxId: mb!.id, threadId: th!.id, dedupKey,
    messageIdHeader: `<${dedupKey}@example.test>`, bodyHash: randomUUID(),
    nativeLocator: { folder: "ohmail/Screener", uidvalidity: "1", uid: 4 },
  }).returning({ id: messages.id });
  return { mailboxId: mb!.id, messageId: msg!.id, dedupKey };
}

const apply = (db: Awaited<ReturnType<typeof makeTestDb>>, mailboxId: string, payload: { dedupKey: string; destination: string }) =>
  db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
    accountId: ACCT, mailboxId, payload, now: new Date("2026-09-07T10:00:00.000Z"),
  }));

describe("the destination vocabulary is symbolic and closed", () => {
  /**
   * THE DUPLICATION GUARD. `MOVE_DESTINATIONS` re-spells the canonical `Destination` union
   * because this package must not depend on `@trafficflow/core` — so the equality that keeps the
   * copy honest is a test, exactly as `screener-apply.test.ts` does for `DECIDABLE_FOLDERS`.
   * Without it the two drift the first time a folder is added and nothing anywhere notices.
   */
  it("every mapped path is a folder core recognises, and `trash` is the one word the map cannot answer", () => {
    for (const [word, path] of MOVE_DESTINATIONS) {
      if (word === "trash") {
        expect(path, "`trash` must resolve per mailbox, never to a constant the map invented").toBeNull();
        continue;
      }
      expect(path, `${word} maps to nothing`).not.toBeNull();
      // Throws for a path outside the union, which is the assertion.
      expect(() => effectForDestination(path as never)).not.toThrow();
    }
  });

  it("refuses a raw IMAP path — the property the whole indirection exists for", () => {
    for (const raw of ["INBOX", "ohmail/News", "Trash", "INBOX.Archive", "../../etc", ""]) {
      expect(validateMovePayload({ dedupKey: "k", destination: raw }),
        `a raw path "${raw}" was accepted as a destination`).toBeNull();
    }
  });

  it("refuses a malformed payload in every shape a record could carry", () => {
    expect(validateMovePayload(null)).toBeNull();
    expect(validateMovePayload("inbox")).toBeNull();
    expect(validateMovePayload([{ dedupKey: "k", destination: "inbox" }])).toBeNull();
    expect(validateMovePayload({})).toBeNull();
    expect(validateMovePayload({ destination: "inbox" })).toBeNull();
    expect(validateMovePayload({ dedupKey: "k" })).toBeNull();
    expect(validateMovePayload({ dedupKey: "", destination: "inbox" })).toBeNull();
    expect(validateMovePayload({ dedupKey: 7, destination: "inbox" })).toBeNull();
    expect(validateMovePayload({ dedupKey: "k", destination: null })).toBeNull();
    expect(validateMovePayload({ dedupKey: "x".repeat(MOVE_DEDUP_KEY_MAX + 1), destination: "inbox" })).toBeNull();
  });

  it("admits the ordinary case — the positive control", () => {
    // Every other assertion here is a refusal, and a validator that refuses everything is
    // indistinguishable from one that works until somebody sends a real record.
    expect(validateMovePayload({ dedupKey: "abc123", destination: "inbox" }))
      .toEqual({ dedupKey: "abc123", destination: "inbox" });
    expect(validateMovePayload({ dedupKey: "x".repeat(MOVE_DEDUP_KEY_MAX), destination: "trash" }))
      .toEqual({ dedupKey: "x".repeat(MOVE_DEDUP_KEY_MAX), destination: "trash" });
  });
});

describe("applyMessageMove writes desired state and nothing else", () => {
  it("resolves by (mailbox, dedupKey), writes desired pending, and PRESERVES observed", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    // A row the worker already owns, saying where the message physically is.
    await db.insert(folderState).values({
      messageId: w.messageId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "worker", reconcileStatus: "clean", conflict: false,
    });

    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "reads" });
    expect(r.applied).toBe(true);
    if (!r.applied) throw new Error("unreachable");
    expect(r.messageId).toBe(w.messageId);
    expect(r.to).toBe("ohmail/News");
    expect(r.from).toBe("ohmail/Screener");

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder).toBe("ohmail/News");
    /* THE ASSERTION THAT MATTERS. `observed_folder` is the worker's record of physical reality. An
       applier that wrote it would assert a move it never performed, the reconciler would compare
       desired against that lie and find nothing to do, and the message would sit where it was
       while the row said it had arrived. Nothing else in the system would notice. */
    expect(fs!.observedFolder, "observed_folder was overwritten — the applier claimed a physical move it did not perform")
      .toBe("ohmail/Screener");
    expect(fs!.reconcileStatus).toBe("pending");
    expect(fs!.lastSetBy).toBe("us");
  });

  it("with no folder_state row yet, `from` comes from the message's own locator", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "inbox" });
    expect(r.applied).toBe(true);
    if (!r.applied) throw new Error("unreachable");
    // The locator seeded by `world`, not the "INBOX" last-resort default — a `from` that silently
    // said INBOX for a message held in the Screener would put a false move in the change feed.
    expect(r.from).toBe("ohmail/Screener");
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.observedFolder).toBe("ohmail/Screener");
  });

  it("records one change_log move carrying from and to", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "receipts" });
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityId, w.messageId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.op).toBe("move");
    expect(rows[0]!.meta).toEqual({ from: "ohmail/Screener", to: "ohmail/Receipts" });
  });

  it("applied TWICE is one desired state, not two moves", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const a = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "reads" });
    const b = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "reads" });
    expect(a.applied && b.applied).toBe(true);
    const rows = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(rows, "the upsert is keyed on message_id; two rows means it is not").toHaveLength(1);
    expect(rows[0]!.desiredFolder).toBe("ohmail/News");
    expect(rows[0]!.observedFolder).toBe("ohmail/Screener");
  });

  it("a move to where it already is still applies and still acks", async () => {
    // A reader may legitimately ask for a state that has since become true. Answering "nothing to
    // do" would make the ack depend on a race the reader cannot see.
    const db = await makeTestDb();
    const w = await world(db);
    await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "screener" });
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "screener" });
    expect(r.applied).toBe(true);
  });
});

describe("the two outcomes that are not refusals of the record", () => {
  it("a dedup key this install has never seen is `no_such_message`, not an error", async () => {
    // Two installs of one mailbox legitimately hold different subsets of it.
    const db = await makeTestDb();
    const w = await world(db);
    const r = await apply(db, w.mailboxId, { dedupKey: "neverseenhere", destination: "inbox" });
    expect(r).toEqual({ applied: false, refusal: "no_such_message" });
  });

  it("a TOMBSTONED message is `no_such_message` — a cancelled intent is not resurrected", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, w.messageId));
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "inbox" });
    expect(r).toEqual({ applied: false, refusal: "no_such_message" });
    expect(await db.select().from(folderState).where(eq(folderState.messageId, w.messageId))).toHaveLength(0);
  });

  it("`trash` with no discovered Trash folder is `no_trash_folder`, and writes NOTHING", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "trash" });
    expect(r).toEqual({ applied: false, refusal: "no_trash_folder" });
    /* ohmail never expunges, so there is no fallback that is not a lie about where the mail went.
       Asserting the absence of a write matters as much as the refusal: a half-applied refusal
       would leave a pending intent to move mail to a folder that does not exist. */
    expect(await db.select().from(folderState).where(eq(folderState.messageId, w.messageId))).toHaveLength(0);
    expect(await db.select().from(changeLog).where(eq(changeLog.entityId, w.messageId))).toHaveLength(0);
  });

  it("`trash` resolves to THIS mailbox's own discovered path", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, w.mailboxId));
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "trash" });
    expect(r.applied).toBe(true);
    if (!r.applied) throw new Error("unreachable");
    // The provider's own spelling, not a constant this codebase chose.
    expect(r.to).toBe("INBOX.Trash");
  });
});

describe("a forwarded delete records where the message came from", () => {
  /**
   * `folder_state.trashed_from` is the ONLY durable record of where a deleted message rode from,
   * and it is what a restore resolves its destination against. This applier never wrote it, so a
   * message deleted through a reader install restored to INBOX even while the folder it came from
   * still existed — and a forwarded move never CLEARED it, leaving a previous delete's origin for
   * the next delete to inherit. Both halves below; `MessageService.upsertDesired` is the door that
   * already had the rule.
   */
  it("a forwarded delete stores the origin, so a restore has somewhere to put it back", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, w.mailboxId));
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "trash" });
    expect(r.applied).toBe(true);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder).toBe("INBOX.Trash");
    expect(fs!.trashedFrom, "the origin a restore resolves against").toBe("ohmail/Screener");
  });

  it("a forwarded NON-Trash move CLEARS a previous delete's origin", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    // The row a previous delete left behind: this message has been in Trash once already.
    await db.insert(folderState).values({
      messageId: w.messageId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "worker", reconcileStatus: "clean", conflict: false, trashedFrom: "Archive/2026",
    });
    const r = await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "reads" });
    expect(r.applied).toBe(true);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.desiredFolder).toBe("ohmail/News");
    expect(
      fs!.trashedFrom,
      "a stale origin would send the NEXT delete's restore to the previous life's folder",
    ).toBeNull();
  });

  it("a delete of a message ALREADY in the Trash path remembers nothing", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, w.mailboxId));
    await db.insert(folderState).values({
      messageId: w.messageId, desiredFolder: "INBOX.Trash", observedFolder: "INBOX.Trash",
      lastSetBy: "worker", reconcileStatus: "clean", conflict: false,
    });
    await apply(db, w.mailboxId, { dedupKey: w.dedupKey, destination: "trash" });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs!.trashedFrom, "Trash as an origin would restore a message to where it already is").toBeNull();
  });
});

describe("account isolation", () => {
  it("a dedup key that exists on ANOTHER account's mailbox does not resolve", async () => {
    /* The uniqueness constraint is `(mailbox_id, dedup_key)`, so the mailbox predicate alone
       already identifies the row — the account predicate is what stops that being true only
       BECAUSE of an index definition somewhere else in the schema. Driven through a real second
       account rather than argued. */
    const db = await makeTestDb();
    const mine = await world(db);
    const OTHER = "00000000-0000-0000-0000-0000000000db";
    await db.insert(accounts).values({ id: OTHER, name: "other" });
    const [mb2] = await db.insert(mailboxes).values({
      accountId: OTHER, provider: "imap", address: `${randomUUID()}@other.test`,
    }).returning({ id: mailboxes.id });

    const r = await db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
      accountId: OTHER, mailboxId: mb2!.id,
      payload: { dedupKey: mine.dedupKey, destination: "inbox" },
      now: new Date(),
    }));
    expect(r).toEqual({ applied: false, refusal: "no_such_message" });
    expect(await db.select().from(folderState).where(eq(folderState.messageId, mine.messageId))).toHaveLength(0);
  });

  /**
   * THE CASE THAT TELLS THE TWO PREDICATES APART — added because a mutation asked for it.
   *
   * Deleting `eq(messages.accountId, accountId)` left every other case in this file GREEN, and the
   * reason is worth writing down rather than patching over: `messages_mailbox_dedup_uq` is
   * `(mailbox_id, dedup_key)`, so on any fixture where the mailbox belongs to the calling account
   * the mailbox predicate alone already identifies the row. The account clause is then a condition
   * whose contrary state no ordinary fixture reaches — and an untestable condition is one a later
   * reader takes for a guarantee it has never seen hold.
   *
   * The contrary state is reachable, and this is it: a caller naming ITS OWN account and ANOTHER
   * account's mailbox. Without the account predicate that read crosses the boundary and this
   * install writes a move intent against a message belonging to somebody else — the "Account isolation is absolute, and it binds staff too" invariant, and
   * a person's mail physically moved on their server by an account that does not own it.
   *
   * The drain guards the same thing upstream (`e.mailboxId !== rt.mailboxId` refuses `wrong_mailbox`
   * before an applier is reached), so this is defence in depth — which is exactly why it needs a
   * case that can watch it fail, rather than a comment claiming it is safe.
   */
  it("MY account id with ANOTHER account's mailbox id resolves NOTHING — the account predicate, watched", async () => {
    const db = await makeTestDb();
    const theirs = await world(db);          // lives on ACCT
    const MINE = "00000000-0000-0000-0000-0000000000dc";
    await db.insert(accounts).values({ id: MINE, name: "mine" });

    // I claim my own account and name THEIR mailbox, with THEIR dedup key.
    const r = await db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
      accountId: MINE, mailboxId: theirs.mailboxId,
      payload: { dedupKey: theirs.dedupKey, destination: "trash" },
      now: new Date(),
    }));
    expect(r, "a cross-account read resolved a message this account does not own")
      .toEqual({ applied: false, refusal: "no_such_message" });
    // …and nothing was written against their message.
    expect(await db.select().from(folderState).where(eq(folderState.messageId, theirs.messageId))).toHaveLength(0);
    expect(await db.select().from(changeLog).where(eq(changeLog.entityId, theirs.messageId))).toHaveLength(0);
  });

  it("the right account and the WRONG mailbox does not resolve either", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const [mb2] = await db.insert(mailboxes).values({
      accountId: ACCT, provider: "imap", address: `${randomUUID()}@example.test`,
    }).returning({ id: mailboxes.id });
    const r = await apply(db, mb2!.id, { dedupKey: w.dedupKey, destination: "inbox" });
    expect(r).toEqual({ applied: false, refusal: "no_such_message" });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `profile.update` — THE AWAY RESPONDER'S PILE SCOPE ON THE WIRE (ruling of 2026-09-10)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The scope (`piles`, mail 0096) did not travel. `ProfileAwayResponderPatch` carried six members,
 * this validator ignored an unknown key and the away write was a partial SET that never named the
 * column — so on a MIXED or READER account a save that changed the scope reached nothing, was
 * acked `applied`, and the pane showed the old value back.
 *
 * The APPLY half is measured where the rows are — `apps/worker/test/request-drain.test.ts` drives
 * it through the real drain on PGlite, and `profile-update-piles.pg.test.ts` does the same against
 * real Postgres on a private database, because the column is a `text[]` behind a containment CHECK
 * and that is the part worth reading off a server. What is measured HERE is the validator: the
 * refusal, the three states of the key, and the equality that keeps this package's copy of the
 * closed set honest.
 */
describe("a host that has lost the lease hands its pending moves over", () => {
  /**
   * THE WINDOW, AND WHY NEITHER GATE CLOSES IT. Another install takes the mailbox; until this
   * host's next lease poll its `organizer_role` still reads `organizer`, so a paired device's
   * forwarded move passes the role check, is recorded as a local `folder_state` intent and
   * answered 200. The drain then stands the mailbox down — correctly — and the intent is left
   * behind: a reader's reconciler skips it, and the install that CAN perform it has never heard
   * of it. The near side shows a move that never reaches the mail server.
   *
   * So the intent travels at the stand-down, as the `message.move` request the door would have
   * written. The five cases below are its whole contract.
   */
  const intents = (db: Awaited<ReturnType<typeof makeTestDb>>, mailboxId: string) =>
    db.select().from(organizerRequests).where(eq(organizerRequests.mailboxId, mailboxId));

  const handOver = (db: Awaited<ReturnType<typeof makeTestDb>>, mailboxId: string) =>
    db.transaction((tx) => exportPendingMovesOnStandDown(tx as unknown as Tx, {
      accountId: ACCT, mailboxId, now: new Date("2026-09-10T10:00:00.000Z"),
      mintId: () => randomUUID(),
    }));

  const pend = async (
    db: Awaited<ReturnType<typeof makeTestDb>>, messageId: string,
    desired: string, lastSetBy = "us",
  ): Promise<void> => {
    await db.insert(folderState).values({
      messageId, desiredFolder: desired, observedFolder: "ohmail/Screener",
      lastSetBy, reconcileStatus: "pending", conflict: false,
    });
  };

  it("writes one request per pending intent, naming the destination WORD", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await pend(db, w.messageId, "ohmail/News");

    const r = await handOver(db, w.mailboxId);
    expect(r).toEqual({ exported: 1, already: 0, unmappable: 0 });
    const rows = await intents(db, w.mailboxId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("message.move");
    expect(rows[0]!.state).toBe("pending");
    /* THE WORD AND THE SHARED NAME, which is what makes this readable on the other install: a raw
       IMAP path is refused by `validateMovePayload`, and the message is named by its dedup key
       because two stores have different primary keys for one message. */
    expect(rows[0]!.payload).toEqual({ dedupKey: w.dedupKey, destination: "reads" });
  });

  it("an intent written before the 0.22 rename (desired `ohmail/Reads`) still hands over as `reads`", async () => {
    // The legacy spelling through the CONSTANT so a vocabulary sweep cannot rewrite this input:
    // the case exists to prove the exporter canonicalizes a stored pre-rename row rather than
    // counting it unmappable and stranding the person's move at the stand-down.
    const db = await makeTestDb();
    const w = await world(db);
    await pend(db, w.messageId, LEGACY_NEWS_FOLDER);

    const r = await handOver(db, w.mailboxId);
    expect(r).toEqual({ exported: 1, already: 0, unmappable: 0 });
    const rows = await intents(db, w.mailboxId);
    expect(rows[0]!.payload).toEqual({ dedupKey: w.dedupKey, destination: "reads" });
  });

  it("the mailbox's OWN Trash path travels as `trash` — a delete is a move, and it travels too", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.update(mailboxes).set({ trashFolder: "INBOX.Trash" }).where(eq(mailboxes.id, w.mailboxId));
    // A delete tombstones the row locally; that tombstone is this install's, not the holder's, and
    // leaving the intent behind loses exactly the gesture that is hardest to notice.
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, w.messageId));
    await pend(db, w.messageId, "INBOX.Trash");

    expect(await handOver(db, w.mailboxId)).toEqual({ exported: 1, already: 0, unmappable: 0 });
    const rows = await intents(db, w.mailboxId);
    expect(rows[0]!.payload).toEqual({ dedupKey: w.dedupKey, destination: "trash" });
  });

  it("a desired folder no word covers is COUNTED, never sent as a raw path", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await pend(db, w.messageId, "Archive/2026/Q1");

    expect(await handOver(db, w.mailboxId)).toEqual({ exported: 0, already: 0, unmappable: 1 });
    expect(await intents(db, w.mailboxId), "a raw path would be an instruction to file outside ohmail's tree")
      .toHaveLength(0);
  });

  it("an intent already travelling is not sent twice — a repeated stand-down mints nothing", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await pend(db, w.messageId, "ohmail/News");

    expect((await handOver(db, w.mailboxId)).exported).toBe(1);
    expect(await handOver(db, w.mailboxId)).toEqual({ exported: 0, already: 1, unmappable: 0 });
    expect(await intents(db, w.mailboxId)).toHaveLength(1);
  });

  it("a row the WORKER left pending is not a decision to hand over", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await pend(db, w.messageId, "ohmail/News", "worker");

    expect(await handOver(db, w.mailboxId)).toEqual({ exported: 0, already: 0, unmappable: 0 });
    expect(await intents(db, w.mailboxId)).toHaveLength(0);
  });

  /* ── A REQUEST THAT IS OVER IS NOT ONE STILL TRAVELLING ──────────────────────────────────
   *
   * The "already travelling" read used to include `applied`, `refused` and `expired`, which are
   * the three states in which a request has FINISHED. So a message moved once, whose request the
   * holder applied, and then moved AGAIN during a takeover, read as one already handed over: the
   * new intent was counted as `already`, the host demoted, and the second move — a different
   * destination, decided later — never reached the mailbox. The case above cannot catch it,
   * because it repeats against a still-`pending` row. */
  it.each(["applied", "refused", "expired"])(
    "a LATER move is exported even though an earlier request for the same message is %s",
    async (state) => {
      const db = await makeTestDb();
      const w = await world(db);
      // The earlier request, over: the holder applied it (or refused it, or it aged out).
      await db.insert(organizerRequests).values({
        accountId: ACCT, mailboxId: w.mailboxId, kind: "message.move",
        payload: { dedupKey: w.dedupKey, destination: "reads" },
        decidedAt: new Date("2026-09-09T10:00:00.000Z"),
        state, resolvedAt: new Date("2026-09-09T10:00:05.000Z"),
      });
      // …and the NEW decision, for a different destination.
      await pend(db, w.messageId, "ohmail/Receipts");

      expect(await handOver(db, w.mailboxId)).toEqual({ exported: 1, already: 0, unmappable: 0 });
      const rows = await intents(db, w.mailboxId);
      expect(rows).toHaveLength(2);
      const fresh = rows.filter((r) => r.state === "pending");
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.payload).toEqual({ dedupKey: w.dedupKey, destination: "receipts" });
    },
  );

  it("a `sent` request IS still travelling, and is not sent a second time", async () => {
    // The positive control for the case above: narrowing the read to `pending` alone would have
    // re-minted every request that had already been appended to the mailbox.
    const db = await makeTestDb();
    const w = await world(db);
    await db.insert(organizerRequests).values({
      accountId: ACCT, mailboxId: w.mailboxId, kind: "message.move",
      payload: { dedupKey: w.dedupKey, destination: "reads" },
      decidedAt: new Date("2026-09-09T10:00:00.000Z"),
      state: "sent", sentAt: new Date("2026-09-09T10:00:01.000Z"),
    });
    await pend(db, w.messageId, "ohmail/News");

    expect(await handOver(db, w.mailboxId)).toEqual({ exported: 0, already: 1, unmappable: 0 });
    expect(await intents(db, w.mailboxId)).toHaveLength(1);
  });

  /* ── AND THE WALK REACHES THE END OF THE SET, NOT THE END OF ONE PAGE ────────────────────
   *
   * The read was one statement of `limit + 1` and the export took the first `limit` of it; the
   * remainder was reported as `more: true` and BOTH callers demoted anyway. So a mailbox holding
   * one intent past the page handed over all but one and stranded the last one on an install that
   * may not perform it, in front of the one install that could. The page below is deliberately
   * SMALL so the case is about the boundary rather than about a fixture one past a full page of messages. */
  it("hands over every intent past the page boundary, not the first page of them", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const [th] = await db.select({ id: threads.id }).from(threads).limit(1);
    const keys: string[] = [w.dedupKey];
    await pend(db, w.messageId, "ohmail/News");
    // Seven messages, all pending, so a page of three needs three reads and a short fourth.
    for (let i = 0; i < 6; i += 1) {
      const dedupKey = randomUUID().replace(/-/g, "");
      const [msg] = await db.insert(messages).values({
        accountId: ACCT, mailboxId: w.mailboxId, threadId: th!.id, dedupKey,
        messageIdHeader: `<${dedupKey}@example.test>`, bodyHash: randomUUID(),
        nativeLocator: { folder: "ohmail/Screener", uidvalidity: "1", uid: 5 + i },
      }).returning({ id: messages.id });
      await pend(db, msg!.id, "ohmail/Receipts");
      keys.push(dedupKey);
    }

    const r = await db.transaction((tx) => exportPendingMovesOnStandDown(tx as unknown as Tx, {
      accountId: ACCT, mailboxId: w.mailboxId, now: new Date("2026-09-10T10:00:00.000Z"),
      mintId: () => randomUUID(), limit: 3,
    }));
    expect(r).toEqual({ exported: 7, already: 0, unmappable: 0 });
    const rows = await intents(db, w.mailboxId);
    expect(rows).toHaveLength(7);
    /* EVERY MESSAGE, ONCE. A cursor that failed to advance would re-read page one for ever, and a
       cursor that skipped would leave a message out — the count alone cannot tell those apart. */
    const sent = rows.map((row) => (row.payload as { dedupKey: string }).dedupKey).sort();
    expect(sent).toEqual([...keys].sort());
  });
});

describe("the away responder's pile scope, validated at the boundary", () => {
  /**
   * THE DUPLICATION GUARD, and the reason it exists is in `AWAY_PILES`' own docblock:
   * `@trafficflow/core` depends on `@trafficflow/db`, never the reverse, so importing
   * `AWAY_ANSWERABLE_PILES` into `../src/request-apply.js` answers `TS2307` — measured, not
   * assumed. A TEST may import it (this package's tests already do), so the equality lives here,
   * exactly as it does for `MOVE_DESTINATIONS` above.
   *
   * Without it the two drift in the direction that fails silently: a third pile added to the core
   * set is a scope the settings control offers, the door sends and this validator then refuses as
   * `invalid_payload` — a save that appears to work and changes nothing on the one install whose
   * row the responder actually reads.
   */
  it("holds this package's closed set equal to core's `AWAY_ANSWERABLE_PILES`", () => {
    expect([...AWAY_PILES].sort()).toEqual([...AWAY_ANSWERABLE_PILES].sort());
  });

  const SIX = {
    enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day",
  };

  it("admits every member of the closed set, and collapses duplicates", () => {
    const wide = validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/News"] },
    });
    expect(wide!.awayResponder!.piles).toEqual(["INBOX", "ohmail/News"]);

    /* The value is a SET, the CHECK is containment and admits `{INBOX,INBOX}`, and the local door
       collapses duplicates — two write paths storing different rows for the same ask is a diff
       nobody can read. */
    const dupes = validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["ohmail/News", "INBOX", "ohmail/News"] },
    });
    expect(dupes!.awayResponder!.piles).toEqual(["ohmail/News", "INBOX"]);

    /* A pre-0.22 install's ask spells the News pile the old way (via the CONSTANT so a
       vocabulary sweep cannot rewrite this input): admitted, and stored CANONICAL — the widened
       CHECK admits both, and one spelling per new row is what keeps the diff readable. */
    const legacy = validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["INBOX", LEGACY_NEWS_FOLDER] },
    });
    expect(legacy!.awayResponder!.piles).toEqual(["INBOX", "ohmail/News"]);
  });

  it("REFUSES a non-member — the two folders no setting may reach, and the near-misses", () => {
    /* `ohmail/Screened` and `ohmail/Quarantine` are the durable "no" of a screening decision and
     * mail the pipeline judged hostile; neither is a pile anybody may tick. `ohmail/Ohbox` is the
     * folder that does not exist, and the rest are the shapes a hand-written request produces. */
    for (const bad of ["ohmail/Screened", "ohmail/Quarantine", "ohmail/Ohbox",
      "inbox", "reads", ""]) {
      expect(validateProfileUpdatePayload({ awayResponder: { ...SIX, piles: ["INBOX", bad] } }),
        `a non-member "${bad}" was admitted as a pile`).toBeNull();
    }
  });

  /**
   * THE SCREENER PILE NEEDS `everyone` (mail 0101), and this door has both halves in one record.
   *
   * Refused rather than filtered: a narrower scope acked `applied` would tell the person their
   * edit travelled while the responder answered a different set of mail. Receipts beside the same
   * narrow audience is the POSITIVE CONTROL — the rule is about one member, not about the audience.
   */
  it("REFUSES `ohmail/Screener` beside `screened_in`, and admits it beside `everyone`", () => {
    expect(validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/Screener"] },
    }), "the Screener pile was admitted beside the narrow audience").toBeNull();

    const wide = validateProfileUpdatePayload({
      awayResponder: { ...SIX, audience: "everyone", piles: ["INBOX", "ohmail/Screener"] },
    });
    expect(wide!.awayResponder!.piles).toEqual(["INBOX", "ohmail/Screener"]);

    const receipts = validateProfileUpdatePayload({
      awayResponder: { ...SIX, piles: ["INBOX", "ohmail/Receipts"] },
    });
    expect(receipts!.awayResponder!.piles).toEqual(["INBOX", "ohmail/Receipts"]);
  });

  it("REFUSES a `piles` that is not an array of strings", () => {
    for (const bad of ["INBOX", 1, true, null, {}, { 0: "INBOX" }, [1], [null], [["INBOX"]]]) {
      expect(validateProfileUpdatePayload({ awayResponder: { ...SIX, piles: bad } }),
        `a malformed piles ${JSON.stringify(bad)} was admitted`).toBeNull();
    }
  });

  it("an ABSENT `piles` is VALID — an install one release older must keep saving", () => {
    /* THE COMPATIBILITY ARM, and it is the one that decides whether this ruling may ship: a 0.15
     * install sends the six fields and no `piles`. Refusing that record would 400 its every
     * responder save, including the save that turns the responder OFF, which is the one save
     * nobody may be prevented from making. */
    const older = validateProfileUpdatePayload({ awayResponder: { ...SIX } });
    expect(older, "an older install's responder save was refused").not.toBeNull();
    expect(older!.awayResponder).toBeDefined();
    expect("piles" in older!.awayResponder!,
      "an absent scope became a present one, so the apply will overwrite the stored array")
      .toBe(false);
  });

  it("an EXPLICIT EMPTY list is kept, and is not read as an absent one", () => {
    /* "Answer nobody" is what unticking every box means, and the two states are different: absent
       leaves the stored scope alone, empty replaces it with silence. Collapsing them would make
       the one edit a person cannot make be the one that switches the responder quiet. */
    const quiet = validateProfileUpdatePayload({ awayResponder: { ...SIX, piles: [] } });
    expect(quiet!.awayResponder!.piles).toEqual([]);
    expect("piles" in quiet!.awayResponder!).toBe(true);
  });
});

/**
 * THE SIGNATURE'S MARKUP AT THE BOUNDARY (mail 0098) — ruling of 2026-09-10, "a signature's
 * formatting travels to the install that organizes the mailbox".
 *
 * The WRITE is measured against a real server in `profile-update-signature-html.pg.test.ts` and
 * the whole drain on PGlite in `apps/worker/test/request-drain.test.ts`. What is measured HERE is
 * the validator: the byte bound, the three states of the key, and the refusals.
 */
describe("the signature's markup, validated at the boundary", () => {
  it("admits a string and keeps it, and the bound is measured in BYTES", () => {
    const html = "<p><strong>Mila</strong></p>";
    expect(validateProfileUpdatePayload({ signatureHtml: html })!.signatureHtml).toBe(html);

    /* BYTES, not UTF-16 units, for the text half's reason: markup is the longer shape of the same
       value, and a multi-byte document is what a character count would let past a byte ceiling
       the record itself is measured against. One glyph short of the bound in characters, over it
       in bytes — so a `.length` check would admit this. */
    const multibyte = "\u2014".repeat(TRAVELLING_SIGNATURE_HTML_MAX_BYTES / 2);
    expect(multibyte.length).toBeLessThan(TRAVELLING_SIGNATURE_HTML_MAX_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(TRAVELLING_SIGNATURE_HTML_MAX_BYTES);
    expect(validateProfileUpdatePayload({ signatureHtml: multibyte }),
      "a multi-byte document over the byte bound was admitted — the bound is counting characters")
      .toBeNull();
  });

  it("REFUSES markup over the bound, and admits it AT the bound", () => {
    const over = "x".repeat(TRAVELLING_SIGNATURE_HTML_MAX_BYTES + 1);
    expect(validateProfileUpdatePayload({ signatureHtml: over }),
      "markup one byte over the bound was admitted").toBeNull();

    // The positive control: the bound admits, so the refusal above is the bound and not the arm.
    const at = "y".repeat(TRAVELLING_SIGNATURE_HTML_MAX_BYTES);
    expect(validateProfileUpdatePayload({ signatureHtml: at })!.signatureHtml).toBe(at);
  });

  it("REFUSES a `signatureHtml` that is neither a string nor null", () => {
    for (const bad of [1, 0, true, false, {}, [], ["<p></p>"], { html: "<p></p>" }]) {
      expect(validateProfileUpdatePayload({ signatureHtml: bad }),
        `a malformed signatureHtml ${JSON.stringify(bad)} was admitted`).toBeNull();
    }
  });

  it("`null` is KEPT and is not read as an absent key — a plain save clears the markup", () => {
    /* The two states are different and both reachable: absent leaves the column alone, `null`
       replaces it with "no formatting". Collapsing them would leave a holder appending markup the
       words no longer match, which is the drift the local door refuses outright. */
    const cleared = validateProfileUpdatePayload({ signature: "-- \nMila", signatureHtml: null });
    expect(cleared!.signatureHtml).toBeNull();
    expect("signatureHtml" in cleared!,
      "an explicit clear became an absent key, so the apply will leave stale markup").toBe(true);
  });

  it("an ABSENT `signatureHtml` is VALID — an install one release older must keep saving", () => {
    /* THE COMPATIBILITY ARM. A 0.15 install sends `signature` and no markup member; refusing that
       record would 400 its every signature save, and admitting it as `null` would strip
       formatting its own pane never showed. */
    const older = validateProfileUpdatePayload({ signature: "-- \nMila" });
    expect(older, "an older install's signature save was refused").not.toBeNull();
    expect("signatureHtml" in older!,
      "an absent markup key became a present one, so the apply will clear the column").toBe(false);
  });

  it("markup ALONE is a recognised payload — the record is not read as naming nothing", () => {
    /* `validateProfileUpdatePayload` refuses a payload naming no recognised field, and a save
       that only changed the formatting names exactly one. Without this the new key would validate
       and then be refused as an empty ask. */
    const only = validateProfileUpdatePayload({ signatureHtml: "<p><em>Mila</em></p>" });
    expect(only, "a markup-only payload was refused as naming nothing").not.toBeNull();
    expect(only!.signature).toBeUndefined();
  });
});

describe("the screening preference, validated at the boundary", () => {
  const screening = (v: unknown) => validateProfileUpdatePayload({ screeningPreference: v });

  it("the object is admitted key by key, and a partial names only what it carries", () => {
    expect(screening({ ohboxPolicy: "people_only", ohboxBar: "people", screenerAutoApply: true })!
      .screeningPreference).toEqual({ ohboxPolicy: "people_only", ohboxBar: "people", screenerAutoApply: true });
    expect(screening({ ohboxBar: null })!.screeningPreference).toEqual({ ohboxBar: null });
    expect(screening({ screenerAutoApply: false })!.screeningPreference).toEqual({ screenerAutoApply: false });
    expect(screening({ impersonationFiling: false })!.screeningPreference).toEqual({ impersonationFiling: false });
    expect(screening({ impersonationFiling: true, ohboxBar: null })!.screeningPreference)
      .toEqual({ impersonationFiling: true, ohboxBar: null });
    expect(screening({ ohboxPolicy: null })!.screeningPreference).toEqual({ ohboxPolicy: null });
  });

  it("the legacy posture string still maps to the posture, exactly as before", () => {
    expect(screening("people_only")!.screeningPreference).toEqual({ ohboxPolicy: "people_only" });
    expect(screening("people_and_replied")!.screeningPreference).toEqual({ ohboxPolicy: "people_and_replied" });
    expect(screening(null)!.screeningPreference).toEqual({ ohboxPolicy: null });
    expect(screening("everyone"), "a posture outside the pair was admitted").toBeNull();
  });

  it.each([
    ["a number", 42], ["an array", ["people_only"]], ["an empty object", {}],
    ["an unknown sub-key", { ohboxPolicy: "people_only", ohboxMood: "calm" }],
    ["a posture outside the pair", { ohboxPolicy: "everyone" }],
    ["a bar that is not text", { ohboxBar: 7 }],
    ["a bar one byte past the ceiling", { ohboxBar: "x".repeat(TRAVELLING_OHBOX_BAR_MAX_BYTES + 1) }],
    ["a bar holding a NUL", { ohboxBar: "a\u0000b" }],
    ["a switch that is not a boolean", { screenerAutoApply: "yes" }],
    ["an impersonation switch that is not a boolean", { impersonationFiling: "off" }],
  ])("%s refuses the record", (_label, v) => {
    expect(screening(v)).toBeNull();
  });

  it("a bar at the ceiling is admitted, measured in bytes", () => {
    const at = "\u00e9".repeat(TRAVELLING_OHBOX_BAR_MAX_BYTES / 2);
    expect(screening({ ohboxBar: at })!.screeningPreference).toEqual({ ohboxBar: at });
    expect(screening({ ohboxBar: `${at}x` })).toBeNull();
  });
});

/**
 * THE PRESS INSTANT ON THE ORGANIZER'S CLOCK (mail 0145). `payload.pressedAt` comes from another
 * install's clock, so it is clamped to this store's `now`: a reader ahead reads fresh and stamps
 * `now`, a reader behind by minutes is fresh and applies. Only an aged press is compared.
 */
describe("the reader's press instant, bounded by the organizer's clock", () => {
  const T = new Date("2026-09-07T10:00:00.000Z");
  const MIN = 60_000;
  const at = (db: Awaited<ReturnType<typeof makeTestDb>>, mailboxId: string, dedupKey: string, now: Date, pressedAt?: Date) =>
    db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
      accountId: ACCT, mailboxId, now, decidedAt: now,
      payload: validateMovePayload({ dedupKey, destination: "receipts", ...(pressedAt ? { pressedAt: pressedAt.toISOString() } : {}) })!,
    }));
  const stamp = async (db: Awaited<ReturnType<typeof makeTestDb>>, messageId: string) =>
    (await db.select({ d: folderState.decidedAt, f: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, messageId)))[0]!;

  it("a record written by a reader clock 10 min ahead, stating no press, is stamped no later than now", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    const r = await db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
      accountId: ACCT, mailboxId: w.mailboxId, now: T, decidedAt: new Date(T.getTime() + 10 * MIN),
      payload: validateMovePayload({ dedupKey: w.dedupKey, destination: "receipts" })!,
    }));
    expect(r.applied).toBe(true);
    expect((await stamp(db, w.messageId)).d!.getTime()).toBeLessThanOrEqual(T.getTime());
  });

  it("a press stamped 10 min in the future is applied and stamped no later than now; presses at +2 and +9 min still land", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    expect((await at(db, w.mailboxId, w.dedupKey, T, new Date(T.getTime() + 10 * MIN))).applied).toBe(true);
    expect((await stamp(db, w.messageId)).d!.getTime()).toBeLessThanOrEqual(T.getTime());
    for (const plus of [2, 9]) {
      const now = new Date(T.getTime() + plus * MIN);
      expect((await at(db, w.mailboxId, w.dedupKey, now, now)).applied, `+${plus} min`).toBe(true);
    }
  });

  it("a reader 90 s behind, pressing after the organizer's own move, is applied", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.insert(folderState).values({
      messageId: w.messageId, desiredFolder: "ohmail/News", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false, decidedAt: T,
    });
    const r = await at(db, w.mailboxId, w.dedupKey, new Date(T.getTime() + 60_000), new Date(T.getTime() + 30_000 - 90_000));
    expect(r.applied).toBe(true);
    expect((await stamp(db, w.messageId)).f).toBe("ohmail/Receipts");
  });

  it("an aged press is refused behind a newer placement and lands over an older one; an unreadable instant is invalid", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await db.insert(folderState).values({
      messageId: w.messageId, desiredFolder: "ohmail/News", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false, decidedAt: new Date(T.getTime() - 20 * 60 * MIN),
    });
    expect(await at(db, w.mailboxId, w.dedupKey, T, new Date(T.getTime() - 25 * 60 * MIN))).toEqual({ applied: false, refusal: "stale_press" });
    await db.update(folderState).set({ decidedAt: new Date(T.getTime() - 30 * 60 * MIN) }).where(eq(folderState.messageId, w.messageId));
    expect((await at(db, w.mailboxId, w.dedupKey, T, new Date(T.getTime() - 25 * 60 * MIN))).applied).toBe(true);
    expect(validateMovePayload({ dedupKey: w.dedupKey, destination: "receipts", pressedAt: "not a time" })).toBeNull();
    expect(validateMovePayload({ dedupKey: w.dedupKey, destination: "receipts" })).toEqual({ dedupKey: w.dedupKey, destination: "receipts" });
  });
});
