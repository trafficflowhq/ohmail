import { describe, it, expect } from "vitest";
import { ImapAdapter, EpochUnknownError, MessageGoneError, StoreRefusedError, StoreUnansweredError, makeRef } from "../../src/adapters/imap.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ── EVERY LOCATOR-CONSUMING COMMAND ENFORCES THE REF'S UIDVALIDITY ──────────────────────────
 *
 * A UID names a message only within one UIDVALIDITY epoch. A folder
 * that a provider purges and recreates — which providers do on their own schedule, with no
 * attacker and no concurrency involved — gets a new epoch and re-issues its UIDs from the bottom,
 * so a ref committed under epoch V addresses a DIFFERENT message under V′.
 *
 * The mechanism to refuse that already existed: `move`'s `requireEpoch`, written for the Junk
 * rescue. It was OPT-IN and the rescue was its only caller, so the ORGANIZER — the one thing in
 * this system that writes to the user's real mailbox — ran outside it:
 *
 *  · `move` was called by `sync.ts#fileOne` without the flag;
 *  · `moveMany` reduced every locator to a bare UID (`wanted.set(parseRef(loc.ref).uid, loc)`)
 *    and never compared an epoch at all;
 *  · `setFlags` parsed the ref and kept only the UID;
 *  · `fetchPart` and `fetchRaw` did the same, and their bytes go to a requester or into a
 *    message's own row.
 *
 * The guard is `ImapAdapter#assertLocatorEpoch` / `#locatorEpochStale`, it is unconditional, and
 * these are its cases. **Both directions on every one**: the stale ref must refuse BEFORE any
 * command that addresses the UID, and the matching ref must still act.
 *
 * MUTATIONS WATCHED RED AND RESTORED (2026-08-31):
 *  · `locatorEpochStale` → `return false` ⇒ 8 cases red (every refusal case in this file);
 *  · drop the step-3 recheck in `moveMany` ⇒ the mid-batch flip case red, and it goes red by
 *    OBSERVING THE WRITE — `messageMove` appears in `writes` — not merely by a changed return;
 *  · drop the mixed-epoch decline ⇒ the mixed-epoch case red;
 *  · `current === "0"` escape removed ⇒ the unreporting-server case red (that escape is GONE now;
 *    see the two cases at the bottom of this file and the guard's own docblock).
 *
 * MUTATIONS WATCHED RED AND RESTORED (2026-09-12, every restore verified by `cmp`):
 *  · `epochVerdict` → `return "usable"` when either side is unknown ⇒ 10 red across this file
 *    and `epoch.test.ts` — the ref-side fail-open, in one line;
 *  · `epochOf` → admit zero as a known epoch ⇒ 6 red;
 *  · the pre-fix `moveMany` shape — skip unknown members from the epoch set AND take a KNOWN
 *    member as the representative ⇒ 2 red, and they go red by OBSERVING THE WRITE (`messageMove`
 *    in `writes`), not by a changed return.
 *
 * AND ONE MUTATION THAT CAME BACK GREEN, which is a question, not a pass. Changing only the
 * chunk's `if (!e.known) return empty` to `continue` reddens nothing: the representative is now
 * `locators[0]` rather than the first KNOWN member, so the under-lock `locatorEpochStale` check
 * refuses the same chunk one step later. Two mechanisms, so no single-line mutation can isolate
 * either — the mutation above breaks the pair, which is what these two cases actually pin.
 *
 * THE RULE THIS FILE USED TO STATE, AND WHY IT IS GONE. Until 0.18 a `0:uid` ref was "usable":
 * a locator that claims no epoch cannot contradict one, so the command ran. That is the fail-open
 * — `0` was the guard's own word for "unknown", so the one ref that proved nothing was the one
 * ref nothing was asked of. Nothing persists such a ref: `epochsObserved` reads the epoch off
 * locators the adapter minted from the server's own answer, and `soleEpochOf`/`buildCursor`
 * carry a FOLDER cursor, never a `native_locator`. The only zero-epoch refs are the `0:0`
 * placeholders a NULL locator column takes — which name no message — and those now refuse by
 * name instead of issuing `UID FETCH 0`.
 */

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

interface FakeOpts {
  /** Epoch per server path. A function is called per lock acquisition, so it can flip mid-command. */
  epochs: Record<string, bigint | ((nth: number) => bigint)>;
  /** UIDs the source folder answers a FETCH for. */
  present?: number[];
  /** COPYUID/MOVEUID map the server reports. */
  uidMap?: Map<number, number>;
  /** Report `uidValidity: null` on the mailbox object — a driver that does not answer it. */
  silentEpoch?: boolean;
  /** Report `uidValidity: 0` — invalid per RFC 3501, and once this guard's own "none" sentinel. */
  zeroEpoch?: boolean;
  /** UIDs the DESTINATION returns for a Message-ID search — the move's candidate set. */
  dstCandidates?: number[];
  /** Drop the MOVE capability, forcing the COPY + EXPUNGE path (a fourth source lock). */
  noMove?: boolean;
}

function makeClient(opts: FakeOpts) {
  const writes: string[] = [];
  const reads: string[] = [];
  const locks = new Map<string, number>();
  const present = opts.present ?? [2];
  const client = {
    writes,
    reads,
    usable: true,
    capabilities: new Map<string, boolean>(
      opts.noMove
        ? [["IDLE", true], ["UIDPLUS", true]]
        : [["IDLE", true], ["UIDPLUS", true], ["MOVE", true]],
    ),
    mailbox: false as unknown,
    async list() {
      return Object.keys(opts.epochs).map((path) => ({
        path, name: path, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async getMailboxLock(path: string) {
      const nth = (locks.get(path) ?? 0);
      locks.set(path, nth + 1);
      const spec = opts.epochs[path] ?? 1n;
      const v = typeof spec === "function" ? spec(nth) : spec;
      client.mailbox = {
        path, exists: present.length,
        uidValidity: opts.silentEpoch ? null : opts.zeroEpoch ? 0n : v,
      };
      return { path, release() { /* nothing */ } };
    },
    async search() {
      reads.push("search");
      // A destination candidate sharing the Message-ID — what sends `move` down the
      // `sourceFingerprintOf` branch (the THIRD source selection).
      return (opts.dstCandidates ?? []) as number[];
    },
    async fetchOne(range: string, query?: { source?: boolean }) {
      // The `source` flag is what tells a body read apart from an existence probe, and the body
      // read at the third source selection is exactly what FINDING 1 was about.
      reads.push(`fetchOne ${range}${query?.source ? " +source" : ""}@${String((client.mailbox as { path?: string } | false) && (client.mailbox as { path: string }).path)}`);
      if (!present.includes(Number(range))) return null;
      return {
        uid: Number(range),
        envelope: { messageId: `<m${range}@x>` },
        source: query?.source ? Buffer.from(`raw-${range}`) : undefined,
      };
    },
    async fetchAll(range: string) {
      reads.push(`fetchAll ${range}`);
      return present.map((uid) => ({ uid, envelope: { messageId: `<m${uid}@x>` } }));
    },
    async messageMove(uids: number[] | number, to: string) {
      writes.push(`messageMove ${JSON.stringify(uids)} → ${to}`);
      const list = Array.isArray(uids) ? uids : [uids];
      return {
        uidValidity: 100n,
        uidMap: opts.uidMap ?? new Map(list.map((u) => [u, u + 1000])),
      };
    },
    async messageCopy(uids: number[], to: string) {
      writes.push(`messageCopy ${JSON.stringify(uids)} → ${to}`);
      return { uidValidity: 100n, uidMap: new Map(uids.map((u) => [u, u + 1000])) };
    },
    async messageDelete(uids: number[]) { writes.push(`messageDelete ${JSON.stringify(uids)}`); return true; },
    async messageFlagsAdd(uids: number[]) { writes.push(`flagsAdd ${JSON.stringify(uids)}`); return true; },
    async messageFlagsRemove(uids: number[]) { writes.push(`flagsRemove ${JSON.stringify(uids)}`); return true; },
    /**
     * `fetchPart`'s bytes — and, since the move's destination pre-check switched to a byte-capped
     * `download`, the CANDIDATE probe's bytes too.
     *
     * The presence rule is the load-bearing line. `fetchOne` has always answered nothing for a uid
     * outside `present`, and that is this harness's way of saying "the candidate at the destination
     * is not ours". This method handed out the same `bytes` for ANY uid, so once the candidate
     * probe started coming through here a stranger's UID fingerprinted EQUAL to the source — two
     * unparseable buffers yield the same empty parse — and the move ADOPTED it, answering
     * `ref: "1:50"` instead of the copy's own locator. Measured, not reasoned: the case went red.
     */
    async download(range: string) {
      reads.push(`download ${range}`);
      if (!present.includes(Number(range))) return null;
      async function* content() { yield Buffer.from("bytes"); }
      return { content: content(), meta: { contentType: "text/plain", filename: "f.txt", expectedSize: 5 } };
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

async function adapterOver(opts: FakeOpts) {
  const client = makeClient(opts);
  const adapter = new ImapAdapter(cfg, { client });
  await adapter.connect();
  return { adapter, client };
}

const LOC = (folder: string, epoch: number, uid: number) => ({ folder, ref: makeRef(epoch, uid) });

describe("setFlags — `UID STORE` never runs against a recycled UID", () => {
  it("REFUSES a stale-epoch ref before the probe, so no flag is written", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await expect(adapter.setFlags(LOC("Junk", 7, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(MessageGoneError);
    // Nothing was even read: the guard sits ahead of the existence probe, so a mailbox whose
    // folder was recycled costs one lock and no command.
    expect(client.reads).toEqual([]);
    expect(client.writes).toEqual([]);
  });

  it("ACTS on a matching epoch — the healthy path is untouched", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await adapter.setFlags(LOC("Junk", 9, 2), { seen: true }, FIXTURE_DOOR);
    expect(client.writes).toEqual(["flagsAdd [2]"]);
  });

  it("a `false` answer on a usable connection is a refusal, not a gone message", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    client.messageFlagsAdd = async () => false;
    await expect(adapter.setFlags(LOC("Junk", 9, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(StoreRefusedError);
  });

  it("a `false` answer after the connection closed is an unanswered STORE: it may have landed", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    client.messageFlagsRemove = async () => { client.usable = false; return false; };
    await expect(adapter.setFlags(LOC("Junk", 9, 2), { seen: false }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(StoreUnansweredError);
  });

  it("a probe that finds no message is still the one gone signal, and nothing is stored", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n }, present: [] });
    await expect(adapter.setFlags(LOC("Junk", 9, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(MessageGoneError);
    expect(client.writes).toEqual([]);
  });

  it("marking UNREAD is guarded identically — the destructive direction is not special-cased", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await expect(adapter.setFlags(LOC("Junk", 7, 2), { seen: false }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(MessageGoneError);
    expect(client.writes).toEqual([]);
  });
});

describe("moveMany — the batch declines rather than moving fifty wrong messages", () => {
  const chunk = (epoch: number) => [LOC("Junk", epoch, 2), LOC("Junk", epoch, 3)];

  it("a stale epoch DECLINES the batch (`outcome: \"declined\"`) and issues no command", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n }, present: [2, 3] });
    const res = await adapter.moveMany(chunk(7), "INBOX", FIXTURE_DOOR);
    // Declined, not thrown: the caller re-files the chunk one message at a time and `move`'s own
    // guard then gives each row its own honest verdict. See `sync.ts#fileChunk`.
    expect(res.outcome).toBe("declined");
    expect(res.moved.size).toBe(0);
    expect(client.writes).toEqual([]);
    // And it declined BEFORE the existence probe, not after.
    expect(client.reads).toEqual([]);
  });

  it("a matching epoch still BATCHES — the fast path is intact", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n }, present: [2, 3] });
    const res = await adapter.moveMany(chunk(9), "INBOX", FIXTURE_DOOR);
    expect(res.outcome).toBe("batched");
    expect(res.moved.size).toBe(2);
    expect(client.writes).toEqual(["messageMove [2,3] → INBOX"]);
  });

  it("a chunk assembled from TWO epochs is declined — one UID set cannot be right about both", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n }, present: [2, 3] });
    const res = await adapter.moveMany([LOC("Junk", 9, 2), LOC("Junk", 7, 3)], "INBOX", FIXTURE_DOOR);
    expect(res.outcome).toBe("declined");
    expect(client.writes).toEqual([]);
  });

  describe("AN UNKNOWN-EPOCH MEMBER DECLINES THE CHUNK — every ordering", () => {
    /**
     * `UID MOVE 10,11,12` addresses whatever the SELECTed folder currently numbers, so the batch
     * is sound only if EVERY member is proved to belong to the epoch the server is reporting. A
     * `0:uid` member proves nothing about itself, and the old precheck filtered exactly those
     * members OUT before looking — so a chunk whose members all claimed no epoch was moved with
     * no comparison performed at all, and a chunk with one real epoch behind a `0:` member had
     * that member relocated on the strength of somebody else's agreement.
     *
     * All three orderings are asserted because the defect was ORDER-DEPENDENT.
     */
    it("unknown FIRST, stale real epoch behind it ⇒ declined, nothing moved", async () => {
      const { adapter, client } = await adapterOver({ epochs: { Junk: 8n, INBOX: 1n }, present: [10, 11, 12] });
      const res = await adapter.moveMany(
        [LOC("Junk", 0, 10), LOC("Junk", 7, 11), LOC("Junk", 7, 12)], "INBOX", FIXTURE_DOOR,
      );
      expect(res.outcome).toBe("declined");
      expect(client.writes).toEqual([]);
    });

    it("unknown first, MATCHING real epoch behind it ⇒ DECLINED — the agreement is not about it", async () => {
      // Until 0.18 this batched, and the `0:10` member rode along on `8:11`'s agreement with the
      // folder. The per-message path now gives uid 10 its own verdict, which is a refusal.
      const { adapter, client } = await adapterOver({ epochs: { Junk: 8n, INBOX: 1n }, present: [10, 11] });
      const res = await adapter.moveMany([LOC("Junk", 0, 10), LOC("Junk", 8, 11)], "INBOX", FIXTURE_DOOR);
      expect(res.outcome).toBe("declined");
      expect(client.writes).toEqual([]);
    });

    it("an ALL-UNKNOWN chunk DECLINES — nothing to compare is not a licence to move", async () => {
      const { adapter, client } = await adapterOver({ epochs: { Junk: 8n, INBOX: 1n }, present: [10, 11] });
      const res = await adapter.moveMany([LOC("Junk", 0, 10), LOC("Junk", 0, 11)], "INBOX", FIXTURE_DOOR);
      expect(res.outcome).toBe("declined");
      expect(client.writes).toEqual([]);
    });

    it("POSITIVE CONTROL — an all-KNOWN, all-agreeing chunk still batches in one command", async () => {
      const { adapter, client } = await adapterOver({ epochs: { Junk: 8n, INBOX: 1n }, present: [10, 11] });
      const res = await adapter.moveMany([LOC("Junk", 8, 10), LOC("Junk", 8, 11)], "INBOX", FIXTURE_DOOR);
      expect(res.outcome).toBe("batched");
      expect(client.writes).toEqual(["messageMove [10,11] → INBOX"]);
    });
  });

  it("AN EPOCH FLIP BETWEEN THE PROBE AND THE WRITE refuses — the step-1 check is not enough", async () => {
    // The source lock is released while the destination is inspected, and imapflow re-selects the
    // mailbox on each re-acquisition. A folder recycled in exactly that window would pass step 1.
    // Third acquisition of `Junk` is step 3 (step 1, then the destination look does not touch
    // Junk… so: 0 = step 1, 1 = step 3). Flip on the second.
    const { adapter, client } = await adapterOver({
      epochs: { Junk: (nth: number) => (nth === 0 ? 9n : 11n), INBOX: 1n },
      present: [2, 3],
    });
    const res = await adapter.moveMany(chunk(9), "INBOX", FIXTURE_DOOR);
    expect(res.outcome).toBe("declined");
    // THE LOAD-BEARING ASSERTION: no `UID MOVE` was issued. A test that only checked `batched`
    // would stay green if the write happened and the bookkeeping was skipped.
    expect(client.writes).toEqual([]);
    // …and it did get as far as the probe, so the refusal really is the step-3 recheck.
    expect(client.reads.some((r) => r.startsWith("fetchAll"))).toBe(true);
  });
});

describe("move — one message, and the guard holds at every source lock", () => {
  it("REFUSES a stale-epoch ref with no command issued", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n } });
    await expect(adapter.move(LOC("Junk", 7, 2), "INBOX", FIXTURE_DOOR)).rejects.toBeInstanceOf(MessageGoneError);
    expect(client.reads).toEqual([]);
    expect(client.writes).toEqual([]);
  });

  /* THE TWO READINGS OF ONE CLASS, told apart for the reconciler: only an absence at the ref's own
     epoch may close a filing; a stale epoch may name a message that is still there, renumbered. */
  it("a stale epoch is NOT an absence", async () => {
    const { adapter } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n } });
    await expect(adapter.move(LOC("Junk", 7, 2), "INBOX", FIXTURE_DOOR))
      .rejects.toMatchObject({ name: "MessageGoneError", absent: false });
  });

  it("a matching epoch with no such UID IS an absence, and nothing is written", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n }, present: [] });
    await expect(adapter.move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR))
      .rejects.toMatchObject({ name: "MessageGoneError", absent: true });
    expect(client.writes).toEqual([]);
  });

  it("THE FINAL EXPUNGE LOCK is guarded too — a COPY-path flip at step 5 deletes nothing", async () => {
    /**
     * On a server without MOVE the source is COPYied and then expunged under a FOURTH source
     * lock, and that expunge is the destructive half: a flip confined to it would delete a
     * message the user never touched while their own message stayed put. No other case in this
     * file reaches that lock, so without this one the step-5 guard could be deleted and the suite
     * would stay green — which is the regression codex's round-2 FINDING 6 named.
     *
     * Lock order on this path: Junk#0 (probe) → INBOX#0 (look) → Junk#1 (COPY) → INBOX#1 (the
     * post-copy look, only when COPYUID is absent) → Junk#2 (the EXPUNGE). UIDPLUS is on here, so
     * the second look is skipped and the expunge is Junk#2.
     */
    const { adapter, client } = await adapterOver({
      epochs: { Junk: (nth: number) => (nth === 2 ? 11n : 9n), INBOX: 1n },
      present: [2],
      noMove: true,
    });
    await expect(adapter.move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR)).rejects.toBeInstanceOf(MessageGoneError);
    // The COPY landed (it is what step 3 does on this server) and the EXPUNGE did not — which is
    // the safe direction: a duplicate, never a deletion of a stranger. The next reconcile pass
    // converges it exactly as it converges a crash in the same place.
    expect(client.writes).toEqual(["messageCopy [2] → INBOX"]);
  });

  it("MOVES on a matching epoch, and answers the destination locator", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n, INBOX: 1n } });
    const out = await adapter.move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR);
    expect(out).toEqual({ folder: "INBOX", ref: "100:1002" });
    expect(client.writes).toEqual(["messageMove [2] → INBOX"]);
  });
});

describe("the on-demand body reads — a recycled UID must not hand over a stranger's bytes", () => {
  it("`fetchPart` refuses a stale-epoch locator before downloading anything", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await expect(adapter.fetchPart(LOC("Junk", 7, 2), "2"))
      .rejects.toBeInstanceOf(MessageGoneError);
    expect(client.reads).toEqual([]);
  });

  it("`fetchPart` serves a matching epoch", async () => {
    const { adapter } = await adapterOver({ epochs: { Junk: 9n } });
    const part = await adapter.fetchPart(LOC("Junk", 9, 2), "2");
    expect(Buffer.from(part.body).toString()).toBe("bytes");
  });

  it("`fetchRaw` refuses a stale-epoch locator — its callers WRITE these bytes into a row", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await expect(adapter.fetchRaw(LOC("Junk", 7, 2)))
      .rejects.toBeInstanceOf(MessageGoneError);
    expect(client.reads).toEqual([]);
  });

  it("`fetchRaw` serves a matching epoch", async () => {
    const { adapter } = await adapterOver({ epochs: { Junk: 9n } });
    expect(Buffer.from(await adapter.fetchRaw(LOC("Junk", 9, 2))).toString()).toBe("bytes");
  });
});

describe("the `\"0\"` escapes are GONE — an unknown epoch on EITHER side refuses", () => {
  it("a `0:uid` REF refuses: an epoch nobody named cannot license a command", async () => {
    // the ref-side half. This asserted the opposite until 0.18, on the
    // premise that the drain persists such refs — it does not (see this file's header). The
    // refusal is `EpochUnknownError`, which `classifyIngestFault` reads as INFRASTRUCTURE: the
    // row is held and re-read, never written off, so nothing is stranded.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await expect(adapter.setFlags(LOC("Junk", 0, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(EpochUnknownError);
    expect(client.writes).toEqual([]);
  });

  it("…and a `0:0` NULL-locator placeholder refuses rather than issuing `UID FETCH 0`", async () => {
    // The shape a NULL `native_locator` column takes in `rowToStored`, `approval-service` and
    // `screener-service`. It names no message; it used to reach the server anyway.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await expect(adapter.fetchRaw(LOC("Junk", 0, 0)))
      .rejects.toBeInstanceOf(EpochUnknownError);
    expect(client.reads).toEqual([]);
    expect(client.writes).toEqual([]);
  });

  it("a ref whose epoch is the STRING `undefined` refuses — it is unknown, not a contradiction", async () => {
    // `makeRef(mb.uidValidity, uid)` on a silent server mints `"undefined:2"`. Compared as a
    // string that is unequal to every epoch, so it read as STALE — and stale is terminal
    // (`gone.ts`), which writes off mail that is still on the server.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    const err = await adapter.setFlags(
      { folder: "Junk", ref: `${String(undefined)}:2` }, { seen: true }, FIXTURE_DOOR,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EpochUnknownError);
    expect(err).not.toBeInstanceOf(MessageGoneError);
    expect(client.writes).toEqual([]);
  });

  it("a server that reports NO `uidValidity` REFUSES, and writes nothing", async () => {
    // This case asserted the opposite until 0.17: with no epoch to compare,
    // the guard was disabled for every locator-addressed command on the folder, so a flag, a move
    // or a body read landed on whatever message now wears the UID. RFC 3501 requires the field on
    // a successful SELECT, so its absence is UNKNOWN and unknown identity fails closed.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n }, silentEpoch: true });
    await expect(adapter.setFlags(LOC("Junk", 7, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(EpochUnknownError);
    expect(client.writes).toEqual([]);
  });

  it("…and it is NOT a gone locator: the terminal reading would write off mail that is there", async () => {
    // `gone.ts` licenses a TERMINAL reading of `MessageGoneError` on positive evidence, and
    // `sync.ts#fileOne` voids the filing on one. A silent server is the mailbox's condition, so
    // the class has to be distinguishable — this is the assertion that keeps it so.
    const { adapter } = await adapterOver({ epochs: { Junk: 9n }, silentEpoch: true });
    const err = await adapter.setFlags(LOC("Junk", 7, 2), { seen: true }, FIXTURE_DOOR).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(MessageGoneError);
    expect((err as { code?: string }).code).toBe("EIMAPEPOCHUNKNOWN");
  });

  it("a server reporting UIDVALIDITY ZERO refuses too — an epoch WAS given and was ignored", async () => {
    // the worse half: zero was this guard's own sentinel for
    // "the client cannot say", so a server answering zero was indistinguishable from one
    // answering nothing and the comparison passed.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n }, zeroEpoch: true });
    await expect(adapter.setFlags(LOC("Junk", 7, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(EpochUnknownError);
    expect(client.writes).toEqual([]);
  });

  it("POSITIVE CONTROL — a server that DOES report its epoch still acts", async () => {
    // The refusals above are worth nothing without this: a guard whose every case is a refusal has
    // no evidence it admits the ordinary server.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n } });
    await adapter.setFlags(LOC("Junk", 9, 2), { seen: true }, FIXTURE_DOOR);
    expect(client.writes).toEqual(["flagsAdd [2]"]);
  });

  it("BOTH sides unknown refuses — two unanswered questions are not one answer", async () => {
    // The zero-epoch conflation in its purest form: a `0:` ref against a server that
    // names no epoch. Read as strings, `"0"` and the absence used to be the same value and the
    // comparison passed itself.
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n }, silentEpoch: true });
    await expect(adapter.setFlags(LOC("Junk", 0, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(EpochUnknownError);
    expect(client.writes).toEqual([]);
  });

  it("…and a server reporting ZERO against a `0:` ref refuses too, not matches", async () => {
    const { adapter, client } = await adapterOver({ epochs: { Junk: 9n }, zeroEpoch: true });
    await expect(adapter.setFlags(LOC("Junk", 0, 2), { seen: true }, FIXTURE_DOOR))
      .rejects.toBeInstanceOf(EpochUnknownError);
    expect(client.writes).toEqual([]);
  });
});

describe("move — the THIRD source selection is guarded too (`sourceFingerprintOf`)", () => {
  /**
   * `move` takes the source lock three times on the no-match/UIDPLUS-with-candidates path:
   * step 1 (the probe), `sourceFingerprintOf` (the body read the destination look asked for),
   * and step 3 (the write). imapflow re-selects the mailbox on every acquisition, so each is its
   * own epoch window.
   *
   * The flip here is on the SECOND acquisition ONLY, and that is what makes the test
   * discriminating: step 1 and step 3 both see the ref's own epoch, so every other guard in this
   * method passes. Without the check inside `sourceFingerprintOf` the move reads a STRANGER'S
   * bytes, fingerprints them, and decides adopt-or-refuse on that — and the docblock's claim that
   * the guard runs "under every source lock" is simply untrue.
   */
  it("an epoch flip confined to the fingerprint read refuses, and reads no stranger's body", async () => {
    const { adapter, client } = await adapterOver({
      // Junk: 9 at step 1, 11 at the fingerprint read, 9 again at the write.
      epochs: { Junk: (nth: number) => (nth === 1 ? 11n : 9n), INBOX: 1n },
      present: [2],
      dstCandidates: [50],
    });
    await expect(adapter.move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR)).rejects.toBeInstanceOf(MessageGoneError);
    expect(client.writes).toEqual([]);
    // THE LOAD-BEARING ASSERTION: no body was pulled from the source under the wrong epoch.
    // A `batched`-style check on the return value alone would stay green on the defect, because
    // the later step-3 guard refuses either way — the difference is only visible in the reads.
    expect(client.reads.filter((r) => r.includes("+source") && r.includes("@Junk"))).toEqual([]);
  });

  it("…and with the epoch steady the fingerprint read DOES happen — the branch is really reached", async () => {
    const { adapter, client } = await adapterOver({
      epochs: { Junk: 9n, INBOX: 1n }, present: [2], dstCandidates: [50],
    });
    // The destination holds a candidate that merely SHARES the Message-ID; its bytes differ, so
    // it is not ours and does not block the move — the file's own rule, "a stranger who names a
    // Message-ID the mailbox already holds does not get to block a move". So this SUCCEEDS…
    expect(await adapter.move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR)).toEqual({ folder: "INBOX", ref: "100:1002" });
    // …and it got there THROUGH the fingerprint read, which is what makes the case above a real
    // discriminator rather than a branch that is never taken.
    expect(client.reads.filter((r) => r.includes("+source") && r.includes("@Junk"))).toHaveLength(1);
  });
});
