import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { authThrottle, HOSTED_IMAP_ADMISSION } from "@trafficflow/db/cloud";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * Gap **ONBOARDING STORED IMAP CREDENTIALS WITHOUT EVER TRYING THEM.**
 *
 * `POST /mailboxes` encrypted whatever was typed and answered 201. A mistyped host, or an Apple
 * ID password where an app-specific one is mandatory, was accepted by the form; `mailboxes.status`
 * DEFAULTS to `'connected'`, so the row said connected from the moment it existed, and the first
 * word the user got about it was a worker sync error minutes later and somewhere else.
 *
 * These tests measure the DIAL, not the response: `ImapAdapter.prototype.connect` is spied, so
 * `dialed()` is the number of real login attempts `POST /mailboxes` produced. Before the fix it
 * was ZERO, for every credential, always.
 *
 * NOTHING HERE ASSERTS ON A PASSWORD's VALUE and no spy echoes one. The plaintext is handed to
 * the probe seam by necessity — it is what is being tried — and the assertions are about which
 * rows exist and which sentence came back.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const body = (o: unknown): string => JSON.stringify(o);

const IMAP = { host: "imap.example.invalid", port: 993, secure: true, user: "u@example.invalid", pass: "typed-secret-password-password" };
const SMTP = { host: "smtp.example.invalid", port: 465, secure: true, user: "u@example.invalid" };

const post = (token: string, over: Record<string, unknown> = {}): Request =>
  req("POST", "/mailboxes", {
    bearer: token,
    headers: { "content-type": "application/json" },
    body: body({ provider: "imap", address: "u@example.invalid", imap: IMAP, smtp: SMTP, ...over }),
  });

/**
 * A thrown value shaped like the ones `imapflow@1.5.0` really produces.
 *
 * `authenticationFailed` is set on EVERY failure of the LOGIN command, unconditionally
 * (`lib/commands/login.js:38`) — which is the whole reason an earlier change moved the structured probes
 * above it in the worker's classifier. Every fixture here therefore carries the flag, so a probe
 * that reads it first is caught by the cases that are NOT a rejected password.
 */
function imapError(over: Record<string, unknown>): Error {
  return Object.assign(new Error("login failed"), { authenticationFailed: true }, over);
}

/** Count the logins `POST /mailboxes` actually attempted, and decide how each one ends. */
function spyDial(outcome: () => Promise<void>): { dialed: () => number; closed: () => number } {
  let dialed = 0;
  let closed = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async () => {
    dialed += 1;
    await outcome();
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async () => { closed += 1; });
  return { dialed: () => dialed, closed: () => closed };
}

const ok = () => Promise.resolve();

async function session(): Promise<{ db: Awaited<ReturnType<typeof makeDeps>>["db"]; deps: ApiDeps; token: string }> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  return { db, deps, token: s.token };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("credentials are tried before they are stored", () => {
  it("REPRODUCTION: a login the server refuses is not stored, and the connect was really attempted", async () => {
    const { db, deps, token } = await session();
    const dial = spyDial(() => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" })));

    const res = await H(post(token), deps);

    // The dial happened at all. Before this slice it never did, for any credential.
    expect(dial.dialed()).toBe(1);
    expect(res.status).toBe(400);
    const wire = await res.json();
    expect(wire.error.code).toBe("mailbox_probe_failed");
    expect(wire.error.details.reason).toBe("auth");
    // And NOTHING was written: not the mailbox, not the credential.
    expect(await db.select().from(mailboxes)).toHaveLength(0);
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
    // The sentence never contains what was typed.
    expect(JSON.stringify(wire)).not.toContain("typed-secret-password-password");
  });

  it("a mistyped host and a rejected password do NOT produce the same sentence", async () => {
    const { deps, token } = await session();
    spyDial(() => Promise.reject(imapError({ code: "ENOTFOUND" })));
    const host = await H(post(token), deps);
    const hostWire = await host.json();

    vi.restoreAllMocks();
    const { deps: deps2, token: token2 } = await session();
    spyDial(() => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" })));
    const auth = await H(post(token2), deps2);
    const authWire = await auth.json();

    expect(hostWire.error.details.reason).toBe("connect");
    expect(authWire.error.details.reason).toBe("auth");
    expect(hostWire.error.message).not.toBe(authWire.error.message);
    // Each one names ITS failure rather than a shared shrug.
    expect(hostWire.error.message.toLowerCase()).toContain("reach");
    expect(authWire.error.message.toLowerCase()).toContain("password");
  });

  it("TLS and timeout are their own sentences too", async () => {
    for (const [thrown, reason, word] of [
      [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls", "certificate"],
      [{ code: "CONNECT_TIMEOUT" }, "timeout", "time"],
    ] as const) {
      vi.restoreAllMocks();
      const { db, deps, token } = await session();
      spyDial(() => Promise.reject(imapError(thrown)));
      const res = await H(post(token), deps);
      const wire = await res.json();
      expect(wire.error.details.reason, JSON.stringify(thrown)).toBe(reason);
      expect(wire.error.message.toLowerCase()).toContain(word);
      expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
    }
  });

  /**
   * SEC2 IMAP-PROBE-CONNECT-ORACLE — the refusal SENTENCE names no host from the dialed certificate.
   *
   * A hostname-mismatch used to read "certificate is for {certHost} … use {suggestedHost}", echoing
   * the CN/SAN of whatever answered at the dialed `host:port`. Behind a verified session that is a
   * caller-driven disclosure of an internal hostname. The message now names neither; the structured
   * `details.tls` still carries them for the client's own vanity-CNAME suggestion UX. Mutation:
   * restore the old `${server}'s certificate is for ${tls.certHost}` sentence and the first
   * assertion goes red.
   */
  it("a hostname-mismatch refusal leaks NO cert host in its message, but keeps it in details.tls", async () => {
    const { db, deps, token } = await session();
    spyDial(() => Promise.reject(imapError({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      message: "Hostname/IP does not match certificate's altnames: Host: imap.example.invalid. is not in the cert's altnames: DNS:internal-mx.corp.local",
      cert: { subject: { CN: "internal-mx.corp.local" }, subjectaltname: "DNS:internal-mx.corp.local" },
    })));
    const res = await H(post(token), deps);
    const wire = await res.json();

    expect(res.status).toBe(400);
    expect(wire.error.details.reason).toBe("tls");
    // The sentence the user sees names no host from the certificate we dialed.
    expect(wire.error.message).not.toContain("internal-mx.corp.local");
    // …but the structured detail still carries it, so the client's suggestion UX is unchanged.
    expect(wire.error.details.tls.certHost).toBe("internal-mx.corp.local");
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("a login the server ACCEPTS stores the mailbox exactly as before, and closes the socket", async () => {
    const { db, deps, token } = await session();
    const dial = spyDial(ok);

    const res = await H(post(token), deps);

    expect(res.status).toBe(201);
    expect(dial.dialed()).toBe(1);
    // The probe is not a second way to hold a connection open.
    expect(dial.closed()).toBe(1);
    const dto = await res.json();
    expect(dto.status).toBe("connected");
    expect(await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, dto.id))).toHaveLength(2);
  });

  /**
   * THE ONE FAILURE THAT STILL STORES, AND WHY IT IS NOT AN EXCEPTION SMUGGLED IN.
   *
   * A server that answers `NO [UNAVAILABLE]` or `NO [LIMIT]` HAS BEEN REACHED: it parsed our
   * LOGIN and declined to serve it right now. That is positive evidence the host, the port and
   * the TLS mode are right, and no evidence at all about the password. iCloud caps concurrent
   * connections across ALL of an account's clients, so refusing here would be a hard block on a
   * condition the user cannot clear from our form — and `MailboxSection.statusKey` already
   * renders a row with `lastSyncAt === null` as "connecting", not "connected".
   */
  it("a server that answers 'not right now' stores — it was reached, not refused", async () => {
    for (const thrown of [
      { serverResponseCode: "UNAVAILABLE" },
      { serverResponseCode: "LIMIT" },
      { code: "ETHROTTLE" },
      // The commoner iCloud shape: BYE with a bracket atom the library discards, so the pending
      // login is rejected with a bare connection error and there is no code to promote.
      { code: "EConnectionClosed" },
    ]) {
      vi.restoreAllMocks();
      const { db, deps, token } = await session();
      spyDial(() => Promise.reject(imapError(thrown)));
      const res = await H(post(token), deps);
      expect(res.status, JSON.stringify(thrown)).toBe(201);
      expect(await db.select().from(mailboxCredentials)).toHaveLength(2);
    }
  });

  /**
   * A CONFIGURATION THE ADAPTER COULD NEVER USE IS REFUSED BEFORE THE DIAL, NOT AFTER IT.
   *
   * `metaOf` drops undefined values, so a create with no host used to store a credential whose
   * `meta` had none — a mailbox the worker cannot log in with and cannot explain. Feeding the
   * same body to the probe would produce a true sentence about the wrong thing ("we could not
   * reach that mail server"), and it would spend a connection to say it.
   */
  it("a create with no IMAP host is refused before anything is dialled", async () => {
    for (const bad of [{ ...IMAP, host: "" }, { ...IMAP, port: 0 }]) {
      vi.restoreAllMocks();
      const { db, deps, token } = await session();
      const dial = spyDial(ok);
      const res = await H(post(token, { imap: bad }), deps);
      const wire = await res.json();
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(wire.error.code).toBe("validation_failed");
      expect(dial.dialed()).toBe(0);
      expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
    }
  });

  it("a throw nobody can name refuses, and does not claim to know why", async () => {
    const { db, deps, token } = await session();
    spyDial(() => Promise.reject(new Error("something else entirely")));
    const res = await H(post(token), deps);
    const wire = await res.json();
    expect(res.status).toBe(502);
    expect(wire.error.details.reason).toBe("unknown");
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("the probe goes through the IMAP admission counter, and gives its slot back", async () => {
    const { db, deps, token } = await session();
    spyDial(ok);
    await H(post(token), deps);
    const rows = await db.select().from(authThrottle);
    const admission = rows.filter((r) => r.key.startsWith("imap:mailbox:"));
    // BOTH probes were counted — the IMAP dial and the SMTP verify each hold their own slot,
    // in their own namespace, because they are budgets against different servers.
    expect(admission).toHaveLength(2);
    expect(admission.filter((r) => r.key.startsWith("imap:mailbox:probe:smtp:"))).toHaveLength(1);
    for (const row of admission) {
      // …and released, so a second attempt is not refused by our own bookkeeping.
      expect(row.failures).toBe(0);
      // And the key carries no address: it is a digest, like the table's other identity namespaces.
      expect(row.key).not.toContain("example.invalid");
    }
  });

  it("past the probes' budget an Add is refused before it dials, and stores nothing", async () => {
    // Add tries the password as Test does, so it spends the same budget (hosted hosts only).
    const { db, deps, token } = await session();
    (deps.services as unknown as { imapAdmission: unknown }).imapAdmission = HOSTED_IMAP_ADMISSION;
    const dial = spyDial(() => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" })));
    for (let i = 0; i < 10; i++) expect((await H(post(token), deps)).status).toBe(400);
    const res = await H(post(token), deps);
    expect({ status: res.status, code: (await res.json()).error.code }).toEqual({ status: 429, code: "rate_limited" });
    expect(dial.dialed()).toBe(10);
    expect(await db.select().from(mailboxes)).toHaveLength(0);
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("a refused probe releases its slot too", async () => {
    const { db, deps, token } = await session();
    spyDial(() => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" })));
    await H(post(token), deps);
    const rows = (await db.select().from(authThrottle)).filter((r) => r.key.startsWith("imap:mailbox:"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failures).toBe(0);
  });

  it("a probe that hangs is bounded, and says the server stopped answering", async () => {
    vi.useFakeTimers();
    try {
      const { db, deps, token } = await session();
      spyDial(() => new Promise<void>(() => { /* never settles — a provider that goes quiet */ }));
      const pending = H(post(token), deps);
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await pending;
      const wire = await res.json();
      expect(wire.error.details.reason).toBe("timeout");
      expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
