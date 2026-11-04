/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A START THAT DID NOT FINISH STARTING IS NOT A START — the phone's resume, on the device store
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A background hand-back clears the poll timer. The foreground resume claims the mailbox and then
 * a transient store failure rejects before the timer is re-armed. The install was left with
 * `organizing` true, the claim taken, and NOTHING polling and nothing renewing: the person was
 * shown a mailbox being organized while no pass ran, and no other install could take it, because
 * the claim stood. The refusals were swallowed by an `allSettled` over the runtimes, so not even a
 * log line said so — the shape this product has measured before, here on the resume path.
 *
 * Everything below is the engine: the real gate, the real permit, the real hand-back and the real
 * resume. The two injected things are a store that faults at a named instant and an in-memory
 * `ohmail/_meta`, so no mail server is needed and no box lock is taken.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import {
  startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows,
} from "../src/mobile.js";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

function nodeExecutor(): PhoneSqlExecutor & { direct: (sql: string, params?: unknown[]) => unknown[] } {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
    direct: (sql, params = []) => raw.prepare(sql).all(...params),
  };
}

/** An in-memory `ohmail/_meta`, narrowed to what this file reads, plus a hook at the APPEND. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /** How many claims this install has written here across the whole case — the retry's evidence. */
  appends = 0;
  /** Run the instant a claim lands, which is the instant a resume becomes able to lose one. */
  onAppend: (() => void) | null = null;
  unreadable = false;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.peekClaims(); }
  async peekClaims(): Promise<RawClaimMessage[]> {
    if (this.unreadable) {
      throw new LeaseUnavailableError("ohmail/_meta could not be read", { op: "list_claims" });
    }
    return this.claims.map((c) => ({ ...c }));
  }
  /** Land the claim and take the ANSWER away — a dropped response, as the wire produces it. */
  loseAppendAnswer = false;
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
    this.appends += 1;
    this.onAppend?.();
    if (this.loseAppendAnswer) throw new Error("the connection dropped before the server answered");
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

function quietMailbox(meta: MemoryMetaFolder) {
  const factory = (_cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo; leasePeekIo(): { listClaims(): Promise<RawClaimMessage[]> };
  } => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.peekClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> {
      throw new Error("this test's mailbox must never be asked to send");
    },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
  return { factory };
}

const OUR_INSTALL = "install-resume-that-did-not-start";
const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";

interface Phone {
  engine: PhoneEngine;
  meta: MemoryMetaFolder;
  id: string;
  /** The engine's own answer for the one mailbox. */
  organizer(): { organizing: boolean; claimed: boolean };
  /** Make every store statement reject, from now until it is cleared. */
  faultStore(on: boolean): void;
  /** Hold every store statement open, and the hand that lets them through. */
  holdStore(): () => void;
}

const open: PhoneEngine[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
});

/** An organizing phone with a consented row and a claim in the folder — every case's premise. */
async function organizingPhone(): Promise<Phone> {
  const exec = nodeExecutor();
  let faulting = false;
  let held: Promise<void> | null = null;
  const gate = async (): Promise<void> => {
    if (held !== null) await held;
    if (faulting) throw new Error("the local store is temporarily unavailable");
  };
  const gated: PhoneSqlExecutor = {
    ...exec,
    all: async (sql: string, params: readonly unknown[]) => { await gate(); return exec.all(sql, params); },
    run: async (sql: string, params: readonly unknown[]) => { await gate(); return exec.run(sql, params); },
    batch: async (statements) => { await gate(); return exec.batch(statements); },
  };
  const meta = new MemoryMetaFolder();
  const engine = await startPhoneEngine({
    exec: gated,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "a@b.test", pass: "idle-fixture-password" },
    },
    machineName: "ohmail on a phone",
    installId: OUR_INSTALL,
    adapterFactory: quietMailbox(meta).factory,
    log: () => undefined,
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  exec.direct(
    `insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
     values (?, 'imap', 'not-a-secret', 1)`,
    [id],
  );
  exec.direct(
    `update mailboxes set organizer_role = 'organizer', organize_consented_at = 1,
       status = 'connected' where id = ?`,
    [id],
  );
  await engine.resume();
  expect(meta.count, "the premise is an install holding its claim").toBe(1);
  return {
    engine, meta, id,
    organizer: () => {
      const s = engine.runtimes().organizer[id]!;
      return { organizing: s.organizing, claimed: s.claimed };
    },
    faultStore: (on: boolean) => { faulting = on; },
    holdStore: () => {
      let release!: () => void;
      held = new Promise<void>((r) => { release = r; });
      return () => { held = null; release(); };
    },
  };
}

describe.runIf(ON_DEVICE_STORE)("a resume that did not finish starting, on the device store", () => {
  /**
   * THE STATE THE FINDING NAMES, AND IT IS NOW UNREACHABLE. A store that refuses after the gate has
   * taken the mailbox left `organizing` true with the claim held and NOTHING polling or renewing.
   * The claim is not the thing to give up here — this install IS the organizer, and handing the
   * mailbox to another machine over a local hiccup is the worse answer — so what was missing is the
   * TIMER, and the invariant is that claimed-with-nothing-running cannot be left behind.
   */
  it("arms the poll when the store refuses after the claim, instead of holding a claim with nothing running", async () => {
    const p = await organizingPhone();
    await p.engine.handBack();
    expect(p.meta.count, "the hand-back did not give the claim back").toBe(0);

    p.meta.onAppend = () => { p.faultStore(true); };
    await p.engine.resume();
    p.faultStore(false);

    expect(p.meta.count, "the gate did not take the mailbox, so this case measures nothing").toBe(1);
    /* CLAIMED AND ORGANIZING TOGETHER. `organizing` is derived from the poll timer among other
       facts, so its truth here IS the assertion that the timer was armed — the state this case
       exists to make unreachable is `claimed` true beside `organizing` false. */
    expect(p.organizer().claimed).toBe(true);
    expect(p.organizer().organizing, "a claim is held and nothing is polling or renewing").toBe(true);
  });

  /**
   * AND A RENEWAL WHOSE ANSWER IS LOST COSTS THE MAILBOX NOTHING. The claim lands and the answer is
   * taken away; the gate's own exemption carries it, the next cycle recognises the claim this
   * install wrote — the nonce was recorded before the append — and the poll is armed throughout,
   * which is the state this file is about.
   */
  it("keeps the mailbox when the claim it wrote lost its answer", async () => {
    const p = await organizingPhone();
    await p.engine.handBack();

    p.meta.loseAppendAnswer = true;
    p.meta.onAppend = () => { setTimeout(() => { p.meta.loseAppendAnswer = false; }, 0); };
    await p.engine.resume();

    expect(p.meta.appends, "the fixture never wrote a claim, so this case measures nothing")
      .toBeGreaterThan(0);
    /* THE STATE IS `starting` — claimed by instruction, no pass yet — and it is a state with a
       future rather than the one this file is about: the resume resolved and its poll is armed, so
       the next cycle carries it. That is what the second press proves, and it is the only thing
       this fixture can settle; whether the gate RECOGNISES the claim it wrote across the lost
       answer is item B's question, measured against a real server in
       `apps/worker/test/lease-lost-renewal-response.imap.test.ts`. */
    expect(p.organizer().claimed, "a lost answer cost this install its entitlement").toBe(true);
    await p.engine.resume();
    expect(p.organizer().organizing, "the install never recovered from a lost answer").toBe(true);
    expect(p.meta.count, "the recovery left more than one claim standing").toBe(1);
  });

  /**
   * THE POSITIVE CONTROL. Nothing faults, and an ordinary resume takes the mailbox back and says
   * so — so a red above is the failure and never the fixture.
   */
  it("takes the mailbox back on an ordinary resume", async () => {
    const p = await organizingPhone();
    await p.engine.handBack();
    await p.engine.resume();
    expect(p.organizer().organizing).toBe(true);
    expect(p.organizer().claimed).toBe(true);
    expect(p.meta.count).toBe(1);
  });

  /**
   * THE DOOR'S TWO WORDS, MEASURED ON A SUBJECT THAT HAS THE PROPERTY.
   *
   * `phone-claim-door.test.ts` drives an adapter with no `connect` and no `leaseIo`: it cannot dial
   * and no claim can reach `ohmail/_meta`, so `claimed` and `released` are unreachable there and
   * every expectation of them was reading the runtime's attach-time optimism. This composition CAN
   * claim — the premise above is a claim standing in the folder — so the two words are measured
   * here once, against the folder rather than against a record of intent.
   */
  it("answers released and claimed for real, on an adapter that can take the mailbox", async () => {
    const p = await organizingPhone();

    await expect(p.engine.stopOrganizing(), "a stop over a real claim did not release it")
      .resolves.toBe("released");
    expect(p.meta.count, "the release did not take the claim out of ohmail/_meta").toBe(0);
    expect(p.organizer().organizing).toBe(false);

    await expect(p.engine.claimHere({ by: "press" }), "a press over a free mailbox did not take it")
      .resolves.toBe("claimed");
    expect(p.meta.count, "the press answered claimed and wrote no claim").toBe(1);
    expect(p.organizer().organizing).toBe(true);
    expect(p.organizer().claimed).toBe(true);
  });

  /**
   * ORGANIZING IS THE MECHANISM, NOT THE INTENT. The claim is taken and the pass is held before
   * anything is polling or renewing: that state is `starting` and it is not organizing. Reading the
   * intent instead is what let a claim stand over an install with no timer and call it organized.
   */
  it("does not report organizing while the claim is held and nothing is scheduled", async () => {
    const p = await organizingPhone();
    await p.engine.handBack();

    /* HELD FROM THE INSTANT THE CLAIM LANDS, which is the only instant that measures this: held
       from the start, the pass never reaches the gate and the state under test is never entered —
       the case would be green for nothing. Armed at the APPEND, the claim is taken and the permit
       is held, and the next thing the pass wants is the store. */
    let letGo: (() => void) | null = null;
    p.meta.onAppend = () => { letGo = p.holdStore(); };
    const resuming = p.engine.resume().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));

    expect(letGo, "the fixture never held the pass, so this case measures nothing").not.toBeNull();
    expect(p.organizer().claimed, "the premise is a claim this install holds").toBe(true);
    expect(p.organizer().organizing, "a claim with nothing scheduled was reported as organizing")
      .toBe(false);
    letGo!();
    await resuming;
    expect(p.organizer().organizing, "the resume that did finish is not reported either").toBe(true);
  });
});
