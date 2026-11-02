/**
 * THE SERVER-PROFILE STORE, and the isolation rule profiles exist under.
 *
 * Two suites. The first drives `ServerProfileStore` over a memory KV exactly as the app drives
 * it over expo-secure-store (same two-method seam): add/switch/forget, the re-pair-in-place
 * dedupe on (origin, accountId), the vault half the BearerManager persists rotations through,
 * and the keystore constraints (key charset, per-value size) that make secure-store a safe home.
 *
 * The second is the "Account isolation is absolute, and it binds staff too" invariant on the multi-profile phone: MULTIPLE PROFILES ARE MULTIPLE
 * ACCOUNTS, one mirror per (origin, account), and what stops mirror bleed between them is the
 * `__owner` stamp — proven here by (a) a profile switch reading ZERO of the other account's
 * rows, and (b) the stamp itself refusing a FOREIGN profile a read of the active mirror even
 * when the naming layer is deliberately collapsed. Weakening `mirrorOwnerKey` to ignore the
 * account, or dropping the stamp check, turns these red (watched, not assumed — see the
 * red-first record).
 */
import { describe, expect, it } from "vitest";
import { SqlMirrorStore, mirrorDbName } from "@ohmail/client-engine";
import { mirrorOwnerKey, type MobileEngineDeps } from "../src/engine/boot";
import { connectProfile, pairWithServer, type PairingEnv } from "../src/net/pairing";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { listen, pairServer, pairThroughConfirm, sqlWorld } from "./helpers/pair-server";

/** The keystore, inspectable: what is stored, under which keys, how large. */
function memoryKV() {
  const map = new Map<string, string>();
  const kv: SecureKV = {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
  return { kv, map };
}

const seed = { origin: "http://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1" };

describe("the profile store over the keystore seam", () => {
  it("add makes the profile active; list/active read it back; switch and forget move the index", async () => {
    const { kv } = memoryKV();
    const store = new ServerProfileStore(kv);
    expect(await store.active()).toBeNull();

    const a = await store.add(seed);
    const b = await store.add({ ...seed, origin: "http://b.example", accountId: "acct-2", refreshToken: "ref-b" });
    expect((await store.active())?.id).toBe(b.id); // the newest pairing is what the user just did
    expect((await store.list()).map((p) => p.origin)).toEqual(["http://a.example", "http://b.example"]);

    await store.setActive(a.id);
    expect((await store.active())?.id).toBe(a.id);
    await expect(store.setActive("nope")).rejects.toThrow(/no server profile/);

    await store.remove(a.id);
    expect((await store.list()).map((p) => p.id)).toEqual([b.id]);
    // Forgetting the ACTIVE profile clears the active slot rather than electing a survivor —
    // the user said "not this server", not "that other one instead".
    expect(await store.active()).toBeNull();
  });

  it("re-pairing the same (origin, account) UPDATES in place — same id, one row, fresh token", async () => {
    const { kv } = memoryKV();
    const store = new ServerProfileStore(kv);
    const first = await store.add(seed);
    const again = await store.add({ ...seed, flavor: "selfhost", refreshToken: "ref-2" });
    expect(again.id).toBe(first.id);
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refreshToken).toBe("ref-2");
    // A DIFFERENT account on the same server is a second profile, never an overwrite.
    const other = await store.add({ ...seed, accountId: "acct-9", refreshToken: "ref-9" });
    expect(other.id).not.toBe(first.id);
    expect(await store.list()).toHaveLength(2);
  });

  it("refuses a non-normalized origin — the dedupe key must be the mirror's own derivation", async () => {
    const { kv } = memoryKV();
    const store = new ServerProfileStore(kv);
    await expect(store.add({ ...seed, origin: "HTTP://A.example/" })).rejects.toThrow(/normalized/);
    await expect(store.add({ ...seed, accountId: "  " })).rejects.toThrow(/account id/);
  });

  it("the vault half: rotations persist, a refusal clears the token but KEEPS the row", async () => {
    const { kv } = memoryKV();
    const store = new ServerProfileStore(kv);
    const p = await store.add(seed);
    await store.saveRefreshToken(p.id, "ref-rotated", new Set([seed.refreshToken]));
    expect((await store.active())?.refreshToken).toBe("ref-rotated");
    await store.clearRefreshToken(p.id, new Set([seed.refreshToken, "ref-rotated"]));
    const after = await store.active();
    expect(after?.refreshToken).toBeNull(); // the picker renders this as "pairing ended"
    expect(after?.origin).toBe(seed.origin); // the row survives, so re-pairing is one scan
    // Writes into a forgotten profile are silent no-ops, not resurrection.
    await store.remove(p.id);
    await store.saveRefreshToken(p.id, "ref-zombie", new Set(["ref-rotated"]));
    expect(await store.list()).toEqual([]);
  });

  it("a credential write lands only over a token of its writer's chain", async () => {
    // MUTATION WATCHED, one verb at a time: the comparison removed — that verb's write from a
    // chain the row does not hold answers `landed` and the row moves under a family not its own.
    const { kv } = memoryKV();
    const store = new ServerProfileStore(kv);
    const p = await store.add(seed);
    const row = async () => (await store.list())[0]!;
    const other = new Set(["ref-old", "ref-older"]);
    expect(await store.saveRefreshToken(p.id, "ref-x", other)).toBe("superseded");
    expect(await store.armRefreshAttempt(p.id, "r-x", "ref-old", other)).toBe("superseded");
    expect(await store.clearRefreshToken(p.id, other)).toBe("superseded");
    expect(await store.clearRefreshToken(p.id, new Set()), "a writer holding no token writes nothing").toBe("superseded");
    expect(await row()).toMatchObject({ refreshToken: "ref-1", refreshAttempt: null });

    // A chain whose save failed is two tokens ahead of the row: its arm lands, and writes the head.
    const chain = new Set(["ref-1", "ref-2"]);
    expect(await store.armRefreshAttempt(p.id, "r-2", "ref-2", chain)).toBe("landed");
    expect(await row()).toMatchObject({ refreshToken: "ref-2", refreshAttempt: "r-2" });
    expect(await store.saveRefreshToken(p.id, "ref-3", chain)).toBe("landed");
    expect(await row()).toMatchObject({ refreshToken: "ref-3", refreshAttempt: null });
    expect(await store.clearRefreshToken(p.id, new Set([...chain, "ref-3"]))).toBe("landed");
    expect(await row()).toMatchObject({ refreshToken: null, refreshAttempt: null });
    expect(await store.saveRefreshToken(p.id, "ref-4", new Set([...chain, "ref-3"])), "a cleared row admits nobody").toBe("superseded");

    await store.remove(p.id);
    expect(await store.saveRefreshToken(p.id, "ref-5", chain)).toBe("no_row");
    expect(await store.armRefreshAttempt(p.id, "r-3", "ref-2", chain)).toBe("no_row");
    expect(await store.clearRefreshToken(p.id, chain)).toBe("no_row");
  });

  it("a pairing whose value write is dropped is refused, fresh or re-paired, and the row is not the new family's", async () => {
    // MUTATION WATCHED: the value's read-back removed — the re-pair resolves over the previous
    // family's row, which the new pairing's manager can never write, and the next launch says
    // the pairing ended.
    const { kv, map } = memoryKV();
    let dropNextSetOf: string | null = null;
    const dropping: SecureKV = {
      ...kv,
      set: async (k, v) => {
        if (k === dropNextSetOf) { dropNextSetOf = null; return; } // resolved without storing
        await kv.set(k, v);
      },
    };
    const store = new ServerProfileStore(dropping, { newId: () => "p-one" });
    dropNextSetOf = "ohmail.servers.v1.p-one";
    await expect(store.add(seed), "a fresh pairing's dropped value").rejects.toMatchObject({ code: "pairing_not_recorded" });

    const p = await store.add(seed);
    await store.clearRefreshToken(p.id, new Set([seed.refreshToken])); // the server ended the family
    dropNextSetOf = "ohmail.servers.v1.p-one";
    await expect(store.add({ ...seed, refreshToken: "ref-new" }), "a re-pair's dropped value").rejects.toMatchObject({ code: "pairing_not_recorded" });
    expect((await store.list())[0]!.refreshToken, "the row still says the pairing ended").toBeNull();
    expect(map.size).toBeGreaterThan(0);
    expect((await store.add({ ...seed, refreshToken: "ref-new" })).refreshToken, "a write that lands is admitted").toBe("ref-new");
  });

  it("keystore constraints hold: key charset is secure-store-safe, one value stays small", async () => {
    const { kv, map } = memoryKV();
    const store = new ServerProfileStore(kv);
    await store.add({ ...seed, refreshToken: "r".repeat(256) });
    for (const [key, value] of map) {
      // expo-secure-store accepts only alphanumerics plus ".", "-", "_" in keys…
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      // …and warns past a small size per VALUE on iOS — which is why profiles are stored one
      // per key rather than as a single list blob.
      expect(Buffer.byteLength(value, "utf8")).toBeLessThan(2048);
    }
  });

  it("an owed sign-out is a value of its own, read back, eight at most, and gone when cleared or purged", async () => {
    const { kv, map } = memoryKV();
    const store = new ServerProfileStore(kv);
    await store.add(seed);
    const index = map.get("ohmail.servers.v1");
    const owe = (i: number) => store.markPendingSignOut({ origin: "http://a.example", pin: null, refreshToken: `owed-${i}` });
    const first = await owe(0);
    expect(map.get("ohmail.servers.v1"), "an owed token rode the profile index").toBe(index);
    for (let i = 1; i < 8; i += 1) await owe(i);
    await expect(owe(8)).rejects.toMatchObject({ code: "sign_out_queue_full" });
    expect((await store.pendingSignOuts()).map((e) => e.refreshToken)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `owed-${i}`));
    for (const [key, value] of map) {
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(Buffer.byteLength(value, "utf8")).toBeLessThan(2048);
    }
    await store.clearPendingSignOut(first.id);
    expect([...map.values()].some((v) => v.includes("owed-0")), "a cleared sign-out kept its token").toBe(false);
    await store.purgeAll();
    expect([...map.values()].some((v) => v.includes("owed-")), "the purge left an owed token").toBe(false);
  });

  it("an owed sign-out whose write resolves without storing is refused, not reported kept", async () => {
    const { kv } = memoryKV();
    const dropping: SecureKV = { ...kv, set: async (k, v) => { if (!k.includes(".signout.")) await kv.set(k, v); } };
    const store = new ServerProfileStore(dropping);
    await expect(store.markPendingSignOut({ origin: "http://a.example", pin: null, refreshToken: "owed" }))
      .rejects.toMatchObject({ code: "sign_out_not_recorded" });
    expect(await store.pendingSignOuts()).toEqual([]);
  });

  it("an unreadable index loses the list, never throws — profiles re-pair with one scan", async () => {
    const { kv } = memoryKV();
    await kv.set("ohmail.servers.v1", "{not json");
    const store = new ServerProfileStore(kv);
    expect(await store.list()).toEqual([]);
    expect(await store.active()).toBeNull();
  });
});

describe("one mirror per (origin, account); the __owner stamp stops bleed", () => {
  it("a profile switch reads ZERO of the other account's rows — distinct mirrors by derivation", async () => {
    const serverA = pairServer({ accountId: "acct-A", flavor: "selfhost", sessionRoute: true });
    const serverB = pairServer({ accountId: "acct-B", flavor: "selfhost", sessionRoute: true });
    const originA = await listen(serverA.server);
    const originB = await listen(serverB.server);
    try {
      serverA.addMessage("a1", "Mail for A only");
      serverA.addMessage("a2", "More of A's mail");
      serverA.mintPairToken("tok-A");
      serverB.mintPairToken("tok-B");

      const world = sqlWorld();
      const { kv } = memoryKV();
      const env: PairingEnv = {
        profiles: new ServerProfileStore(kv),
        engineDeps: { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" },
      };

      // Pair A, drain its mail, close (the app backgrounds).
      const pairedA = await pairThroughConfirm(env, { origin: originA, token: "tok-A" });
      expect(pairedA.kind).toBe("paired");
      if (pairedA.kind !== "paired") return;
      await pairedA.session.verifyIdentity();
      await pairedA.session.engine.start();
      expect(pairedA.session.engine.read().list("message")).toHaveLength(2);
      pairedA.session.store.close();

      // Pair B — the switch. B's mirror is a DIFFERENT database, and B sees none of A's mail.
      const pairedB = await pairThroughConfirm(env, { origin: originB, token: "tok-B" });
      expect(pairedB.kind).toBe("paired");
      if (pairedB.kind !== "paired") return;
      await pairedB.session.verifyIdentity();
      await pairedB.session.engine.start();
      expect(pairedB.session.engine.read().list("message")).toHaveLength(0);
      expect(pairedB.session.ownerKey).not.toBe(pairedA.session.ownerKey);
      expect(world.names()).toContain(mirrorDbName(pairedA.session.ownerKey));
      expect(world.names()).toContain(mirrorDbName(pairedB.session.ownerKey));
      pairedB.session.store.close();

      // Switching BACK reconnects A's profile and finds A's mail still on the device.
      const rows = await env.profiles.list();
      const profileA = rows.find((p) => p.accountId === "acct-A")!;
      await env.profiles.setActive(profileA.id);
      const back = await connectProfile(env, profileA);
      expect(back.kind).toBe("connected");
      if (back.kind !== "connected") return;
      expect(back.session.engine.read().list("message")).toHaveLength(2);
      back.session.store.close();
    } finally {
      serverA.server.close();
      serverB.server.close();
    }
  });

  it("the stamp itself: a FOREIGN owner opening the active mirror's database cannot read it", async () => {
    // The naming layer keeps mirrors apart above; this pins the belt under the braces. Collapse
    // the naming DELIBERATELY — hand profile B's owner key an opener that returns profile A's
    // physical database — and the __owner stamp mismatch wipes-and-claims: B reads NOTHING of
    // A's mail. This is the exact discipline idb.ts carried to sqlite in that change, asserted at this
    // slice's composition seam because multi-profile is the state this change introduces.
    //
    // ONE origin, TWO accounts — the multi-user standalone server case, chosen deliberately:
    // an owner key that dropped its account half would make these two keys EQUAL, the stamp
    // would match, and the read below would hand B account A's mail — exactly the mutation
    // this test was watched failing under (its red-first record, mutation 6).
    const world = sqlWorld();
    const ownerA = mirrorOwnerKey("http://one.example", "acct-A");
    const ownerB = mirrorOwnerKey("http://one.example", "acct-B");
    expect(ownerB).not.toBe(ownerA);

    const storeA = new SqlMirrorStore({ owner: ownerA, open: world.open });
    await storeA.load();
    await storeA.applyChanges([
      {
        type: "message",
        op: "create",
        id: "m-secret",
        seq: 1,
        updatedAt: "2026-08-19T08:00:00Z",
        entity: { id: "m-secret", accountId: "acct-A", subject: "A's private mail" },
      },
    ]);
    expect(storeA.list("message")).toHaveLength(1);
    storeA.close();

    const nameA = mirrorDbName(ownerA);
    const impostor = new SqlMirrorStore({ owner: ownerB, open: () => world.open(nameA) });
    await impostor.load();
    // The mismatch wiped: the foreign profile holds an empty, re-claimed mirror — no bleed.
    expect(impostor.list("message")).toHaveLength(0);
    expect(impostor.getCursor()).toBe("0");
    impostor.close();
  });
});
