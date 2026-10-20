/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  STOP, THEN START, IN ONE RUN OF THE APP — on the DEVICE store, with the gate running
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `phone-claim-door.test.ts` already presses both verbs and its "CLAIM cancels a release" case is
 * green. It is green because nothing between the two presses runs a GATED CYCLE — and the cycle is
 * where the device's defect lives.
 *
 * So this file composes the same engine over the same store and drives the cycle, with an
 * in-memory `ohmail/_meta` for the adapter's lease so no mail server is needed and no box lock is
 * taken.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type {
  LeaseIo, MetaFolderStamp, RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import { LeaseUnavailableError, formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows,
} from "../src/mobile.js";
import { releaseRefusal } from "./_release-refusal.js";

/* 30 s per case: the SQL runner below waits a real `setTimeout(0)` before every statement, as the
   phone's async database bridge does, so a case is 0.8-2.7 s of waiting on an idle host and up to
   3.9 s on a starved one. About 8x that, which the default 5 s is not. */
vi.setConfig({ testTimeout: 30_000 });

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

function nodeExecutor(file = ":memory:"): PhoneSqlExecutor & { direct: (sql: string, params?: unknown[]) => unknown[] } {
  const raw = new sqlite.DatabaseSync(file);
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

/** An in-memory `ohmail/_meta` — `reader-no-auto-resume.test.ts`'s, narrowed to what is read here. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  unreadable = false;
  /**
   * THE SERVER WILL NOT ENUMERATE THIS INSTALL'S RECORDS, so the claim cannot be removed.
   *
   * It throws what the real io throws (`_release-refusal.ts`): a `ClaimReleaseError`, never a
   * `null`, which that io does not return. GreenMail cannot be made to behave this way, so this
   * is the fake-server seam where the refusal arm is reachable at all.
   */
  releaseRefused = false;
  /**
   * HOLD A GATED CYCLE OPEN, and nothing else — which is the GATE's read and not the door's.
   *
   * This said "only the gate reads the lease, the phone's own route never touches IMAP", and that
   * stopped being true when the consent door learned to look: it now peeks `ohmail/_meta` on a row
   * whose `organizer_state` is NULL. Gating that peek too makes a held gate silence the DOOR's own
   * decision — and the case below measures exactly where the door's line lands relative to the
   * cycle, so a fixture that holds both cannot tell them apart and the case can never pass.
   *
   * So `held` gates {@link listClaims}, which is the gate's read, and {@link peekClaims} — the
   * APPEND-less bounded look the door composes through its own `leasePeekIo` accessor — runs
   * ungated. Two accessors, because the engine composes two.
   */
  held: Promise<void> | null = null;
  /**
   * THE CONNECTION IS GONE BY THE TIME THE GATE READS, and it was there for the door's look.
   *
   * {@link unreadable} refuses both accessors, so a press meets it at the DOOR and never reaches
   * a cycle — which measures the 503 arm and not this one. The ordering a start can be reported
   * over is the other one: the look is served, the consent is recorded, and the read the CYCLE
   * makes is the one that fails. Gate-only, for the reason `held` is gate-only.
   */
  gateUnreadable = false;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    if (this.held !== null) await this.held;
    if (this.gateUnreadable) {
      throw new LeaseUnavailableError("the connection died before the cycle", { op: "list_claims" });
    }
    return this.peekClaims();
  }
  /** The door's own read-only look — never gated; see {@link held}. */
  async peekClaims(): Promise<RawClaimMessage[]> {
    if (this.unreadable) {
      throw new LeaseUnavailableError("ohmail/_meta could not be read", { op: "list_claims" });
    }
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    if (this.releaseRefused) throw releaseRefusal();
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

const OUR_INSTALL = "install-stop-then-start";
const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

interface Line { event: string; detail: Record<string, unknown> }
interface Phone {
  engine: PhoneEngine;
  lines: Line[];
  meta: MemoryMetaFolder;
  /** The row, read through the statement runner rather than through drizzle — the store's own answer. */
  row(): { role: string; release: number | null; takeover: number | null; released: number | null };
  /**
   * A SPENDABLE TAKEOVER STAMP, written as the consent route writes it.
   *
   * Not through `claimHere()`: on a consented organizer row with no request standing the route
   * answers `already_organizing` and writes nothing — *"a second press is not a second becoming"* —
   * so the state this exercises is unreachable through the door and the column is what has it.
   */
  stampTakeover(): void;
  seedPendingMove(n?: number): void;
  exported(): number;
  detail(event: string): Record<string, unknown>[];
  said(event: string): number;
  /** The LAST line for an event, so a case can read the fields it carries. */
  line(event: string): Record<string, unknown> | undefined;
  /** Make the gate's own row re-read throw, so a pass that learned nothing can be measured. */
  refuseRowRead(on: boolean): void;
  /** Tombstone the mailbox row, which is the local door's `removed` arm — a refusal, not a 409. */
  makeUnclaimable(): void;
  /** Hold the gate's row read open, and the hand that lets it through. */
  holdGate(): () => void;
  /** The engine's own answer for the one mailbox — `organizing` and the row's standing stop. */
  organizer(): { organizing: boolean; releaseRequestedAt: string | null };
}

const open: PhoneEngine[] = [];
const stores: string[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (stores.length > 0) rmSync(stores.pop()!, { recursive: true, force: true });
});

/**
 * A store on DISK, for the two cases that outlive one process. An in-memory store dies with the
 * statement runner its engine closes, so a relaunch over it would be a fresh mailbox wearing the same
 * name — which is the one thing a restart case may not be.
 */
function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-stop-"));
  stores.push(dir);
  return join(dir, "engine.db");
}

/** An organizing phone with a consented row and a claim in the folder — every case's premise. */
async function organizingPhone(o: {
  /** Where the store lives. Absent ⇒ in memory, which is every case that does not relaunch. */
  file?: string;
  /** The same folder across a relaunch — `ohmail/_meta` is on the mail server, not in the store. */
  meta?: MemoryMetaFolder;
  /** `false` for a relaunch: the row and its consent are already there, and re-writing them would
      re-promote a row the act under test may have demoted. The credential is written either way —
      see the block that writes it. */
  seed?: boolean;
} = {}): Promise<Phone> {
  const exec = nodeExecutor(o.file);
  let rowReadRefused = false;
  /* ── THE GATE'S OWN PER-PASS ROW RE-READ, refused on demand ──────────────────────────────
     Keyed on `organized_by_capabilities`, which only that statement selects. A hold does NOT
     belong here: the door's own 409 precheck reads the holder columns too, so a hold keyed on any
     of them blocks the PRESS as well as the cycle and the case measures its own hook — measured,
     here, as a press that never reached the route. The lease is where a cycle is held; see
     {@link MemoryMetaFolder.held}. */
  const gated: PhoneSqlExecutor = {
    ...exec,
    all: async (sql: string, params: readonly unknown[]) => {
      if (rowReadRefused && sql.includes("organized_by_capabilities") && !/^\s*update/i.test(sql)) {
        throw new Error("the mailbox row could not be re-read");
      }
      return exec.all(sql, params);
    },
  };
  const meta = o.meta ?? new MemoryMetaFolder();
  const lines: Line[] = [];
  const engine = await startPhoneEngine({
    exec: gated,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "a@b.test", pass: "pw-not-used-password-password" },
    },
    machineName: "ohmail on a phone",
    installId: OUR_INSTALL,
    adapterFactory: quietMailbox(meta).factory,
    log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  /* The credential the claim-back ceremony requires, and the consent the gate reads. This
     composition's launch seals neither — its adapter is a double that cannot complete a dial. */
  /* ALWAYS, and after the launch rather than before it: the value is not a sealed blob, so a
     launch that MET it would refuse the mailbox and discard it (`removeRefusedSeal`). Written here
     because the claim-back ceremony reads it and this composition's own launch seals nothing —
     its adapter is a double that cannot complete a dial. A relaunch therefore scrubs it first. */
  exec.direct(
    `insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
     values (?, 'imap', 'not-a-secret', 1)`,
    [id],
  );
  if (o.seed !== false) {
    exec.direct(
      `update mailboxes set organizer_role = 'organizer', organize_consented_at = 1,
         status = 'connected' where id = ?`,
      [id],
    );
  }
  await engine.resume();
  expect(meta.count, "the premise is an install holding its claim").toBe(1);
  return {
    engine, lines, meta,
    row: () => {
      const [r] = exec.direct(
        `select organizer_role as role, release_requested_at as release,
           takeover_authorized_at as takeover, organizer_released_at as released
         from mailboxes where id = ?`,
        [id],
      ) as { role: string; release: number | null; takeover: number | null; released: number | null }[];
      return r!;
    },
    stampTakeover: () => {
      exec.direct("update mailboxes set takeover_authorized_at = ? where id = ?", [Date.now(), id]);
    },
    refuseRowRead: (on: boolean) => { rowReadRefused = on; },
    holdGate: () => {
      let release!: () => void;
      meta.held = new Promise<void>((r) => { release = r; });
      return () => { meta.held = null; release(); };
    },
    makeUnclaimable: () => {
      /* A TOMBSTONE, which is the refusal the door the press now uses actually has. It was a
         consent-less reader with no stored login — the SHARED route's 422 `credential_needed` —
         and the press moved to `/local/`, which records the consent without a credential check
         (the desktop's door has always done so; the password is the engine's own, sealed at
         attach). So the arm that stayed real is the one where the person took the mailbox off
         this phone while the press was in flight: `status = 'disabled'` → `removed`. The runtime
         map is not touched, so `soleMailbox()` still finds the mailbox and the refusal measured
         is the DOOR's rather than the roster's. */
      exec.direct(
        `update mailboxes set status = 'disabled', organizer_role = 'reader',
           organize_consented_at = null, organizer_state = null, organized_by_name = null,
           organized_by_kind = null, organized_by_install_id = null where id = ?`,
        [id],
      );
    },
    /**
     * `n` local moves this install decided and has not performed — the handover's input.
     *
     * Written straight into the two tables the walk reads rather than through a route: what is
     * under test is the STATEMENTS the handover runs on this store, and a route would add a
     * second way for the case to fail that has nothing to do with the dialect.
     */
    seedPendingMove: (n = 1) => {
      for (let i = 0; i < n; i++) {
        exec.direct(
          `insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject)
           values (?, (select account_id from mailboxes where id = ?), ?, 'bh', ?, 's')`,
          [`msg-${i}`, id, id, `dedup-${i}`],
        );
        /* DISTINCT `updated_at`s, ascending: the walk's cursor is `(updated_at, id)` and a page
           boundary landing inside a run of equal instants is the shape a keyset gets wrong. */
        exec.direct(
          `insert into folder_state (id, message_id, desired_folder, observed_folder, last_set_by,
             reconcile_status, updated_at)
           values (?, ?, 'ohmail/News', 'INBOX', 'us', 'pending', ?)`,
          [`fs-${i}`, `msg-${i}`, Date.now() + i],
        );
      }
    },
    /** Every `message.move` request the handover minted, as the store holds them. */
    exported: () => (exec.direct(
      "select count(*) as n from organizer_requests where kind = 'message.move'",
    ) as { n: number }[])[0]!.n,
    detail: (event: string) => lines.filter((l) => l.event === event).map((l) => l.detail),
    said: (event: string) => lines.filter((l) => l.event === event).length,
    line: (event: string) => lines.filter((l) => l.event === event).at(-1)?.detail,
    organizer: () => {
      const states = Object.values(engine.runtimes().organizer);
      expect(states, "the engine stopped reporting its one mailbox").toHaveLength(1);
      /* THE TWO FIELDS THIS FILE IS ABOUT, projected — so a case comparing them whole cannot be
         satisfied by a holder or an outage moving beside them. */
      const { organizing, releaseRequestedAt } = states[0]!;
      return { organizing, releaseRequestedAt };
    },
    /* The row id is not returned: every case below reads the store through `row()`, and a case
       that needed the id would be reaching past the door it is measuring. */
  };
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT, "OHMAIL_EXPECT_DIALECT is unset — neither project declared itself").toBeDefined();
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

/**
 * ══ THE PERSON'S STOP IS RECORDED, ON THE STORE A PHONE CARRIES ═══════════════════════════
 *
 * The guard on the release write compares the two stamps this pass decided from, so a press that
 * landed while the server was being asked is not deleted. Both comparisons bound a JavaScript
 * `Date` into a raw `sql` fragment, where there is no column to coerce it against: on the device
 * store those columns are epoch-millisecond integers, and the value arrived as SQL NULL or was
 * refused by the binding outright.
 *
 * So the write never recorded anything, on any poll, with nobody having pressed anything — the row
 * stayed an organizer with the request standing while the claim was already out of the folder, and
 * the log said `organizer_released` regardless. That is the two standing instructions device run 3
 * met: an engine that says it does not organize the mailbox and a row that says it does.
 */
describe.runIf(ON_DEVICE_STORE)("the person's stop, on the device store", () => {
  it("RECORDS the release: the row demotes, both stamps are spent, and the claim is gone", async () => {
    const p = await organizingPhone();
    await expect(p.engine.stopOrganizing()).resolves.toBe("released");
    /* AND THE RUNTIME READS THE SAME THING, which is what the phone's panel and its press both
       ask: the request is spent, so nothing is standing. */
    expect(p.organizer()).toEqual({ organizing: false, releaseRequestedAt: null });
    const row = p.row();
    expect(row.role, "the release was not recorded, so the row still says this install organizes")
      .toBe("reader");
    expect(row.release, "the request still stands, so every later poll honours it again").toBeNull();
    expect(row.takeover).toBeNull();
    expect(row.released, "nothing marks the release as having happened").not.toBeNull();
    expect(p.meta.count, "the claim is still in the folder").toBe(0);
    expect(p.said("organizer_release_write_failed"), "the guarded update could not run").toBe(0);
    expect(p.said("organizer_claim_release_yielded_to_press"),
      "the release yielded to a press nobody made").toBe(0);
  });

  it("REFUSED: a claim the server will not give up is not a stop, and the row keeps the request", async () => {
    /**
     * ══ THE ARM THE PHONE'S ADAPTER REPORTED AS A SUCCESS ═══════════════════════════════════
     *
     * The route accepts the stop (202) and the forced cycle then fails to confirm the claim left
     * `ohmail/_meta`. The adapter answered `true` for every 202, and the engine sets `organizing`
     * false on this arm too — a pass honouring a release arranges nothing either way — so the app
     * read "the mailbox was let go", tore the notification, the foreground service and both
     * watches down, and the phone went on holding the claim with nothing anywhere saying so.
     *
     * Driven through the REAL composition: the app-side cell for this used a double that answered
     * `false` while production answered `true`, which is the defect's own twin.
     */
    const p = await organizingPhone();
    p.meta.releaseRefused = true;
    await expect(p.engine.stopOrganizing(), "a refused release was reported as a stop")
      .resolves.toBe("refused");
    expect(p.meta.count, "the premise is a claim the server would not give up").toBe(1);
    /* THE TWO FACTS, AND THEY ARE NOT THE SAME ONE. */
    expect(p.organizer(), "the runtime read as a mailbox this install has let go")
      .toEqual({ organizing: false, releaseRequestedAt: expect.any(String) });
    /* AT LEAST ONE: the 202 route rings the mailbox and `stopOrganizing` then forces a resume, two
       designed triggers. On a fast host their cycles merge into one; on a starved one each runs. */
    expect(p.said("organizer_claim_release_unconfirmed"),
      "the cycle did not reach the unconfirmed arm — this case measured something else").toBeGreaterThanOrEqual(1);
    expect(p.said("organizer_claim_released"), "a cycle read the refused release as done").toBe(0);
    const row = p.row();
    expect(row.role, "the row demoted over a claim that is still in the mailbox").toBe("organizer");
    expect(row.release, "the request was spent over a release that never happened").not.toBeNull();
    expect(row.released, "the row recorded a release that did not happen").toBeNull();
  });

  it("ASKS AGAIN: the refused release is honoured by a later poll, and then it IS a stop", async () => {
    /* The refusal is not the end of the instruction — the request stands on the row, so the next
       poll asks the server again. Without this the cell above is satisfied by a stop that can
       never complete. */
    const p = await organizingPhone();
    p.meta.releaseRefused = true;
    await expect(p.engine.stopOrganizing()).resolves.toBe("refused");
    p.meta.releaseRefused = false;
    await p.engine.resume();
    expect(p.meta.count, "the later poll did not take the claim out of the mailbox").toBe(0);
    expect(p.row().role).toBe("reader");
    /* AND THE DAY IT HAPPENED IS ON THE ROW. A 0.14.2 test run photographed a released row with no
       date because the release had never completed behind a cut link; once the link is back and
       the pass honours the request, the same statement that demotes the row stamps it — the pane
       renders "You stopped organizing this here on {day}" from nothing else (RELEASED-ROW-CARRIES-NO-DATE).
       Watched red: drop `organizerReleasedAt: now()` from the release statement in `engine.ts`. */
    expect(p.row().released, "the honoured release left the row without the day it happened").not.toBeNull();
    expect(p.organizer()).toEqual({ organizing: false, releaseRequestedAt: null });
  });

  it("CARRIES the standing stop through a pass that could not read the row", async () => {
    /* A pass whose row re-read threw learned nothing about the person's stop, so it may not report
       the stop as gone — the rule `unreadableSince` already holds to. Cleared, the panel would put
       "Nothing organizes this mailbox" and a Start verb in front of somebody whose stop is still
       standing and whose claim is still in the mailbox. */
    const p = await organizingPhone();
    p.meta.releaseRefused = true;
    await expect(p.engine.stopOrganizing()).resolves.toBe("refused");
    expect(p.organizer().releaseRequestedAt, "the premise is a standing stop").not.toBeNull();

    p.refuseRowRead(true);
    await p.engine.resume();
    expect(p.said("organizer_takeover_reread_failed"),
      "the row read did not fail — this case measured an ordinary pass").toBe(1);
    expect(p.organizer().releaseRequestedAt,
      "a pass that read nothing reported the person's stop as gone").not.toBeNull();
    /* AND THE ROW STILL HOLDS IT, which is what the next readable pass acts on. */
    p.refuseRowRead(false);
    expect(p.row().release).not.toBeNull();
  });

  it("A REFUSED PRESS SAYS SO — the door's silence was half the device's diagnosis", async () => {
    /**
     * ══ DEVICE RUN 4 ════════════════════════════════════════════════════════════════════════
     *
     * Measured on the device: after a Stop, a Start was refused for over a minute and the door
     * logged NOTHING. Both verbs had `return "refused"` exits with no line, and the app's own
     * catch turns a throw into the same word — so a press a person made and watched fail left
     * nothing anywhere to say what the route had answered.
     *
     * Driven through the real route: a tombstoned mailbox is the door's own `removed`, which is a
     * refusal and not a conflict — the person took the mailbox off this phone.
     */
    const p = await organizingPhone();
    p.makeUnclaimable();
    const before = p.said("organizer_claim_here_refused");
    await expect(p.engine.claimHere({ by: "press" })).resolves.toBe("refused");
    expect(p.said("organizer_claim_here_refused") - before,
      "the refused press left no line anywhere").toBe(1);
    /* THE STATUS IS ON THE LINE, which is the whole of what the device could not read. The local
       door answers 200 for every outcome and names it in the body, so the status is the floor and
       `organizer_reclaimed` is what must be ABSENT — a press that wrote nothing must not read as
       a becoming. */
    const said = p.line("organizer_claim_here_refused");
    expect(said?.status, "the line does not carry what the door answered").toBe(200);
    expect(p.said("organizer_reclaimed"),
      "a press the door recorded nothing for was logged as a re-claim").toBe(0);
  });

  it("…and an ADMITTED press writes no refusal line — the positive control", async () => {
    /* Without this the cell above is satisfied by a door that logs a refusal for every press. */
    const p = await organizingPhone();
    await expect(p.engine.claimHere({ by: "press" })).resolves.toBe("claimed");
    expect(p.said("organizer_claim_here_refused"),
      "an ordinary press was recorded as a refusal").toBe(0);
  });

  it("THE DOOR'S DECISION IS LOGGED WHEN IT IS MADE, not when the cycle ends", async () => {
    /**
     * ══ DEVICE RUN 4 ════════════════════════════════════════════════════════════════════════
     *
     * A Start after a Stop left the door silent for over a minute. The forced cycle a press asks
     * for QUEUES behind whatever drain is already running, and both decision lines stood after
     * that await — so nothing said the press had even been taken until the cycle finished.
     *
     * The wait itself is not the defect and is not bounded: `claimed` raises the background
     * session and ends the transition, so answering before the engine organizes would paint an
     * idle mailbox over a start the person was just told worked. What moves is the LINE.
     */
    const p = await organizingPhone();
    /* Back to a reader, the state a Start is pressed from. */
    await p.engine.stopOrganizing();
    const letGo = p.holdGate();
    const before = p.said("organizer_reclaimed");

    const pressing = p.engine.claimHere({ by: "press" });
    /* Let the route run and the forced cycle queue behind the held gate read. */
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
    expect(p.said("organizer_reclaimed") - before,
      "the door said nothing until the cycle it was waiting on had finished").toBe(1);
    /* AND THE PRESS HAS NOT ANSWERED, which is the half the ruling keeps: the engine does not
       organize the mailbox yet, so the press may not say it does. */
    expect(p.row().role, "the gate promoted while its own read was held").toBe("reader");

    letGo();
    await expect(pressing).resolves.toBe("claimed");
    expect(p.row().role, "the press answered `claimed` over a row that never promoted")
      .toBe("organizer");
    expect(p.meta.count, "the claim is not in the mailbox the press answered for").toBe(1);
  });

  it("STAYS released: a later poll does not honour the same request again", async () => {
    const p = await organizingPhone();
    await p.engine.stopOrganizing();
    const before = p.said("organizer_released");
    await p.engine.resume();
    await p.engine.resume();
    expect(p.said("organizer_released"), "the spent request was honoured again").toBe(before);
    expect(p.said("organizer_claim_release_yielded_to_press")).toBe(0);
    expect(p.row().role).toBe("reader");
    expect(p.meta.count, "a released reader re-claimed the mailbox").toBe(0);
  });

  it("records it with a takeover stamp ALSO standing — the guard's other column", async () => {
    /* The second of the two comparisons, and the arm the ordinary case cannot reach: with no press
       the observed stamp is NULL, which binds correctly whatever the encoder does. A row carrying
       one exercises the same fragment with a real instant on both sides. */
    const p = await organizingPhone();
    p.stampTakeover();
    expect(p.row().takeover, "the premise is a row carrying a spendable stamp").not.toBeNull();
    await expect(p.engine.stopOrganizing()).resolves.toBe("released");
    expect(p.row().role).toBe("reader");
    expect(p.row().takeover, "the release left a stamp the next poll promotes on").toBeNull();
    expect(p.said("organizer_release_write_failed")).toBe(0);
  });

  it("STOP THEN START in one process: one claim, and the row is an organizer again", async () => {
    /**
     * Device run 3, cell 3b, with the gate running between the two presses — which is the whole
     * difference from `phone-claim-door.test.ts`'s pair, where nothing cycles and the release arm
     * is therefore never reached.
     */
    const p = await organizingPhone();
    await p.engine.stopOrganizing();
    await expect(p.engine.claimHere({ by: "press" }), "the way back was refused in the process that stopped")
      .resolves.toBe("claimed");
    expect(p.row().role).toBe("organizer");
    expect(p.row().release).toBeNull();
    expect(p.meta.count, "the mailbox was claimed more than once for one press").toBe(1);
  });

  /**
   * ══ A START IS REPORTED ONLY WHERE THE CLAIM WAS ACQUIRED ════════════════════════════════
   *
   * The press is admitted, the consent is recorded, and the connection is gone by the time the
   * forced cycle reads the lease. The cycle settles through `Promise.allSettled`, so the door's
   * own `.catch()` cannot fire and never did — and the answer was `claimed` regardless: the app
   * raised its organizer session over a mailbox with no claim in `ohmail/_meta`, a row still
   * saying reader, and not one line anywhere saying so.
   *
   * `organizing` and not {@link OrganizerState.claimed}: that one is the INSTRUCTION, set before
   * the lease append and carried through an outage, so it reads `true` on this very arm.
   */
  it("does NOT report a start it could not make: no claim, and the door says so", async () => {
    const p = await organizingPhone();
    await p.engine.stopOrganizing();
    expect(p.meta.count, "the premise is a free mailbox this phone may take").toBe(0);
    p.meta.gateUnreadable = true;
    await expect(p.engine.claimHere({ by: "press" }), "a start that acquired no claim was reported as one")
      .resolves.toBe("unreadable");
    expect(p.meta.count, "nothing was claimed, which is the whole premise").toBe(0);
    expect(p.organizer().organizing, "the gate never took the permit").toBe(false);
    expect(p.said("organizer_claim_here_unconfirmed"),
      "the door answered without saying the claim was never acquired").toBe(1);
  });

  /* THE POSITIVE CONTROL — an ordinary start is still a start, and writes no unconfirmed line. */
  it("…and an ordinary start IS one: the claim is in the folder and the door says `claimed`", async () => {
    const p = await organizingPhone();
    await p.engine.stopOrganizing();
    await expect(p.engine.claimHere({ by: "press" })).resolves.toBe("claimed");
    expect(p.meta.count).toBe(1);
    expect(p.organizer().organizing).toBe(true);
    expect(p.said("organizer_claim_here_unconfirmed")).toBe(0);
  });
});

/**
 * ══ AND THE PATH BESIDE IT — a stand-down spends the same stamp through the same fragment ══
 *
 * `mayOrganize`'s demotion write clears the takeover stamp with `case when … is not distinct from
 * …`, bound the same way. With a stamp standing, the whole transaction threw on the device store:
 * the role, the holder columns and the handover of pending local moves were all rolled back, so
 * the row went on saying this install organizes a mailbox another machine holds.
 */
describe.runIf(ON_DEVICE_STORE)("a stand-down with a press standing", () => {
  it("demotes the row and spends the stamp, rather than rolling the whole write back", async () => {
    const p = await organizingPhone();
    p.stampTakeover();
    expect(p.row().takeover).not.toBeNull();
    /* ANOTHER MACHINE TAKES THE MAILBOX. `authorizedAt` is a press, which is how a claim outranks
       an incumbent since 0.14.1 — otherwise this fixture would model an arrival that loses. */
    const now = new Date();
    await p.meta.appendClaim(formatClaim({
      protocol: 1, installId: "the-studio-mac", kind: "local", displayName: "Studio Mac",
      nonce: "a-stand-down", heartbeat: now, claimedAt: now, authorizedAt: now, capabilities: [],
    }));
    await p.engine.resume();
    expect(p.said("organizer_stand_down_write_failed"), "the demotion could not be written").toBe(0);
    expect(p.row().role, "the row still says this install organizes a mailbox somebody else holds")
      .toBe("reader");
    expect(p.row().takeover, "the stamp survived, so the next poll takes the mailbox back")
      .toBeNull();
    expect(p.engine.runtimes().organizer[Object.keys(p.engine.runtimes().organizer)[0]!]!.organizing)
      .toBe(false);
  });
});

/**
 * ══ THE OTHER HALF OF THE SAME WRITE — the handover of pending local moves ═══════════════════
 *
 * The demotion and the handover ride ONE transaction, so a statement either of them cannot run on
 * this store rolls both back and the row goes on saying this install organizes. The case above
 * exercises the demotion with a stamp standing; neither it nor anything else reached the handover
 * here, whose walk is a keyset over `(updated_at, id)` and whose mint is an `insert … returning`.
 * Both were carried by the dialect seam and NEITHER had been measured on this store.
 */
describe.runIf(ON_DEVICE_STORE)("a stand-down that has moves to hand over", () => {
  /** Another machine takes the mailbox, with a press, which is what a stand-down needs. */
  async function takenAway(p: Phone): Promise<void> {
    const now = new Date();
    await p.meta.appendClaim(formatClaim({
      protocol: 1, installId: "the-studio-mac", kind: "local", displayName: "Studio Mac",
      nonce: "a-hand-over", heartbeat: now, claimedAt: now, authorizedAt: now, capabilities: [],
    }));
    await p.engine.resume();
  }

  it("mints a request for each pending intent and demotes in the same transaction", async () => {
    const p = await organizingPhone();
    p.seedPendingMove();
    await takenAway(p);
    expect(p.said("organizer_stand_down_write_failed"), "the demotion could not be written").toBe(0);
    expect(p.exported(), "the intent stayed pending on an install that may not perform it").toBe(1);
    expect(p.detail("organizer_stand_down_moves_handed_over")[0]?.exported).toBe(1);
    expect(p.row().role).toBe("reader");
  });

  it("WALKS PAST ONE PAGE: the keyset cursor is the statement nothing else reaches", async () => {
    /* `STAND_DOWN_EXPORT_MAX` is 200, and the cursor fragment is only COMPILED once a page comes
       back full — a row-value comparison whose right-hand side is a timestamp bound through the
       seam. One intent past a full page is the smallest input that reaches it. */
    const p = await organizingPhone();
    p.seedPendingMove(201);
    await takenAway(p);
    expect(p.said("organizer_stand_down_write_failed"), "the second page could not be read").toBe(0);
    expect(p.exported(), "the walk stopped at the page boundary").toBe(201);
    expect(p.row().role).toBe("reader");
  });
});

/**
 * ══ A STOP GIVES THE CLAIM BACK ══════════════════════════════════════════════════════════════
 *
 * `stop()` used to close the store and leave the record in `ohmail/_meta` to age out: ten minutes
 * (`DEFAULT_STALE_AFTER_MS`) in which NO install organizes the mailbox — this one is gone and every
 * other one is refused by a claim nobody is renewing — and a relaunch inside that window verifying
 * against its own residue. It now goes back through `handBack`, the one door.
 *
 * Read off the FOLDER and never off a local row: the row is deliberately untouched by a hand-back,
 * so a row read would agree with a stop that released nothing.
 */
describe.runIf(ON_DEVICE_STORE)("a phone's stop, on the device store", () => {
  it("hands the claim back, and leaves the ROW saying organizer", async () => {
    const p = await organizingPhone();
    expect(p.row().role).toBe("organizer");
    await p.engine.stop();
    expect(p.meta.count, "the stop left its claim standing in the folder").toBe(0);
  });

  it("A RELAUNCH MEETS AN EMPTY FOLDER and writes a claim of its own", async () => {
    /* The ruling's own sentence, measured: what identifies this install's claim is the PAIR — its
       install id and its own nonce. A relaunch is a new run and can hold neither of the previous
       one's, so it must find nothing to resume and claim freshly. */
    const file = storeFile();
    const meta = new MemoryMetaFolder();
    const first = await organizingPhone({ file, meta });
    expect(first.row().role).toBe("organizer");
    await first.engine.stop();
    expect(meta.count, "the stop left a claim for the relaunch to verify against").toBe(0);

    /* THE FIXTURE'S CREDENTIAL GOES FIRST. It is not a sealed blob — the launch above never read
       one — so a relaunch that met it would refuse the mailbox and remove it, and this case would
       be measuring the fixture. The mailbox row, which is what the case is about, is untouched. */
    const scrub = nodeExecutor(file);
    scrub.direct("delete from mailbox_credentials");
    await scrub.close();

    const second = await organizingPhone({ file, meta, seed: false });
    expect(second.row().role, "the hand-back demoted the row it is supposed to leave alone")
      .toBe("organizer");
    expect(meta.count, "the relaunch holds no claim").toBe(1);
    expect(second.said("organizer_stand_down"), "the relaunch stood down against its own residue")
      .toBe(0);
  });

  it("A HAND-BACK AND A RESUME leave ONE claim, not two", async () => {
    /* The app leaving the foreground and coming back. The claim goes and comes; what must never
       happen is the folder ending with two of ours, which is the renew residue this install's own
       kind cannot rank. */
    const p = await organizingPhone();
    await p.engine.handBack();
    expect(p.meta.count, "the hand-back left the claim standing").toBe(0);
    await p.engine.resume();
    expect(p.meta.count, "the resume wrote a second claim").toBe(1);
    expect(p.row().role, "the hand-back wrote the row, which is the release's job and not its")
      .toBe("organizer");
  });
});

/**
 * ══ THE ROW FOLLOWS THE CLAIM, AND TWO PRODUCT EVENTS ARE THE WITNESS ════════════════════════
 * The invariant: the row every write door consults says `organizer` before any permit exists to
 * write with — a confirmed claim over a row still saying `reader` is the install organizing on
 * IMAP while its own API answers `409 organized_elsewhere` about itself. It followed the claim by
 * 188-214 ms before the promotion moved ahead of `acquireLeasePermit`, and no DURATION guards
 * that, so the guard reads the ORDER of `organizer_row_promoted` and `lease_permit_granted` —
 * never this fixture's `stampMeta` invocation, which the baseline move put ahead of the row on
 * purpose. `MemoryMetaFolder` has no `stampMeta`, so every case above awaits nothing here.
 */
class StampedMeta extends MemoryMetaFolder {
  /**
   * What the ROW said each time the folder was asked to hold still. A RECORD, kept because it is
   * worth seeing in a failure, and not an order claim: the baseline is issued with the claim, so
   * this reads the instant BEFORE the promotion by design. The order is read off the log.
   */
  readonly rolesAtStamp: (string | null)[] = [];
  /** Wired after the store exists — the probe is what reads the row, at the instant it runs. */
  roleNow: () => string | null = () => null;
  /**
   * A FAULT NO SHIPPED IMPLEMENTATION CAN PRODUCE, and that is the point of having it here.
   *
   * `makeLeaseIo#stampMeta` is one IMAP STATUS under a blanket `catch` that answers `null` for
   * every way of failing — *"Nothing here decides whether anybody organizes anything."* So the
   * permit's adopt path performs no election and this probe, its only AWAIT, cannot refuse it.
   * What CAN is the synchronous `adapter.leaseIo()` beside it, whose real implementation asserts
   * the connection is usable — a breach, never a lease verdict. The arm below injects the
   * refusal the probe cannot produce, because the question the ordering raises is what a failure
   * between the claim and the row leaves behind, and that is worth measuring rather than arguing.
   */
  stampThrows = false;
  async stampMeta(): Promise<MetaFolderStamp | null> {
    this.rolesAtStamp.push(this.roleNow());
    if (this.stampThrows) throw new Error("the STATUS on ohmail/_meta was refused");
    return { messages: this.count, uidNext: this.count + 1, uidValidity: 4_100 };
  }
}

/**
 * A CONSENTED READER WITH A PRESS STANDING — the row exactly as the organize door leaves it.
 *
 * `organizingPhone` seeds `organizer_role = 'organizer'`, which is the state AFTER the promotion
 * and cannot measure it. The door writes consent and the stamp in one statement and deliberately
 * writes no role (*"The GATE promotes"*), so this is that row, and the resume below is the pass
 * that has to move it.
 */
async function pressedReader(meta: StampedMeta): Promise<{
  engine: PhoneEngine; lines: Line[]; role(): string | null; said(event: string): number;
}> {
  const exec = nodeExecutor();
  const lines: Line[] = [];
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "a@b.test", pass: "pw-not-used-password-password" },
    },
    machineName: "ohmail on a phone",
    installId: OUR_INSTALL,
    adapterFactory: quietMailbox(meta).factory,
    log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  const role = (): string | null => {
    const [r] = exec.direct(
      "select organizer_role as role from mailboxes where id = ?", [id],
    ) as { role: string }[];
    return r?.role ?? null;
  };
  exec.direct(
    `insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
     values (?, 'imap', 'not-a-secret', 1)`,
    [id],
  );
  exec.direct(
    `update mailboxes set organizer_role = 'reader', organize_consented_at = 1,
       takeover_authorized_at = ?, status = 'connected' where id = ?`,
    [Date.now(), id],
  );
  expect(role(), "the premise is the row the organize door leaves behind").toBe("reader");
  meta.roleNow = role;
  return {
    engine, lines, role,
    said: (event: string) => lines.filter((l) => l.event === event).length,
  };
}

describe.runIf(ON_DEVICE_STORE)("the claim and the row are one act", () => {
  it("THE ORDER: the row is promoted before the permit is granted", async () => {
    const meta = new StampedMeta();
    const p = await pressedReader(meta);
    await p.engine.resume();

    /* THE PREMISE, IN THREE PARTS, and without all three every assertion below is green for
       nothing. A missing event answers `-1` from `findIndex`, which compares LESS THAN every real
       position — so an order read over a line that was never written is the exact shape of a
       vacuous pass, and the counts are what close it. The permit also has to have been asked at
       all, and the pass has to have won its election. */
    expect(p.said("organizer_row_promoted"), "the row was never promoted, or was promoted twice")
      .toBe(1);
    expect(p.said("lease_permit_granted"), "no permit was granted, or more than one was").toBe(1);
    expect(meta.rolesAtStamp.length, "the permit never asked the folder to hold still")
      .toBeGreaterThan(0);
    expect(meta.count, "the premise is a pass that won the election and wrote its claim").toBe(1);

    /* THE ASSERTION, over two PRODUCT lines. The row that gates every write says `organizer`
       before anything holds a permit to write with; with the promotion moved behind
       `acquireLeasePermit` these two swap and this reads red by name. */
    const at = (event: string): number => p.lines.findIndex((l) => l.event === event);
    expect(at("organizer_row_promoted"),
      "the permit was granted while the row still said reader — the claim stands in the folder "
      + "and the row that gates every write does not agree with it")
      .toBeLessThan(at("lease_permit_granted"));
    expect(p.role(), "the pass ended without promoting the row").toBe("organizer");
  });

  it("A REFUSED PROBE leaves the row saying what the folder says, and the next pass organizes",
    async () => {
      /* The injected fault of {@link StampedMeta.stampThrows}. What it establishes is narrow and
         worth stating: the promotion is now AHEAD of the permit, so whatever the permit does the
         row already agrees with the folder. The claim was elected and verified, so `organizer` is
         the TRUE answer here — the pass has no write receipt, which is what stops it writing, and
         the row is not the receipt. */
      const meta = new StampedMeta();
      meta.stampThrows = true;
      const p = await pressedReader(meta);
      await p.engine.resume().catch(() => undefined);

      expect(meta.count, "the claim this install won is in the folder").toBe(1);
      expect(p.role(), "a refused probe left the row disagreeing with the folder it won")
        .toBe("organizer");

      /* AND THE RETRY IS WATCHED, not assumed. */
      meta.stampThrows = false;
      await p.engine.resume();
      const id = Object.keys(p.engine.runtimes().organizer)[0]!;
      expect(p.engine.runtimes().organizer[id]!.organizing,
        "the next pass did not take the mailbox the row and the folder both give it").toBe(true);
      expect(p.role()).toBe("organizer");
    });
});
