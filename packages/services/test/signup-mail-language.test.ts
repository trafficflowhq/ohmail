import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { users } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import {
  AuthService, makeTestAuthDeps, MailService, SpyMailer, throttleKeysFor, type ServiceContext,
} from "@trafficflow/services";

/**
 * THE SIGNUP'S MAILS SPEAK THE SIGNUP'S LANGUAGE. A German signup was answered in English: the
 * verification link, and the account-exists news that is its constant-202 twin. `POST /auth/register`
 * now carries the screen's `locale` (a member of de|en, else English) and BOTH branches write their mail
 * in it, so the inbox is the only place the branches differ, exactly as before; the register RESULT stays
 * one constant value whatever the language. The resend takes the same word.
 */

const PW = "pw-correct-horse";
const NOW = new Date("2026-10-17T12:00:00.000Z");

async function harness(ttlMs?: number) {
  const db = await makeTestDb();
  const spy = new SpyMailer();
  const mail = new MailService({
    mailer: spy,
    config: {
      appUrl: "https://ohmail.app", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app",
      ...(ttlMs === undefined ? {} : { emailVerifyTtlMs: ttlMs }),
    },
    throttleKeys: throttleKeysFor(makeTestAuthDeps().keyProvider),
  });
  const deps = makeTestAuthDeps({ publicSignup: true, maxPublicRegistrationsPerWindow: 50 }, mail);
  const svc = new AuthService(deps);
  const ctx = (o: Partial<ServiceContext> = {}): ServiceContext => ({
    db, accountId: "", userId: null, now: () => NOW, requestId: "r", ip: "1.2.3.4", ...o,
  });
  const register = (email: string, locale?: unknown) =>
    svc.register(ctx(), { email, password: PW, displayName: "Stranger", ...(locale === undefined ? {} : { locale }) });
  return { db, spy, svc, ctx, register };
}

describe("the verification mail and its twin, in the signup's language", () => {
  it("de: the link mail and the account-exists news are German, and say so in their html", async () => {
    const h = await harness();
    await h.register("neu@example.com", "de");
    await h.register("neu@example.com", "de");
    const [verify, exists] = h.spy.sent;
    expect(verify!.template).toBe("email_verification");
    expect(verify!.rendered.subject).toBe("Bestätige deine E-Mail-Adresse für ohmail");
    expect(verify!.rendered.text).toContain("Öffne diesen Link: https://ohmail.app/verify-email?token=");
    expect(verify!.rendered.text).toContain("läuft in 24 Stunden ab");
    expect(verify!.rendered.html).toContain('<html lang="de">');
    expect(verify!.rendered.html).toContain("Adresse bestätigen");
    expect(exists!.template).toBe("account_exists");
    expect(exists!.rendered.subject).toBe("Du hast schon einen ohmail-Account");
    expect(exists!.rendered.html).toContain('<html lang="de">');
    expect(exists!.rendered.text).toContain("Anmelden: https://ohmail.app/login");
  });

  it("en, no word, or a word outside the set: English, as before", async () => {
    const h = await harness();
    for (const [i, locale] of (["en", undefined, "fr", 7, ["de"], "DE"] as unknown[]).entries()) {
      await h.register(`a${i}@example.com`, locale);
    }
    expect(h.spy.sent.map((s) => s.rendered.subject)).toEqual(Array(6).fill("Verify your email for ohmail"));
    expect(h.spy.sent.every((s) => s.rendered.html.includes('<html lang="en">'))).toBe(true);
    expect(h.spy.sent[0]!.rendered.text).toContain("expires in 24 hours");
  });

  it("the register RESULT is one constant value across branches AND languages", async () => {
    const h = await harness();
    const freshDe = await h.register("x@example.com", "de");
    const takenDe = await h.register("x@example.com", "de");
    const freshEn = await h.register("y@example.com", "en");
    const takenNone = await h.register("y@example.com");
    for (const out of [takenDe, freshEn, takenNone]) expect(JSON.stringify(out)).toBe(JSON.stringify(freshDe));
  });

  it("the resend takes the screen's language too", async () => {
    const h = await harness();
    await h.register("z@example.com", "en");
    const [user] = await h.db.select({ id: users.id, accountId: users.accountId }).from(users)
      .where(eq(users.email, "z@example.com"));
    const as = h.ctx({ userId: user!.id, accountId: user!.accountId });
    await h.svc.resendVerification(as, { locale: "de" });
    await h.svc.resendVerification(as);
    await h.svc.resendVerification(as, { locale: "es" });
    expect(h.spy.sent.map((s) => s.rendered.subject)).toEqual([
      "Verify your email for ohmail", "Bestätige deine E-Mail-Adresse für ohmail",
      "Verify your email for ohmail", "Verify your email for ohmail",
    ]);
  });
});

describe("the link's lifetime, said in German", () => {
  for (const [ms, de] of [
    [30 * 60_000, "30 Minuten"], [60_000, "1 Minute"], [60 * 60_000, "1 Stunde"],
    [24 * 60 * 60_000, "24 Stunden"], [72 * 60 * 60_000, "3 Tagen"],
  ] as const) {
    it(`${ms} ms reads "läuft in ${de} ab"`, async () => {
      const h = await harness(ms);
      await h.register("t@example.com", "de");
      expect(h.spy.sent[0]!.rendered.text).toContain(`läuft in ${de} ab`);
    });
  }
});
