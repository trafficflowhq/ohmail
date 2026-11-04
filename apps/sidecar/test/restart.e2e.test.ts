import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import { mailboxCredentials, messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";

/**
 * A LOCAL INSTALL SURVIVES A RESTART — the acceptance for the persisted key-encryption key.
 *
 * The engine used to mint a key-encryption key per launch. That was safe only while nothing
 * encrypted was ever written down, which is why the headless end-to-end pinned
 * `mailbox_credentials` EMPTY: a credential sealed under a key that dies with the process is a
 * mailbox the user cannot reconnect to after a restart. Credential entry makes that pin false,
 * so this file is where the pin's meaning moves to — the table is no longer empty, and what is
 * asserted instead is that the row survives a restart, that its ciphertext is not the password,
 * and that losing the key is recoverable rather than terminal.
 *
 * ── THE SHAPE OF THE ACCEPTANCE ────────────────────────────────────────────────────────────
 *
 * A restart, not a unit test of key material. Every case here stands up a real engine on a real
 * on-disk database against a real IMAP server, stops it the way the shell stops it, and stands a
 * SECOND engine up on the same directory — because the defect being fixed is invisible to any
 * test that keeps one process alive. `apps/sidecar/test/sidecar.e2e.test.ts` explains why the
 * server is GreenMail and not a fake.
 *
 * The second launch is deliberately given NO password. That is the entire point: the shell holds
 * one key and the database holds the credential, so a launch that carries no secret in its
 * environment must still be able to open the mailbox.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);

/** A fresh GreenMail user per test → a mailbox nothing else has touched. */
function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

/** A per-install key, as the shell's keystore would hand it over. Never written to disk here. */
function aKek(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}

function eml(o: { from: string; to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`,
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello — we have not met before.",
  ].join("\r\n");
}

interface Launch {
  sidecar: Sidecar;
  host: StdioHost;
  client: StdioClient;
}

const openLaunches: Launch[] = [];
const dataDirs: string[] = [];
const rawClients: ImapFlow[] = [];

afterEach(async () => {
  for (const l of openLaunches.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const c of rawClients.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface LaunchOptions {
  dataDir: string;
  cfg: ReturnType<typeof greenmail>;
  /** The keystore's per-install key. Omitted ⇒ the engine has no durable key this launch. */
  keks?: Record<number, Buffer>;
  /** Omitted ⇒ the environment carries NO password, which is the steady state after first run. */
  pass?: string;
  /**
   * Intercept the resolved connection instead of dialling GreenMail.
   *
   * Needed for exactly one thing, and it is a limitation of the SERVER rather than a preference:
   * `docker-compose.yml` runs GreenMail with `-Dgreenmail.auth.disabled`, so it accepts every
   * password and a test cannot tell two apart by whether the login succeeds. Which password the
   * engine chose is therefore observed where the choice is actually made — the config handed to
   * the adapter.
   */
  adapterFactory?: (cfg: { auth: { user: string; pass: string } }) => unknown;
}

/**
 * One launch of the engine on `dataDir`, with a client on the other end of a pipe pair.
 *
 * `PassThrough`s stand in for the pipes a spawned child would get; the bytes are the same. The
 * launch is registered for teardown immediately, so a failing assertion still releases the data
 * directory lock — two engines on one directory is the one thing that corrupts it.
 */
async function launch(opts: LaunchOptions): Promise<Launch> {
  const sidecar = await createSidecar({
    dataDir: opts.dataDir,
    imap: {
      ...opts.cfg,
      auth: { user: opts.cfg.auth.user, ...(opts.pass === undefined ? {} : { pass: opts.pass }) },
    },
    address: opts.cfg.auth.user,
    displayName: "This Mac",
    ...(opts.keks ? { keks: opts.keks } : {}),
    ...(opts.adapterFactory
      ? { adapterFactory: opts.adapterFactory as unknown as SidecarConfig["adapterFactory"] }
      : {}),
    // Long enough that the poll never fires during a test — every cycle here is one the test
    // asked for, so a passing assertion is never a coincidence of timing.
    pollIntervalMs: 60 * 60 * 1000,
  });

  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    credentialState: await sidecar.credentialState(),
  });

  const l: Launch = { sidecar, host, client };
  openLaunches.push(l);
  return l;
}

/** Stop a launch the way the shell does, and take it off the teardown list. */
async function shutdown(l: Launch): Promise<void> {
  const i = openLaunches.indexOf(l);
  if (i >= 0) openLaunches.splice(i, 1);
  l.client.close();
  l.host.stop();
  await l.sidecar.stop();
}

function freshDataDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-restart-"));
  dataDirs.push(d);
  return d;
}

/**
 * ENTER THE CREDENTIAL THE WAY THE SHELL WILL — over the bridge, through the same
 * `PATCH /mailboxes/:id` the Cloud client uses. Not a direct insert: the point of the slice is
 * that credential entry and Cloud's credential entry are one code path, so the test drives the
 * one the product drives.
 */
async function enterCredential(l: Launch, cfg: ReturnType<typeof greenmail>): Promise<Response> {
  return l.client.fetch(`/mailboxes/${l.sidecar.world.mailboxId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${l.sidecar.sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      imap: {
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        user: cfg.auth.user, pass: cfg.auth.pass,
      },
    }),
  });
}

/** What `/health` publishes about the key ring — never the key itself. */
async function readKek(l: Launch): Promise<{ active: number; count: number; fingerprint: string } | null> {
  const res = await l.client.fetch("/health");
  const body = await res.json() as {
    ok: boolean; schemaOk: boolean;
    schemaMarkers: { found: number; expected: number };
    kek: { active: number; count: number; fingerprint: string } | null;
  };
  /**
   * **A LOCAL INSTALL IS HEALTHY, AND IT RAN ONE JOURNAL.**
   *
   * Asserted here rather than in a test of its own because this is the only place a REAL engine
   * process answers `/health` — and the failure it guards is silent in the worst way. The engine
   * migrates the mail journal alone, so it has no `credit_ledger` and no `staff_users`; probed
   * against the hosted marker set it answers `503 schema_incomplete` on every request for ever,
   * about a database that is complete for what it is. `HealthConfig.schemaTier` is what makes the
   * probe ask the right question, and pinning `found === expected` is what stops the answer from
   * being right by accident — a probe that found nothing at all would satisfy `ok` alone.
   */
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.schemaOk, "a mail-only install reported an incomplete schema").toBe(true);
  expect(body.schemaMarkers.found).toBe(body.schemaMarkers.expected);
  expect(body.schemaMarkers.found).toBeGreaterThan(0);
  return body.kek;
}

/** Deliver one message to the user's real mailbox, as a stranger would. */
async function deliver(cfg: ReturnType<typeof greenmail>, subject: string, messageId: string): Promise<void> {
  const raw = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await raw.connect();
  rawClients.push(raw);
  await raw.append("INBOX", eml({
    from: "stranger@example.test", to: cfg.auth.user, subject, messageId,
  }));
}

describe("the local engine survives a restart", () => {
  it(
    "keeps the credential across a restart, and the second launch carries no password at all",
    async () => {
      const cfg = greenmail();
      const dataDir = freshDataDir();
      const keks = { 1: aKek() };

      // ── LAUNCH ONE: first run. The shell passes the password once. ────────────────────────
      const first = await launch({ dataDir, cfg, keks, pass: cfg.auth.pass });
      const entered = await enterCredential(first, cfg);
      expect(entered.status, await entered.clone().text()).toBe(200);

      const stored = await first.sidecar.db.select().from(mailboxCredentials)
        .where(eq(mailboxCredentials.mailboxId, first.sidecar.world.mailboxId));
      expect(stored).toHaveLength(1);
      // The row is a SEALED envelope, not a password with extra steps.
      expect(stored[0]!.secretEnc).not.toContain(cfg.auth.pass);
      expect(stored[0]!.keyVersion).toBe(1);

      await deliver(cfg, "First contact", `restart-1-${randomUUID()}@example.test`);
      await first.sidecar.start();
      const beforeRestart = await first.sidecar.db.select().from(messages);
      expect(beforeRestart.length).toBeGreaterThan(0);

      await shutdown(first);

      // ── LAUNCH TWO: the steady state. Environment holds the KEY, database holds the SECRET.
      // `pass` is deliberately absent: this is the assertion the whole slice exists for.
      const second = await launch({ dataDir, cfg, keks });
      expect(await second.sidecar.credentialState()).toBe("ready");

      // A message that arrived while the app was closed proves the SECOND launch really opened
      // the mailbox, rather than merely finding the first launch's rows still on disk.
      await deliver(cfg, "While you were away", `restart-2-${randomUUID()}@example.test`);
      await second.sidecar.start();
      await second.sidecar.syncUntilQuiet();

      const afterRestart = await second.sidecar.db.select().from(messages);
      expect(afterRestart.length).toBeGreaterThan(beforeRestart.length);
    },
    180_000,
  );

  it(
    "the STORED password outranks one left in the environment",
    async () => {
      /**
       * The precedence rule, and it is the hosted worker's: an environment variable SEEDS a
       * credential once and never overwrites a stored one. Without it a stale password in a
       * launch script silently outranks the one the user actually typed, and the mailbox stops
       * opening for a reason nothing on screen could explain.
       *
       * ── WHY THIS ASSERTS ON THE CONFIG AND NOT ON A LOGIN ─────────────────────────────────
       *
       * The obvious test — store a good password, put a bad one in the environment, see whether
       * the mailbox opens — CANNOT WORK HERE, and it was written that way first. GreenMail runs
       * with `-Dgreenmail.auth.disabled` (`docker-compose.yml`), so it accepts every password and
       * both branches connect happily. That version of this test passed while the rule it claimed
       * to check was inverted; the inversion was caught by mutating the source and watching this
       * file stay green.
       *
       * So the observation moved to where the decision is: the connection config the engine hands
       * its adapter. That is the value the real `ImapAdapter` would log in with, and it is knowable
       * without a server that checks passwords.
       */
      const cfg = greenmail();
      const dataDir = freshDataDir();
      const keks = { 1: aKek() };
      const storedPass = "keyed-in-password";
      const stalePass = "stale-launcher-password";

      const first = await launch({ dataDir, cfg, keks, pass: storedPass });
      expect((await enterCredential(first, { ...cfg, auth: { ...cfg.auth, pass: storedPass } })).status).toBe(200);
      await shutdown(first);

      let handed: string | null = null;
      const second = await launch({
        dataDir, cfg, keks, pass: stalePass,
        adapterFactory: (c) => {
          handed = c.auth.pass;
          return { close: async () => undefined };
        },
      });
      expect(await second.sidecar.credentialState()).toBe("ready");
      expect(handed).toBe(storedPass);
      expect(handed).not.toBe(stalePass);
    },
    180_000,
  );

  it(
    "/health publishes the key ring's identity, and a rotation moves it",
    async () => {
      /**
       * Rotation has to be observable from outside the process, or "the key was replaced" is a
       * claim nobody can check. This is the hosted service's own `{ active, count, fingerprint }`
       * — a digest and two integers, never key material — so an operator comparing a desktop
       * install with a Cloud account reads one vocabulary rather than two.
       */
      const cfg = greenmail();
      const dataDir = freshDataDir();
      const v1 = aKek();

      const before = await readKek(await launch({ dataDir, cfg, keks: { 1: v1 }, pass: cfg.auth.pass }));
      expect(before).toMatchObject({ active: 1, count: 1 });
      expect(before!.fingerprint).toMatch(/^[0-9a-f]{8}$/);

      const after = await readKek(await launch({ dataDir: freshDataDir(), cfg, keks: { 1: v1, 2: aKek() } }));
      expect(after).toMatchObject({ active: 2, count: 2 });
      // The ring changed, so the fingerprint must have. A fingerprint of the ACTIVE key alone
      // could not tell these two apart from a host that had merely dropped v1.
      expect(after!.fingerprint).not.toBe(before!.fingerprint);

      // No key material, in any encoding, anywhere in the published body.
      const body = JSON.stringify(after);
      expect(body).not.toContain(v1.toString("hex"));
      expect(body).not.toContain(v1.toString("base64url"));
    },
    180_000,
  );

  it(
    "a launch with no durable key seals NOTHING, so a restart cannot find an unreadable row",
    async () => {
      /**
       * The original pin, moved rather than deleted. `sidecar.e2e.test.ts` asserted
       * `mailbox_credentials` was empty because the key was per-launch; the rule that replaces it
       * is narrower and stronger — a per-launch key may not seal anything to disk, ever. An
       * install with no keystore behind it keeps working exactly as it does today (the shell
       * passes the password every launch) and writes nothing it will not be able to read.
       */
      const cfg = greenmail();
      const dataDir = freshDataDir();

      const l = await launch({ dataDir, cfg, pass: cfg.auth.pass });
      const res = await enterCredential(l, cfg);
      // Refused, and refused LOUDLY. A silent skip would answer 200 to a shell that then
      // believes the password is stored and stops passing it.
      expect(res.status).toBe(503);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("install_key_absent");

      expect(await l.sidecar.db.select().from(mailboxCredentials)).toEqual([]);
    },
    180_000,
  );

  it(
    "a LOST key is recoverable: the mirror is intact, and re-entering the password restores it",
    async () => {
      /**
       * What a lost key actually costs, measured rather than assumed.
       *
       * The key wraps `mailbox_credentials` and NOTHING else — the local mirror is an ordinary
       * unencrypted database — so losing it costs the stored password and not the mail. The
       * honest recovery is therefore to ask for the password again, and the mailbox on the
       * user's own server is untouched throughout. This asserts both halves: the mirror still
       * reads under a key that cannot open the credential, and re-entry re-seals it.
       */
      const cfg = greenmail();
      const dataDir = freshDataDir();

      const first = await launch({ dataDir, cfg, keks: { 1: aKek() }, pass: cfg.auth.pass });
      expect((await enterCredential(first, cfg)).status).toBe(200);
      await deliver(cfg, "Before the key was lost", `restart-3-${randomUUID()}@example.test`);
      await first.sidecar.start();
      const mirrored = await first.sidecar.db.select().from(messages);
      expect(mirrored.length).toBeGreaterThan(0);
      await shutdown(first);

      // A DIFFERENT key: the keystore entry was deleted and the shell minted a new one.
      const newKek = aKek();
      const second = await launch({ dataDir, cfg, keks: { 1: newKek } });

      // 1. It came up. A launch that threw here would be a mail app that a lost keystore entry
      //    turns into a permanently broken one.
      expect(await second.sidecar.credentialState()).toBe("unreadable");

      // 2. THE MIRROR IS FINE. This is the measurement — the key never protected the store.
      const stillThere = await second.sidecar.db.select().from(messages);
      expect(stillThere.map((m) => m.id).sort()).toEqual(mirrored.map((m) => m.id).sort());

      // 3. Starting is a no-op rather than a crash: the mirror keeps being served and the shell
      //    shows a password field. An EMPTY failure report and not merely a resolved promise — a
      //    mailbox with no readable credential never dials, so there is no failed launch to
      //    report, which is a different answer from "one mailbox could not be opened".
      await expect(second.sidecar.start()).resolves.toEqual({ failures: [] });

      // 4. Re-entry is the recovery, and it is the same code path as first entry.
      expect((await enterCredential(second, cfg)).status).toBe(200);
      expect(await second.sidecar.credentialState()).toBe("ready");
      await shutdown(second);

      // 5. And the recovery is DURABLE — the re-sealed row opens on the next launch, with no
      //    password in the environment. Recovering until the next restart is not recovering.
      const third = await launch({ dataDir, cfg, keks: { 1: newKek } });
      expect(await third.sidecar.credentialState()).toBe("ready");
      await third.sidecar.start();
      await third.sidecar.syncUntilQuiet();
    },
    180_000,
  );

  it(
    "rotation: a key added as v2 leaves v1 rows readable, and new writes land under v2",
    async () => {
      /**
       * The Cloud contract, on a laptop. `packages/core/src/crypto.ts`: the highest version is
       * active, every older version stays loaded so rows carrying `key_version < active` still
       * decrypt, and re-encryption is lazy. A key that cannot be rotated is a key that cannot be
       * revoked, so this is the property that makes the keystore entry replaceable.
       */
      const cfg = greenmail();
      const dataDir = freshDataDir();
      const v1 = aKek();
      const v2 = aKek();

      const first = await launch({ dataDir, cfg, keks: { 1: v1 }, pass: cfg.auth.pass });
      expect((await enterCredential(first, cfg)).status).toBe(200);
      const [rowV1] = await first.sidecar.db.select().from(mailboxCredentials);
      expect(rowV1!.keyVersion).toBe(1);
      await shutdown(first);

      // The shell adds the new key alongside the old one. Nothing is re-encrypted on the way in.
      const second = await launch({ dataDir, cfg, keks: { 1: v1, 2: v2 } });
      expect(await second.sidecar.credentialState()).toBe("ready");
      const [stillV1] = await second.sidecar.db.select().from(mailboxCredentials);
      expect(stillV1!.keyVersion).toBe(1);
      expect(stillV1!.secretEnc).toBe(rowV1!.secretEnc);

      // A NEW write goes under the active version, and only v2 can open it.
      expect((await enterCredential(second, cfg)).status).toBe(200);
      const [rowV2] = await second.sidecar.db.select().from(mailboxCredentials);
      expect(rowV2!.keyVersion).toBe(2);
      expect(await StaticKeyProvider.fromSecret(v2, 2).decrypt(rowV2!.secretEnc, 2)).toBe(cfg.auth.pass);

      await shutdown(second);

      // Retiring v1 is now safe for this row, which is what "rotation happened" means.
      const third = await launch({ dataDir, cfg, keks: { 2: v2 } });
      expect(await third.sidecar.credentialState()).toBe("ready");
    },
    180_000,
  );

  it(
    "a credential write lands while a sync drain is in flight",
    async () => {
      /**
       * PGlite IS PRODUCTION HERE, and it is one connection while the bridge dispatches
       * concurrently. `MailboxService.update` takes a row lock in a transaction; the sync loop
       * writes on the same handle. PGlite's transaction takes an exclusive lock, so the two
       * SERIALIZE rather than interleave — but nothing had ever exercised the pair on a local
       * install, and "serialize" and "deadlock" look identical until someone runs it.
       */
      const cfg = greenmail();
      const dataDir = freshDataDir();

      const l = await launch({ dataDir, cfg, keks: { 1: aKek() }, pass: cfg.auth.pass });
      expect((await enterCredential(l, cfg)).status).toBe(200);
      await deliver(cfg, "Under load", `restart-4-${randomUUID()}@example.test`);
      await l.sidecar.start();

      // Both at once, on one PGlite connection, with no await between them.
      const drain = l.sidecar.syncUntilQuiet();
      const write = enterCredential(l, cfg);
      const [cycles, res] = await Promise.all([drain, write]);

      expect(res.status).toBe(200);
      expect(cycles).toBeGreaterThanOrEqual(0);
      const [row] = await l.sidecar.db.select().from(mailboxCredentials);
      expect(row!.secretEnc).not.toContain(cfg.auth.pass);
    },
    180_000,
  );
});
