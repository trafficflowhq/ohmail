/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S CONSENT DOOR — a live foreign claim is a 409, and it is DRIVEN THROUGH THE ROUTE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `apps/mobile/src/net/mailboxes.ts` has always claimed that `POST /mailboxes/:id/organize`
 * *"answers 409 where another install holds the mailbox"*, and the route did not:
 * `MailboxService.organizeHere` writes a stamp and leaves the decision to the gate. That is right
 * for a desktop — there the press is a person's finger and the 0.14.1 election is meant to let
 * somebody take a mailbox back from a machine they can no longer reach — and it was reached on a
 * phone by a LAUNCH. Measured on a device beside a second install holding the claim: the engine
 * decided `stand_down` at +2 s, the app's launch press was answered 202 2.3 s later, and the phone
 * held the claim at +19 s. Two organizers of one mailbox, nobody asked, no sentence anywhere.
 *
 * So the claim becomes true at the PHONE's own door, and only there. Every case below presses the
 * real route through the real composition — `engine.handle(new Request(...))` — because a unit of
 * the predicate would prove nothing about what a press does: *"a refusal is only as real as the
 * PIPELINE the route runs"*.
 *
 * ── WHAT DECIDES, AND WHY IT IS NOT THE STAND-DOWN REASON ─────────────────────────────────
 *
 * `organizer_state` is written from the gate's APPEND-less peek and is `held` only while a claim in
 * `ohmail/_meta` is still being RENEWED (`peekLease`). So it is liveness. `disabled_reason` is the
 * row's MEMORY of a stand-down and outlives the holder — a phone whose laptop has gone away would
 * be refused its own mailbox for ever if the refusal read that instead, which is the defect on the
 * other side of this lane (the holder-left row).
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT, on `phone-engine-boot.test.ts`'s own argument ────────
 *
 * The whole engine is composed over the DEVICE store, so it needs `vitest.sqlite.config.ts`'s
 * schema substitution. Under the default project it states the premise rather than skipping in
 * silence. No socket is opened: the adapter is a double, and the only "request" anywhere is an
 * in-process `Request` object.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeAuthConfig } from "@trafficflow/services/mail";
import { IMAP_META_DEADLINE_MS } from "@trafficflow/core/adapters/imap";
import type { RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { LeaseUnavailableError, formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";

/**
 * THE STEP-UP WINDOW, READ FROM THE PRODUCT'S OWN CONFIG and never spelled here.
 *
 * The cases below turn the clock past it. A literal would keep passing if the number moved and
 * would stop measuring the thing it names; this reads the same value `withStepUp` reads.
 */
const STEP_UP_WINDOW_MS = makeAuthConfig({ rpID: "localhost", origin: "http://localhost" })
  .stepUpWindowMs;

/**
 * A CLOCK THE CASE OWNS. `startPhoneEngine` threads `now` all the way to `ApiDeps`, which is what
 * `withStepUp` compares the launch session's `lastTwofaAt` against — so advancing this is exactly
 * what a phone that has been open for six minutes does, without waiting six minutes.
 */
function clock(): { now: () => Date; advance: (ms: number) => void } {
  let t = Date.UTC(2026, 8, 12, 10, 0, 0);
  return { now: (): Date => new Date(t), advance: (ms: number): void => { t += ms; } };
}

/** Past the window by a minute — the device's own +6 m 06 s, rounded to the config. */
const PAST_THE_WINDOW_MS = STEP_UP_WINDOW_MS + 60_000;

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

/** `phone-engine-boot.test.ts`'s statement runner, with its yield — see that file for why it must yield. */
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
        const statement = raw.prepare(sql);
        const columns = (statement.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
        const objects = statement.all(...(params as unknown[])) as Record<string, unknown>[];
        return {
          columns,
          rows: columns.length > 0
            ? objects.map((o) => columns.map((c) => o[c]))
            : objects.map((o) => Object.values(o)),
        };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.prepare(sql).run(...(params as unknown[]));
      });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          raw.exec("ROLLBACK");
          throw err;
        }
      });
    },
    async close(): Promise<void> { raw.close(); },
    /** THE SAME HANDLE, synchronously — a case seeds and reads the row the engine is serving. */
    direct: (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params),
  };
}

const OUR_INSTALL = "install-marker-abc";

/**
 * THE DOUBLE HAS THE ACCESSOR PRODUCTION HAS, and that is not a convenience.
 *
 * It used to be `{ close }` alone — no `leasePeekIo`, the read-only accessor every real
 * `ImapAdapter` carries. The door then reached `organizer_state` NULL, read it as "nobody holds
 * this mailbox", and admitted the press; measured on this composition, every case below that
 * expects 202 passed for a door that could not see the claim folder at all. That is the defect
 * `LEASE-PEEK-ENGINE-ADAPTER-BLIND` names — *"a test that builds its own adapter goes green over
 * it"* — so the default double answers an EMPTY folder, which is the fact the 202 cases mean, and
 * the two cases at the bottom of this file supply the other two answers instead.
 */
const EMPTY_META = () => ({ listClaims: async () => [] as { ref: unknown; raw: string }[] });

/**
 * ══ AND A DOUBLE THE LEASE GATE CAN ANSWER, because the door's word is the PASS's ═══════════
 *
 * `claimHere` answers `claimed` only where the runtime reports `organizing`, which is a
 * DECLARATION a gated cycle makes — the door says so itself, and refuses to read
 * `OrganizerState.claimed`, the instruction, because that one survives an outage. The double
 * above has `leasePeekIo` and no `leaseIo`, so `resume()`'s forced cycle cannot reach the gate
 * and nothing ever declares. The three cases that expect `claimed` were passing on the runtime's
 * ATTACH-TIME default instead — `organizing: true` taken from the row before any pass — and when
 * that default became honest they read `unreadable`, which is this fixture's true state. So the
 * fixture grows the property it was asserting about: an `ohmail/_meta` the gate can list and
 * append to, and a mailbox quiet enough that the cycle settles.
 */
class MemoryMeta {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /**
   * A folder THE GATE cannot look into, and the PEEK still can — which is not a convenience.
   *
   * The door peeks before it records anything and refuses `unreadable` there on its own, without
   * writing a consent; that path is somebody else's case. What this one needs is the press
   * ADMITTED and the forced cycle failing after it, which is where the runtime's declaration
   * decides the door's word. Two accessors, so the two can differ — production's do.
   */
  unreadable = false;
  /** The gate's read refused by name (`meta_folder_full`, …); the peek still answers. */
  refusedAs: "meta_folder_full" | "meta_undeletable" | null = null;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    if (this.refusedAs !== null) throw new LeaseUnavailableError("refused by name", { op: this.refusedAs });
    if (this.unreadable) {
      throw new LeaseUnavailableError("ohmail/_meta could not be read", { op: "list_claims" });
    }
    return this.peek();
  }
  /** What the APPEND-less read answers, whatever the gate's own read is doing. */
  async peek(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
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

/** The quiet mailbox `phone-resume-that-did-not-start.test.ts` drives, narrowed to this file. */
function claimable(meta: MemoryMeta): () => MailboxAdapter {
  return () => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.peek() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities() {
      return {
        move: true, uidplus: true, condstore: true, qresync: false,
        idle: true, specialUse: true, sentFolder: null,
      };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince() {
      return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
    },
    async move(locator: unknown): Promise<unknown> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(): Promise<never> { throw new Error("this test's mailbox must never be asked to send"); },
    async fetchPart(): Promise<never> { throw new Error("this mailbox cannot fetchPart"); },
  }) as unknown as MailboxAdapter;
}

type AdapterFactory = NonNullable<Parameters<typeof startPhoneEngine>[0]["adapterFactory"]>;

function deps(exec: PhoneSqlExecutor, over: Record<string, unknown> = {}): Parameters<typeof startPhoneEngine>[0] {
  const made = {
    exec,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "ohmail on a phone",
    installId: OUR_INSTALL,
    adapterFactory: () => ({
      close: async () => undefined,
      leasePeekIo: EMPTY_META,
    }) as unknown as MailboxAdapter,
    ...over,
  } as Parameters<typeof startPhoneEngine>[0];
  /* EVERY DOUBLE HERE SIGNS IN: Connect opens a mailbox only over a login, and these
     cases are about the claim door, not the dial. One that brings its own `connect` keeps it. */
  const make = made.adapterFactory as AdapterFactory;
  const signedIn: AdapterFactory = (...args) => {
    const adapter = make(...args);
    return "connect" in adapter ? adapter : Object.assign(adapter, { connect: async (): Promise<void> => undefined });
  };
  return { ...made, adapterFactory: signedIn };
}

const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

let live: PhoneEngine | null = null;
afterEach(async () => {
  if (live) await live.stop().catch(() => undefined);
  live = null;
});

/** The engine's own name for the mailbox it serves — the key of its runtime map. */
const soleMailbox = (engine: PhoneEngine): string => {
  const ids = Object.keys(engine.runtimes().organizer);
  expect(ids, "the engine did not report exactly one mailbox").toHaveLength(1);
  return ids[0]!;
};

/**
 * A STORED IMAP CREDENTIAL, because the ceremony requires one and the device always had one.
 *
 * `organizeHere` refuses a claim-back with no password anywhere — 422 `credential_needed`, and
 * rightly: *"a stamp on a mailbox whose stored login no longer works is an action that looks like
 * it worked and leaves the mailbox quarantined"*. This composition's launch never seals one (the
 * adapter is a double that signs in and can do nothing after it), so the row is seeded. Its
 * content is never read by anything here — the check is on the ROW's existence.
 */
const seedCredential = (exec: { direct: (sql: string, p?: unknown[]) => unknown[] }, id: string): void => {
  exec.direct(
    `insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
     values (?, 'imap', 'not-a-secret', 1)`,
    [id],
  );
};

/** Press a route with this launch's bearer and the body given — `{}` unless a case says otherwise. */
const pressPath = (engine: PhoneEngine, path: string, body = "{}"): Promise<Response> => engine.handle(
  new Request(`http://engine.invalid${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${engine.sessionToken}`,
      "content-type": "application/json",
    },
    body,
  }),
);

/** The person's marker, exactly as `apps/mobile/src/net/mailboxes.ts#organizeHere` sends it. */
const PERSON = JSON.stringify({ consent: "person" });

/** The SHARED spelling — `stepUp: true`, and not served on this door. */
const press = (engine: PhoneEngine, id: string, path = "organize"): Promise<Response> =>
  pressPath(engine, `/mailboxes/${encodeURIComponent(id)}/${path}`);

/**
 * THE CONSENT DOOR THIS BUILD SERVES — `/local/`, which the app and `claimHere` both press.
 *
 * It answers 200 for every outcome and names it in the body; the shared route split the same
 * answer across 202/200. See `mobile.ts#LOCAL_ORGANIZE_PATH` for why the spelling moved.
 */
const pressLocal = (engine: PhoneEngine, id: string): Promise<Response> =>
  pressPath(engine, `/local/mailboxes/${encodeURIComponent(id)}/organize`);

/**
 * THE APP'S CONNECT PRESS — the local door with the person's consent. `pressLocal`
 * above carries none, which is the claim watch's shape: over a row nobody consented on it is
 * answered `no_consent`, and on a refusal it writes nothing.
 */
const pressConnect = (engine: PhoneEngine, id: string): Promise<Response> =>
  pressPath(engine, `/local/mailboxes/${encodeURIComponent(id)}/organize`, PERSON);

/** The outcome the local door named, or `""` where the body could not be read. */
const outcomeOf = async (res: Response): Promise<string> =>
  await res.json().then((b) => String((b as { outcome?: unknown }).outcome), () => "");

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT, "OHMAIL_EXPECT_DIALECT is unset — neither project declared itself").toBeDefined();
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("the consent route on a phone", () => {
  it("REFUSES 409 with the holder while another install is renewing its claim", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    /* THE ROW AS A STAND-DOWN LEAVES IT: reader, a live foreign claim, the holder named. This is
       exactly what `organizer_stand_down disabledReason:"organized_elsewhere:local" heldBy:"a
       laptop" state:"held"` wrote on the device. */
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop', disabled_reason = 'organized_elsewhere:local'
       where id = ?`,
      [id],
    );
    const res = await press(live, id);
    expect(res.status, "the door admitted a press over a live foreign claim").toBe(409);
    const body = await res.json() as { error?: { code?: string }; holder?: { name?: string; kind?: string } };
    expect(body.error?.code).toBe("organized_elsewhere");
    /* THE HOLDER RIDES THE REFUSAL, because the app has no other source for it on this door. */
    expect(body.holder).toEqual({ name: "a laptop", kind: "local" });
    /* AND NOTHING WAS WRITTEN. The stamp is what a gate spends to promote, so its absence is the
       whole invariant: no consent, no authorization, no second organizer. */
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.t, "a takeover was authorized over a live foreign claim").toBeNull();
    expect(row!.c, "a consent was recorded over a live foreign claim").toBeNull();
  });

  it("ADMITS the press once no claim is being renewed — the positive control", async () => {
    /* Without this the refusal above is satisfied by a door that refuses everything. Same row,
       same reader role, same stand-down memory; only the LIVENESS differs. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         organized_by_name = null, organized_by_kind = null, organized_by_install_id = null,
         disabled_reason = 'organized_elsewhere:local'
       where id = ?`,
      [id],
    );
    const res = await pressConnect(live, id);
    expect(res.status, "the door refused a mailbox nothing holds").toBe(200);
    expect(await outcomeOf(res)).toBe("authorized");
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.t, "the authorization the gate spends was not written").not.toBeNull();
    expect(row!.c, "the consent was not recorded").not.toBeNull();
  });

  it("REFUSES 409 on the LOCAL spelling too — the door the press actually uses", async () => {
    /* THE REGRESSION GUARD FOR THE MOVE. `claimHere` and the app's `organizeHere` both press
       `/local/` now; a 409 that named only the shared spelling would have left the one-organizer
       rule with a door beside it. Same row as the first case, same holder, other path. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop', disabled_reason = 'organized_elsewhere:local'
       where id = ?`,
      [id],
    );
    const res = await pressLocal(live, id);
    expect(res.status, "the local door admitted a press over a live foreign claim").toBe(409);
    const body = await res.json() as { error?: { code?: string }; holder?: unknown };
    expect(body.error?.code).toBe("organized_elsewhere");
    expect(body.holder).toEqual({ name: "a laptop", kind: "local" });
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.t, "a takeover was authorized over a live foreign claim").toBeNull();
    expect(row!.c, "a consent was recorded over a live foreign claim").toBeNull();
  });

  it("does NOT SERVE the shared consent route at all — it is the one with the second factor", async () => {
    /* Measured on a device: the shared route answered 403 `step_up_required` at +6 m 06 s and
       +14 m 30 s, because a standalone launch stamps its second factor ONCE at boot. A caller
       aimed at that spelling is a caller that cannot work past the first five minutes, so the
       path is absent rather than discouraged. Nothing holds this mailbox, so the 409 above does
       not answer first — this is the route's own verdict. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    const res = await press(live, id);
    expect(res.status, "the step-up'd spelling is still served on this door").toBe(404);
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.t, "the absent route wrote a stamp").toBeNull();
    expect(row!.c, "the absent route recorded a consent").toBeNull();
  });

  it("ADMITS the local press SIX MINUTES into the launch — the window is not this tier's", async () => {
    /* THE APP'S CONNECT PATH, past the step-up window. At the base this press was the shared
       route and answered 403 for the life of the process; the same sequence here writes the
       consent. The clock is the case's own and is advanced past the product's own number. */
    const exec = nodeExecutor();
    const c = clock();
    live = await startPhoneEngine(deps(exec, { now: c.now }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         disabled_reason = 'organized_elsewhere:local' where id = ?`,
      [id],
    );
    c.advance(PAST_THE_WINDOW_MS);
    const res = await pressConnect(live, id);
    expect(res.status, "a press six minutes into the launch was refused").toBe(200);
    expect(await outcomeOf(res)).toBe("authorized");
    const [row] = exec.direct(
      "select takeover_authorized_at as t from mailboxes where id = ?",
      [id],
    ) as { t: number | null }[];
    expect(row!.t, "the authorization the gate spends was not written").not.toBeNull();
  });

  it("does not read ITS OWN stranded claim as foreign — own-role resumption still works", async () => {
    /* A restored image, a crash, a dead predecessor's record. The claim carries THIS install's id,
       so it is not somebody else's mailbox and refusing it would leave a person unable to start
       their own phone again. The NULL-id direction stays refused; see the case above. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'ohmail on a phone', organized_by_kind = 'mobile',
         organized_by_install_id = ?
       where id = ?`,
      [OUR_INSTALL, id],
    );
    const res = await pressConnect(live, id);
    expect(res.status).toBe(200);
    expect(await outcomeOf(res)).toBe("authorized");
  });

  it("refuses a live claim whose install id the row does not carry", async () => {
    /* `organized_by_install_id` is NULL on every row written before that column existed. "We
       cannot say the claim is ours" is not "the claim is ours", and for a REFUSAL the safe
       direction is the one that keeps the one-organizer invariant. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = '', organized_by_kind = 'local', organized_by_install_id = null
       where id = ?`,
      [id],
    );
    const res = await press(live, id);
    expect(res.status).toBe(409);
    /* NAMED NOTHING, which is a different fact from NO HOLDER — the status is what says which. */
    expect((await res.json() as { holder?: { name?: string } }).holder?.name).toBe("");
  });

  it("leaves every other route alone — the refusal is scoped to the consent path", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_install_id = 'the-laptop'
       where id = ?`,
      [id],
    );
    /* THE RELEASE IS THE OPPOSITE DIRECTION and must stay answerable: a person standing next to a
       phone that is refusing to organize must still be able to stop it trying. */
    expect((await press(live, id, "release")).status).not.toBe(409);
    /* AND A GET OF THE ROSTER is untouched — the refusal keys on the METHOD as well as the path. */
    const roster = await live.handle(new Request("http://engine.invalid/mailboxes", {
      headers: { authorization: `Bearer ${live.sessionToken}` },
    }));
    expect(roster.status).toBe(200);
  });
});

describe.runIf(ON_DEVICE_STORE)("the person's two verbs, on the engine's own door", () => {
  it("STOP records the release on the ROW, which is what a relaunch reads", async () => {
    /* The defect this closes: `handBack()` removes the claim and leaves the row saying organizer,
       so the next foreground resume claimed the mailbox again — measured on a device as a claim
       written into `ohmail/_meta` and then never serviced. `release_requested_at` is the durable
       half; the gate honours it before it reads the lease at all. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    /* A CONSENTED ORGANIZER, which is the only state a stop is about. */
    exec.direct(
      `update mailboxes set organizer_role = 'organizer', organize_consented_at = 1,
         status = 'connected' where id = ?`,
      [id],
    );
    await expect(live.stopOrganizing()).resolves.toBe("released");
    /* ── WHAT A RELAUNCH READS, AND IT IS THE ROLE ────────────────────────────────────────
     *
     * This asserted `release_requested_at` still standing, which was the request rather than the
     * record of it — and it stood only because the gate's guarded write could not run on this
     * store. The verb forces one gated cycle precisely so the ceremony COMPLETES, so the durable
     * half is the shape the gate leaves: a consented reader carrying `organizer_released_at`,
     * with the request spent so no later poll honours it twice. A reader with no press never
     * re-enters the gate, which is what makes the stop survive a kill. */
    const [row] = exec.direct(
      `select release_requested_at as r, organizer_role as role, organizer_released_at as rel,
         organize_consented_at as c from mailboxes where id = ?`,
      [id],
    ) as { r: number | null; role: string; rel: number | null; c: number | null }[];
    expect(row!.role, "the person's stop was not recorded where a relaunch reads it").toBe("reader");
    expect(row!.rel, "nothing marks the stop as having happened").not.toBeNull();
    expect(row!.r, "the request still stands, so the next poll honours it again").toBeNull();
    /* AND THE MAILBOX KEEPS ITS CONSENT, ITS LOGIN AND ITS MIRROR — the whole difference between
       stopping and removing, and what `settingsStopHereWhat` promises. */
    expect(row!.c, "the release took the consent with it").not.toBeNull();
  });

  it("STOP answers `not_organizing`, and writes nothing, over a mailbox this install does not organize", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    exec.direct("update mailboxes set organizer_role = 'reader' where id = ?", [id]);
    /* NOT `refused`: the route answered 200 because there was nothing of ours to give up, which
       is a settled state and not a failure — and not a release either. */
    await expect(live.stopOrganizing()).resolves.toBe("not_organizing");
    const [row] = exec.direct(
      "select release_requested_at as r from mailboxes where id = ?",
      [id],
    ) as { r: number | null }[];
    expect(row!.r).toBeNull();
  });

  it("CLAIM answers `held` over a live foreign claim, and writes nothing", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_install_id = 'the-laptop'
       where id = ?`,
      [id],
    );
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("held");
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.t).toBeNull();
    /* THE WATCH'S REFUSED PRESS WRITES NO CONSENT EITHER: only a person's press carries one. */
    expect(row!.c, "the claim watch recorded a consent on a refused press").toBeNull();
  });

  /* THE CLAIM WATCH'S QUESTION, ASKED OF THE ROW WITH NO PRESS: held while the
     claim is renewed, free once it is not, and nothing written either way. */
  it("HELD ELSEWHERE reads the row: true while renewed, false once stopped, no press", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_install_id = 'the-laptop'
       where id = ?`,
      [id],
    );
    await expect(live.heldElsewhere()).resolves.toBe(true);
    exec.direct("update mailboxes set organizer_state = 'stopped' where id = ?", [id]);
    await expect(live.heldElsewhere()).resolves.toBe(false);
    exec.direct("update mailboxes set organizer_state = null where id = ?", [id]);
    await expect(live.heldElsewhere()).resolves.toBeNull();
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.t).toBeNull();
    expect(row!.c).toBeNull();
  });

  /**
   * ══ THE REFUSAL NAMES THE HOLDER WHERE THE APP ALREADY READS HOLDERS ══════════════════════
   *
   * The 409's body has always carried `holder`, and `claimHere()` answered the app one word. So a
   * press refused over a mailbox another install organizes changed NOTHING a person could see:
   * measured on a device, the panel read `['Nothing organizes this mailbox', 'Start organizing
   * here', 'Start organizing here']` at every reading over the following minute after the refusal, and
   * again after leaving Settings and coming back — the free-mailbox sentence and a live Start verb
   * over a mailbox another phone was actively organizing.
   *
   * The holder is recorded on the organizer state the app already reads, so there is one answer to
   * "who holds this mailbox" rather than a second channel. `reason` is what makes the app's claim
   * `theirs` — the chip, the reader sentence, no Start verb — and it is also what arms the claim
   * watch, so the phone comes back on its own when the holder goes away.
   */
  it("CLAIM records the holder it was refused to, where the panel reads it", async () => {
    const exec = nodeExecutor();
    /* THE GATE CAN RUN HERE — see {@link claimable}. The admitted press at the end of this
       case asks for `claimed`, and only a declared pass can answer that. */
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(new MemoryMeta()) }));
    const id = soleMailbox(live);
    /* THE CONTROL FIRST: before any press, the engine names nobody — so a `heldBy` below is this
       refusal's doing and not the row leaking through. */
    expect(live.runtimes().organizer[id]!.heldBy).toBeNull();
    expect(live.runtimes().organizer[id]!.reason).toBeNull();
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop'
       where id = ?`,
      [id],
    );
    /* A PERSON'S press: refused, with the consent kept — the word says so (RULING-026 Q3). */
    await expect(live.claimHere({ by: "press" })).resolves.toBe("held_consented");
    const after = live.runtimes().organizer[id]!;
    expect(after.heldBy, "the door refused a press and the app had no way to name the holder")
      .toBe("a laptop");
    expect(after.reason, "the kind the sentence reads did not travel with the holder")
      .toBe("organized_elsewhere:local");
    expect(after.organizing, "a refused press left this install reading as the organizer").toBe(false);
    /* THE OCCUPANCY RIDES WITH IT: the card reads `holderState`, and the look's stale word from
       before the press put "Nothing organizes" and Start over the holder until the next look. */
    expect(after.holderState, "the refusal kept the look's stale occupancy").toBe("held");
    /* AND IT DOES NOT OUTLIVE ITS TRUTH. The holder goes away, the next press is admitted, and the
       sentence goes with it — a refusal that stood after the mailbox was free would be the same
       defect pointing the other way. */
    seedCredential(exec, id);
    exec.direct(
      "update mailboxes set organizer_state = null, disabled_reason = null where id = ?",
      [id],
    );
    await expect(live.claimHere({ by: "press" })).resolves.toBe("claimed");
    expect(live.runtimes().organizer[id]!.heldBy, "the holder outlived the claim it named").toBeNull();
  });

  it("…and over a gate's own stand-down, whose look is older than the refusal", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    await expect(live.claimHere({ by: "press" })).resolves.toBe("claimed");
    const laptop = () => meta.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: `laptop-${Date.now()}`, authorizedAt: new Date(), capabilities: [],
    }));
    await laptop();
    await live.resume();
    for (const c of await meta.peek()) {
      if (c.raw.includes("X-Ohmail-Install-Id: the-laptop")) await meta.removeClaims([c.ref]);
    }
    await live.resume();
    const stood = live.runtimes().organizer[id]!;
    expect([stood.reason, stood.holderState], "premise: a stand-down whose look reads nobody").toEqual(
      ["organized_elsewhere:local", "none"]);
    /* The laptop takes it again and a person presses before this phone's next look. This phone
       organized the mailbox, so its watch takes it back by itself: the word says so. */
    await laptop();
    await expect(live.claimHere({ by: "press" })).resolves.toBe("held_returns");
    const after = live.runtimes().organizer[id]!;
    expect(after.holderState, "the card read free over the refused press").toBe("held");
    expect(after.heldBy, "the refused press named nobody over a look that had lost the name").toBe("a laptop");
  });

  it("…and once a newer look has ended it, a look that returns to its word does not revive it", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    await live.resume();
    expect(live.runtimes().organizer[id]!.holderState, "premise: a fresh reader's look reads nobody").toBe("none");
    await meta.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: "laptop-takes-it", authorizedAt: new Date(), capabilities: [],
    }));
    /* A person presses before this phone's next look: refused, the consent kept, the memo written. */
    await expect(live.claimHere({ by: "press" })).resolves.toBe("held_consented");
    await live.resume();
    expect(live.runtimes().organizer[id]!.holderState).toBe("held");
    /* The laptop hands back; the look returns to `none`, the word the refusal was written over. */
    for (const c of await meta.peek()) await meta.removeClaims([c.ref]);
    await live.resume();
    const after = live.runtimes().organizer[id]!;
    expect([after.holderState, after.reason, after.heldBy], "the ended memo came back over a holder that let go")
      .toEqual(["none", null, null]);
  });

  it("…and a look that moved since the refusal is the newer fact", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    await meta.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: "laptop-holds-it", authorizedAt: new Date(), capabilities: [],
    }));
    await live.resume();
    expect(live.runtimes().organizer[id]!.holderState, "premise: the look reads the laptop").toBe("held");
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("held");
    for (const c of await meta.peek()) await meta.removeClaims([c.ref]);
    /* The laptop lets go and the engine's own look runs: newer than the refusal, so it wins. */
    await live.resume();
    const looked = live.runtimes().organizer[id]!;
    expect(looked.holderState, "the refusal outlived a newer look").toBe("none");
    expect(looked.reason).toBeNull();
  });

  /**
   * ══ ONE LINE PER STANDING CAUSE ═══════════════════════════════════════════════════════════
   *
   * The claim watch presses once a tick for as long as another install keeps the mailbox, and this
   * door logged every press: 61 `organizer_consent_refused_elsewhere` lines in one device run, 37
   * of them exactly 10.016 s apart, for one cause that had not changed. A log that repeats itself
   * once a tick is one nobody reads.
   */
  it("says a standing refusal ONCE, and says it again when the holder changes", async () => {
    const lines: string[] = [];
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, { logSink: (line: string) => { lines.push(line); } }));
    const id = soleMailbox(live);
    const refusals = (): number =>
      lines.filter((l) => l.includes('"organizer_consent_refused_elsewhere"')).length;
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop'
       where id = ?`,
      [id],
    );
    /* THE POSITIVE CONTROL — the FIRST refusal is said. A rule that silences the first line is a
       door that refuses presses and reports nothing anywhere. */
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("held");
    expect(refusals(), "the first refusal was not said at all").toBe(1);
    await live.claimHere({ by: "watch" });
    await live.claimHere({ by: "watch" });
    expect(refusals(), "a standing cause was said once per press").toBe(1);
    /* A DIFFERENT HOLDER IS A DIFFERENT CAUSE. */
    exec.direct("update mailboxes set organized_by_name = 'a phone' where id = ?", [id]);
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("held");
    expect(refusals(), "a holder this door had not named before went unsaid").toBe(2);
  });

  it("CLAIM answers `claimed` and records the consent once nothing holds it", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(new MemoryMeta()) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         disabled_reason = 'organized_elsewhere:local' where id = ?`,
      [id],
    );
    await expect(live.claimHere({ by: "press" })).resolves.toBe("claimed");
    const [row] = exec.direct(
      `select takeover_authorized_at as t, organize_consented_at as c,
         release_requested_at as r from mailboxes where id = ?`,
      [id],
    ) as { t: number | null; c: number | null; r: number | null }[];
    expect(row!.c).not.toBeNull();
    /* ══ THE AUTHORIZATION WAS WRITTEN AND THEN SPENT, AND THE PROMOTION IS THE RECEIPT ══════
     *
     * The gate runs INSIDE this call now, and spending the stamp is what it does on a promotion.
     * Asserting the stamp still standing would be asserting the gate did not run — which is what
     * this case used to rest on. The stronger reading is the one the stamp exists to license: a
     * stood-down reader cannot promote itself without a press (`reader-no-auto-resume.test.ts`,
     * "N CYCLES over an empty folder" against its own positive control), so an organizing runtime
     * over a row that carried `disabled_reason` IS the proof that the door wrote it. */
    expect(row!.t, "the authorization outlived the gate that spends it").toBeNull();
    expect(live.runtimes().organizer[id]!.organizing,
      "the gate did not promote this install, so nothing spent an authorization").toBe(true);
    /* AND A STANDING RELEASE REQUEST IS CANCELLED by the same ceremony — the LATER press is the
       one a person meant, and a request left standing is spent by the very next pass. */
    expect(row!.r).toBeNull();
  });

  /* ══ NO MACHINE PRESS MINTS CONSENT ═════════════════════════════════════════
   * A row nobody consented on got a stand-down memory from its own look, the claim watch pressed
   * when the holder left, and the press wrote the consent. The watch now asks with no consent of
   * its own: refused, nothing written, nothing appended. A person's press is the control above. */
  it("the WATCH's press over a row nobody consented on is refused and writes and appends nothing", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'stopped',
         organized_by_kind = 'local', organized_by_name = 'a laptop', organize_consented_at = null
       where id = ?`,
      [id],
    );
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("refused");
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?", [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.c, "a machine press minted a consent").toBeNull();
    expect(row!.t, "a machine press authorized a becoming").toBeNull();
    expect(meta.count, "a machine press claimed a mailbox nobody consented to").toBe(0);
    expect(live.runtimes().organizer[id]!.organizing).toBe(false);
  });

  it("answers `no_consent` to a press carrying no person's consent over a row nobody consented on", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    const res = await pressLocal(live, id);
    expect(res.status).toBe(200);
    expect(await outcomeOf(res)).toBe("no_consent");
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?", [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.c).toBeNull();
    expect(row!.t).toBeNull();
    /* CONSENT ALONE IS NO LICENCE: a consent a refused press recorded leaves the
       machine's press unanswered, on a mailbox this phone never organized — under its own word. */
    exec.direct("update mailboxes set organize_consented_at = ? where id = ?", [Date.now(), id]);
    expect(await outcomeOf(await pressLocal(live, id))).toBe("not_organized_here");
    /* THE POSITIVE CONTROL: a mailbox this phone's gate read as its own is returned by the same press. */
    exec.direct("update mailboxes set organizer_role = 'organizer' where id = ?", [id]);
    await live.resume();
    exec.direct("update mailboxes set organizer_role = 'reader', organizer_state = 'stopped' where id = ?", [id]);
    expect(await outcomeOf(await pressLocal(live, id))).toBe("authorized");
  });

  /* AFTER A RESTART THE CONSENT STANDS and this run has organized nothing: the watch takes nothing,
     and its line says so rather than that no consent is recorded. */
  it("the WATCH over a consent this run never organized is refused, and its line says why truly", async () => {
    const lines: string[] = [];
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: claimable(meta), logSink: (line: string) => { lines.push(line); },
    }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'stopped',
         organized_by_kind = 'mobile', organized_by_name = 'ohmail on a phone', organize_consented_at = ?
       where id = ?`,
      [Date.now(), id],
    );
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("refused");
    const said = lines.filter((l) => l.includes('"organizer_claim_here_refused"'));
    expect(said, "the refusal was not said").toHaveLength(1);
    expect(said[0], "a consent on the row was reported as missing").not.toContain("no consent is recorded");
    expect(said[0]).toContain("consent is recorded on this phone, but this install has not organized");
    expect(meta.count, "the watch claimed a mailbox this run never organized").toBe(0);
  });

  /* ══ A PERSON'S CONSENT IS RECORDED EVEN WHEN THE PRESS IS REFUSED ═════════════════════════
   * Connect while another install organizes answered 409 and kept nothing, so only the minting
   * watch ever carried that person's consent out. The refused press now records the consent and
   * the screening baseline — no stamp, no intent, the row stays a reader — and once the holder lets
   * go the person's next press takes the mailbox; the watch returns only one this install organized. */
  const heldByALaptop = (exec: ReturnType<typeof nodeExecutor>, id: string): void => {
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop', organize_consented_at = null
       where id = ?`,
      [id],
    );
  };

  it("a PERSON's press refused 409 records the consent and the baseline, and no stamp", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    heldByALaptop(exec, id);
    const res = await pressConnect(live, id);
    expect(res.status).toBe(409);
    const body = await res.json() as { holder?: unknown; consentRecorded?: unknown };
    expect(body.holder).toEqual({ name: "a laptop", kind: "local" });
    /* THE APP IS TOLD THE CONSENT WAS KEPT, so its refusal can say both facts (RULING-026 Q3). */
    expect(body.consentRecorded, "the refusal did not say the consent was kept").toBe(true);
    const [row] = exec.direct(
      `select takeover_authorized_at as t, organize_consented_at as c, organizer_role as role
         from mailboxes where id = ?`,
      [id],
    ) as { t: number | null; c: number | null; role: string }[];
    expect(row!.c, "the person's consent was lost because another install held the mailbox").not.toBeNull();
    expect(row!.t, "a refused press authorized a becoming").toBeNull();
    expect(row!.role, "a refused press promoted the row").toBe("reader");
    const [st] = exec.direct(
      "select screening_baseline_at as b from account_settings limit 1",
    ) as { b: number | null }[];
    expect(st?.b, "the screening baseline did not ride the consent").not.toBeNull();
  });

  /* A PERSON'S START REFUSED OVER A LIVE CLAIM keeps the consent and SAYS SO in its own word, so the
     app owes both facts; the watch beside it never does (RULING-026 Q3). */
  it("CLAIM by a person's press answers `held_consented` and records the consent, no stamp", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    heldByALaptop(exec, id);
    await expect(live.claimHere({ by: "watch" }), "the watch carries no consent").resolves.toBe("held");
    await expect(live.claimHere({ by: "press" })).resolves.toBe("held_consented");
    const [row] = exec.direct(
      "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
      [id],
    ) as { t: number | null; c: number | null }[];
    expect(row!.c, "the person's consent was not recorded").not.toBeNull();
    expect(row!.t, "a refused press authorized a becoming").toBeNull();
  });

  it("…and once that install lets go, the WATCH takes nothing: a refused press licenses no machine", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    heldByALaptop(exec, id);
    expect((await pressConnect(live, id)).status).toBe(409);
    exec.direct("update mailboxes set organizer_state = 'stopped' where id = ?", [id]);
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("refused");
    expect(meta.count, "the phone took over by itself a mailbox it never organized").toBe(0);
    /* THE PERSON'S FRESH PRESS — the offer's verb — takes it, on the consent already recorded. */
    await expect(live.claimHere({ by: "press" })).resolves.toBe("claimed");
    expect(meta.count, "the person's press did not take the freed mailbox").toBe(1);
  });

  it("CONTROL: the watch RETURNS a mailbox this phone organized, once the install that took it lets go", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    await expect(live.claimHere({ by: "press" })).resolves.toBe("claimed");
    // A LAPTOP TAKES IT by a press newer than this phone's claim; this phone's next gate stands down.
    await meta.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(),
      claimedAt: new Date(), nonce: "laptop-takes-it", authorizedAt: new Date(), capabilities: [],
    }));
    await live.resume();
    expect(live.runtimes().organizer[id]!.organizing, "premise: the phone stood down").toBe(false);
    for (const c of await meta.peek()) {
      if (c.raw.includes("X-Ohmail-Install-Id: the-laptop")) await meta.removeClaims([c.ref]);
    }
    await live.resume(); // the reader's look sees the laptop gone, as the watch's held check waits for
    await expect(live.claimHere({ by: "watch" }), "the phone did not return a mailbox it organized")
      .resolves.toBe("claimed");
  });

  /**
   * ══ THE DOOR'S CONTINUE WAKES THE GATE — no wait for the next poll (PERF-026) ══════════════
   *
   * The setup door records consent through `/local/…/organize` and nothing else; `claimHere` is a
   * different caller that forces its own pass. Measured on the host rig and on a device, the claim
   * then waited for the next 15 s poll plus the 1.5 s first-page grace. The bound here is a third
   * of that poll, so only a pass the consent itself started can meet it.
   * MUTATION WATCHED RED: drop the wake in the door and `organizing` stays false past the bound.
   */
  it("CONSENT through the local door starts a gated pass at once", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(new MemoryMeta()) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         disabled_reason = 'organized_elsewhere:local' where id = ?`,
      [id],
    );
    /* THE CONTROL: a reader before the press, so a promotion below is the press's doing. */
    expect(live.runtimes().organizer[id]!.organizing).toBe(false);
    /* The app's Connect press, which carries the person's consent: a bare press over a row nobody
       agreed on is the claim watch's shape and is answered `no_consent`. */
    const res = await pressConnect(live, id);
    expect(await outcomeOf(res)).toBe("authorized");
    const deadline = Date.now() + 5_000;
    while (!live.runtimes().organizer[id]!.organizing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(live.runtimes().organizer[id]!.organizing,
      "the consent was recorded and no pass asked the gate before the next poll").toBe(true);
  });

  /**
   * ══ AND A CYCLE THAT NEVER REACHED THE GATE SAYS SO — the consumer of the honest default ════
   *
   * The door answers `claimed` off the runtime's `organizing`, which is a DECLARATION a gated pass
   * makes; it deliberately refuses to read `OrganizerState.claimed`, the instruction, because that
   * one survives an outage. A runtime used to ATTACH with `organizing` already true, taken from
   * the row before anything asked the lease — so a press whose forced cycle never reached the gate
   * answered `claimed` anyway, and the app raised an organizer session over a mailbox with no
   * claim in `ohmail/_meta` and a row still saying reader.
   *
   * THE SUBJECT IS THIS FILE'S DEFAULT DOUBLE, deliberately: `leasePeekIo` and no `leaseIo`, so
   * the press is admitted, the consent is recorded, and the forced cycle cannot reach the gate to
   * declare anything. Nothing overwrites the attach default on that path, which is what makes this
   * the case the default decides — the lease-unavailable arm is a different one, because a gate
   * that RAN and threw withdraws the declaration itself.
   *
   * MUTATION WATCHED RED: put the attach default back to `organizing: true` and this answers
   * `claimed` over a mailbox nothing organizes.
   */
  it("CLAIM answers `unreadable` where the forced cycle never reached the gate", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         disabled_reason = 'organized_elsewhere:local' where id = ?`,
      [id],
    );
    await expect(live.claimHere({ by: "press" })).resolves.toBe("unreadable");
    expect(live.runtimes().organizer[id]!.organizing,
      "an install whose cycle never asked the lease reported itself organizing").toBe(false);
    /* AND THE CONSENT IS KEPT, which is what makes `unreadable` different from a refusal: the
       person asked, the door recorded it, and the next poll carries it out. */
    const [row] = exec.direct(
      "select organize_consented_at as c from mailboxes where id = ?", [id],
    ) as { c: number | null }[];
    expect(row!.c, "the press was recorded nowhere, so the next poll has nothing to act on")
      .not.toBeNull();
  });

  it("CLAIM is taken SIX MINUTES into the launch — the defect this lane closes", async () => {
    /* ══ THE MEASUREMENT, AS THE DEVICE MADE IT ═══════════════════════════════════════════
     *
     * `Start organizing here` at +44 s and +2 m 35 s: 202. At +6 m 06 s and +14 m 30 s: 403
     * `step_up_required`, no claim, *"This phone could not start organizing that mailbox."* —
     * because the shared consent route is `stepUp: true` and a standalone launch session stamps
     * its second factor once at boot. Six minutes in, the way back was gone for the life of the
     * process; only a force-stop restored it.
     *
     * The row is a stood-down reader with nothing renewing a claim — the state a person presses
     * Start from. The only thing this case changes from the one above it is the clock. */
    const exec = nodeExecutor();
    const c = clock();
    live = await startPhoneEngine(deps(exec, {
      now: c.now, adapterFactory: claimable(new MemoryMeta()),
    }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         disabled_reason = 'organized_elsewhere:local' where id = ?`,
      [id],
    );
    c.advance(PAST_THE_WINDOW_MS);
    await expect(live.claimHere({ by: "press" })).resolves.toBe("claimed");
    const [row] = exec.direct(
      `select takeover_authorized_at as t, organize_consented_at as cc from mailboxes where id = ?`,
      [id],
    ) as { t: number | null; cc: number | null }[];
    expect(row!.cc, "the consent was not recorded").not.toBeNull();
    /* SPENT BY THE GATE THIS CALL RAN — the sibling case above states the reading in full. */
    expect(row!.t, "the authorization outlived the gate that spends it").toBeNull();
    expect(live.runtimes().organizer[id]!.organizing,
      "the press past the window recorded a consent nothing acted on").toBe(true);
  });

  it("STOP then CLAIM, both past the window — the claim watch's own sequence", async () => {
    /* The device measured this pair split across the window: the stop, inside it, worked (the
       release route is not step-up) and the start, past it, was 403 — so the phone could give
       its mailbox up and never take it back. The same shape is the claim WATCH's: a holder
       releases, the watch presses, and at the base every press after the fifth minute was refused
       while `ohmail/_meta` stayed empty for 4 min 24 s. */
    const exec = nodeExecutor();
    const c = clock();
    live = await startPhoneEngine(deps(exec, { now: c.now }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'organizer', organize_consented_at = 1,
         status = 'connected' where id = ?`,
      [id],
    );
    c.advance(PAST_THE_WINDOW_MS);
    await expect(live.stopOrganizing()).resolves.toBe("released");
    /* THE ROW IS WHAT THIS CASE IS ABOUT, and the door's word is now a narrower statement than the
       one it used to make: `claimed` means the forced cycle TOOK the claim, and this composition's
       adapter can do nothing past its sign-in (`deps`), so no cycle here can take one. The press is admitted
       all the same — which is the step-up question this case asks — and the two stamps below are
       where that is read. A `claimed` here would mean the door had gone back to reporting a start
       it never made. */
    await expect(live.claimHere({ by: "watch" }), "the phone could not take its own mailbox back").resolves
      .toBe("unreadable");
    const [row] = exec.direct(
      "select takeover_authorized_at as t, release_requested_at as r from mailboxes where id = ?",
      [id],
    ) as { t: number | null; r: number | null }[];
    expect(row!.t, "the authorization the gate spends was not written").not.toBeNull();
    expect(row!.r, "the stop the person changed their mind about still stands").toBeNull();
  });

  it("CLAIM still answers `held` past the window — the refusal is not the step-up's", async () => {
    /* The positive control's opposite face, and it is what keeps the move honest: taking the
       second factor off this tier must not have taken the one-organizer rule off with it. */
    const exec = nodeExecutor();
    const c = clock();
    live = await startPhoneEngine(deps(exec, { now: c.now }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_install_id = 'the-laptop'
       where id = ?`,
      [id],
    );
    c.advance(PAST_THE_WINDOW_MS);
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("held");
    const [row] = exec.direct(
      "select takeover_authorized_at as t from mailboxes where id = ?",
      [id],
    ) as { t: number | null }[];
    expect(row!.t).toBeNull();
  });

  it("CLAIM cancels a release this install had just asked for", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'organizer', organize_consented_at = 1,
         status = 'connected' where id = ?`,
      [id],
    );
    await expect(live.stopOrganizing()).resolves.toBe("released");
    /* The cancel is the ROW's, and it happens on the way in — before the cycle the word now
       reports on. See the case above: this composition dials nothing, so `unreadable` is the
       honest word and the two stamps are the cancel. */
    await expect(live.claimHere({ by: "press" })).resolves.toBe("unreadable");
    const [row] = exec.direct(
      "select release_requested_at as r, takeover_authorized_at as t from mailboxes where id = ?",
      [id],
    ) as { r: number | null; t: number | null }[];
    expect(row!.r, "the stop the person changed their mind about still stands").toBeNull();
    expect(row!.t).not.toBeNull();
  });
});

/**
 * ══ THE VERB THIS DOOR WRITES, AND THE ONE IT REFUSES ═══════════════════════════════════════
 *
 * The 409 above is the fast path, off a row up to one poll old. What makes "this phone has no
 * takeover verb" true at the FENCE is the `join` intent the door writes onto every consent request
 * it forwards: `decideLease` rule 6 refuses a `join` against a live foreign claim however recent
 * the press. These rows are about the DOOR — that the intent reaches the row, on BOTH consent
 * spellings this handle serves, whatever the caller sent.
 */
describe.runIf(ON_DEVICE_STORE)("the phone's door writes the verb", () => {
  /** A row a press is allowed to write on: a consent-less reader nobody is holding. */
  const claimable = (exec: ReturnType<typeof nodeExecutor>, id: string): void => {
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = null,
         organize_consented_at = null, disabled_reason = 'organized_elsewhere:local' where id = ?`,
      [id],
    );
  };
  const intentOf = (exec: ReturnType<typeof nodeExecutor>, id: string): string =>
    (exec.direct("select takeover_intent as i from mailboxes where id = ?", [id]) as { i: string }[])[0]!.i;

  it("stamps NOTHING on the shared consent path — the route is absent, so no verb is written", async () => {
    /* STALE BY DESIGN, and kept as the other half of the verb's contract. This case read the
       `join` the door stamped on the shared spelling; since `mobile.ts#LOCAL_ORGANIZE_PATH` that
       spelling is a 404, so what a caller aimed at it now gets is no verb at all. The `join` half
       is stated on the door this build serves, one case below. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    claimable(exec, id);
    const before = intentOf(exec, id);
    expect((await press(live, id)).status, "the step-up'd spelling is served on this door").toBe(404);
    expect(intentOf(exec, id), "the absent route stamped a verb on the row").toBe(before);
  });

  it("stamps `join` on the LOCAL consent path — the one door this build serves", async () => {
    /* The door's own verb, never the caller's: a check the app supplies is one the next caller
       can be added past. This is the only spelling that reaches the stamp writer at all now. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    claimable(exec, id);
    const res = await live.handle(new Request(
      `http://engine.invalid/local/mailboxes/${encodeURIComponent(id)}/organize`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${live.sessionToken}`,
          "content-type": "application/json",
        },
        body: PERSON,
      },
    ));
    expect(res.status, "the local consent path is not served on this handle at all").toBe(200);
    expect(intentOf(exec, id), "the second consent path wrote the displacing verb").toBe("join");
  });

  it("OVERRIDES a caller that asked for a takeover", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    claimable(exec, id);
    /* ON THE LOCAL SPELLING, which is where a caller can still be heard: the shared one is a 404
       before any body is read, so a takeover asked for there proves nothing about the override. */
    const res = await live.handle(new Request(
      `http://engine.invalid/local/mailboxes/${encodeURIComponent(id)}/organize`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${live.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ consent: "person", intent: "takeover" }),
      },
    ));
    expect(res.status, "the local consent path is not served on this handle").toBe(200);
    expect(intentOf(exec, id), "a caller talked this door into the verb it does not have").toBe("join");
  });

  it("REFUSES the takeover route outright, and writes nothing", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    claimable(exec, id);
    const res = await live.handle(new Request("http://engine.invalid/local/organizer/takeover", {
      method: "POST",
      headers: {
        authorization: `Bearer ${live.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mailboxId: id }),
    }));
    expect(res.status, "the desktop's takeover verb is served on a phone").toBe(404);
    const [row] = exec.direct(
      "select takeover_authorized_at as t from mailboxes where id = ?",
      [id],
    ) as { t: number | null }[];
    expect(row!.t, "a refused verb still stamped the row").toBeNull();
  });

  it("leaves a consent body's OTHER keys alone — the window still rides the same write", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    claimable(exec, id);
    /* ON THE LOCAL SPELLING, for the reason the case above gives. */
    const res = await live.handle(new Request(
      `http://engine.invalid/local/mailboxes/${encodeURIComponent(id)}/organize`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${live.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ consent: "person", screening: { dormancyDays: 90, scope: "window" } }),
      },
    ));
    expect(res.status, "the local consent path is not served on this handle").toBe(200);
    expect(intentOf(exec, id)).toBe("join");
    const [st] = exec.direct(
      "select dormancy_days as d, screening_scope as s from account_settings limit 1",
    ) as { d: number | null; s: string | null }[];
    expect(st?.d, "the rewritten body lost the answer the person gave").toBe(90);
    expect(st?.s).toBe("window");
  });
});

/**
 * ══ AND EVERY REFUSAL THIS DOOR ANSWERS NAMES ITSELF ══════════════════════════════════════════
 *
 * `GET /mailboxes` over the app's own loopback door answers a row under Node and was refused on a
 * device, measured twice, with nothing anywhere to read: the app's roster read folds a non-200 and
 * a throw into one `null` ("could not ask"), so the status that decided it existed nowhere. The
 * line is written where the answer is decided — and through the engine's own hardened logger,
 * because an app composing it would be a second logger outside the field allowlist.
 */
describe.runIf(ON_DEVICE_STORE)("the phone's door says what it refused", () => {
  const booted = async (
    exec: PhoneSqlExecutor,
  ): Promise<{ engine: PhoneEngine; lines: Record<string, unknown>[] }> => {
    const lines: Record<string, unknown>[] = [];
    const engine = await startPhoneEngine(deps(exec, {
      logSink: (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>); },
    }));
    return { engine, lines };
  };

  const refusals = (lines: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
    lines.filter((l) => l.event === "phone_door_refused");

  it("a roster read the door turned down is one line with the route and the status", async () => {
    const exec = nodeExecutor();
    const b = await booted(exec);
    live = b.engine;
    /* NO BEARER — the shape a device produced and Node did not, and the one the app's own read
       cannot tell from a network fault. Composed here rather than through `localEngineTransport`,
       which always stamps the token: the point is the door's ANSWER, not the app's transport. */
    const res = await b.engine.handle(new Request("http://sidecar/mailboxes?counts=1", { method: "GET" }));
    expect(res.status, "the door admitted an unauthenticated roster read").toBeGreaterThanOrEqual(400);

    const said = refusals(b.lines);
    expect(said.length, "the refusal was answered and never written down").toBe(1);
    expect(said[0]!.route).toBe("/mailboxes");
    expect(said[0]!.method).toBe("GET");
    expect(said[0]!.status).toBe(res.status);
    /* THE QUERY IS NOT IN THE LINE. `describeRoute` drops it before its grammar runs, which is
       what keeps a person's own words off a log line on every route that takes one. */
    expect(JSON.stringify(said[0]), "the query string reached the line").not.toContain("counts");
    expect(said[0]!.droppedFields, "the refusal lost fields to the census").toBeUndefined();
  });

  it("POSITIVE CONTROL: a roster read the door ANSWERS writes no refusal at all", async () => {
    /* Without this the case above is satisfied by a door that logs every request, which would put
       a line on the ordinary read a phone makes on its own cadence for as long as it is open. */
    const exec = nodeExecutor();
    const b = await booted(exec);
    live = b.engine;
    const res = await b.engine.handle(new Request("http://sidecar/mailboxes", {
      method: "GET",
      headers: { authorization: `Bearer ${b.engine.sessionToken}` },
    }));
    expect(res.status, "the door refused its own bearer").toBe(200);
    expect(refusals(b.lines)).toEqual([]);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PEEK'S THIRD ANSWER — "I COULD NOT LOOK" IS NOT "NOBODY HOLDS IT"
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The cases above decide off `organizer_state`, which is `held`, `stopped`, or NULL — and NULL is
 * TWO facts in one value, as `schema-mail.ts` says in its own comment: "nobody has ever organized
 * this mailbox" and "we have not looked". This door read that NULL as the first.
 *
 * MEASURED on this composition, before the change, with the row left exactly as a launch leaves it
 * (`organizer_state` NULL, reader, pre-consent) and the engine's adapter unable to read the claim
 * folder — three arms, one answer:
 *
 *   · no `leasePeekIo` on the adapter  → press 202, consent + authorization written, `claimHere`
 *     answered `claimed`, `unreadableSince` null, and NOT ONE LOG LINE said a look had failed;
 *   · `leasePeekIo` whose `listClaims` threw → press 202, consent + authorization written, while
 *     `organizer_peek_failed` had already been logged on the same launch — the engine KNEW and the
 *     door did not ask;
 *   · a folder holding a live foreign claim → 409, correctly, which is what made the other two
 *     look like a working door.
 *
 * So the door asks the ENGINE when the row cannot say, and the engine answers in three words. The
 * `held` and `free` arms below are the same two the rest of this file drives; these two are the
 * third, and the last case is the positive control that a genuinely empty folder still admits a
 * press — without it every case here is satisfied by a door that refuses everything.
 */
/** The row a launch leaves before anybody consents: reader, and nothing has looked. */
const unlookedAt = (exec: ReturnType<typeof nodeExecutor>, id: string): void => {
  seedCredential(exec, id);
  exec.direct(
    `update mailboxes set organizer_role = 'reader', organizer_state = null,
       organized_by_name = null, organized_by_kind = null, organized_by_install_id = null,
       organize_consented_at = null where id = ?`,
    [id],
  );
};
const stamps = (exec: ReturnType<typeof nodeExecutor>, id: string): { t: number | null; c: number | null } =>
  (exec.direct(
    "select takeover_authorized_at as t, organize_consented_at as c from mailboxes where id = ?",
    [id],
  ) as { t: number | null; c: number | null }[])[0]!;

describe.runIf(ON_DEVICE_STORE)("the peek's third answer, at the consent door", () => {
  /* EVERY CASE BELOW PRESSES THE LOCAL SPELLING, which is the door a press actually uses. The
     refusals here outrank route absence, so they read the same on either spelling — and that is
     the hazard: written on the shared one they would pass over a door that serves nothing, and
     only the positive control would ever notice. One door, one contract. */
  it("REFUSES 503 where the adapter has no read-only accessor at all", async () => {
    /* The arm that was silent: `notePeekedHolder` probed `leasePeekIo`, found nothing, and
       returned — no write, no line, no mark. An adapter that cannot look is not evidence that
       nobody is there. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressLocal(live, id);
    expect(res.status, "the door admitted a press it could not check").toBe(503);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("organizer_unreadable");
    const row = stamps(exec, id);
    expect(row.t, "an authorization was written over a claim folder nothing could read").toBeNull();
    expect(row.c, "a consent was recorded over a claim folder nothing could read").toBeNull();
  });

  it("REFUSES 503 where asking for the read-only accessor itself throws", async () => {
    /* `ImapAdapter.leasePeekIo()` asserts the adapter is usable before handing the io out, so a
       RETIRED one throws at the accessor rather than at the read — an ordinary runtime state, a
       mailbox detached while a press was in flight. Inside the poll that throw is caught by the
       pass around it; this door awaits the look directly, so without the guard it would REJECT,
       and a rejection is not the refusal whose sentence tells a person to press again. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => { throw new Error("this adapter has been retired"); },
      }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressLocal(live, id);
    expect(res.status, "an accessor that refused became a rejection, not a refusal").toBe(503);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("organizer_unreadable");
    expect(stamps(exec, id).c).toBeNull();
  });

  it("REFUSES 503 where the claim folder could not be read", async () => {
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => ({
          listClaims: async (): Promise<RawClaimMessage[]> => {
            throw new LeaseUnavailableError("ohmail/_meta could not be read", { op: "list_claims" });
          },
        }),
      }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressLocal(live, id);
    expect(res.status).toBe(503);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("organizer_unreadable");
    const row = stamps(exec, id);
    expect(row.t).toBeNull();
    expect(row.c).toBeNull();
  });

  it("answers `unreadable` on the ENGINE's own verb, not `claimed` and not `refused`", async () => {
    /* The app's sentence hangs off this word. `refused` renders "this phone could not start
       organizing that mailbox", which sends somebody looking for a fault on the phone; the answer
       here is "press again". `claimed` is what it used to say. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    await expect(live.claimHere({ by: "watch" })).resolves.toBe("unreadable");
    expect(stamps(exec, id).c, "a consent was recorded by a verb that could not look").toBeNull();
  });

  it("REFUSES 409 and NAMES the holder the row had not caught up with", async () => {
    /* The row says nothing and the FOLDER says everything — a phone relaunching beside a laptop
       that claimed the mailbox while this install was not running. The holder rides the refusal,
       read off the claim rather than off a column nothing has written yet. */
    const exec = nodeExecutor();
    const raw = formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop",
      heartbeat: new Date(), claimedAt: new Date(Date.now() - 60_000),
      nonce: "nonce-foreign", authorizedAt: null, capabilities: [],
    });
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => ({ listClaims: async (): Promise<RawClaimMessage[]> => [{ ref: 1, raw }] }),
      }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressLocal(live, id);
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string }; holder?: { name?: string; kind?: string } };
    expect(body.error?.code).toBe("organized_elsewhere");
    expect(body.holder).toEqual({ name: "a laptop", kind: "local" });
    expect(stamps(exec, id).c).toBeNull();
  });

  it("does NOT read ITS OWN claim as foreign on the LOOKED path either — the row twin is not enough", async () => {
    /* THE EXEMPTION THE ROW READ HAS AND THIS PATH HAD NOT. `liveForeignHolder` lets a claim
       carrying our own install id through off `organized_by_install_id`; the peek refused on
       `held` whoever wrote it. So a phone whose row lost its holder columns — a restore, a fresh
       row, a stand-down that cleared them — while its OWN claim is still renewed in `ohmail/_meta`
       was refused its own mailbox, 409, naming the phone in the person's hand as the holder.
       `LeaseHolder.installId` is on the preview for exactly this question. */
    const exec = nodeExecutor();
    const raw = formatClaim({
      installId: OUR_INSTALL, kind: "mobile", displayName: "ohmail on a phone",
      heartbeat: new Date(), claimedAt: new Date(Date.now() - 60_000),
      nonce: "nonce-ours", authorizedAt: null, capabilities: [],
    });
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => ({ listClaims: async (): Promise<RawClaimMessage[]> => [{ ref: 1, raw }] }),
      }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressConnect(live, id);
    expect(res.status, "the door refused this install its own live claim").toBe(200);
    expect(await outcomeOf(res), "own-role resumption did not admit the press").toBe("authorized");
    expect(stamps(exec, id).c, "the admitted press recorded no consent").not.toBeNull();
  });

  it("REFUSES 409 with the incumbent BURIED under six hundred later records", async () => {
    /* The fixture the row names. The live claim is the OLDEST record in the folder and hundreds of
       stale ones sit after it, which is what a long-lived `ohmail/_meta` looks like. A read that
       took the first N by uid would drop the live one and report `stopped` — "nobody organizes
       this mailbox" about a mailbox somebody is actively organizing — so the answer must be `held`
       or a refusal, and never `free`. */
    const exec = nodeExecutor();
    const live1 = formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop",
      heartbeat: new Date(), claimedAt: new Date(Date.now() - 60_000),
      nonce: "nonce-foreign", authorizedAt: null, capabilities: [],
    });
    const records: RawClaimMessage[] = [{ ref: 1, raw: live1 }];
    for (let i = 0; i < 600; i++) {
      records.push({
        ref: i + 2,
        raw: formatClaim({
          installId: `gone-${i}`, kind: "local", displayName: "a machine that stopped",
          heartbeat: new Date(Date.now() - 20 * 60_000 - i * 1000),
          claimedAt: new Date(Date.now() - 40 * 60_000),
          nonce: `nonce-${i}`, authorizedAt: null, capabilities: [],
        }),
      });
    }
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => ({ listClaims: async (): Promise<RawClaimMessage[]> => records }),
      }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressLocal(live, id);
    expect(res.status, "a buried incumbent read as a free mailbox").toBe(409);
    expect((await res.json() as { holder?: { name?: string } }).holder?.name).toBe("a laptop");
    expect(stamps(exec, id).c).toBeNull();
  });

  it("ADMITS the press where the folder was READ and is empty — the positive control", async () => {
    /* Without this every case above is satisfied by a door that refuses every press it cannot
       answer off the row, which would break the ordinary first run: a phone connecting a mailbox
       nobody has ever organized reaches this door with `organizer_state` NULL too. The difference
       is that the look LANDED. */
    const exec = nodeExecutor();
    live = await startPhoneEngine(deps(exec));
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    const res = await pressConnect(live, id);
    expect(res.status, "a mailbox whose folder was read and is empty was refused").toBe(200);
    expect(await outcomeOf(res), "the admitted press did not name its outcome").toBe("authorized");
    const row = stamps(exec, id);
    expect(row.t, "the authorization the gate spends was not written").not.toBeNull();
    expect(row.c, "the consent was not recorded").not.toBeNull();
  });

  it("costs NO look where the row already says held — the fast path is still the fast path", async () => {
    /* The refusal off the row is one indexed read and no round trip, and that is deliberate: a
       phone beside a laptop that holds the mailbox meets this door on every relaunch. A peek here
       would be a dial per press for an answer the last poll already has. */
    const exec = nodeExecutor();
    let looks = 0;
    live = await startPhoneEngine(deps(exec, {
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => ({
          listClaims: async (): Promise<RawClaimMessage[]> => { looks += 1; return []; },
        }),
      }) as unknown as MailboxAdapter,
    }));
    const id = soleMailbox(live);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop' where id = ?`,
      [id],
    );
    const before = looks;
    expect((await pressLocal(live, id)).status).toBe(409);
    expect(looks - before, "the door dialled for an answer the row already had").toBe(0);
  });

  /* PHONE-START-HERE-META-FOLDER-FULL: a folder the look cannot read FOR A NAMED REASON answers under
     that reason, so the app says the desktop row's sentence instead of "could not check". */
  it.each(["meta_folder_full", "meta_undeletable"] as const)(
    "names a look refused %s under its own code, and records nothing", async (op) => {
      const exec = nodeExecutor();
      live = await startPhoneEngine(deps(exec, {
        adapterFactory: () => ({
          close: async () => undefined,
          leasePeekIo: () => ({
            listClaims: async (): Promise<RawClaimMessage[]> => { throw new LeaseUnavailableError("refused", { op }); },
          }),
        }) as unknown as MailboxAdapter,
      }));
      const id = soleMailbox(live);
      unlookedAt(exec, id);
      const res = await pressLocal(live, id);
      expect(res.status).toBe(503);
      expect((await res.json() as { error?: { code?: string } }).error?.code, "a named refusal read as could-not-check").toBe(op);
      expect(stamps(exec, id).c).toBeNull();
      await expect(live.claimHere({ by: "watch" })).resolves.toBe(op);
    },
  );

  it("refuses a press under the reason this engine's own gate was refused, where the look would admit it", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMeta();
    live = await startPhoneEngine(deps(exec, { adapterFactory: claimable(meta) }));
    const id = soleMailbox(live);
    seedCredential(exec, id);
    exec.direct(
      `update mailboxes set organizer_role = 'organizer', organizer_state = null,
         organize_consented_at = ? where id = ?`,
      [Date.now(), id],
    );
    meta.refusedAs = "meta_folder_full";
    await live.resume().catch(() => undefined);
    for (let i = 0; i < 160 && live.runtimes().organizer[id]?.unreadableReason !== "meta_folder_full"; i++) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    expect(live.runtimes().organizer[id]?.unreadableReason, "the gate's refusal never reached the runtime").toBe("meta_folder_full");
    const res = await pressLocal(live, id);
    expect(res.status, "a press over a gate refused by name was admitted, and would organize nothing").toBe(503);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("meta_folder_full");
    await expect(live.claimHere({ by: "press" })).resolves.toBe("meta_folder_full");
  }, 20_000);
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LOOK THE PRESS PAYS FOR RUNS UNDER A CLOCK
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The block above establishes that a look which FAILED is a 503. This one is about the look that
 * is merely SLOW, which used to be no answer at all: MEASURED on this composition against a
 * `listClaims` that never resolves, the press was still outstanding at 1 s, 10 s, 60 s and 120 s
 * of virtual clock. Nothing beneath the door bounded a whole look — the fetch out of
 * `ohmail/_meta` is raced against `IMAP_META_DEADLINE_MS`, and the folder resolution, the mailbox
 * lock and the STATUS probe ahead of it carry no clock — so a person met `Starting` with no line
 * anywhere, which is device run 4's defect reappearing through a different await.
 *
 * The ceiling is read from the product (`IMAP_META_DEADLINE_MS`) rather than spelled here, for
 * `STEP_UP_WINDOW_MS`'s reason at the top of this file: a literal keeps passing when the number
 * moves and stops measuring the thing it names.
 */
describe.runIf(ON_DEVICE_STORE)("the look the press pays for runs under a clock", () => {
  /** The `organizer_consent_look` line this press wrote, or `null` where it wrote none. */
  const looks = (lines: readonly string[]): { outcome?: unknown; latencyMs?: unknown }[] =>
    lines
      .map((l) => JSON.parse(l) as { event?: string; outcome?: unknown; latencyMs?: unknown })
      .filter((l) => l.event === "organizer_consent_look");

  /** A launch whose adapter's claim folder behaves however the case needs, lines collected. */
  const phone = async (
    exec: ReturnType<typeof nodeExecutor>,
    listClaims: () => Promise<RawClaimMessage[]>,
  ): Promise<{ id: string; lines: string[] }> => {
    const lines: string[] = [];
    /* THE LAUNCH'S OWN LOOK DOES NOT LAND, as on the dial that never signed in which this block was
       written against: Connect now signs in first, and a launch reaching this look
       would wait out its bound before the case began. The press's look is the one measured. */
    let launched = false;
    live = await startPhoneEngine(deps(exec, {
      logSink: (line: string) => { lines.push(line); },
      adapterFactory: () => ({
        close: async () => undefined,
        leasePeekIo: () => ({
          listClaims: () => (launched ? listClaims()
            : Promise.reject(new LeaseUnavailableError("ohmail/_meta could not be read", { op: "list_claims" }))),
        }),
      }) as unknown as MailboxAdapter,
    }));
    launched = true;
    const id = soleMailbox(live);
    unlookedAt(exec, id);
    return { id, lines };
  };

  it("REFUSES 503 where the look does not answer within the bound, and the line says `timeout`", async () => {
    const exec = nodeExecutor();
    const { id, lines } = await phone(
      exec,
      () => new Promise<RawClaimMessage[]>(() => undefined),
    );
    vi.useFakeTimers();
    let settled = false;
    const press = pressLocal(live!, id).then((r) => { settled = true; return r; });
    /* JUST SHORT OF THE CEILING FIRST, so the bound is what ends this press and not the advance:
       a case that only ever looked past the deadline would pass over a door that refuses every
       look instantly. */
    await vi.advanceTimersByTimeAsync(IMAP_META_DEADLINE_MS - 1_000);
    expect(settled, "the press answered BEFORE the ceiling — the bound is not the mechanism here")
      .toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    const res = await press;
    expect(res.status, "a look that never landed left the press waiting").toBe(503);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("organizer_unreadable");
    const row = stamps(exec, id);
    expect(row.t, "an authorization was written over a look that never answered").toBeNull();
    expect(row.c, "a consent was recorded over a look that never answered").toBeNull();
    const said = looks(lines);
    expect(said, "the look this press paid for was not written down").toHaveLength(1);
    expect(said[0]!.outcome).toBe("timeout");
    expect(said[0]!.latencyMs, "the line carries no duration — an unregistered field is dropped")
      .toBeGreaterThanOrEqual(IMAP_META_DEADLINE_MS);
  });

  it("ADMITS the press where the look lands just UNDER the bound, and the line says `landed`", async () => {
    /* The positive control for the case above: without it, a door that refused every look would
       satisfy the ceiling and the `timeout` word alike. */
    const exec = nodeExecutor();
    const { id, lines } = await phone(
      exec,
      () => new Promise<RawClaimMessage[]>((resolve) => {
        setTimeout(() => { resolve([]); }, IMAP_META_DEADLINE_MS - 1_000);
      }),
    );
    vi.useFakeTimers();
    let settled = false;
    /* A PERSON'S PRESS, as Connect sends it: the row is a consent-less reader, which the watch's
       empty body could not be admitted over. */
    const press = pressConnect(live!, id).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(IMAP_META_DEADLINE_MS - 1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    expect(settled, "a look that landed inside the ceiling did not answer the press").toBe(true);
    const res = await press;
    expect(res.status, "a look that landed was refused").toBe(200);
    expect(await outcomeOf(res), "the admitted press did not name its outcome").toBe("authorized");
    expect(stamps(exec, id).c, "the admitted press recorded no consent").not.toBeNull();
    const said = looks(lines);
    expect(said, "the look this press paid for was not written down").toHaveLength(1);
    expect(said[0]!.outcome).toBe("landed");
  });

  it("REFUSES 503 where the look THROWS something the peek does not classify, and says `failed`", async () => {
    /* NOT A 500. `answerLeasePeek` rethrows anything that is not a `LeaseUnavailableError`, and
       this door awaited that directly — so a fault inside `listClaims` that the lease layer has no
       reading of became a rejection out of the route rather than the refusal whose sentence tells
       a person to press again. A look that did not land is a look that did not land. */
    const exec = nodeExecutor();
    const { id, lines } = await phone(exec, () => Promise.reject(new Error("the folder read blew up")));
    const res = await pressLocal(live!, id);
    expect(res.status, "an unclassified fault in the look became a rejection, not a refusal").toBe(503);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("organizer_unreadable");
    expect(stamps(exec, id).c, "a consent was recorded over a look that threw").toBeNull();
    const said = looks(lines);
    expect(said, "the look this press paid for was not written down").toHaveLength(1);
    expect(said[0]!.outcome).toBe("failed");
  });

  it("writes NO look line where the row already says held — the fast path pays for nothing", async () => {
    /* The other half of "one line per look this press paid for": a line on the fast path would
       report a dial that never happened, once per relaunch of a stood-down phone. */
    const exec = nodeExecutor();
    const { id, lines } = await phone(exec, async () => []);
    exec.direct(
      `update mailboxes set organizer_role = 'reader', organizer_state = 'held',
         organized_by_name = 'a laptop', organized_by_kind = 'local',
         organized_by_install_id = 'the-laptop' where id = ?`,
      [id],
    );
    expect((await pressLocal(live!, id)).status).toBe(409);
    expect(looks(lines), "the fast path reported a look it never paid for").toHaveLength(0);
  });
});
