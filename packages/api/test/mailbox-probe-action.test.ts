/**
 * `POST /mailboxes/probe` — THE TEST ACTION EVERY MAILBOX FORM WAS MISSING.
 *
 * Until this route the only way to find out whether a set of mail-server details worked was to
 * submit them and watch the mailbox either appear or not. Fourteen failure sentences existed and
 * were reachable only as the by-product of a create that did not happen; no success sentence
 * existed anywhere in the product, because nothing could produce one.
 *
 * What these tests pin is the part that is genuinely new — the SHAPE of a success, the folder
 * count inside it, and the one place this route deliberately answers differently from the create
 * path it shares a probe with. The failure taxonomy itself is not re-tested here: it is
 * `probeRefused`'s, byte for byte, and re-asserting it would be asserting a shared function twice
 * while proving nothing about this route.
 *
 * The dial is measured, never described: `ImapAdapter.prototype.connect` and `listFolders` are
 * spied, so the counts below are real login attempts and real LIST commands. No spy echoes a
 * password and nothing here asserts on one.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, connectAttemptRecorder, type ApiDeps } from "@trafficflow/api";
import { accounts, mailboxes, mailboxCredentials, type Tx } from "@trafficflow/db";
import { connectAttempts } from "@trafficflow/db/cloud";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const IMAP = { host: "imap.example.invalid", port: 993, secure: true, user: "u@example.invalid", pass: "typed-secret-password-password" };

const post = (token: string, over: Record<string, unknown> = {}): Request =>
  req("POST", "/mailboxes/probe", {
    bearer: token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: "u@example.invalid", imap: IMAP, ...over }),
  });

function imapError(over: Record<string, unknown>): Error {
  return Object.assign(new Error("login failed"), { authenticationFailed: true }, over);
}

/** Decide how the login ends and what the folder LIST answers, and count both. */
function spyDial(
  connect: () => Promise<void>,
  list: () => Promise<string[]> = async () => ["INBOX", "Sent", "Drafts"],
): { dialed: () => number; listed: () => number } {
  let dialed = 0;
  let listed = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async () => { dialed += 1; await connect(); });
  vi.spyOn(ImapAdapter.prototype, "listFolders").mockImplementation(async () => { listed += 1; return list(); });
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async () => {});
  return { dialed: () => dialed, listed: () => listed };
}

const ok = (): Promise<void> => Promise.resolve();

async function session(): Promise<{ db: Awaited<ReturnType<typeof makeDeps>>["db"]; deps: ApiDeps; token: string }> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  return { db, deps, token: s.token };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the affirmative verdict, which did not exist before", () => {
  it("answers the host, the user and a real folder COUNT — and writes nothing", async () => {
    const { db, deps, token } = await session();
    const dial = spyDial(ok, async () => ["INBOX", "Sent", "Drafts", "Junk", "Archive"]);

    const res = await H(post(token), deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, host: "imap.example.invalid", user: "u@example.invalid", folders: 5,
    });
    // One login, one LIST — the count is taken inside the connection that proved the password,
    // never by a second dial.
    expect(dial.dialed()).toBe(1);
    expect(dial.listed()).toBe(1);
    // A TEST CREATES NOTHING. This is the property that separates it from the create path, and it
    // is asserted on the rows rather than on the response.
    expect(await db.select().from(mailboxes)).toHaveLength(0);
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
  });

  it("the count is the CHECKABLE half: a mailbox with one folder says one, not 'connected'", async () => {
    const { deps, token } = await session();
    spyDial(ok, async () => ["INBOX"]);
    const wire = await (await H(post(token), deps)).json();
    expect(wire.folders).toBe(1);
  });

  it("the username defaults to the address, so the test proves what the create will send", async () => {
    // A test that quietly dialled a different identity than the create that follows it would be
    // worse than no test at all.
    const { deps, token } = await session();
    spyDial(ok);
    const { user: _dropped, ...noUser } = IMAP;
    const wire = await (await H(post(token, { imap: noUser }), deps)).json();
    expect(wire.user).toBe("u@example.invalid");
  });

  it("never echoes the password, in any field", async () => {
    const { deps, token } = await session();
    spyDial(ok);
    const wire = await (await H(post(token), deps)).text();
    expect(wire).not.toContain("typed-secret-password-password");
  });
});

describe("a LIST that fails is not a success", () => {
  it("signing in and failing to read folders is a named refusal, not ok-with-no-count", async () => {
    // The whole reason the count is taken INSIDE the probe rather than bolted on after it. A
    // green verdict over a mailbox whose folders could not be read is the true-but-useless
    // answer this route exists to stop giving.
    const { deps, token } = await session();
    const dial = spyDial(ok, () => Promise.reject(imapError({ code: "ETIMEDOUT" })));

    const res = await H(post(token), deps);

    expect(dial.dialed()).toBe(1);
    expect(dial.listed()).toBe(1);
    expect(res.status).not.toBe(200);
    const wire = await res.json();
    expect(wire.error.code).toBe("mailbox_probe_failed");
    // Classified by the ordinary taxonomy — this one really is a timeout — rather than by a
    // second vocabulary invented for LIST failures.
    expect(wire.error.details.reason).toBe("timeout");
  });
});

describe("the one place this answers differently from the create path", () => {
  it("a server that says 'not right now' is a FAILURE here, though a create would store it", async () => {
    // `store_unverified` means the server was reached and declined to serve. On the create path
    // that is positive evidence about host/port/TLS and the credential is stored, because
    // refusing would lock out anyone whose provider caps concurrent connections. Here the
    // question is "did this work", and nothing about the password has been established — so a
    // green verdict naming a folder count nobody read would be a lie.
    const { deps, token } = await session();
    spyDial(() => Promise.reject(imapError({ serverResponseCode: "UNAVAILABLE" })));

    const res = await H(post(token), deps);

    expect(res.status).not.toBe(200);
    const wire = await res.json();
    expect(wire.error.code).toBe("mailbox_probe_failed");
    expect(wire.error.details.reason).toBe("connect");
  });

  it("and a refused password is the same sentence the create path gives", async () => {
    // Shared by construction, not by resemblance: every client that renders a connect failure
    // renders a test failure with no new copy and no new branch.
    const { deps, token } = await session();
    spyDial(() => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" })));
    const wire = await (await H(post(token), deps)).json();
    expect(wire.error.code).toBe("mailbox_probe_failed");
    expect(wire.error.details.reason).toBe("auth");
  });
});

describe("the wire shape is read field by field", () => {
  it("refuses a body with no host, before any dial", async () => {
    const { deps, token } = await session();
    const dial = spyDial(ok);
    const { host: _h, ...noHost } = IMAP;
    const res = await H(post(token, { imap: noHost }), deps);
    expect(res.status).toBe(400);
    expect(dial.dialed()).toBe(0);
  });

  it("refuses a body with no password, before any dial", async () => {
    const { deps, token } = await session();
    const dial = spyDial(ok);
    const { pass: _p, ...noPass } = IMAP;
    const res = await H(post(token, { imap: noPass }), deps);
    expect(res.status).toBe(400);
    expect(dial.dialed()).toBe(0);
  });

  it("an absent port stays absent, so the standard ladder is what runs", async () => {
    // Coercing a missing port would pin the probe to one rung and turn "find my server" into
    // "try exactly this and fail". 993 implicit TLS is the ladder's first rung, so a bare
    // host/user/pass must still succeed.
    const { deps, token } = await session();
    const dial = spyDial(ok);
    const wire = await (await H(post(token, {
      imap: { host: IMAP.host, user: IMAP.user, pass: IMAP.pass },
    }), deps)).json();
    expect(wire.ok).toBe(true);
    expect(dial.dialed()).toBe(1);
  });
});

describe("the create path is untouched — the count is this route's alone", () => {
  it("`POST /mailboxes` still runs NO folder LIST, so no create pays for a number nobody reads", async () => {
    // The negative control for `countFolders`. The option is off by default and only this route
    // turns it on; if that ever inverts, every create and every claim starts spending a round trip
    // inside the probe deadline to produce a value neither of them reads. Deleting the
    // `countFolders` guard in the probe makes this red while the tests above stay green — which is
    // exactly why the assertion is here and not implied by them.
    const { deps, token } = await session();
    const dial = spyDial(ok);
    await H(req("POST", "/mailboxes", {
      bearer: token,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "imap", address: "u@example.invalid", imap: IMAP,
        smtp: { host: "smtp.example.invalid", port: 465, secure: true, user: "u@example.invalid" },
      }),
    }), deps);
    expect(dial.listed()).toBe(0);
  });
});

describe("the route is gated", () => {
  it("is mounted as `connection`, with step-up", async () => {
    // Read off the table rather than exercised: `connection` is what keeps a mail-server dial out
    // of the set an account with an unproven address may reach, and the step-up is there because
    // the body carries a mailbox password. The spend-gate census holds the arithmetic.
    const route = apiRoutes.find((r) => r.method === "POST" && r.pattern === "/mailboxes/probe");
    expect(route).toBeDefined();
    expect(route!.cost).toBe("connection");
    expect(route!.options?.stepUp).toBe(true);
  });
});

describe("the plaintext consent on Test connection", () => {
  it("carries a ticked consent to the probe, which admits it for a server on the person's own network", async () => {
    // A home server with no TLS: 993 refuses, 143 has no STARTTLS, a plaintext login needs consent.
    const { deps, token } = await session();
    (deps.services as unknown as { probeScopeResolver: unknown }).probeScopeResolver =
      { resolve: async () => ["192.168.1.20"] };
    vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: unknown) {
      const c = (this as { config: { secure: boolean; allowInsecure?: boolean } }).config;
      if (c.secure) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", authenticationFailed: true });
      if (c.allowInsecure !== true) {
        throw Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true, authenticationFailed: true });
      }
    });
    vi.spyOn(ImapAdapter.prototype, "listFolders").mockResolvedValue(["INBOX"]);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const home = { host: "mail.home.example", user: "u@example.invalid", pass: "typed-secret-password-password" };

    const first = await H(post(token, { imap: home }), deps);
    expect(first.status).toBe(400);
    expect((await first.json()).error.details.tls).toEqual({ kind: "tls_unavailable", plaintext: "offered" });

    const second = await H(post(token, { imap: { ...home, allowInsecure: true } }), deps);
    expect(second.status, "the ticked consent never reached the probe").toBe(200);
  });
});

describe("how a test ended is recorded on the managed host (cloud 0054)", () => {
  async function recording(): Promise<{ db: Awaited<ReturnType<typeof makeDeps>>["db"]; deps: ApiDeps; token: string; accountId: string }> {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    return { db, deps: { ...deps, connectAttempts: connectAttemptRecorder(db as unknown as Tx, deps.now) }, token: s.token, accountId: s.accountId };
  }
  const refusedLogin = (): Promise<void> => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" }));

  it("an ok test is one row of closed words, holding nothing the person typed", async () => {
    const { db, deps, token, accountId } = await recording();
    spyDial(ok);
    expect((await H(post(token), deps)).status).toBe(200);
    expect(await db.select().from(connectAttempts)).toEqual([{
      accountId, at: FIXED_NOW, id: expect.any(String),
      door: "test", preset: "imap", outcome: "ok", reason: null, transport: null,
    }]);
  });

  it("Google's named refusal is recorded by its word, against the gmail preset", async () => {
    const { db, deps, token } = await recording();
    spyDial(() => Promise.reject(imapError({
      serverResponseCode: "ALERT", responseText: "Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
    })));
    const res = await H(post(token, { imap: { ...IMAP, host: "IMAP.Gmail.com" } }), deps);
    expect((await res.json()).error.details.authHint).toBe("app_password_required");
    expect(await db.select().from(connectAttempts)).toMatchObject([{
      door: "test", preset: "gmail", outcome: "refused", reason: "auth_app_password_required", transport: "imap",
    }]);
  });

  it("a refused sending leg in the answer is recorded as refused on smtp", async () => {
    const { db, deps, token } = await recording();
    vi.spyOn(deps.services!.mailbox, "probeConnection").mockResolvedValue({
      ok: true, host: IMAP.host, user: IMAP.user, folders: 3,
      sending: { state: "refused", host: "smtp.example.invalid", reason: "tls" },
    });
    expect((await H(post(token), deps)).status).toBe(200);
    expect(await db.select().from(connectAttempts)).toMatchObject([{ outcome: "refused", reason: "tls", transport: "smtp" }]);
  });

  it("a recorder that throws, or none at all, changes neither the status nor the body", async () => {
    const { db, deps, token } = await recording();
    const answer = async (d: ApiDeps): Promise<[number, string]> => {
      const res = await H(post(token), d);
      return [res.status, await res.text()];
    };
    for (const connect of [ok, refusedLogin]) {
      spyDial(connect);
      const recorded = await answer(deps);
      expect(await answer({ ...deps, connectAttempts: async () => { throw new Error("the record failed"); } })).toEqual(recorded);
      expect(await answer({ ...deps, connectAttempts: undefined })).toEqual(recorded);
    }
    expect((await db.select().from(connectAttempts)).map((r) => r.outcome)).toEqual(["ok", "refused"]);
  });

  it("an erasure that lands during the dial records nothing, and the answer is the ordinary one", async () => {
    const { db, deps, token, accountId } = await recording();
    spyDial(async () => { await db.update(accounts).set({ erasedAt: FIXED_NOW }).where(eq(accounts.id, accountId)); });
    const res = await H(post(token), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, host: IMAP.host, user: IMAP.user, folders: 3 });
    expect(await db.select().from(connectAttempts)).toEqual([]);
  });

  it("past 200 attempts in 24 hours the next one is not recorded", async () => {
    const { db, deps, token, accountId } = await recording();
    const minutesAgo = (m: number): Date => new Date(FIXED_NOW.getTime() - m * 60_000);
    // 199 in the day and one just outside it: the next press is the 200th of the day.
    await db.insert(connectAttempts).values([...Array.from({ length: 199 }, (_, i) => minutesAgo(i + 1)), minutesAgo(25 * 60)]
      .map((at) => ({ accountId, at, door: "test", preset: "imap", outcome: "ok" })));
    spyDial(ok);
    for (let i = 0; i < 2; i++) expect((await H(post(token), deps)).status).toBe(200);
    expect(await db.select().from(connectAttempts)).toHaveLength(201);
  });
});
