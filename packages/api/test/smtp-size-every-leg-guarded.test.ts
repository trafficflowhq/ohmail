import { afterEach, beforeEach, describe, expect, it } from "vitest";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import type { ApiDeps } from "@trafficflow/api";
import type { HostResolver } from "@trafficflow/services/mail";
import { learnMissingSmtpSizes } from "../src/smtp-size.js";
import { makeProbeHostGuard } from "../src/imap-probe.js";
import { makeDeps, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * EVERY LEG OF THE SIZE BACK-FILL DIALS THROUGH THE DIAL DOOR. The pass handed a stored submission
 * name and port to a fresh socket and re-asked only a consented plaintext leg, so on the managed
 * deployment a name now resolving to a private address, or a port that carries no mail, was
 * dialled with the stored password. What the pass dials is read off the socket calls themselves,
 * which record and refuse: nothing here opens a connection. The machine's own resolver is stubbed
 * for the fixture names, so a dial by name never asks the network either.
 */

const OS_ANSWER = "198.51.100.7";
const PUBLIC = "93.184.216.35";
const SUFFIX = ".size.example";

type Dialled = { via: "net" | "tls"; host: unknown; port: unknown; servername: unknown };
const dialled: Dialled[] = [];
const restores: Array<() => void> = [];

beforeEach(() => {
  dialled.length = 0;
  const realNet = net.connect;
  const realTls = tls.connect;
  const refused = (): net.Socket => {
    const s = new net.Socket();
    setImmediate(() => s.destroy(Object.assign(new Error("recorded, not dialled"), { code: "ECONNREFUSED" })));
    return s;
  };
  net.connect = ((o: Record<string, unknown>) => {
    dialled.push({ via: "net", host: o.host, port: o.port, servername: o.servername });
    return refused();
  }) as unknown as typeof net.connect;
  tls.connect = ((o: Record<string, unknown>) => {
    dialled.push({ via: "tls", host: o.host, port: o.port, servername: o.servername });
    return refused();
  }) as unknown as typeof tls.connect;

  const lookup = dns.lookup;
  const r4 = dns.Resolver.prototype.resolve4;
  const r6 = dns.Resolver.prototype.resolve6;
  dns.lookup = function stub(host: string, ...rest: unknown[]) {
    if (!host.endsWith(SUFFIX)) return (lookup as (...a: unknown[]) => unknown).call(dns, host, ...rest);
    const cb = rest.find((a) => typeof a === "function") as (e: unknown, a?: unknown, f?: number) => void;
    const opts = (typeof rest[0] === "object" && rest[0] !== null ? rest[0] : {}) as { all?: boolean };
    queueMicrotask(() => (opts.all ? cb(null, [{ address: OS_ANSWER, family: 4 }]) : cb(null, OS_ANSWER, 4)));
  } as typeof dns.lookup;
  const none = function (this: unknown, _h: string, cb: (e: unknown) => void) {
    queueMicrotask(() => cb(Object.assign(new Error("no record"), { code: dns.NOTFOUND })));
  };
  dns.Resolver.prototype.resolve4 = none as typeof r4;
  dns.Resolver.prototype.resolve6 = none as typeof r6;

  restores.push(() => {
    net.connect = realNet;
    tls.connect = realTls;
    dns.lookup = lookup;
    dns.Resolver.prototype.resolve4 = r4;
    dns.Resolver.prototype.resolve6 = r6;
  });
});
afterEach(() => { for (const r of restores.splice(0)) r(); });

/** The deployment's own resolver for the door, answering per fixture name, counting each ask. */
function guardResolver(answers: Record<string, string[] | Error>): HostResolver & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (host: string) => {
      asked.push(host);
      const a = answers[host];
      if (a === undefined) throw new Error(`no answer scripted for ${host}`);
      if (a instanceof Error) throw a;
      return [...a];
    },
  };
}

type Deps = Awaited<ReturnType<typeof makeDeps>>;

async function armed(over: { managed?: HostResolver; scope?: HostResolver } = {}): Promise<{
  db: Deps["db"]; deps: ApiDeps; accountId: string;
}> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const services = deps.services as unknown as { probeHostGuard?: unknown; probeScopeResolver?: unknown };
  if (over.managed) services.probeHostGuard = makeProbeHostGuard(over.managed);
  if (over.scope) services.probeScopeResolver = over.scope;
  return { db, deps: deps as ApiDeps, accountId: s.accountId };
}

/** One mailbox needing a ceiling: an imap row, and an smtp row unless `smtp` is null. */
async function seed(
  db: Deps["db"], deps: ApiDeps, accountId: string,
  o: { imapHost?: string; smtp?: { host: string; port: number; secure: boolean; insecureConsent?: boolean } | null; oauthSmtp?: { host: string; port: number; secure: boolean } },
): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: o.oauthSmtp ? "microsoft" : "imap",
    address: `x${Math.random().toString(36).slice(2, 8)}@example.net`, status: "connected",
  }).returning();
  const imap = await deps.keyProvider.encrypt(o.oauthSmtp ? "a-refresh-token" : "imap-fixture");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: imap.ciphertext, keyVersion: imap.keyVersion,
    meta: o.oauthSmtp
      ? { host: `imap${SUFFIX}`, port: 993, secure: true, user: "o@example.net", authType: "oauth2", provider: "microsoft", tenant: "common", smtp: o.oauthSmtp }
      : { host: o.imapHost ?? `imap${SUFFIX}`, port: 993, secure: true, user: "u@example.net" },
    updatedAt: FIXED_NOW,
  });
  if (o.smtp && !o.oauthSmtp) {
    const enc = await deps.keyProvider.encrypt("smtp-fixture");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { ...o.smtp, user: "u@example.net" }, updatedAt: new Date(FIXED_NOW.getTime() + 1000),
    });
  }
  return mb!.id;
}

const stampOf = async (db: Deps["db"], id: string): Promise<string | null> =>
  (await db.select({ code: mailboxes.smtpSizeProbeCode }).from(mailboxes).where(eq(mailboxes.id, id)))[0]?.code ?? null;

/** The token source the send binds, faked: it mints a token and never dials anything. */
const oauth = { forMailbox: () => () => async (): Promise<string> => "an-access-token" } as unknown as NonNullable<ApiDeps["oauth"]>;

describe("THE MANAGED DEPLOYMENT: every SIZE leg is checked, pinned and port-ruled before a socket", () => {
  it("a stored submission port that carries no mail is never dialled", async () => {
    const r = guardResolver({ [`a${SUFFIX}`]: [PUBLIC] });
    const { db, deps, accountId } = await armed({ managed: r });
    const id = await seed(db, deps, accountId, { smtp: { host: `a${SUFFIX}`, port: 2525, secure: false } });
    const res = await learnMissingSmtpSizes(deps);
    expect(dialled, "the pass dialled a port the send door refuses").toEqual([]);
    expect(res.failed).toBe(1);
    expect(await stampOf(db, id)).toBe("unreachable");
  });

  it("a stored submission name that now resolves to a loopback address is refused by the deployment's guard", async () => {
    const r = guardResolver({ [`b${SUFFIX}`]: ["127.0.0.1"] });
    const { db, deps, accountId } = await armed({ managed: r });
    const id = await seed(db, deps, accountId, { smtp: { host: `b${SUFFIX}`, port: 587, secure: false } });
    await learnMissingSmtpSizes(deps);
    expect(r.asked, "the deployment's guard was never asked about the host it dialled").toEqual([`b${SUFFIX}`]);
    expect(dialled).toEqual([]);
    expect(await stampOf(db, id)).toBe("unreachable");
  });

  it("a cleared submission name is dialled at the address the guard cleared, never re-resolved", async () => {
    const r = guardResolver({ [`c${SUFFIX}`]: [PUBLIC] });
    const { db, deps, accountId } = await armed({ managed: r });
    await seed(db, deps, accountId, { smtp: { host: `c${SUFFIX}`, port: 587, secure: false } });
    await learnMissingSmtpSizes(deps);
    expect(dialled.map((d) => [d.via, d.host, d.port])).toEqual([["net", PUBLIC, 587]]);
  });

  it("an implicit-TLS leg is pinned and keeps the NAME for SNI", async () => {
    const r = guardResolver({ [`d${SUFFIX}`]: [PUBLIC] });
    const { db, deps, accountId } = await armed({ managed: r });
    await seed(db, deps, accountId, { smtp: { host: `d${SUFFIX}`, port: 465, secure: true } });
    await learnMissingSmtpSizes(deps);
    expect(dialled).toEqual([{ via: "tls", host: PUBLIC, port: 465, servername: `d${SUFFIX}` }]);
  });

  it("the no-smtp-row fallback, the imap host on 587, is checked as its own leg", async () => {
    const r = guardResolver({ [`e${SUFFIX}`]: ["10.0.0.5"] });
    const { db, deps, accountId } = await armed({ managed: r });
    const id = await seed(db, deps, accountId, { imapHost: `e${SUFFIX}`, smtp: null });
    await learnMissingSmtpSizes(deps);
    expect(dialled).toEqual([]);
    expect(await stampOf(db, id)).toBe("unreachable");
  });

  it("an oauth mailbox's submission endpoint is checked like a password one", async () => {
    const r = guardResolver({ [`f${SUFFIX}`]: ["10.0.0.5"] });
    const { db, deps, accountId } = await armed({ managed: r });
    (deps as { oauth?: unknown }).oauth = oauth;
    const id = await seed(db, deps, accountId, { oauthSmtp: { host: `f${SUFFIX}`, port: 587, secure: false } });
    await learnMissingSmtpSizes(deps);
    expect(dialled).toEqual([]);
    expect(await stampOf(db, id)).toBe("unreachable");
  });

  it("a resolver that cannot answer at the door dials nothing", async () => {
    const r = guardResolver({ [`g${SUFFIX}`]: new Error("EAI_AGAIN") });
    const { db, deps, accountId } = await armed({ managed: r });
    const id = await seed(db, deps, accountId, { smtp: { host: `g${SUFFIX}`, port: 587, secure: false } });
    await learnMissingSmtpSizes(deps);
    expect(dialled).toEqual([]);
    expect(await stampOf(db, id), "an unresolved name is unreachable, never unknown").toBe("unreachable");
  });
});

describe("the door's refusals are recorded as what they are: no connection was made", () => {
  it("a consented plaintext leg whose name the deployment cannot resolve stamps unreachable", async () => {
    const { db, deps, accountId } = await armed({ scope: guardResolver({ [`h${SUFFIX}`]: new Error("EAI_AGAIN") }) });
    const id = await seed(db, deps, accountId, { smtp: { host: `h${SUFFIX}`, port: 587, secure: false, insecureConsent: true } });
    await learnMissingSmtpSizes(deps);
    expect(dialled).toEqual([]);
    expect(await stampOf(db, id)).toBe("unreachable");
  });

  it("a consented plaintext leg whose name left the person's network stamps unreachable", async () => {
    const { db, deps, accountId } = await armed({ scope: guardResolver({ [`i${SUFFIX}`]: [PUBLIC] }) });
    const id = await seed(db, deps, accountId, { smtp: { host: `i${SUFFIX}`, port: 587, secure: false, insecureConsent: true } });
    await learnMissingSmtpSizes(deps);
    expect(dialled).toEqual([]);
    expect(await stampOf(db, id)).toBe("unreachable");
  });
});

describe("CONTROL: the self-host deployment dials its own network by name, any port", () => {
  it("a LAN submission server on its own port is dialled by name, nothing pinned", async () => {
    const { db, deps, accountId } = await armed();
    await seed(db, deps, accountId, { smtp: { host: `j${SUFFIX}`, port: 2525, secure: false } });
    await learnMissingSmtpSizes(deps);
    expect(dialled.map((d) => [d.via, d.host, d.port])).toEqual([["net", OS_ANSWER, 2525]]);
  });
});
