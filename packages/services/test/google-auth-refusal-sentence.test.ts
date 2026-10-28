import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { GOOGLE_AUTH_HINTS } from "@trafficflow/core/adapters/imap";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";
import { GOOGLE_AUTH_REFUSAL, launchRefused } from "../src/mailbox-service.js";

/**
 * GOOGLE'S REFUSED SIGN-IN SAYS WHY. The probe's `authHint` (Google's hosts, `auth` only) becomes
 * Google's sentence and `details.authHint`; without one every refusal is today's, byte for byte.
 */

const NOW = new Date("2026-10-23T08:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });

type Verdict = { verdict: "ok" } | { verdict: "refuse"; code: "auth" | "connect"; authHint?: string; localServer?: true };
interface Refused { code: string; message: string; details: Record<string, unknown> }
const OK: Verdict = { verdict: "ok" };

let ctx: ServiceContext;
beforeAll(async () => {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "google-refusal" }).returning();
  ctx = { db, accountId: a!.id, userId: null, now: () => NOW, requestId: randomUUID() };
});

const caught = async (run: () => Promise<unknown>): Promise<Refused | null> => {
  try {
    await run();
    return null;
  } catch (err) {
    const e = err as { code?: unknown; message: string; details?: Record<string, unknown> };
    return { code: String(e.code), message: e.message, details: e.details ?? {} };
  }
};
const connect = (imap: Verdict) => caught(() => svc.create(ctx, {
  provider: "gmail", address: `g-${randomUUID()}@example.test`,
  imap: { host: "imap.gmail.com", port: 993, secure: true, user: "u", pass: "p" },
  smtp: { host: "smtp.gmail.com", port: 465, secure: true },
}, { probe: async () => imap, smtpProbe: async () => OK } as never));
const test = (imap: Verdict) => caught(() => svc.probeConnection(ctx, {
  address: "someone@example.test", imap: { host: "imap.gmail.com", port: 993, secure: true, pass: "p" },
}, { probe: async () => imap } as never));

describe("Google's sentences", () => {
  it("one per hint, each naming Google and none the generic app-specific line", () => {
    expect(Object.keys(GOOGLE_AUTH_REFUSAL).sort()).toEqual([...GOOGLE_AUTH_HINTS].sort());
    for (const h of GOOGLE_AUTH_HINTS) expect(GOOGLE_AUTH_REFUSAL[h], h).toMatch(/Google/);
    expect(GOOGLE_AUTH_REFUSAL.app_password_required).toMatch(/2-Step Verification/);
    expect(GOOGLE_AUTH_REFUSAL.app_password_required).toMatch(/with or without the spaces/);
    expect(GOOGLE_AUTH_REFUSAL.app_password_required).toMatch(/cannot connect those yet/);
    // Accounts that cannot create an App Password hear it on either refusal, with the way out.
    for (const h of ["app_password_required", "invalid"] as const) {
      expect(GOOGLE_AUTH_REFUSAL[h], h).toMatch(/Advanced Protection/);
      expect(GOOGLE_AUTH_REFUSAL[h], h).toMatch(/accounts that sign in with security keys only/);
      expect(GOOGLE_AUTH_REFUSAL[h], h).toMatch(/ask your administrator to allow (App Passwords|them), or connect another address\.$/);
    }
    expect(GOOGLE_AUTH_REFUSAL.web_login).toMatch(/password may be right/);
    expect(GOOGLE_AUTH_REFUSAL.imap_disabled).toMatch(/password may be right/);
  });
});

describe("connect and Test carry the hint", () => {
  for (const hint of GOOGLE_AUTH_HINTS) {
    it(`${hint}: Google's sentence and details.authHint, on connect and on Test`, async () => {
      for (const r of [await connect({ verdict: "refuse", code: "auth", authHint: hint }), await test({ verdict: "refuse", code: "auth", authHint: hint })]) {
        expect(r?.code).toBe("mailbox_probe_failed");
        expect(r?.message).toBe(GOOGLE_AUTH_REFUSAL[hint]);
        expect(r?.details).toEqual({ reason: "auth", transport: "imap", authHint: hint });
      }
    });
  }

  it("control: no hint is today's refusal, byte for byte", async () => {
    for (const r of [await connect({ verdict: "refuse", code: "auth" }), await test({ verdict: "refuse", code: "auth" })]) {
      expect(r?.details).toEqual({ reason: "auth", transport: "imap" });
      expect(r?.message).toMatch(/^The mail server refused this password\. If your provider requires an app-specific password/);
    }
  });

  it("control: a hint the closed set does not hold is not said", async () => {
    const r = await connect({ verdict: "refuse", code: "auth", authHint: "something_else" });
    expect(r?.details).toEqual({ reason: "auth", transport: "imap" });
    expect(r?.message).toMatch(/^The mail server refused this password\./);
  });
});

describe("Sign in again's refusal", () => {
  it("launchRefused with a hint says Google's sentence; without one it is today's", () => {
    const hinted = launchRefused("auth", false, "invalid") as unknown as Refused;
    expect(hinted.message).toBe(GOOGLE_AUTH_REFUSAL.invalid);
    expect(hinted.details).toEqual({ reason: "auth", transport: "imap", authHint: "invalid" });
    const plain = launchRefused("auth") as unknown as Refused;
    expect(plain.details).toEqual({ reason: "auth", transport: "imap" });
    expect(launchRefused("auth", false, null)).toEqual(launchRefused("auth"));
    expect((launchRefused("tls", false, "invalid") as unknown as Refused).details).toEqual({ reason: "tls", transport: "imap" });
  });
});
