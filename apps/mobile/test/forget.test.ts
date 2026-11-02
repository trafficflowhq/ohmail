/**
 * THE TAKE-BACK — "forget this server" measured at the STORES, not at the call.
 *
 * Every assertion here is an ABSENCE at a real store: the SQLite database is gone from the
 * world (a fresh open of the same name has none of the mirror's tables), the keystore no
 * longer holds the profile, and the durable wipe queue is empty. That distinction is the whole
 * point of the suite — the defect this closes had a forget that called `store.close()`, which
 * is a HANDLE, and a test asserting "the deleter was called" would have passed against a
 * deleter that did nothing. So the no-op deleter is here too, as its own case, and it must be
 * reported as a PARTIAL take-back rather than as a forget.
 *
 * ── THE FOUR PROPERTIES ────────────────────────────────────────────────────────────────────
 *
 *  1. a forget removes the mail, and a relaunch finds nothing — no entity, no body, no outbox
 *     entry, no cursor;
 *  2. a deletion that does not land is REPORTED, and the debt survives to be paid at the next
 *     launch (`drainPendingWipes`);
 *  3. a keystore that will not let go of the credential fails LOUDLY, with the remedy that
 *     always works (revoke the device server-side);
 *  4. the install generation: a container without the marker is a fresh install, and every
 *     pairing the keystore outlived is purged before a profile is read — which is what makes
 *     deleting the app a take-back on iOS, where the Keychain survives it.
 */
import { describe, expect, it, vi } from "vitest";
import { refuse, sayRefusal } from "../src/refusal";
import { OUTBOX_TYPE, SqlMirrorStore, mirrorDbName } from "@ohmail/client-engine";
import {
  LOCAL_ENGINE_ORIGIN, forgetMirror, mirrorExists, mirrorOwnerKey, type MobileEngineDeps,
} from "../src/engine/boot";
import {
  ENGINE_DB_FILE, ENGINE_STORE_TABLES, openLocalEnginePlatform, removeStandaloneEngine,
} from "../src/engine/local-engine";
import { KEK_KEY } from "../src/engine/kek";
import {
  connectProfileById, drainPendingSignOuts, drainPendingWakeDrops, drainPendingWipes, forgetProfile, pairWithServer,
  revokeProfile, type PairingEnv,
} from "../src/net/pairing";
import type { FetchLike } from "../src/net/bearer";
import { installPinning } from "../src/net/host-pinning";
import { dropWakeRowOrOwe } from "../src/net/push";
import {
  INSTALL_MARKER_DB, installGeneration, settleInstallGeneration,
} from "../src/state/install-marker";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { listen, pairServer, pairThroughConfirm, sqlWorld } from "./helpers/pair-server";
import { engineStoreWorld } from "./helpers/expo-sqlite-shape";
import { Copy } from "../src/copy";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

function memoryKV(): { kv: SecureKV; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    kv: {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => void map.set(k, v),
      remove: async (k) => void map.delete(k),
    },
  };
}

function testEnv(overrides: Partial<MobileEngineDeps> = {}, kv?: SecureKV) {
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
    ...overrides,
  };
  const profiles = new ServerProfileStore(kv ?? memoryKV().kv);
  const env: PairingEnv = { profiles, engineDeps: deps };
  return { env, world, profiles };
}

/**
 * Pair, drain two messages, and leave one un-flushed mutation in the durable outbox — so the
 * mirror under test holds all three of the things a forget claims to remove: entities, the
 * cursor, and a queued verb the engine would replay.
 */
async function pairedWithMail(env: PairingEnv, origin: string, token: string) {
  const outcome = await pairThroughConfirm(env, { origin, token });
  if (outcome.kind !== "paired") throw new Error(`pairing refused: ${outcome.reason}`);
  await outcome.session.verifyIdentity();
  await outcome.session.engine.start();
  expect(outcome.session.engine.read().list("message")).toHaveLength(2);
  return outcome.session;
}

/** What the world still holds under a mirror's name, read WITHOUT creating a store. */
async function tablesUnder(world: ReturnType<typeof sqlWorld>, ownerKey: string): Promise<string[]> {
  const db = world.open(mirrorDbName(ownerKey));
  const rows = await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'meta')",
  );
  return rows.map((r) => String(r.name)).sort();
}

describe("forget removes the MAIL, not only the pairing", () => {
  it("a relaunch on the same owner key finds no entity, no body, no outbox and no cursor", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const { env, world, profiles } = testEnv();

      const session = await pairedWithMail(env, origin, "tok-1");
      const ownerKey = session.ownerKey;
      // A verb the engine has NOT flushed: this is what lives in `meta`'s durable outbox, and
      // it is the half a "close the handle" forget left behind alongside the mail.
      await session.engine.mutate({ kind: "mark_seen", messageIds: ["m1"], unread: false });
      expect(await tablesUnder(world, ownerKey)).toEqual(["entities", "meta"]);

      const row = (await profiles.list())[0]!;
      const outcome = await forgetProfile(env, row.id, { closed: Promise.resolve(session.store.close()) });
      expect(outcome).toEqual({ kind: "forgotten" });

      // ── THE ABSENCE, AT THE STORE ──────────────────────────────────────────────────────
      // The physical database is gone: an open of that name yields one this call just made,
      // with none of the mirror's tables in it.
      expect(await tablesUnder(world, ownerKey)).toEqual([]);
      // And the relaunch the user would actually do: a store on the same owner key reads an
      // empty mirror from cursor zero, with nothing queued to replay.
      const relaunched = new SqlMirrorStore({ owner: ownerKey, open: world.open });
      await relaunched.load();
      expect(relaunched.list("message")).toEqual([]);
      // The hydrated bodies (`message_body`) and the DURABLE OUTBOX (`outbox_entry`) are both
      // client-local records in the same table, and both are mail the user believes is gone.
      expect(relaunched.list("message_body")).toEqual([]);
      expect(relaunched.entries(OUTBOX_TYPE)).toEqual([]);
      expect(relaunched.getCursor()).toBe("0");
      relaunched.close();

      // The credential went with it, and nothing is owed.
      expect(await profiles.list()).toEqual([]);
      expect(await profiles.pendingWipes()).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("THE MUTATION: restore the best-effort behaviour (no deletion) and the take-back is refused, not reported", async () => {
    // This is the defect verbatim — `forget` closed the store handle and there was no deletion
    // path in the app at all. With `deleteDatabase` a no-op, the read-back finds the mirror's
    // tables still there and the outcome is PARTIAL: the sentence names the mail, and the wipe
    // stays owed. A test that asserted "the deleter was called" would be green right here.
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const { env, world, profiles } = testEnv({ deleteDatabase: async () => undefined });

      const session = await pairedWithMail(env, origin, "tok-1");
      const ownerKey = session.ownerKey;
      const row = (await profiles.list())[0]!;
      const outcome = await forgetProfile(env, row.id, { closed: Promise.resolve(session.store.close()) });

      expect(outcome.kind).toBe("partial");
      if (outcome.kind !== "partial") return;
      expect(sayRefusal(outcome.reason)).toMatch(/could not be deleted/);
      expect(sayRefusal(outcome.reason)).toMatch(/try again the next time it starts/);

      // The mail really is still there — the report is not pessimism, it is the truth.
      expect(await tablesUnder(world, ownerKey)).toEqual(["entities", "meta"]);
      const still = new SqlMirrorStore({ owner: ownerKey, open: world.open });
      await still.load();
      expect(still.list("message")).toHaveLength(2);
      still.close();

      // And the debt is DURABLE: the profile is gone, so nothing else on this phone could
      // still name the mirror — the queue is the only thing that can.
      expect(await profiles.list()).toEqual([]);
      expect((await profiles.pendingWipes()).map((w) => w.owner)).toEqual([ownerKey]);
    } finally {
      fake.server.close();
    }
  });

  it("the owed deletion is paid at the next launch, and a launch that cannot pay keeps the debt", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const world = sqlWorld();
      const { kv } = memoryKV();
      const profiles = new ServerProfileStore(kv);
      // A deleter that can be turned off, so one env models both launches.
      let deleting = false;
      const env: PairingEnv = {
        profiles,
        engineDeps: {
          openExecutor: world.open,
          deleteDatabase: async (name) => {
            if (deleting) await world.drop(name);
          },
          uuid: () => "00000000-0000-4000-8000-000000000000",
        },
      };

      const session = await pairedWithMail(env, origin, "tok-1");
      const ownerKey = session.ownerKey;
      const row = (await profiles.list())[0]!;
      expect((await forgetProfile(env, row.id, { closed: Promise.resolve(session.store.close()) })).kind)
        .toBe("partial");

      // Launch two: still cannot delete. The debt must SURVIVE a failed drain — a queue that
      // cleared itself on the attempt would lose the mail's only remaining name.
      expect(await drainPendingWipes(env)).toEqual([ownerKey]);
      expect((await profiles.pendingWipes()).map((w) => w.owner)).toEqual([ownerKey]);
      expect(await tablesUnder(world, ownerKey)).toEqual(["entities", "meta"]);

      // Launch three: the deletion lands, the debt clears, the mail is gone.
      deleting = true;
      expect(await drainPendingWipes(env)).toEqual([]);
      expect(await profiles.pendingWipes()).toEqual([]);
      expect(await tablesUnder(world, ownerKey)).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("a keystore that will not let go fails LOUDLY, and names the remedy that always works", async () => {
    // The credential is the residue that can still OPEN the mailbox, so a refused removal is the
    // one that must never be reported as a forget. `remove` reads the index back for exactly this.
    const { kv, map } = memoryKV();
    const stubborn: SecureKV = { ...kv, remove: async () => undefined };
    const { env, profiles } = testEnv({}, stubborn);
    await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const row = (await profiles.list())[0]!;

    const outcome = await forgetProfile(env, row.id);
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(sayRefusal(outcome.reason)).toMatch(/would not let go of the pairing/);
    expect(sayRefusal(outcome.reason)).toMatch(/Devices list/);
    // Still there, still holding the refresh token, and still IN THE LIST — which is why the
    // sentence points at the server-side revoke rather than telling the reader to press again.
    // The row leaving the picker while its credential stayed readable would be the worse
    // failure: an invisible residue.
    expect((await profiles.list())[0]?.refreshToken).toBe("ref-1");
    expect([...map.values()].some((v) => v.includes("ref-1"))).toBe(true);
  });

  it("forgetMirror's verdict comes from the DATABASE, not from the deleter's promise", async () => {
    // The narrow unit: a deleter that resolves without deleting is a failed take-back.
    const world = sqlWorld();
    const ownerKey = mirrorOwnerKey("http://a.example", "acct-1");
    const store = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m-secret", seq: 1, updatedAt: "2026-08-19T08:00:00Z",
      entity: { id: "m-secret", accountId: "acct-1", subject: "still here" },
    }]);
    store.close();

    const lying: MobileEngineDeps = {
      openExecutor: world.open, deleteDatabase: async () => undefined, uuid: () => "u",
    };
    await expect(forgetMirror(lying, ownerKey)).rejects.toThrow(/still on the device/);
    // The message names the tables that survived, so a log line says WHAT was left behind.
    await expect(forgetMirror(lying, ownerKey)).rejects.toThrow(/entities, meta/);

    const honest: MobileEngineDeps = { ...lying, deleteDatabase: world.drop };
    await expect(forgetMirror(honest, ownerKey)).resolves.toBeUndefined();
    // The read-back probe cleans up after itself: no empty stub is left under the name.
    expect(world.names()).not.toContain(mirrorDbName(ownerKey));
  });
});

describe("the review's own findings, each with the sequence that reaches it", () => {
  it("a keystore that keeps ONE profile key refuses the purge, keeps the index, and never stamps", async () => {
    // The purge was best-effort per key, dropped the INDEX anyway, and let the marker report
    // the install as purged. A live refresh token would have survived the purge that claimed
    // it, under a key nothing lists any more, and no later launch would ever try again.
    const map = new Map<string, string>();
    let stubbornKey: string | null = null;
    const kv: SecureKV = {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => void map.set(k, v),
      remove: async (k) => { if (k !== stubbornKey) map.delete(k); },
    };
    const { env, profiles } = testEnv({}, kv);
    const keep = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-STUCK",
    });
    await profiles.add({
      origin: "http://b.example", flavor: "selfhost", accountId: "acct-2", refreshToken: "ref-2",
    });
    stubbornKey = `ohmail.servers.v1.${keep.id}`;

    const verdict = await settleInstallGeneration(env.engineDeps, profiles);
    expect(verdict.kind).toBe("purge-refused");
    if (verdict.kind !== "purge-refused") return;
    expect(sayRefusal(verdict.reason)).toMatch(/could not be purged/);

    // The index SURVIVES, because it is the only thing that names the surviving credential.
    expect(map.has("ohmail.servers.v1")).toBe(true);
    expect([...map.values()].some((v) => v.includes("ref-STUCK"))).toBe(true);
    // The one that COULD go, went — a refusal on one key must not spare the others.
    expect([...map.values()].some((v) => v.includes("ref-2"))).toBe(false);

    // And the generation was NOT stamped, so the next launch tries again — which is what makes
    // the refusal a retry rather than a permanent residue.
    stubbornKey = null;
    const second = await settleInstallGeneration(env.engineDeps, profiles);
    expect(second.kind).toBe("fresh-install");
    expect(await profiles.list()).toEqual([]);
    expect([...map.values()].some((v) => v.includes("ref-STUCK"))).toBe(false);
  });

  it("a kill between the intent and the credential does NOT resurrect the pairing", async () => {
    // The durable intent used to record only the mirror's owner key. A kill after that write
    // and before `remove(profileId)` left the profile standing and still ACTIVE, so the next
    // launch deleted the mirror, cleared the debt, then reconnected and drained the entire
    // mailbox back onto the phone: a forget interrupted at its documented crash point came
    // back as a paired server with the mail in it.
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const { env, world, profiles } = testEnv();
      const session = await pairedWithMail(env, origin, "tok-1");
      const ownerKey = session.ownerKey;
      const row = (await profiles.list())[0]!;
      session.store.close();

      // THE KILL: the intent is durable, nothing else has run.
      await profiles.markPendingWipe(row.id, ownerKey);
      expect(await profiles.pendingWipes()).toEqual([{ id: row.id, owner: ownerKey }]);
      expect((await profiles.active())?.id).toBe(row.id); // still bootable — this is the danger

      // The next launch pays the debt. The CREDENTIAL goes first, or the profile below is live.
      expect(await drainPendingWipes(env)).toEqual([]);
      expect(await profiles.list()).toEqual([]);
      expect(await profiles.active()).toBeNull();
      expect(await tablesUnder(world, ownerKey)).toEqual([]);
      expect(await profiles.pendingWipes()).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("a launch whose purge was REFUSED does not read a single pairing", async () => {
    // The verdict existed and nobody read it: the launch drained wipes, read `active()` and
    // booted the surviving credential — so the take-back failed AND opened the mailbox, which
    // is the exact no-ceremony reinstall the marker is for. The connection layer is React, so
    // this is a source census; what it pins is the ORDER, which is the whole property.
    // Scoped to the LAUNCH EFFECT, not the whole file: `env.profiles.active()` also appears in
    // `refreshProfiles`, which is DECLARED above it — an unscoped `indexOf` would compare the
    // launch's refusal against a helper's declaration and pass or fail for the wrong reason.
    const whole = read("../src/net/connection.tsx");
    const start = whole.indexOf("useEffect(() => {\n    void gate");
    const end = whole.indexOf("const api = useMemo<Connection>(", start);
    expect(start, "the launch effect must be findable").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const conn = whole.slice(start, end);
    const settle = conn.indexOf("settleInstallGeneration(");
    const refuse = conn.indexOf('install.kind === "purge-refused"');
    const drain = conn.indexOf("drainPendingWipes(env)");
    const read0 = conn.indexOf("env.profiles.active()");
    expect(settle).toBeGreaterThan(-1);
    expect(refuse, "the verdict must be acted on").toBeGreaterThan(settle);
    expect(drain, "…before anything drains").toBeGreaterThan(refuse);
    expect(read0, "…and before any profile is read").toBeGreaterThan(refuse);
    expect(conn.slice(refuse, drain)).toMatch(/return;/);
    /* The marker's own reason reaches the screen, and reaches it AS A REFUSAL. This used to pin
       the literal `sayRefusal(install.reason)`, which rendered the inner clause at production
       time and left it in the language it was produced in — so the pin held the defect in place.
       The shape is what matters: the value is passed whole. */
    expect(conn, "the marker's own reason must reach the screen, unrendered")
      .toMatch(/refuse\("serversPurgeRefused",\s*install\.reason\)/);

    // ── `unknown` STOPS TOO, AND FOR A DIFFERENT REASON THAN IT DELETES ─────────────────
    //
    // This once asserted the opposite — that `unknown` must NOT stop the launch — and that
    // conflated two acts. It still deletes nothing (a transient storage failure must not cost
    // somebody their pairings), but it may not CONNECT either: on iOS the keychain outlives an
    // uninstall, so an unverified marker is precisely the state in which a stranger's reinstall
    // opens a mailbox, and the app's own About copy promises the pairing is discarded before
    // anything is opened. Refusing keeps both halves.
    const unknown = conn.indexOf('install.kind === "unknown"');
    expect(unknown, "an unverified marker must not connect").toBeGreaterThan(settle);
    expect(drain, "…and it stops before anything drains").toBeGreaterThan(unknown);
    expect(conn.slice(unknown, drain)).toMatch(/return;/);
    expect(conn, "the unreadable marker's own reason must reach the screen, unrendered")
      .toMatch(/refuse\("serversInstallUnknown",\s*install\.reason\)/);
    // …and it does NOT purge: the verdict producer is the only thing allowed to delete.
    expect(conn).not.toMatch(/purgeAll/);
  });

  it("a full wipe queue REFUSES a new forget rather than evicting an old debt", async () => {
    // The bound used to `slice(-N)` in the common index writer. An unpaid debt is the ONLY
    // remaining name of a mirror still on disk — the profile that named it is already gone —
    // so evicting one stranded that mail for ever, while the screen had just promised the app
    // would try again at startup.
    const { env, world, profiles } = testEnv({ deleteDatabase: async () => undefined });
    const owed: string[] = [];
    for (let i = 0; i < 12; i++) {
      const key = mirrorOwnerKey(`http://s${i}.example`, `acct-${i}`);
      await profiles.markPendingWipe(`p${i}`, key);
      owed.push(key);
    }
    expect((await profiles.pendingWipes()).map((w) => w.owner)).toEqual(owed);

    // A THIRTEENTH profile, forgotten. Nothing about it may be touched.
    const row = await profiles.add({
      origin: "http://last.example", flavor: "selfhost", accountId: "acct-last", refreshToken: "ref-last",
    });
    const outcome = await forgetProfile(env, row.id);
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(sayRefusal(outcome.reason)).toMatch(/could not start forgetting/);
    expect(sayRefusal(outcome.reason)).toMatch(/Restart ohmail/);

    // Every earlier debt is intact — none was evicted to make room…
    expect((await profiles.pendingWipes()).map((w) => w.owner)).toEqual(owed);
    // …and the refused forget changed nothing, so the credential is still there to retry with.
    expect((await profiles.list()).map((p) => p.id)).toEqual([row.id]);
    void world;
  });

  it("a full queue still fits in one keystore value, measured rather than assumed", async () => {
    // The cap exists because expo-secure-store warns past 2 KB per VALUE. The number is only
    // safe if the full queue plus a realistic profile list actually fits, so it is measured.
    const { kv, map } = memoryKV();
    const profiles = new ServerProfileStore(kv);
    for (let i = 0; i < 4; i++) {
      await profiles.add({
        origin: `https://mail-${i}.a-fairly-long-hostname.example`,
        flavor: "selfhost",
        accountId: `00000000-0000-4000-8000-00000000000${i}`,
        refreshToken: "r".repeat(64),
      });
    }
    for (let i = 0; i < 12; i++) {
      await profiles.markPendingWipe(
        `p${i}aaaaaaaaaaaaaa`,
        mirrorOwnerKey(`https://mail-${i}.a-fairly-long-hostname.example`, `00000000-0000-4000-8000-00000000000${i}`),
      );
    }
    const index = map.get("ohmail.servers.v1")!;
    expect(Buffer.byteLength(index, "utf8")).toBeLessThan(2048);
  });

  it("re-pairing the same mailbox settles the owed forget FIRST, so no later drain eats it", async () => {
    // A forget whose deletion failed leaves {oldId, owner} owed, and a re-pair of the same
    // (origin, account) resolves to that same owner — and, because `add()` re-pairs in place,
    // the same profile id. Adopting it booted the SURVIVING mirror; the next launch's drain
    // then deleted the database the person had just re-authorized, taking any work queued into
    // it with them: a debt written against the old pairing, collected against the new one.
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const world = sqlWorld();
      const { kv } = memoryKV();
      const profiles = new ServerProfileStore(kv);
      let deleting = false;
      const env: PairingEnv = {
        profiles,
        engineDeps: {
          openExecutor: world.open,
          deleteDatabase: async (n) => { if (deleting) await world.drop(n); },
          uuid: () => "00000000-0000-4000-8000-000000000000",
        },
      };

      const session = await pairedWithMail(env, origin, "tok-1");
      const ownerKey = session.ownerKey;
      const row = (await profiles.list())[0]!;
      // `revoke` is stubbed so the FAKE SERVER's family survives for the re-pair below. The
      // real forget spends the refresh token into a logout, which is correct and is covered by
      // its own case; here it would end the loopback server's session and the second redeem
      // would refuse for a reason that has nothing to do with the property under test.
      expect((await forgetProfile(env, row.id, {
        closed: Promise.resolve(session.store.close()),
        revoke: async () => true,
      })).kind).toBe("partial");
      expect((await profiles.pendingWipes()).map((w) => w.owner)).toEqual([ownerKey]);

      // The person re-pairs, and this time the deletion can land.
      deleting = true;
      fake.mintPairToken("tok-2");
      const again = await pairThroughConfirm(env, { origin, token: "tok-2" });
      expect(again.kind).toBe("paired");
      if (again.kind !== "paired") return;

      // THE DEBT IS SETTLED, not carried: nothing is owed against the mirror now in use…
      expect(await profiles.pendingWipes()).toEqual([]);
      // …and the mirror the new pairing boots is a fresh one, not the old mail.
      await again.session.verifyIdentity();
      await again.session.engine.start();
      const relaunch = new SqlMirrorStore({ owner: again.session.ownerKey, open: world.open });
      await relaunch.load();
      relaunch.close();
      // A drain now must find nothing to do, so it cannot eat the adopted mirror.
      expect(await drainPendingWipes(env)).toEqual([]);
      expect(await tablesUnder(world, again.session.ownerKey)).toEqual(["entities", "meta"]);
      again.session.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("and a re-pair whose owed deletion STILL fails is refused, never adopted", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const { env, profiles } = testEnv({ deleteDatabase: async () => undefined });
      const session = await pairedWithMail(env, origin, "tok-1");
      const row = (await profiles.list())[0]!;
      await forgetProfile(env, row.id, {
        closed: Promise.resolve(session.store.close()),
        revoke: async () => true, // see the sibling case
      });

      fake.mintPairToken("tok-2");
      const from = fake.seen.length;
      const again = await pairThroughConfirm(env, { origin, token: "tok-2" });
      expect(again.kind).toBe("refused");
      if (again.kind !== "refused") return;
      expect(sayRefusal(again.reason)).toMatch(/still owes a deletion/);
      // Nothing was stored, so nothing boots the mail this app cannot delete…
      expect(await profiles.list()).toEqual([]);
      // …and the session the redeem minted is ended there, after the redeem and with its bearer.
      const after = fake.seen.slice(from).map((r) => [r.url, (r.auth ?? "").startsWith("Bearer ")]);
      expect(after.slice(after.findIndex(([u]) => u === "/pair/redeem")).filter(([u]) => u === "/auth/logout"))
        .toEqual([["/auth/logout", true]]);
    } finally {
      fake.server.close();
    }
  });

  it("a profile still owed a forget cannot be booted by ANY path", async () => {
    // A forget whose CREDENTIAL removal was refused correctly leaves the row and the debt — the
    // row is the only thing that still names it and the launch retries. What must not follow is
    // the launch reading that row as the active profile and connecting it, which would turn the
    // retry into a resurrection. Asserted at `buildSession`, the one place every session is
    // built, so launch, switch and connect-by-id all inherit it.
    const { kv, map } = memoryKV();
    const stubborn: SecureKV = { ...kv, remove: async (k) => { if (k === "ohmail.servers.v1") map.delete(k); } };
    const { env, profiles } = testEnv({}, stubborn);
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    expect((await forgetProfile(env, row.id)).kind).toBe("partial");
    expect((await profiles.pendingWipes()).map((w) => w.id)).toEqual([row.id]);

    const boot = await connectProfileById(env, row.id);
    expect(boot.kind).toBe("refused");
    if (boot.kind !== "refused") return;
    expect(sayRefusal(boot.reason)).toMatch(/still being forgotten/);
    expect(sayRefusal(boot.reason)).toMatch(/Devices list/);
  });

  it("a REFUSED wake-row removal is written down, and paid at the next launch", async () => {
    // Both the switch path and the superseded-registration path fire the delete and walk away,
    // and both used to discard the verdict with the id. A 401, a 500 or a lost network then
    // left a row NOTHING could name again — and because the distributor endpoint is shared with
    // the profile now in use and therefore still answering, the server never gets the 404/410
    // it prunes on. The row and its outbound traffic were permanent.
    const { kv } = memoryKV();
    const profiles = new ServerProfileStore(kv);
    const row = await profiles.add({
      origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });

    const calls: Array<{ url: string; method: string }> = [];
    let serverAnswers = 500;
    /**
     * SINGLE-USE ROTATION, modelled properly. An endlessly reusable `/auth/refresh` stub made
     * this guard blind to a defect the drain itself introduced: a manager on a throwaway vault
     * spends the stored refresh token, discards the replacement, and leaves the CONSUMED token
     * in the keystore — and presenting a consumed token is the reuse signal that revokes the
     * family. Paying a "stop waking me" debt would have ended the pairing this launch is about
     * to boot. Here a second presentation of a spent token is refused, as the server refuses it.
     */
    let head = "ref-1";
    let mints = 0;
    // …and the DELETE is AUTHENTICATED, like the real route: a cold manager holds no access
    // token, so its first attempt 401s and the recovery is what spends the refresh token. A
    // fake that accepted the bare request would never reach the rotation this case is about.
    const live = new Set<string>();
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/auth/refresh")) {
        const presented = (JSON.parse(init?.body ?? "{}") as { refreshToken?: string }).refreshToken;
        if (presented !== head) return new Response(null, { status: 401 }); // reuse: refused
        mints += 1;
        head = `ref-${mints + 1}`;
        live.add(`acc-${mints}`);
        return new Response(JSON.stringify({ tokens: { accessToken: `acc-${mints}`, refreshToken: head } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      const auth = init?.headers?.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !live.has(auth.slice("Bearer ".length))) {
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: serverAnswers });
    }) as unknown as PairingEnv["fetchImpl"];
    const env: PairingEnv = {
      profiles,
      engineDeps: { openExecutor: sqlWorld().open, deleteDatabase: async () => undefined, uuid: () => "u" },
      fetchImpl,
    };

    // The switch fires the delete; the server refuses; the DEBT is what survives.
    const session = { profile: row, fetch: fetchImpl } as unknown as Parameters<typeof dropWakeRowOrOwe>[0];
    expect((await dropWakeRowOrOwe(session, "sub-A", profiles)).ok).toBe(false);
    expect(await profiles.pendingWakeDrops()).toEqual([{ profileId: row.id, subscriptionId: "sub-A" }]);

    // A launch that still cannot reach the server KEEPS the debt.
    expect(await drainPendingWakeDrops(env)).toEqual(["sub-A"]);
    expect(await profiles.pendingWakeDrops()).toHaveLength(1);

    // …and the launch where the server answers pays it, against that profile's own credential.
    serverAnswers = 204;
    calls.length = 0;
    expect(await drainPendingWakeDrops(env)).toEqual([]);
    expect(await profiles.pendingWakeDrops()).toEqual([]);
    expect(calls.some((c) => c.method === "DELETE" && c.url === "https://a.example/push/subscriptions/sub-A"))
      .toBe(true);

    // ── AND THE PAIRING SURVIVED PAYING THE DEBT ──────────────────────────────────────────
    //
    // The drain's manager spends the stored refresh token to authenticate its DELETE. The
    // ROTATION it gets back has to be kept: a throwaway vault would leave the consumed token in
    // the keystore, and this launch boots that same profile moments later — whose first refresh
    // would then be a reuse and would revoke the whole family.
    const after = (await profiles.list())[0]!;
    expect(after.refreshToken, "the rotation must be persisted, not discarded").toBe(head);
    expect(after.refreshToken).not.toBe("ref-1");
  });

  it("a debt whose profile is gone is dropped, not retried for ever", async () => {
    // The row is deleted on that profile's own server with that profile's own credential. Once
    // the pairing is forgotten there is nothing left to present, so the entry would be a
    // permanent no-op — and the row lapses with the pairing it belonged to.
    const { kv } = memoryKV();
    const profiles = new ServerProfileStore(kv);
    await profiles.markPendingWakeDrop("p-gone", "sub-Z");
    const env: PairingEnv = {
      profiles,
      engineDeps: { openExecutor: sqlWorld().open, deleteDatabase: async () => undefined, uuid: () => "u" },
      fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as PairingEnv["fetchImpl"],
    };
    expect(await drainPendingWakeDrops(env)).toEqual([]);
    expect(await profiles.pendingWakeDrops()).toEqual([]);
  });

  it("a forget whose SERVER was never told is partial, and names the remedy", async () => {
    // The logout was fire-and-forget on the reasoning that an unreachable server must not hold a
    // local forget open. That is sound about BLOCKING and wrong about REPORTING: the credential
    // this call destroys is the only thing that could ever retry the logout, and the logout is
    // what revokes the session AND takes this device's wake registration down. A forget reported
    // over a logout that never landed leaves both alive with nothing left to retry them.
    const { env, profiles } = testEnv();
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const outcome = await forgetProfile(env, row.id, { revoke: async () => false });
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(sayRefusal(outcome.reason)).toMatch(/could not be reached/i);
    expect(sayRefusal(outcome.reason)).toMatch(/Devices list/);
    // The LOCAL half still completed — a device taking its own credential back must not be
    // blocked by an unreachable server. That is the half the sentence says is done.
    expect(await profiles.list()).toEqual([]);
    expect(await profiles.pendingWipes()).toEqual([]);
    expect(sayRefusal(outcome.reason)).toMatch(/are gone/);
  });

  it("and a server that WAS told answers a plain forget", async () => {
    const { env, profiles } = testEnv();
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    expect(await forgetProfile(env, row.id, { revoke: async () => true })).toEqual({ kind: "forgotten" });
  });

  it("a second Forget on a row the first removed does NOT report success over owed mail", async () => {
    // Two taps before the row re-renders both reach the seam through the gate. The first writes
    // the debt, removes the credential and — the mirror deletion having failed — returns
    // `partial` with the mail still on the phone. The second found no row, derived no owner key
    // and returned `forgotten`: an unearned success that replaced the first tap's honest warning
    // and, on the last pairing, would have sent the screen to Welcome over a live mirror.
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const world = sqlWorld();
      const { kv } = memoryKV();
      const profiles = new ServerProfileStore(kv);
      let deleting = false;
      const env: PairingEnv = {
        profiles,
        engineDeps: {
          openExecutor: world.open,
          deleteDatabase: async (n) => { if (deleting) await world.drop(n); },
          uuid: () => "00000000-0000-4000-8000-000000000000",
        },
      };
      const session = await pairedWithMail(env, origin, "tok-1");
      const ownerKey = session.ownerKey;
      const row = (await profiles.list())[0]!;

      const first = await forgetProfile(env, row.id, {
        closed: Promise.resolve(session.store.close()),
        revoke: async () => true,
      });
      expect(first.kind).toBe("partial");
      expect(await profiles.list()).toEqual([]); // the row really is gone

      // THE SECOND TAP. Same profile id, no row left to find.
      const second = await forgetProfile(env, row.id, { revoke: async () => true });
      expect(second.kind, "a missing row is not proof the forget completed").toBe("partial");
      if (second.kind !== "partial") return;
      expect(sayRefusal(second.reason)).toMatch(/could not be deleted/);
      expect(await tablesUnder(world, ownerKey)).toEqual(["entities", "meta"]);

      // …and once the deletion can land, the same second-tap path FINISHES the owed debt.
      deleting = true;
      expect(await forgetProfile(env, row.id, { revoke: async () => true })).toEqual({ kind: "forgotten" });
      expect(await tablesUnder(world, ownerKey)).toEqual([]);
      expect(await profiles.pendingWipes()).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("a pairing that could not be stored says whether its session was really closed", async () => {
    // By the time the keystore refuses, the single-use token is burned and a server session is
    // minted, so the flow revokes it and says so. The status of that revocation was never read:
    // a 401, a 500 or a dead network all produced "the session was closed" over a live session —
    // a take-back asserted on the strength of a request having been sent.
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      const { kv } = memoryKV();
      // A keystore that refuses every write — the failure this compensation exists for.
      const refuses: SecureKV = { ...kv, set: async () => { throw new Error("keystore full"); } };
      const world = sqlWorld();
      const seen: string[] = [];
      const base = globalThis.fetch.bind(globalThis);
      let logoutStatus = 500;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/logout")) {
          seen.push(url);
          return new Response(null, { status: logoutStatus });
        }
        return base(url, init);
      }) as unknown as PairingEnv["fetchImpl"];
      const env: PairingEnv = {
        profiles: new ServerProfileStore(refuses),
        engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "u" },
        fetchImpl,
      };

      fake.mintPairToken("tok-1");
      const refused = await pairThroughConfirm(env, { origin, token: "tok-1" });
      expect(refused.kind).toBe("refused");
      if (refused.kind !== "refused") return;
      expect(seen).toHaveLength(1); // it really did try
      expect(sayRefusal(refused.reason), "a 500 is not a closed session").not.toMatch(/the session was closed/);
      expect(sayRefusal(refused.reason)).toMatch(/could not be reached to close the session/);
      expect(sayRefusal(refused.reason)).toMatch(/Devices list/);

      // …and when it DOES land, the original sentence is the true one.
      logoutStatus = 204;
      fake.mintPairToken("tok-2");
      const again = await pairThroughConfirm(env, { origin, token: "tok-2" });
      expect(again.kind).toBe("refused");
      if (again.kind !== "refused") return;
      expect(sayRefusal(again.reason)).toMatch(/the session was closed/);
    } finally {
      fake.server.close();
    }
  });

  it("an intent that did not persist REFUSES the forget, before the credential goes", async () => {
    // "Persist the decision first" is worth nothing if the persistence is not checked. A
    // keystore `set` that resolved without storing left the queue empty while the forget removed
    // the credential and promised on screen that the app would retry the deletion — and nothing
    // could, because the entry naming the mirror had never been written.
    const map = new Map<string, string>();
    const kv: SecureKV = {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => {
        // The index write is silently dropped; per-profile values still land, so the profile
        // exists to be forgotten and only the DEBT goes missing.
        if (k !== "ohmail.servers.v1") map.set(k, v);
      },
      remove: async (k) => void map.delete(k),
    };
    // The profile has to exist first, so it is added through a working store and the index is
    // then seeded by hand — `add` itself would be refused by the same dropped write.
    const { kv: good, map: shared } = memoryKV();
    const seeded = new ServerProfileStore(good);
    const row = await seeded.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    for (const [k, v] of shared) map.set(k, v);

    const { env, profiles } = testEnv({}, kv);
    const outcome = await forgetProfile(env, row.id, { revoke: async () => true });
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(sayRefusal(outcome.reason)).toMatch(/could not start forgetting/);
    // NOTHING was destroyed: the credential is still there, which is the recoverable state.
    expect((await profiles.list())[0]?.refreshToken).toBe("ref-1");
  });

  it("an index write that did not land REFUSES the pairing, before the credential", async () => {
    // Writing the index first is only worth something if the write landed: a `set` that resolved
    // without storing puts the credential under a key no list names, invisible to the purge that
    // walks the list — the exact state the ordering exists to prevent.
    const map = new Map<string, string>();
    const kv: SecureKV = {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => { if (k !== "ohmail.servers.v1") map.set(k, v); },
      remove: async (k) => void map.delete(k),
    };
    const { profiles } = testEnv({}, kv);
    await expect(profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-GHOST",
    })).rejects.toThrow(/could not record the pairing/);
    expect([...map.values()].some((v) => v.includes("ref-GHOST")),
      "no credential may be written behind an index that did not take").toBe(false);
  });

  it("an UNREADABLE index refuses the purge instead of passing over it", async () => {
    // `readIndex` answers an empty index for a corrupt value, which is right for readers — they
    // lose a list — and catastrophic here: the walk finds nothing to remove, reports a completed
    // purge, and leaves every indexed credential in the keystore under keys it never asked
    // about. "There is nothing to purge" and "I cannot tell what to purge" have opposite
    // correct actions.
    const { kv, map } = memoryKV();
    const profiles = new ServerProfileStore(kv);
    const { env } = testEnv({}, kv);
    await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    map.set("ohmail.servers.v1", "{not json");

    const verdict = await settleInstallGeneration(env.engineDeps, profiles);
    expect(verdict.kind).toBe("purge-refused");
    // The credential is still there — which is the point: it was never named, so nothing could
    // have removed it, and the verdict says so instead of claiming otherwise.
    expect([...map.values()].some((v) => v.includes("ref-1"))).toBe(true);
  });

  it("a closed store never opens again, so an in-flight mutation cannot recreate the mirror", async () => {
    // `close()` used to null the handle and nothing more, so a later touch simply opened the
    // database again — which on this arm means CREATING it. A mutation still in flight when the
    // forget ran would settle afterwards, touch the store, and put the mirror back with its
    // outbox in it, after the screen had said the mail was gone and with no debt left to remove
    // the recreated database.
    const world = sqlWorld();
    const ownerKey = mirrorOwnerKey("http://a.example", "acct-1");
    const store = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: 1, updatedAt: "2026-08-19T08:00:00Z",
      entity: { id: "m1", accountId: "acct-1", subject: "still here" },
    }]);
    store.close();

    const deps: MobileEngineDeps = {
      openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "u",
    };
    await forgetMirror(deps, ownerKey);
    expect(await tablesUnder(world, ownerKey)).toEqual([]);

    // THE LATE SETTLE. It must refuse, loudly — a write that vanished quietly would be the same
    // lie one layer down — and it must not put the database back.
    await expect(store.applyChanges([{
      type: "message", op: "create", id: "m2", seq: 2, updatedAt: "2026-08-19T08:00:00Z",
      entity: { id: "m2", accountId: "acct-1", subject: "after the forget" },
    }])).rejects.toThrow(/was closed/);
    expect(await tablesUnder(world, ownerKey),
      "a late mutation recreated the mirror after a clean forget").toEqual([]);
  });

  it("a keystore value that survives in UNREADABLE form still refuses the removal", async () => {
    // `readProfile` maps "absent" and "present but unreadable" to the same null, so a malformed
    // value surviving a refused remove read as an empty keystore — and the id then left the
    // index, which is the only durable name those credential-bearing bytes had. Whether the
    // value parses is not the question a removal asks.
    const { kv, map } = memoryKV();
    const profiles = new ServerProfileStore(kv);
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    map.set(`ohmail.servers.v1.${row.id}`, "{not json");
    const stubborn: SecureKV = { ...kv, remove: async (k) => { if (k !== `ohmail.servers.v1.${row.id}`) map.delete(k); } };
    const held = new ServerProfileStore(stubborn);

    await expect(held.remove(row.id)).rejects.toThrow(/refused to forget/);
    // The id is still in the index, which is what any later purge walks.
    expect((await held.pendingWipes()).length).toBe(0);
    expect(map.has(`ohmail.servers.v1.${row.id}`)).toBe(true);
    const idx = JSON.parse(map.get("ohmail.servers.v1")!) as { ids: string[] };
    expect(idx.ids, "the only durable name must survive a refused removal").toContain(row.id);
  });

  it("a STALE debt is refused: a clear that did not store cannot outlive its forget", async () => {
    // The nastier half of the same rule. A `clearPendingWipe` that resolved without storing
    // leaves a debt against an owner whose mirror is already gone — the forget reports success,
    // the person re-pairs the same server, and the next launch's drain collects the old debt
    // against the NEW mirror and deletes the mailbox they had just re-authorized. A debt
    // outliving its purpose is worse than one never written.
    const map = new Map<string, string>();
    let swallowClears = false;
    const kv: SecureKV = {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => {
        // The clear is an index write whose `wipes` shrank; swallow exactly those.
        if (swallowClears && k === "ohmail.servers.v1") {
          const held = map.get(k);
          const before = held === undefined ? 0 : (JSON.parse(held).wipes ?? []).length;
          const after = (JSON.parse(v).wipes ?? []).length;
          if (after < before) return;
        }
        map.set(k, v);
      },
      remove: async (k) => void map.delete(k),
    };
    const { env, profiles } = testEnv({}, kv);
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const ownerKey = mirrorOwnerKey(row.origin, row.accountId);

    swallowClears = true;
    const outcome = await forgetProfile(env, row.id, { revoke: async () => true });
    expect(outcome.kind, "a debt that survives its own clear is not a completed forget").toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(sayRefusal(outcome.reason)).toMatch(/could not be deleted/);
    // The debt is still recorded, which is what a later launch retries — the honest state.
    expect((await profiles.pendingWipes()).map((w) => w.owner)).toEqual([ownerKey]);
  });

  it("a kill before the logout leaves a token the LAUNCH can still spend", async () => {
    // The credential used to be removed before the server was told, which opened a window whose
    // damage was permanent: a kill in it left the drain with no token to revoke with, so it
    // cleared the debt on the local halves alone and the server kept counting the phone as
    // connected — with its push row still live on a shared endpoint. Revoking first means a kill
    // before it leaves the profile standing and OWED, which is non-bootable and still spendable.
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.mintPairToken("tok-1");
      const { env, world, profiles } = testEnv();
      const session = await pairedWithMail(env, origin, "tok-1").catch(async () => {
        // one message is enough here; `pairedWithMail` expects two
        return null;
      });
      void session;
      const row = (await profiles.list())[0]!;
      const ownerKey = mirrorOwnerKey(row.origin, row.accountId);

      // THE KILL: the intent is durable and nothing else has run.
      await profiles.markPendingWipe(row.id, ownerKey);
      const before = fake.seen.filter((r) => r.url === "/auth/logout").length;

      expect(await drainPendingWipes(env)).toEqual([]);
      const after = fake.seen.filter((r) => r.url === "/auth/logout").length;
      expect(after, "the launch must spend the token while it still exists").toBeGreaterThan(before);
      expect(await profiles.list()).toEqual([]);
      expect(await tablesUnder(world, ownerKey)).toEqual([]);
    } finally {
      fake.server.close();
    }
  });

  it("a pairing the server already refused is NOT a confirmed revocation", async () => {
    // The token is null because the server killed the family — a reuse judgment or a Devices
    // revoke. That ends the sessions and nothing else: the push row is stamped with the device
    // and is pruned only by a logout or a Devices revoke, neither of which ran, so it stays live
    // on a shared endpoint this phone still answers. Reporting "told" over that was a completed
    // forget claimed on the strength of having nothing left to ask with.
    const { env, profiles } = testEnv();
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    await profiles.clearRefreshToken(row.id, new Set(["ref-1"]));
    const dead = (await profiles.list())[0]!;
    expect(dead.refreshToken).toBeNull();
    expect(await revokeProfile(env, dead)).toBe(false);

    const outcome = await forgetProfile(env, row.id);
    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") return;
    expect(sayRefusal(outcome.reason)).toMatch(/could not be reached/);
    expect(sayRefusal(outcome.reason)).toMatch(/Devices list/);
  });

  it("a kill mid-`add` cannot leave a credential the purge can never name", async () => {
    // The profile VALUE used to be written before the index learned its id, so a kill between
    // them left `ohmail.servers.v1.<id>` holding a live refresh token with `<id>` in no list.
    // The fresh-install purge walks the list, so it never even asked for that key, removed the
    // index and stamped the install as purged: "every key was read back" is vacuous for a key
    // it cannot name. Reversed, the same kill over-names instead, which every reader handles.
    // THE KILL IS COUNTED, NOT NAMED. An earlier version of this test threw on any key that was
    // not the index, which made it VACUOUS under its own mutation: with the writes reversed the
    // very first write threw, nothing landed at all, and every assertion below still passed.
    // Killing after the FIRST write, whichever key that is, is the actual crash being modelled —
    // and it is what tells the two orders apart.
    const map = new Map<string, string>();
    let writes = 0;
    let arm = false;
    const kv: SecureKV = {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => {
        if (arm && ++writes > 1) throw new Error("killed mid-add");
        map.set(k, v);
      },
      remove: async (k) => void map.delete(k),
    };
    const { env, profiles } = testEnv({}, kv);

    arm = true;
    await expect(profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-ORPHAN",
    })).rejects.toThrow(/killed mid-add/);

    // NOTHING with a credential in it was written — the index moved first, so the only residue
    // is a name, and the value never landed.
    expect([...map.values()].some((v) => v.includes("ref-ORPHAN"))).toBe(false);
    // The over-named entry is invisible to every reader…
    expect(await profiles.list()).toEqual([]);
    expect(await profiles.active()).toBeNull();
    // …and the purge NAMES it, which is the property that makes its read-back non-vacuous.
    const verdict = await settleInstallGeneration(env.engineDeps, profiles);
    expect(verdict.kind).toBe("fresh-install");
    expect(map.has("ohmail.servers.v1")).toBe(false);
  });

  it("a wipe entry in an older, id-less shape is read and drained, never thrown on", async () => {
    // Tolerance, not a migration: nothing has shipped. The point is the rule the index already
    // lives under — an unreadable index loses the LIST, never the app — applied to a member
    // shape a future build might not recognise. A bare owner key reads as "mail only".
    const { kv, map } = memoryKV();
    const { env, world, profiles } = testEnv({}, kv);
    const ownerKey = mirrorOwnerKey("http://a.example", "acct-1");
    const store = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: 1, updatedAt: "2026-08-19T08:00:00Z",
      entity: { id: "m1", accountId: "acct-1", subject: "still here" },
    }]);
    store.close();

    map.set("ohmail.servers.v1", JSON.stringify({
      active: null, ids: [], wipes: [ownerKey, 42, null, { owner: "" }, { id: "x" }],
    }));
    // The malformed members are dropped, the legacy string survives as an id-less entry.
    expect(await profiles.pendingWipes()).toEqual([{ id: "", owner: ownerKey }]);
    expect(await drainPendingWipes(env)).toEqual([]);
    expect(await tablesUnder(world, ownerKey)).toEqual([]);
  });
});

/**
 * The claims this change set makes to a person, held against what the code can actually do.
 * Source and copy censuses, because this app's suite drives modules rather than rendering them —
 * the same shape `privacy.test.ts` established here.
 */
describe("the claims, held to the code", () => {
  it("the copy does NOT say deleting the app removes the pairing, and names the real remedy", () => {
    // On iOS the Keychain item survives an app delete and no code of ours runs at that moment:
    // the credential is genuinely still there until the NEXT launch's purge discards it. The
    // sentence said "deleting the app removes both", which is a claim about an instant at which
    // nothing we wrote can act — so it now says what actually happens, and points at the
    // server-side revoke, which is the remedy that works immediately and from anywhere.
    expect(Copy.aboutOnDevice).not.toMatch(/app removes both/i);
    expect(Copy.aboutOnDevice).toMatch(/until ohmail is opened again/i);
    expect(Copy.aboutOnDevice).toMatch(/Devices list/);
    // …and it still tells the truth about the pairing, which is the other half. What the MAIL
    // does is no longer a sentence here: `Copy.aboutOnDeviceBackup` derives it from what the
    // device measured, and `backup-exclusion.test.ts` holds that pair.
    expect(Copy.aboutOnDevice).toMatch(/never included in a backup/i);
    expect(Copy.aboutOnDevice).not.toMatch(/On Android it is excluded/);
  });

  it("turning wakes off has a sentence for a server that KEPT the row", () => {
    expect(Copy.wakeRowRemains).toMatch(/would not remove the registration/i);
    expect(Copy.wakeRowRemains).toMatch(/Devices list/);
    // And it does not claim a removal, which is what the hint beside it does.
    expect(Copy.wakeDistributorNoneHint).toMatch(/removes the registration/i);
    expect(Copy.wakeRowRemains).not.toMatch(/\bremoved\b/i);
  });

  it("a superseded registration takes its own row down before discarding the id", () => {
    // Structural, and it has to be: the defect is a race inside a React effect between a
    // fifteen-second POST and a profile switch, and no module-level call can observe it. What
    // CAN be observed is that the discard arm spends the id it is about to throw away.
    const wake = read("../src/state/wake.tsx");
    const superseded = /if \(!fresh\(\)\) \{([\s\S]*?)\n      \}/.exec(wake)?.[1] ?? "";
    expect(superseded, "the superseded arm must exist").not.toBe("");
    // `owedDrop`, not the bare `dropWakeRow`: round 2 found that firing the delete and
    // discarding its verdict left a refused removal with nothing to retry it, so the arm now
    // goes through the seam that writes the debt down. Two cases pin that behaviour directly.
    expect(superseded).toContain("owedDrop(session, next.id)");
    expect(superseded).toContain('next.k === "on"');
  });

  it("the pane does not print \"removes the registration\" beside \"the row remains\"", () => {
    // Two claims about the same act, on the same screen, saying opposite things. The hint is a
    // CLAIM about what turning wakes off does; `row_remains` is the state saying that is exactly
    // what did not happen. Whichever is right, both cannot be shown.
    const settings = read("../app/settings.tsx");
    expect(settings).toMatch(/wake\.state\.k === "off" && wake\.state\.reason === "row_remains"/);
    const hintAt = settings.indexOf("Copy.wakeDistributorNoneHint");
    const guardAt = settings.indexOf('wake.state.reason === "row_remains"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(hintAt, "the guard must sit in front of the hint").toBeGreaterThan(guardAt);
  });

  it("the forget failure is held by the SCREEN, not by the row it removes", () => {
    // A partial forget removes the credential first, so the row is gone from `conn.profiles`
    // before the outcome arrives: a `useState` in `ProfileRow` was a setState into a tree that
    // no longer existed, and the only notice that mail was still on the phone was thrown away.
    const screen = read("../app/servers.tsx");
    // From `ProfileRow`'s declaration to the next top-level one — or to the end of the file when
    // it is the last, which it now is. A brace-counting reader here would be a parser nobody
    // asked for. The bound used to be REQUIRED to find a following function, because slicing to
    // end-of-file would have swept in `AddPanel`, which legitimately held its own state; that
    // component is gone (the door chooser it duplicated lives in `src/ui/Doors.tsx` now), so the
    // hazard the bound existed for is gone with it and an absent bound is no longer a failure.
    // A component added below ProfileRow later re-arms the tighter bound automatically.
    const from = screen.indexOf("function ProfileRow(");
    const next = screen.indexOf("\nfunction ", from + 1);
    expect(from).toBeGreaterThan(-1);
    const row = screen.slice(from, next === -1 ? screen.length : next);
    expect(row, "the row component must exist").not.toBe("");
    expect(row, "the row may not hold the failure it is about to be removed by")
      .not.toMatch(/useState<string \| null>/);
    expect(row).toContain("onForgetFailed(outcome.reason)");
    // …and the screen renders it, above the list, where it survives the removal.
    expect(screen).toMatch(/export default function ServersScreen[\s\S]*?useState<Refusal \| null>\(null\)/);
    expect(screen).toContain("Copy.serversForgetFailed(sayRefusal(forgetFailure))");
  });
});

describe("the install generation — deleting the app is a take-back on iOS too", () => {
  it("a container with no marker purges every pairing the keystore outlived, then stamps", async () => {
    const { env, world, profiles } = testEnv();
    await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    await profiles.add({
      origin: "http://b.example", flavor: "selfhost", accountId: "acct-2", refreshToken: "ref-2",
    });
    expect(await profiles.list()).toHaveLength(2);

    const first = await settleInstallGeneration(env.engineDeps, profiles);
    expect(first.kind).toBe("fresh-install");
    // THE ABSENCE, at the keystore: the reinstall opens on nothing, and `active()` — the value
    // the launch effect reads and immediately connects — is null.
    expect(await profiles.list()).toEqual([]);
    expect(await profiles.active()).toBeNull();
    expect(world.names()).toContain(INSTALL_MARKER_DB);

    // The SECOND launch is the same install: a pairing made now must survive it.
    await profiles.add({
      origin: "http://c.example", flavor: "selfhost", accountId: "acct-3", refreshToken: "ref-3",
    });
    const second = await settleInstallGeneration(env.engineDeps, profiles);
    expect(second.kind).toBe("same-install");
    if (second.kind !== "same-install") return;
    if (first.kind === "fresh-install") expect(second.generation).toBe(first.generation);
    expect((await profiles.list()).map((p) => p.origin)).toEqual(["http://c.example"]);

    // And the uninstall: the container goes, the keystore does not. The marker's absence is the
    // only evidence, and it is enough.
    await world.drop(INSTALL_MARKER_DB);
    expect((await settleInstallGeneration(env.engineDeps, profiles)).kind).toBe("fresh-install");
    expect(await profiles.list()).toEqual([]);
  });

  it("the first launch after an UPDATE keeps every pairing, because the mirrors are still here", async () => {
    // The marker cannot exist before the build that writes it, so its absence on that launch is
    // indistinguishable from a reinstall — and this used to purge, costing every existing user
    // their pairings for an update they did not ask anything of. The evidence was already on the
    // device: a reinstall's container has no MIRRORS, an update's has one per synced server.
    const { env, world, profiles } = testEnv();
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    // The pairing has synced at some point, so its mirror is on disk.
    const store = new SqlMirrorStore({ owner: mirrorOwnerKey(row.origin, row.accountId), open: world.open });
    await store.load();
    store.close();

    const hasMirror = (p: { origin: string; accountId: string }) =>
      mirrorExists(env.engineDeps, mirrorOwnerKey(p.origin, p.accountId));
    const verdict = await settleInstallGeneration(env.engineDeps, profiles, hasMirror);
    expect(verdict.kind).toBe("upgrade");
    expect((await profiles.list()).map((p) => p.id)).toEqual([row.id]);
    // …and the marker was stamped, so the launch after it is an ordinary one.
    expect((await settleInstallGeneration(env.engineDeps, profiles, hasMirror)).kind).toBe("same-install");
  });

  it("a REINSTALL still purges, because no mirror can survive the container", async () => {
    const { env, world, profiles } = testEnv();
    const row = await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const ownerKey = mirrorOwnerKey(row.origin, row.accountId);
    const store = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await store.load();
    store.close();

    // THE UNINSTALL: the container goes — marker and mirrors together — and the keychain does not.
    await world.drop(INSTALL_MARKER_DB);
    await world.drop(mirrorDbName(ownerKey));

    const verdict = await settleInstallGeneration(
      env.engineDeps, profiles,
      (p) => mirrorExists(env.engineDeps, mirrorOwnerKey(p.origin, p.accountId)),
    );
    expect(verdict.kind).toBe("fresh-install");
    expect(await profiles.list()).toEqual([]);
    // The sentinel probe cleaned up after itself: opening a name creates it, and a stub left
    // behind would make the NEXT launch read it as a mirror and never purge again.
    expect(world.names()).not.toContain(mirrorDbName(ownerKey));
  });

  it("a marker store that will not open leaves the pairings ALONE — unknown is never fresh", async () => {
    // The dangerous direction is the other one: reading a transient sqlite failure as a fresh
    // install would delete every pairing on the phone for a reason that has nothing to do with
    // the user. A genuine reinstall has a working sqlite by definition — the app just launched.
    const { kv } = memoryKV();
    const profiles = new ServerProfileStore(kv);
    await profiles.add({
      origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1",
    });
    const broken: MobileEngineDeps = {
      openExecutor: () => { throw new Error("sqlite is dead"); },
      deleteDatabase: async () => undefined,
      uuid: () => "u",
    };
    const verdict = await settleInstallGeneration(broken, profiles);
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind !== "unknown") return;
    expect(sayRefusal(verdict.reason)).toMatch(/sqlite is dead/);
    expect(await profiles.list()).toHaveLength(1);
  });

  it("READING THE GENERATION GIVES ITS HANDLE BACK, so a third Connect still dials", async () => {
    /**
     * ══ DEVICE RUN 4 ════════════════════════════════════════════════════════════════════════
     *
     * `installGeneration` runs on EVERY Connect press — the door screen reads this install's id
     * and hands it to the engine — and it opened the marker store without ever closing it, while
     * `settleInstallGeneration` beside it closes in a `finally`. Measured on the device: after
     * two Connects the third found the store unopenable, the read answered `null`, the screen
     * passed the empty string on, and the engine refused the launch by name (`installId is
     * required`) WITHOUT DIALLING — the fourth door gone for the rest of the run of the app.
     *
     * The host here fails the way that platform fails: a ceiling on LIVE handles, not on opens.
     * A reader that gives its handle back never reaches the ceiling, however many times it runs.
     */
    const { env, profiles } = testEnv();
    await settleInstallGeneration(env.engineDeps, profiles);

    let live = 0;
    let opened = 0;
    const ceilinged = {
      openExecutor: async (name: string) => {
        /* THE CEILING IS ON LIVE HANDLES. Two at once is what the device tolerated. */
        if (live >= 2) throw new Error("too many open databases");
        opened += 1;
        live += 1;
        const db = await env.engineDeps.openExecutor(name);
        return {
          all: db.all.bind(db),
          batch: db.batch.bind(db),
          close: () => { live -= 1; },
        };
      },
      uuid: env.engineDeps.uuid,
    };

    /* THREE PRESSES — the device's own sequence, and the third is the one that was refused. */
    const first = await installGeneration(ceilinged);
    const second = await installGeneration(ceilinged);
    const third = await installGeneration(ceilinged);
    expect(opened, "the reads did not reach the store at all").toBe(3);
    expect(first, "the marker was not readable even once").not.toBeNull();
    expect(second).toBe(first);
    /* THE WHOLE CELL. `null` here is the empty install id the screen passed on, and the launch
       the engine then refused without dialling. */
    expect(third, "the third press could not read the install id, so it would never dial")
      .toBe(first);
    expect(live, "a handle was left open behind every read").toBe(0);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A FORGET TAKES DOWN ITS OWN WAKE REGISTRATION — the seam review's third finding
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The sequence it named: register wakes for A, switch to B, forget A while keeping B. `forget`
 * runs `forgetProfile`, whose step 4 `logout` prunes the SERVER's `push_subscriptions` row — and
 * nothing took down the DISTRIBUTOR end. `wake.tsx` sweeps only when the LAST pairing goes
 * (the distributor CHOICE is app-wide) and `forgetWake` is reached only by turning wakes off
 * explicitly, so A's registration survived a successful forget indefinitely.
 *
 * It became a real orphan in the same slice that made registrations per-pairing: before that
 * there was ONE registration and B was using it, so "leaving it" was correct. The fix and its
 * cause are the same change, which is why the control lives here rather than in a follow-up.
 */
describe("forgetting a pairing unregisters the pairing's own wake instance", () => {
  function connector() {
    const dropped: string[] = [];
    return { dropped, port: { unregister: async (instance: string) => { dropped.push(instance); } } };
  }

  it("drops EXACTLY its own instance, and a second pairing's survives", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "One");
      fake.addMessage("m2", "Two");
      fake.mintPairToken("tok-1");
      const c = connector();
      const { env } = testEnv();
      const withConnector: PairingEnv = { ...env, distributor: c.port };

      const session = await pairedWithMail(withConnector, origin, "tok-1");
      const row = (await env.profiles.list())[0]!;
      expect(c.dropped, "nothing is unregistered by pairing").toEqual([]);

      const outcome = await forgetProfile(withConnector, row.id, {
        closed: Promise.resolve(session.store.close()),
      });
      expect(outcome.kind).toBe("forgotten");
      // THE INSTANCE IS THE PROFILE'S OWN ID — the same value `registerWake` hands the connector.
      expect(c.dropped).toEqual([row.id]);
      // …and it is exactly one, so a forget cannot have swept a sibling's registration with it.
      expect(c.dropped).toHaveLength(1);
    } finally {
      fake.server.close();
    }
  });

  it("a composition with NO connector forgets exactly as before — the port is optional", async () => {
    // The positive control on the ordinary case, and on every existing case in this file: the
    // port is absent by default (`net/pairing.ts` must not reach a native module under node), and
    // its absence may not change what a forget does.
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "One");
      fake.addMessage("m2", "Two");
      fake.mintPairToken("tok-1");
      const { env } = testEnv();
      const session = await pairedWithMail(env, origin, "tok-1");
      const row = (await env.profiles.list())[0]!;
      const outcome = await forgetProfile(env, row.id, {
        closed: Promise.resolve(session.store.close()),
      });
      expect(outcome.kind).toBe("forgotten");
      expect(await env.profiles.list()).toHaveLength(0);
    } finally {
      fake.server.close();
    }
  });
});

/**
 * ── THE MAILBOX ON THIS PHONE: "STOP AND REMOVE" HAS TO REACH THE ENGINE'S OWN STORE ────────
 *
 * The take-back above is a PAIRING's: a credential, a mirror, a server session. A standalone
 * install has a fourth store nothing in it named — `ohmail-engine.db`, the engine's authority,
 * holding the account, the mailbox row, the mail and the password sealed under the keystore's
 * key ring. Removal deleted the mirror and left all of it, so connecting a DIFFERENT mailbox
 * afterwards booted an engine over the survivor: `ensureLocalWorld` found the existing account,
 * the roster attached the removed mailbox beside the new one, and a person who had removed a
 * mailbox read its mail under the next one's session.
 *
 * Every assertion here is an absence at a REAL store — a file on a real directory, so a delete
 * is a delete and the next open of that name is a new, empty database.
 */
describe("removing the mailbox on this phone removes its mail, its key and its identity", () => {
  const ACCOUNT_A = "acct-on-this-phone";
  const ENGINE_TABLES = ["accounts", "mailbox_credentials", "mailboxes", "messages"];

  /** A standalone install with a mailbox in it: the engine store's four load-bearing tables. */
  async function standaloneInstall() {
    const engine = engineStoreWorld();
    const { kv, map } = memoryKV();
    map.set(KEK_KEY, "a".repeat(64));
    const profiles = new ServerProfileStore(kv);
    const row = await profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: ACCOUNT_A,
    });

    /* A's rows, written through the same handle the engine writes through. The sealed credential
       is a LITERAL that is not a password — the store's shape is what is under test, never a
       secret, and nothing in this file may print one. */
    const store = await engine.open(ENGINE_DB_FILE);
    for (const sql of [
      "CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT)",
      "CREATE TABLE mailboxes (id TEXT PRIMARY KEY, account_id TEXT, address TEXT)",
      "CREATE TABLE mailbox_credentials (mailbox_id TEXT PRIMARY KEY, transport TEXT, sealed TEXT)",
      "CREATE TABLE messages (id TEXT PRIMARY KEY, mailbox_id TEXT, subject TEXT)",
      `INSERT INTO accounts VALUES ('${ACCOUNT_A}', 'This phone')`,
      `INSERT INTO mailboxes VALUES ('mbx-a', '${ACCOUNT_A}', 'a@example.test')`,
      "INSERT INTO mailbox_credentials VALUES ('mbx-a', 'imap', 'sealed-envelope-not-a-password')",
      "INSERT INTO messages VALUES ('msg-a', 'mbx-a', 'One')",
    ]) {
      const statement = await store.prepareAsync(sql);
      await statement.executeAsync([]);
      await statement.finalizeAsync();
    }
    await store.closeAsync();

    const world = sqlWorld();
    const engineDeps: MobileEngineDeps = {
      openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000",
    };
    const env: PairingEnv = {
      profiles,
      engineDeps,
      standalone: {
        door: () => null,
        reopen: async () => ({ ok: false, reason: refuse("standaloneNoEngine") }),
        removeEngine: () => removeStandaloneEngine({
          openDatabase: engine.open, deleteDatabase: engine.drop, kv,
        }),
        /* NOT DRIVEN HERE, and loud rather than silent: `standDownAway` is only reached when
           `door()` is non-null and these doubles answer null, so a case that somehow stood the
           mailbox down would be a case measuring something this file does not drive. */
        standDownAway: async () => { throw new Error("a switch stood the mailbox down in a forget case"); },
      },
    };
    return { env, engine, kv, map, profiles, row, world };
  }

  it("deletes the engine STORE — a later mailbox does not find A's account, rows or mail", async () => {
    const world = await standaloneInstall();
    try {
      expect(world.engine.tables(ENGINE_DB_FILE), "the install starts with A's mailbox in it")
        .toEqual(ENGINE_TABLES);

      const outcome = await forgetProfile(world.env, world.row.id);
      expect(outcome.kind).toBe("forgotten");

      /* THE MAIL, THE MAILBOX ROW, THE ACCOUNT AND THE SEALED CREDENTIAL — all four are the
         store, and the store is the file. A survivor here is the finding: the next standalone
         mailbox's bootstrap reuses this account and attaches the removed mailbox beside it. */
      expect(world.engine.tables(ENGINE_DB_FILE), "the engine store survived the removal")
        .toEqual([]);
    } finally {
      world.engine.cleanup();
    }
  });

  it("deletes the sealed credential's KEY — an erasure that leaves it is the finding", async () => {
    const world = await standaloneInstall();
    try {
      expect(world.map.get(KEK_KEY), "the install starts with a key ring").toBeDefined();
      expect((await forgetProfile(world.env, world.row.id)).kind).toBe("forgotten");
      expect(world.map.get(KEK_KEY), "the credential key survived the removal").toBeUndefined();
    } finally {
      world.engine.cleanup();
    }
  });

  it("deletes the IDENTITY record — the row naming this phone's own mailbox", async () => {
    const world = await standaloneInstall();
    try {
      expect((await forgetProfile(world.env, world.row.id)).kind).toBe("forgotten");
      expect(await world.env.profiles.list()).toHaveLength(0);
    } finally {
      world.engine.cleanup();
    }
  });
});

/**
 * ── THE BELT: A REMOVAL THAT DID NOT FINISH STILL REFUSES, AND FINISHES ─────────────────────
 *
 * The sequence above is durable in one direction only — a kill between the record and the last
 * deletion leaves a store holding the removed mailbox. `openLocalEnginePlatform` is the ONE gate
 * in front of that store (the door press and the relaunch both arrive there), so the record is
 * read before anything is opened: the deletions are finished and the launch is refused by name.
 */
describe("an interrupted removal refuses on the next launch and finishes the deletion", () => {
  const ACCOUNT_A = "acct-on-this-phone";

  /** A store with A's four tables in it, and the key ring that opens its sealed credential. */
  async function interrupted() {
    const engine = engineStoreWorld();
    const { kv, map } = memoryKV();
    map.set(KEK_KEY, "a".repeat(64));
    const profiles = new ServerProfileStore(kv);
    const store = await engine.open(ENGINE_DB_FILE);
    for (const table of ENGINE_STORE_TABLES) {
      const statement = await store.prepareAsync(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
      await statement.executeAsync([]);
      await statement.finalizeAsync();
    }
    await store.closeAsync();
    /* THE KILL: the record is written and nothing after it ran. */
    await profiles.markEngineRemoval(ACCOUNT_A);
    return { engine, kv, map, profiles };
  }

  const platform = (w: Awaited<ReturnType<typeof interrupted>>) => openLocalEnginePlatform({
    openDatabase: w.engine.open,
    deleteDatabase: w.engine.drop,
    kv: w.kv,
    randomKekHex: () => "b".repeat(64),
    removal: { recorded: () => w.profiles.engineRemoval(), clear: () => w.profiles.clearEngineRemoval() },
  });

  it("refuses the launch BY NAME rather than attaching the removed mailbox", async () => {
    const w = await interrupted();
    try {
      const outcome = await platform(w);
      expect(outcome.kind).toBe("refused");
      expect(outcome.kind === "refused" ? outcome.reason.say : null).toBe("standaloneMailboxRemoved");
      /* RENDERED — a refusal nobody can read is the same dead end as no refusal. */
      expect(sayRefusal(outcome.kind === "refused" ? outcome.reason : refuse("standaloneNoEngine")))
        .toContain("removed");
    } finally { w.engine.cleanup(); }
  });

  it("FINISHES it — the store and the key are gone, and the record with them", async () => {
    const w = await interrupted();
    try {
      await platform(w);
      expect(w.engine.tables(ENGINE_DB_FILE), "the store survived the belt").toEqual([]);
      expect(w.map.get(KEK_KEY), "the key survived the belt").toBeUndefined();
      // Cleared LAST, and only once both read back absent — else it would refuse for ever.
      expect(await w.profiles.engineRemoval()).toBeNull();
    } finally { w.engine.cleanup(); }
  });

  it("KEEPS the record when the deletion still cannot land, and refuses for that reason", async () => {
    const w = await interrupted();
    try {
      /* A deleter that resolves and deletes nothing — the failure the read-back exists for, and
         the one a test asserting "the deleter was called" would pass over. */
      const outcome = await openLocalEnginePlatform({
        openDatabase: w.engine.open,
        deleteDatabase: async () => undefined,
        kv: w.kv,
        randomKekHex: () => "b".repeat(64),
        removal: { recorded: () => w.profiles.engineRemoval(), clear: () => w.profiles.clearEngineRemoval() },
      });
      expect(outcome.kind === "refused" ? outcome.reason.say : null).toBe("standaloneRemovalUnfinished");
      // STILL OWED: the next launch tries again rather than opening over the survivor.
      expect(await w.profiles.engineRemoval()).toBe(ACCOUNT_A);
      expect(w.engine.tables(ENGINE_DB_FILE)).toEqual(ENGINE_STORE_TABLES);
    } finally { w.engine.cleanup(); }
  });

  it("the ordinary launch is untouched — no record, a store and a key ring (the positive control)", async () => {
    const w = await interrupted();
    try {
      await w.profiles.clearEngineRemoval();
      const outcome = await platform(w);
      expect(outcome.kind, "a launch with no removal recorded must open").toBe("ready");
      if (outcome.kind !== "ready") return;
      expect(outcome.keks).toEqual({ 1: "a".repeat(64) });
      await outcome.exec.close();
      // And it opened rather than deleted: the store the person's mailbox lives in is still here.
      expect(w.engine.tables(ENGINE_DB_FILE)).toEqual(ENGINE_STORE_TABLES);
    } finally { w.engine.cleanup(); }
  });
});

/**
 * ── THE FINDING'S OWN SEQUENCE, END TO END, AND THE SCOPE AROUND IT ─────────────────────────
 *
 * Remove mailbox A on the phone, connect mailbox B: B's session holds no message, folder,
 * credential or identity of A. The cases above measure each store; these two measure the act the
 * person performed, and the mailbox beside it that must not move.
 */
describe("remove A, connect B — and the mailbox beside it is untouched", () => {
  it("B's session finds an empty store: no account, no mailbox row, no credential, no mail of A", async () => {
    const engine = engineStoreWorld();
    const { kv, map } = memoryKV();
    map.set(KEK_KEY, "a".repeat(64));
    const profiles = new ServerProfileStore(kv);
    try {
      const store = await engine.open(ENGINE_DB_FILE);
      for (const sql of [
        "CREATE TABLE accounts (id TEXT PRIMARY KEY)",
        "CREATE TABLE mailboxes (id TEXT PRIMARY KEY, account_id TEXT)",
        "CREATE TABLE mailbox_credentials (mailbox_id TEXT PRIMARY KEY)",
        "CREATE TABLE messages (id TEXT PRIMARY KEY)",
        "INSERT INTO accounts VALUES ('acct-a')",
        "INSERT INTO mailboxes VALUES ('mbx-a', 'acct-a')",
        "INSERT INTO mailbox_credentials VALUES ('mbx-a')",
        "INSERT INTO messages VALUES ('msg-a')",
      ]) {
        const statement = await store.prepareAsync(sql);
        await statement.executeAsync([]);
        await statement.finalizeAsync();
      }
      await store.closeAsync();
      const row = await profiles.addStandalone({
        origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "acct-a",
      });
      const world = sqlWorld();
      const env: PairingEnv = {
        profiles,
        engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" },
        standalone: {
          door: () => null,
          reopen: async () => ({ ok: false, reason: refuse("standaloneNoEngine") }),
          removeEngine: () => removeStandaloneEngine({ openDatabase: engine.open, deleteDatabase: engine.drop, kv }),
          /* NOT DRIVEN HERE, and loud rather than silent: `standDownAway` is only reached when
             `door()` is non-null and these doubles answer null, so a case that somehow stood the
             mailbox down would be a case measuring something this file does not drive. */
          standDownAway: async () => { throw new Error("a switch stood the mailbox down in a forget case"); },
        },
      };

      expect((await forgetProfile(env, row.id)).kind).toBe("forgotten");

      /* ── NOW CONNECT B, through the one gate every standalone launch goes through ───────── */
      const opened = await openLocalEnginePlatform({
        openDatabase: engine.open,
        deleteDatabase: engine.drop,
        kv,
        randomKekHex: () => "b".repeat(64),
        removal: { recorded: () => profiles.engineRemoval(), clear: () => profiles.clearEngineRemoval() },
      });
      expect(opened.kind, "an ordinary connect after a finished removal must open").toBe("ready");
      if (opened.kind !== "ready") return;
      /* A NEW KEY RING. A's was deleted, so B's store is sealed under a key A's password was
         never sealed under — which is the second half of "the credential went too". */
      expect(opened.keks).toEqual({ 1: "b".repeat(64) });
      await opened.exec.close();
      /* AND THE STORE B IS HANDED IS EMPTY. This is the finding, stated as its absence: A's
         account is what `ensureLocalWorld` reused, and A's mailbox row is what the roster
         attached beside B's. */
      expect(engine.tables(ENGINE_DB_FILE)).toEqual([]);
    } finally { engine.cleanup(); }
  });

  it("forgetting a PAIRED server leaves this phone's own engine store and its key alone", async () => {
    /* SCOPE. The engine store belongs to the mailbox this phone opened itself; a pairing's
       forget has no business in it, and a removal that swept it would take a mailbox the person
       never pressed remove on. Driven through the real ceremony, not through a flag. */
    const engine = engineStoreWorld();
    const fake = pairServer({ accountId: "acct-1", flavor: "desktop-host", sessionRoute: false });
    const origin = await listen(fake.server);
    try {
      const store = await engine.open(ENGINE_DB_FILE);
      const statement = await store.prepareAsync("CREATE TABLE mailboxes (id TEXT PRIMARY KEY)");
      await statement.executeAsync([]);
      await statement.finalizeAsync();
      await store.closeAsync();

      const { kv, map } = memoryKV();
      map.set(KEK_KEY, "a".repeat(64));
      fake.addMessage("m1", "One");
      fake.addMessage("m2", "Two");
      fake.mintPairToken("tok-1");
      const { env, world } = testEnv({}, kv);
      env.standalone = {
        door: () => null,
        reopen: async () => ({ ok: false, reason: refuse("standaloneNoEngine") }),
        removeEngine: () => removeStandaloneEngine({ openDatabase: engine.open, deleteDatabase: engine.drop, kv }),
        /* NOT DRIVEN HERE, and loud rather than silent: `standDownAway` is only reached when
           `door()` is non-null and these doubles answer null, so a case that somehow stood the
           mailbox down would be a case measuring something this file does not drive. */
        standDownAway: async () => { throw new Error("a switch stood the mailbox down in a forget case"); },
      };
      const session = await pairedWithMail(env, origin, "tok-1");
      const row = (await env.profiles.list())[0]!;
      const outcome = await forgetProfile(env, row.id, { closed: Promise.resolve(session.store.close()) });

      expect(outcome.kind).toBe("forgotten");
      // The PAIRING's mirror went, as it always did.
      expect(await tablesUnder(world, mirrorOwnerKey(origin, "acct-1"))).toEqual([]);
      // And nothing of this phone's own mailbox moved.
      expect(engine.tables(ENGINE_DB_FILE), "a pairing's forget reached the engine store").toEqual(["mailboxes"]);
      expect(map.get(KEK_KEY), "a pairing's forget took the engine's key").toBe("a".repeat(64));
      expect(await env.profiles.engineRemoval(), "a pairing's forget recorded an engine removal").toBeNull();
    } finally {
      engine.cleanup();
      fake.server.close();
    }
  });
});

/**
 * THE DELETER AND THE OPENER MUST NAME ONE FILE — read off `local-engine-native.ts` as text.
 *
 * The suite never loads that module (expo packages are Flow-typed JavaScript its transform
 * refuses), and the hazard is invisible in every other reading: the MIRROR's opener and deleter
 * both wrap their argument in `dbFileName`, so a deleter here copied from that one would remove
 * `ohmail-engine.db.db` — a database nothing ever wrote to — and the removal would report itself
 * done over a mailbox still on the phone. The pair is asserted where the pair is written.
 */
describe("the engine store's opener and deleter name the same file", () => {
  it("neither wraps the name, and both default to ENGINE_DB_FILE", () => {
    const src = read("../src/engine/local-engine-native.ts");
    // The name bare, and the options `local-engine.ts` states forwarded whole (engine-store-executor.test.ts).
    expect(src).toContain("SQLite.openDatabaseAsync(name, options)");
    expect(src).toContain("SQLite.deleteDatabaseAsync(name)");
    /* THE CALL, not the word: this file's own docblock explains why the wrapper is wrong, and a
       needle that matches prose measures the prose. */
    expect(src).not.toMatch(/dbFileName\s*\(/u);
    // Both take the engine's own file as their default, so a bare call cannot reach a mirror.
    expect(src.match(/name: string = ENGINE_DB_FILE/gu) ?? []).toHaveLength(2);
  });
});

/**
 * ── THE RECORD IS WRITTEN BY THE CEREMONY, AND THE ORDER IS KEY-THEN-STORE ──────────────────
 *
 * The belt's cases above arm the record by hand, which measures the READER. These measure the
 * WRITER — that "Stop and remove" itself records the removal before it deletes anything, so a
 * failure part-way leaves the next launch something to refuse on — and the order it deletes in.
 */
describe("the removal records itself first, and takes the key before the store", () => {
  /** An install whose engine removal will fail, and at which store it fails. */
  async function failing(at: "key" | "store") {
    const engine = engineStoreWorld();
    const { kv, map } = memoryKV();
    map.set(KEK_KEY, "a".repeat(64));
    const store = await engine.open(ENGINE_DB_FILE);
    for (const table of ENGINE_STORE_TABLES) {
      const statement = await store.prepareAsync(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
      await statement.executeAsync([]);
      await statement.finalizeAsync();
    }
    await store.closeAsync();
    /* A KEYSTORE THAT ACCEPTS `remove` AND REMOVES NOTHING — the platform failure the read-back
       exists for, and the one a test asserting "remove was called" would pass over. */
    const held: SecureKV = at === "key"
      ? { get: kv.get, set: kv.set, remove: async () => undefined }
      : kv;
    const profiles = new ServerProfileStore(kv);
    const row = await profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "acct-a",
    });
    const world = sqlWorld();
    const env: PairingEnv = {
      profiles,
      engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" },
      standalone: {
        door: () => null,
        reopen: async () => ({ ok: false, reason: refuse("standaloneNoEngine") }),
        removeEngine: () => removeStandaloneEngine({
          openDatabase: engine.open,
          deleteDatabase: at === "store" ? async () => undefined : engine.drop,
          kv: held,
        }),
        /* NOT DRIVEN HERE, and loud rather than silent: `standDownAway` is only reached when
           `door()` is non-null and these doubles answer null, so a case that somehow stood the
           mailbox down would be a case measuring something this file does not drive. */
        standDownAway: async () => { throw new Error("a switch stood the mailbox down in a forget case"); },
      },
    };
    return { engine, kv, map, profiles, row, env };
  }

  it("a removal that cannot take the KEY stops there — the store is untouched and the record stands", async () => {
    const w = await failing("key");
    try {
      const outcome = await forgetProfile(w.env, w.row.id);
      /* PARTIAL, and it says the mail is still here. Reporting "forgotten" over this is the
         class of defect the whole take-back suite exists for. */
      expect(outcome.kind).toBe("partial");
      expect(outcome.kind === "partial" ? outcome.reason.say : null).toBe("forgetEngineRemains");
      /* KEY FIRST is the whole of this assertion: the store is still here because the sequence
         stopped at the key, and the person can press remove again. */
      expect(w.engine.tables(ENGINE_DB_FILE)).toEqual(ENGINE_STORE_TABLES);
      // Nothing below the engine ran: the identity row stays, so the launch refuses it.
      expect(await w.env.profiles.list()).toHaveLength(1);
      expect(await w.env.profiles.isOwedForget(w.row.id)).toBe(true);
      /* AND THE RECORD STANDS — the belt has something to refuse on and finish. */
      expect(await w.profiles.engineRemoval()).toBe("acct-a");
    } finally { w.engine.cleanup(); }
  });

  it("a removal that cannot take the STORE leaves the record too, and the key is already gone", async () => {
    const w = await failing("store");
    try {
      const outcome = await forgetProfile(w.env, w.row.id);
      expect(outcome.kind === "partial" ? outcome.reason.say : null).toBe("forgetEngineRemains");
      expect(w.engine.tables(ENGINE_DB_FILE)).toEqual(ENGINE_STORE_TABLES);
      /* THE OTHER HALF OF KEY-FIRST: what is left is a store nothing can open, never the key to
         mail that is still here. */
      expect(w.map.get(KEK_KEY)).toBeUndefined();
      expect(await w.profiles.engineRemoval()).toBe("acct-a");
    } finally { w.engine.cleanup(); }
  });

  it("the record carries an id and nothing else — never the address", async () => {
    const w = await failing("store");
    try {
      await forgetProfile(w.env, w.row.id);
      const recorded = await w.profiles.engineRemoval();
      /* A DURABLE NOTE OF WHICH MAILBOX SOMEBODY HAD is exactly what a removal exists to end.
         The account id is the identity the bootstrap would otherwise reuse; an address is not. */
      expect(recorded).toBe("acct-a");
      expect(recorded).not.toContain("@");
      // And nothing anywhere in the keystore's own values names one either.
      expect([...w.map.values()].join(" ")).not.toContain("@");
    } finally { w.engine.cleanup(); }
  });
});

/**
 * A FORGET THE SERVER DID NOT HEAR IS OWED, AND SENT AT THE NEXT CONNECTION. The refresh token is
 * kept apart from the profile, sent to the refresh door (never presented for a renewal) with the
 * pairing's own pin, and forgotten on the server's answer; the sentence says it will be told.
 */
describe("a sign-out the server did not hear is owed, and sent when it can be", () => {
  /** The transport every manager of `env` rides, with a switch for the network. */
  function switchable(): { fetchImpl: FetchLike; offline: (v: boolean) => void } {
    let down = false;
    return {
      fetchImpl: (url, init) => (down ? Promise.reject(new TypeError("Network request failed")) : fetch(url, init as RequestInit)),
      offline: (v) => { down = v; },
    };
  }
  const refresh = (origin: string, refreshToken: string) => fetch(`${origin}/auth/refresh`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }),
  });

  it("offline: the forget says so, and the drain behind the next launch ends the session at the refresh door", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const net = switchable();
      const { env, profiles } = testEnv();
      env.fetchImpl = net.fetchImpl;
      const session = await pairedWithMail(env, origin, "tok-1");
      const row = (await profiles.list())[0]!;
      net.offline(true);
      const outcome = await forgetProfile(env, row.id, { closed: Promise.resolve(session.store.close()) });
      expect(outcome).toEqual({ kind: "partial", reason: refuse("forgetServerOwed") });
      const owed = await profiles.pendingSignOuts();
      expect(owed.map((e) => [e.origin, e.pin])).toEqual([[origin, null]]);
      const token = owed[0]!.refreshToken;

      net.offline(false);
      const from = fake.seen.length;
      expect(await drainPendingSignOuts(env, { atLaunch: true }), "no key swap, so nothing holds the launch").toBe(1);
      expect(await drainPendingSignOuts(env, { atLaunch: false })).toBe(0);
      const told = fake.seen.slice(from).filter((r) => r.url.startsWith("/auth/"));
      expect(told.map((r) => [r.url, r.auth ?? null, JSON.parse(r.body)])).toEqual([
        ["/auth/refresh/logout", null, { refreshToken: token }],
      ]);
      expect(fake.seen.some((r) => r.url === "/auth/refresh"), "an owed sign-out was presented for a renewal").toBe(false);
      expect(await profiles.pendingSignOuts()).toEqual([]);
      expect((await refresh(origin, token)).status, "the session the forget left lives on").toBe(401);
    } finally {
      fake.server.close();
    }
  });

  it("a full list keeps nothing more, and the forget says the server was not told", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const net = switchable();
      const { env, profiles } = testEnv();
      env.fetchImpl = net.fetchImpl;
      const session = await pairedWithMail(env, origin, "tok-1");
      for (let i = 0; i < 8; i += 1) {
        await profiles.markPendingSignOut({ origin: "https://elsewhere.example", pin: null, refreshToken: `t${i}` });
      }
      net.offline(true);
      const row = (await profiles.list())[0]!;
      const outcome = await forgetProfile(env, row.id, { closed: Promise.resolve(session.store.close()) });
      expect(outcome).toEqual({ kind: "partial", reason: refuse("forgetServerUnreachable") });
      expect((await profiles.pendingSignOuts()).every((e) => e.origin !== origin)).toBe(true);
    } finally {
      fake.server.close();
    }
  });

  /** One owed sign-out to `https://a.example`, and a transport that answers `answer`. */
  async function owing(answer: () => Response | Promise<Response>, owedSince?: number) {
    const { kv, map } = memoryKV();
    const { env, profiles } = testEnv({}, kv);
    const sent: Array<{ url: string; body: unknown; auth: string | null }> = [];
    env.fetchImpl = async (url, init) => {
      const i = (init ?? {}) as { body?: string; headers?: Record<string, string> };
      sent.push({ url, body: i.body ? JSON.parse(i.body) : null, auth: i.headers?.authorization ?? null });
      return answer();
    };
    const entry = await profiles.markPendingSignOut({ origin: "https://a.example", pin: null, refreshToken: "owed-1" });
    if (owedSince !== undefined) {
      const key = `ohmail.servers.v1.signout.${entry.id}`;
      map.set(key, JSON.stringify({ ...JSON.parse(map.get(key)!), owedSince }));
    }
    return { env, profiles, sent };
  }

  it.each([
    ["the server's 503", () => new Response(null, { status: 503 }), 1],
    ["a page in front of the server", () => new Response("<!doctype html><title>Wi-Fi</title>", { status: 401 }), 1],
    ["the network", () => Promise.reject(new TypeError("Network request failed")), 1],
    ["the door's own refusal", () => new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }), 0],
    ["a server without the door (404)", () => new Response("not found", { status: 404 }), 0],
    ["the door's 204", () => new Response(null, { status: 204 }), 0],
  ] as const)("%s: kept or forgotten as the answer says", async (_name, answer, left) => {
    const o = await owing(answer);
    expect(await drainPendingSignOuts(o.env, { atLaunch: false })).toBe(left);
    expect(o.sent).toEqual([{ url: "https://a.example/auth/refresh/logout", body: { refreshToken: "owed-1" }, auth: null }]);
    expect((await o.profiles.pendingSignOuts()).length).toBe(left);
  });

  it("one older than thirty days is dropped unsent", async () => {
    const o = await owing(() => new Response(null, { status: 204 }), Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(await drainPendingSignOuts(o.env, { atLaunch: true })).toBe(0);
    expect(o.sent).toEqual([]);
    expect(await o.profiles.pendingSignOuts()).toEqual([]);
  });

  it("dials under the pairing's own key, and never over a live pairing's different key but at launch", async () => {
    const calls: string[] = [];
    installPinning({
      isInstalled: () => true, factoryUses: () => 1,
      setPin: (_h, _p, spki) => { calls.push(`pin ${spki}`); return 1; },
      clearPin: () => { calls.push("unpin"); return 1; },
      clearAllPins: () => 0, pinnedCount: () => 0,
    });
    try {
      const origin = "https://192.168.1.20:6245";
      const { env, profiles } = testEnv();
      env.fetchImpl = async (url) => { calls.push(`dial ${new URL(url).pathname}`); return new Response(null, { status: 204 }); };
      await profiles.add({ origin, flavor: "desktop-host", accountId: "acct-1", refreshToken: "live-1", pin: "KEY-NOW" });
      await profiles.markPendingSignOut({ origin, pin: "KEY-THEN", refreshToken: "owed-1" });
      expect(await drainPendingSignOuts(env, { atLaunch: false }), "the network's return swapped a live pairing's key").toBe(1);
      expect(calls).toEqual([]);
      expect(await drainPendingSignOuts(env, { atLaunch: true })).toBe(0);
      expect(calls).toEqual(["pin KEY-THEN", "dial /auth/refresh/logout", "pin KEY-NOW"]);

      calls.length = 0;
      await profiles.markPendingSignOut({ origin: "https://192.168.1.30:6245", pin: "KEY-GONE", refreshToken: "owed-2" });
      expect(await drainPendingSignOuts(env, { atLaunch: false })).toBe(0);
      expect(calls, "a key nothing pairs with was left behind").toEqual(["pin KEY-GONE", "dial /auth/refresh/logout", "unpin"]);
    } finally {
      installPinning(null);
    }
  });

  it("one the network never answers holds no launch: the active pairing connects at once, the drain behind it dials", async () => {
    const fake = pairServer({ accountId: "acct-1", flavor: "selfhost", sessionRoute: true });
    const origin = await listen(fake.server);
    installPinning({
      isInstalled: () => true, factoryUses: () => 1, setPin: () => 1, clearPin: () => 1, clearAllPins: () => 0, pinnedCount: () => 0,
    });
    const gone = "https://192.168.1.20:6245";
    /** The dials to the computer that is gone: never answered, failed only once given up. */
    const waiting: Array<() => void> = [];
    try {
      fake.addMessage("m1", "Welcome");
      fake.addMessage("m2", "Your invoice");
      fake.mintPairToken("tok-1");
      const { env, profiles } = testEnv();
      env.fetchImpl = (url, init) => (url.startsWith(gone)
        ? new Promise<Response>((_ok, fail) => {
          const drop = (): void => fail(new TypeError("Network request failed"));
          waiting.push(drop);
          (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", drop);
        })
        : fetch(url, init as RequestInit));
      (await pairedWithMail(env, origin, "tok-1")).store.close();
      await profiles.markPendingSignOut({ origin: gone, pin: "KEY-GONE", refreshToken: "owed-1" });

      // The launch's order (`connection.tsx`): the sign-outs, then the active pairing.
      const from = Date.now();
      await drainPendingSignOuts(env, { atLaunch: true });
      const behind = drainPendingSignOuts(env, { atLaunch: false });
      const relaunch = await connectProfileById(env, (await profiles.active())!.id);
      expect(Date.now() - from, "the mail waited on a sign-out nobody answers").toBeLessThan(2_000);
      if (relaunch.kind !== "connected") throw new Error(`the relaunch was refused: ${relaunch.kind}`);
      await relaunch.session.verifyIdentity();
      await relaunch.session.engine.start();
      expect(relaunch.session.engine.read().list("message")).toHaveLength(2);
      relaunch.session.store.close();
      await vi.waitFor(() => expect(waiting).toHaveLength(1));
      waiting[0]!();
      expect(await behind).toBe(1);
      expect((await profiles.pendingSignOuts()).map((e) => e.refreshToken)).toEqual(["owed-1"]);
    } finally {
      for (const drop of waiting) drop();
      installPinning(null);
      fake.server.close();
    }
  });

  it("one only a launch may send holds it two seconds at most, and so does a drain still dialing ahead of it", async () => {
    const calls: string[] = [];
    installPinning({
      isInstalled: () => true, factoryUses: () => 1,
      setPin: (_h, _p, spki) => { calls.push(`pin ${spki}`); return 1; },
      clearPin: () => { calls.push("unpin"); return 1; },
      clearAllPins: () => 0, pinnedCount: () => 0,
    });
    vi.useFakeTimers();
    try {
      const origin = "https://192.168.1.20:6245";
      const { env, profiles } = testEnv();
      env.fetchImpl = (url, init) => new Promise<Response>((_ok, fail) => {
        calls.push(`dial ${new URL(url).host}`);
        (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () => fail(new TypeError("Network request failed")));
      });
      await profiles.add({ origin, flavor: "desktop-host", accountId: "acct-1", refreshToken: "live-1", pin: "KEY-NOW" });
      await profiles.markPendingSignOut({ origin, pin: "KEY-THEN", refreshToken: "owed-1" });
      const watched = <T>(p: Promise<T>): { done: () => boolean; value: Promise<T> } => {
        let done = false;
        return { done: () => done, value: p.finally(() => { done = true; }) };
      };
      const launch = watched(drainPendingSignOuts(env, { atLaunch: true }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(launch.done(), "the launch waited past two seconds on a computer that does not answer").toBe(true);
      expect(await launch.value).toBe(1);
      expect(calls, "the live pairing's key is back before anything connects")
        .toEqual(["pin KEY-THEN", "dial 192.168.1.20:6245", "pin KEY-NOW"]);

      calls.length = 0;
      await profiles.markPendingSignOut({ origin: "https://192.168.1.30:6245", pin: "KEY-GONE", refreshToken: "owed-2" });
      const ahead = drainPendingSignOuts(env, { atLaunch: false });
      const next = watched(drainPendingSignOuts(env, { atLaunch: true }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(next.done(), "a drain dialing ahead of the launch held it").toBe(true);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await ahead).toBe(2);
      expect(await next.value).toBe(2);
      expect(calls, "the launch's drain dialed past its two seconds").toEqual(["pin KEY-GONE", "dial 192.168.1.30:6245", "unpin"]);
    } finally {
      vi.useRealTimers();
      installPinning(null);
    }
  });
});
