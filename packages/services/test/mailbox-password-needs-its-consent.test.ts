import { randomUUID } from "node:crypto";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * A PASSWORD PATCH NAMING AN OAUTH MAILBOX IS REFUSED BY NAME AT THE SERVICE. The row's credential
 * is a refresh token under `meta.authType: "oauth2"`; `update()` used to dial the typed password
 * and store it there, where the organizer reads it as a token. The web form hides Edit on such a
 * row and that was the only guard. Refused before the dial, and again under the row lock.
 */

const NOW = new Date("2026-09-29T01:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });
const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-password-needs-its-consent") };
const OAUTH = {
  provider: "microsoft", tenant: "common", refreshToken: "refresh-fixture", accessToken: "access-fixture",
  imap: { host: "outlook.office365.example", port: 993, secure: true },
};

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(db: Db): Promise<ServiceContext> {
  const [a] = await db.insert(accounts).values({ name: "oauth-password" }).returning();
  return { db, accountId: a!.id, userId: null, now: () => NOW, requestId: randomUUID() };
}

/** A probe double that counts its dials, and may act on the database while it "dials". */
function probe(during?: () => Promise<void>): { dials: () => number; opts: { probe: () => Promise<{ verdict: "ok" }> } } {
  let n = 0;
  return {
    dials: () => n,
    opts: { probe: async () => { n += 1; await during?.(); return { verdict: "ok" as const }; } },
  };
}

const secretsOf = async (db: Db, id: string): Promise<string> => JSON.stringify(
  (await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id)))
    .map((r) => [r.transport, r.secretEnc]).sort(),
);

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return { code: String((err as { code?: unknown }).code), message: (err as Error).message };
  }
}

describe("a password onto a mailbox that signs in with OAuth", () => {
  it("is refused by name before anything is dialled, and the refresh token stays", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const made = await svc.connectOAuth(ctx, { provider: "microsoft", address: "o@trafficflow.test", oauth: OAUTH }, probe().opts);
    const before = await secretsOf(db, made.mailbox.id);
    const p = probe();
    const r = await refusal(() => svc.update(ctx, made.mailbox.id, { imap: { pass: "typed-password" } }, p.opts));
    expect(r?.code, "the password PATCH onto an OAuth row was admitted").toBe("mailbox_signs_in_with_oauth");
    expect(r?.message).toBe(
      "This mailbox signs in with Microsoft, so it takes no password. Reconnect it from Settings → Mailboxes.",
    );
    expect(p.dials(), "the typed password was dialled against an OAuth row").toBe(0);
    expect(await secretsOf(db, made.mailbox.id), "the refresh token was replaced").toBe(before);
  });

  it("an outgoing password is refused the same way, with or without a submission probe", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const made = await svc.connectOAuth(ctx, { provider: "microsoft", address: "s@trafficflow.test", oauth: OAUTH }, probe().opts);
    const before = await secretsOf(db, made.mailbox.id);
    let smtpDials = 0;
    const smtpProbe = async () => { smtpDials += 1; return { verdict: "ok" as const }; };
    const probed = await refusal(() => svc.update(ctx, made.mailbox.id, { smtp: { pass: "p" } }, { ...probe().opts, smtpProbe }));
    const bare = await refusal(() => svc.update(ctx, made.mailbox.id, { smtp: { pass: "p" } }, probe().opts));
    expect([probed?.code, bare?.code]).toEqual(["mailbox_signs_in_with_oauth", "mailbox_signs_in_with_oauth"]);
    expect(smtpDials).toBe(0);
    expect(await secretsOf(db, made.mailbox.id)).toBe(before);
  });

  it("a row read as a password mailbox and locked as OAuth is refused under the lock, nothing written", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, { provider: "imap", address: "raced@trafficflow.test", imap: IMAP }, probe().opts);
    const before = await secretsOf(db, dto.id);
    // The unlocked read before the dial sees a password row; by the transaction it is OAuth.
    const p = probe(async () => {
      await db.update(mailboxes).set({ authKind: "oauth", provider: "imap" }).where(eq(mailboxes.id, dto.id));
    });
    const r = await refusal(() => svc.update(ctx, dto.id, { imap: { pass: "new-password" }, displayName: "Renamed" }, p.opts));
    expect(p.dials(), "the fixture never reached the locked read").toBe(1);
    expect(r?.code).toBe("mailbox_signs_in_with_oauth");
    expect(r?.message).toBe(
      "This mailbox signs in through its provider, so it takes no password. Reconnect it from Settings → Mailboxes.",
    );
    expect(await secretsOf(db, dto.id), "a password was stored over the locked refusal").toBe(before);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, dto.id));
    expect(row!.displayName, "the refused PATCH still wrote the row").toBeNull();
  });

  it("CONTROL: a password mailbox takes a new password, and an OAuth row takes a rename", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, { provider: "imap", address: "plain@trafficflow.test", imap: IMAP }, probe().opts);
    const before = await secretsOf(db, dto.id);
    const p = probe();
    await svc.update(ctx, dto.id, { imap: { pass: "rotated" } }, p.opts);
    expect(p.dials()).toBe(1);
    expect(await secretsOf(db, dto.id)).not.toBe(before);

    const made = await svc.connectOAuth(ctx, { provider: "microsoft", address: "r@trafficflow.test", oauth: OAUTH }, probe().opts);
    const renamed = await svc.update(ctx, made.mailbox.id, { displayName: "Work" }, probe().opts);
    expect(renamed.displayName).toBe("Work");
  });
});

/**
 * A NEW PASSWORD ON A SERVER WITHOUT TLS IS ASKED ITS OWN CONSENT. A mailbox added with the
 * plaintext consent keeps `meta.insecureConsent`, and a password-only PATCH still dials with no
 * `allowInsecure`: the consent is taken from the dial that proves it (`mergedTransportMeta`), never
 * inherited by a new secret. The desktop's "Sign in again" then offers the consent line.
 */
describe("the plaintext consent is asked for the password that travels", () => {
  it("a stored consent is not inherited: the pass-only PATCH is refused with the offer", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const plain = { host: "mail.lan.example", port: 143, secure: false, user: "u", pass: "old", allowInsecure: true };
    const dto = await svc.create(ctx, { provider: "imap", address: "lan@trafficflow.test", imap: plain }, {
      probe: async () => ({
        verdict: "ok" as const, proven: { host: plain.host, port: 143, secure: false, insecure: true as const },
      }),
    });
    const [row] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, dto.id));
    expect((row!.meta as { insecureConsent?: unknown }).insecureConsent, "the fixture carries no stored consent").toBe(true);

    const asked: Array<boolean | undefined> = [];
    const r = await refusal(() => svc.update(ctx, dto.id, { imap: { pass: "new" } }, {
      probe: async (input: { imap: { allowInsecure?: boolean } }) => {
        asked.push(input.imap.allowInsecure);
        return input.imap.allowInsecure === true
          ? { verdict: "ok" as const, proven: { host: plain.host, port: 143, secure: false, insecure: true as const } }
          : { verdict: "refuse" as const, code: "tls" as const, tls: { kind: "tls_unavailable" as const, plaintext: "offered" as const } };
      },
    }));
    expect(asked, "the new password was dialled under the old consent").toEqual([undefined]);
    expect(r?.code).toBe("mailbox_probe_failed");

    const consented = await svc.update(ctx, dto.id, { imap: { pass: "new", allowInsecure: true } }, {
      probe: async () => ({
        verdict: "ok" as const, proven: { host: plain.host, port: 143, secure: false, insecure: true as const },
      }),
    });
    expect(consented.id, "CONTROL: the press that carries the consent is admitted").toBe(dto.id);
  });
});

/**
 * A CERTIFICATE TRUSTED FOR A SERVER ON THIS COMPUTER IS STORED FROM THE PROOF ALONE. The claim is
 * forwarded to the probe, which dials pinned; a pin a request names itself is no pin, and a later
 * proof without one rewrites it to null (the `||` merge keeps a deleted key's old value).
 */
describe("the trusted certificate a probe proved", () => {
  const SHA = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, "0")).join(":");
  const PIN = { sha256: SHA, pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" };
  const BRIDGE = { host: "127.0.0.1", port: 1143, secure: false, user: "u", pass: "bridge-password" };
  const pinOf = async (db: Db, id: string): Promise<unknown> =>
    ((await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id)))[0]!.meta as { tlsPin?: unknown }).tlsPin;

  it("is written from the proof, never from the body, and a later proof without it clears it", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const claims: Array<string | undefined> = [];
    const dto = await svc.create(ctx, {
      provider: "imap", address: "bridge@trafficflow.test",
      imap: { ...BRIDGE, trustCertificate: SHA, tlsPin: { sha256: "AA", pem: "planted" } } as never,
    }, {
      probe: async (input: { imap: { trustCertificate?: string } }) => {
        claims.push(input.imap.trustCertificate);
        return { verdict: "ok" as const, proven: { host: BRIDGE.host, port: 1143, secure: false, tlsPin: PIN } };
      },
    });
    expect(claims, "the claim never reached the probe").toEqual([SHA]);
    expect(await pinOf(db, dto.id)).toEqual(PIN);

    // A pin the request names itself is not stored, and the proof without one clears the old.
    await svc.update(ctx, dto.id, { imap: { pass: "rotated", tlsPin: { sha256: SHA, pem: "planted" } } as never }, {
      probe: async () => ({ verdict: "ok" as const, proven: { host: BRIDGE.host, port: 1143, secure: true } }),
    });
    expect(await pinOf(db, dto.id), "a stale pin outlived the proof that dropped it").toBeNull();
  });

  it("control: a body-only pin on create is not stored", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);
    const dto = await svc.create(ctx, {
      provider: "imap", address: "bridge-two@trafficflow.test", imap: { ...BRIDGE, tlsPin: PIN } as never,
    }, { probe: async () => ({ verdict: "ok" as const, proven: { host: BRIDGE.host, port: 1143, secure: false } }) });
    expect(await pinOf(db, dto.id)).toBeUndefined();
  });
});
