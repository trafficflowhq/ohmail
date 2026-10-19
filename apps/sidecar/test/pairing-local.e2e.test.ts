import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { eq } from "drizzle-orm";
import { devices, sessions } from "@trafficflow/db";
import {
  makeAuthConfig, makeSessionLifecycle, mintPairingToken, redeemDevicePair, resolveSession,
  type ServiceContext, type SessionLifecycle,
} from "@trafficflow/services/auth";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, mintLaunchSession, type LocalWorld } from "../src/identity.js";

/**
 * ═══ DEVICE PAIRING ON THE DESKTOP'S REAL STORE — the Phase 3 substrate, end to end ═══════
 *
 * Everything here runs against on-disk PGlite through `openLocalDb` — the store the shipped
 * engine actually opens, migrated by the same mail journal (0060 is what gives it
 * `refresh_tokens`) — and through the sidecar's real composition idioms: `ensureLocalWorld` +
 * `mintLaunchSession` for the launch identity, `makeSessionLifecycle` for the machinery the
 * service bag holds (`engine.ts`), and the SAME `mintPairingToken`/`redeemDevicePair` the
 * `/pair` routes call. The hosted halves of these claims (the atomic burn under real
 * concurrency, hash-at-rest against a real catalog) are `pairing.pg.test.ts`'s; THIS file
 * proves the desktop tier's composition of them.
 *
 * The first suite is the named scenario ("THE
 * LAUNCH-SESSION LANDMINE"): `mintLaunchSession` used to revoke EVERY unrevoked session at
 * every app launch, paired-device sessions live in the same `sessions` table, so every desktop
 * restart would have silently unpaired every phone. Only a scenario test can see that defect —
 * each half is locally correct — and this one was watched RED against the blanket revoke
 * before `identity.ts` narrowed it with `isNull(sessions.deviceId)`.
 */

const AT = new Date("2026-08-18T09:00:00.000Z");
const at = (offsetMs: number): Date => new Date(AT.getTime() + offsetMs);

const opened: OpenLocalDb[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const o of opened.splice(0)) await o.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshWorld(): Promise<{ db: LocalDb; world: LocalWorld; lifecycle: SessionLifecycle }> {
  const dir = await freshDataDir("ohmail-pairing-e2e-");
  dirs.push(dir);
  const o = await openLocalDb(dir);
  opened.push(o);
  const world = await ensureLocalWorld(o.db, { address: "owner@example.com", now: AT });
  // The exact construction `engine.ts` performs for the service bag: the real validator, the
  // local rpID/origin nothing here ceremonies against.
  const lifecycle = makeSessionLifecycle({
    config: makeAuthConfig({ rpID: "localhost", origin: "http://localhost" }),
  });
  return { db: o.db, world, lifecycle };
}

/** A ServiceContext over the local store, as the stdio door's request path builds one. */
function ctxFor(db: LocalDb, world: LocalWorld, now: Date): ServiceContext {
  return {
    db: db as ServiceContext["db"],
    accountId: world.accountId,
    userId: world.userId,
    now: () => now,
    requestId: "pairing-e2e",
  };
}

async function pairPhone(
  db: LocalDb, world: LocalWorld, lifecycle: SessionLifecycle, now: Date,
  kind?: "web" | "macos",
): Promise<{ accessToken: string; refreshToken: string }> {
  const ctx = ctxFor(db, world, now);
  const minted = await mintPairingToken(ctx, { grant: "device-pair", label: "Pixel in the kitchen" });
  const { tokens } = await redeemDevicePair(ctx, lifecycle, {
    token: minted.token, ...(kind !== undefined ? { kind } : {}),
  });
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

describe("THE LAUNCH-SESSION LANDMINE — pair, relaunch, and the phone must still be paired", () => {
  it("a relaunch kills the old launch token and ONLY that: the paired session survives, and still rotates", async () => {
    const { db, world, lifecycle } = await freshWorld();

    // Launch one: the app starts, the shell gets its per-launch bearer.
    const launch1 = await mintLaunchSession(db, world, AT);
    expect(await resolveSession(db, launch1.token, at(1_000))).not.toBeNull();

    // A phone pairs (mint → redeem → establish) and its bearer pair works.
    const phone = await pairPhone(db, world, lifecycle, at(60_000));
    expect(await resolveSession(db, phone.accessToken, at(61_000))).not.toBeNull();

    // ── THE RELAUNCH. This is the line the whole scenario exists for. ───────────────────────
    const launch2 = await mintLaunchSession(db, world, at(120_000));

    // The old launch token is dead — the per-launch property `identity.ts` has always enforced.
    expect(await resolveSession(db, launch1.token, at(121_000))).toBeNull();
    // The new one works.
    expect(await resolveSession(db, launch2.token, at(121_000))).not.toBeNull();

    // THE PAIRED SESSION STILL WORKS. Red under the blanket revoke: paired sessions share the
    // `sessions` table, and only `isNull(sessions.deviceId)` — launch sessions carry no device
    // row, `establishPairedDevice` always sets one — keeps a restart from unpairing the phone.
    expect(
      await resolveSession(db, phone.accessToken, at(121_000)),
      "the desktop relaunch silently unpaired the phone",
    ).not.toBeNull();

    // …and exactly one session was revoked by the relaunch: the stale launch session. This is
    // the counting half of the same assertion — a blanket revoke reports 2 here.
    expect(launch2.revoked).toBe(1);

    // The paired family is genuinely ALIVE, not merely unrevoked: its refresh still rotates.
    const ctx = ctxFor(db, world, at(180_000));
    const rotated = await lifecycle.refresh(ctx, { refreshToken: phone.refreshToken });
    expect(rotated.tokens).toBeDefined();
    expect(await resolveSession(db, rotated.tokens!.accessToken, at(181_000))).not.toBeNull();
  });
});

describe("the paired-device lifecycle, end to end on PGlite", () => {
  it("mint → redeem → the bearer pair works → refresh rotates → reuse detection trips and kills the family", async () => {
    const { db, world, lifecycle } = await freshWorld();
    await mintLaunchSession(db, world, AT);
    const ctx = (ms: number): ServiceContext => ctxFor(db, world, at(ms));

    const pair = await pairPhone(db, world, lifecycle, at(10_000));

    // The bearer works, and the session it names carries a DEVICE — the row that makes the
    // pairing visible in the device list and revocable, and the row the relaunch narrowing
    // keys on.
    const resolved = await resolveSession(db, pair.accessToken, at(11_000));
    expect(resolved).not.toBeNull();
    const [sessionRow] = await db.select().from(sessions).where(eq(sessions.id, resolved!.sessionId));
    expect(sessionRow!.deviceId).not.toBeNull();
    // NO step-up standing: `establishPairedDevice`'s deliberate NULL, on the store that is
    // otherwise all `lastTwofaAt = now` (the launch session's boot stamp).
    expect(sessionRow!.lastTwofaAt).toBeNull();

    // /auth/refresh rotates: a new pair, the old ACCESS token replaced on the same session.
    const r1 = await lifecycle.refresh(ctx(30_000), { refreshToken: pair.refreshToken });
    expect(r1.tokens).toBeDefined();
    expect(r1.tokens!.refreshToken).not.toBe(pair.refreshToken);
    expect(await resolveSession(db, r1.tokens!.accessToken, at(31_000))).not.toBeNull();
    expect(await resolveSession(db, pair.accessToken, at(31_000)),
      "rotation must retire the previous access token").toBeNull();

    // REUSE DETECTION: replaying the consumed refresh token is the theft signal, and on the
    // bearer surface (no grace) it revokes the WHOLE family — the fresh rotation included.
    await expect(lifecycle.refresh(ctx(60_000), { refreshToken: pair.refreshToken }))
      .rejects.toThrow(/reuse detected/);
    expect(await resolveSession(db, r1.tokens!.accessToken, at(61_000)),
      "a detected reuse must kill the family's live access token").toBeNull();
    await expect(lifecycle.refresh(ctx(62_000), { refreshToken: r1.tokens!.refreshToken }),
      "a detected reuse must kill the family's live refresh token too")
      .rejects.toThrow(/invalid refresh token/);
  });

  it("`kind` names the device and NEVER chooses a lifetime — both kinds get the one bearer window", async () => {
    // The reviewer's finding, pinned: `kind` is anonymous wire input (any holder of a valid
    // device-pair token picks it), so it must not steer the refresh window — and it could not
    // honestly anyway, because a bearer pair rotates through the native branch, which re-issues
    // the native window on the first rotation whatever the mint chose. One policy, at mint AND
    // at rotation: the paired mint pins the bearer surface, and the declared kind is only the
    // device row's truth.
    const { db, world, lifecycle } = await freshWorld();
    const ctx = ctxFor(db, world, AT);

    const windowOf = async (kind: "web" | "macos"): Promise<number> => {
      const minted = await mintPairingToken(ctx, { grant: "device-pair", label: `probe-${kind}` });
      const { tokens } = await redeemDevicePair(ctx, lifecycle, { token: minted.token, kind });
      const resolved = await resolveSession(db, tokens.accessToken, at(1_000));
      const [row] = await db.select().from(sessions).where(eq(sessions.id, resolved!.sessionId));
      return row!.refreshExpiresAt.getTime() - AT.getTime();
    };

    const webWindow = await windowOf("web");
    const macWindow = await windowOf("macos");
    expect(webWindow, "the wire kind must not choose the credential's lifetime").toBe(macWindow);
    // …and the one window is the NATIVE one — the surface every bearer rotation re-issues — so
    // the mint cannot promise a shorter life than the first refresh would grant anyway.
    expect(webWindow).toBe(makeAuthConfig({ rpID: "localhost", origin: "http://localhost" }).nativeRefreshTtlMs);
  });

  /*
   * A TAKE-BACK ON THE WINDOW TAKES THE CODES STILL WAITING. The bare lifecycle can mint one grant, the
   * device-pair code, and its sign-out-everywhere and device revoke now void it with the sessions, on
   * the desktop's own store (no Cloud table exists here to void). The window's mint carries the launch
   * session, as the stdio door's request does, and proves it live last.
   */
  it("revoking a device voids the codes still waiting; a code minted after works", async () => {
    const { db, world, lifecycle } = await freshWorld();
    const launch = await mintLaunchSession(db, world, AT);
    const windowCtx: ServiceContext = {
      ...ctxFor(db, world, at(1_000)), sessionId: (await resolveSession(db, launch.token, at(1_000)))!.sessionId,
    };
    const first = await mintPairingToken(windowCtx, { grant: "device-pair", label: "Pixel in the kitchen" });
    const { tokens } = await redeemDevicePair(ctxFor(db, world, at(1_500)), lifecycle, { token: first.token });
    const phone = (await resolveSession(db, tokens.accessToken, at(2_000)))!;
    const [row] = await db.select({ deviceId: sessions.deviceId }).from(sessions).where(eq(sessions.id, phone.sessionId));
    const waiting = await mintPairingToken(windowCtx, { grant: "device-pair", label: "The tablet" });

    await lifecycle.revokeDevice(windowCtx, row!.deviceId!, { requireStepUp: false });

    await expect(redeemDevicePair(ctxFor(db, world, at(3_000)), lifecycle, { token: waiting.token }))
      .rejects.toMatchObject({ code: "pairing_invalid" });
    expect(await resolveSession(db, tokens.accessToken, at(3_000))).toBeNull();
    const next = await mintPairingToken(windowCtx, { grant: "device-pair", label: "The tablet" });
    await expect(redeemDevicePair(ctxFor(db, world, at(4_000)), lifecycle, { token: next.token })).resolves.toBeTruthy();
  });

  it("signing out everywhere voids the codes still waiting, and a mint on the signed-out launch session is refused", async () => {
    const { db, world, lifecycle } = await freshWorld();
    const launch = await mintLaunchSession(db, world, AT);
    const windowCtx: ServiceContext = {
      ...ctxFor(db, world, at(1_000)), sessionId: (await resolveSession(db, launch.token, at(1_000)))!.sessionId,
    };
    const waiting = await mintPairingToken(windowCtx, { grant: "device-pair", label: "The tablet" });

    await lifecycle.logout(windowCtx, { allDevices: true });

    await expect(redeemDevicePair(ctxFor(db, world, at(2_000)), lifecycle, { token: waiting.token }))
      .rejects.toMatchObject({ code: "pairing_invalid" });
    await expect(mintPairingToken(windowCtx, { grant: "device-pair", label: "Too late" }))
      .rejects.toMatchObject({ code: "unauthorized", httpStatus: 401 });
    // The next launch mints again.
    const relaunch = await mintLaunchSession(db, world, at(5_000));
    const next = await mintPairingToken({
      ...ctxFor(db, world, at(6_000)), sessionId: (await resolveSession(db, relaunch.token, at(6_000)))!.sessionId,
    }, { grant: "device-pair", label: "The tablet" });
    await expect(redeemDevicePair(ctxFor(db, world, at(7_000)), lifecycle, { token: next.token })).resolves.toBeTruthy();
  });

  it("`kind` is the redeemer's declaration: absent means web, macos is accepted, junk refuses WITHOUT burning", async () => {
    const { db, world, lifecycle } = await freshWorld();
    const ctx = ctxFor(db, world, AT);

    // Absent → "web": the browser reading, on the device row. This is the wire wart this slice
    // removed — the row used to say `macos` for every redeemer, phones included.
    await pairPhone(db, world, lifecycle, at(1_000));
    const rows = await db.select().from(devices).where(eq(devices.userId, world.userId));
    const phone = rows.find((d) => d.label === "Pixel in the kitchen");
    expect(phone?.kind).toBe("web");

    // Declared macos → macos (the Phase 5 native app's arm).
    const mac = await mintPairingToken(ctx, { grant: "device-pair", label: "The studio Mac" });
    await redeemDevicePair(ctx, lifecycle, { token: mac.token, kind: "macos" });
    const rows2 = await db.select().from(devices).where(eq(devices.userId, world.userId));
    expect(rows2.find((d) => d.label === "The studio Mac")?.kind).toBe("macos");

    // An unlisted kind refuses BEFORE the burn — a malformed declaration is the caller's bug
    // and must not cost the single-use token — and the rightful redeem still works after it.
    const third = await mintPairingToken(ctx, { grant: "device-pair", label: "Junk kind" });
    await expect(redeemDevicePair(ctx, lifecycle, {
      token: third.token, kind: "toaster" as unknown as "web",
    })).rejects.toThrow(/device kind/);
    const { tokens } = await redeemDevicePair(ctx, lifecycle, { token: third.token });
    expect(await resolveSession(db, tokens.accessToken, at(2_000))).not.toBeNull();
  });
});
