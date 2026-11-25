import { describe, it, expect } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { devices, pairingTokens, sessions } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { createApp, type ApiDeps } from "@trafficflow/api";
import { APP_HANDOFF_PER_HOUR, generateToken, hashToken } from "@trafficflow/services";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { makeDeps, seedSession, seedSessionFor, req, FIXED_NOW } from "./helpers.js";

/**
 * ONE PHONE APP HANDS ITS SIGN-IN TO ITS SIBLING ON THE SAME PHONE (`POST /pair/handoff`, the redeem's
 * `app-handoff` arm), over HTTP on the self-host table. The mint rotates the phone's own refresh token first and
 * costs it; the code is bound to the receiving app's SHA-256 challenge, single use, a minute long, redeemable only while
 * the minting session lives; the born session is a pairing's own, and its device records its parent, so a reuse
 * sweep or a take-back of the parent ends it too.
 */
const app = createApp(selfHostRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const post = (path: string, body: unknown, bearer?: string) =>
  req("POST", path, { body: JSON.stringify(body), ...(bearer ? { bearer } : {}) });

type Tokens = { accessToken: string; refreshToken: string };

/** A phone paired by a QR code: its own device and session, the bearer pair the redeem answered. */
async function pairedPhone(db: Awaited<ReturnType<typeof makeDeps>>["db"], deps: ApiDeps, kind = "mobile-android", label = "Pixel") {
  const owner = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const minted = await (await H(post("/pair", { grant: "device-pair", label }, owner.token), deps)).json();
  const res = await H(post("/pair/redeem", { grant: "device-pair", token: minted.token, kind }), deps);
  expect(res.status, await res.clone().text()).toBe(200);
  const tokens = (await res.json()).tokens as Tokens;
  const [row] = await db.select({ deviceId: sessions.deviceId }).from(sessions)
    .where(eq(sessions.accessTokenHash, hashToken(tokens.accessToken)));
  return { owner, tokens, deviceId: row!.deviceId! };
}

/** The receiving app's proof key: a verifier only it holds and its SHA-256 challenge. */
function proofKey() {
  const verifier = generateToken();
  return { verifier, challenge: hashToken(verifier) };
}

async function handOff(deps: ApiDeps, refreshToken: string, challenge: string, target = "ohcal") {
  const res = await H(post("/pair/handoff", { refreshToken, challenge, target }), deps);
  return { res, body: await res.clone().json() as { tokens: Tokens; handoff: { token: string; expiresIn: number } | null; handoffRefused?: string } };
}

const redeem = (deps: ApiDeps, token: string, verifier: string, kind = "mobile-ios", bearer?: string) =>
  H(post("/pair/redeem", { grant: "app-handoff", token, verifier, kind }, bearer), deps);

describe("POST /pair/handoff — a phone's own refresh token, rotated, then a code bound to the sibling's challenge", () => {
  it("rotates the phone's pair and answers a one-minute code; the presented token is spent; no cookie, no cache", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    const key = proofKey();
    const { res, body } = await handOff(deps, phone.tokens.refreshToken, key.challenge);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.tokens.refreshToken).not.toBe(phone.tokens.refreshToken);
    expect(body.handoff).toMatchObject({ expiresIn: 60 });
    const [row] = await db.select().from(pairingTokens).where(eq(pairingTokens.tokenHash, hashToken(body.handoff!.token)));
    expect(row).toMatchObject({ grant: "app-handoff", challengeHash: key.challenge, handoffFromDeviceId: phone.deviceId, label: "ohcal · Pixel" });
    // The token it presented was rotated: a second presentation is a replay.
    expect((await H(post("/auth/refresh", { refreshToken: phone.tokens.refreshToken }), deps)).status).toBe(401);
  });

  it("mints nothing for a browser's or a computer's pair, and still answers their rotated pair", async () => {
    const { db, deps } = await makeDeps();
    for (const kind of ["web", "desktop-linux"]) {
      const device = await pairedPhone(db, deps, kind);
      const { res, body } = await handOff(deps, device.tokens.refreshToken, proofKey().challenge);
      expect(res.status, kind).toBe(200);
      expect(body, kind).toMatchObject({ handoff: null, handoffRefused: "handoff_refused" });
      expect(body.tokens.refreshToken, kind).toEqual(expect.any(String));
    }
    expect(await db.select().from(pairingTokens).where(eq(pairingTokens.grant, "app-handoff"))).toEqual([]);
  });

  it("refuses its shape before anything is spent: no challenge, a short one, an unknown app, an access token", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    for (const body of [
      { refreshToken: phone.tokens.refreshToken, target: "ohcal" },
      { refreshToken: phone.tokens.refreshToken, challenge: "abc", target: "ohcal" },
      { refreshToken: phone.tokens.refreshToken, challenge: proofKey().challenge, target: "ohdrive" },
    ]) {
      expect((await H(post("/pair/handoff", body), deps)).status, JSON.stringify(Object.keys(body))).toBe(400);
    }
    // An access token alone mints nothing: it is no refresh token.
    expect((await H(post("/pair/handoff", { refreshToken: phone.tokens.accessToken, challenge: proofKey().challenge, target: "ohcal" }), deps)).status).toBe(401);
    // Nothing was spent: the phone's own pair still rotates.
    expect((await H(post("/auth/refresh", { refreshToken: phone.tokens.refreshToken }), deps)).status).toBe(200);
  });

  it("answers the rotated pair with the refusal past six an hour, and past eight live handed-off apps", async () => {
    const { db, deps, clock } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    let refresh = phone.tokens.refreshToken;
    for (let i = 0; i < APP_HANDOFF_PER_HOUR; i += 1) {
      const { body } = await handOff(deps, refresh, proofKey().challenge);
      expect(body.handoff, `mint ${i + 1}`).not.toBeNull();
      refresh = body.tokens.refreshToken;
    }
    const seventh = await handOff(deps, refresh, proofKey().challenge);
    expect(seventh.res.status).toBe(200);
    expect(seventh.body).toMatchObject({ handoff: null, handoffRefused: "handoff_rate_limited" });
    refresh = seventh.body.tokens.refreshToken;
    // Five minutes on, every code of the hour has expired unspent, and the hour still counts it.
    clock.advance(5 * 60_000);
    const later = await handOff(deps, refresh, proofKey().challenge);
    expect(later.body).toMatchObject({ handoff: null, handoffRefused: "handoff_rate_limited" });
    refresh = later.body.tokens.refreshToken;
    /** One more child signed in by a code: the mint admitted, the redeem answered. */
    const child = async (label: string) => {
      const key = proofKey();
      const { body } = await handOff(deps, refresh, key.challenge);
      refresh = body.tokens.refreshToken;
      expect(body.handoff, label).not.toBeNull();
      expect((await redeem(deps, body.handoff!.token, key.verifier)).status, label).toBe(200);
    };
    // Eight live children, an hour apart in pairs.
    for (let n = 0; n < 8; n += 1) {
      if (n % APP_HANDOFF_PER_HOUR === 0) clock.advance(61 * 60_000);
      await child(`child ${n + 1}`);
    }
    clock.advance(61 * 60_000);
    // One taken back in Devices frees its place: the next is admitted, and past eight live again it is refused.
    const [taken] = await db.select({ id: devices.id }).from(devices).where(eq(devices.handedOffFrom, phone.deviceId)).limit(1);
    const owner = await seedSessionFor(db, { accountId: phone.owner.accountId, userId: phone.owner.userId, now: clock.now(), lastTwofaAt: clock.now() });
    expect((await H(req("DELETE", `/devices/${taken!.id}`, { bearer: owner.token }), deps)).status).toBe(204);
    await child("child 8 again, after the take-back");
    const ninth = await handOff(deps, refresh, proofKey().challenge);
    expect(ninth.body).toMatchObject({ handoff: null, handoffRefused: "handoff_limit" });
  });

  it("is no grant of POST /pair: a signed-in person mints no handoff code there, and nothing is written", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect((await H(post("/pair", { grant: "app-handoff", label: "Pixel" }, owner.token), deps)).status).toBe(400);
    expect(await db.select().from(pairingTokens).where(eq(pairingTokens.grant, "app-handoff"))).toEqual([]);
  });

  it("still answers the rotated pair when the mint faults", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    // A store that refuses every new code: the mint's write faults after the rotation committed.
    await db.execute(sql.raw(`ALTER TABLE "pairing_tokens" ADD CONSTRAINT "no_new_codes" CHECK ("grant" <> 'app-handoff')`));
    const { res, body } = await handOff(deps, phone.tokens.refreshToken, proofKey().challenge);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ handoff: null, handoffRefused: "internal" });
    expect((await H(post("/auth/refresh", { refreshToken: body.tokens.refreshToken }), deps)).status).toBe(200);
  });
});

describe("POST /pair/redeem, grant app-handoff — the code and its challenge's verifier sign the sibling in", () => {
  it("scopes a handoff to the calendar app and refuses a mail handoff from that session", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    const key = proofKey();
    const minted = await handOff(deps, phone.tokens.refreshToken, key.challenge);
    const res = await redeem(deps, minted.body.handoff!.token, key.verifier);
    expect(res.status).toBe(200);
    const { tokens, scope } = await res.json();
    expect(scope).toBe("calendar");
    expect((await H(req("GET", "/messages", { bearer: tokens.accessToken }), deps)).status).toBe(403);
    const onward = await handOff(deps, tokens.refreshToken, proofKey().challenge, "ohmail");
    expect(onward.body).toMatchObject({ handoff: null, handoffRefused: "handoff_refused" });
    expect((await H(req("GET", "/messages", { bearer: onward.body.tokens.accessToken }), deps)).status).toBe(403);
  });

  it("makes a full session with no step-up time, of the phone's kind, under the composed label, child of the phone", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    const key = proofKey();
    const { body } = await handOff(deps, phone.tokens.refreshToken, key.challenge, "ohmail");
    const res = await redeem(deps, body.handoff!.token, key.verifier, "mobile-android");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const answer = await res.json();
    expect(answer.grant).toBe("app-handoff");
    const [born] = await db.select().from(sessions).where(eq(sessions.accessTokenHash, hashToken(answer.tokens.accessToken)));
    expect(born).toMatchObject({ scope: "full", lastTwofaAt: null, userId: phone.owner.userId });
    const [device] = await db.select().from(devices).where(eq(devices.id, born!.deviceId!));
    expect(device).toMatchObject({ kind: "mobile-android", label: "ohmail · Pixel", handedOffFrom: phone.deviceId });
    // Listed in Devices beside the phone.
    const listed = await (await H(req("GET", "/devices", { bearer: answer.tokens.accessToken }), deps)).json();
    expect(listed.items.map((d: { label: string }) => d.label).sort()).toEqual(expect.arrayContaining(["Pixel", "ohmail · Pixel"]));
  });

  it("burns nothing for a wrong verifier, the code at the plain redeem, a QR code at this arm, or a computer's kind", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    const key = proofKey();
    const { body } = await handOff(deps, phone.tokens.refreshToken, key.challenge);
    const code = body.handoff!.token;
    const wrong = await redeem(deps, code, proofKey().verifier);
    expect([wrong.status, (await wrong.json()).error.code]).toEqual([400, "pairing_invalid"]);
    const plain = await H(post("/pair/redeem", { grant: "device-pair", token: code, kind: "mobile-ios" }), deps);
    expect((await plain.json()).error.code).toBe("pairing_invalid");
    expect((await redeem(deps, code, key.verifier, "desktop-linux")).status).toBe(400);
    const qr = await (await H(post("/pair", { grant: "device-pair" }, phone.owner.token), deps)).json();
    expect((await (await redeem(deps, qr.token, key.verifier)).json()).error.code).toBe("pairing_invalid");
    expect((await H(post("/pair/redeem", { grant: "device-pair", token: qr.token }), deps)).status).toBe(200);
    // The code survived every refusal: its own verifier still spends it, once.
    expect((await redeem(deps, code, key.verifier)).status).toBe(200);
    expect((await (await redeem(deps, code, key.verifier)).json()).error.code).toBe("pairing_invalid");
  });

  it("refuses a code past its minute, and one whose minting session has ended", async () => {
    const { db, deps, clock } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    const late = proofKey();
    const first = await handOff(deps, phone.tokens.refreshToken, late.challenge);
    clock.advance(61_000);
    expect((await (await redeem(deps, first.body.handoff!.token, late.verifier)).json()).error.code).toBe("pairing_invalid");
    const orphan = proofKey();
    const second = await handOff(deps, first.body.tokens.refreshToken, orphan.challenge);
    await db.update(sessions).set({ revokedAt: clock.now() }).where(eq(sessions.deviceId, phone.deviceId));
    expect((await (await redeem(deps, second.body.handoff!.token, orphan.verifier)).json()).error.code).toBe("pairing_invalid");
  });

  it("answers 409 to a request carrying another account's session, and burns nothing", async () => {
    const { db, deps } = await makeDeps();
    const phone = await pairedPhone(db, deps);
    const stranger = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const key = proofKey();
    const { body } = await handOff(deps, phone.tokens.refreshToken, key.challenge);
    const crossed = await redeem(deps, body.handoff!.token, key.verifier, "mobile-ios", stranger.token);
    expect(crossed.status).toBe(409);
    expect((await redeem(deps, body.handoff!.token, key.verifier)).status).toBe(200);
  });
});

describe("the lineage: what a phone handed its sign-in to ends with it", () => {
  async function family() {
    const made = await makeDeps();
    const { db, deps } = made;
    const phone = await pairedPhone(db, deps);
    const key = proofKey();
    const minted = await handOff(deps, phone.tokens.refreshToken, key.challenge, "ohmail");
    const child = (await (await redeem(deps, minted.body.handoff!.token, key.verifier)).json()).tokens as Tokens;
    const grandKey = proofKey();
    const fromChild = await handOff(deps, child.refreshToken, grandKey.challenge, "ohcal");
    const grandchild = (await (await redeem(deps, fromChild.body.handoff!.token, grandKey.verifier)).json()).tokens as Tokens;
    const live = async (t: { accessToken: string }) =>
      (await db.select({ revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.accessTokenHash, hashToken(t.accessToken))))[0]!.revokedAt === null;
    return { ...made, phone, rotated: minted.body.tokens, child: fromChild.body.tokens, grandchild, live };
  }

  /** A wake registration of the phone's and one of the app it handed off to, each stamped with its device. */
  async function wakeRows(f: Awaited<ReturnType<typeof family>>): Promise<string[]> {
    const rows = await f.db.insert(pushSubscriptions).values([f.phone.deviceId, await deviceOf(f.deps, f.child.accessToken)].map((deviceId) => ({
      accountId: f.phone.owner.accountId, transport: "unifiedpush", endpoint: `https://wake.example.test/${deviceId}`, deviceId,
    }))).returning();
    return rows.map((r) => r.id);
  }
  const wakeLeft = async (f: Awaited<ReturnType<typeof family>>, ids: string[]) =>
    (await f.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(inArray(pushSubscriptions.id, ids))).length;

  it("a replayed spent refresh token sweeps the phone, the app it handed off to, and the one that one handed off to", async () => {
    const f = await family();
    const { db, deps, phone, rotated, child, grandchild, live } = f;
    const woken = await wakeRows(f);
    const replay = await H(post("/auth/refresh", { refreshToken: phone.tokens.refreshToken }), deps);
    expect(replay.status).toBe(401);
    expect([await live(rotated), await live(child), await live(grandchild)]).toEqual([false, false, false]);
    // The sweep's record says how many signed-in apps it ended with the family.
    const rows = await db.execute(sql`select device from auth_events where event = 'refresh_reuse_revoked'`);
    const details = (Array.isArray(rows) ? rows : (rows as { rows: { device: string }[] }).rows).map((r) => (r as { device: string }).device);
    expect(details).toEqual([expect.stringMatching(/ handed_off=2$/)]);
    // Their wake registrations go with them: nothing wakes an app the theft ended.
    expect(await wakeLeft(f, woken)).toBe(0);
  });

  it("the redo-alone arm of a sweep ends the children too", async () => {
    const f = await family();
    const { db, deps, phone, rotated, child, live } = f;
    const woken = await wakeRows(f);
    // The sweep's transaction cannot commit when its trail row is refused: the sweep is redone alone.
    await db.execute(sql.raw(`ALTER TABLE "auth_events" ADD CONSTRAINT "no_trail" CHECK ("event" <> 'refresh_reuse_revoked')`));
    expect((await H(post("/auth/refresh", { refreshToken: phone.tokens.refreshToken }), deps)).status).toBe(401);
    expect([await live(rotated), await live(child)]).toEqual([false, false]);
    expect(await wakeLeft(f, woken)).toBe(0);
  });

  it("a take-back of the phone in Devices takes its children; the child's own take-back and sign-out leave the phone", async () => {
    const { deps, phone, rotated, child, grandchild, live } = await family();
    const childDevice = await deviceOf(deps, child.accessToken);
    expect((await H(post("/auth/logout", { refreshToken: grandchild.refreshToken }, grandchild.accessToken), deps)).status).toBeLessThan(300);
    expect([await live(rotated), await live(child)]).toEqual([true, true]);
    expect((await H(req("DELETE", `/devices/${childDevice}`, { bearer: phone.owner.token }), deps)).status).toBe(204);
    expect([await live(rotated), await live(child)]).toEqual([true, false]);
    const again = await family();
    expect((await H(req("DELETE", `/devices/${again.phone.deviceId}`, { bearer: again.phone.owner.token }), again.deps)).status).toBe(204);
    expect([await again.live(again.rotated), await again.live(again.child), await again.live(again.grandchild)]).toEqual([false, false, false]);
  });

  async function deviceOf(deps: ApiDeps, accessToken: string): Promise<string> {
    const listed = await (await H(req("GET", "/devices", { bearer: accessToken }), deps)).json();
    return listed.items.find((d: { current?: boolean }) => d.current)?.id;
  }
});

describe("nothing secret of a switch is logged", () => {
  it("holds no code, verifier or challenge in any line the server writes", async () => {
    const { db, deps } = await makeDeps();
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v)));
    const logger: Record<string, unknown> = { info: record, warn: record, error: record, debug: record };
    logger.child = () => logger;
    const logged = { ...deps, logger } as unknown as ApiDeps;
    const phone = await pairedPhone(db, logged);
    const key = proofKey();
    const { body } = await handOff(logged, phone.tokens.refreshToken, key.challenge);
    await redeem(logged, body.handoff!.token, proofKey().verifier);
    await redeem(logged, body.handoff!.token, key.verifier);
    const secrets = [body.handoff!.token, key.verifier, key.challenge, phone.tokens.refreshToken, body.tokens.refreshToken];
    for (const secret of secrets) expect(lines.join("\n")).not.toContain(secret);
  });
});
