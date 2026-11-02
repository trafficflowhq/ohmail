/**
 * THE DESKTOP SEED DIALS A SERVER WITHOUT ENCRYPTION WITH ITS ROW'S CONSENT. It dialled its settings
 * file, which carries none: a consented seal was stored and never dialled (0 messages after the
 * door's relaunch) and "Sign in again" with the line ticked was refused as a "certificate". Real
 * engine, store and `ImapAdapter`; this checkout's GreenMail's plain port through a name the TLS
 * floor does not exempt (`ip6-localhost`, answered 127.0.0.1), so the floor is production's.
 */
import { rmSync } from "node:fs";
import { generateKeyPairSync, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { mailboxCredentials, messages } from "@trafficflow/db";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { buildSelfSignedCert } from "../src/host-lan-tls.js";
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

  /* THE OUTGOING SERVER IS ASKED ABOUT, at the seal and at Add alike: without its line the press is
     refused with the offer and stores nothing; with it, both admit the mailbox and sending is settled. */
  it("the seal and Add ask about the same outgoing server the same way, and admit it the same way once ticked", async () => {
    const { address, pass, dataDir } = await fixture("receive");
    const other = `fd-${randomUUID()}@trafficflow.test`;
    await seedServer(other, pass);
    const s = await bootSeed(dataDir, address, { 1: randomBytes(32) }, []);
    await s.start();
    const addBody = (smtpConsent: boolean): unknown => ({
      provider: "other", address: other,
      imap: { host: HOME_NAME, port: IMAP_PORT, secure: false, user: other, pass, allowInsecure: true, smtpUnsettled: "" },
      smtp: { host: HOME_NAME, port: SMTP_PORT, secure: false, user: other, pass, ...(smtpConsent ? { allowInsecure: true } : {}) },
    });
    const sealed = await sealOf(s, doorSeal(address, pass, { imap: true }));
    const added = await local(s, "/local/mailboxes", { method: "POST", body: addBody(false) });
    for (const res of [sealed, added]) {
      const body = await res.json() as { error?: { code?: string; details?: unknown } };
      expect(res.status).toBe(400);
      expect(body.error?.code).toBe("mailbox_probe_failed");
      expect(body.error?.details).toMatchObject({ transport: "smtp", tls: { kind: "tls_unavailable", plaintext: "offered" } });
    }
    expect(await s.credentialState()).toBe("absent");

    const sealedAgain = await sealOf(s, doorSeal(address, pass, { imap: true, smtp: true }));
    const addedAgain = await local(s, "/local/mailboxes", { method: "POST", body: addBody(true) });
    expect([sealedAgain.status, addedAgain.status]).toEqual([200, 201]);
    for (const res of [sealedAgain, addedAgain]) {
      expect(((await res.json()) as { sendingUnsettledReason?: unknown }).sendingUnsettledReason ?? null).toBeNull();
    }
  });
});

/**
 * …AND A SERVER ON THIS COMPUTER WITH THE CERTIFICATE ITS ROW TRUSTS (a gateway such as Proton
 * Mail Bridge). "Sign in again" stored the trusted pin while the running seed dialled without it:
 * a bare seed's launch was refused and its password purged, and after a certificate change the
 * re-dial kept the old pin. A real STARTTLS server with its own certificate and the real reader;
 * a dial pinned to the certificate served is let in, any other is a real `ImapAdapter` against it.
 */
describe("the first-run seed on a server on this computer with its own certificate", () => {
  const USER = "pat@bridge.example";
  const KEKS = { 1: Buffer.alloc(32, 7) };
  type Served = { key: string; cert: string; sha256: string };

  function certificate(): Served {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const cert = new X509Certificate(buildSelfSignedCert(publicKey, privateKey, "127.0.0.1"));
    return { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: cert.toString(), sha256: cert.fingerprint256 };
  }

  /** IMAP on loopback offering STARTTLS with the certificate served now, and nothing past it. */
  async function bridge(served: { current: Served }): Promise<number> {
    const live = new Set<Socket>();
    const server = createNetServer((raw) => {
      live.add(raw);
      raw.on("error", () => { /* a client that refused the certificate hangs up */ });
      raw.on("close", () => live.delete(raw));
      let buf = "";
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString("latin1");
        for (let end = buf.indexOf("\r\n"); end >= 0; end = buf.indexOf("\r\n")) {
          const [tag, command = ""] = buf.slice(0, end).split(" ");
          buf = buf.slice(end + 2);
          if (/^CAPABILITY$/i.test(command)) raw.write(`* CAPABILITY IMAP4rev1 STARTTLS\r\n${tag} OK done\r\n`);
          else if (!/^STARTTLS$/i.test(command)) raw.write(`${tag} BAD not before STARTTLS\r\n`);
          else {
            raw.write(`${tag} OK begin TLS\r\n`);
            raw.removeListener("data", onData);
            new TLSSocket(raw, { isServer: true, key: served.current.key, cert: served.current.cert }).on("error", () => {});
            return;
          }
        }
      };
      raw.on("data", onData);
      raw.write("* OK [CAPABILITY IMAP4rev1 STARTTLS] bridge ready\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { for (const s of live) s.destroy(); server.close(() => resolve()); }));
    return (server.address() as AddressInfo).port;
  }

  /** Every dial the engine builds, and the pin its config held when it connected. */
  function dialer(served: { current: Served }) {
    const dials: Array<{ cfg: ImapConfig; ctx?: AdapterDialContext; pin?: string | null }> = [];
    const factory = (cfg: ImapConfig, ctx?: AdapterDialContext) => {
      const dial: (typeof dials)[number] = { cfg, ctx };
      dials.push(dial);
      const real = new ImapAdapter(cfg);
      const none = async (): Promise<never[]> => [];
      return {
        // Read at the connect, as `ImapAdapter` reads its config: the engine may re-point it after the build.
        async connect(): Promise<void> {
          dial.pin = cfg.tlsPin?.sha256 ?? null;
          if (dial.pin !== served.current.sha256) await real.connect();
        },
        close: () => real.close().catch(() => undefined),
        listFolders: async () => ["INBOX"],
        leaseIo: () => ({
          ensureMetaFolder: async () => {}, listClaims: none, appendClaim: async () => {}, removeClaims: async () => {},
          uidValidity: () => 4_100,
        }),
        leasePeekIo: () => ({ listClaims: none }),
        capabilities: async () => ({ move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null }),
        ensureFolders: async () => {},
        changesSince: async () => ({ creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } }),
        move: async () => ({ folder: "INBOX", ref: "1:1" }),
        setFlags: async () => {},
        scanSentRecipients: none,
        watch: async () => async () => {},
      };
    };
    return { dials, factory };
  }

  /** The seed on the bridge, started; `engine` lists the pins of this runtime's own dials, the probe's left out. */
  async function bootBridge(dataDir: string, port: number, d: ReturnType<typeof dialer>) {
    const from = d.dials.length;
    const s = await createSidecar({
      dataDir, address: USER, keks: KEKS, machineName: "this computer",
      imap: { host: "127.0.0.1", port, secure: false, auth: { user: USER } },
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, adapterFactory: d.factory, log: () => {},
    } as never);
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await s.start();
    const own = d.dials[from]!.cfg;
    const engine = () => d.dials.filter((x) => x.cfg === own && x.pin !== undefined);
    return { s, engine };
  }

  async function fixture(tag: string): Promise<{ served: { current: Served }; port: number; d: ReturnType<typeof dialer>; dataDir: string }> {
    const dataDir = await freshDataDir(`ohmail-seed-pin-${tag}-`);
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const served = { current: certificate() };
    const d = dialer(served);
    return { served, port: await bridge(served), d, dataDir };
  }
  const pinOf = async (s: Sidecar): Promise<unknown> => {
    const rows = await s.db.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
      .from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, s.world.mailboxId));
    return (rows.find((r) => r.transport === "imap")?.meta as { tlsPin?: { sha256?: unknown } } | undefined)?.tlsPin?.sha256;
  };
  const reachable = async (s: Sidecar): Promise<void> => {
    await vi.waitFor(async () => {
      const { items } = await (await local(s, "/local/mailboxes/connections")).json() as { items: Array<{ mailboxId: string; reachable?: boolean }> };
      expect(items.find((i) => i.mailboxId === s.world.mailboxId)?.reachable).toBe(true);
    }, { timeout: 10_000, interval: 50 });
  };

  it("Sign in again on the seed with no password, its certificate trusted, stores the pin and dials with it", async () => {
    const { served, port, d, dataDir } = await fixture("bare");
    const { s, engine } = await bootBridge(dataDir, port, d);
    expect(await s.credentialState()).toBe("absent");
    const res = await sealOf(s, { imap: { pass: "bridge-password", trustCertificate: served.current.sha256 } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await s.credentialState(), "the trusted press purged the password it stored").toBe("ready");
    expect(await pinOf(s)).toBe(served.current.sha256);
    expect(engine().map((x) => x.pin), "the launch dialled without the certificate just trusted").toEqual([served.current.sha256]);
    await reachable(s);
  });

  it("after its certificate changed, the re-dial behind the trusted press is pinned to the new one", async () => {
    const { served, port, d, dataDir } = await fixture("changed");
    const first = await bootBridge(dataDir, port, d);
    // The door's seal names the server; the engine the door starts next dials pinned.
    const sealed = await sealOf(first.s, {
      imap: { host: "127.0.0.1", port, secure: false, user: USER, pass: "bridge-password", trustCertificate: served.current.sha256, smtpHost: "" },
    });
    expect(sealed.status, await sealed.clone().text()).toBe(200);
    await first.s.stop();
    const { s, engine } = await bootBridge(dataDir, port, d);
    await reachable(s);
    expect(engine().map((x) => x.pin), "the relaunch dialled pinned").toEqual([served.current.sha256]);

    // Reinstalled with another certificate: the connection drops, and the person trusts the new one.
    served.current = certificate();
    engine().at(-1)!.ctx!.onConnectionError(new Error("the bridge restarted"));
    const before = engine().length;
    const res = await sealOf(s, { imap: { pass: "bridge-password", trustCertificate: served.current.sha256 } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await pinOf(s)).toBe(served.current.sha256);
    expect(engine().slice(before).map((x) => x.pin), "the re-dial kept the old certificate").toEqual([served.current.sha256]);
    await reachable(s);
  });
});
