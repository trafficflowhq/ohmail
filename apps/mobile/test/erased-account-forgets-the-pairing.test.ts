/**
 * AN ACCOUNT ERASED ELSEWHERE LEAVES NO COPY ON THIS PHONE. Measured at the base: the paired
 * phone of an erased account heard 401s, read them as an ordinary refusal ("pair again") and kept
 * the profile and its mirror. Now `410 account_erased` naming THIS pairing's account ends the
 * session as `erased` in the manager, before the engine sees it (to the adapter a 410 is a cursor
 * expiry, whose remedy is a re-bootstrap), and the connection layer forgets the profile through the
 * Forget verb's own ceremony. A session the server revoked by code (`refresh_revoked`) takes the
 * same Forget; a lapse does not. Real pairing, engine and forget against a fake of the hosted routes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { mirrorDbName } from "@ohmail/client-engine";
import { mirrorOwnerKey, type MobileEngineDeps } from "../src/engine/boot";
import { BearerManagerRN, type SessionDeath } from "../src/net/bearer";
import { forgetProfile, type ConnectedSession, type PairingEnv } from "../src/net/pairing";
import { deathRefusal, noteSessionDeath } from "../src/net/session-death";
import { bindSeedOfferKV, relaunchSeedOfferForTests, seedLater, seedNotNowKey } from "../src/state/seed-offer";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { listen, pairServer, pairThroughConfirm, sqlWorld } from "./helpers/pair-server";
/* @reads: apps/mobile/src/net/connection.tsx */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function memoryKV(): SecureKV & { size: () => number } {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    size: () => map.size,
  };
}

function testEnv() {
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  const kv = memoryKV();
  const env: PairingEnv = { profiles: new ServerProfileStore(kv), engineDeps: deps };
  return { env, world, kv };
}

/** "Not now" on the sent-mail review, pressed for each owner into the keystore; answers which rows it still holds. */
async function notNowOf(kv: SecureKV, owners: string[]): Promise<() => Promise<boolean[]>> {
  bindSeedOfferKV(kv);
  for (const owner of owners) await seedLater(owner);
  relaunchSeedOfferForTests();
  return () => Promise.all(owners.map(async (o) => (await kv.get(seedNotNowKey(o))) !== null));
}

/** One account on its own server, paired, drained once so its mirror holds mail. */
async function paired(env: PairingEnv, accountId: string) {
  const fake = pairServer({ flavor: "desktop-host", sessionRoute: false, accountId });
  const origin = await listen(fake.server);
  fake.addMessage(`m-${accountId}`, `the letter of ${accountId}`);
  fake.mintPairToken(`tok-${accountId}`);
  const outcome = await pairThroughConfirm(env, { origin, token: `tok-${accountId}` });
  if (outcome.kind !== "paired") throw new Error(`pairing refused: ${JSON.stringify(outcome)}`);
  const session = outcome.session as ConnectedSession;
  // The connection layer's order: the identity check settles before the first drain.
  expect((await session.verifyIdentity()).kind).not.toBe("mismatch");
  await session.engine.start();
  return { fake, origin, session };
}

const holds = (world: ReturnType<typeof sqlWorld>, origin: string, account: string): boolean =>
  world.names().includes(mirrorDbName(mirrorOwnerKey(origin, account)));

describe("the paired phone of an erased account", () => {
  it("dies as ERASED on the read path, before the engine sees the 410, and the door forgets only it", async () => {
    const { env, world, kv } = testEnv();
    const x = await paired(env, "acct-x");
    const y = await paired(env, "acct-y");
    try {
      expect(holds(world, x.origin, "acct-x") && holds(world, y.origin, "acct-y")).toBe(true);
      const notNow = await notNowOf(kv, [x.session.ownerKey, y.session.ownerKey]);
      const deaths: SessionDeath[] = [];
      x.session.bearer!.onSessionDead((why) => deaths.push(why));
      const before = x.fake.seen.length;
      x.fake.erase();

      await x.session.engine.syncOnce().catch(() => undefined);
      const after = x.fake.seen.slice(before);
      expect(deaths, "the erased answer read as an ordinary refusal").toEqual(["erased"]);
      expect(after.length, "the engine asked again after the verdict (a re-bootstrap)").toBe(1);
      expect(after[0]!.url.startsWith("/auth/refresh"), "a refresh was spent on a gone account").toBe(false);

      // What `connection.tsx`'s erased arm runs: the Forget ceremony, nothing to tell the server.
      const profilesBefore = (await env.profiles.list()).map((p) => p.accountId).sort();
      const outcome = await forgetProfile(env, x.session.profile.id, {
        closed: Promise.resolve().then(() => x.session.store.close()), revoke: async () => true, erased: true,
      });
      expect(outcome.kind).toBe("forgotten");
      expect(profilesBefore).toEqual(["acct-x", "acct-y"]);
      expect((await env.profiles.list()).map((p) => p.accountId), "the other pairing went too").toEqual(["acct-y"]);
      expect(holds(world, x.origin, "acct-x"), "the erased account's mirror is still on the phone").toBe(false);
      expect(holds(world, y.origin, "acct-y"), "account Y's mirror was taken").toBe(true);
      expect(await notNow(), "the erased account's keystore row stayed, or account Y's went").toEqual([false, true]);
    } finally {
      x.fake.server.close();
      y.fake.server.close();
    }
  }, 30_000);

  it("a session revoked at its server by code: its copy is owed before the credential goes, and only it goes", async () => {
    const { env, world, kv } = testEnv();
    const x = await paired(env, "acct-x");
    const y = await paired(env, "acct-y");
    try {
      const notNow = await notNowOf(kv, [x.session.ownerKey]);
      const deaths: SessionDeath[] = [];
      x.session.bearer!.onSessionDead((why) => deaths.push(why));
      x.fake.revoke("refresh_revoked");

      await x.session.engine.syncOnce().catch(() => undefined);
      expect(deaths, "a revoke read as a lapse").toEqual(["signedOutElsewhere"]);
      expect(x.session.bearer!.removesCopy).toBe(true);
      expect((await env.profiles.pendingWipes()).map((w) => w.id), "no Forget owed before the token went").toEqual([x.session.profile.id]);
      expect(deathRefusal("signedOutElsewhere").say, "the sentence a pairing that ended says").toBe("pairEnded");

      // What `connection.tsx` runs on a death that removes the copy: the Forget, nothing to tell the server.
      const outcome = await forgetProfile(env, x.session.profile.id, {
        closed: Promise.resolve().then(() => x.session.store.close()), revoke: async () => true,
      });
      expect(outcome.kind).toBe("forgotten");
      expect((await env.profiles.list()).map((p) => p.accountId), "the other pairing went too").toEqual(["acct-y"]);
      expect(holds(world, x.origin, "acct-x"), "the revoked account's mirror is still on the phone").toBe(false);
      expect(holds(world, y.origin, "acct-y"), "account Y's mirror was taken").toBe(true);
      // A revoke is not an erasure: the account's own rows stay for its next pairing, as Forget keeps them.
      expect(await notNow(), "a revoke took the account's keystore row").toEqual([true]);
    } finally {
      x.fake.server.close();
      y.fake.server.close();
    }
  }, 30_000);

  it("at the refresh door: the rotation's 410 naming this account ends it as ERASED", async () => {
    const { env } = testEnv();
    const x = await paired(env, "acct-x");
    try {
      const deaths: SessionDeath[] = [];
      x.session.bearer!.onSessionDead((why) => deaths.push(why));
      x.fake.expireAccess();
      x.fake.erase();
      const res = await x.session.bearer!.fetch(`${x.origin}/sync?since=0`, { method: "GET" });
      expect(deaths).toEqual(["erased"]);
      expect(res.status, "the engine must not be handed the 410").toBe(401);
      expect(x.session.bearer!.paired()).toBe(false);
      expect(x.session.bearer!.removesCopy).toBe(true);
    } finally {
      x.fake.server.close();
    }
  }, 30_000);

  it("every ask and the refresh declare that they understand the answer", async () => {
    const asked: Array<string | null> = [];
    const bearer = new BearerManagerRN({
      origin: "https://cloud.test", accessToken: "a", refreshToken: "r", accountId: "acct-x",
      vault: { save: async () => "landed", clear: async () => "landed", armAttempt: async () => "landed", oweSignOut: async () => false },
      fetchImpl: async (_url, init) => {
        asked.push(((init ?? {}) as { headers?: Record<string, string> }).headers?.["x-ohmail-accepts"] ?? null);
        return new Response(JSON.stringify({ error: { code: "unauthorized", message: "x" } }), { status: 401 });
      },
    });
    await bearer.fetch("https://cloud.test/sync", { method: "GET" });
    expect(asked).toEqual(["account_erased", "account_erased"]);
  });
});

describe("what ends nothing as erased", () => {
  const manager = (answer: () => Response, accountId: string | null = "acct-x") => {
    const deaths: SessionDeath[] = [];
    const bearer = new BearerManagerRN({
      origin: "https://cloud.test", accessToken: "a", refreshToken: "r", accountId,
      vault: { save: async () => "landed", clear: async () => "landed", armAttempt: async () => "landed", oweSignOut: async () => false },
      fetchImpl: async () => answer(),
    });
    bearer.onSessionDead((why) => deaths.push(why));
    return { bearer, deaths };
  };
  const coded = (status: number, code: string, account: string | null) => new Response(
    JSON.stringify({ error: { code, message: code } }),
    { status, headers: { "content-type": "application/json", ...(account ? { "x-ohmail-account": account } : {}) } },
  );

  it("CONTROL — an ordinary 401 and a lapsed refresh: 'refused', the pair ends, the profile stays", async () => {
    const { bearer, deaths } = manager(() => coded(401, "refresh_expired", null));
    await bearer.fetch("https://cloud.test/sync", { method: "GET" });
    expect(deaths).toEqual(["refused"]);
    expect(bearer.removesCopy).toBe(false);
    expect(deathRefusal("refused").say).toBe("pairEnded");
  });

  it("a 410 naming ANOTHER account, one naming nobody, and a cursor expiry end nothing", async () => {
    for (const answer of [
      () => coded(410, "account_erased", "acct-y"),
      () => coded(410, "account_erased", null),
      () => coded(410, "cursor_expired", "acct-x"),
    ]) {
      const { bearer, deaths } = manager(answer);
      const res = await bearer.fetch("https://cloud.test/sync", { method: "GET" });
      expect(deaths).toEqual([]);
      expect(res.status).toBe(410);
      expect(bearer.paired()).toBe(true);
    }
  });

  it("a refresh answering 410 naming ANOTHER account keeps the pair", async () => {
    const refreshing = new BearerManagerRN({
      origin: "https://cloud.test", accessToken: "a", refreshToken: "r", accountId: "acct-x",
      vault: { save: async () => "landed", clear: async () => "landed", armAttempt: async () => "landed", oweSignOut: async () => false },
      fetchImpl: async (url) => (url.endsWith("/auth/refresh")
        ? coded(410, "account_erased", "acct-y") : coded(401, "unauthorized", null)),
    });
    const seen: SessionDeath[] = [];
    refreshing.onSessionDead((why) => seen.push(why));
    await refreshing.fetch("https://cloud.test/sync", { method: "GET" });
    expect(seen).toEqual([]);
    expect(refreshing.paired()).toBe(true);
  });

  it("a manager that was never told its account acts on no erased answer", async () => {
    const { bearer, deaths } = manager(() => coded(410, "account_erased", "acct-x"), null);
    await bearer.fetch("https://cloud.test/sync", { method: "GET" });
    expect(deaths).toEqual([]);
  });
});

describe("the sentence and the door", () => {
  it("says the account was deleted and the copy is gone, in both languages; the cause goes to the log", () => {
    expect(deathRefusal("erased").say).toBe("accountErased");
    expect(EN.accountErased).toMatch(/deleted/);
    expect(EN.accountErased).toMatch(/mail server is untouched/);
    expect(DE.accountErased).toMatch(/gelöscht/);
    const lines: string[] = [];
    noteSessionDeath("erased", (l) => lines.push(l));
    expect(lines).toEqual(['{"service":"pairing","event":"session_dead","why":"erased"}']);
  });

  it("the connection layer's dead signal forgets the profile on a death that removes the copy, after the store closes", () => {
    const src = withoutComments(fs.readFileSync(path.join(HERE, "..", "src", "net", "connection.tsx"), "utf8"));
    const arm = src.slice(src.indexOf("onSessionDead((why) =>"), src.indexOf("}) ?? null;", src.indexOf("onSessionDead((why) =>")));
    expect(arm).toMatch(/const closed = teardown\(session\);/);
    expect(arm).toMatch(/if \(session\.bearer\?\.removesCopy !== true\) \{/);
    expect(arm).toMatch(/forgetProfile\(env, session\.profile\.id, \{ closed, revoke: async \(\) => true, erased: why === "erased" \}\)/);
  });
});
