import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, rules, contacts, organizerRequests, insertOrganizerRequest,
  accountSettings, awayResponders, changeLog, TRAVELLING_SIGNATURE_HTML_MAX_BYTES, ruleCreatePayload, type RuleKey,
} from "@trafficflow/db";
import {
  formatRequest, formatAck, acksIn, parseRequestEnvelope, deriveRequestKey, decodeRequestPayload,
  isMalformedRequest,
  REQUEST_PROTOCOL, REQUEST_PAYLOAD_MAX_BYTES, classifyMetaRecord, MetaEnumRefusedError, metaFolderFullSentence,
  RequestUnavailableError, META_RECORDS_MAX_PER_FETCH, META_HOLDER_RESERVE_RECORDS, META_ENUM_RECORDS_MAX, ackSweepCutoff,
  type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage, type RequestEnvelope,
  type MetaRecordsList,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  applyMetaRequests, driveOutstandingRequests, settleOwnOutstandingRequests,
  readerOutcomeFor, hasRequestOrganizerIo, hasRequestReaderIo,
  REQUEST_DRAIN_MAX_PER_CYCLE, REQUEST_STALE_AFTER_MS, REQUEST_STALE_MUST_NOT_EXCEED_MS,
} from "../src/request-drain.js";

/** The drain refuses a runtime with no install, so every fixture states one. */
const TEST_INSTALL = "test-install";

const ACCT = "00000000-0000-0000-0000-0000000000f1";
const NOW = new Date("2026-09-03T12:00:00.000Z");

/**
 * ONE IN-MEMORY FOLDER, seen through BOTH role objects — the same `ohmail/_meta` two installs
 * share in production. The reader half can look and append; the organizer half can look, ack and
 * remove. Keeping them as two objects over one store is what lets a test drain what the other
 * appended without ever handing the reader an expunge.
 */
/**
 * The return type is INFERRED, and that is the point: the hand-written one named four of the
 * object's fields, so every case reaching for `order`, `ackDates` or `uidValidity` — the
 * four this double exists to expose — was writing against a type that did not have them. The
 * ratchet counted them and nobody read the count. Inference keeps the double and its declaration
 * one thing.
 */
function fakeMeta() {
  const store = new Map<number, string>();
  let nextUid = 1;
  const self = {
    store,
    listCalls: 0,
    /** Which of `sweep` / `compact` / `list` happened, in order — the ONE thing this case is about. */
    order: [] as string[],
    /** How many records the compaction reports moving, and whether it refuses instead. */
    compactMoves: 0,
    compactThrows: false,
    /** INTERNALDATE per uid, because the sweep asks the server by date rather than parsing. */
    ackDates: new Map<number, Date>(),
    /** The folder's uid generation; bump it to model a mailbox deleted and recreated. */
    uidValidity: 1_000,
    reader: {} as RequestReaderIo,
    organizer: {} as RequestOrganizerIo,
  };
  /* THE ONE DOOR, as the drains receive it: every request and ack in the folder with its count and
   * bytes, or — past the enumeration's ceiling — a `RequestUnavailableError` carrying `over_ceiling`
   * with the enumeration's refusal as its cause, exactly as `makeMetaRecordsList` wraps it. */
  const list = async (): Promise<MetaRecordsList> => {
    self.listCalls += 1;
    self.order.push("list");
    const all: RawMetaMessage[] = [...store.entries()].map(([uid, raw]) => ({ ref: uid, raw }));
    if (all.length > META_ENUM_RECORDS_MAX) {
      const cause = new MetaEnumRefusedError("over_ceiling", { rows: 0, total: all.length, ceiling: META_ENUM_RECORDS_MAX });
      throw new RequestUnavailableError(metaFolderFullSentence(all.length, META_ENUM_RECORDS_MAX), { op: "list_requests", code: "over_ceiling", cause });
    }
    const kept = all.filter((r) => {
      const kind = classifyMetaRecord(r.raw);
      return kind === "request" || kind === "ack";
    });
    return { records: kept, count: all.length, bytes: all.reduce((n, r) => n + Buffer.byteLength(r.raw, "utf8"), 0) };
  };
  self.reader = {
    listMetaRecords: list,
    async append(raw: string): Promise<void> { store.set(nextUid++, raw); },
  };
  self.organizer = {
    listMetaRecords: list,
    /* The folder reports its generation, as a real one does; a case that wants a renumbering
     * says so by changing it. */
    uidValidity(): number { return self.uidValidity; },
    async ack(raw: string): Promise<void> { store.set(nextUid++, raw); },
    async remove(refs: readonly unknown[]): Promise<void> {
      for (const r of refs) if (typeof r === "number") store.delete(r);
    },
    /**
     * The ack sweep, by HEADER and DATE, which the server answers without a read. Modelled as the
     * real one is: it never fetches, so nothing about a folder being over the ceiling can refuse
     * it — which is the whole reason it moved ahead of the bounded read.
     */
    async sweepStaleAcks(before: Date): Promise<number> {
      self.order.push("sweep");
      /* ── THE SAME CUTOFF PRODUCTION USES, FROM THE SAME FUNCTION ─────────────────────────
       *
       * This compared the raw instant, which is MORE PERMISSIVE than the server: production
       * floors the cutoff to the start of its UTC day, so acknowledgements filed on that day
       * SURVIVE a sweep this fake would have deleted. A guard written against the permissive
       * version proves a recovery that does not happen — and a double kinder than production is
       * the third time on this branch that the fixture, not the code, decided a result.
       *
       * Imported rather than reimplemented, for the reason the module gives where it is
       * exported: two implementations of "which acknowledgements are old enough" disagree
       * eventually, and the disagreement is invisible until it matters. */
      const cutoff = ackSweepCutoff(before);
      let removed = 0;
      for (const [uid, raw] of [...store.entries()]) {
        if (!raw.includes("X-Ohmail-Ack:")) continue;
        const at = self.ackDates.get(uid);
        if (at === undefined || !(at < cutoff)) continue;
        store.delete(uid);
        removed += 1;
      }
      return removed;
    },
    /**
     * The compaction, modelled as the two facts a caller can actually observe: WHEN it ran, and
     * that a folder it could not move is a throw rather than a quiet zero. What it does to uids is
     * measured where uids can be placed (`packages/core`); this double exists so the ORDER can be.
     */
    async compactMeta(_now: Date): Promise<number> {
      self.order.push("compact");
      if (self.compactThrows) throw new Error("the folder could not be compacted");
      return self.compactMoves;
    },
  };
  return self;
}

function organizerAdapter(m: ReturnType<typeof fakeMeta>): MailboxAdapter {
  return { requestOrganizerIo: () => m.organizer } as unknown as MailboxAdapter;
}
function readerAdapter(m: ReturnType<typeof fakeMeta>): MailboxAdapter {
  return { requestReaderIo: () => m.reader } as unknown as MailboxAdapter;
}

type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

async function seedHeldMessage(db: TestDb, mailboxId: string, from: string): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: ACCT, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    subject: "s", fromAddress: from, unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

async function seedMailbox(db: TestDb): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
  }).returning({ id: mailboxes.id });
  return mb!.id;
}

/**
 * THE MAILBOX'S KEY, derived exactly as every install derives it: HKDF over the password, salted
 * with the address. Nothing is stored, so there is nothing to seed — two installs agree because
 * they hold the same credential, which is the whole point of the derivation.
 */
const PASSWORD = "correct-horse-battery-staple-password-password";
const ADDRESS = "person@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: PASSWORD }, address: ADDRESS })!;
/** A DIFFERENT password — what an install that does not share the credential would derive. */
const OTHER_KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "a-different-password" }, address: ADDRESS })!;

const noopLog = (): void => undefined;

function decideRecord(o: {
  requestId?: string; mailboxId: string; key: string; address?: string;
  decidedAt?: Date; protocol?: number; kind?: string; installId?: string;
}): string {
  return formatRequest({
    requestId: o.requestId ?? randomUUID(),
    kind: (o.kind ?? "screener.decide") as "screener.decide",
    mailboxId: o.mailboxId,
    installId: o.installId ?? "reader-install",
    organizerKind: "local",
    decidedAt: o.decidedAt ?? NOW,
    ...(o.protocol !== undefined ? { protocol: o.protocol } : {}),
    payload: {
      scope: "sender", address: o.address ?? "person@example.com",
      appliedFolder: "INBOX", decision: "yes",
    },
    key: o.key,
  });
}

/** A signed `message.move` record — mail 0094's kind, through the same wire format. */
function moveRecord(o: {
  requestId?: string; mailboxId: string; key: string;
  dedupKey: string; destination: string; decidedAt?: Date; pressedAt?: Date;
}): string {
  return formatRequest({
    requestId: o.requestId ?? randomUUID(),
    kind: "message.move",
    mailboxId: o.mailboxId,
    installId: "reader-install",
    organizerKind: "local",
    decidedAt: o.decidedAt ?? NOW,
    payload: {
      dedupKey: o.dedupKey, destination: o.destination,
      ...(o.pressedAt ? { pressedAt: o.pressedAt.toISOString() } : {}),
    },
    key: o.key,
  });
}

async function ruleCount(db: TestDb): Promise<number> {
  return (await db.select().from(rules).where(eq(rules.accountId, ACCT))).length;
}

describe("the adapter capability probes", () => {
  it("tell the two roles apart structurally", () => {
    const m = fakeMeta();
    expect(hasRequestOrganizerIo(organizerAdapter(m))).toBe(true);
    expect(hasRequestReaderIo(organizerAdapter(m))).toBe(false);
    expect(hasRequestReaderIo(readerAdapter(m))).toBe(true);
    expect(hasRequestOrganizerIo(readerAdapter(m))).toBe(false);
    expect(hasRequestOrganizerIo({} as MailboxAdapter)).toBe(false);
  });
});

describe("applyMetaRequests — the happy path", () => {
  it("applies a signed screener.decide: the rule lands, the record goes, an applied ack is left", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const key = KEY;
    const m = fakeMeta();
    const requestId = randomUUID();
    await m.reader.append(decideRecord({ requestId, mailboxId, key }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });
    expect(await ruleCount(db)).toBe(1);

    // The request is gone and an ACK naming it is in its place.
    const left = [...m.store.values()];
    expect(left.filter((raw) => raw.includes("X-Ohmail-Request: 1"))).toHaveLength(0);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), key);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.requestId).toBe(requestId);
    expect(acks[0]!.outcome).toBe("applied");
    // No wait of its own: 1.4 s as a rule, 2.9 s once on a loaded CI VM, 32 s under 10% of a CPU.
  }, 60_000);

  /** ONE fetch per drain — the folder's three record types come off a single read. */
  it("reads the folder once per drain", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const m = fakeMeta();
    await m.reader.append(decideRecord({ mailboxId, key }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(m.listCalls).toBe(1);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SECURITY CASES — each one is a way a stranger's message could have moved somebody's mail
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("applyMetaRequests — origin authentication", () => {
  /**
   * THE CASE THE WHOLE KEY EXISTS FOR. A record with no signature is exactly what anyone with
   * APPEND rights on the mailbox can write, and before 0090 it was applied. ZERO writes is the
   * assertion that matters — not merely "not applied", but nothing at all in `rules`.
   */
  it("a FORGED record with no signature is refused, and writes NOTHING", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const key = KEY;
    const m = fakeMeta();

    // Built by hand the way a forger would: every header a genuine record has, and no signature.
    const signed = decideRecord({ mailboxId, key });
    const forged = signed.split("\r\n").filter((l) => !l.startsWith("X-Ohmail-Request-Sig")).join("\r\n");
    await m.reader.append(forged);

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(0);
    expect(result.refused).toBe(1);
    expect(await ruleCount(db)).toBe(0);
    expect((await db.select().from(contacts).where(eq(contacts.accountId, ACCT))).length).toBe(0);

    // AND NOTHING IS WRITTEN BACK EITHER. A record that does not verify did not come from a
    // holder of the key, so there is no reader waiting on an answer — and one ack per forged
    // record would let a flooder make this organizer APPEND once for every message it appends.
    // The record is removed; the folder gains nothing.
    expect(acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), key)).toEqual([]);
    expect(m.store.size).toBe(0);
  });

  it("a record signed under a DIFFERENT key is refused unauthenticated", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const m = fakeMeta();
    await m.reader.append(decideRecord({ mailboxId, key: OTHER_KEY }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    expect(await ruleCount(db)).toBe(0);
  });

  /**
   * ROTATION uses the same path as a forgery, deliberately: after a password change the old key
   * stops verifying, and records signed with it are refused rather than applied. The person's
   * reader expires the row and can decide again.
   */
  it("a record signed before a PASSWORD CHANGE stops verifying afterwards", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const m = fakeMeta();
    // Written while the mailbox password was still the old one.
    await m.reader.append(decideRecord({ mailboxId, key: OTHER_KEY }));

    // The organizer now derives from the CURRENT password. Nothing was revoked and nothing
    // rotated: the key simply is not the same one any more, which is what a password change means.
    const result = await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    expect(await ruleCount(db)).toBe(0);
  });

  /** No key at all: the account has no request channel, so the drain does not even look. */
  it("an OAuth mailbox — no shared secret — applies nothing and does not read the folder", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const m = fakeMeta();
    // A record that WOULD verify if a key existed — it must still be ignored.
    await m.reader.append(decideRecord({ mailboxId, key: KEY }));
    m.listCalls = 0;

    const result = await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: null }, NOW, noopLog);
    expect(result).toEqual({ applied: 0, refused: 0, deferred: 0, standing: 0 });
    expect(m.listCalls).toBe(0);
    expect(await ruleCount(db)).toBe(0);
    expect(m.store.size).toBe(1); // left standing, not destroyed
  });
});

describe("applyMetaRequests — the record is bound to its content and its mailbox", () => {
  /**
   * SAME ID, DIFFERENT PAYLOAD. The id is a header a forger chooses, so reusing a genuine id used
   * to make the second record a silent no-op — which meant the impostor could SPEND the genuine
   * record's key and the real decision would never be applied. It is a `conflict` now, and the
   * genuine record still lands.
   */
  it("a reused id with different content is refused CONFLICT, and the genuine record still applies", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "genuine@example.com");
    await seedHeldMessage(db, mailboxId, "impostor@example.com");
    const key = KEY;
    const sharedId = randomUUID();

    // Cycle one: the genuine decision.
    const m1 = fakeMeta();
    await m1.reader.append(decideRecord({ requestId: sharedId, mailboxId, key, address: "genuine@example.com" }));
    const r1 = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m1), requestKey: KEY }, NOW, noopLog);
    expect(r1.applied).toBe(1);

    // Cycle two: the SAME id, a different address — properly signed, because an attacker who can
    // append can also copy a header. Only the content comparison catches this.
    const m2 = fakeMeta();
    await m2.reader.append(decideRecord({ requestId: sharedId, mailboxId, key, address: "impostor@example.com" }));
    const r2 = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m2), requestKey: KEY }, NOW, noopLog);
    expect(r2.refused).toBe(1);
    expect(r2.applied).toBe(0);

    const all = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(all).toHaveLength(1);
    expect(all[0]!.match).toBe("genuine@example.com");

    const acks = acksIn([...m2.store.entries()].map(([ref, raw]) => ({ ref, raw })), key);
    expect(acks[0]!.reason).toBe("conflict");
  });

  /**
   * A record lifted out of ANOTHER mailbox's folder verifies (same account, same key) and must
   * still be refused — the mailbox is inside the signed body precisely so it cannot be moved.
   */
  it("a record naming ANOTHER mailbox is refused", async () => {
    const db = await makeTestDb();
    const mine = await seedMailbox(db);
    const theirs = await seedMailbox(db);
    await seedHeldMessage(db, mine, "person@example.com");
    const key = KEY;
    const m = fakeMeta();
    await m.reader.append(decideRecord({ mailboxId: theirs, key }));

    const result = await applyMetaRequests(db, { mailboxId: mine, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    expect(await ruleCount(db)).toBe(0);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), key);
    expect(acks[0]!.reason).toBe("wrong_mailbox");
  });

  /** The same record, drained by the mailbox it actually names, applies. The check is the id, not paranoia. */
  it("and the same record applies against the mailbox it does name", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const key = KEY;
    const m = fakeMeta();
    await m.reader.append(decideRecord({ mailboxId, key }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(1);
  });
});

describe("applyMetaRequests — bounds", () => {
  /**
   * A folder anyone can append to must not turn one cycle into unbounded work. Past the cap in records,
   * the cap is handled oldest-first, the rest deferred to the next pass.
   */
  it("handles at most REQUEST_DRAIN_MAX_PER_CYCLE records and defers the rest", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const m = fakeMeta();
    const total = REQUEST_DRAIN_MAX_PER_CYCLE + 1;
    for (let i = 0; i < total; i++) {
      // Unsigned, so each is refused cheaply — this test is about the COUNT, not the outcome.
      const signed = decideRecord({ mailboxId, key, decidedAt: new Date(NOW.getTime() + i) });
      await m.reader.append(signed.split("\r\n").filter((l) => !l.startsWith("X-Ohmail-Request-Sig")).join("\r\n"));
    }

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(REQUEST_DRAIN_MAX_PER_CYCLE);
    expect(result.deferred).toBe(1);
  });

  /**
   * Refused BEFORE decoding, so a hostile record cannot buy an attacker-chosen amount of base64
   * and JSON parsing. Asserted through the drain rather than only at the parser, because it is the
   * drain's ordering that has to keep the bound.
   */
  it("an oversized payload header is refused without being decoded", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const m = fakeMeta();
    const oversized = [
      "X-Ohmail-Request: 1",
      `X-Ohmail-Request-Id: ${randomUUID()}`,
      "X-Ohmail-Request-Kind: screener.decide",
      `X-Ohmail-Request-Mailbox: ${mailboxId}`,
      "X-Ohmail-Install-Id: them",
      "X-Ohmail-Organizer-Kind: local",
      `X-Ohmail-Decided-At: ${NOW.toISOString()}`,
      "X-Ohmail-Protocol: 1",
      `X-Ohmail-Request-Payload: ${"A".repeat(REQUEST_PAYLOAD_MAX_BYTES + 1)}`,
      "X-Ohmail-Request-Sig: whatever",
      "", "body", "",
    ].join("\r\n");
    await m.reader.append(oversized);

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    expect(await ruleCount(db)).toBe(0);
  });

  /**
   * ONE STORE+EXPUNGE for the whole batch. A flooded folder must not become one IMAP command per
   * hostile record, so the removals are collected and issued once.
   */
  it("batches every refusal into a single remove call", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const m = fakeMeta();
    let removeCalls = 0;
    const realRemove = m.organizer.remove;
    m.organizer.remove = async (refs) => { removeCalls += 1; return realRemove(refs); };
    for (let i = 0; i < 5; i++) {
      const signed = decideRecord({ mailboxId, key, decidedAt: new Date(NOW.getTime() + i) });
      await m.reader.append(signed.split("\r\n").filter((l) => !l.startsWith("X-Ohmail-Request-Sig")).join("\r\n"));
    }
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(5);
    expect(removeCalls).toBe(1);
  });
});

describe("applyMetaRequests — what is LEFT STANDING rather than refused", () => {
  /**
   * A future protocol and an unknown kind are not invalid, they are UNREADABLE BY THIS BUILD. A
   * newer reader may be talking to an older organizer, and the record becomes applicable the
   * moment that organizer updates. Refusing would be a lie and expunging would lose a decision a
   * person made.
   */
  it("a record from a FUTURE protocol is left standing — not applied, not refused, not expunged", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const m = fakeMeta();
    await m.reader.append(decideRecord({ mailboxId, key, protocol: REQUEST_PROTOCOL + 1 }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 0, refused: 0, deferred: 0, standing: 1 });
    expect(m.store.size).toBe(1);
    expect(await ruleCount(db)).toBe(0);
  });

  /* ══ mail 0094 — THE DISPATCH TABLE ══════════════════════════════════════════════════════
   *
   * The kind gate stopped being `if (kind !== "screener.decide")` and became a table. These cases
   * are what makes the table's two halves observable: an entry carries the record out, and an
   * ABSENT entry still leaves it standing rather than refusing or expunging it.
   */
  it("mail 0094 — a signed message.move is applied: desired state written, record gone, applied ack", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const messageId = await seedHeldMessage(db, mailboxId, "person@example.com");
    const [row] = await db.select({ dedupKey: messages.dedupKey }).from(messages).where(eq(messages.id, messageId));
    const requestId = randomUUID();
    const m = fakeMeta();
    await m.reader.append(moveRecord({ requestId, mailboxId, key: KEY, dedupKey: row!.dedupKey, destination: "reads" }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.desiredFolder).toBe("ohmail/News");
    expect(fs!.reconcileStatus).toBe("pending");
    // The worker's own truth, untouched by an applier that performed no physical move.
    expect(fs!.observedFolder).toBe("ohmail/Screener");

    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.requestId).toBe(requestId);
    expect(acks[0]!.outcome).toBe("applied");
  });

  it("mail 0094 — a move for a message this organizer does not hold is REFUSED BY NAME", async () => {
    /* The reader could not have known: two installs of one mailbox legitimately hold different
       subsets of it. What matters is that the ack carries the WORD — a record that quietly
       disappeared would leave the person unable to tell "done" from "never happened". */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const requestId = randomUUID();
    const m = fakeMeta();
    await m.reader.append(moveRecord({ requestId, mailboxId, key: KEY, dedupKey: "mid:never-synced-here", destination: "reads" }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 0, refused: 1, deferred: 0, standing: 0 });

    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.outcome).toBe("refused");
    expect(acks[0]!.reason, "the reader was refused without being told which of the two happened")
      .toBe("no_such_message");
  });

  it("mail 0094 — a move to trash with no Trash folder is refused by its OWN name, not the other one", async () => {
    // Two refusals that must not collapse into one word: they want different things from a person.
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const messageId = await seedHeldMessage(db, mailboxId, "person@example.com");
    const [row] = await db.select({ dedupKey: messages.dedupKey }).from(messages).where(eq(messages.id, messageId));
    const m = fakeMeta();
    await m.reader.append(moveRecord({ mailboxId, key: KEY, dedupKey: row!.dedupKey, destination: "trash" }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks[0]!.reason).toBe("no_trash_folder");

    /* AND THE REFUSAL LEFT NO INTENT BEHIND. The applier throws to roll its transaction back, so
       the idempotency key claimed moments earlier must be gone too — otherwise the next cycle
       reads the key, concludes the record was already taken, and acks `applied` for a move that
       never happened. The `folder_state` row is still the worker's, unchanged. */
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.desiredFolder).toBe("ohmail/Screener");
    expect(fs!.reconcileStatus).toBe("reconciled");
  });

  it("mail 0094 — a move whose payload is not a move is invalid_payload, never applied", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    // A well-formed record of the right kind carrying a Screener decision's payload.
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "message.move", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW,
      payload: { scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes" },
      key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks[0]!.reason).toBe("invalid_payload");
  });

  it("mail 0094 — a profile.update writes the account's rows and the mailbox's signature", async () => {
    /* THE KIND THAT CLOSED A SUCCESS THAT CHANGED NOTHING. Before it, a reader editing any of
       these got `200`, the write landed in the READER's own row, and the organizer's pass never
       read it — the setting was on screen and in effect nowhere. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const requestId = randomUUID();
    const m = fakeMeta();
    await m.reader.append(formatRequest({
      requestId, kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW,
      payload: {
        signature: "-- \nMila",
        dormancyDays: 45,
        awayResponder: {
          enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
          audience: "screened_in", throttle: "per_day",
        },
      },
      key: KEY,
    }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });

    const [mb] = await db.select({ signature: mailboxes.signature }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.signature).toBe("-- \nMila");
    const [st] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(st!.dormancyDays).toBe(45);
    const [aw] = await db.select().from(awayResponders).where(eq(awayResponders.accountId, ACCT));
    expect(aw!.enabled).toBe(true);
    expect(aw!.body).toBe("Back Monday.");
    expect(aw!.throttle).toBe("per_day");

    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.requestId).toBe(requestId);
    expect(acks[0]!.outcome).toBe("applied");
  });

  it("mail 0094 — a profile.update leaves ABSENT fields alone; a null signature is a REMOVAL", async () => {
    /* An absent key is "leave it", a present key replaces — `null` included. Collapsing the two
       would make the one edit a person cannot make be the removal of their own signature. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.update(mailboxes).set({ signature: "-- \nold" }).where(eq(mailboxes.id, mailboxId));
    await db.insert(accountSettings).values({ accountId: ACCT, dormancyDays: 30 });
    const m = fakeMeta();

    // Names ONLY the signature, as a removal. `dormancyDays` must survive untouched.
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW, payload: { signature: null }, key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(1);

    const [mb] = await db.select({ signature: mailboxes.signature }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.signature, "a null signature was treated as absent, so a removal is unexpressible").toBeNull();
    const [st] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(st!.dormancyDays, "an absent field was overwritten — a partial became a whole replace").toBe(30);
  });

  it("mail 0094 — the screening posture arms the backlog tidy on the TRANSITION only", async () => {
    /* Mirrors the organizer's own door. A request that changed the posture without arming would
       leave the mail already misfiled in the Ohbox unfiled — in effect for new mail and silently
       not for the backlog, which is the halfway state the arming exists to prevent. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const post = async () => {
      await m.reader.append(formatRequest({
        requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
        organizerKind: "local", decidedAt: NOW, payload: { screeningPreference: "people_only" }, key: KEY,
      }));
      return applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    };

    expect((await post()).applied).toBe(1);
    const [first] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(first!.ohboxPolicy).toBe("people_only");
    expect(first!.ohboxTidyRequestedAt, "the transition into people_only armed nothing").not.toBeNull();

    // A RE-SAVE that leaves the posture where it is must not re-arm.
    await db.update(accountSettings).set({ ohboxTidyRequestedAt: null }).where(eq(accountSettings.accountId, ACCT));
    expect((await post()).applied).toBe(1);
    const [again] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(again!.ohboxTidyRequestedAt, "a re-save re-ran the backlog — the arming is not on the transition")
      .toBeNull();
  });

  it("a screening shape outside the object and the legacy string is refused BY NAME, and writes nothing", async () => {
    // Filtering an unknown sub-key would ack `applied` for an edit that did not all apply.
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.insert(accountSettings).values({ accountId: ACCT, ohboxPolicy: "people_and_replied", ohboxBar: "kept" });
    const m = fakeMeta();
    for (const shape of [42, { ohboxPolicy: "people_only", ohboxMood: "calm" }, { ohboxPolicy: "everyone" }, {}]) {
      await m.reader.append(formatRequest({
        requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
        organizerKind: "local", decidedAt: NOW, payload: { screeningPreference: shape }, key: KEY,
      }));
    }
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 0, refused: 4, deferred: 0, standing: 0 });
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks.map((a) => a.reason)).toEqual(["invalid_payload", "invalid_payload", "invalid_payload", "invalid_payload"]);
    const [st] = await db.select().from(accountSettings).where(eq(accountSettings.accountId, ACCT));
    expect(st!.ohboxPolicy).toBe("people_and_replied");
    expect(st!.ohboxBar).toBe("kept");
  });

  it("mail 0094 — a profile.update naming nothing recognised is invalid_payload, not an applied no-op", async () => {
    // A reader that queues an empty record has asked for nothing; answering `applied` would tell
    // somebody a change they did not make had been made.
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW, payload: { somethingElse: 1 }, key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks[0]!.reason).toBe("invalid_payload");
  });

  it("the ruling of 2026-09-10 — a profile.update carrying a pile scope WRITES that scope", async () => {
    /* THE SCOPE (`piles`, mail 0096) DID NOT TRAVEL, and nothing failed while it did not: the
       patch carried six members, the validator ignored the seventh and the away write was a
       partial SET that never named the column. So a save on a MIXED or READER account that opted
       Reads in was acked `applied` and the pane showed the old scope back — a setting that
       reverts itself, with every guard green.

       Driven through the whole drain rather than through `applyProfileUpdate` directly, because
       the defect was distributed across the validator AND the SET: a fix to either alone leaves
       the field travelling and ignored, which is the state this case exists to make impossible. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    // A row that already exists at the NARROW scope, so the wide value is a change rather than a
    // default and "it wrote" cannot be satisfied by the column's own `'{INBOX}'`.
    await db.insert(awayResponders).values({ accountId: ACCT, enabled: true, piles: ["INBOX"] });
    const m = fakeMeta();
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW,
      payload: {
        awayResponder: {
          enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
          audience: "screened_in", throttle: "per_day", piles: ["INBOX", "ohmail/News"],
        },
      },
      key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });

    const [aw] = await db.select().from(awayResponders).where(eq(awayResponders.accountId, ACCT));
    expect(aw!.piles, "the scope travelled and was dropped — the pane will show the old value")
      .toEqual(["INBOX", "ohmail/News"]);
  });

  it("the ruling of 2026-09-10 — a profile.update WITHOUT piles leaves the stored scope alone", async () => {
    /* THE COMPATIBILITY ARM, and the one that decides whether the ruling may ship: an install one
       release older sends the six fields and no `piles`. Its save must still apply, and it must
       not NARROW a scope its own pane never showed and never offered — so absence is "this
       request is not about the scope", never "set it to the default".

       BOTH stored values are tried. Asserting only the wide one would be satisfied by a SET that
       writes the wide value unconditionally, and only the narrow one by a SET that writes the
       default; the pair can be satisfied only by a SET that does not name the column at all. */
    for (const stored of [["INBOX", "ohmail/News"], ["INBOX"]]) {
      const db = await makeTestDb();
      const mailboxId = await seedMailbox(db);
      await db.insert(awayResponders).values({ accountId: ACCT, enabled: false, piles: stored });
      const m = fakeMeta();
      await m.reader.append(formatRequest({
        requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
        organizerKind: "local", decidedAt: NOW,
        payload: {
          awayResponder: {
            enabled: true, body: "Back Monday.", startsAt: null, endsAt: null,
            audience: "everyone", throttle: "per_week",
          },
        },
        key: KEY,
      }));
      const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
      expect(result.applied, "an older install's responder save was refused").toBe(1);

      const [aw] = await db.select().from(awayResponders).where(eq(awayResponders.accountId, ACCT));
      expect(aw!.piles, `an absent scope overwrote a stored ${JSON.stringify(stored)}`).toEqual(stored);
      // …and the six fields it DID name replaced, so the case is not green by nothing applying.
      expect(aw!.audience).toBe("everyone");
      expect(aw!.throttle).toBe("per_week");
    }
  });

  it("the ruling of 2026-09-10 — a profile.update carrying MARKUP writes BOTH signature columns", async () => {
    /* THE MARKUP DID NOT TRAVEL, and nothing failed while it did not: the payload had one
       signature slot and it was the derived TEXT, so a formatted sign-off reached the holder as
       words with the bold, the italic and the links stripped, and `signature_html` stayed NULL.
       The pane said "pending" and echoed the columns as they stood, which was true.

       Driven through the whole drain rather than through `applyProfileUpdate`, because the defect
       was distributed across the payload interface, the wire type, the validator and the SET: a
       fix to any one of them leaves the field either not travelling or travelling and ignored. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    // Columns that already hold a DIFFERENT signature, so "it wrote" cannot be satisfied by the
    // column's own NULL default.
    await db.update(mailboxes)
      .set({ signature: "-- \nold words", signatureHtml: "<p>old <b>words</b></p>" })
      .where(eq(mailboxes.id, mailboxId));
    const m = fakeMeta();
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW,
      payload: { signature: "-- \nMila", signatureHtml: "<p>-- <br><strong>Mila</strong></p>" },
      key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });

    const [mb] = await db.select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.signature).toBe("-- \nMila");
    expect(mb!.signatureHtml, "the markup travelled and was dropped — the holder appends the words without the formatting")
      .toBe("<p>-- <br><strong>Mila</strong></p>");
  });

  it("the ruling of 2026-09-10 — a plain travelling save CLEARS the holder's markup", async () => {
    /* A plain save is saving the whole value, and clearing the markup is the LOCAL rule that has
       to survive the wire: without it the holder keeps markup the stored words no longer match
       and its composer ships that in place of what was just saved. `null` on the wire is the
       instruction, which is why an absent key could not have carried this. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.update(mailboxes)
      .set({ signature: "-- \nMila", signatureHtml: "<p><strong>Mila</strong></p>" })
      .where(eq(mailboxes.id, mailboxId));
    const m = fakeMeta();
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW,
      payload: { signature: "-- \nMila, from the phone", signatureHtml: null },
      key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(1);

    const [mb] = await db.select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.signature).toBe("-- \nMila, from the phone");
    expect(mb!.signatureHtml, "a plain save left the holder's markup standing over the new words").toBeNull();
  });

  it("the ruling of 2026-09-10 — a profile.update WITHOUT signatureHtml leaves the column alone", async () => {
    /* THE COMPATIBILITY ARM, and the one that decides whether the ruling may ship: an install one
       release older sends `signature` and no markup member. Its save must still apply, and it must
       not clear formatting its own pane never showed.

       BOTH stored values are tried. Asserting only the markup case would be satisfied by a SET
       that never names the column, and only the NULL case by a SET that writes NULL
       unconditionally; the pair can be satisfied only by a SET that names it when the payload
       carried it and not otherwise. */
    for (const storedHtml of ["<p>kept <em>markup</em></p>", null]) {
      const db = await makeTestDb();
      const mailboxId = await seedMailbox(db);
      await db.update(mailboxes).set({ signature: "-- \nold", signatureHtml: storedHtml })
        .where(eq(mailboxes.id, mailboxId));
      const m = fakeMeta();
      await m.reader.append(formatRequest({
        requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
        organizerKind: "local", decidedAt: NOW,
        payload: { signature: "-- \nnew words" },
        key: KEY,
      }));
      const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
      expect(result.applied, "an older install's signature save was refused").toBe(1);

      const [mb] = await db.select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
        .from(mailboxes).where(eq(mailboxes.id, mailboxId));
      expect(mb!.signatureHtml, `an absent markup key overwrote a stored ${JSON.stringify(storedHtml)}`)
        .toBe(storedHtml);
      // …and the field it DID name replaced, so the case is not green by nothing applying.
      expect(mb!.signature).toBe("-- \nnew words");
    }
  });

  it("the ruling of 2026-09-10 — over-bound or malformed markup is invalid_payload, and the row is untouched", async () => {
    /* The whole record refuses rather than the one field being dropped: applying the rest and
       acking `applied` would tell somebody their formatting travelled while the holder stored the
       words alone — the state this ruling exists to end, reached by a different door. */
    for (const bad of ["x".repeat(TRAVELLING_SIGNATURE_HTML_MAX_BYTES + 1), 42, ["<p></p>"]]) {
      const db = await makeTestDb();
      const mailboxId = await seedMailbox(db);
      await db.update(mailboxes).set({ signature: "-- \nold", signatureHtml: "<p>old</p>" })
        .where(eq(mailboxes.id, mailboxId));
      const m = fakeMeta();
      await m.reader.append(formatRequest({
        requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
        organizerKind: "local", decidedAt: NOW,
        payload: { signature: "-- \nnew", signatureHtml: bad },
        key: KEY,
      }));
      const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
      expect(result.refused, `a malformed signatureHtml ${JSON.stringify(bad).slice(0, 40)} was applied`).toBe(1);

      const [mb] = await db.select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
        .from(mailboxes).where(eq(mailboxes.id, mailboxId));
      expect(mb!.signature, "a refused record wrote the text half anyway").toBe("-- \nold");
      expect(mb!.signatureHtml).toBe("<p>old</p>");
      const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
      expect(acks[0]!.reason).toBe("invalid_payload");
    }
  });

  /* A SCOPE THE RESPONDER CAN NEVER ACT ON IS REFUSED WHOLE, and there are TWO such scopes.
   *
   * This case sent `ohmail/Screener` beside `audience: 'everyone'` and called it a non-member,
   * which it was until mail 0101 widened `AWAY_ANSWERABLE_PILES` to four ("Receipts and the
   * Screener are answerable piles"). That payload is now VALID and correctly applied, so the
   * premise died with the design while the invariant it guards did not: `request-apply.ts` still
   * refuses a member that is not in the closed set, and still refuses the Screener beside the
   * NARROW audience, which is the combination the pass can never act on (`awayScopeFitsAudience`).
   *
   * REFUSED rather than filtered, for both: filtering would store a narrower scope than the
   * request asked for and ack it `applied` — the person told their edit travelled while the
   * responder answers a different set of mail. The validator's own arms are measured in
   * `packages/db/test/request-apply.test.ts`; what is measured HERE is the drain — the ack a
   * reader receives, and the row it must leave alone.
   */
  const REFUSED_SCOPES: Array<{ what: string; audience: string; piles: string[] }> = [
    { what: "a NON-MEMBER pile", audience: "everyone", piles: ["INBOX", "ohmail/Spam"] },
    { what: "the Screener beside the narrow audience", audience: "screened_in", piles: ["INBOX", "ohmail/Screener"] },
  ];

  for (const scope of REFUSED_SCOPES) {
    it(`the ruling of 2026-09-10 — ${scope.what} is invalid_payload, and the row is untouched`, async () => {
      const db = await makeTestDb();
      const mailboxId = await seedMailbox(db);
      await db.insert(awayResponders).values({
        accountId: ACCT, enabled: true, body: "kept", piles: ["INBOX"], audience: "screened_in",
      });
      const m = fakeMeta();
      await m.reader.append(formatRequest({
        requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
        organizerKind: "local", decidedAt: NOW,
        payload: {
          awayResponder: {
            enabled: false, body: "changed", startsAt: null, endsAt: null,
            audience: scope.audience, throttle: "always", piles: scope.piles,
          },
        },
        key: KEY,
      }));
      const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
      expect(result.refused).toBe(1);
      expect(result.applied).toBe(0);
      const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
      expect(acks[0]!.reason).toBe("invalid_payload");

      /* THE WHOLE RECORD IS REFUSED, not the one bad field. The other members of the same patch
         must not have landed — a partial apply would be a responder configured half from a record
         the organizer rejected. `body` and `enabled` discriminate in BOTH arms; `audience` cannot
         in the second, where the request asks for the value the row already holds. */
      const [aw] = await db.select().from(awayResponders).where(eq(awayResponders.accountId, ACCT));
      expect(aw!.piles).toEqual(["INBOX"]);
      expect(aw!.body, "a refused record applied its other fields anyway").toBe("kept");
      expect(aw!.enabled).toBe(true);
      expect(aw!.audience).toBe("screened_in");
    });
  }

  it("mail 0101 — the Screener IS answerable beside `everyone`, and that scope travels", async () => {
    /* The positive control the case above used to be. Without it the two refusals are satisfied by
       a validator that rejects every Screener scope, which would make the fourth answerable pile
       unreachable on a reader account with the suite green. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.insert(awayResponders).values({
      accountId: ACCT, enabled: true, body: "kept", piles: ["INBOX"], audience: "screened_in",
    });
    const m = fakeMeta();
    await m.reader.append(formatRequest({
      requestId: randomUUID(), kind: "profile.update", mailboxId, installId: "reader-install",
      organizerKind: "local", decidedAt: NOW,
      payload: {
        awayResponder: {
          enabled: false, body: "changed", startsAt: null, endsAt: null,
          audience: "everyone", throttle: "always", piles: ["INBOX", "ohmail/Screener"],
        },
      },
      key: KEY,
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(1);
    expect(result.refused).toBe(0);
    const [aw] = await db.select().from(awayResponders).where(eq(awayResponders.accountId, ACCT));
    expect(aw!.piles).toEqual(["INBOX", "ohmail/Screener"]);
    expect(aw!.audience).toBe("everyone");
  });

  it("a kind with no applier here is left standing too", async () => {
    /* This case used `rule.create` while that kind had no applier. Every kind mail 0094 admits has
       one now, so the standing path is reached only by a kind from a FUTURE build — which is what
       it was always for. The kind below is deliberately one NO build has, so the case cannot go
       green again by a later slice quietly handling it. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const m = fakeMeta();
    await m.reader.append(decideRecord({ mailboxId, key, kind: "message.shred" }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.standing).toBe(1);
    expect(result.refused).toBe(0);
    expect(m.store.size, "a kind from a future build was expunged").toBe(1);
  });

  /* ══ mail 0094 — THE THREE `rule.*` KINDS ═══════════════════════════════════════════════
   *
   * They share one applier, one table and one capability. The natural key is FOUR fields, not the
   * two the shape was specified with, because this database has no unique index on
   * `(account_id, kind, match)` and two rules on one sender that differ only in a narrowing term
   * are two different rules that file different mail to different places.
   */
  function ruleRecord(o: { mailboxId: string; kind: string; payload: unknown; requestId?: string }): string {
    return formatRequest({
      requestId: o.requestId ?? randomUUID(),
      kind: o.kind as "screener.decide",
      mailboxId: o.mailboxId, installId: "reader-install", organizerKind: "local",
      decidedAt: NOW, payload: o.payload, key: KEY,
    });
  }

  const RULE_KEY: RuleKey = { kind: "sender", match: "shop@example.com", subjectContains: null, bodyContains: null };
  /** A create as the door composes it, so these cases read the shape a reader actually sends. */
  const created = (key: RuleKey, destination: string, applyRetro?: boolean) =>
    ruleCreatePayload({ key, destination, priority: 0, enabled: true, applyRetro });

  it("mail 0094 — rule.create writes the rule, arms retro by default, and records a change", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create",
      payload: created(RULE_KEY, "receipts"),
    }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 1, refused: 0, deferred: 0, standing: 0 });

    const [r] = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(r!.kind).toBe("sender");
    expect(r!.match).toBe("shop@example.com");
    expect(r!.destination).toBe("ohmail/Receipts");
    /* A REQUEST IS A PERSON'S OWN PRESS. `promoted` would make an explicit rule look learned,
       which changes how the rules pane ranks and explains it. */
    expect(r!.provenance).toBe("manual");
    // Retro is the DEFAULT, not an opt-in — creating a rule reaches mail already on disk.
    expect(r!.retroRequestedAt, "a created rule did not ask to reach mail already on disk").not.toBeNull();

    /* A RULE IS A SYNC TYPE, unlike profile configuration: the delta feed must see one written
       through the reader door exactly as one written at the organizer's own door. */
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule")));
    expect(changes, "a rule written through the reader door is missing from the delta feed").toHaveLength(1);
    expect(changes[0]!.op).toBe("create");
  });

  it("mail 0094 — the FOUR-field key tells two rules on one sender apart", async () => {
    /* The reason the specified two-field key was widened. Both rules match the same sender; only
       the subject term separates them, and they file to different folders. A two-field key would
       have named both and had to guess. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create", payload: created(RULE_KEY, "receipts"),
    }));
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create",
      payload: created({ ...RULE_KEY, subjectContains: "invoice" }, "reads"),
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(2);

    const all = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(all, "the two rules collapsed into one — the key cannot tell them apart").toHaveLength(2);
    const bare = all.find((r) => r.subjectContains === null);
    const termed = all.find((r) => r.subjectContains === "invoice");
    expect(bare!.destination).toBe("ohmail/Receipts");
    expect(termed!.destination).toBe("ohmail/News");
  });

  it("mail 0094 — rule.update re-targets and re-opens the backlog; a no-op re-send does not", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create", payload: created(RULE_KEY, "receipts", false),
    }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect((await db.select().from(rules).where(eq(rules.accountId, ACCT)))[0]!.retroRequestedAt).toBeNull();

    // A MOVE: the destination changes, so the backlog is re-opened.
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.update", payload: { key: RULE_KEY, set: { destination: "reads" } },
    }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    const [moved] = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(moved!.destination).toBe("ohmail/News");
    expect(moved!.retroRequestedAt, "a re-targeted rule did not re-open the backlog").not.toBeNull();

    // A NO-OP: the same destination re-sent. Compared against the STORED value, so a habit-click
    // costs nothing — re-running the backlog on it would be work nobody asked for.
    await db.update(rules).set({ retroRequestedAt: null }).where(eq(rules.accountId, ACCT));
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.update", payload: { key: RULE_KEY, set: { destination: "reads" } },
    }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    const [again] = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(again!.retroRequestedAt, "re-sending the destination it already had re-ran the backlog").toBeNull();
  });

  it("mail 0094 — rule.update REFUSES a `set` that names a key field", async () => {
    /* Changing what a rule matches is not an edit to that rule, it is a different rule. Refused
       rather than silently ignored: ignoring it would apply a DIFFERENT change from the one asked
       for and ack the reader `applied` for it. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create", payload: created(RULE_KEY, "receipts"),
    }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);

    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.update", payload: { key: RULE_KEY, set: { match: "other@example.com" } },
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    const [r] = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(r!.match, "a key field was edited through `set`").toBe("shop@example.com");
  });

  it("mail 0094 — a `set` mixing a key field WITH a legitimate one is refused WHOLE, not partly applied", async () => {
    /* THIS CASE EXISTS BECAUSE A MUTATION CAME BACK GREEN. Deleting the forbidden-field check left
       the case above passing, because a `set` naming ONLY `match` then has no recognised field and
       the empty-`set` check refuses it instead — a second mechanism covering for the one under
       test, which measures the pair rather than the part.

       Mixed, the two come apart: without the check the destination edit lands, the `match` edit is
       silently dropped, and the reader is acked `applied` for a change that is not the one it
       asked for. Refusing WHOLE is the only honest answer — a partial apply of an edit somebody
       composed as one thing is a different edit. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create", payload: created(RULE_KEY, "receipts"),
    }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);

    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.update",
      payload: { key: RULE_KEY, set: { destination: "reads", match: "other@example.com" } },
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused, "a mixed `set` was accepted").toBe(1);

    const [r] = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(r!.match, "the key field moved").toBe("shop@example.com");
    expect(r!.destination, "the legitimate half of a refused edit was applied anyway")
      .toBe("ohmail/Receipts");
  });

  it("mail 0094 — rule.delete removes the rule and records the delete; an unknown key is no_such_rule", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create", payload: created(RULE_KEY, "receipts"),
    }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);

    await m.reader.append(ruleRecord({ mailboxId, kind: "rule.delete", payload: { key: RULE_KEY } }));
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(await db.select().from(rules).where(eq(rules.accountId, ACCT))).toHaveLength(0);
    const deletes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "delete")));
    expect(deletes, "the delete is missing from the delta feed").toHaveLength(1);

    // …and deleting it again names the outcome rather than pretending it worked.
    await m.reader.append(ruleRecord({ mailboxId, kind: "rule.delete", payload: { key: RULE_KEY } }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
    expect(acks.some((a) => a.reason === "no_such_rule"), "the reader was not told the rule was gone").toBe(true);
  });

  it("mail 0094 — a rule may not file to `trash`", async () => {
    /* A rule is ACCOUNT-scoped and Trash resolves per MAILBOX, so the word would mean a different
       folder per mailbox the rule fires on. And a rule filing to Trash is a standing instruction
       to delete mail on arrival, which no door in this product offers. */
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    await m.reader.append(ruleRecord({
      mailboxId, kind: "rule.create", payload: created(RULE_KEY, "trash"),
    }));
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    expect(await db.select().from(rules).where(eq(rules.accountId, ACCT))).toHaveLength(0);
  });
});

describe("applyMetaRequests — staleness, and the double-apply it closes", () => {
  /**
   * ONE WINDOW, BOTH SIDES. An organizer offline for two days comes back to decisions the person
   * was already told had expired — and may well have made again. Applying the old one would leave
   * the OLDER rule as the final state, because the drain applies in `decidedAt` order.
   */
  it("refuses a decision older than the stale window", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const key = KEY;
    const m = fakeMeta();
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    await m.reader.append(decideRecord({ mailboxId, key, decidedAt: twoDaysAgo }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.refused).toBe(1);
    expect(await ruleCount(db)).toBe(0);
    const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), key);
    expect(acks[0]!.reason).toBe("stale");
  });

  /**
   * THE OFFLINE-ORGANIZER STORY END TO END: the person decides, the organizer is away past the
   * window, the reader expires the row and the person decides again. When the organizer returns
   * BOTH records are in the folder — and exactly one rule must result, the NEWER one.
   */
  it("organizer away two days: the stale decision is refused and the fresh one applies — one rule", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "old@example.com");
    await seedHeldMessage(db, mailboxId, "new@example.com");
    const key = KEY;
    const m = fakeMeta();
    await m.reader.append(decideRecord({
      mailboxId, key, address: "old@example.com",
      decidedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
    }));
    await m.reader.append(decideRecord({ mailboxId, key, address: "new@example.com", decidedAt: NOW }));

    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(result.applied).toBe(1);
    expect(result.refused).toBe(1);
    const all = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(all).toHaveLength(1);
    expect(all[0]!.match).toBe("new@example.com");
  });

  /**
   * WHY THE TWO CONSTANTS ARE RELATED, stated as an assertion rather than a comment.
   *
   * The idempotency key is what stops a second drain re-applying a record whose expunge failed,
   * and it EXPIRES. Once it has, a record still in the folder would be claimable again — a second
   * promoted rule for a press that happened once. Staleness is what closes that: a record old
   * enough for its key to have expired is refused before it can be re-claimed. Widen the window
   * past the TTL and the double-apply returns.
   */
  it("the stale window never outlives the idempotency key", () => {
    expect(REQUEST_STALE_AFTER_MS).toBeLessThanOrEqual(REQUEST_STALE_MUST_NOT_EXCEED_MS);
  });

  /**
   * The proof, driven rather than argued: a stuck expunge plus a clock past the TTL still yields
   * ONE rule, because the record is stale by then.
   */
  it("a stuck expunge past the idempotency TTL still produces exactly one rule", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const key = KEY;
    const m = fakeMeta();
    // The expunge fails, so the record stays in the folder for the next cycle to find.
    m.organizer.remove = async () => { throw new Error("server refused the expunge"); };
    await m.reader.append(decideRecord({ mailboxId, key }));

    const first = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
    expect(first.deferred).toBe(1);
    expect(await ruleCount(db)).toBe(1);

    // A day and a minute later: the key has expired, and the record is still sitting there.
    const later = new Date(NOW.getTime() + REQUEST_STALE_AFTER_MS + 60_000);
    await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, later, noopLog);
    expect(await ruleCount(db)).toBe(1);
  });
});

describe("applyMetaRequests — a duplicate drain produces one rule", () => {
  it("replaying the same record twice applies it once", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const key = KEY;
    const requestId = randomUUID();
    const raw = decideRecord({ requestId, mailboxId, key });

    const m1 = fakeMeta();
    await m1.reader.append(raw);
    expect((await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m1), requestKey: KEY }, NOW, noopLog)).applied).toBe(1);

    // The same record re-appears (a failed expunge, or a re-append) — same id, same content.
    const m2 = fakeMeta();
    await m2.reader.append(raw);
    const second = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m2), requestKey: KEY }, NOW, noopLog);
    expect(second.applied).toBe(1); // handled, and acknowledged again
    expect(await ruleCount(db)).toBe(1); // but only ONE rule
  });

  it("an adapter with no organizer IO drains nothing and never throws", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: {} as MailboxAdapter, requestKey: KEY }, NOW, noopLog);
    expect(result).toEqual({ applied: 0, refused: 0, deferred: 0, standing: 0 });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE READER'S STATE MACHINE — one table, because every transition it may make is here
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The two rows that must read `null` are the point of the table. Absence of a RECORD is not
 * `applied` (that was the defect), and absence of an ACK is not `refused` — it is silence, and
 * silence only ever becomes `expired`, on the clock.
 */
describe("readerOutcomeFor", () => {
  const ack = (outcome: "applied" | "refused", reason: string | null = null) =>
    ({ requestId: "r", outcome, reason, ackedAt: NOW, protocol: 1 }) as never;
  const fresh = new Date(NOW.getTime() - 60_000);
  const old = new Date(NOW.getTime() - REQUEST_STALE_AFTER_MS - 60_000);

  it.each([
    ["an applied ack →  applied", ack("applied"), fresh, "applied", null],
    ["a refused ack  →  refused, with its reason", ack("refused", "conflict"), fresh, "refused", "conflict"],
    ["a refused ack with an unknown reason → refused, reason null", ack("refused", null), fresh, "refused", null],
    ["no ack, inside the window → nothing", null, fresh, null, null],
    ["no ack, past the window  → expired", null, old, "expired", null],
    ["an ack PAST the window still wins — a real outcome outranks a timeout", ack("applied"), old, "applied", null],
    ["a refused ack past the window also wins", ack("refused", "stale"), old, "refused", "stale"],
  ] as const)("%s", (_name, a, sentAt, next, reason) => {
    const out = readerOutcomeFor({ ack: a, sentAt, now: NOW });
    expect(out.next).toBe(next);
    if (next === "refused") expect((out as { reason: string | null }).reason).toBe(reason);
  });

  /** A `sentAt` that is somehow null must not be read as infinitely old and expired at once. */
  it("treats a null sentAt as 'just now' rather than as ancient", () => {
    expect(readerOutcomeFor({ ack: null, sentAt: null, now: NOW }).next).toBeNull();
  });
});

describe("driveOutstandingRequests — the reader's own cycle", () => {
  async function queue(db: TestDb, mailboxId: string, address = "person@example.com"): Promise<string> {
    const id = randomUUID();
    await db.insert(organizerRequests).values({
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", address, appliedFolder: "INBOX", decision: "yes", match: address },
      decidedAt: NOW, state: "pending",
    });
    return id;
  }
  const self = { installId: "reader-install", kind: "local" as const };

  it("appends a pending request, signed, and marks it sent", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const id = await queue(db, mailboxId);
    const m = fakeMeta();

    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(result.sent).toBe(1);
    expect(m.store.size).toBe(1);

    // The record it wrote names this mailbox and verifies under the account's key.
    const env = parseRequestEnvelope([...m.store.values()][0]!) as RequestEnvelope;
    expect(env.requestId).toBe(id);
    expect(env.mailboxId).toBe(mailboxId);
    expect(env.sig).not.toBe("");

    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("sent");
  });

  /* EVERY KIND THE VOCABULARY ADMITS TRAVELS, not `screener.decide` alone. The appender filtered on
     that one literal while the organizer's apply table already carried `rule.*`, `message.move` and
     `profile.update`, so a move or a signature made on a reader was stored, reported as waiting for
     the organizing machine, and appended nowhere that machine reads. The mutation that reddens this:
     put `req.kind !== "screener.decide"` back in `request-drain.ts`. */
  it("appends a move and a profile update too, each carrying its own kind and payload", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();

    const movePayload = { scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes" };
    const profilePayload = { signature: "-- \nMila", dormancyDays: 45 };
    const moveId = randomUUID();
    const profileId = randomUUID();
    await db.insert(organizerRequests).values([
      { id: moveId, accountId: ACCT, mailboxId, kind: "message.move", payload: movePayload, decidedAt: NOW, state: "pending" },
      { id: profileId, accountId: ACCT, mailboxId, kind: "profile.update", payload: profilePayload, decidedAt: NOW, state: "pending" },
    ]);

    const result = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog,
    );
    expect(result.sent).toBe(2);
    expect(m.store.size).toBe(2);

    /* Parsed back by the organizer's OWN reader: the kind it will switch on and the payload it will
       validate are the ROW's, not the appender's idea of them. */
    const byId = new Map<string, RequestEnvelope>();
    for (const raw of m.store.values()) {
      const env = parseRequestEnvelope(raw) as RequestEnvelope;
      byId.set(env.requestId, env);
    }
    expect(byId.get(moveId)?.kind).toBe("message.move");
    expect(byId.get(profileId)?.kind).toBe("profile.update");
    /* `decodeRequestPayload` answers a UNION — the record, or evidence the payload would not decode
       — so each is narrowed by the repository's own `isMalformedRequest` before its payload is
       read. That narrowing is an assertion in its own right: the first version of this case reached
       for `.payload` and would have said nothing about a record that failed to decode. */
    for (const [id, want] of [[moveId, movePayload], [profileId, profilePayload]] as const) {
      const rec = decodeRequestPayload(byId.get(id)!);
      expect(isMalformedRequest(rec), `the record for ${id} did not decode`).toBe(false);
      if (isMalformedRequest(rec)) continue;
      expect(rec.payload).toEqual(want);
    }

    const rows = await db.select().from(organizerRequests);
    expect(rows.every((r) => r.state === "sent")).toBe(true);
  });

  /**
   * ── AN INSTALL MAY NOT FILL THE FOLDER IT WOULD THEN REFUSE TO READ ───────────────────────
   *
   * Publishing every queued decision in one pass leaves nothing between the length of the queue
   * and the folder's ceiling. Somebody who has been filing mail on a second machine while the
   * organizing install was away comes back with hundreds of decisions queued, and one cycle
   * appends all of them -- so the folder crosses the ceiling by way of THIS INSTALL'S OWN records,
   * with nobody else involved and nothing misconfigured.
   *
   * That state does not heal. Records leave the folder only after a bounded read SUCCEEDS, the
   * read refuses past the ceiling, and the sweep that runs ahead of it removes acknowledgements
   * only -- it cannot remove these, because the pass that settles them is the one that refused.
   *
   * Asserted on the FOLDER rather than on a counter: what matters is that the records this install
   * writes never take it past the ceiling, whatever the queue length was. The second assertion is
   * what stops the first being satisfied by appending nothing at all.
   *
   * MUTATION WATCHED RED: lift the headroom bound -- append the whole queue again -- and the
   * folder ends the cycle over the ceiling, which is the state nothing in the loop can clear.
   */
  /**
   * ── THE OTHER HALF OF THE INVARIANT: A JOINT CROSSING MUST RECOVER, NOT PERSIST ────────────
   *
   * The bound above is per-writer and cannot be more than that. `records` is a snapshot taken a
   * round trip ago and IMAP offers no append-under-condition, so two readers can each measure the
   * same headroom, each stay honestly inside it, and cross the ceiling together. Nothing on the
   * append path prevents it; a check that appeared to would be a lie the rest of the system would
   * then rely on.
   *
   * What makes that survivable is recovery. The ack sweep needs no read of its own, so it still
   * runs against a folder that is over the ceiling; it removes the acknowledgements that are the
   * bulk of one; and the bounded read that follows it IN THE SAME CYCLE then succeeds. The
   * refusal is a pause, not a wall.
   *
   * This drives exactly that: two writers cross 500 together, and the next cycle brings the folder
   * back under and applies the request that was waiting behind it.
   *
   * MUTATION WATCHED RED: move the sweep back behind the bounded read and the folder never
   * recovers — the read refuses, the compactor never runs, and the request stays unapplied for
   * every cycle after.
   */
  it("two writers that cross the ceiling together recover on the next cycle", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    /* ── STALE BY A DAY, NOT BY A MINUTE, BECAUSE THE SWEEP DELETES BY DATE ────────────────
     *
     * The cutoff is floored to the start of its UTC day: the server searches BEFORE a DATE, and a
     * cutoff carrying a time of day is widened forward by the client — right for a reader, wrong
     * for something that deletes. So an acknowledgement a minute past its nominal life is usually
     * NOT swept, because it was filed on the cutoff's own day.
     *
     * This seeded exactly that, and passed only because the fake compared the raw instant — more
     * permissive than production. With the fake using production's own cutoff function, a
     * minute-past-the-life acknowledgement survives and the recovery this case asserts does not
     * happen. Three days old is stale by any reading, which is what the case means. */
    const stale = new Date(NOW.getTime() - 3 * 86_400_000);

    /* THE JOINT CROSSING, as two honest writers produce it: the folder sat just under the ceiling
     * and two cycles each appended within the headroom they measured. Modelled by its RESULT,
     * because the race itself is not the thing under test — the recovery is. */
    let uid = 8000;
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 40; i++) {
      m.store.set(uid, formatAck({
        requestId: `old-${i}`, mailboxId, outcome: "applied", ackedAt: stale, key,
      }));
      m.ackDates.set(uid, stale);
      uid += 1;
    }
    // …and one fresh request waiting behind the refusal.
    m.store.set(uid, decideRecord({ requestId: "waiting", mailboxId, key }));
    expect(m.store.size, "the folder is not actually over the ceiling, so this proves nothing")
      .toBeGreaterThan(META_RECORDS_MAX_PER_FETCH);

    const res = await applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    expect(m.store.size, "the folder did not come back under the ceiling, so the state is terminal")
      .toBeLessThanOrEqual(META_RECORDS_MAX_PER_FETCH);
    expect(res.applied, "the request behind the refusal was never applied, so nothing recovered")
      .toBeGreaterThan(0);
  });

  it("never appends past the ceiling, however long the queue is", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();

    // The folder is already most of the way full of records this install did not write...
    let uid = 7000;
    // (Below the window less the holder's reserve, the ceiling a reader stops at.)
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH - META_HOLDER_RESERVE_RECORDS - 10; i++) {
      m.store.set(uid, `Subject: filler ${i}\r\n\r\nbody`);
      uid += 1;
    }
    const before = m.store.size;

    // ...and this install has far more queued than the ten records of headroom that leaves.
    for (let i = 0; i < 200; i++) await queue(db, mailboxId, `s${i}@example.com`);

    await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY },
      self, NOW, noopLog,
    );

    expect(m.store.size,
      "this install appended its own records past the ceiling, so every later read refuses")
      .toBeLessThanOrEqual(META_RECORDS_MAX_PER_FETCH - META_HOLDER_RESERVE_RECORDS);
    expect(m.store.size, "the headroom that existed was not used at all").toBeGreaterThan(before);
  });

  /** A reader with no key cannot sign, so it writes nothing rather than writing something useless. */
  it("appends nothing for an OAuth mailbox — nothing it wrote could be verified", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    const result = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: null }, self, NOW, noopLog);
    expect(result).toEqual({ sent: 0, applied: 0, refused: 0, expired: 0 });
    expect(m.store.size).toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("pending");
  });

  it("a sent request with an APPLIED ack becomes applied", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);

    // The organizer answers, and takes the record away.
    m.store.clear();
    await m.organizer.ack(formatAck({ requestId: id, mailboxId, outcome: "applied", ackedAt: NOW, key }));

    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(result.applied).toBe(1);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("applied");
  });

  it("a sent request with a REFUSED ack becomes refused, and keeps the reason", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const key = KEY;
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);

    m.store.clear();
    await m.organizer.ack(formatAck({ requestId: id, mailboxId, outcome: "refused", reason: "wrong_mailbox", ackedAt: NOW, key }));

    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(result.refused).toBe(1);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("refused");
    expect(row!.refusedReason).toBe("wrong_mailbox");
  });

  /**
   * THE DEFECT THIS WHOLE ACK MODEL EXISTS TO CLOSE. The record is gone from the folder and there
   * is no ack. That used to read as `applied`. It is not evidence of anything, so the row waits.
   */
  it("a sent request whose record is GONE but has no ack does NOT become applied", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);

    m.store.clear(); // the record vanished, with nothing said about it

    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(result.applied).toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("sent");
  });

  /** A forged ack is not an outcome. It reads as silence, and the row waits for a real one. */
  it("an ack signed under a different key is ignored", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);

    m.store.clear();
    await m.organizer.ack(formatAck({
      requestId: id, mailboxId, outcome: "applied", ackedAt: NOW,
      key: OTHER_KEY,
    }));

    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(result.applied).toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("sent");
  });

  it("a sent request past the stale window with no ack becomes expired", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);

    const later = new Date(NOW.getTime() + REQUEST_STALE_AFTER_MS + 60_000);
    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, later, noopLog);
    expect(result.expired).toBe(1);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("expired");
  });

  /**
   * AN UNREADABLE FOLDER TRANSITIONS NOTHING — including the case where the folder is ABSENT,
   * which `listMetaRecords` raises for rather than answering `[]`. "I could not look" and "the
   * organizer answered" must not be reachable from one another.
   */
  it("transitions nothing when the folder cannot be read", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);

    m.reader.listMetaRecords = async () => { throw new Error("ohmail/_meta does not exist"); };
    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(result).toEqual({ sent: 0, applied: 0, refused: 0, expired: 0 });
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("sent");
  });

  /**
   * THE SPLIT TRY. A database failure AFTER a good APPEND used to be caught as "the append
   * failed", so the row stayed `pending` and the next cycle appended the SAME decision again —
   * for ever, a growing pile of genuine signed records the organizer would dutifully apply.
   */
  /**
   * ── THE DUPLICATE-APPEND LOOP, DRIVEN ────────────────────────────────────────────────────
   *
   * The sequence: a cycle APPENDS the record, then the database write that would mark the row
   * `sent` fails. The row is still `pending`, so the next cycle wants to append it again — and the
   * one after that, for ever, each a genuine signed record the organizer would dutifully apply.
   *
   * The row is put back to `pending` by hand here, which is exactly the state that failure leaves
   * behind, and is the honest way to reach it without stubbing the transaction machinery. What
   * must happen next is that the record ALREADY IN THE FOLDER is recognised: one record, and the
   * row marked without a second append.
   */
  it("a pending row whose record is already in the folder is marked, never appended twice", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();

    await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(m.store.size).toBe(1);

    // The state a failed `markRequestsSent` leaves: record in the folder, row still `pending`.
    await db.update(organizerRequests)
      .set({ state: "pending", sentAt: null })
      .where(eq(organizerRequests.id, id));

    const second = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY }, self, NOW, noopLog);
    expect(m.store.size).toBe(1); // NOT two
    expect(second.sent).toBe(1);  // and the row was settled this time
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("sent");
  });

  /** A read that fails must not lead to a write it cannot deduplicate. */
  it("appends nothing when the folder could not be read", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId);
    const m = fakeMeta();
    m.reader.listMetaRecords = async () => { throw new Error("ohmail/_meta does not exist"); };

    const result = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: null }, self, NOW, noopLog);
    expect(result).toEqual({ sent: 0, applied: 0, refused: 0, expired: 0 });
    expect(m.store.size).toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("pending");
  });

  /**
   * ── THE IMMORTAL ROW, AND WHY IT WAS REACHABLE ──────────────────────────────────────────
   *
   * A `pending` row is EXCLUDED from the Screener queue, and every expiry predicate but this one
   * requires `sent` — so a row nothing will ever append removed its sender from the person's queue
   * permanently, with the list still saying "waiting for …".
   *
   * It is reachable without any bug on the reader's side: the door decides whether to queue from
   * the HOLDER's advertised capability, which is copied out of a claim, and a claim is a message
   * anyone with append rights on the folder can write. Point that at a mailbox this install has no
   * shared secret for and the row is queued and never sent.
   *
   * MUTATION WATCHED RED: drop the `expireNeverSent` call and the row stays `pending` for ever.
   */
  it("a pending row nothing can hand over EXPIRES, even with no key at all", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId, "stuck@example.com");
    const m = fakeMeta();

    // An OAuth mailbox: no shared secret, so this cycle can neither sign nor append.
    const later = new Date(NOW.getTime() + REQUEST_STALE_AFTER_MS + 60_000);
    const out = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: null },
      self, later, noopLog);

    expect(out.expired).toBe(1);
    expect(m.store.size, "nothing may be appended without a key").toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("expired");

    // AND THE SENDER IS BACK: the exclusion the Screener list applies reads this set.
    const { listOutstandingForAccount } = await import("@trafficflow/db");
    const outstanding = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT, later));
    expect(outstanding.map((o) => o.match)).not.toContain("stuck@example.com");
  });

  /** Inside the window it is left alone — the next cycle may still be able to hand it over. */
  it("a pending row still inside the window is not expired", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = await queue(db, mailboxId, "fresh@example.com");
    const m = fakeMeta();

    const out = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: null },
      self, NOW, noopLog);

    expect(out.expired).toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("pending");
  });

  it("no reader IO — drives nothing, never throws", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const result = await driveOutstandingRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: {} as MailboxAdapter, requestKey: KEY }, self, NOW, noopLog);
    expect(result).toEqual({ sent: 0, applied: 0, refused: 0, expired: 0 });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ROLE FLIP — an install that becomes the organizer still owes its own old rows an ending
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("settleOwnOutstandingRequests", () => {
  /**
   * EXPIRED, NOT APPLIED — and this test asserts the NOT as hard as the expiry.
   *
   * Applying looked obviously right and is wrong twice: the row's record may already be in the
   * folder (the reader's append can succeed while the row update fails), so the drain would apply
   * it too and one press would write two rules; and these rows accumulate, so applying them
   * oldest-first lets a decision the person has since reversed win the final state.
   *
   * Expiring loses nothing a person can see: the sender returns to the queue and is answerable
   * again on the install that now organizes the mailbox.
   */
  it("EXPIRES a pending row this install queued before it became the organizer — never applies it", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await seedHeldMessage(db, mailboxId, "person@example.com");
    const id = randomUUID();
    await db.insert(organizerRequests).values({
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes", match: "person@example.com" },
      decidedAt: NOW, state: "pending",
    });

    const out = await settleOwnOutstandingRequests(db, { mailboxId, accountId: ACCT }, NOW, noopLog);
    expect(out.expired).toBe(1);
    expect(await ruleCount(db), "the flip applied a decision instead of returning it to the queue").toBe(0);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("expired");
  });

  /**
   * THE DEFECT THIS FUNCTION EXISTS FOR, stated as the property a person would notice: a `pending`
   * row is EXCLUDED from the Screener queue, so a row nothing will ever hand over removes its
   * sender from the queue permanently. Expiry is what puts the sender back.
   */
  it("a pending row does not survive the flip — the sender is answerable again", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = randomUUID();
    await db.insert(organizerRequests).values({
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", address: "stuck@example.com", appliedFolder: "INBOX", decision: "yes", match: "stuck@example.com" },
      decidedAt: NOW, state: "pending",
    });

    await settleOwnOutstandingRequests(db, { mailboxId, accountId: ACCT }, NOW, noopLog);

    // `listOutstandingForAccount` is what the Screener list excludes on; an expired row is not in
    // it, so the sender is back.
    const { listOutstandingForAccount } = await import("@trafficflow/db");
    const outstanding = await db.transaction((tx) => listOutstandingForAccount(tx, ACCT, NOW));
    expect(outstanding.map((o) => o.match)).not.toContain("stuck@example.com");
  });

  it("expires a sent row nobody ever took, past the window", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const id = randomUUID();
    await db.insert(organizerRequests).values({
      id, accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", address: "a@b.example", appliedFolder: "INBOX", decision: "yes", match: "a@b.example" },
      decidedAt: NOW, state: "sent", sentAt: NOW,
    });

    const later = new Date(NOW.getTime() + REQUEST_STALE_AFTER_MS + 60_000);
    const out = await settleOwnOutstandingRequests(db, { mailboxId, accountId: ACCT }, later, noopLog);
    expect(out.expired).toBe(1);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, id));
    expect(row!.state).toBe("expired");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A FOLDER PAST THE ENUMERATION'S CEILING IS A LOOK THAT FAILED — nothing settled, nothing removed
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Past the record window the drains read the whole folder; past {@link META_ENUM_RECORDS_MAX}
 * (shipping constant, not lowered) the read refuses `over_ceiling` with the person's sentence. Both
 * drains treat that as "I could not look": no apply, no ack, no expunge, no append, no transition,
 * and one line naming the code. In production the lease stands the organizer down first.
 */
describe("both drains treat a folder past the enumeration's ceiling as a look that failed", () => {
  const PAST = META_ENUM_RECORDS_MAX + 1;
  function seedStrays(m: ReturnType<typeof fakeMeta>, n: number): void {
    for (let i = 0; i < n; i++) m.store.set(50_000 + i, `Subject: stray ${i}\r\nX-Other-Client: 1\r\n\r\nbody`);
  }

  it("the organizer drain applies nothing, expunges nothing, and logs over_ceiling", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const removed: unknown[][] = [];
    m.organizer.remove = async (refs) => { removed.push([...refs]); };
    seedStrays(m, PAST - 1);
    m.store.set(10, decideRecord({ requestId: "under-the-pile", mailboxId, key: KEY }));
    expect(m.store.size).toBe(PAST);
    const events: Array<[string, Record<string, unknown>]> = [];

    const out = await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW,
      (event, detail) => { events.push([event, detail]); },
    );

    expect(out).toEqual({ applied: 0, refused: 0, deferred: 0, standing: 0 });
    expect(removed).toEqual([]);
    expect(m.store.size).toBe(PAST);
    expect(await ruleCount(db)).toBe(0);
    const listed = events.filter(([e]) => e === "meta_requests_list_failed");
    expect(listed).toHaveLength(1);
    expect(listed[0]![1].code).toBe("over_ceiling");
    expect((listed[0]![1].err as Error).message).toBe(metaFolderFullSentence(PAST, META_ENUM_RECORDS_MAX));
  });

  /** The reader's half: "my record is not in the folder" must never come from a look that failed. */
  it("the reader drain appends nothing, transitions nothing, and logs over_ceiling", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const [row] = await db.insert(organizerRequests).values({
      accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", address: "person@example.com", decision: "yes", appliedFolder: "INBOX" },
      decidedAt: NOW, state: "pending",
    }).returning({ id: organizerRequests.id });
    const m = fakeMeta();
    seedStrays(m, PAST);
    const events: Array<[string, Record<string, unknown>]> = [];

    const out = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY },
      { installId: "reader-install", kind: "local" }, NOW,
      (event, detail) => { events.push([event, detail]); },
    );

    expect(out).toEqual({ sent: 0, applied: 0, refused: 0, expired: 0 });
    expect(m.store.size).toBe(PAST);
    const [after] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, row!.id));
    expect(after!.state).toBe("pending");
    const listed = events.filter(([e]) => e === "outstanding_requests_list_failed");
    expect(listed).toHaveLength(1);
    expect(listed[0]![1].code).toBe("over_ceiling");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  AN ACK NAMING ANOTHER MAILBOX WAS IMMORTAL
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `acksIn` verifies under the ACCOUNT key, so an ack naming a different mailbox id is still this
 * account's own bookkeeping. Which mailbox it names decides whether it ANSWERS anything here — and
 * that filter used to feed the stale sweep as well, which is the only path that expunges an ack.
 *
 * So nobody could ever collect it: not this drain, which had filtered it out, and not the drain for
 * the mailbox it names, which reads a different folder. It sat in the customer's folder for ever,
 * counting against the read ceiling on every cycle of every host — and a mailbox removed and
 * re-added gets a new id, so an ack written moments before the removal is exactly this shape.
 */
describe("the stale ack sweep is by AGE, and the mailbox filter is for MATCHING only", () => {
  const OTHER_MAILBOX = "33333333-3333-4333-8333-333333333333";

  function staleAck(mailboxId: string): string {
    return formatAck({
      requestId: randomUUID(), mailboxId, outcome: "applied",
      ackedAt: new Date(NOW.getTime() - REQUEST_STALE_AFTER_MS - 60_000), key: KEY,
    });
  }

  /**
   * MUTATION WATCHED RED: narrow `staleAckRefs` back onto `existingAcks` (the mailbox-filtered
   * list) and the foreign-mailbox ack survives the sweep — for ever, on every subsequent cycle.
   */
  it("sweeps a stale ack that names ANOTHER mailbox, which nothing else can ever collect", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    m.store.set(1, staleAck(mailboxId));
    m.store.set(2, staleAck(OTHER_MAILBOX));

    await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog,
    );

    expect(m.store.size).toBe(0);
  });

  /** A FRESH ack naming another mailbox is still inside its window and is left alone. */
  it("leaves a FRESH ack alone, whichever mailbox it names", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const fresh = formatAck({
      requestId: randomUUID(), mailboxId: OTHER_MAILBOX, outcome: "applied", ackedAt: NOW, key: KEY,
    });
    m.store.set(1, fresh);

    await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog,
    );

    expect([...m.store.values()]).toEqual([fresh]);
  });

  /**
   * AND AN ACK THIS ACCOUNT DID NOT WRITE IS NOT OURS TO DESTROY. The sweep widened from "this
   * mailbox" to "this account"; it must not widen to "anything in the folder".
   */
  it("never touches a record that does not verify under this account's key", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const foreign = formatAck({
      requestId: randomUUID(), mailboxId, outcome: "applied",
      ackedAt: new Date(NOW.getTime() - REQUEST_STALE_AFTER_MS - 60_000), key: OTHER_KEY,
    });
    m.store.set(1, foreign);
    m.store.set(2, "Subject: somebody else's mail\r\n\r\nbody");

    await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog,
    );

    expect(m.store.size).toBe(2);
  });

  /**
   * The MATCHING half, and the case it exists for: an ack signed for ANOTHER MAILBOX THIS STORE
   * HOLDS, copied into this folder, is not an answer here. It verifies under the same key and would
   * otherwise win the first-wins match, telling a person their applied decision was refused and
   * inviting a second press. An id no row here carries is the organizer's own row id and IS the
   * answer (`reader-decision-two-stores.test.ts`), so the other mailbox is seeded as a row.
   */
  it("still refuses to read an ack for another mailbox as an answer in this one", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.insert(mailboxes).values({
      id: OTHER_MAILBOX, accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
    });
    const [row] = await db.insert(organizerRequests).values({
      accountId: ACCT, mailboxId, kind: "screener.decide",
      payload: { scope: "sender", address: "person@example.com", decision: "yes", appliedFolder: "INBOX" },
      decidedAt: NOW, state: "sent", sentAt: NOW,
    }).returning({ id: organizerRequests.id });
    const m = fakeMeta();
    // A FRESH ack for the right request id, signed for the WRONG mailbox.
    m.store.set(1, formatAck({
      requestId: row!.id, mailboxId: OTHER_MAILBOX, outcome: "refused", reason: "conflict",
      ackedAt: NOW, key: KEY,
    }));

    const out = await driveOutstandingRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: readerAdapter(m), requestKey: KEY },
      { installId: "reader-install", kind: "local" }, NOW, noopLog,
    );

    expect(out.refused).toBe(0);
    const [after] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, row!.id));
    expect(after!.state).toBe("sent");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE CHEAPEST RECORD MUST NOT STARVE THE MOST EXPENSIVE GUARANTEE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Malformed records used to be taken FIRST and out of the SAME per-cycle ceiling as well-formed
 * ones, with the well-formed slice computed as whatever remained. A malformed record needs no
 * signature and no key — it need only carry the discriminator and then be unreadable — so anyone
 * with APPEND rights on the folder could hold a ceiling's worth of them in the read window and
 * every genuine, SIGNED decision would be deferred, every cycle, for as long as they kept
 * appending.
 *
 * The drain's own counters reported that as healthy work: a full count refused, zero applied, some
 * deferred. Nothing in the numbers says "the queue is being held open by junk".
 *
 * The two kinds cost different things — a malformed record is one ref in a batch that is already
 * being sent, while a well-formed one is a verify, a decode and a transaction — so they now have
 * separate allowances. Both are still bounded: an unbounded malformed sweep would hand the same
 * attacker an unbounded expunge instead.
 */
describe("malformed records do not consume the budget a signed decision needs", () => {
  /**
   * MUTATION WATCHED RED: put the well-formed slice back to
   * `wellFormed.slice(0, max(0, MAX - takeMalformed.length))` and `applied` is 0 — the genuine
   * decision is deferred behind junk that carries no signature at all.
   */
  it("a ceiling's worth of malformed records still leaves the signed decision applied", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();

    // A full ceiling of junk that merely SAYS it is a request. No signature, no key, no cost.
    for (let i = 0; i < REQUEST_DRAIN_MAX_PER_CYCLE; i++) {
      m.store.set(i + 1, `X-Ohmail-Request: 1\r\nSubject: junk ${i}\r\n\r\nbody`);
    }
    // …and ONE genuine decision, signed under this mailbox's key.
    const messageId = await seedHeldMessage(db, mailboxId, "person@example.com");
    m.store.set(REQUEST_DRAIN_MAX_PER_CYCLE + 1, decideRecord({ mailboxId, key: KEY }));

    const out = await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog,
    );

    // THE ASSERTION THIS CASE EXISTS FOR: the signed decision was carried out in the SAME cycle.
    expect(out.applied).toBe(1);
    expect(out.refused).toBe(REQUEST_DRAIN_MAX_PER_CYCLE);
    // …and it really was applied, not merely counted.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.desiredFolder).toBe("INBOX");
  });

  /**
   * AND BOTH ALLOWANCES ARE STILL CEILINGS. Separate does not mean unbounded — an unbounded
   * malformed sweep is an unbounded expunge, which is the same attacker with a different verb.
   */
  it("the malformed allowance is itself bounded, and the excess is deferred", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const extra = 25;
    for (let i = 0; i < REQUEST_DRAIN_MAX_PER_CYCLE + extra; i++) {
      m.store.set(i + 1, `X-Ohmail-Request: 1\r\nSubject: junk ${i}\r\n\r\nbody`);
    }

    const out = await applyMetaRequests(
      db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog,
    );

    expect(out.refused).toBe(REQUEST_DRAIN_MAX_PER_CYCLE);
    expect(out.deferred).toBe(extra);
    // The folder shrinks by exactly the allowance — the rest is still there for the next cycle.
    expect(m.store.size).toBe(extra);
  });

  /* ── A FOLDER PAST THE WINDOW IS READ WHOLE, AND TIDIED AHEAD OF THE READ ─────────────────
   *
   * The drain once paged a folder past the record window and kept a cursor between cycles; the
   * one door reads it whole now (up to the enumeration's ceiling), so the cases below pin what one
   * read must cover: requests under three windows of acknowledgements, below a hole in the uid
   * space, a folder of requests past the window, and a standing record a newer ohmail wrote. The ack
   * sweep and the compaction still run AHEAD of the read: the sweep is the one thing that makes the
   * folder smaller. MUTATION WATCHED RED: move the sweep behind the read and `order[0]` is `list`.
   */
  /**
   * ── A RECORD THIS BUILD CANNOT SETTLE IS NOT WORK PENDING HERE ────────────────────────────
   *
   * A request written by a newer ohmail is left standing on purpose: it is not ours to apply and
   * not ours to destroy, and it must not stop the older requests in the same folder.
   */
  it("a standing future-protocol request does not stop the older ones beneath it", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    const fresh = new Date(NOW.getTime() - 60_000);

    /* OLDEST: ordinary decisions this build can settle. */
    let uid = 100;
    for (let i = 0; i < 5; i++) {
      m.store.set(uid++, decideRecord({ requestId: `older-${i}`, mailboxId, key }));
    }
    /* ABOVE THEM: one record from a protocol this build does not implement, which will still be
     * standing on every future cycle. */
    m.store.set(3_000, decideRecord({
      requestId: "from-a-newer-ohmail", mailboxId, key, protocol: REQUEST_PROTOCOL + 1,
    }));
    /* And enough fresh acknowledgements above that to take the folder past the window. */
    for (let i = 0; i <= META_RECORDS_MAX_PER_FETCH; i++) {
      const u = 4_000 + i;
      m.store.set(u, formatAck({
        requestId: `ack-${i}`, mailboxId, outcome: "applied", ackedAt: fresh, key,
      }));
      m.ackDates.set(u, fresh);
    }

    const runOnce = async (): Promise<{ applied: number }> => applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    /* However many cycles the drain needs, it must settle what is BELOW the standing record. */
    let applied = 0;
    for (let cycle = 0; cycle < 8 && applied === 0; cycle++) {
      applied = (await runOnce()).applied;
    }

    expect(applied,
      "the drain stopped on a record it can never settle, so the older decisions never applied")
      .toBeGreaterThan(0);
  });

  /**
   * ── THE CLOCK CUTS A PASS SHORT AS SURELY AS THE COUNT DOES ───────────────────────────────
   *
   * A pass takes the records it is allowed, gets through some, and defers the rest when its time
   * budget runs out. The deferred ones are still in the folder, so the next cycle's read settles
   * them. The clock is stubbed rather than waited on.
   */
  /**
   * ── THE SEAM REFUSES A RUNTIME IT CANNOT ATTRIBUTE ────────────────────────────────────────
   *
   * What this pass remembers about a mailbox belongs to ONE install on ONE mailbox, and the tests in
   * this package are not typechecked, so the check is at RUN time.
   *
   * MUTATION WATCHED RED: drop the assertion and a runtime with no install is accepted.
   */
  it("refuses a runtime with no install, rather than remembering under nothing", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();

    await expect(applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: "  ", adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    )).rejects.toThrow(/no usable install id/);
  });

  it("holds its place when the clock, not the count, cut the pass short", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    const fresh = new Date(NOW.getTime() - 60_000);

    const HOW_MANY = 5;
    for (let i = 0; i < HOW_MANY; i++) {
      m.store.set(100 + i, decideRecord({ requestId: `slow-${i}`, mailboxId, key }));
    }
    for (let i = 0; i <= META_RECORDS_MAX_PER_FETCH; i++) {
      const u = 900 + i;
      m.store.set(u, formatAck({
        requestId: `ack-${i}`, mailboxId, outcome: "applied", ackedAt: fresh, key,
      }));
      m.ackDates.set(u, fresh);
    }

    const runOnce = async (slow: boolean): Promise<number> => {
      const realNow = Date.now;
      if (slow) {
        let calls = 0;
        const base = realNow();
        // The first sample is the pass's start; everything after it looks an hour later.
        Date.now = (): number => (calls++ === 0 ? base : base + 3_600_000);
      }
      try {
        const out = await applyMetaRequests(
          db,
          { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
          NOW,
          noopLog,
        );
        return out.applied;
      } finally {
        Date.now = realNow;
      }
    };

    const first = await runOnce(true);
    const second = await runOnce(false);

    expect(first, "the clock stub did not defer anything, so this proves nothing")
      .toBeLessThan(HOW_MANY);
    expect(first + second,
      "the pass moved its bound below records its own clock had deferred, and they were skipped")
      .toBe(HOW_MANY);
  });

  it("settles what is below a hole in the uid space", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    const fresh = new Date(NOW.getTime() - 60_000);

    /* The requests, at the bottom of the folder. */
    const BURIED = 40;
    for (let i = 0; i < BURIED; i++) {
      m.store.set(100 + i, decideRecord({ requestId: `under-the-hole-${i}`, mailboxId, key }));
    }
    /* THE HOLE: nothing at all between here and the acknowledgements above, wider than one window. */
    const ABOVE = 3_000;
    for (let i = 0; i <= META_RECORDS_MAX_PER_FETCH; i++) {
      const u = ABOVE + i;
      m.store.set(u, formatAck({
        requestId: `ack-${i}`, mailboxId, outcome: "applied", ackedAt: fresh, key,
      }));
      m.ackDates.set(u, fresh);   // fresh, so the sweep leaves them where they are
    }

    const out = await applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    expect(out.applied + out.refused + out.deferred,
      "nothing below the hole was ever reached").toBeGreaterThan(0);
  });

  it("reads past three windows of acknowledgements in one read and settles what is underneath", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    // Fresh — the sweep will not take these, which is the whole point of the shape.
    const fresh = new Date(NOW.getTime() - 60_000);

    /* OLDEST FIRST, so the requests end up BELOW three pages of acknowledgements by uid. */
    let uid = 100;
    for (let i = 0; i < 40; i++) {
      m.store.set(uid++, decideRecord({ requestId: `buried-${i}`, mailboxId, key }));
    }
    for (let page = 0; page < 3; page++) {
      for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) {
        const u = uid++;
        m.store.set(u, formatAck({
          requestId: `ack-${page}-${i}`, mailboxId, outcome: "applied", ackedAt: fresh, key,
        }));
        m.ackDates.set(u, fresh);
      }
    }

    const res = await applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    expect(res.applied, "the read never reached the requests under the acknowledgements")
      .toBeGreaterThan(0);
    /* ONE READ, the whole folder: no page, no cursor. */
    expect(m.listCalls, "the drain read the folder more than once").toBe(1);
  });

  it("reads a folder of REQUESTS past the window whole and settles them", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();

    /* A full window already in the folder, then ten from each of two writers that measured the same
     * headroom — the joint crossing, by its result. Every one is a signed decision; none is
     * stale, so the sweep has nothing to take. */
    let uid = 6000;
    for (let i = 0; i < 490; i++) {
      m.store.set(uid++, decideRecord({ requestId: `settled-${i}`, mailboxId, key: KEY }));
    }
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < 10; i++) {
        m.store.set(uid++, decideRecord({ requestId: `w${w}-${i}`, mailboxId, key: KEY }));
      }
    }
    const before = m.store.size;
    expect(before, "the folder is not over the ceiling, so this case proves nothing")
      .toBeGreaterThan(META_RECORDS_MAX_PER_FETCH);

    const res = await applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    /* THE DECISIONS ARE UNSTUCK, which is what the wholesale refusal made impossible for ever. */
    expect(res.applied, "the drain refused the whole folder, so nothing was ever settled")
      .toBeGreaterThan(0);

    /* ── AND THE REQUESTS ARE GONE, WHICH IS THE SHRINK THAT ACTUALLY HAPPENS ───────────────
     *
     * The first version of this asserted `store.size` fell, and it went red at 510 → 510. That
     * was the code being honest and the assertion being wrong: settling a request APPENDS an
     * acknowledgement in its place, so the record count holds while the requests convert. The
     * count comes back under the ceiling a DAY later, when those acknowledgements pass the
     * sweep's day-floored cutoff — not on this cycle, and saying otherwise was describing a
     * folder full of a different thing.
     *
     * What is true now, and is the recovery this page-at-a-time drain provides: the requests
     * themselves are settled and out of the folder. */
    const requestsLeft = [...m.store.values()].filter((r) => r.includes("X-Ohmail-Request:")).length;
    expect(requestsLeft, "the requests were not settled, so the folder is stuck on them")
      .toBeLessThan(510);
    expect(m.store.size, "the folder lost records it should have replaced with acknowledgements")
      .toBe(before);
  });

  it("sweeps stale acks BEFORE the read, so a full folder can shrink", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    /* ── STALE BY A DAY, NOT BY A MINUTE, BECAUSE THE SWEEP DELETES BY DATE ────────────────
     *
     * The cutoff is floored to the start of its UTC day: the server searches BEFORE a DATE, and a
     * cutoff carrying a time of day is widened forward by the client — right for a reader, wrong
     * for something that deletes. So an acknowledgement a minute past its nominal life is usually
     * NOT swept, because it was filed on the cutoff's own day.
     *
     * This seeded exactly that, and passed only because the fake compared the raw instant — more
     * permissive than production. With the fake using production's own cutoff function, a
     * minute-past-the-life acknowledgement survives and the recovery this case asserts does not
     * happen. Three days old is stale by any reading, which is what the case means. */
    const stale = new Date(NOW.getTime() - 3 * 86_400_000);

    let uid = 9000;
    for (let i = 0; i < 501; i++) {
      const raw = formatAck({
        requestId: `old-${i}`, mailboxId, outcome: "applied", ackedAt: stale, key,
      });
      m.store.set(uid, raw);
      m.ackDates.set(uid, stale);
      uid += 1;
    }
    // …and one fresh request, which must still be applied on the cycle that unblocked the folder.
    m.store.set(uid, decideRecord({ requestId: "the-request", mailboxId, key }));
    const before = m.store.size;

    const res = await applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    expect(m.order[0], "the read ran before the sweep, so a full folder could never shrink")
      .toBe("sweep");
    expect(m.order, "the read never happened at all").toContain("list");
    expect(m.store.size, "the folder did not shrink").toBeLessThan(before);
    expect(res.applied, "the request was not applied on the cycle that unblocked the folder")
      .toBeGreaterThan(0);
  });

  /**
   * ── AND THE COMPACTION RUNS BESIDE THE SWEEP, FOR THE SWEEP'S REASON ────────────────────────
   *
   * The sweep makes `ohmail/_meta` smaller and nothing made it SHALLOWER: a uid is spent per
   * renewal and never returned, so the folder's records end up further below the top of its uid
   * space than any bounded read reaches, and from then on every gate refuses. Both belong AHEAD of
   * the read they unblock, and neither may stop the drain — a folder that could not be tidied is
   * where this was a moment ago.
   */
  it("compacts the folder ahead of the read, and a compaction that refuses does not stop the drain", async () => {
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    const m = fakeMeta();
    const key = KEY;
    m.compactThrows = true;
    m.store.set(9000, decideRecord({ requestId: "the-request", mailboxId, key }));

    const res = await applyMetaRequests(
      db,
      { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY },
      NOW,
      noopLog,
    );

    expect(m.order.slice(0, 2),
      "the folder is read before it is tidied, so a folder out of reach can never come back")
      .toEqual(["sweep", "compact"]);
    expect(res.applied, "a compaction that refused stopped a drain that could still work")
      .toBeGreaterThan(0);
  });
});

/**
 * A READER'S PRESS THAT REACHES ITS DOOR A DAY LATE (mail 0145). The record keeps its creation
 * instant, which both 24 h windows age by, and the press instant travels as `payload.pressedAt`: the
 * organizer applies it over nothing newer and refuses it `superseded` behind a newer placement.
 */
describe("the press instant travels in the payload, the record keeps its own", () => {
  const HOUR = 3_600_000;
  it("a reader door writes decided_at = now and payload.pressedAt = the press; nothing expires it", async () => {
    const { messageService } = await import("@trafficflow/services");
    const db = await makeTestDb();
    const mailboxId = await seedMailbox(db);
    await db.update(mailboxes).set({
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests,moves",
      organizedByKind: "local", organizedByName: "laptop", trashFolder: "Trash",
    }).where(eq(mailboxes.id, mailboxId));
    const id = await seedHeldMessage(db, mailboxId, "person@example.com");
    const floor = new Date(NOW.getTime() - 25 * HOUR);
    const ctx = { db, accountId: ACCT, userId: null, now: () => NOW, requestId: "r", pressFloor: floor, pressAged: true };
    const res = await messageService.move(ctx as never, id, { folder: "ohmail/Receipts" });
    expect((res as { pending?: boolean }).pending).toBe(true);
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, ACCT));
    expect(row!.decidedAt.getTime()).toBe(NOW.getTime());
    expect((row!.payload as { pressedAt?: string }).pressedAt).toBe(floor.toISOString());
    const drive = await driveOutstandingRequests(
      db as never,
      { mailboxId, accountId: ACCT, installId: "cloud-1", adapter: { requestReaderIo: () => ({}) } as never, requestKey: null },
      { installId: "cloud-1", kind: "cloud" }, NOW, noopLog,
    );
    expect(drive.expired).toBe(0);
  });

  it("the organizer applies a day-old press over nothing newer, and refuses it superseded behind a newer placement", async () => {
    for (const newer of [false, true]) {
      const db = await makeTestDb();
      const mailboxId = await seedMailbox(db);
      const messageId = await seedHeldMessage(db, mailboxId, "person@example.com");
      const [row] = await db.select({ dedupKey: messages.dedupKey }).from(messages).where(eq(messages.id, messageId));
      if (newer) await db.update(folderState).set({ decidedAt: new Date(NOW.getTime() - 24 * HOUR) }).where(eq(folderState.messageId, messageId));
      const m = fakeMeta();
      await m.reader.append(moveRecord({
        mailboxId, key: KEY, dedupKey: row!.dedupKey, destination: "reads", pressedAt: new Date(NOW.getTime() - 25 * HOUR),
      }));
      const result = await applyMetaRequests(db, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: organizerAdapter(m), requestKey: KEY }, NOW, noopLog);
      const acks = acksIn([...m.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
      expect([newer, result.applied, result.refused, acks[0]?.reason ?? null, fs!.desiredFolder]).toEqual(newer
        ? [true, 0, 1, "superseded", "ohmail/Screener"]
        : [false, 1, 0, null, "ohmail/News"]);
    }
  });
});
