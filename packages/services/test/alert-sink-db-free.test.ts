import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { dbUnreadableAlert, type AlertNotifyContext } from "@trafficflow/db/cloud";
import {
  MailService, SpyMailer, dbFreeMailAlertSink, dbRecipientLimiter, memoryRecipientLimiter,
  type RecipientLimiter,
} from "../src/index.js";

/**
 * The API hosts' mail arm for the last-resort page: the ordinary sink over the same service, with
 * the recipient limiter in process memory. The ordinary arm claims an `auth_throttle` slot and
 * refuses when it cannot, which is exactly when this page is sent.
 */

const NOW = new Date("2026-10-20T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const CTX: AlertNotifyContext = { source: "api", environment: "production", now: NOW };

function service(mailer: SpyMailer): MailService {
  return new MailService({
    mailer,
    config: {
      appUrl: "https://app.ohmail.app", siteUrl: "https://ohmail.app", adminUrl: "https://admin.ohmail.app",
      supportEmail: "support@ohmail.app", operatorEmail: "ops@ohmail.example",
    },
  });
}

describe("memoryRecipientLimiter keeps the database limiter's window", () => {
  it("counts the same as dbRecipientLimiter, rolls over the same, and keys stay apart", async () => {
    const db = await makeTestDb();
    const pair: RecipientLimiter[] = [dbRecipientLimiter(db), memoryRecipientLimiter()];
    const read = async (l: RecipientLimiter): Promise<number[]> => {
      const out: number[] = [];
      for (const ms of [0, 10 * MIN, 59 * MIN]) out.push(await l.claim("k1", new Date(NOW.getTime() + ms), HOUR));
      out.push(await l.claim("k2", new Date(NOW.getTime() + 59 * MIN), HOUR));
      out.push(await l.claim("k1", new Date(NOW.getTime() + 61 * MIN), HOUR));
      out.push(await l.claim("k1", new Date(NOW.getTime() + 62 * MIN), HOUR));
      return out;
    };
    const [fromDb, fromMemory] = [await read(pair[0]!), await read(pair[1]!)];
    expect(fromMemory).toEqual([1, 2, 3, 1, 1, 2]);
    expect(fromMemory).toEqual(fromDb);
  });

  it("its key map is capped", async () => {
    const l = memoryRecipientLimiter(2);
    await l.claim("a", NOW, HOUR);
    await l.claim("b", NOW, HOUR);
    await l.claim("c", NOW, HOUR);
    expect(await l.claim("a", NOW, HOUR), "the oldest key was dropped").toBe(1);
  });
});

describe("dbFreeMailAlertSink", () => {
  it("sends with no database anywhere in scope", async () => {
    const mailer = new SpyMailer();
    const sink = dbFreeMailAlertSink(service(mailer), () => NOW);
    expect(sink).toMatchObject({ name: "mail", channel: "mail" });
    expect(await sink.notify([dbUnreadableAlert("api")], CTX)).toBe(true);
    expect(mailer.sent.map((m) => [m.to, m.template])).toEqual([["ops@ohmail.example", "operator_alert"]]);
  });

  it("keeps the hourly quota: the sixth send in an hour is refused as rate-limited", async () => {
    const mailer = new SpyMailer();
    const sink = dbFreeMailAlertSink(service(mailer), () => NOW);
    const out: unknown[] = [];
    for (let i = 0; i < 6; i++) out.push(await sink.notify([dbUnreadableAlert("api")], CTX));
    expect(out).toEqual([true, true, true, true, true, false]);
    expect(mailer.sent).toHaveLength(5);
  });

  it("a lone alert_db_unreadable keeps one key for the 6 h page window", async () => {
    const mailer = new SpyMailer();
    const svc = service(mailer);
    for (const ms of [0, 2 * HOUR, 5 * HOUR]) {
      const at = new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + ms);
      await dbFreeMailAlertSink(svc, () => at).notify([dbUnreadableAlert("api")], CTX);
    }
    const keys = mailer.sent.map((m) => m.idempotencyKey ?? "");
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size, "one key: the provider replays the first mail").toBe(1);
    await dbFreeMailAlertSink(svc, () => new Date(Date.UTC(2026, 9, 20, 6, 1, 0)))
      .notify([dbUnreadableAlert("api")], CTX);
    expect(new Set(mailer.sent.map((m) => m.idempotencyKey)).size, "the next bucket is a new key").toBe(2);
  });
});
