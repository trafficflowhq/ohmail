import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { REFILE_HOLD_MS } from "@trafficflow/core/mail";
import {
  accounts, applyRuleRequest, approvals, changeLog, drafts, folderState, mailboxes, messageStates, messages, rules, threads,
  type LedgerTx, type Tx,
} from "@trafficflow/db";
import { MessageService, RulesService, type ServiceContext } from "@trafficflow/services";
import { ruleRetroPass } from "../src/rule-retro.js";
import {
  REFILE_FIXTURE, REFILE_FROM, REFILE_MOVES, REFILE_TO,
} from "../../../test/support/retro-candidates.js";

/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

/**
 * A RULE ABOUT A SENDER NEVER MOVES A LETTER WHOSE PLACE SOMEBODY DECIDED (`folder_state.decided_at`):
 * the person's own move (a decision once moved 42 earlier letters out of News) and an
 * answer the gate admitted for itself alone (screening the stranger out would have
 * taken the answer with it). Their undecided mail still moves: the decision does what it names.
 */

const OHBOX = "INBOX";
const NEWS = "ohmail/News";
const SCREENED = "ohmail/Screened";
const GATE = "ohmail/Screener";
const STRANGER = "b+r31x@answers.example";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `decided-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  const letter = async (folder: string, decidedAt: Date | null): Promise<string> => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "the north elevation", fromAddress: STRANGER, nativeLocator: { folder, ref: "1:1" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false, decidedAt,
    });
    return m!.id;
  };
  const decide = async (destination: string) => {
    await db.insert(rules).values({
      accountId, kind: "sender", match: STRANGER, destination, provenance: "promoted", enabled: true,
      retroRequestedAt: new Date("2026-10-10T06:50:00Z"), personDecidedAt: new Date("2026-10-10T06:50:00Z"),
    });
    return ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE }, new Date("2026-10-10T06:51:00Z"));
  };
  const at = async (id: string) => (await db.select({ d: folderState.desiredFolder }).from(folderState)
    .where(eq(folderState.messageId, id)))[0]!.d;
  return { letter, decide, at };
}

describe("the retro leaves a place somebody decided", () => {
  it("screening the stranger out moves neither their admitted answer nor a letter the person filed", async () => {
    const w = await world();
    const answer = await w.letter(OHBOX, new Date("2026-10-10T06:42:45Z"));
    const filed = await w.letter(NEWS, new Date("2026-10-09T08:00:00Z"));
    const undecided = await w.letter(OHBOX, null);
    const res = await w.decide(SCREENED);
    expect([await w.at(answer), await w.at(filed)]).toEqual([OHBOX, NEWS]);
    // CONTROL: the decision still moves what it names, the sender's undecided mail.
    expect(await w.at(undecided)).toBe(SCREENED);
    expect(res.moved).toBe(1);
  });

  it("CONTROL: a letter put back at the gate waits for this decision, and the decision moves it", async () => {
    const w = await world();
    const back = await w.letter(GATE, new Date("2026-10-09T08:00:00Z"));
    await w.decide(NEWS);
    expect(await w.at(back)).toBe(NEWS);
  });

  it("CONTROL: an admission into the Ohbox moves undecided mail filed elsewhere", async () => {
    const w = await world();
    const news = await w.letter(NEWS, null);
    await w.decide(OHBOX);
    expect(await w.at(news)).toBe(OHBOX);
  });
});

/* A RULES-PAGE CHANGE (a refile walk: `refile_at = retro_requested_at`) re-files the rule's own pile,
   decided before the press included, and nothing else; every other walk keeps clause 7. */
describe("the refile walk moves the rule's pile and nothing else", () => {
  const PRESS = new Date("2026-10-24T19:07:18Z");
  const AFTER = new Date(PRESS.getTime() + REFILE_HOLD_MS + 1000);
  async function pile(refile: boolean) {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `refile-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    const ids = new Map<string, string>();
    for (const r of REFILE_FIXTURE) {
      const dedup = `mid:${randomUUID()}`;
      const [thread] = r.serverOnly === "answered"
        ? await db.insert(threads).values({ accountId, subject: "a conversation" }).returning() : [];
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject: r.why, fromAddress: STRANGER, nativeLocator: { folder: r.folder, ref: "1:1" },
        ...(thread ? { threadId: thread.id } : {}),
      }).returning();
      const decidedAt = r.decided === "before" ? new Date(PRESS.getTime() - 60_000)
        : r.decided === "after" ? new Date(PRESS.getTime() + 1000) : null;
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: r.folder, observedFolder: r.folder,
        lastSetBy: r.serverOnly === "external" ? "external" : "us", reconcileStatus: "reconciled", conflict: false, decidedAt,
      });
      if (r.triage) await db.insert(messageStates).values({ accountId, messageId: m!.id, state: r.triage });
      if (r.serverOnly === "draft") {
        await db.insert(drafts).values({ accountId, mailboxId: mb!.id, inReplyToMessageId: m!.id, subject: "re", body: "…", status: "draft" });
      }
      if (r.serverOnly === "approval") {
        await db.insert(approvals).values({ accountId, messageId: m!.id, kind: "routing", action: "file", status: "approved", payload: {} });
      }
      if (thread) {
        const own = `mid:${randomUUID()}`;
        await db.insert(messages).values({
          accountId, mailboxId: mb!.id, messageIdHeader: own, bodyHash: randomUUID(), dedupKey: own,
          subject: "re", fromAddress: mb!.address, threadId: thread.id, nativeLocator: { folder: "ohmail/Sent", ref: "2:1" },
        });
      }
      ids.set(r.id, m!.id);
    }
    await db.insert(rules).values({
      accountId, kind: "sender", match: STRANGER, destination: REFILE_TO, provenance: "manual", enabled: true,
      retroRequestedAt: PRESS, ...(refile ? { refileFrom: REFILE_FROM, refileAt: PRESS } : {}),
    });
    const res = await ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE }, AFTER);
    const moved: string[] = [];
    for (const r of REFILE_FIXTURE) {
      const [f] = await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, ids.get(r.id)!));
      if (f!.d !== r.folder) moved.push(r.id);
    }
    return { res, moved };
  }

  it("moves exactly the pile: decided before the press in, after it out, every exclusion kept", async () => {
    const { res, moved } = await pile(true);
    for (const r of REFILE_FIXTURE) {
      expect(moved.includes(r.id), `${r.id} — ${r.why}`).toBe(REFILE_MOVES.includes(r.id));
    }
    expect(res.moved).toBe(REFILE_MOVES.length);
  });

  it("CONTROL: the ordinary walk still leaves a decided place and moves the Ohbox", async () => {
    const { moved } = await pile(false);
    expect(moved).not.toContain("f-decided-before");
    expect(moved).toContain("f-ohbox");
  });
});

/* THE PROBE: a second mailbox only read here, so the walk parks instead of stamping. A Change News ->
   Receipts, its walk past the hold, and a day later Receipts -> Screened, each applied as the
   organizer applies the travelled request: the second walk re-files the letter from Receipts. */
describe("with a mailbox only read here, a later Change re-files from where the rule files", () => {
  const PRESS = new Date("2026-10-24T19:07:18Z");
  const LATER = new Date(PRESS.getTime() + 24 * 3600_000);
  const past = (t: Date) => new Date(t.getTime() + REFILE_HOLD_MS + 1000);

  it("the second walk moves the letter from Receipts, and the reader's stays", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `probe-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    const [rb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `read-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "reader",
    }).returning();
    const letter = async (mailboxId: string): Promise<string> => {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject: "the hostpoint invoice", fromAddress: STRANGER, nativeLocator: { folder: NEWS, ref: "1:1" },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: NEWS, observedFolder: NEWS, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    const ours = await letter(mb!.id);
    const theirs = await letter(rb!.id);
    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: STRANGER, destination: NEWS, provenance: "manual", enabled: true,
      retroRequestedAt: new Date("2026-10-20T08:00:00Z"), retroDoneAt: new Date("2026-10-20T08:01:00Z"),
    }).returning();
    const key = { kind: "sender", match: STRANGER, subjectContains: null, bodyContains: null };
    const change = (destination: string, now: Date) => (db as unknown as Tx).transaction((tx) => applyRuleRequest(
      tx as unknown as LedgerTx,
      { accountId, now, payload: { op: "update", key, set: { destination }, applyRetro: false, retroAsked: false, refile: true } },
    ));
    const walk = (now: Date) => ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE }, now);
    const at = async (id: string) => (await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, id)))[0]!.d;
    const deltas = async () => (await db.select({ op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.entityType, "rule"), eq(changeLog.entityId, rule!.id)))).length;

    await change("ohmail/Receipts", PRESS);
    const told = await deltas();
    expect((await walk(past(PRESS))).moved).toBe(1);
    const toldAfterWalk = await deltas();
    await change(SCREENED, LATER);
    const second = await walk(past(LATER));
    expect(second.moved, "the second walk re-filed from News, where none of the rule's mail is").toBe(1);
    expect([await at(ours), await at(theirs)]).toEqual([SCREENED, NEWS]);
    expect(toldAfterWalk, "the walk ended the origin and told no client").toBe(told + 1);
  });
});

/* A SENDER DECISION'S OWN LETTER IS THE DECISION'S: the sheet files the letter it was pressed on
   itself (`pressRule`), the walk files the rest, and the next decision takes all of them along. */
describe("the letter a sender decision was made on follows the next decision", () => {
  const PIA = "pia.grove@pantry.example";
  async function sheet(n: number, decided: ReadonlyMap<number, Date> = new Map()) {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `press-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    let now = new Date("2026-10-26T10:48:00Z");
    const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => now, requestId: "press" };
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject: `Review pantry thistle ${875 + i}`, fromAddress: PIA, nativeLocator: { folder: OHBOX, ref: `1:${i + 1}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: "us",
        reconcileStatus: "reconciled", conflict: false, decidedAt: decided.get(i) ?? null,
      });
      ids.push(m!.id);
    }
    const mail = new MessageService();
    const ruleSvc = new RulesService();
    let ruleId: string | null = null;
    const step = () => { now = new Date(now.getTime() + 60_000); };
    /** The sheet's press on `seed` with past mail on: its move now, the rule as the window closes, the walk. */
    const press = async (seed: string, to: string) => {
      await mail.move(ctx, seed, { folder: to, pressRule: true });
      step();
      if (ruleId === null) {
        ruleId = ((await ruleSvc.create(ctx, { kind: "sender", match: PIA, destination: to, applyRetro: true })) as { rule: { id: string } }).rule.id;
      } else await ruleSvc.update(ctx, ruleId, { destination: to, applyRetro: true });
      step();
      await ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE }, now);
    };
    const count = async (folder: string) => (await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(inArray(folderState.messageId, ids))).filter((r) => r.d === folder).length;
    const at = async (id: string) => (await db.select({ d: folderState.desiredFolder }).from(folderState)
      .where(eq(folderState.messageId, id)))[0]!.d;
    /** A release off a shelf: the letters there move as the rule's, the rule is retargeted, the walk. */
    const release = async (from: string, to: string) => {
      for (const id of ids) if ((await at(id)) === from) await mail.move(ctx, id, { folder: to, pressRule: true });
      step();
      await ruleSvc.update(ctx, ruleId!, { destination: to, applyRetro: true });
      step();
      await ruleRetroPass(db as never, { accountId, trustedAuthservIdsFor: NONE }, now);
    };
    return { ctx, ids, mail, press, release, count, at };
  }

  it("to News and back to the Ohbox, past mail on both times: all 23 come back", async () => {
    const w = await sheet(23);
    await w.press(w.ids[0]!, NEWS);
    expect(await w.count(NEWS)).toBe(23);
    await w.press(w.ids[5]!, OHBOX);
    expect([await w.count(OHBOX), await w.count(NEWS)], "the first press's letter came back too").toEqual([23, 0]);
  });

  it("screened out, released to the Ohbox, then to News: every letter goes to News", async () => {
    const w = await sheet(6);
    await w.press(w.ids[0]!, SCREENED);
    await w.release(SCREENED, OHBOX);
    expect(await w.count(OHBOX)).toBe(6);
    await w.press(w.ids[1]!, NEWS);
    expect([await w.count(NEWS), await w.count(OHBOX)], "the released letters stayed behind").toEqual([6, 0]);
  });

  it("CONTROL: a letter moved by hand stays where it was put", async () => {
    const w = await sheet(3);
    await w.mail.move(w.ctx, w.ids[2]!, { folder: "ohmail/Receipts" });
    await w.press(w.ids[0]!, NEWS);
    expect([await w.at(w.ids[1]!), await w.at(w.ids[2]!)]).toEqual([NEWS, "ohmail/Receipts"]);
  });

  it("Undo of the press leaves each letter's own decision as it was", async () => {
    const answered = new Date("2026-10-20T08:00:00Z");
    const w = await sheet(3, new Map([[1, answered]]));
    for (const seed of [w.ids[0]!, w.ids[1]!]) {
      await w.mail.move(w.ctx, seed, { folder: NEWS, pressRule: true });
      const back = await w.mail.move(w.ctx, seed, { folder: OHBOX, pressRule: true });
      expect("dto" in back && back.dto.placeDecided === true, seed === w.ids[1] ? "the answer" : "the undecided letter").toBe(seed === w.ids[1]);
    }
    // A screen-out with past mail moves the undecided letter and leaves the admitted answer.
    await w.press(w.ids[2]!, SCREENED);
    expect([await w.at(w.ids[0]!), await w.at(w.ids[1]!)]).toEqual([SCREENED, OHBOX]);
  });
});
