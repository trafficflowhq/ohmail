/**
 * THE DESKTOP SEED DIALS A SERVER WITHOUT ENCRYPTION WITH ITS ROW'S CONSENT. It dialled its settings
 * file, which carries none: a consented seal was stored and never dialled (0 messages after the
 * door's relaunch) and "Sign in again" with the line ticked was refused as a "certificate". Real
 * engine, store and `ImapAdapter`; this checkout's GreenMail's plain port through a name the TLS
 * floor does not exempt (`ip6-localhost`, answered 127.0.0.1), so the floor is production's.
 */
import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { mailboxCredentials, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { HOME_NAME, osAnswers } from "../../../test/support/plaintext-wire.js";
import { serviceUp } from "@trafficflow/db/testing";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 4 });

const GM = "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);

const SERVER_UP = serviceUp("greenmail", `${GM}:${IMAP_PORT}`).up;

interface Line { event: string; detail: Record<string, unknown> }
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const N = 3;
async function seedServer(address: string, pass: string): Promise<void> {
  const seeder = new ImapFlow({ host: GM, port: IMAP_PORT, secure: false, auth: { user: address, pass }, logger: false });
  await seeder.connect();
  try {
    for (let i = 0; i < N; i++) {
      await seeder.append("INBOX", Buffer.from([
        `From: sender${i} <sender${i}@example.test>`, `To: <${address}>`, `Subject: first door ${i}`,
        `Message-ID: <first-door-${i}-${randomUUID()}@example.test>`,
        `Date: Mon, 28 Sep 2026 10:0${i}:00 +0000`, "Content-Type: text/plain; charset=utf-8", "", `body ${i}`, "",
      ].join("\r\n"), "utf8"));
    }
  } finally {
    await seeder.logout().catch(() => undefined);
  }
}

/** The engine a door's configure starts: the shell's settings, NO consent field (it has none). */
async function bootSeed(dataDir: string, address: string, keks: Record<number, Buffer>, lines: Line[],
  extra: { allowInsecure?: true } = {}, pollIntervalMs = 60 * 60 * 1000): Promise<Sidecar> {
  const s = await createSidecar({
    dataDir, address, keks,
    imap: {
      host: HOME_NAME, port: IMAP_PORT, secure: false, ...extra, auth: { user: address },
      smtp: { host: HOME_NAME, port: SMTP_PORT, secure: false },
    },
    machineName: "the computer being set up",
    pollIntervalMs,
    leaseStaleAfterMs: 60_000,
    log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
  } as Parameters<typeof createSidecar>[0]);
  cleanups.push(async () => { await s.stop().catch(() => undefined); });
  return s;
}

const local = (s: Sidecar, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  s.handle(new Request(`http://local${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }));

/** The door's seal body, as `sealLocalPassword` composes it, with the lines a press ticked. */
function doorSeal(address: string, pass: string, consent: { imap?: boolean; smtp?: boolean } = {}): unknown {
  const imap = { host: HOME_NAME, user: address, port: IMAP_PORT, secure: false };
  const smtp = { host: HOME_NAME, user: address, port: SMTP_PORT, secure: false };
  return {
    imap: { ...imap, pass, smtpHost: HOME_NAME, smtpUnsettled: "", ...(consent.imap ? { allowInsecure: true } : {}) },
    smtp: { ...smtp, pass, ...(consent.smtp ? { allowInsecure: true } : {}) },
  };
}

async function stored(s: Sidecar): Promise<number> {
  return (await s.db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, s.world.mailboxId))).length;
}
async function allStored(s: Sidecar): Promise<void> {
  await vi.waitFor(async () => { expect(await stored(s)).toBe(N); }, { timeout: 15_000, interval: 100 });
}
function ownServer(): () => void {
  const restore = osAnswers("127.0.0.1");
  cleanups.push(async () => restore());
  return restore;
}
async function fixture(tag: string): Promise<{ address: string; pass: string; dataDir: string }> {
  ownServer();
  const address = `fd-${randomUUID()}@trafficflow.test`;
  const pass = randomUUID();
  await seedServer(address, pass);
  const dataDir = await freshDataDir(`ohmail-seed-consent-${tag}-`);
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return { address, pass, dataDir };
}
const sealOf = (s: Sidecar, body: unknown): Promise<Response> =>
  local(s, `/local/mailboxes/${s.world.mailboxId}`, { method: "PATCH", body });

describe.skipIf(!SERVER_UP)("the first-run seed on a server that offers no encryption", () => {
  it("without consent the door's seal is refused with the offer, and nothing is stored", async () => {
    const { address, pass, dataDir } = await fixture("none");
    const s = await bootSeed(dataDir, address, { 1: randomBytes(32) }, []);
    await s.start();
    const res = await sealOf(s, doorSeal(address, pass));
    const body = await res.json() as { error?: { code?: string; details?: { transport?: string; tls?: unknown } } };
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("mailbox_probe_failed");
    expect(body.error?.details).toMatchObject({ transport: "imap", tls: { kind: "tls_unavailable", plaintext: "offered" } });
    expect(await s.credentialState()).toBe("absent");
  });

  it("with consent the door's seal is stored, and the door's relaunch dials it and syncs", async () => {
    const { address, pass, dataDir } = await fixture("door");
    const keks = { 1: randomBytes(32) };
    const first = await bootSeed(dataDir, address, keks, []);
    await first.start();
    expect((await sealOf(first, doorSeal(address, pass, { imap: true, smtp: true }))).status).toBe(200);
    const consent = await first.db.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
      .from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, first.world.mailboxId));
    expect(Object.fromEntries(consent.map((r) => [r.transport, (r.meta as { insecureConsent?: unknown }).insecureConsent])))
      .toEqual({ imap: true, smtp: true });
    await first.stop();
    // The shell's relaunch composes the SAME settings, which carry no consent field.
    const next = await bootSeed(dataDir, address, keks, []);
    await next.start();
    await allStored(next);
  });

  it("CONTROL: the same sealed row under settings that carry the consent syncs too", async () => {
    const { address, pass, dataDir } = await fixture("seam");
    const keks = { 1: randomBytes(32) };
    const first = await bootSeed(dataDir, address, keks, []);
    await first.start();
    expect((await sealOf(first, doorSeal(address, pass, { imap: true, smtp: true }))).status).toBe(200);
    await first.stop();
    const next = await bootSeed(dataDir, address, keks, [], { allowInsecure: true });
    await next.start();
    await allStored(next);
  });

  it("Sign in again with the incoming line ticked, on the running seed, signs in and syncs", async () => {
    const { address, pass, dataDir } = await fixture("press");
    const lines: Line[] = [];
    const s = await bootSeed(dataDir, address, { 1: randomBytes(32) }, lines);
    await s.start();
    // The pane's body at the doors tip: the password and the ticked line, nothing else.
    const res = await sealOf(s, { imap: { pass, allowInsecure: true } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(lines.some((l) => l.event === "local_mailbox_launch_refused"), "the consented press was refused at its launch")
      .toBe(false);
    await allStored(s);
  });

  it("receive-only: the seal and Add admit the same server the same way", async () => {
    const { address, pass, dataDir } = await fixture("receive");
    const other = `fd-${randomUUID()}@trafficflow.test`;
    await seedServer(other, pass);
    const s = await bootSeed(dataDir, address, { 1: randomBytes(32) }, []);
    await s.start();
    const sealed = await sealOf(s, doorSeal(address, pass, { imap: true }));
    const sealedDto = await sealed.json() as { sendingUnsettledReason?: unknown };
    const added = await local(s, "/local/mailboxes", {
      method: "POST",
      body: {
        provider: "other", address: other,
        imap: { host: HOME_NAME, port: IMAP_PORT, secure: false, user: other, pass, allowInsecure: true, smtpUnsettled: "" },
        smtp: { host: HOME_NAME, port: SMTP_PORT, secure: false, user: other, pass },
      },
    });
    const addedDto = await added.json() as { sendingUnsettledReason?: unknown };
    expect(sealed.status).toBe(200);
    expect(added.status).toBe(201);
    expect(sealedDto.sendingUnsettledReason).toBe("tls");
    expect(addedDto.sendingUnsettledReason).toBe("tls");
  });
});
