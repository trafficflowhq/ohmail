import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { contacts, drafts, mailboxes, outboundSendFingerprints, outboundSends } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createLogger, SendNotSubmitted } from "@trafficflow/core";
import type { OpenSendAdapter, OutboundMessage, SendOptions } from "@trafficflow/core";
import { SendService } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { SEND_SETTLE_WAITS_MS } from "../src/send-service.js";

/**
 * THE SEND PATH'S LOCK ORDER, AND WHAT A SETTLE DOES WHEN POSTGRES KILLS IT — on real Postgres.
 *
 * A settle is the transaction that writes what became of a send: `sent` after the server's 250,
 * `unverified`, `failed`, `sent` from a held row, or the row forgotten. Each wrote the reservation
 * row and then the draft row, while the draft's own writers (a same-key replay, Send again, the
 * person's answer for a held send, a discard) take the draft row and then a reservation row of it.
 * Two orders are a cycle, Postgres kills one side of it (40P01), and a killed settle after a 250
 * left a delivered letter `pending` with no Sent copy.
 *
 * What is held here:
 *  1. every settle waits for the draft row while it holds NOTHING of the reservation, so no writer
 *     that holds the draft can be waiting on it (one case per settle, the draft row held by a third
 *     connection and the reservation row then taken `NOWAIT` by a fourth);
 *  2. two settles of one account take the contacts they learn in one order;
 *  3. a settle Postgres kills is run again, and settles;
 *  4. when every try is killed after a 250, the Sent copy is filed all the same, so the letter is
 *     settled `sent` from its Sent folder and is never submitted twice.
 *
 * Each interleaving is forced by gates read in `pg_stat_activity`, never by a sleep or by load.
 * PGlite cannot run any of it: it is one connection.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-09-02T12:00:00.000Z");
const LATER = new Date(NOW.getTime() + 11 * 60 * 1000);
const DEADLOCK = "40P01";

const watch = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const dbW = brandDialect(drizzle(watch, { schema }), "pg");
const sleep15 = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 15); });
const codeOf = (e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  return String(x?.code ?? x?.cause?.code ?? x?.message ?? e);
};
type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };
const settled = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

/**
 * One party of a race: its own pool under its own application name, every error a transaction of
 * it ended on, and a plant. While `plant.armed`, each of its next `plant.left` transactions runs
 * its whole body and is then killed by the server with SQLSTATE 40P01, the error a deadlock's
 * victim gets, raised through the real driver.
 */
function party(name: string) {
  const app = `${name}-${randomUUID().slice(0, 8)}`;
  const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {}, connection: { application_name: app } });
  const db = brandDialect(drizzle(client, { schema }), "pg");
  const ended: string[] = [];
  const plant = { armed: false, left: 0, fired: 0 };
  type Body = (tx: { execute: (q: unknown) => Promise<unknown> }, ...more: unknown[]) => Promise<unknown>;
  const h = db as unknown as { transaction: (fn: Body, ...rest: unknown[]) => Promise<unknown> };
  const inner = h.transaction.bind(h);
  Object.defineProperty(h, "transaction", {
    configurable: true, writable: true,
    value: (fn: Body, ...rest: unknown[]) => inner(async (tx, ...more) => {
      const out = await fn(tx, ...more);
      if (plant.armed && plant.left > 0) {
        plant.left -= 1;
        plant.fired += 1;
        await tx.execute(sql`do $$ begin raise exception 'planted: this transaction is the deadlock victim' using errcode = '40P01'; end $$`);
      }
      return out;
    }, ...rest).catch((e: unknown) => { ended.push(codeOf(e)); throw e; }),
  });
  return { app, client, db, ended, plant };
}
type Party = ReturnType<typeof party>;

/** The statement a backend of `waiter` waits for a lock at, when one of `holder` blocks it (any backend when null). */
async function blockedOn(waiter: string, holder: string | null, ms = 15_000): Promise<string | null> {
  const end = Date.now() + ms;
  for (;;) {
    const rows = holder === null
      ? await watch<{ q: string }[]>`
          select w.query as q from pg_stat_activity w
           where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'`
      : await watch<{ q: string }[]>`
          select w.query as q from pg_stat_activity w
           where w.datname = current_database() and w.application_name = ${waiter} and w.wait_event_type = 'Lock'
             and exists (select 1 from pg_stat_activity h
                          where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`;
    if (rows[0]) return rows[0].q.replace(/\s+/g, " ");
    if (Date.now() >= end) return null;
    await sleep15();
  }
}

/** Waits for `seen` to answer true, looking every 15 ms; false when it never does within `ms`. */
async function until(seen: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await seen()) return true;
    if (Date.now() >= end) return false;
    await sleep15();
  }
}

/** A connection that takes one lock in a transaction and keeps it until `release()`. */
function holder(name: string) {
  const app = `${name}-${randomUUID().slice(0, 8)}`;
  const client = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, connection: { application_name: app } });
  let release: () => void = () => {};
  let done: Promise<unknown> = Promise.resolve();
  return {
    app,
    /** Resolves once `take` has run inside the open transaction. */
    hold(take: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
      return new Promise<void>((took, failed) => {
        const released = new Promise<void>((r) => { release = r; });
        done = client.begin(async (tx) => { await take(tx); took(); await released; }).catch(failed);
      });
    },
    async release(): Promise<void> { release(); await done; },
    async end(): Promise<void> { release(); await done; await client.end({ timeout: 5 }); },
  };
}

/** Whether the reservation row can be taken right now: `free`, or the code Postgres refused with. */
async function reservationRow(sendId: string): Promise<string> {
  try {
    await watch.begin(async (tx) => { await tx`select id from outbound_sends where id = ${sendId} for update nowait`; });
    return "free";
  } catch (e) {
    return codeOf(e);
  }
}

/**
 * A transport shaped as production's: the release gate is passed before the server can answer
 * (the row reads `complete`), the answer can be held, and the Sent copy is the caller's to file
 * (`copy: "caller"`), so `filed` says whether it ever was. `messageInSent` answers from that folder.
 * `onAccepted` runs as the server's 250 arrives.
 */
function transport(o: { hold?: boolean; onAccepted?: () => void; sentFolder?: string[] } = {}) {
  const state = { delivered: [] as OutboundMessage[], filed: o.sentFolder ?? [] as string[], probes: 0, dials: 0 };
  let release: () => void = () => {};
  const held = o.hold ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  const factory: OpenSendAdapter = async () => {
    state.dials += 1;
    return {
      async send(msg: OutboundMessage, opts?: SendOptions) {
        state.delivered.push(msg);
        try {
          await opts?.beforeRelease?.();
        } catch (err) {
          throw new SendNotSubmitted("data", err);
        }
        await held;
        o.onAccepted?.();
        return {
          providerMessageId: msg.messageId!,
          ...(opts?.copy === "caller" ? { unfiledCopy: Buffer.from("the sent copy") } : {}),
        };
      },
      async fileSentCopy(_raw: Buffer, messageId: string) { state.filed.push(messageId); return null; },
      async messageInSent(messageId: string) { state.probes += 1; return state.filed.includes(messageId); },
      async close() { /* nothing to tear down */ },
    };
  };
  return { factory, state, release };
}

/** An account with one mailbox, and a draft per recipient list. */
async function world(recipients: string[][] = [["you@example.com"]]) {
  const accountId = randomUUID();
  const [mb] = await dbW.insert(mailboxes).values({
    accountId, provider: "imap", address: `settle-${randomUUID().slice(0, 8)}@order.test`,
  }).returning();
  const draftIds: string[] = [];
  for (const to of recipients) {
    const [d] = await dbW.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "the letter", body: "words",
      to: to.map((address) => ({ name: null, address })), status: "draft", createdAt: NOW, updatedAt: NOW,
    }).returning();
    draftIds.push(d!.id);
  }
  const ctx = (p: Party, now: Date = NOW): ServiceContext =>
    ({ db: p.db, accountId, userId: null, now: () => now, requestId: p.app });
  return { accountId, mailboxId: mb!.id, draftIds, draftId: draftIds[0]!, ctx };
}
type World = Awaited<ReturnType<typeof world>>;

const sendRow = async (id: string) => (await dbW.select().from(outboundSends).where(eq(outboundSends.id, id)))[0];
const sendOfDraft = async (draftId: string) => (await dbW.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))[0];
const draftRow = async (id: string) => (await dbW.select().from(drafts).where(eq(drafts.id, id)))[0];

/** A reservation written as an attempt left it, and its draft in the status that goes with it. */
async function leftBehind(w: World, o: { status: "pending" | "unverified"; offerState: string; draft: string; claim?: boolean }) {
  await dbW.update(drafts).set({ status: o.draft }).where(eq(drafts.id, w.draftId));
  const [row] = await dbW.insert(outboundSends).values({
    accountId: w.accountId, idempotencyKey: `key-${randomUUID()}`, draftId: w.draftId,
    mintedMessageId: `<${randomUUID()}@order.test>`, status: o.status, offerState: o.offerState, createdAt: NOW,
  }).returning();
  if (o.claim) {
    await dbW.insert(outboundSendFingerprints).values({
      accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: randomUUID().replace(/-/g, "").repeat(2),
      sendId: row!.id, createdAt: NOW,
    });
  }
  return row!;
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await watch.end({ timeout: 5 }); });

/**
 * ONE CASE PER SETTLE. `arrange` brings a send to the moment before its settle and answers how to
 * let the settle start (`fire`), the promise that carries it (`run`) and what must be true once it
 * is through (`after`). The case holds the draft row on a third connection, lets the settle start,
 * waits until it is blocked there, and takes the reservation row on a fourth.
 */
interface Arranged { sendId: string; fire: () => void; run: Promise<Settled<unknown>>; after: () => Promise<void> }
const SETTLES: ReadonlyArray<{ settle: string; arrange: (w: World, p: Party, sends: SendService) => Promise<Arranged> }> = [
  {
    settle: "finalizeSent (the server's 250)",
    async arrange(w, p, sends) {
      const t = transport({ hold: true });
      const run = settled(sends.send(w.ctx(p), w.draftId, "key", { openSendAdapter: t.factory }));
      expect(await until(async () => (await sendOfDraft(w.draftId))?.offerState === "complete"), "the press never reached its release").toBe(true);
      const sendId = (await sendOfDraft(w.draftId))!.id;
      return {
        sendId, fire: t.release, run,
        async after() {
          expect((await sendRow(sendId))!.status).toBe("sent");
          expect((await draftRow(w.draftId))!.status).toBe("sent");
        },
      };
    },
  },
  {
    settle: "finalizeUnverified (a stale attempt, not found in Sent)",
    async arrange(w, p, sends) {
      const row = await leftBehind(w, { status: "pending", offerState: "complete", draft: "sending" });
      const t = transport();
      let fire!: () => void;
      const go = new Promise<void>((r) => { fire = r; });
      const run = settled(go.then(() => sends.resolveStale(w.ctx(p, LATER), row, w.mailboxId, t.factory)));
      return {
        sendId: row.id, fire, run,
        async after() {
          expect((await sendRow(row.id))!.status).toBe("unverified");
          expect((await draftRow(w.draftId))!.status).toBe("unverified");
        },
      };
    },
  },
  {
    settle: "finalizeFailed (the dial was refused before anything was offered)",
    async arrange(w, p, sends) {
      let refuse!: () => void;
      const refused = new Promise<void>((r) => { refuse = r; });
      let dialled = false;
      const dead: OpenSendAdapter = async () => {
        dialled = true;
        await refused;
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      };
      const run = settled(sends.send(w.ctx(p), w.draftId, "key", { openSendAdapter: dead }));
      expect(await until(() => dialled), "the press never reached its dial").toBe(true);
      const sendId = (await sendOfDraft(w.draftId))!.id;
      return {
        sendId, fire: refuse, run,
        async after() {
          expect((await sendRow(sendId))!.status).toBe("failed");
          expect((await draftRow(w.draftId))!.status, "a letter that did not go is a draft again").toBe("draft");
        },
      };
    },
  },
  {
    settle: "finalizeSentFromUnverified (a held send, found in Sent after all)",
    async arrange(w, p, sends) {
      const row = await leftBehind(w, { status: "unverified", offerState: "complete", draft: "unverified" });
      const t = transport({ sentFolder: [row.mintedMessageId] });
      let fire!: () => void;
      const go = new Promise<void>((r) => { fire = r; });
      const run = settled(go.then(() => sends.recheckUnverified(w.ctx(p, LATER), row, w.mailboxId, t.factory)));
      return {
        sendId: row.id, fire, run,
        async after() {
          const now = (await sendRow(row.id))!;
          expect([now.status, now.resolvedBy]).toEqual(["sent", "sent_folder"]);
          expect((await draftRow(w.draftId))!.status).toBe("sent");
        },
      };
    },
  },
  {
    settle: "forgetUnoffered (a stale attempt that offered nothing)",
    async arrange(w, p, sends) {
      const row = await leftBehind(w, { status: "pending", offerState: "unoffered", draft: "sending", claim: true });
      let fire!: () => void;
      const go = new Promise<void>((r) => { fire = r; });
      const run = settled(go.then(() => sends.resolveStale(w.ctx(p, LATER), row, w.mailboxId, null)));
      return {
        sendId: row.id, fire, run,
        async after() {
          expect(await sendRow(row.id), "a reservation that sent nothing is forgotten").toBeUndefined();
          expect((await draftRow(w.draftId))!.status).toBe("draft");
        },
      };
    },
  },
];

describe.skipIf(!PG_UP)("a settle takes the draft row before anything of the reservation", () => {
  for (const s of SETTLES) {
    it(`${s.settle}: while it waits for the draft row, the reservation row is free`, async () => {
      const p = party("order-settle");
      const third = holder("order-draft");
      try {
        const w = await world();
        const a = await s.arrange(w, p, new SendService());
        // The draft row, as any of its own writers holds it (a replay, Send again, an answer, a discard).
        await third.hold((tx) => tx`select id from drafts where id = ${w.draftId} for update`);
        a.fire();
        const waitsAt = await blockedOn(p.app, third.app);
        expect(waitsAt, "the settle never met the draft's holder").not.toBeNull();
        // The reading: taken by a fourth connection at once, or refused because the settle holds it.
        const reservation = await reservationRow(a.sendId);
        await third.release();
        const out = await a.run;

        expect(reservation, "the settle waits for the draft row while it holds the reservation row: half of a deadlock").toBe("free");
        expect(waitsAt, "the settle's first row lock is the draft's").toMatch(/from "drafts".*for no key update/i);
        expect(p.ended.filter((c) => c === DEADLOCK)).toEqual([]);
        // `finalizeFailed`'s press is refused by name, as it always was; every other settle answers.
        if (!/finalizeFailed/.test(s.settle)) expect(out.ok ? "answered" : `threw ${codeOf(out.e)}`).toBe("answered");
        await a.after();
      } finally {
        await third.end();
        await p.client.end({ timeout: 5 });
      }
    }, 60_000);
  }
});

describe.skipIf(!PG_UP)("two settles of one account learn their contacts in one order", () => {
  it("letters to the same new people, named in opposite orders and settled together: nobody is killed", async () => {
    const tag = randomUUID().slice(0, 8);
    // Sorted: x < g1 < g2 < y. Each letter names one address only it has, between the two they share.
    const x = `a-${tag}@contacts.test`, g1 = `b-${tag}@contacts.test`, g2 = `c-${tag}@contacts.test`, y = `d-${tag}@contacts.test`;
    const one = party("order-contacts-1");
    const two = party("order-contacts-2");
    const gate1 = holder("order-gate-1");
    const gate2 = holder("order-gate-2");
    try {
      const w = await world([[x, g1, y], [y, g2, x]]);
      const sends = new SendService();
      const t1 = transport({ hold: true });
      const t2 = transport({ hold: true });
      const first = settled(sends.send(w.ctx(one), w.draftIds[0]!, "key-1", { openSendAdapter: t1.factory }));
      const second = settled(sends.send(w.ctx(two), w.draftIds[1]!, "key-2", { openSendAdapter: t2.factory }));
      expect(await until(async () =>
        (await sendOfDraft(w.draftIds[0]!))?.offerState === "complete" && (await sendOfDraft(w.draftIds[1]!))?.offerState === "complete",
      ), "the two presses never reached their release").toBe(true);

      // Each letter's own address is being written by somebody else, so each settle stops inside its
      // contacts statement with the addresses before that one already taken.
      await gate1.hold((tx) => tx`insert into contacts (account_id, address, source) values (${w.accountId}, ${g1}, 'person')`);
      await gate2.hold((tx) => tx`insert into contacts (account_id, address, source) values (${w.accountId}, ${g2}, 'person')`);
      t1.release();
      expect(await blockedOn(one.app, gate1.app), "the first settle never reached its contacts").toMatch(/insert into "contacts"/i);
      t2.release();
      expect(await blockedOn(two.app, null), "the second settle never reached its contacts").toMatch(/insert into "contacts"/i);
      await Promise.all([gate1.release(), gate2.release()]);

      const [r1, r2] = await Promise.all([first, second]);
      expect([...one.ended, ...two.ended].filter((c) => c === DEADLOCK), "Postgres killed one of the two settles").toEqual([]);
      expect([r1, r2].map((r) => (r.ok ? r.v.status : `threw ${codeOf(r.e)}`))).toEqual(["sent", "sent"]);
      expect([(await sendOfDraft(w.draftIds[0]!))!.status, (await sendOfDraft(w.draftIds[1]!))!.status]).toEqual(["sent", "sent"]);
      const known = await dbW.select({ address: contacts.address }).from(contacts).where(eq(contacts.accountId, w.accountId));
      expect(known.map((c) => c.address).sort(), "everybody written to is known").toEqual([x, g1, g2, y]);
    } finally {
      await gate1.end();
      await gate2.end();
      await one.client.end({ timeout: 5 });
      await two.client.end({ timeout: 5 });
    }
  }, 60_000);
});

describe.skipIf(!PG_UP)("a settle Postgres kills is run again", () => {
  it("the first try after the 250 is the deadlock victim: the next one settles, and the person is told sent", async () => {
    const p = party("order-retry");
    try {
      const w = await world();
      // From the 250 on, the next transaction of this party is the settle: it is killed once.
      const t = transport({ onAccepted: () => { p.plant.armed = true; p.plant.left = 1; } });
      const out = await settled(new SendService().send(w.ctx(p), w.draftId, "key", { openSendAdapter: t.factory }));

      expect(p.plant.fired, "the plant never reached the settle").toBe(1);
      expect(p.ended.filter((c) => c === DEADLOCK), "the settle's first try ended as a deadlock victim").toHaveLength(1);
      expect(out.ok ? out.v.status : `threw ${codeOf(out.e)}`).toBe("sent");
      const row = (await sendOfDraft(w.draftId))!;
      expect([row.status, row.providerMessageId]).toEqual(["sent", row.mintedMessageId]);
      expect((await draftRow(w.draftId))!.status).toBe("sent");
      expect(await until(() => t.state.filed.length > 0), "the Sent copy was never filed").toBe(true);
      expect(t.state.filed).toEqual([row.mintedMessageId]);
      expect(t.state.delivered, "one envelope").toHaveLength(1);
    } finally {
      await p.client.end({ timeout: 5 });
    }
  }, 60_000);

  it("every try is killed: the Sent copy is filed all the same, the letter is settled from its Sent folder, and nothing is submitted twice", async () => {
    const p = party("order-spent");
    const later = party("order-later");
    try {
      const w = await world();
      const lines: string[] = [];
      const log = createLogger({ service: "send", sink: (line) => { lines.push(line); } });
      const t = transport({ onAccepted: () => { p.plant.armed = true; p.plant.left = 99; } });
      const sends = new SendService();
      const out = await settled(sends.send(w.ctx(p), w.draftId, "key", { openSendAdapter: t.factory, log }));
      p.plant.armed = false;

      // What stands when the tries are spent.
      const tries = SEND_SETTLE_WAITS_MS.length + 1;
      expect(p.plant.fired, "a bounded number of tries").toBe(tries);
      expect(out.ok ? `answered ${out.v.status}` : codeOf(out.e), "the press is told the record could not be written, as before").toBe(DEADLOCK);
      const stood = (await sendOfDraft(w.draftId))!;
      expect([stood.status, stood.offerState], "no try committed anything").toEqual(["pending", "complete"]);
      expect((await draftRow(w.draftId))!.status).toBe("sending");
      expect(t.state.filed, "the provider accepted it: its copy is in Sent although the record is not written").toEqual([stood.mintedMessageId]);
      expect(lines.filter((l) => l.includes("send_accepted_not_settled")), "said once, at error level").toHaveLength(1);

      // Whatever pass finds the row once it is stale reads the Sent folder, and can only end it `sent`.
      const probe = transport({ sentFolder: t.state.filed });
      const replay = await settled(sends.send(w.ctx(later, LATER), w.draftId, "key", { openSendAdapter: probe.factory, log }));
      expect(replay.ok ? replay.v.status : `threw ${codeOf(replay.e)}`).toBe("sent");
      const row = (await sendOfDraft(w.draftId))!;
      expect([row.status, row.providerMessageId]).toEqual(["sent", row.mintedMessageId]);
      expect((await draftRow(w.draftId))!.status).toBe("sent");

      // And a Send again is answered from that delivery.
      const again = await settled(sends.send(w.ctx(later, LATER), w.draftId, "again-key", { openSendAdapter: probe.factory, log }, { again: true }));
      expect(again.ok ? again.v.status : `threw ${codeOf(again.e)}`).toBe("sent");
      expect([...t.state.delivered, ...probe.state.delivered], "THE RECIPIENT GOT IT TWICE").toHaveLength(1);
      expect(t.state.filed, "one copy").toHaveLength(1);
    } finally {
      await p.client.end({ timeout: 5 });
      await later.client.end({ timeout: 5 });
    }
  }, 60_000);

  it("an error that is not Postgres' own \"run it again\" is not retried", async () => {
    const p = party("order-other");
    try {
      const w = await world();
      const h = p.db as unknown as { transaction: (fn: unknown, ...rest: unknown[]) => Promise<unknown> };
      const inner = h.transaction.bind(h);
      let settles = 0;
      let accepted = false;
      const t = transport({ onAccepted: () => { accepted = true; } });
      Object.defineProperty(h, "transaction", {
        configurable: true, writable: true,
        value: (fn: unknown, ...rest: unknown[]) => {
          if (!accepted) return inner(fn, ...rest);
          settles += 1;
          return Promise.reject(Object.assign(new Error("the connection is gone"), { code: "08006" }));
        },
      });
      const out = await settled(new SendService().send(w.ctx(p), w.draftId, "key", { openSendAdapter: t.factory }));
      expect(out.ok ? `answered ${out.v.status}` : codeOf(out.e)).toBe("08006");
      expect(settles, "one try: a lost connection is not a deadlock").toBe(1);
      expect((await sendOfDraft(w.draftId))!.status, "nothing was written").toBe("pending");
      expect(t.state.filed, "accepted all the same: the copy is filed").toHaveLength(1);
    } finally {
      await p.client.end({ timeout: 5 });
    }
  }, 60_000);
});
