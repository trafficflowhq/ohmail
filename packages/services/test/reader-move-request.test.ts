import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  folderState, mailboxes, mailboxFolders, messages, organizerRequests,
  MOVE_DESTINATIONS, validateMovePayload, validateFolderMovePayload,
} from "@trafficflow/db";
import {
  formatRequest, REQUEST_PAYLOAD_MAX_BYTES,
} from "@trafficflow/core/adapters/organizer-lease";
import {
  messageService, type MoveRequestResult, type MoveResult,
} from "../src/index.js";
import { changesFor, makeCtx, seedMessage } from "./helpers.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A READER'S MOVE AND DELETE BECOME REQUESTS — `MessageService` (mail 0094)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mail 0083 refused both outright on a mailbox another install organizes. Ruling 6 replaces the
 * dead end with a `message.move` record the holder applies. The property this file exists to hold
 * is the "Organize-in-place" invariant (organize-in-place): the record is written and NOTHING ELSE IS — no
 * `folder_state`, no tombstone, no `change_log`. A version that also wrote locally would show the
 * person a message in its destination while the machine that actually holds the mailbox knew
 * nothing about it, which is the false state the whole ruling is about.
 *
 * PGlite: every case here is one connection writing rows and reading them back. The concurrency
 * halves (the drain racing the organizer's own move on one dedup key) are `.pg.test.ts` files on
 * the real box, where a sequential test of a concurrent property cannot pass by accident.
 */

/**
 * A mailbox this install READS. Defaults describe the holder ruling 6's control names: `held`, and
 * advertising `moves` — the capability `message.move` requires. Every argument is overridable
 * because the interesting cases are the ones where exactly one of them is different.
 */
async function readerCtx(over: {
  organizerState?: string | null;
  organizedByCapabilities?: string | null;
  organizedByKind?: string | null;
  organizedByName?: string | null;
  status?: string;
  trashFolder?: string | null;
} = {}) {
  const ctx = await makeCtx();
  await ctx.db.update(mailboxes).set({
    organizerRole: "reader",
    organizerState: over.organizerState === undefined ? "held" : over.organizerState,
    organizedByCapabilities:
      over.organizedByCapabilities === undefined ? "requests,moves" : over.organizedByCapabilities,
    organizedByKind: over.organizedByKind === undefined ? "local" : over.organizedByKind,
    organizedByName: over.organizedByName === undefined ? "mila-thinkpad" : over.organizedByName,
    ...(over.status === undefined ? {} : { status: over.status }),
    trashFolder: over.trashFolder === undefined ? "Trash" : over.trashFolder,
  }).where(eq(mailboxes.id, ctx.mailboxId));
  return ctx;
}

type Db = Awaited<ReturnType<typeof makeCtx>>["db"];

async function requestRows(db: Db, accountId: string) {
  return db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
}

async function dedupKeyOf(db: Db, messageId: string): Promise<string> {
  const [m] = await db.select({ k: messages.dedupKey }).from(messages).where(eq(messages.id, messageId));
  return m!.k;
}

describe("a reader's move becomes a request, and moves nothing here", () => {
  it("MOVE on a capable reader — exactly one message.move row, and the mirror row is untouched", async () => {
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const dedupKey = await dedupKeyOf(db, id);

    const result = await messageService.move(ctx, id, { folder: "ohmail/News" }) as MoveRequestResult;

    expect(result.pending).toBe(true);
    expect(result.holder).toEqual({ kind: "local", name: "mila-thinkpad", since: null });

    const rows = await requestRows(db, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.requestId, mailboxId, kind: "message.move", state: "pending" });
    // The SYMBOLIC word, not a path — and it is exactly what the applier's own validator accepts.
    expect(rows[0]!.payload).toEqual({ dedupKey, destination: "reads" });
    expect(validateMovePayload(rows[0]!.payload)).toEqual({ dedupKey, destination: "reads" });

    // ── INVARIANT #3: NOTHING MOVED HERE ──────────────────────────────────────────────────
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    // …and the DTO says so too. A DTO naming the destination would be the false state the ruling
    // exists to end — the person would see the message filed on a machine that filed nothing.
    expect(result.dto.folder).toBe("INBOX");
    // No change to emit: nothing in this store changed, so no client cursor may advance.
    expect(await changesFor(db, accountId)).toEqual([]);
  });

  it("DELETE on a capable reader — destination is the WORD trash, and nothing is tombstoned here", async () => {
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    const dedupKey = await dedupKeyOf(db, id);

    const result = await messageService.delete(ctx, id) as MoveRequestResult;
    expect(result.pending).toBe(true);

    const rows = await requestRows(db, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ dedupKey, destination: "trash" });

    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m!.deletedAt).toBeNull();
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    expect(await changesFor(db, accountId)).toEqual([]);
  });

  it("DELETE travels even when THIS install has never discovered a Trash folder", async () => {
    /* THE TRUE SENTENCE ABOUT THE WRONG MACHINE. `mailboxes.trash_folder` is discovered at connect
     * by the install that is CONNECTED; a reader's copy is routinely NULL. Asking it here would
     * refuse a perfectly deliverable request with `422 no_trash_folder` — a sentence about a server
     * this install is not the one talking to. The word travels unresolved; the organizer resolves
     * it, and answers `no_trash_folder` as a refusal only if IT has none. */
    const { db, accountId, mailboxId, ctx } = await readerCtx({ trashFolder: null });
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    const result = await messageService.delete(ctx, id) as MoveRequestResult;
    expect(result.pending).toBe(true);
    expect((await requestRows(db, accountId))[0]!.payload).toMatchObject({ destination: "trash" });
  });

  it("every canonical folder a client may name has a word, and every word round-trips", async () => {
    // The map is DERIVED from `MOVE_DESTINATIONS`, so this holds the derivation honest rather than
    // re-typing the pairs: a folder a client may move to that has no word would be a door that
    // throws for a legal request, and a word that resolves to a different folder would file mail
    // somewhere nobody chose.
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    for (const folder of ["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine", "ohmail/Screener"]) {
      const id = await seedMessage(db, accountId, mailboxId, { folder: folder === "INBOX" ? "ohmail/News" : "INBOX" });
      const r = await messageService.move(ctx, id, { folder }) as MoveRequestResult;
      const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, r.requestId));
      const word = (row!.payload as { destination: string }).destination;
      expect(MOVE_DESTINATIONS.get(word)).toBe(folder);
    }
  });

  it("a RAW IMAP PATH is never queued — the folder move's own word and this store's own list both stand first", async () => {
    // A holder without `folder_moves`: the path could only travel as a person's folder, which it cannot take.
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await expect(messageService.move(ctx, id, { folder: "INBOX.Junk" }))
      .rejects.toMatchObject({ code: "organized_elsewhere", httpStatus: 409, details: { reason: "organizer_outdated" } });
    // A holder with it: still nothing, because this mailbox lists no such folder of the person's own.
    await db.update(mailboxes).set({ organizedByCapabilities: "requests,moves,folder_moves" }).where(eq(mailboxes.id, mailboxId));
    await expect(messageService.move(ctx, id, { folder: "INBOX.Junk" }))
      .rejects.toMatchObject({ code: "no_such_folder", httpStatus: 422 });
    // Nothing queued. A record naming a path would be an instruction to file a person's mail
    // outside ohmail's tree, where nothing in this product would ever look for it again.
    expect(await requestRows(db, accountId)).toEqual([]);
  });

  it("the door's byte ceiling is the CYCLE's own ceiling, measured against the cycle itself", async () => {
    /* THE DOOR RE-IMPLEMENTS THE CYCLE'S ENCODING, AND HAS TO — `b64urlEncode` is private to
     * `organizer-lease.ts` and `packages/services` could not reach it even if it were not. So the
     * duplication is held honest here the way `request-apply.test.ts` holds `MOVE_DESTINATIONS`
     * equal to `Destination` and `screener-apply.test.ts` holds `DECIDABLE_FOLDERS` equal to
     * `effectForDestination`: not by comparing the two encoders, which would only prove they were
     * copied, but by driving the REAL `formatRequest` and asserting it succeeds on exactly the
     * payloads this door admits and throws on exactly the ones it refuses.
     *
     * Without this the two can drift a byte apart and the failure is invisible: the door accepts,
     * the cycle throws on every pass, and the row expires a day later as never sent. */
    const { db, accountId, mailboxId, ctx } = await readerCtx();

    /* SWEPT ACROSS THE BOUNDARY RATHER THAN PROBED AT IT, and the reason is worth recording
     * because the first version of this test could not fail.
     *
     * `base64url` length is `ceil(4n/3)`, so it advances by 1, 1, 2 as the payload grows: for this
     * payload shape the encoded lengths near the ceiling run … 4094, 4095, 4096, 4098 …, and 4097
     * IS NOT REACHABLE. A test that probed only "the largest that fits" and "the smallest that
     * does not" therefore stayed GREEN with the door's ceiling shifted by one byte — the mutation
     * was a no-op, not a passing guard. Sweeping every reachable length across the line asserts
     * the two verdicts agree everywhere they can be compared, and makes the granularity a stated
     * fact instead of a silent assumption. The drift this actually has to catch is a WRONG UNIT
     * (counting the JSON's own bytes rather than the encoded ones), which is large and shows up
     * across the whole window. */
    const wire = (dedupKey: string) => formatRequest({
      requestId: "00000000-0000-4000-8000-000000000000",
      kind: "message.move", mailboxId, installId: "i", organizerKind: "local",
      decidedAt: new Date("2026-09-07T00:00:00.000Z"),
      payload: { dedupKey, destination: "reads" }, key: "k",
    });
    const cycleAccepts = (dedupKey: string) => {
      try { wire(dedupKey); return true; } catch { return false; }
    };

    // Find the first length the CYCLE refuses, then walk a window either side of it.
    let first = 1;
    while (cycleAccepts("k".repeat(first))) first += 1;
    const window: number[] = [];
    for (let k = first - 5; k <= first + 5; k += 1) window.push(k);
    // The window straddles the line — without both kinds present the sweep would be vacuous.
    expect(window.some((k) => cycleAccepts("k".repeat(k)))).toBe(true);
    expect(window.some((k) => !cycleAccepts("k".repeat(k)))).toBe(true);

    for (const k of window) {
      const dedupKey = "k".repeat(k);
      const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
      await db.update(messages).set({ dedupKey }).where(eq(messages.id, id));
      const doorAdmits = await messageService.move(ctx, id, { folder: "ohmail/News" })
        .then(() => true, (e: unknown) => {
          // Only the ceiling refusal counts as "the door said no to the SIZE".
          expect(e).toMatchObject({ code: "validation_failed" });
          return false;
        });
      expect(
        doorAdmits,
        `dedupKey of ${k} chars: the door and the reader's cycle must agree about whether this `
        + "payload can travel",
      ).toBe(cycleAccepts(dedupKey));
    }
  });

  it("a payload the reader's cycle could never append is refused at the door, not queued", async () => {
    /* `formatRequest` THROWS over `REQUEST_PAYLOAD_MAX_BYTES`, and it runs in the CYCLE — long
     * after this door answered. Without the door's own check the row is accepted, fails to append
     * every pass for a day, and expires as `outstanding_requests_never_sent`: a spinner for
     * something that was never going to travel, with every guard green. */
    const { db, accountId, mailboxId, ctx } = await readerCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await db.update(messages).set({ dedupKey: `mid:${"x".repeat(4000)}` }).where(eq(messages.id, id));

    await expect(messageService.move(ctx, id, { folder: "ohmail/News" }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    expect(await requestRows(db, accountId)).toEqual([]);
  });
});

describe("a reader whose holder cannot take the request is refused, and queues nothing", () => {
  it("a 0.14.1 holder — held, advertising `requests` ALONE — is 409 organizer_outdated for a move", async () => {
    /* RULING 6'S CONTROL, and it is green against the organizer this build actually ships:
     * `ORGANIZER_CAPABILITIES` is `[CAPABILITY_REQUESTS]` until the widening lands, so every real
     * holder in the field answers exactly this. Queueing a move for it would be a decision nobody
     * is ever going to take. */
    const { db, accountId, mailboxId, ctx } = await readerCtx({ organizedByCapabilities: "requests" });
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    await expect(messageService.move(ctx, id, { folder: "ohmail/News" })).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { reason: "organizer_outdated", by: { kind: "local", name: "mila-thinkpad" } },
    });
    await expect(messageService.delete(ctx, id)).rejects.toMatchObject({
      code: "organized_elsewhere", details: { reason: "organizer_outdated" },
    });
    expect(await requestRows(db, accountId)).toEqual([]);
    // And the refusal wrote nothing either — the 0083 property, unchanged.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
  });

  it("a holder that STOPPED is 409 no_organizer however its capabilities read", async () => {
    // Its lease lapsed, so nothing organizes the mailbox: "update ohmail on it" would name a
    // machine that stopped. This case pinned `organizer_outdated` until the one decider.
    const { db, accountId, mailboxId, ctx } = await readerCtx({ organizerState: "stopped" });
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await expect(messageService.move(ctx, id, { folder: "ohmail/News" })).rejects.toMatchObject({
      code: "organized_elsewhere", details: { reason: "no_organizer" },
    });
    expect(await requestRows(db, accountId)).toEqual([]);
  });

  it("no holder at all is 409 no_organizer — a different sentence, so it travels", async () => {
    const { db, accountId, mailboxId, ctx } = await readerCtx({
      organizerState: null, organizedByCapabilities: null, organizedByKind: null, organizedByName: null,
    });
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await expect(messageService.move(ctx, id, { folder: "ohmail/News" })).rejects.toMatchObject({
      code: "organized_elsewhere", details: { reason: "no_organizer", by: { kind: null } },
    });
    expect(await requestRows(db, accountId)).toEqual([]);
  });

  it("a TOMBSTONED mailbox is 404, never a 409 naming a holder that holds nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await readerCtx({ status: "disabled" });
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await expect(messageService.move(ctx, id, { folder: "ohmail/News" }))
      .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    expect(await requestRows(db, accountId)).toEqual([]);
  });
});

describe("the organizer's own path is unchanged — the positive control every refusal needs", () => {
  it("MOVE on an organizer row writes desired state and emits the move change, as it always did", async () => {
    // Without this, every case above proves only that moving is broken. `makeCtx` leaves the
    // schema default `organizer_role = 'organizer'`.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    const result = await messageService.move(ctx, id, { folder: "ohmail/News" }) as MoveResult;
    expect("pending" in result).toBe(false);
    expect(result.dto.folder).toBe("ohmail/News");
    expect(typeof result.seq).toBe("number");

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us" });
    expect(await requestRows(db, accountId)).toEqual([]);
    expect((await changesFor(db, accountId)).map((c) => c.op)).toContain("move");
  });

  it("DELETE on an organizer row still tombstones and still refuses when there is no Trash", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: "Trash" }).where(eq(mailboxes.id, mailboxId));
    const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });

    const result = await messageService.delete(ctx, id) as MoveResult;
    expect("pending" in result).toBe(false);
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    expect(m!.deletedAt).not.toBeNull();

    // …and the 422 an ORGANIZER gets is still the true sentence for an organizer: it IS the
    // machine that discovered (or failed to discover) the folder.
    await db.update(mailboxes).set({ trashFolder: null }).where(eq(mailboxes.id, mailboxId));
    const other = await seedMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await expect(messageService.delete(ctx, other))
      .rejects.toMatchObject({ code: "no_trash_folder", httpStatus: 422 });
  });
});

/**
 * A READER'S MOVE INTO ONE OF THE PERSON'S OWN FOLDERS travels as `message.file`, which the holder
 * must advertise (`folder_moves`): a holder without it refuses at this door and nothing is queued.
 * The folder is checked against THIS store's list first; the organizer checks its own again.
 */
describe("a reader's move into a person's own folder becomes a message.file request, or nothing", () => {
  async function withFolder(caps = "requests,moves,folder_moves") {
    const r = await readerCtx({ organizedByCapabilities: caps });
    await r.db.insert(mailboxFolders).values({ mailboxId: r.mailboxId, accountId: r.accountId, folder: "Clients/Acme" });
    const id = await seedMessage(r.db, r.accountId, r.mailboxId, { folder: "INBOX" });
    return { ...r, id };
  }

  it("a holder advertising moves but not folder_moves is 409 organizer_outdated, naming it; nothing is queued", async () => {
    const { db, accountId, ctx, id } = await withFolder("requests,moves");
    await expect(messageService.move(ctx, id, { folder: "Clients/Acme" })).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { reason: "organizer_outdated", by: { kind: "local", name: "mila-thinkpad" } },
    });
    expect(await requestRows(db, accountId)).toEqual([]);
  });

  it("a holder that stopped is 409 no_organizer; nothing is queued", async () => {
    const r = await withFolder();
    await r.db.update(mailboxes).set({ organizerState: "stopped" }).where(eq(mailboxes.id, r.mailboxId));
    await expect(messageService.move(r.ctx, r.id, { folder: "Clients/Acme" }))
      .rejects.toMatchObject({ code: "organized_elsewhere", details: { reason: "no_organizer" } });
    expect(await requestRows(r.db, r.accountId)).toEqual([]);
  });

  it("a folder this store does not list, or not the person's own, is 422 here; nothing is queued", async () => {
    const { db, accountId, ctx, id } = await withFolder();
    for (const folder of ["Clients/Gone", "clients/acme", "Trash"]) {
      await expect(messageService.move(ctx, id, { folder }), folder).rejects.toMatchObject({ code: "no_such_folder", httpStatus: 422 });
    }
    expect(await requestRows(db, accountId)).toEqual([]);
  });

  it("with the word and the folder listed: 202 and exactly one message.file row, as the organizer's validator reads it; nothing moved here", async () => {
    const { db, accountId, mailboxId, ctx, id } = await withFolder();
    const dedupKey = await dedupKeyOf(db, id);
    const floor = new Date("2026-07-27T12:00:00.000Z");
    const result = await messageService.move({ ...ctx, pressFloor: floor, pressAged: true }, id, { folder: "Clients/Acme" }) as MoveRequestResult;
    expect(result.pending).toBe(true);
    const rows = await requestRows(db, accountId);
    expect(rows.map((r) => [r.kind, r.mailboxId, r.state])).toEqual([["message.file", mailboxId, "pending"]]);
    expect(rows[0]!.payload).toEqual({ dedupKey, folder: "Clients/Acme", pressedAt: floor.toISOString() });
    expect(validateFolderMovePayload(rows[0]!.payload)).toEqual({ dedupKey, folder: "Clients/Acme", pressedAt: floor });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", observedFolder: "INBOX" });
    expect(result.dto.folder).toBe("INBOX");
    expect(await changesFor(db, accountId)).toEqual([]);
  });
});
