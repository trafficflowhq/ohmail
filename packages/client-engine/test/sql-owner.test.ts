import { describe, expect, it } from "vitest";
import { SqlMirrorStore, mirrorDbName } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { newDb, nodeSqlExecutor, sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * INVARIANT #9 ON SQLITE — the mirror belongs to an account, carried verbatim from
 * `idb-owner.test.ts` to the React Native arm.
 *
 * The browser learned this the expensive way: one shared database name meant the second
 * account on a machine hydrated the first one's mail and resumed from a cursor that was not
 * theirs. On a phone the stakes are strictly higher — one device holds mirrors for accounts on
 * DIFFERENT servers, and two servers' opaque account ids may collide — so both halves of the
 * discipline carry over: the name derivation ({@link mirrorDbName}, the same function) and the
 * `__owner` stamp checked before anything is hydrated.
 *
 * No legacy-database suite here, deliberately: sqlite mirrors never existed before this store,
 * so there is no pre-repair name to purge — the browser's `LEGACY_MIRROR_DB` hygiene has no
 * sqlite counterpart to test.
 */

const seeded = () => new FixturesAdapter().sync({ since: "0", limit: 2000 });

const keysOf = (s: SqlMirrorStore): string[] => [...s.snapshot().keys()].sort();

describe("the sqlite mirror belongs to an account", () => {
  it("THE REGRESSION: account B never sees account A's mail or cursor", async () => {
    const world = sqlWorld();
    const page = await seeded();

    // Account A connects on this device and syncs a mailbox.
    const a = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await a.load();
    await a.applyResponse(page);
    expect(a.snapshot().size).toBeGreaterThan(0);
    const aKeys = keysOf(a);
    const aCursor = a.getCursor();
    a.close();

    // Account B connects on the same device, with no sync of their own yet.
    const b = new SqlMirrorStore({ owner: "acct-B", open: world.open });
    await b.load();

    expect(b.snapshot().size, "B hydrated A's records").toBe(0);
    expect(keysOf(b)).toEqual([]);
    expect(b.getCursor(), "B resumed from A's cursor and would skip their own history").toBe("0");
    expect(b.maxSeq()).toBe(0);
    expect(aCursor).not.toBe("0"); //  the fixture really did advance A's cursor
    b.close();

    // …and A's mail is still A's when they come back.
    const again = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await again.load();
    expect(keysOf(again)).toEqual(aKeys);
    expect(again.getCursor()).toBe(aCursor);
    again.close();
  });

  it("the two accounts are in two DIFFERENT databases, named for them", async () => {
    const world = sqlWorld();
    const page = await seeded();
    for (const owner of ["acct-A", "acct-B"]) {
      const s = new SqlMirrorStore({ owner, open: world.open });
      await s.load();
      if (owner === "acct-A") await s.applyResponse(page);
      s.close();
    }
    // The SAME derivation the browser arm uses — a support call reads the same name shape on
    // either platform.
    expect(world.names()).toEqual([mirrorDbName("acct-A"), mirrorDbName("acct-B")].sort());
  });

  it("an UNOWNED store cannot be constructed — there is no default", () => {
    const world = sqlWorld();
    expect(() => new SqlMirrorStore({ open: world.open })).toThrow(/owner/i);
    expect(() => new SqlMirrorStore({ owner: "  ", open: world.open })).toThrow(/owner/i);
  });

  it("a database stamped with somebody else is WIPED, not read", async () => {
    // Unreachable through the name — which is exactly why it is handled. A restored backup, a
    // changed naming scheme, or two servers issuing the same opaque account id all land here.
    const world = sqlWorld();
    const page = await seeded();
    const name = mirrorDbName("acct-A");

    const a = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await a.load();
    await a.applyResponse(page);
    a.close();

    // Same bytes on disk, different claimant.
    const impostor = new SqlMirrorStore({ owner: "acct-B", dbName: name, open: world.open });
    await impostor.load();
    expect(impostor.snapshot().size).toBe(0);
    expect(impostor.getCursor()).toBe("0");
    impostor.close();

    // …and the wipe is durable: A's records are gone from that database for good, rather than
    // merely hidden from the instance that refused them.
    const raw = new SqlMirrorStore({ dbName: name, open: world.open });
    await raw.load();
    expect(raw.snapshot().size).toBe(0);
    raw.close();
  });

  it("the ownership stamp is never handed back as application meta", async () => {
    const world = sqlWorld();
    const s = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await s.load();
    await s.setMeta("theme", "dark");
    s.close();

    const again = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await again.load();
    expect(again.getMeta("theme")).toBe("dark");
    expect(again.getMeta("__owner")).toBeUndefined();
    again.close();
  });

  it("a re-bootstrap wipe leaves the database OWNED, not empty and claimable", async () => {
    const world = sqlWorld();
    const page = await seeded();
    const s = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await s.load();
    await s.applyResponse(page);
    await s.resetForBootstrap(); //   the 410 cursor-expired path
    s.close();

    // If the stamp had been cleared with everything else, B could take this database over
    // silently. It must still refuse — and prove it by wiping rather than reading.
    const b = new SqlMirrorStore({ owner: "acct-B", dbName: mirrorDbName("acct-A"), open: world.open });
    await b.load();
    expect(b.snapshot().size).toBe(0);
    b.close();

    const a2 = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await a2.load();
    await a2.applyResponse(page);
    expect(a2.snapshot().size).toBeGreaterThan(0);
    a2.close();
  });

  it("the mail a re-bootstrap writes after its wipe is still the account's: another claimant reads none of it", async () => {
    const world = sqlWorld();
    const page = await seeded();
    const s = new SqlMirrorStore({ owner: "acct-A", open: world.open });
    await s.load();
    await s.applyResponse(page);
    await s.resetForBootstrap(); //   the 410 cursor-expired path
    await s.applyResponse(page); //   …and the bootstrap that follows it, on the same open store
    expect(s.snapshot().size).toBeGreaterThan(0);
    s.close();

    // The same bytes, another claimant: a database left unowned by the wipe would be claimed and read.
    const b = new SqlMirrorStore({ owner: "acct-B", dbName: mirrorDbName("acct-A"), open: world.open });
    await b.load();
    expect(b.snapshot().size, "B read the mail A synced after its re-bootstrap").toBe(0);
    expect(b.getCursor()).toBe("0");
    b.close();
  });

  it("the wipe-then-claim is ONE atomic batch — a wipe cannot land unclaimed", async () => {
    // The stamp mismatch wipes and claims in the same batch. Kill the SQL runner exactly there
    // and the database must still be STAMPED FOR A — a successful wipe with a failed claim
    // would leave it empty and silently claimable, the state the stamp exists to prevent.
    const page = await seeded();
    const db = newDb();
    const real = nodeSqlExecutor(db);

    const a = new SqlMirrorStore({ owner: "acct-A", open: () => real });
    await a.load();
    await a.applyResponse(page);
    a.close();

    // B claims the same database through a SQL runner whose WIPE batch dies mid-flight —
    // after the transaction opened, before it could commit.
    const dying = {
      all: real.all,
      batch: (stmts: Parameters<typeof real.batch>[0]) =>
        stmts.some((s) => s.sql.startsWith("DELETE FROM entities"))
          ? Promise.reject(new Error("killed mid-wipe"))
          : real.batch(stmts),
    };
    const b = new SqlMirrorStore({ owner: "acct-B", dbName: mirrorDbName("acct-A"), open: () => dying });
    await expect(b.load()).rejects.toThrow(/killed mid-wipe/);

    // Nothing tore: A's mirror is intact AND still A's.
    const a2 = new SqlMirrorStore({ owner: "acct-A", open: () => real });
    await a2.load();
    expect(a2.snapshot().size).toBeGreaterThan(0);
    expect(a2.getCursor()).toBe(page.cursor);
    a2.close();
  });
});
