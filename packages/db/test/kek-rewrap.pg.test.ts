import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "../src/schema.js";
import { accounts, users, mailboxes, mailboxCredentials, scheduledSendFiles } from "../src/schema-mail.js";
import {
  totpSecrets, staffUsers, mailboxOauthCeremonies, oauthProviderConfig,
} from "../src/schema-cloud.js";
import {
  runKekRewrap, kekRewrapCensus, kekRetiredReferences, WRAPPED_SECRET_SITES, type RewrapKeyProvider,
} from "../src/kek-rewrap.js";
import type { Tx } from "../src/change-log.js";
import { realPgAvailable } from "../src/testing.js";
import { prepareIsolatedDb } from "../../../apps/worker/test/_isolateddb.js";

/**
 * CRYPTO-4 — THE THREE THINGS PGlite CANNOT SEE ABOUT A RE-WRAP PASS.
 *
 * `kek-rewrap.test.ts` covers the registry, the census arithmetic and every fail-closed branch on
 * PGlite. None of that is the risk. A pass that rewrites every stored secret in the product is
 * the highest-stakes data operation in this repository, and the three properties that decide
 * whether it is safe are all properties of REAL transactions over SEPARATE CONNECTIONS:
 *
 *   1. **Resume after a kill.** A pass that dies half way must leave every row wholly at its old
 *      version or wholly at its new one — never a written-but-unverified envelope — and a rerun
 *      must finish the remainder without re-encrypting what is already done.
 *   2. **The write is atomic with its verification.** A failure between the UPDATE and the COMMIT
 *      must leave the row byte-identical. PGlite has transactions, but this is the assertion
 *      whose whole value is that it was watched fail against the real engine.
 *   3. **THE LOST UPDATE.** The obvious implementation re-wraps from the candidate SELECT's
 *      snapshot; the correct one discards it and re-reads under `FOR UPDATE`. Both pass on
 *      PGlite, because one in-process connection has nothing to interleave. The difference is a
 *      user's new IMAP password being silently reverted to the previous one.
 *
 * ── A DEDICATED DATABASE, AND WHY `prepareIsolatedDb` PROVISIONS IT ───────────────────────
 *
 * A re-wrap pass is POPULATION-WIDE by definition, so "the pass re-wrapped exactly the rows that
 * were outstanding" is not a statement one can make in the shared accumulator's thousands of mailbox
 * rows. The create-if-absent form this file used to carry — a hardcoded
 * `trafficflow_kek_rewrap_test`, created once and reused for ever — went one schema behind the
 * tree the first time a migration was amended after it had run there (mail 0096's
 * `away_responders.piles`), and every run after that died in `beforeAll` with
 * `column "piles" does not exist`. `prepareIsolatedDb` keys the name by CHECKOUT, asks
 * `journalDrift` whether the schema is this tree's, and RECREATES when it is not: a database it
 * made for one file is nobody else's to keep. It is imported rather than copied, because two
 * provisioners are two policies one edit apart.
 */
const PG_UP = await realPgAvailable();
/** The LOGICAL name; `prepareIsolatedDb` appends this checkout's key to it. */
const DB_NAME = "trafficflow_kek_rewrap";

/** The private database's URL, as `prepareIsolatedDb` handed it back — never reconstructed. */
let url = "";
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** A SECOND connection — the live system, writing while the pass runs. `max: 1`, see below. */
let liveClient: ReturnType<typeof postgres>;
let live: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  if (!PG_UP) return;
  // CREATE (or recreate on drift) + migrate + empty, then hand back the URL. The 180 s budget is
  // the from-empty case: a first run, or the run after a recreate, replays both journals.
  url = await prepareIsolatedDb(DB_NAME);
  /**
   * ONE CLIENT PER ACTOR, each `max: 1`. Not belt-and-braces: postgres-js PIPELINES concurrent
   * queries issued through one pooled client, so two "concurrent" writers on a shared pool
   * execute in order on a single backend and never contend. `oauth-ceremony.pg.test.ts` records
   * measuring exactly that — a concurrency test that stayed green against the implementation it
   * existed to refuse — and the lost-update case below has the same shape.
   */
  client = postgres(url, { max: 1, onnotice: () => {} });
  db = brandDialect(drizzle(client, { schema }), "pg");
  liveClient = postgres(url, { max: 1, onnotice: () => {} });
  live = brandDialect(drizzle(liveClient, { schema }), "pg");
}, 180_000);

afterAll(async () => {
  if (!PG_UP) return;
  await client?.end({ timeout: 5 });
  await liveClient?.end({ timeout: 5 });
});

/** Toy envelopes — the format is `crypto.ts`'s business, the ORDER of operations is this file's. */
function provider(version: number, opts: { canDecrypt?: number[] } = {}): RewrapKeyProvider {
  const openable = opts.canDecrypt ?? Array.from({ length: version }, (_, i) => i + 1);
  return {
    async encrypt(plaintext: string) {
      return {
        ciphertext: `v${version}:${Buffer.from(plaintext).toString("base64url")}`,
        keyVersion: version,
      };
    },
    async decrypt(ciphertext: string, keyVersion: number) {
      if (!openable.includes(keyVersion)) throw new Error(`no KEK for version ${keyVersion}`);
      const m = /^v(\d+):(.*)$/.exec(ciphertext);
      if (!m || Number(m[1]) !== keyVersion) {
        throw new Error("Unsupported state or unable to authenticate data");
      }
      return Buffer.from(m[2]!, "base64url").toString("utf8");
    },
    currentKeyVersion: () => version,
  };
}

const seal = (v: number, pt: string) => `v${v}:${Buffer.from(pt).toString("base64url")}`;
const open = (ct: string) => Buffer.from(/^v\d+:(.*)$/.exec(ct)![1]!, "base64url").toString("utf8");

let accountId = "";
let mailboxIds: string[] = [];

/**
 * Empty the five secret tables — and ONLY those five.
 *
 * The first draft truncated their parents too (`mailboxes`, `users`, `accounts`) with `CASCADE`,
 * and every test in this file failed with `credit_ledger is append-only (attempted TRUNCATE)`:
 * `CASCADE` reaches the money trail through foreign keys from tables that are not themselves
 * guarded, which is the hazard `apps/worker/test/_isolateddb.ts` documents at length. There is no
 * reason to go near it. Accounts, users and mailboxes hold no envelopes, so leftovers from an
 * earlier test in this file are invisible to the pass; deleting the rows that DO hold one is the
 * whole requirement.
 *
 * Ordered by dependency: `oauth_provider_config.updated_by` references `staff_users`.
 */
async function reset(): Promise<void> {
  await db.delete(mailboxCredentials);
  await db.delete(totpSecrets);
  await db.delete(mailboxOauthCeremonies);
  await db.delete(oauthProviderConfig);
  await db.delete(staffUsers);
  await db.delete(scheduledSendFiles);
}

/** N mailbox credentials at `version`, plaintext `pass-<i>`. Returns their mailbox ids in order. */
async function seedCredentials(n: number, version: number): Promise<string[]> {
  const [a] = await db.insert(accounts).values({ name: "kek" }).returning();
  accountId = a!.id;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [m] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `kek-${i}-${randomUUID()}@example.test`,
    }).returning();
    ids.push(m!.id);
    await db.insert(mailboxCredentials).values({
      mailboxId: m!.id, transport: "imap", secretEnc: seal(version, `pass-${i}`), keyVersion: version,
    });
  }
  // ORDER BY nothing is what the candidate query does, so the pass's visit order is the planner's.
  // Every assertion below is therefore about SETS and per-row state, never about which row is
  // first — a test that depended on the order would be asserting a property the pass never claimed.
  return ids;
}

/** Sorted by mailbox id, so a `toEqual` between two reads is about CONTENT and not row order. */
async function credentialRows(): Promise<Array<{ mailboxId: string; ct: string; kv: number }>> {
  const rows = await db.select({
    mailboxId: mailboxCredentials.mailboxId,
    ct: mailboxCredentials.secretEnc,
    kv: mailboxCredentials.keyVersion,
  }).from(mailboxCredentials);
  return rows.sort((a, b) => a.mailboxId.localeCompare(b.mailboxId));
}

beforeEach(async () => {
  if (!PG_UP) return;
  await reset();
  mailboxIds = [];
});

describe.skipIf(!PG_UP)("CRYPTO-4 — the registry matches the REAL catalog, not the TS schema", () => {
  /**
   * The drizzle schema is a description of the database; `information_schema` is the database.
   * They can disagree — a hand-written migration adds the column, and the TS declaration is a
   * separate edit somebody can forget. This walk asks the engine that actually holds the secrets.
   *
   * Watched fail: removing the `totp_secrets` entry from `WRAPPED_SECRET_SITES` names
   * `totp_secrets.secret_enc` in the diff.
   */
  it("every `_enc` column in the live catalog is a registered site", async () => {
    const rows = await db.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public' and column_name like '%\\_enc'
       order by table_name, column_name`);
    const found = (rows as unknown as Array<{ table_name: string; column_name: string }>)
      .map((r) => `${r.table_name}.${r.column_name}`);
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual([...WRAPPED_SECRET_SITES.map((s) => s.site)].sort());
  });

  /**
   * THE SECOND LAYER, tested as a second layer. `kek-rewrap.test.ts` records that a half-null row
   * is unrepresentable because cloud 0007 and 0009 each carry a `sealed_together` CHECK — and the
   * census's `mismatched` counter exists for the site that gets added WITHOUT one. This asserts
   * the CHECK is there for every nullable site, so the counter stays the backstop rather than
   * becoming the only guard.
   */
  it("every nullable site pins its ciphertext and version together with a CHECK", async () => {
    for (const site of WRAPPED_SECRET_SITES) {
      const [table, column] = site.site.split(".") as [string, string];
      const [nullable] = await db.execute(sql`
        select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = ${table} and column_name = ${column}`) as
        unknown as Array<{ is_nullable: string }>;
      if (nullable!.is_nullable !== "YES") continue;

      const checks = await db.execute(sql`
        select pg_get_constraintdef(c.oid) as def
          from pg_constraint c join pg_class t on t.oid = c.conrelid
         where t.relname = ${table} and c.contype = 'c'`) as
        unknown as Array<{ def: string }>;
      const paired = checks.some((c) =>
        c.def.includes(column) && c.def.includes("IS NULL") && c.def.includes("="));
      expect(paired, `${site.site} is nullable and has no sealed-together CHECK`).toBe(true);
    }
  });
});

describe.skipIf(!PG_UP)("CRYPTO-4 — a pass killed mid-flight resumes without loss or double work", () => {
  /**
   * THE RESUME TEST. Six rows, a pass killed after the third, then a rerun.
   *
   * The kill is injected at `beforeRow`, which is the honest place: it is the instant BETWEEN two
   * row transactions, which is where a SIGKILL, an OOM or a dropped connection actually lands the
   * process. What must hold afterwards is the invariant the whole design rests on — every row is
   * wholly old or wholly new, and every row still decrypts to what it always did.
   */
  it("kills after three rows, leaves six intact, and finishes the remaining three on rerun", async () => {
    mailboxIds = await seedCredentials(6, 1);
    const kp = provider(2);
    const seen: string[] = [];

    await expect(runKekRewrap({
      db: db as unknown as Tx, keyProvider: kp, apply: true,
      hooks: {
        async beforeRow(_site, row) {
          if (seen.length === 3) throw new Error("SIGKILL");
          seen.push(row);
        },
      },
    })).rejects.toThrow("SIGKILL");

    // ── The state a crashed pass left behind ──────────────────────────────────────────────
    const mid = await credentialRows();
    expect(mid).toHaveLength(6);
    const atV2 = mid.filter((r) => r.kv === 2);
    const atV1 = mid.filter((r) => r.kv === 1);
    expect(atV2).toHaveLength(3);
    expect(atV1).toHaveLength(3);
    // NOTHING is half-written: every row's envelope is readable under the version it claims, and
    // the six plaintexts are still the six that were seeded.
    for (const r of mid) {
      expect(r.ct.startsWith(`v${r.kv}:`), `${r.mailboxId} envelope/version disagree`).toBe(true);
      await expect(kp.decrypt(r.ct, r.kv)).resolves.toMatch(/^pass-[0-5]$/);
    }
    expect(new Set(mid.map((r) => open(r.ct)))).toEqual(
      new Set(["pass-0", "pass-1", "pass-2", "pass-3", "pass-4", "pass-5"]),
    );

    // ── The rerun: exactly the remainder, and no work redone ──────────────────────────────
    let encrypts = 0;
    const counting: RewrapKeyProvider = {
      ...kp,
      encrypt: async (pt) => { encrypts++; return kp.encrypt(pt); },
      decrypt: (ct, v) => kp.decrypt(ct, v),
      currentKeyVersion: () => 2,
    };
    const second = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: counting, apply: true,
    });

    expect(second.rewrapped).toBe(3);
    expect(second.failed).toBe(0);
    expect(encrypts).toBe(3);                       // the three already done were never re-sealed
    const after = await credentialRows();
    expect(after.every((r) => r.kv === 2)).toBe(true);
    expect(new Set(after.map((r) => open(r.ct)))).toEqual(
      new Set(["pass-0", "pass-1", "pass-2", "pass-3", "pass-4", "pass-5"]),
    );
    expect((await kekRewrapCensus(db as unknown as Tx, 2)).outstanding).toBe(0);
  });

  /**
   * THE ATOMICITY OF THE WRITE. A failure INSIDE the transaction, after the UPDATE has run and
   * before it commits, must leave the row exactly as it was — not at the new version, and
   * certainly not carrying a new envelope under an old version number.
   *
   * Watched fail: move the `afterUpdate` call from inside the transaction callback to a `.then()`
   * on it — so the crash lands after the COMMIT rather than before it — and this goes red with
   * `expected 'v2:cGFzcy0w' to be 'v1:cGFzcy0w'`: the row survived at the new version while the
   * pass reported a failure.
   *
   * (Writing through `deps.db` instead of `tx` is NOT the mutation to use. It self-deadlocks on a
   * `max: 1` pool — the auto-commit UPDATE waits on the row lock the enclosing transaction still
   * holds — so the file goes red by timeout, which proves nothing about the assertion.)
   */
  it("a failure between the UPDATE and the COMMIT leaves the row byte-identical", async () => {
    mailboxIds = await seedCredentials(1, 1);
    const before = (await credentialRows())[0]!;

    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: provider(2), apply: true,
      hooks: { async afterUpdate() { throw new Error("power cut"); } },
    });

    expect(r.rewrapped).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.failures[0]!.reason).toBe("database_error");
    const after = (await credentialRows())[0]!;
    expect(after.ct).toBe(before.ct);
    expect(after.kv).toBe(before.kv);
  });
});

describe.skipIf(!PG_UP)("CRYPTO-4 — the pass never reverts a secret the live system rewrote", () => {
  /**
   * ══ THE LOST UPDATE — the reason this file exists ═══════════════════════════════════════
   *
   * The candidate SELECT names six rows. Before the pass reaches one of them, the live system
   * changes that mailbox's password; `mailbox_credentials` is rewritten with a NEW secret. The
   * user's mail now works.
   *
   * An implementation that re-wraps from the candidate snapshot decrypts the OLD ciphertext it
   * read seconds ago, re-seals it under the new KEK, and writes it back. Everything looks right —
   * a well-formed envelope at the current `key_version` — and the mailbox stops connecting,
   * because its stored password is one generation stale. The same shape reverts a Microsoft
   * refresh token, which `core/src/oauth/microsoft.ts` rewrites on every rotation Azure performs.
   *
   * The pass therefore discards the snapshot and re-reads under `FOR UPDATE`, sees the row is
   * already at the target, and counts it `raced`.
   *
   * ── THE MUTATION, AND WHAT IT ACTUALLY MEASURED ─────────────────────────────────────────
   *
   * `rewrapOneRow` holds TWO guards against this, and the experiment is worth recording because
   * it contradicted the expectation it was run to confirm:
   *
   *   · use the candidate row's `ct`/`kv` instead of the locked re-read  → STILL GREEN;
   *   · drop the compare-and-swap from the UPDATE's `WHERE`, keep the re-read  → STILL GREEN;
   *   · both together  → RED: `expected 'old-password' to be 'new-password'`.
   *
   * So they are peers, not a guard and a flourish, and this test's exit code comes from reality
   * either way. Neither may be removed on the argument that the other covers it — that argument
   * is true today and is one refactor away from being the whole defect.
   *
   * `fileParallelism: false` plus two `max: 1` clients is what makes the interleaving real; see
   * the client comment in `beforeAll`.
   */
  it("a password changed mid-pass survives: the row is raced, not reverted", async () => {
    mailboxIds = await seedCredentials(6, 1);
    const victim = mailboxIds[2]!;
    await db.update(mailboxCredentials)
      .set({ secretEnc: seal(1, "old-password") })
      .where(and(eq(mailboxCredentials.mailboxId, victim), eq(mailboxCredentials.transport, "imap")));

    let rewritten = false;
    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: provider(2), apply: true,
      hooks: {
        async beforeRow() {
          // On the FIRST row visited — whichever it is — the live system changes the victim's
          // password, on its own connection, and commits. Every later visit therefore happens
          // after the change, including the victim's own.
          if (rewritten) return;
          rewritten = true;
          await live.update(mailboxCredentials)
            .set({ secretEnc: seal(2, "new-password"), keyVersion: 2 })
            .where(and(
              eq(mailboxCredentials.mailboxId, victim),
              eq(mailboxCredentials.transport, "imap"),
            ));
        },
      },
    });

    const rows = await credentialRows();
    const victimRow = rows.find((x) => x.mailboxId === victim)!;
    expect(open(victimRow.ct)).toBe("new-password");     // NOT "old-password"
    expect(victimRow.kv).toBe(2);
    expect(r.rewrapped).toBe(5);
    expect(r.raced).toBe(1);
    expect(r.failed).toBe(0);
    // And the other five are re-wrapped correctly, so the guard did not simply refuse everything.
    for (const row of rows.filter((x) => x.mailboxId !== victim)) {
      expect(row.kv).toBe(2);
      expect(open(row.ct)).toMatch(/^pass-[0-5]$/);
    }
  });

  /**
   * The other half of the same window: the row is DELETED between selection and visit — an
   * expired ceremony pruned, a mailbox disconnected. A `raced`, never a failure and never a
   * resurrection.
   */
  it("a row deleted mid-pass is counted raced and not recreated", async () => {
    mailboxIds = await seedCredentials(3, 1);
    const doomed = mailboxIds[1]!;

    let done = false;
    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: provider(2), apply: true,
      hooks: {
        async beforeRow() {
          if (done) return;
          done = true;
          await live.delete(mailboxCredentials)
            .where(eq(mailboxCredentials.mailboxId, doomed));
        },
      },
    });

    expect(r.raced).toBe(1);
    expect(r.rewrapped).toBe(2);
    expect(r.failed).toBe(0);
    const rows = await credentialRows();
    expect(rows).toHaveLength(2);
    expect(rows.some((x) => x.mailboxId === doomed)).toBe(false);
  });
});

describe.skipIf(!PG_UP)("CRYPTO-4 — the whole population, all five sites, against real Postgres", () => {
  it("moves every site to the target and leaves the census clean", async () => {
    mailboxIds = await seedCredentials(2, 1);
    const [u] = await db.insert(users).values({
      accountId, email: `kek-${randomUUID()}@example.test`,
    }).returning();
    await db.insert(totpSecrets).values({
      userId: u!.id, secretEnc: seal(1, "totp-secret"), keyVersion: 1,
    });
    await db.insert(staffUsers).values({
      email: `staff-${randomUUID()}@example.test`, passwordHash: "stored-row-password-hash",
      totpSecretEnc: seal(1, "staff-totp"), totpKeyVersion: 1,
    });
    await db.insert(mailboxOauthCeremonies).values({
      state: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      accountId, provider: "microsoft",
      codeVerifierEnc: seal(1, "pkce-verifier"), codeVerifierKeyVersion: 1,
    });
    await db.insert(oauthProviderConfig).values({
      provider: "microsoft", clientSecretEnc: seal(1, "client-secret"), clientSecretKeyVersion: 1,
    });

    const before = await kekRewrapCensus(db as unknown as Tx, 2);
    expect(before.outstanding).toBe(6);
    expect(before.versionsInUse).toEqual([1]);

    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: provider(2), apply: true });
    expect(r.rewrapped).toBe(6);
    expect(r.failed).toBe(0);

    const after = await kekRewrapCensus(db as unknown as Tx, 2);
    expect(after.outstanding).toBe(0);
    expect(after.versionsInUse).toEqual([2]);
    for (const s of after.sites) expect(s.ahead, s.site).toBe(0);

    // Every plaintext survived the round trip through the real engine's text columns.
    expect(open((await db.select().from(totpSecrets))[0]!.secretEnc)).toBe("totp-secret");
    expect(open((await db.select().from(staffUsers))[0]!.totpSecretEnc!)).toBe("staff-totp");
    expect(open((await db.select().from(mailboxOauthCeremonies))[0]!.codeVerifierEnc))
      .toBe("pkce-verifier");
    expect(open((await db.select().from(oauthProviderConfig))[0]!.clientSecretEnc!))
      .toBe("client-secret");
  });

  /**
   * THE STATE THAT MUST NOT LOOK LIKE SUCCESS. A host whose ring has already lost version one reports
   * every version-one row as `no_kek_for_version` and changes nothing — so the census still shows it in
   * use, and the procedure's "only then remove V<n>" step correctly refuses.
   */
  it("a ring that cannot open key version 1 rewrites nothing and still reports version 1 in use", async () => {
    mailboxIds = await seedCredentials(3, 1);
    const before = await credentialRows();

    const r = await runKekRewrap({
      db: db as unknown as Tx, keyProvider: provider(3, { canDecrypt: [2, 3] }), apply: true,
    });

    expect(r.rewrapped).toBe(0);
    expect(r.failed).toBe(3);
    expect(r.failures.every((f) => f.reason === "no_kek_for_version")).toBe(true);
    expect(await credentialRows()).toEqual(before);
    expect((await kekRewrapCensus(db as unknown as Tx, 3)).versionsInUse).toEqual([1]);
  });
});

describe.skipIf(!PG_UP)("CRYPTO-4 — a scheduled letter's sealed pieces (mail 0180) move with the ring", () => {
  it("re-wraps every piece key and never the bytes, leaves a plain row alone, and counts the pieces until then", async () => {
    const [a] = await db.insert(accounts).values({ name: "kek-pieces" }).returning();
    const [m] = await db.insert(mailboxes).values({
      accountId: a!.id, provider: "imap", address: `kek-pieces-${randomUUID()}@example.test`,
    }).returning();
    const draftId = randomUUID();
    const piece = (seq: number) => ({
      accountId: a!.id, mailboxId: m!.id, draftId, sendKey: "sk", fileNo: 0, seq, filename: "a.pdf",
      contentType: "application/pdf", sizeBytes: 3, contentSha256: "ab".repeat(32), rawB64: `sealed-${seq}`,
    });
    await db.insert(scheduledSendFiles).values([
      { ...piece(0), dekEnc: seal(1, "key-0"), dekKeyVersion: 1 },
      { ...piece(1), dekEnc: seal(1, "key-1"), dekKeyVersion: 1 },
      { ...piece(0), draftId: randomUUID(), rawB64: "cGxhaW4=" },
    ]);
    const before = await kekRetiredReferences(db as unknown as Tx, 1);
    expect(before.sites.find((x) => x.site === "scheduled_send_files.dek_enc")?.rows).toBe(2);

    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: provider(2), apply: true });
    expect(r.failed).toBe(0);
    expect(r.rewrapped).toBe(2);
    const rows = await db.select().from(scheduledSendFiles).where(eq(scheduledSendFiles.accountId, a!.id));
    const sealed = rows.filter((x) => x.dekEnc !== null).sort((x, y) => x.seq - y.seq);
    expect(sealed.map((x) => [x.dekKeyVersion, open(x.dekEnc!), x.rawB64])).toEqual([[2, "key-0", "sealed-0"], [2, "key-1", "sealed-1"]]);
    expect(rows.find((x) => x.dekEnc === null)).toMatchObject({ dekKeyVersion: null, rawB64: "cGxhaW4=" });
    expect((await kekRewrapCensus(db as unknown as Tx, 2)).outstanding).toBe(0);
    expect((await kekRetiredReferences(db as unknown as Tx, 1)).total).toBe(0);
  });
});
