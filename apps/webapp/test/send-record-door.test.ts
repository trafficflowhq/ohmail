/** @vitest-environment jsdom */
/**
 * THE ONE DOOR A SEND RECORD LEAVES BY. A record is never
 * deleted while its key is owed; one that is not owed goes when its send ended, when a newer record
 * of its lane replaces it, or when it aged. Each reason is driven both ways through the function
 * that asks for it, so a door that ignored `owed` and one that refused everything both read red.
 * Beside it: two records on the compose lane, each found by the reader that names it, and the
 * hold's read over a jar of thousands of records, as a reading.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  allSendLocks, claimSendLock, releaseSendLock, releaseSendLockForRow, resumeSendLock, sendIdentity,
  sendLocksKey, SEND_LOCK_FORMAT, SEND_LOCK_TTL_MS, type SendLock,
} from "@ohmail/app-logic/writing/send-lock";
import { sendUnsettledFromLastSession } from "@ohmail/app-logic/writing/mail-send";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const owedOnly = (...keys: string[]) => (k: string): boolean => keys.includes(k);
const NONE = owedOnly();
// A record names its message (`subject`): a nameless one is the retired 0.14.0 shape `load` drops.
const rec = (o: Partial<SendLock> & { key: string }): SendLock => ({
  v: SEND_LOCK_FORMAT, lane: "compose", at: NOW, draftId: null, fp: `fp-${o.key}`, subject: `name:${o.key}`, ...o,
});
const put = (rows: SendLock[]): void => window.localStorage.setItem(sendLocksKey(null), JSON.stringify(rows));
const keys = (): string[] => (JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as SendLock[]).map((r) => r.key).sort();

beforeEach(() => { window.localStorage.clear(); });

describe("each reason a record goes, asked of an owed and of a settled key", () => {
  it("ENDED: releaseSendLock keeps an owed record and drops the settled one", () => {
    put([rec({ key: "K-owed", lane: "m-1", fp: "fp-a" }), rec({ key: "K-done", lane: "m-2", fp: "fp-a" })]);
    releaseSendLock("m-1", "fp-a", owedOnly("K-owed"), null);
    releaseSendLock("m-2", "fp-a", owedOnly("K-owed"), null);
    expect(keys()).toEqual(["K-owed"]);
  });

  it("ENDED by row: releaseSendLockForRow keeps an owed record and drops the settled one", () => {
    put([rec({ key: "K-owed", draftId: "d1" }), rec({ key: "K-done", draftId: "d2" })]);
    releaseSendLockForRow("compose", "d1", null, owedOnly("K-owed"), null);
    releaseSendLockForRow("compose", "d2", null, owedOnly("K-owed"), null);
    expect(keys()).toEqual(["K-owed"]);
  });

  it("REPLACED: a new claim on the lane keeps the owed record and evicts the settled one", () => {
    put([rec({ key: "K-owed", session: "s-1" }), rec({ key: "K-done", session: "s-2" })]);
    claimSendLock(rec({ key: "K-new", session: "s-3" }), owedOnly("K-owed"), null);
    expect(keys()).toEqual(["K-new", "K-owed"]);
  });

  it("REPLACED by the press's spent sweep: resume keeps the owed record of other words and drops the settled one", () => {
    put([rec({ key: "K-owed", fp: "fp-old-1" }), rec({ key: "K-done", fp: "fp-old-2" })]);
    resumeSendLock("compose", { fp: "fp-new", subjects: [], session: null, draftId: null }, NOW, owedOnly("K-owed"), null);
    expect(keys()).toEqual(["K-owed"]);
  });

  it("AGED: the hold's read keeps an owed eight-day record, drops the settled one, keeps anything young or unverified", () => {
    const old = NOW - 8 * DAY;
    put([
      rec({ key: "K-owed", lane: "m-1", at: old }), rec({ key: "K-done", lane: "m-2", at: old }),
      rec({ key: "K-young", lane: "m-3", at: NOW - SEND_LOCK_TTL_MS + 1 }), rec({ key: "K-unverified", lane: "m-4", at: old, unverified: true }),
    ]);
    expect(allSendLocks(NOW, owedOnly("K-owed"), null).map((r) => r.key).sort()).toEqual(["K-owed", "K-unverified", "K-young"]);
    expect(keys()).toEqual(["K-owed", "K-unverified", "K-young"]);
  });

  it("a later format's record is never deleted, for any reason", () => {
    put([rec({ key: "K-later", v: SEND_LOCK_FORMAT + 1, at: NOW - 30 * DAY, fp: "fp-a" })]);
    releaseSendLock("compose", "fp-a", NONE, null);
    claimSendLock(rec({ key: "K-new" }), NONE, null);
    allSendLocks(NOW, NONE, null);
    expect(keys()).toEqual(["K-later", "K-new"]);
  });

  it("before the outbox is read every key is owed, so nothing goes on any lane", () => {
    const old = NOW - 8 * DAY;
    put([rec({ key: "K-1", at: old }), rec({ key: "K-2", lane: "m-1", at: old, fp: "fp-x" })]);
    const unread = (): boolean => true;
    allSendLocks(NOW, unread, null);
    releaseSendLock("m-1", "fp-x", unread, null);
    claimSendLock(rec({ key: "K-3" }), unread, null);
    expect(keys()).toEqual(["K-1", "K-2", "K-3"]);
  });
});

describe("two records on the compose lane: each reader finds its own", () => {
  const msgA = { kind: "mail_send", inReplyTo: null, body: "A", subject: "a", to: [{ name: null, address: "a@x.test" }], mailboxId: "mb-1" };
  const msgB = { ...msgA, body: "B" };

  it("resume picks by words and session, the hold by buffer fingerprint, and the older one is evicted only once it is not owed", () => {
    const a = sendIdentity(msgA as never, "s-a");
    const b = sendIdentity(msgB as never, "s-b");
    claimSendLock({ v: SEND_LOCK_FORMAT, lane: "compose", key: "K-a", at: NOW - DAY, draftId: null, fp: a.fp, session: "s-a", subject: "compose:s-a", bfp: "bfp-a" }, NONE, null);
    // B's press while A's send is still owed: A stays beside it.
    claimSendLock({ v: SEND_LOCK_FORMAT, lane: "compose", key: "K-b", at: NOW, draftId: null, fp: b.fp, session: "s-b", subject: "compose:s-b", bfp: "bfp-b" }, owedOnly("K-a"), null);
    expect(keys()).toEqual(["K-a", "K-b"]);
    const owed = owedOnly("K-a", "K-b");
    expect({
      resumeA: resumeSendLock("compose", a, NOW, owed, null),
      resumeB: resumeSendLock("compose", b, NOW, owed, null),
      resumeAInB: resumeSendLock("compose", { ...a, session: "s-b" }, NOW, owed, null),
    }).toEqual({ resumeA: "K-a", resumeB: "K-b", resumeAInB: null });
    const pendingOnly = (k: string): boolean => !owed(k);
    const hold = (fp: string, session: string, settled: (k: string) => boolean): boolean =>
      sendUnsettledFromLastSession("compose", { fp, session }, new Set(), false, null, { settled, owed: (k) => !settled(k) });
    expect({
      holdA: hold("bfp-a", "s-a", pendingOnly), holdB: hold("bfp-b", "s-b", pendingOnly),
      holdOther: hold("bfp-c", "s-c", pendingOnly),
      holdAOnceSettled: hold("bfp-a", "s-a", (k) => k === "K-a"),
    }).toEqual({ holdA: true, holdB: true, holdOther: false, holdAOnceSettled: false });
    expect(keys(), "a read evicted an owed record").toEqual(["K-a", "K-b"]);
    // A's send has ended: the next press of B's words sweeps A as replaced.
    resumeSendLock("compose", b, NOW, owedOnly("K-b"), null);
    expect(keys()).toEqual(["K-b"]);
  });
});

describe("the hold's read over a large jar (a reading, not a gate)", () => {
  it("1,000 aged records, every one owed: kept, and the read stays under 50 ms on this host", () => {
    const old = NOW - 8 * DAY;
    put(Array.from({ length: 1000 }, (_, i) => rec({
      key: `K-${i}`, lane: i % 2 ? "compose" : `m-${i}`, at: old, session: `s-${i}`, subject: `compose:s-${i}`, bfp: `bfp-${i}`,
    })));
    const all = (): boolean => true;
    const t0 = performance.now();
    for (let r = 0; r < 20; r++) {
      sendUnsettledFromLastSession("compose", { fp: "bfp-none", session: "s-none" }, new Set(), false, null, { settled: () => false, owed: all });
    }
    const perRead = (performance.now() - t0) / 20;
    console.log(`1000-record jar hold read: ${perRead.toFixed(2)} ms per read, ${window.localStorage.getItem(sendLocksKey(null))!.length} bytes`);
    expect(keys()).toHaveLength(1000);
    expect(perRead).toBeLessThan(50);
  });
});
