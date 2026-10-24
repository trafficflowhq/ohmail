import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";

/**
 * THE LOCAL ENGINE CAN SEND — end to end, through a real SMTP server.
 *
 * An earlier change wired the receive-and-organize half of the desktop tier and left the send seam open: the
 * config→env→sidecar plumbing was there (`OHMAIL_SMTP_*` → `config.imap.smtp`) but the local
 * service bag omitted `SendService`/`sendAdapter`, so `POST /drafts/:id/send` answered 500. This is
 * the acceptance for closing it: a message composed locally leaves via SMTP and lands in the test
 * server, authenticated with the DECRYPTED SEALED password rather than anything in the environment.
 *
 * Nothing below the transport is mocked. GreenMail on 3143/3025 (`docker-compose.yml`) is the real
 * IMAP+SMTP server, reached over real sockets; the real `SendService` owns the `outbound_sends`
 * reservation; the real `ImapAdapter` builds the nodemailer transporter and appends to Sent; and
 * the delivered copy is read back with a SECOND, independent IMAP client — the way a user checking
 * their own Sent folder in Apple Mail would.
 *
 * ── WHY A RESTART, AND WHY THE SECOND LAUNCH CARRIES NO PASSWORD ────────────────────────────
 *
 * The claim under test is "send authenticates with the SEALED credential, not the environment". In
 * steady state a launch carries no password at all — it lives envelope-encrypted in the local
 * store — so proving the claim means reaching that state: launch once with the password (which
 * seals it), stop, and launch again with NO password in the environment. On the second launch the
 * sealed store is the ONLY possible source of the secret.
 *
 * ── WHY THE PASSWORD IS OBSERVED ON THE CONFIG, NOT THROUGH A REJECTED LOGIN ─────────────────
 *
 * GreenMail runs with `-Dgreenmail.auth.disabled` (`docker-compose.yml`), so it accepts every
 * password — a send with the WRONG secret still lands. Which secret the engine chose is therefore
 * observed where the choice is made: the SMTP config handed to the adapter, captured through the
 * one `adapterFactory` seam. This is the same technique `restart.e2e.test.ts` uses for the IMAP
 * side, and for the same reason.
 *
 * ── MUTATION-WATCH (run by editing `engine.ts`, watching this file, restoring) ───────────────
 *
 *  · point the SMTP auth at `config.imap.auth.pass` (the environment) instead of `resolveLogin()`'s
 *    sealed password → on the second launch the environment holds nothing, so the captured
 *    `smtp.auth.pass` is no longer the sealed value and the provenance assertion goes red;
 *  · drop `sendAdapter` from the local bag → the route falls back to the hosted `makeSendAdapter`,
 *    which has no `OHMAIL_SMTP_*` to read and dials the IMAP host on 587 → the send never reaches
 *    GreenMail, `status` is `unverified` not `sent`, and the Sent-folder assertion goes red;
 *  · drop `sends` from the local bag → `POST /drafts/:id/send` answers 500 and the status-code
 *    assertion goes red.
 *
 * Docker is a hard requirement, deliberately and consistently with the other sidecar e2e tests: a
 * skip here would let the send path go quietly unexercised, which is the state it was in.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);

interface Greenmail {
  host: string; port: number; secure: false;
  auth: { user: string; pass: string };
  smtp: { host: string; port: number; secure: false };
}

/** A fresh GreenMail user per test → a mailbox nothing else has touched. */
function greenmail(): Greenmail {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
    smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false },
  };
}

/** A per-install key, as the shell's keystore would hand it over. Never written to disk here. */
function aKek(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
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
  cfg: Greenmail;
  keks?: Record<number, Buffer>;
  /** Omitted ⇒ the environment carries NO password — the steady state after first run. */
  pass?: string;
  /** Intercept the resolved connection config; see the header for why the password is read here. */
  adapterFactory?: (cfg: ImapConfig) => unknown;
}

async function launch(opts: LaunchOptions): Promise<Launch> {
  const sidecar = await createSidecar({
    dataDir: opts.dataDir,
    imap: {
      host: opts.cfg.host, port: opts.cfg.port, secure: opts.cfg.secure,
      auth: { user: opts.cfg.auth.user, ...(opts.pass === undefined ? {} : { pass: opts.pass }) },
      smtp: opts.cfg.smtp,
    },
    address: opts.cfg.auth.user,
    displayName: "This Mac",
    ...(opts.keks ? { keks: opts.keks } : {}),
    ...(opts.adapterFactory
      ? { adapterFactory: opts.adapterFactory as unknown as SidecarConfig["adapterFactory"] }
      : {}),
    // Long enough that the poll never fires during a test — every cycle here is one the test asked
    // for, so a passing assertion is never a coincidence of timing.
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
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-send-"));
  dataDirs.push(d);
  return d;
}

/** Enter the credential the way the shell will — over the bridge, through `PATCH /mailboxes/:id`. */
async function enterCredential(l: Launch, cfg: Greenmail): Promise<Response> {
  return l.client.fetch(`/mailboxes/${l.sidecar.world.mailboxId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${l.sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      imap: { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.auth.user, pass: cfg.auth.pass },
    }),
  });
}

async function createDraft(
  l: Launch, body: { subject: string; html: string; to: { name: string | null; address: string }[] },
): Promise<{ id: string }> {
  const res = await l.client.fetch("/drafts", {
    method: "POST",
    headers: { authorization: `Bearer ${l.sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ mailboxId: l.sidecar.world.mailboxId, ...body }),
  });
  expect(res.status, `create draft: ${await res.clone().text()}`).toBe(201);
  return res.json() as Promise<{ id: string }>;
}

async function sendDraft(l: Launch, draftId: string): Promise<Response> {
  return l.client.fetch(`/drafts/${draftId}/send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${l.sidecar.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": `send-${randomUUID()}`,
    },
    body: "{}",
  });
}

/** Read the raw source of the message with this Message-ID out of the user's Sent folder. */
async function sentSource(cfg: Greenmail, messageId: string): Promise<string> {
  const inner = messageId.replace(/[<>]/g, "");
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  rawClients.push(c);
  // GreenMail exposes the tree with a `.` delimiter; the resolved Sent folder is plain "Sent".
  const lock = await c.getMailboxLock("Sent");
  try {
    const uids = await c.search({ header: { "message-id": inner } }, { uid: true });
    expect(Array.isArray(uids) && uids.length, `no Sent copy for ${messageId}`).toBeTruthy();
    const uid = (uids as number[])[0]!;
    const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
    return (msg && typeof msg !== "boolean" && msg.source ? msg.source.toString() : "");
  } finally {
    lock.release();
  }
}

describe("the LOCAL engine sends, end to end against a real SMTP server", () => {
  it(
    "a locally composed message leaves via SMTP authenticated with the SEALED password, lands in Sent, and carries multipart/alternative",
    async () => {
      const cfg = greenmail();
      const dataDir = freshDataDir();
      const keks = { 1: aKek() };

      // ── LAUNCH ONE: first run. The shell passes the password once; the engine seals it. ──────
      const first = await launch({ dataDir, cfg, keks, pass: cfg.auth.pass });
      expect((await enterCredential(first, cfg)).status).toBe(200);
      // start() creates the GreenMail user and the folder tree, then drains the (empty) mailbox.
      await first.sidecar.start();
      await shutdown(first);

      // ── LAUNCH TWO: the steady state. Environment holds the KEY, database holds the SECRET, and
      //    `pass` is deliberately absent — so the only source of the SMTP password is the store.
      let capturedSmtp: NonNullable<ImapConfig["smtp"]> | null = null;
      const second = await launch({
        dataDir, cfg, keks,
        adapterFactory: (c) => {
          if (c.smtp) capturedSmtp = c.smtp;   // captured ONLY on the send path (sync has no smtp)
          return new ImapAdapter(c);
        },
      });
      expect(await second.sidecar.credentialState()).toBe("ready");

      // Compose a RICH draft (html only → the text alternative is derived), so the delivered
      // message is a genuine `multipart/alternative` rather than a single part. Kept ASCII so the
      // parts appear literally in the raw source rather than quoted-printable-encoded.
      const html = '<p>See <a href="https://a.example/q">the quote</a> here.</p>';
      const draft = await createDraft(second, {
        subject: "the quote",
        html,
        to: [{ name: null, address: "you@example.com" }],
      });

      const res = await sendDraft(second, draft.id);
      const body = await res.json() as { status: string; providerMessageId?: string };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.status).toBe("sent");
      expect(body.providerMessageId, "no Message-ID was minted for the send").toBeTruthy();

      // ── PROVENANCE: the transporter authenticated with the SEALED password (env had none), and
      //    the environment supplied only the SMTP SERVER coordinates. ─────────────────────────
      expect(capturedSmtp, "the send never built an SMTP transporter").not.toBeNull();
      const smtp = capturedSmtp!;
      expect(smtp.auth?.pass, "the send did not use the sealed password").toBe(cfg.auth.pass);
      expect(smtp.auth?.user).toBe(cfg.auth.user);
      // host/port/secure come from OHMAIL_SMTP_* (config.imap.smtp), NOT from the IMAP row.
      expect(smtp.host).toBe(SMTP_HOST);
      expect(smtp.port).toBe(SMTP_PORT);
      expect(smtp.secure).toBe(false);

      // ── THE SERVER IS THE PROOF: the message physically landed in the user's Sent folder, and
      //    it is a real two-part alternative carrying BOTH a text and an html part (encoding-
      //    independent — the part headers and the ASCII href, not the em-dash-bearing body text). ──
      const source = await sentSource(cfg, body.providerMessageId!);
      const lower = source.toLowerCase();
      expect(lower).toContain("multipart/alternative");
      expect(lower).toContain("text/plain");
      expect(lower).toContain("text/html");
      expect(source).toContain("https://a.example/q");   // the real markup went out on the html part
    },
    120_000,
  );

  /**
   * A SLOW 250 OUTLIVES THE IMAP LEG DIALLED BEFORE IT. The send's IMAP connection sits idle with
   * nothing selected while SMTP runs, and the socket deadline closes it; the Sent APPEND used to run
   * on it once and was lost. Through a relay that answers every SMTP line late, at a scaled deadline
   * (1 s): one delivery, exactly one Sent copy, the draft `sent`.
   */
  it(
    "a slow submission past the IMAP leg's idle deadline: one delivery, one Sent copy, the draft sent",
    async () => {
      const net = await import("node:net");
      const relay = net.createServer((client) => {
        const upstream = net.connect(SMTP_PORT, SMTP_HOST);
        client.on("data", (d) => upstream.write(d));
        upstream.on("data", (d) => { setTimeout(() => { if (!client.destroyed) client.write(d); }, 300); });
        const end = (): void => { client.destroy(); upstream.destroy(); };
        client.on("error", end); upstream.on("error", end);
        client.on("close", end); upstream.on("close", () => setTimeout(end, 400));
      });
      await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
      const relayPort = (relay.address() as { port: number }).port;
      try {
        const cfg = greenmail();
        const l = await launch({
          dataDir: freshDataDir(), cfg, keks: { 1: aKek() }, pass: cfg.auth.pass,
          // The send leg only (the sync dial carries no smtp): its deadline scaled, its SMTP slowed.
          adapterFactory: (c) => (c.smtp
            ? new ImapAdapter({ ...c, smtp: { ...c.smtp, port: relayPort }, timeouts: { connectionMs: 5_000, greetingMs: 5_000, socketMs: 1_000 } })
            : new ImapAdapter(c)),
        });
        expect((await enterCredential(l, cfg)).status).toBe(200);
        await l.sidecar.start();
        const draft = await createDraft(l, {
          subject: "the slow one", html: "<p>Late but whole.</p>", to: [{ name: null, address: cfg.auth.user }],
        });
        const res = await sendDraft(l, draft.id);
        const body = await res.json() as { status: string; providerMessageId?: string; sentCopy?: string };
        expect(res.status, JSON.stringify(body)).toBe(200);
        expect(body.status).toBe("sent");

        const inner = body.providerMessageId!.replace(/[<>]/g, "");
        const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
        await c.connect();
        rawClients.push(c);
        const count = async (folder: string): Promise<number> => {
          const lock = await c.getMailboxLock(folder).catch(() => null);
          if (lock === null) return 0;
          try {
            const hits = await c.search({ header: { "message-id": inner } }, { uid: true });
            return Array.isArray(hits) ? hits.length : 0;
          } finally { lock.release(); }
        };
        // A copy still being retried after the answer lands within the retry's first wait.
        for (let i = 0; i < 100 && (await count("Sent")) === 0; i += 1) await new Promise((r) => { setTimeout(r, 100); });
        expect(await count("Sent"), "exactly one Sent copy").toBe(1);
        expect(await count("INBOX"), "exactly one delivery").toBe(1);
        const after = await l.client.fetch(`/drafts/${draft.id}`, {
          headers: { authorization: `Bearer ${l.sidecar.sessionToken}` },
        });
        expect(((await after.json()) as { status: string }).status).toBe("sent");
      } finally {
        await new Promise<void>((r) => relay.close(() => r()));
      }
    },
    120_000,
  );
});
