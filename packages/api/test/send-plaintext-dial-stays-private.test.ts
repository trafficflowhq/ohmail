import { afterEach, describe, expect, it, vi } from "vitest";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { SendConnections } from "@trafficflow/core/mail";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeProbeHostGuard } from "../src/imap-probe.js";
import { makeDeps } from "./helpers.js";
import {
  HOME_NAME, osAnswers, plainImap, plainSmtp, resolverAnswering, type PlainServer,
} from "../../../test/support/plaintext-wire.js";

/**
 * A MAILBOX CONNECTED WITHOUT ENCRYPTION IS DIALLED ONLY AT AN ADDRESS ON THE PERSON'S OWN NETWORK.
 * The consent was given for a server that resolved privately; the send path used to honour the
 * stored marker by name, so a name that later answered a public address got the password in
 * clear. The REAL adapter dials the fake server here, and the wire is read by verb only.
 */

type Deps = Awaited<ReturnType<typeof makeDeps>>;
const USER = "u@home.example";

const servers: PlainServer[] = [];
let restoreOs: (() => void) | null = null;
afterEach(async () => {
  restoreOs?.();
  restoreOs = null;
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
});
const open = async (p: Promise<PlainServer>): Promise<PlainServer> => { const s = await p; servers.push(s); return s; };

/** Self-host deps (no enforcing guard), the real adapter, and this deployment's scope resolver. */
async function selfHost(scope: readonly string[]): Promise<Deps> {
  const d = await makeDeps();
  vi.restoreAllMocks();   // makeDeps stubs the IMAP dial; this file dials for real
  (d.deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver = resolverAnswering(scope);
  return d;
}

async function seed(
  d: Deps,
  imap: { host: string; port: number; consent: boolean },
  smtp: { host: string; port: number; consent: boolean } | null,
): Promise<string> {
  const [acct] = await d.db.insert(accounts).values({ name: "plaintext-dial" }).returning();
  const [mb] = await d.db.insert(mailboxes).values({ accountId: acct!.id, provider: "imap", address: USER }).returning();
  const i = await d.deps.keyProvider.encrypt("imap-fixture");
  await d.db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: i.ciphertext, keyVersion: i.keyVersion,
    meta: { host: imap.host, port: imap.port, secure: false, user: USER, ...(imap.consent ? { insecureConsent: true } : {}) },
  });
  if (smtp) {
    const s = await d.deps.keyProvider.encrypt("smtp-fixture");
    await d.db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp", secretEnc: s.ciphertext, keyVersion: s.keyVersion,
      meta: { host: smtp.host, port: smtp.port, secure: false, user: USER, ...(smtp.consent ? { insecureConsent: true } : {}) },
    });
  }
  return mb!.id;
}

const message = { from: USER, to: "friend@elsewhere.example", subject: "hello", text: "hello" };

describe("the send path's plaintext dial", () => {
  it("IMAP: a consented name that now answers a public address is refused, and no LOGIN reaches the wire", async () => {
    const imap = await open(plainImap({ acceptLogin: true }));
    restoreOs = osAnswers("0.0.0.0");
    const d = await selfHost(["0.0.0.0"]);
    const id = await seed(d, { host: HOME_NAME, port: imap.port, consent: true }, null);

    const err = await makeSendAdapter(d.deps, id, {}, undefined, new SendConnections()).catch((e: unknown) => e);
    expect(imap.saw("LOGIN"), "the password went out in clear to a server off the person's network").toBe(false);
    expect(imap.connections(), "a socket was opened before the refusal").toBe(0);
    expect((err as Error).message).toContain("no longer on your own network");
  });

  it("SMTP: the submission server's consent is re-asked at the dial too, and no AUTH reaches the wire", async () => {
    const imap = await open(plainImap({ acceptLogin: true }));
    const smtp = await open(plainSmtp());
    restoreOs = osAnswers("0.0.0.0");
    const d = await selfHost(["0.0.0.0"]);
    // The incoming leg is a loopback literal, which is not the subject: the outgoing leg is.
    const id = await seed(d, { host: "127.0.0.1", port: imap.port, consent: false }, { host: HOME_NAME, port: smtp.port, consent: true });

    const err = await makeSendAdapter(d.deps, id, {}, undefined, new SendConnections())
      .then((a) => a.send(message)).catch((e: unknown) => e);
    expect(smtp.saw("AUTH"), "the submission password went out in clear").toBe(false);
    expect(smtp.connections()).toBe(0);
    expect((err as Error).message).toContain("no longer on your own network");
  });

  it("a resolver that says nothing defers the dial instead of calling the server off the network", async () => {
    // The send settles terminally on the refusal's class; a DNS minute must leave as ENOTFOUND.
    const imap = await open(plainImap({ acceptLogin: true }));
    restoreOs = osAnswers("0.0.0.0");
    const d = await makeDeps();
    vi.restoreAllMocks();
    (d.deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver =
      { resolve: async () => { throw new Error("EAI_AGAIN"); } };
    const id = await seed(d, { host: HOME_NAME, port: imap.port, consent: true }, null);

    const err = await makeSendAdapter(d.deps, id, {}, undefined, new SendConnections()).catch((e: unknown) => e);
    expect(imap.connections()).toBe(0);
    expect((err as { code?: unknown }).code).toBe("ENOTFOUND");
    expect((err as Error).message).not.toContain("no longer on your own network");
  });

  it("ohmail Cloud honours no plaintext consent: the address it may dial is public by construction", async () => {
    // NO REAL ADAPTER HERE: a pinned dial to the public answer would leave this machine, and the
    // suite's egress guard reads the name, not the pin. The reading is that nothing is built.
    const d = await makeDeps();
    vi.restoreAllMocks();
    (d.deps.services as unknown as { probeHostGuard: unknown }).probeHostGuard =
      makeProbeHostGuard({ resolve: async () => ["93.184.216.34"] });
    const id = await seed(d, { host: HOME_NAME, port: 143, consent: true }, null);
    let built = 0;
    const never = (() => { built += 1; throw new Error("an adapter was built for a refused dial"); }) as never;

    const err = await makeSendAdapter(d.deps, id, {}, never, new SendConnections()).catch((e: unknown) => e);
    expect(built).toBe(0);
    expect((err as Error).message).toContain("no longer on your own network");
  });

  it("a name still on the person's network keeps dialling, pinned to the address that was checked", async () => {
    // The positive control, and the pin: the OS no longer resolves the name at all, so only a
    // dial carried to the checked address can reach either server.
    const imap = await open(plainImap({ acceptLogin: true }));
    const smtp = await open(plainSmtp());
    restoreOs = osAnswers(null);
    const d = await selfHost(["127.0.0.1"]);
    const id = await seed(d, { host: HOME_NAME, port: imap.port, consent: true }, { host: HOME_NAME, port: smtp.port, consent: true });

    await makeSendAdapter(d.deps, id, {}, undefined, new SendConnections())
      .then((a) => a.send(message)).catch(() => { /* the fake refuses AUTH; the wire is the reading */ });
    expect(imap.saw("LOGIN"), "the consented incoming dial did not reach its server").toBe(true);
    expect(smtp.saw("AUTH"), "the consented outgoing dial did not reach its server").toBe(true);
  });
});
