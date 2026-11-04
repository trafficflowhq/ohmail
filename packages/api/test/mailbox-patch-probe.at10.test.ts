import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { StaticKeyProvider, makeMailboxService } from "@trafficflow/services";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

/**
 * Gap **THE OTHER DOOR INTO `mailbox_credentials` WAS STILL UNLOCKED.**
 *
 * The add-time probe made `POST /mailboxes` try the credentials before storing them, and made
 * the probe a REQUIRED parameter of `MailboxService.create` so no new create site could forget.
 * This file is the audit of everything else that writes a credential. Exactly one reachable path was
 * left: `PATCH /mailboxes/:id` with an `imap.pass`, which re-encrypted whatever was sent and
 * answered 200 with **zero connection attempts** — the same defect the probe exists to end, one
 * screen later and against a mailbox that was already working.
 *
 * ── WHY THIS PATH IS NOT A BACKWATER ────────────────────────────────────────────────────────
 *
 * It is the DESKTOP'S DOCUMENTED CREDENTIAL-RECOVERY ROUTE. `apps/sidecar/src/engine.ts` says so
 * in as many words about a sealed login its key can no longer open — "re-entry through
 * `PATCH /mailboxes/:id` is what replaces it" — and the sidecar mounts `createApp(apiRoutes)`,
 * so this is the local engine's own surface and not merely the hosted API's. A user whose stored
 * password became unreadable retypes it here; before this slice, a typo at that moment was
 * accepted silently and surfaced later as a quarantined mailbox.
 *
 * ── WHAT THESE TESTS MEASURE, AND WHY IT IS NOT THE LOCAL IMAP SERVER ───────────────────────
 *
 * Hazard recorded: the local IMAP test server runs with AUTHENTICATION DISABLED
 * and accepts every password, so any test phrased as "a wrong password is rejected" passes
 * vacuously against it and proves nothing.
 *
 * No test in this file uses that server, or any server. `ImapAdapter.prototype.connect` is spied,
 * which makes the measurement **the number of dials and the rows that exist afterwards** — and
 * the verdict is driven by throw shapes this file constructs, not by a server's opinion of a
 * password. The assertions are therefore of the form "a dial happened / no dial happened" and
 * "the stored secret did / did not change", none of which can be satisfied by a permissive
 * server. The one test about a *correct* password (`the stored secret is replaced only after a
 * dial that succeeded`) asserts the DIAL COUNT, never that a particular password was accepted.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const body = (o: unknown): string => JSON.stringify(o);

/** The same KEK `makeDeps` injects, so a raw `secret_enc` can be decrypted independently. */
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);

const IMAP = { host: "imap.example.invalid", port: 993, secure: true, user: "u@example.invalid", pass: "before-rotation-password" };

/**
 * A thrown value shaped like the ones `imapflow@1.5.0` really produces.
 *
 * `authenticationFailed` is set on EVERY failure of the LOGIN command, unconditionally
 * (`lib/commands/login.js:38`). Every fixture here carries it, so a classifier that reads the
 * flag before the structured codes is caught by the cases that are NOT a rejected password.
 */
function imapError(over: Record<string, unknown>): Error {
  return Object.assign(new Error("login failed"), { authenticationFailed: true }, over);
}

/**
 * Count the logins a request actually attempted, and record what each one was dialled WITH.
 *
 * `ImapAdapter` holds its config in a TypeScript-private field, which is an ordinary property at
 * runtime — so the spy can report the exact `host/port/secure/user` the probe was built from.
 * That is what makes "what is probed is what is stored" checkable rather than asserted.
 */
function spyDial(outcome: () => Promise<void>): {
  dialed: () => number;
  closed: () => number;
  configs: () => ImapConfig[];
} {
  let dialed = 0;
  let closed = 0;
  const configs: ImapConfig[] = [];
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: ImapAdapter) {
    dialed += 1;
    configs.push((this as unknown as { config: ImapConfig }).config);
    await outcome();
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async () => { closed += 1; });
  return { dialed: () => dialed, closed: () => closed, configs: () => configs };
}

const ok = (): Promise<void> => Promise.resolve();

/** A session with a live plan and a connected mailbox, created through the real POST path. */
async function connected(): Promise<{
  db: Awaited<ReturnType<typeof makeDeps>>["db"];
  deps: ApiDeps;
  token: string;
  id: string;
}> {
  const { db, deps } = await makeDeps();
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  // `makeDeps` stubs the dialler to succeed suite-wide, so this create stores cleanly.
  const res = await H(req("POST", "/mailboxes", {
    bearer: s.token,
    headers: { "content-type": "application/json" },
    body: body({ provider: "imap", address: "u@example.invalid", imap: IMAP }),
  }), deps);
  expect(res.status).toBe(201);
  return { db, deps, token: s.token, id: (await res.json()).id };
}

const patch = (token: string, id: string, b: unknown): Request =>
  req("PATCH", `/mailboxes/${id}`, {
    bearer: token, headers: { "content-type": "application/json" }, body: body(b),
  });

const imapCred = async (
  db: Awaited<ReturnType<typeof makeDeps>>["db"], id: string,
): Promise<{ secretEnc: string; keyVersion: number; meta: unknown }> =>
  (await db.select().from(mailboxCredentials)
    .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "imap"))))[0]!;

afterEach(() => { vi.restoreAllMocks(); });

describe("a credential rewrite is tried before it is stored", () => {
  /**
   * THE REPRODUCTION. Before this slice: 200, zero dials, and the stored secret replaced by one
   * the mail server would have refused. The mailbox went on reporting `connected` until the
   * worker next tried it.
   */
  it("REPRODUCTION: a rotated password the server refuses is not stored, and the dial really happened", async () => {
    const { db, deps, token, id } = await connected();
    const before = await imapCred(db, id);

    const dial = spyDial(() => Promise.reject(imapError({ serverResponseCode: "AUTHENTICATIONFAILED" })));
    const res = await H(patch(token, id, { imap: { pass: "mistyped-entry-password" } }), deps);

    // The dial happened at all. Before this slice it never did, for any credential.
    expect(dial.dialed()).toBe(1);
    expect(res.status).toBe(400);
    const wire = await res.json();
    expect(wire.error.code).toBe("mailbox_probe_failed");
    expect(wire.error.details.reason).toBe("auth");

    // AND THE OLD CREDENTIAL SURVIVED. A failed rotation must not destroy a working login —
    // that would turn one typo into a mailbox that stops syncing.
    const after = await imapCred(db, id);
    expect(after.secretEnc).toBe(before.secretEnc);
    expect(await KP.decrypt(after.secretEnc, after.keyVersion)).toBe("before-rotation-password");

    // AND THE MAILBOX WAS NOT STOOD DOWN. The row is exactly as it was — still `connected`, still
    // on the worker's roster — so the organizer keeps running on the credential that survived
    // above. The probe refuses BEFORE the transaction, so a refused save writes nothing at all;
    // this is the assertion that a bad edit can never weaken a working mailbox's status.
    const row = (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;
    expect(row.status).toBe("connected");

    // The sentence never contains what was typed.
    expect(JSON.stringify(wire)).not.toContain("mistyped-entry-password");
  });

  /**
   * The probe must not become a tax on every PATCH. A rename carries no secret, so there is
   * nothing to try and nobody's connection budget to spend.
   */
  it("a PATCH that carries no secret dials nothing", async () => {
    const { deps, token, id } = await connected();
    const dial = spyDial(ok);

    const rename = await H(patch(token, id, { displayName: "Renamed" }), deps);
    expect(rename.status).toBe(200);
    expect((await rename.json()).displayName).toBe("Renamed");

    const disable = await H(patch(token, id, { status: "disabled" }), deps);
    expect(disable.status).toBe(200);

    expect(dial.dialed()).toBe(0);
  });

  /**
   * THE CONFUSION THAT PREVIOUSLY QUARANTINED WORKING MAILBOXES. A connection refusal is not a
   * rejected password, and saying so sends the user to change a password that was always fine.
   */
  it("a refused connection is not reported as a wrong password", async () => {
    const { db, deps, token, id } = await connected();
    spyDial(() => Promise.reject(imapError({ code: "ECONNREFUSED" })));

    const res = await H(patch(token, id, { imap: { pass: "unchanged-entry-password" } }), deps);
    const wire = await res.json();

    expect(wire.error.details.reason).toBe("connect");
    expect(wire.error.message.toLowerCase()).toContain("reach");
    expect(wire.error.message.toLowerCase()).not.toContain("password");
    // Unproven ⇒ not stored, and the working credential is left alone.
    expect(await KP.decrypt((await imapCred(db, id)).secretEnc, 1)).toBe("before-rotation-password");
  });

  /**
   * WHAT IS PROBED IS WHAT WILL BE STORED.
   *
   * A PATCH may carry a partial transport block — a new password and a corrected host, with the
   * port and user left alone. The probe must dial the MERGE of the patch over what is stored, or
   * it proves a login the worker will never make: dialling the patch alone would send port
   * `undefined`, and dialling the stored config alone would ignore the correction the user just
   * typed.
   *
   * This also pins the write half. `upsertCredOn` replaced `meta` WHOLESALE, so a partial patch
   * silently destroyed the stored port, user and TLS mode — a mailbox that had been probed
   * successfully was then handed to the worker with a config that had never been tried.
   */
  it("a partial credential patch is dialled, and stored, as the merge over what was already there", async () => {
    const { db, deps, token, id } = await connected();
    const dial = spyDial(ok);

    const res = await H(patch(token, id, {
      imap: { pass: "after-rotation-password", host: "imap2.example.invalid" },
    }), deps);
    expect(res.status).toBe(200);

    // Dialled: the new host, and the port/user/secure that were already stored.
    expect(dial.dialed()).toBe(1);
    const cfg = dial.configs()[0]!;
    expect(cfg.host).toBe("imap2.example.invalid");
    expect(cfg.port).toBe(993);
    expect(cfg.secure).toBe(true);
    expect(cfg.auth.user).toBe("u@example.invalid");

    // Stored: the same merge, not the patch alone.
    const after = await imapCred(db, id);
    expect(after.meta).toEqual({
      host: "imap2.example.invalid", port: 993, secure: true, user: "u@example.invalid",
    });
    expect(await KP.decrypt(after.secretEnc, after.keyVersion)).toBe("after-rotation-password");
  });

  /**
   * THE SAME CLOBBER, ON THE TRANSPORT THAT IS *NOT* PROBED — which is where the fix has to live
   * in SQL rather than in the merge above.
   *
   * `upsertCredOn` assigned `meta` wholesale. The IMAP path no longer notices, because
   * `probedImapMeta` hands it an already-merged object (what is dialled must be what is stored).
   * SMTP has no probe and therefore no merge step, so it still passes `metaOf(patch.smtp)` —
   * a partial object — straight into the upsert. Without the jsonb merge, correcting an SMTP
   * port silently erases the stored host, and the next send has nowhere to connect.
   *
   * This test exists because mutating the SQL merge left the IMAP case GREEN: the guard above
   * proves the application-level merge and says nothing about this one.
   */
  it("a partial SMTP patch keeps the stored SMTP params it did not mention", async () => {
    const { db, deps, token, id } = await connected();
    spyDial(ok);

    // Give the mailbox a full SMTP credential first, the shape `POST /mailboxes` writes.
    const seed = await H(patch(token, id, {
      smtp: { pass: "outgoing-server-password", host: "smtp.example.invalid", port: 465, secure: true, user: "u@example.invalid" },
    }), deps);
    expect(seed.status).toBe(200);

    // Now correct ONLY the port.
    const res = await H(patch(token, id, { smtp: { pass: "outgoing-server-password", port: 587 } }), deps);
    expect(res.status).toBe(200);

    const smtp = (await db.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, "smtp"))))[0]!;
    expect(smtp.meta).toEqual({
      host: "smtp.example.invalid", port: 587, secure: true, user: "u@example.invalid",
    });
  });

  /**
   * The probe is a login, so it goes through the admission counter like every other one —
   * and gives the slot back, or a user who mistypes once cannot correct it.
   */
  it("the rotation's probe is admitted, released, and closes its socket", async () => {
    const { db, deps, token, id } = await connected();
    const dial = spyDial(ok);

    await H(patch(token, id, { imap: { pass: "after-rotation-password" } }), deps);

    expect(dial.closed()).toBe(1);
    const admission = (await db.select().from(authThrottle)).filter((r) => r.key.startsWith("imap:mailbox:"));
    expect(admission.length).toBeGreaterThan(0);
    for (const row of admission) expect(row.failures).toBe(0);
    // The key is a digest — no address in the clear, matching the create path's.
    for (const row of admission) expect(row.key).not.toContain("example.invalid");
  });

  /**
   * THE ENFORCEMENT ITSELF, EXERCISED RATHER THAN ASSUMED.
   *
   * `UpdateMailboxOptions` is required in the type, and CLAUDE.md records that
   * `packages/services` compiles `src` only — so for its ~17 `update` call sites that type is
   * never checked. This is the guard that actually runs. Called the way an un-typechecked caller
   * would call it: four arguments' worth of intent, three arguments supplied.
   *
   * It must REFUSE, not store. A path that quietly stored "just this once" is the whole defect.
   */
  it("a credential write with no probe at all is refused, not stored", async () => {
    const { db, id } = await connected();
    const before = await imapCred(db, id);
    const dial = spyDial(ok);

    // The account id the mailbox really belongs to — read back rather than assumed, so this
    // cannot pass by 404-ing on ownership instead of on the missing probe.
    const owner = (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!.accountId;
    const err = await makeMailboxService({ keyProvider: KP }).update(
      { db, accountId: owner, now: () => FIXED_NOW } as never,
      id,
      { imap: { pass: "unchecked-entry-password" } },
    ).catch((e: unknown) => e) as { httpStatus?: number };

    expect(err).toBeInstanceOf(Error);
    expect(err.httpStatus).toBe(500);
    expect(dial.dialed()).toBe(0);
    // Untouched. Not the new password, not a blank, not a partial write.
    const after = await imapCred(db, id);
    expect(after.secretEnc).toBe(before.secretEnc);
    expect(await KP.decrypt(after.secretEnc, after.keyVersion)).toBe("before-rotation-password");
  });

  /**
   * A mailbox that is not yours is a 404, and it is a 404 BEFORE anything is dialled. Otherwise
   * `PATCH /mailboxes/<guessed-id>` is a free connect oracle for arbitrary host:port, which is
   * strictly more than the create path offers.
   */
  it("a cross-account rotation 404s without dialling", async () => {
    const { db, deps, token: _owner, id } = await connected();
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok", lastTwofaAt: FIXED_NOW });
    const dial = spyDial(ok);

    const res = await H(patch(other.token, id, {
      imap: { pass: "x", host: "attacker.invalid", port: 12345 },
    }), deps);

    expect(res.status).toBe(404);
    expect(dial.dialed()).toBe(0);
  });

  /**
   * ── THE MERGE HAS NOTHING TO MERGE OVER ON A DESKTOP'S FIRST CONNECT (public issue #5) ──────
   *
   * Every other test in this file reaches the patch through `POST /mailboxes`, which writes the
   * `mailbox_credentials` row and its non-secret `meta` — so `stored` is always populated and the
   * merge always finds a host. The DESKTOP LOCAL DOOR does not take that path at all: the engine's
   * `ensureLocalWorld` inserts a `mailboxes` row directly and no credential row, because there is
   * no password to seal at that moment. The row below is that state, reproduced exactly.
   *
   * Against it, a pass-only patch — which is what the door used to send — merges to a config with
   * no host and is refused with **"imap host is required"**, which is the sentence the first
   * external user photographed after typing every field correctly. The refusal is RIGHT: a
   * credential the adapter could never dial must not be sealed, and the alternative (guessing a
   * host) is the "true sentence about the wrong thing" this whole file exists to end.
   *
   * So this is a characterization test, not a bug report. It pins the requirement that made the
   * door's omission fatal, so that a future simplification of `enterLocalDoor` back to a pass-only
   * body fails HERE, with this comment attached, rather than on someone's first launch.
   */
  it("refuses a pass-only rotation on a mailbox that has no stored transport, without dialling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    // The engine's own shape: a connected mailbox, and deliberately NO credential row.
    const [row] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: "me@my-own-server.example",
      status: "connected",
    }).returning();
    const mailboxId = row!.id;
    expect(await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId))).toHaveLength(0);

    const dial = spyDial(ok);
    const res = await H(patch(s.token, mailboxId, { imap: { pass: "correct-password" } }), deps);

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("imap host is required");
    // Refused BEFORE any connection — the point of the pre-dial check.
    expect(dial.dialed()).toBe(0);
    // And nothing was sealed on the way out.
    expect(await db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId))).toHaveLength(0);

    // THE SAME PATCH, CARRYING THE TRANSPORT, IS ACCEPTED — which is what the door now sends.
    const ok2 = await H(patch(s.token, mailboxId, {
      imap: {
        host: "mail.my-own-server.example", port: 993, secure: true,
        user: "me@my-own-server.example", pass: "correct-password",
      },
    }), deps);
    expect(ok2.status).toBe(200);
    expect(dial.dialed()).toBe(1);
    expect(dial.configs()[0]!.host).toBe("mail.my-own-server.example");
    const sealed = await imapCred(db, mailboxId);
    expect(await KP.decrypt(sealed.secretEnc, sealed.keyVersion)).toBe("correct-password");
    expect((sealed.meta as { host: string }).host).toBe("mail.my-own-server.example");
  });

  /**
   * AND THE SAME PASS-ONLY PATCH ON A MAILBOX A SIGN-OUT LOCATED (mail 0127) — the web's Settings
   * press arrives here exactly as the rotation above. The sign-out removed the credential rows and
   * kept their non-secret half on the mailbox row, so the merge has a host again: the password is
   * tried against THAT server and stored against it. The row above, which kept nothing, is still
   * refused without a dial.
   */
  it("a pass-only rotation on a signed-out mailbox is tried and stored against its kept server", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const [row] = await db.insert(mailboxes).values({
      accountId: s.accountId, provider: "imap", address: "me@my-own-server.example",
      status: "connected",
      signedOutMeta: { imap: { host: "mail.my-own-server.example", port: 993, secure: true, user: "me@my-own-server.example" } },
    }).returning();
    const mailboxId = row!.id;

    const dial = spyDial(ok);
    const res = await H(patch(s.token, mailboxId, { imap: { pass: "correct-password" } }), deps);
    expect(res.status).toBe(200);
    expect(dial.dialed()).toBe(1);
    expect(dial.configs()[0]).toMatchObject({
      host: "mail.my-own-server.example", port: 993, secure: true, auth: { user: "me@my-own-server.example" },
    });
    const sealed = await imapCred(db, mailboxId);
    expect(sealed.meta).toMatchObject({ host: "mail.my-own-server.example", port: 993, user: "me@my-own-server.example" });
    expect(await KP.decrypt(sealed.secretEnc, sealed.keyVersion)).toBe("correct-password");
  });
});
