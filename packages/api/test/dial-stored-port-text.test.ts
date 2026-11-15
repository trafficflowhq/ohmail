import { accountOfMailbox } from "@trafficflow/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { MailboxSideRefusal, type HostResolver } from "@trafficflow/services/mail";
import { makeOpenAdapter } from "../src/attachments-adapter.js";
import { dialPort, portForDial } from "../src/dial-host-guard.js";
import { makeSendAdapter } from "../src/send-adapter.js";
import { learnMissingSmtpSizes } from "../src/smtp-size.js";
import { makeProbeHostGuard } from "../src/imap-probe.js";
import type { ApiDeps } from "../src/deps.js";
import { FIXED_NOW, makeDeps, seedSession } from "./helpers.js";

/**
 * A PORT STORED AS DIGITS DIALS ON THE HOSTED API, as it does on the worker. A row written before
 * the create path validated its body can hold `"993"`; the three API doors handed it raw to the
 * port rule, which refused it with the HOST sentence. The coercion is one helper at the doors'
 * boundary: `/^[0-9]{1,5}$/` becomes a number, anything else is refused as before, and the rule's
 * set is unchanged. Every case runs under the hosted guard, where the port rule applies.
 */

const PUBLIC = "93.184.216.34";
const SUFFIX = ".port.example";
const publicResolver: HostResolver = { resolve: async () => [PUBLIC] };
const refused = async (run: () => Promise<unknown>): Promise<unknown> => run().then(() => null, (e: unknown) => e);

describe("the one coercion", () => {
  it("digits become a number; nothing stored stays nothing; anything else is kept as stored", () => {
    expect(dialPort("993")).toBe(993);
    expect(dialPort("0587")).toBe(587);
    expect(dialPort(465)).toBe(465);
    expect(dialPort(undefined)).toBeUndefined();
    expect(dialPort(null)).toBeUndefined();
    for (const kept of ["993x", "", " 993", "993 ", "+993", "1e3", "123456", "９９３"]) {
      expect(dialPort(kept)).toEqual({ asStored: kept });
      // The door is asked about the value as it was stored, and its port rule refuses it.
      expect(portForDial(dialPort(kept) ?? 993)).toBe(kept);
    }
    expect(dialPort("99999"), "five digits is a number; the port rule refuses it by name").toBe(99999);
  });

  it("its type says what it returns: a value kept as stored is not a port number", () => {
    // @ts-expect-error a stored value that is not digits comes back as `PortAsStored`, not a number
    const port: number | undefined = dialPort("993x");
    expect(port).toEqual({ asStored: "993x" });
  });
});

/* ── the attachment door ─────────────────────────────────────────────────────────────────────── */

async function attachmentDoor(port: unknown): Promise<{ deps: ApiDeps; mailboxId: string }> {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes).values({ accountId: randomUUID(), provider: "imap", address: "u@port.example" })
    .returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: `imap${SUFFIX}`, port, secure: true, user: "u@port.example" },
  });
  const deps = {
    db, now: () => FIXED_NOW, keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot }, probeHostGuard: makeProbeHostGuard(publicResolver) },
  } as unknown as ApiDeps;
  return { deps, mailboxId: mb!.id };
}

function watchImapDial(): ImapConfig[] {
  const configs: ImapConfig[] = [];
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: object) {
    configs.push((this as unknown as { config: ImapConfig }).config);
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  return configs;
}

describe("the attachment door", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("a port stored as \"993\" dials 993", async () => {
    const configs = watchImapDial();
    const { deps, mailboxId } = await attachmentDoor("993");
    const handle = await makeOpenAdapter(deps)(mailboxId);
    await handle.close();
    expect(configs.map((c) => c.port)).toEqual([993]);
  });

  it("CONTROL: a port stored as a number dials as it always has", async () => {
    const configs = watchImapDial();
    const { deps, mailboxId } = await attachmentDoor(993);
    await (await makeOpenAdapter(deps)(mailboxId)).close();
    expect(configs.map((c) => c.port)).toEqual([993]);
  });

  it.each([["993x"], [""], ["99999"]])("%j is refused and nothing is dialled", async (port) => {
    const configs = watchImapDial();
    const { deps, mailboxId } = await attachmentDoor(port);
    const err = await refused(() => makeOpenAdapter(deps)(mailboxId));
    expect(err).toBeInstanceOf(MailboxSideRefusal);
    expect(configs).toEqual([]);
  });

  it("\"99999\" is refused by its port, as the number would be", async () => {
    watchImapDial();
    const { deps, mailboxId } = await attachmentDoor("99999");
    const err = await refused(() => makeOpenAdapter(deps)(mailboxId));
    expect((err as MailboxSideRefusal).code).toBe("mailbox_port_refused");
    expect((err as Error).message).toContain("set to port 99999");
  });
});

/* ── the send door ───────────────────────────────────────────────────────────────────────────── */

describe("the send door", () => {
  async function sendDoor(o: { imapPort: unknown; smtpPort?: unknown; oauthSmtpPort?: unknown }) {
    const d = await makeDeps();
    (d.deps.services as unknown as { probeHostGuard: unknown }).probeHostGuard = makeProbeHostGuard(publicResolver);
    const [acct] = await d.db.insert(accounts).values({ name: "port-text" }).returning();
    const [mb] = await d.db.insert(mailboxes).values({ accountId: acct!.id, provider: "imap", address: "u@port.example" }).returning();
    const imap = await d.deps.keyProvider.encrypt("imap-pass");
    await d.db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: imap.ciphertext, keyVersion: imap.keyVersion,
      meta: o.oauthSmtpPort !== undefined
        ? { host: `imap${SUFFIX}`, port: o.imapPort, secure: true, user: "u@port.example", authType: "oauth2", provider: "microsoft", tenant: "common", smtp: { host: `smtp${SUFFIX}`, port: o.oauthSmtpPort, secure: false } }
        : { host: `imap${SUFFIX}`, port: o.imapPort, secure: true, user: "u@port.example" },
    });
    if (o.smtpPort !== undefined) {
      const smtp = await d.deps.keyProvider.encrypt("smtp-pass");
      await d.db.insert(mailboxCredentials).values({
        mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "smtp", secretEnc: smtp.ciphertext, keyVersion: smtp.keyVersion,
        meta: { host: `smtp${SUFFIX}`, port: o.smtpPort, secure: false, user: "u@port.example" },
      });
    }
    if (o.oauthSmtpPort !== undefined) {
      (d.deps as { oauth?: unknown }).oauth = { forMailbox: () => () => async (): Promise<string> => "an-access-token" };
    }
    const built: ImapConfig[] = [];
    const newAdapter = ((cfg: ImapConfig) => {
      built.push(cfg);
      return { connect: async (): Promise<void> => undefined, close: async (): Promise<void> => undefined };
    }) as never;
    return { d, mailboxId: mb!.id, built, newAdapter };
  }

  it("both legs stored as digits dial 993 and 587", async () => {
    const s = await sendDoor({ imapPort: "993", smtpPort: "587" });
    await makeSendAdapter(s.d.deps, s.mailboxId, {}, s.newAdapter);
    expect(s.built.map((c) => [c.port, c.smtp?.port])).toEqual([[993, 587]]);
  });

  it("an oauth mailbox's submission port stored as digits dials 587", async () => {
    const s = await sendDoor({ imapPort: 993, oauthSmtpPort: "587" });
    await makeSendAdapter(s.d.deps, s.mailboxId, {}, s.newAdapter);
    expect(s.built.map((c) => [c.port, c.smtp?.port])).toEqual([[993, 587]]);
  });

  it("CONTROL: \"587x\" on the submission row is refused before anything is built", async () => {
    const s = await sendDoor({ imapPort: 993, smtpPort: "587x" });
    const err = await refused(() => makeSendAdapter(s.d.deps, s.mailboxId, {}, s.newAdapter));
    expect(err).toBeInstanceOf(MailboxSideRefusal);
    expect(s.built).toEqual([]);
  });
});

/* ── the SIZE probe: what it dials is read off the socket calls, which record and refuse ───────── */

type Dialled = { via: "net" | "tls"; host: unknown; port: unknown };
const dialled: Dialled[] = [];
const restores: Array<() => void> = [];

describe("the SIZE probe", () => {
  beforeEach(() => {
    dialled.length = 0;
    const realNet = net.connect;
    const realTls = tls.connect;
    const refuse = (): net.Socket => {
      const s = new net.Socket();
      setImmediate(() => s.destroy(Object.assign(new Error("recorded, not dialled"), { code: "ECONNREFUSED" })));
      return s;
    };
    net.connect = ((o: Record<string, unknown>) => { dialled.push({ via: "net", host: o.host, port: o.port }); return refuse(); }) as unknown as typeof net.connect;
    tls.connect = ((o: Record<string, unknown>) => { dialled.push({ via: "tls", host: o.host, port: o.port }); return refuse(); }) as unknown as typeof tls.connect;
    const lookup = dns.lookup;
    dns.lookup = function stub(host: string, ...rest: unknown[]) {
      if (!host.endsWith(SUFFIX)) return (lookup as (...a: unknown[]) => unknown).call(dns, host, ...rest);
      const cb = rest.find((a) => typeof a === "function") as (e: unknown, a?: unknown, f?: number) => void;
      queueMicrotask(() => cb(null, PUBLIC, 4));
    } as typeof dns.lookup;
    restores.push(() => { net.connect = realNet; tls.connect = realTls; dns.lookup = lookup; });
  });
  afterEach(() => { for (const r of restores.splice(0)) r(); });

  async function sizeWorld(smtpPort: unknown, o: { oauth?: boolean } = {}): Promise<ApiDeps> {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    (deps.services as unknown as { probeHostGuard: unknown }).probeHostGuard = makeProbeHostGuard(publicResolver);
    const [mb] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: "u@port.example", status: "connected",
    }).returning();
    const imap = await deps.keyProvider.encrypt(o.oauth ? "a-refresh-token" : "imap-fixture");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: imap.ciphertext, keyVersion: imap.keyVersion,
      meta: o.oauth
        ? { host: `imap${SUFFIX}`, port: 993, secure: true, user: "o@port.example", authType: "oauth2", provider: "microsoft", tenant: "common", smtp: { host: `smtp${SUFFIX}`, port: smtpPort, secure: false } }
        : { host: `imap${SUFFIX}`, port: 993, secure: true, user: "u@port.example" },
      updatedAt: FIXED_NOW,
    });
    if (o.oauth) {
      (deps as { oauth?: unknown }).oauth = { forMailbox: () => () => async (): Promise<string> => "an-access-token" };
      return deps as ApiDeps;
    }
    const smtp = await deps.keyProvider.encrypt("smtp-fixture");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "smtp", secretEnc: smtp.ciphertext, keyVersion: smtp.keyVersion,
      meta: { host: `smtp${SUFFIX}`, port: smtpPort, secure: false, user: "u@port.example" },
      updatedAt: new Date(FIXED_NOW.getTime() + 1000),
    });
    return deps as ApiDeps;
  }

  it("a submission port stored as \"587\" is dialled on 587", async () => {
    await learnMissingSmtpSizes(await sizeWorld("587"));
    expect(dialled.map((d) => [d.via, d.host, d.port])).toEqual([["net", PUBLIC, 587]]);
  });

  it("an oauth mailbox's submission port stored as \"587\" is dialled on 587", async () => {
    await learnMissingSmtpSizes(await sizeWorld("587", { oauth: true }));
    expect(dialled.map((d) => [d.via, d.host, d.port])).toEqual([["net", PUBLIC, 587]]);
  });

  it("CONTROL: \"587x\" is never dialled", async () => {
    await learnMissingSmtpSizes(await sizeWorld("587x"));
    expect(dialled).toEqual([]);
  });
});
