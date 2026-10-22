// @services: none — its Postgres URL is never dialed
import { describe, it, expect } from "vitest";
import { MailService } from "@trafficflow/services";
import { loadServerConfig } from "../src/config.js";
import { customerMailerFor } from "../src/deps.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE CUSTOMER-MAILER SEAM: `cfg.smtp` → `MailService` over `SmtpMailer`, or `null` — and on
 * THIS host an unusable block REFUSES THE BOOT (config.ts's grammar) instead of degrading, which
 * is the deliberate inversion of the managed composition's cannot-throw rule. The refusal must
 * name the variables and never a value: `SMTP_URL` embeds a credential.
 */

const BASE = {
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: "postgres://tf:tf@localhost:5433/never_dialed",
  [KEY_RING_V1]: "ab".repeat(32),
};

const cfgWith = (extra: Record<string, string>) =>
  loadServerConfig({ ...BASE, ...extra } as NodeJS.ProcessEnv);

describe("customerMailerFor", () => {
  it("no SMTP block ⇒ null — the working no-mailer configuration, not an error", () => {
    expect(cfgWith({}).smtp).toBeNull();
    expect(customerMailerFor(cfgWith({}))).toBeNull();
  });

  it("a full block ⇒ a MailService (the policy layer — never the bare port)", () => {
    const mail = customerMailerFor(cfgWith({
      SMTP_URL: "smtp://127.0.0.1:2525",
      MAIL_FROM: "ohmail <no-reply@mail.example.com>",
      MAIL_REPLY_TO: "owner@mail.example.com",
    }));
    expect(mail).toBeInstanceOf(MailService);
  });

  it("an injectable MAIL_FROM refuses the BOOT, naming the variables and echoing nothing", () => {
    const cfg = cfgWith({
      SMTP_URL: "smtp://user:sekretpass@127.0.0.1:2525",
      MAIL_FROM: "a@b.example\r\nBcc: y@z.example",
    });
    let thrown: Error | null = null;
    try {
      customerMailerFor(cfg);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/SMTP_URL and MAIL_FROM/);
    expect(thrown!.message).not.toContain("sekretpass");
    expect(thrown!.message).not.toContain("b.example");
  });

  it("the zero-external-requests guard reaches through the seam: a non-loopback host refuses under vitest", () => {
    const cfg = cfgWith({
      SMTP_URL: "smtps://mailer:pw@smtp.example.net:465",
      MAIL_FROM: "no-reply@mail.example.com",
    });
    expect(() => customerMailerFor(cfg)).toThrow(/loopback/);
  });
});

/**
 * REVIEW FIX, shown red first: every loopback origin the AUTH validator accepts must also be a
 * link base the mail service accepts. `http://[::1]:8080` and `http://app.localhost:3000` boot
 * this server's auth fine, so an operator running one of them with a valid SMTP block must get a
 * working mailer — not a boot refusal blaming SMTP_URL/MAIL_FROM for an origin auth already
 * admitted.
 */
describe("customerMailerFor accepts every auth-valid loopback origin", () => {
  it.each(["http://[::1]:8080", "http://app.localhost:3000"])("%s + a valid SMTP block ⇒ a mailer", (origin) => {
    const mail = customerMailerFor(cfgWith({
      OHMAIL_ORIGIN: origin,
      SMTP_URL: "smtp://127.0.0.1:2525",
      MAIL_FROM: "no-reply@mail.example.com",
    }));
    expect(mail).toBeInstanceOf(MailService);
  });
});
