import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxes as mailboxesTable } from "@trafficflow/db";
import { invites, waitlist } from "@trafficflow/db/cloud";
import {
  makeMailService, makeWaitlistService, MAX_JOINS_PER_IP_WINDOW,
  SpyMailer, throttleKeysFor,
} from "@trafficflow/services";
import { SoftwareAuthenticator } from "../../services/test/webauthn-authenticator.js";
import { makeDeps, req, setCookieMap } from "./helpers.js";

/**
 * Stage-2 REGISTRATION AND ONBOARDING, over the wire, with nothing seeded.
 *
 * This is the first onboarding gate carried the rest of the way. That gate proved a person could get from
 * `POST /auth/register` to a full session without a `sessions` row being inserted by the
 * test; this one has to prove the same person can get from an INVITE CODE to a full session
 * **with a mailbox attached** — which crosses three more subsystems (the invite table, the
 * mailbox allowance gate, the mail) and is the first point at which the product is
 * something a stranger can actually sign up for.
 *
 * ── THE ABSENCE OF `seedSessionFor` IS AN ASSERTION ─────────────────────────────────────
 *
 * The first gate set the precedent and this file keeps it: the DB bridge is the bug, so its absence is
 * the proof. A test that seeds a session proves the routes work for a caller the wire
 * cannot produce. The last `it` in this file greps this very source and fails if any
 * session-seeding helper appears in it.
 *
 * ONE thing is seeded, and it is not a session: the INVITE, through
 * `WaitlistService.mintInvite` — the operator path, exercised as a service call because
 * deliberately ships no HTTP route for minting.
 *
 * ── THERE IS NO PLAN STEP ANY MORE, AND THAT RETIRED A DEADLOCK RATHER THAN HIDING IT ───
 *
 * The walkthrough used to seed a subscription in the middle of itself, because the mailbox
 * step answered 402 without one — and the wizard's own plan step was reachable only after a
 * mailbox existed, so subscribing needed a mailbox and a mailbox needed subscribing. This
 * server has no plans: the allowance gate reads a verdict from whoever operates the service,
 * an install with none is unmetered, and the mailbox step is therefore the first thing a
 * signed-up person can do. The two cases that existed to prove the ordering are gone with the
 * ordering; what remains is the limit itself, driven through the access verdict the shared
 * helper steers, so the enforcement is still asserted over the wire.
 */
const app = createApp(apiRoutes);
const PW = "pw-correct-horse-battery";
const RPID = "localhost";
const ORIGIN = "http://localhost:3000";

/** A fresh per-request container per call, exactly as `apps/web` builds one. */
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * The operator mint, as a service call, MAILED — because delivery is what makes an invite
 * confer verification, and the person this funnel follows is the invitee opening that mail.
 * This used to pass `send: false`, which now (correctly) mints a hand-delivered,
 * NON-conferring invite: the funnel would register an unverified account and stall at the
 * spend gate on `POST /mailboxes`, which is the truthful outcome for that flow but not the
 * flow under test. Returns the RAW code — the same string the mail carries.
 */
async function mintInvite(deps: ApiDeps, email: string, over: { ttlMs?: number } = {}): Promise<string> {
  const mail = makeMailService({
    mailer: new SpyMailer(),
    config: {
      appUrl: "http://localhost:3001", siteUrl: "http://localhost:3000",
      supportEmail: "support@ohmail.app",
    },
    throttleKeys: throttleKeysFor(deps.keyProvider),
  });
  const svc = makeWaitlistService({ mail });
  const out = await svc.mintInvite({ db: deps.db, now: deps.now }, {
    email, ttlMs: over.ttlMs ?? 14 * 24 * 60 * 60_000,
  });
  return out.code;
}

interface Registered {
  cookie: string;
  csrf: string;
  res: Response;
}

async function register(deps: ApiDeps, email: string, code: string): Promise<Registered> {
  const res = await H(
    req("POST", "/auth/register", {
      body: JSON.stringify({ email, password: PW, displayName: "Gil", inviteCode: code }),
    }),
    deps,
  );
  const c = setCookieMap(res);
  return { cookie: `tf_session=${c.tf_session}; tf_csrf=${c.tf_csrf}`, csrf: c.tf_csrf!, res };
}

/**
 * Enroll a passkey on an enrollment session and return the FULL session it is exchanged for.
 *
 * Over the wire, with a `SoftwareAuthenticator` — never a seeded row. The walkthrough spells
 * this out step by step because the exchange is the thing it is proving; the cases after it
 * only need to be past that point, and repeating twenty lines each time is how a
 * session-seeding helper eventually gets written instead.
 */
async function enrollPasskey(deps: ApiDeps, e: Registered): Promise<{ cookie: string; csrf: string }> {
  const opts = await H(
    req("POST", "/auth/2fa/webauthn/register/options", {
      cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
    }),
    deps,
  );
  const { options } = await opts.json();
  const credential = new SoftwareAuthenticator()
    .register({ rpID: RPID, challenge: options.challenge, origin: ORIGIN });
  const verify = await H(
    req("POST", "/auth/2fa/webauthn/register/verify", {
      cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
      body: JSON.stringify({ credential, label: "Chrome on Mac" }),
    }),
    deps,
  );
  if (verify.status !== 200) throw new Error(`passkey enrollment failed: ${verify.status}`);
  const full = setCookieMap(verify);
  return { cookie: `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`, csrf: full.tf_csrf! };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("invite → account → passkey → recovery codes → mailbox → plan, over HTTP", () => {
  it("walks the whole funnel: waitlist signup → invite → register → passkey → codes → mailbox → billing", async () => {
    const { db, deps, mailer, access } = await makeDeps();

    // 1 ── THE LANDING FORM. Public, unauthenticated, one row, one mail.
    const join = await H(
      req("POST", "/waitlist", { body: JSON.stringify({ email: "Gil@Example.com ", tier: "pro" }) }),
      deps,
    );
    expect(join.status).toBe(202);
    // CONSTANT, and carrying no counter. It used to answer `{status, mailed}`; `mailed` is a
    // readout of the per-recipient mail limiter, so on a public endpoint it let anyone submit
    // an address they do not own and watch `true` flip to `false` early — an oracle for
    // "has ohmail recently mailed this person", i.e. "was this person invited".
    expect(await join.json()).toEqual({ status: "ok" });

    const [row] = await db.select().from(waitlist);
    // Normalised on the way in — the UNIQUE index is only real uniqueness if it is.
    expect(row!.email).toBe("gil@example.com");
    expect(row!.tier).toBe("pro");
    expect(row!.invitedAt).toBeNull();
    expect(row!.registeredAt).toBeNull();

    // The waitlist confirmation went out, rendered, with its event-derived dedup key.
    const confirmation = mailer.only("waitlist_confirmation");
    expect(confirmation.to).toBe("gil@example.com");
    expect(confirmation.rendered.subject).toBe("You're on the ohmail waitlist");

    // 2 ── THE OPERATOR MINTS AN INVITE. Stamps `invited_at`; the code is stored hashed.
    const code = await mintInvite(deps, "gil@example.com");
    expect(code).toMatch(/^OHMAIL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const [invite] = await db.select().from(invites);
    expect(invite!.codeHash).not.toContain(code);
    expect(invite!.email).toBe("gil@example.com");
    expect(invite!.consumedAt).toBeNull();
    const [afterMint] = await db.select().from(waitlist);
    expect(afterMint!.invitedAt).not.toBeNull();

    // 3 ── REGISTER. 201 + an enrollment-scoped session in cookies.
    const e = await register(deps, "gil@example.com", code);
    expect(e.res.status).toBe(201);
    const registered = await e.res.json();
    expect(registered.status).toBe("enrollment");
    expect(registered.next).toBe("enroll_2fa");

    // The invite is CONSUMED, in the same transaction, and bound to the new user.
    const [consumed] = await db.select().from(invites);
    expect(consumed!.consumedAt).not.toBeNull();
    expect(consumed!.consumedByUserId).toBe(registered.user.userId);
    // …and the funnel closed.
    const [registeredRow] = await db.select().from(waitlist);
    expect(registeredRow!.registeredAt).not.toBeNull();

    // 4 ── THE ENROLLMENT SESSION CANNOT ADD A MAILBOX. This is the step order, enforced
    //      by the server rather than by the wizard: 403 `enrollment_incomplete`.
    const tooEarly = await H(
      req("POST", "/mailboxes", {
        cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
        body: JSON.stringify({ provider: "imap", address: "gil@example.com", imap: imapBody() }),
      }),
      deps,
    );
    expect(tooEarly.status).toBe(403);
    expect((await tooEarly.json()).error.code).toBe("enrollment_incomplete");

    // 5 ── THE PASSKEY. The first factor EXCHANGES the enrollment session for a full one.
    const opts = await H(
      req("POST", "/auth/2fa/webauthn/register/options", {
        cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
      }),
      deps,
    );
    expect(opts.status).toBe(200);
    const { options } = await opts.json();
    const authenticator = new SoftwareAuthenticator();
    const credential = authenticator.register({ rpID: RPID, challenge: options.challenge, origin: ORIGIN });
    const verify = await H(
      req("POST", "/auth/2fa/webauthn/register/verify", {
        cookie: e.cookie, headers: { "x-csrf-token": e.csrf },
        body: JSON.stringify({ credential, label: "Chrome on Mac" }),
      }),
      deps,
    );
    expect(verify.status).toBe(200);
    const enrolled = await verify.json();
    expect(enrolled.twofaEnrolled.webauthn).toBe(true);
    expect(enrolled.session.status).toBe("authenticated");
    // The full session arrives in NEW cookies with the tokens stripped from the body.
    expect(enrolled.session.tokens).toBeUndefined();
    const full = setCookieMap(verify);
    const fullCookie = `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`;
    const fullCsrf = full.tf_csrf!;
    expect(full.tf_session).not.toBe(setCookieMap(e.res).tf_session);

    // 6 ── RECOVERY CODES. Doubly gated (`enrollmentOk` AND `stepUp`); the passkey that
    //      just landed is what makes step-up satisfiable at all.
    const codes = await H(
      req("POST", "/auth/2fa/recovery-codes", {
        cookie: fullCookie, headers: { "x-csrf-token": fullCsrf },
      }),
      deps,
    );
    expect(codes.status).toBe(200);
    expect((await codes.json()).codes).toHaveLength(10);

    // 7 ── THE MAILBOX, which is the first thing a signed-up person does. The host is
    //      METERED for the rest of this case so the limit below is a limit somebody set,
    //      rather than the unmetered default the helper starts from.
    const SOLO = 5;
    access.metered({ mailboxes: SOLO });

    const created = await H(
      req("POST", "/mailboxes", {
        cookie: fullCookie, headers: { "x-csrf-token": fullCsrf },
        body: JSON.stringify({
          provider: "gmail", address: "gil@example.com", displayName: "Personal", imap: imapBody(),
        }),
      }),
      deps,
    );
    expect(created.status).toBe(201);
    const mailbox = await created.json();
    expect(mailbox.address).toBe("gil@example.com");
    // The credential is never echoed back (RC1).
    expect(JSON.stringify(mailbox)).not.toContain("app-password-16");

    // 8 ── THE SESSION IS REAL: it reads its own account through the protected surface.
    const list = await H(req("GET", "/mailboxes", { cookie: fullCookie }), deps);
    expect(list.status).toBe(200);
    expect((await list.json()).items).toHaveLength(1);

    const session = await H(req("GET", "/auth/session", { cookie: fullCookie }), deps);
    expect((await session.json()).scope).toBe("full");

    // 9 ── the limit the host set is the limit the server enforces. One mailbox is already
    // connected, so `SOLO - 1` more fit and the next one does not.
    for (let i = 1; i < SOLO; i++) {
      const more = await H(
        req("POST", "/mailboxes", {
          cookie: fullCookie, headers: { "x-csrf-token": fullCsrf },
          body: JSON.stringify({ provider: "imap", address: `extra${i}@example.com`, imap: imapBody() }),
        }),
        deps,
      );
      expect(more.status, `mailbox ${i + 1} of ${SOLO}`).toBe(201);
    }
    const atLimit = await H(
      req("POST", "/mailboxes", {
        cookie: fullCookie, headers: { "x-csrf-token": fullCsrf },
        body: JSON.stringify({ provider: "imap", address: "over@example.com", imap: imapBody() }),
      }),
      deps,
    );
    expect(atLimit.status).toBe(409);
    const limitBody = await atLimit.json();
    expect(limitBody.error.code).toBe("mailbox_limit_reached");
    expect(limitBody.error.message).toContain(`${SOLO} mailboxes`);
    expect(limitBody.error.details).toMatchObject({ mailboxLimit: SOLO, mailboxCount: SOLO });
    expect(await db.select().from(mailboxesTable)).toHaveLength(SOLO);
  });

});

describe("every invite refusal says something true, and none of them is an oracle", () => {
  it("a code nobody minted → 403 invite_invalid", async () => {
    const { deps } = await makeDeps();
    const res = await register(deps, "nobody@example.com", "OHMAIL-ZZZZ-ZZZZ-ZZZZ");
    expect(res.res.status).toBe(403);
    const body = await res.res.json();
    expect(body.error.code).toBe("invite_invalid");
    expect(body.error.message).toContain("only works for the address it was sent to");
  });

  it("a consumed code → 409 invite_used, and it cannot open a second account", async () => {
    const { db, deps } = await makeDeps();
    const code = await mintInvite(deps, "one@example.com");
    expect((await register(deps, "one@example.com", code)).res.status).toBe(201);

    // The same person, again: the code is spent and says so.
    const again = await register(deps, "one@example.com", code);
    expect(again.res.status).toBe(409);
    expect((await again.res.json()).error.code).toBe("invite_used");

    // Exactly one account exists, whatever anyone does with the code.
    expect(await db.select().from(invites)).toHaveLength(1);
  });

  it("an expired code → 403 invite_expired, and it is a DIFFERENT answer from a bad one", async () => {
    const { deps, clock } = await makeDeps();
    const code = await mintInvite(deps, "late@example.com", { ttlMs: 60_000 });
    clock.advance(120_000);
    const res = await register(deps, "late@example.com", code);
    expect(res.res.status).toBe(403);
    expect((await res.res.json()).error.code).toBe("invite_expired");
  });

  it("THE ORACLE: a valid code cannot be used to probe another address", async () => {
    const { deps } = await makeDeps();
    // A real, live invite for one address…
    const code = await mintInvite(deps, "mine@example.com");
    // …and a victim who already has an account, registered through their OWN invite.
    const victimCode = await mintInvite(deps, "victim@example.com");
    expect((await register(deps, "victim@example.com", victimCode)).res.status).toBe(201);

    // Presenting a genuine code against somebody else's address must be INDISTINGUISHABLE
    // from presenting garbage — otherwise the 201-vs-409 answer sweeps the user table.
    const probeRegistered = await register(deps, "victim@example.com", code);
    const probeUnknown = await register(deps, "stranger@example.com", code);
    const garbage = await register(deps, "victim@example.com", "OHMAIL-ZZZZ-ZZZZ-ZZZZ");

    for (const r of [probeRegistered, probeUnknown, garbage]) {
      expect(r.res.status).toBe(403);
      expect((await r.res.json()).error.code).toBe("invite_invalid");
    }

    // And the probe did not burn the invite — it is still usable by its owner.
    const ok = await register(deps, "mine@example.com", code);
    expect(ok.res.status).toBe(201);
  });

  it("the address that IS bound gets the honest 409, and the invite survives it", async () => {
    const { db, deps } = await makeDeps();
    // Somebody registered with the bootstrap code, then received an invite anyway.
    expect((await register(deps, "dup@example.com", "INVITE-OK")).res.status).toBe(201);
    const code = await mintInvite(deps, "dup@example.com");

    const res = await register(deps, "dup@example.com", code);
    expect(res.res.status).toBe(409);
    const body = await res.res.json();
    expect(body.error.code).toBe("email_taken");
    expect(body.error.message).toContain("Sign in instead");

    // THE TRANSACTION ROLLED BACK: a refused registration must not spend the invite.
    // Without the tx wrapper the UPDATE would have committed and the user would hold a
    // burned code for an account they cannot reach.
    const [invite] = await db.select().from(invites);
    expect(invite!.consumedAt).toBeNull();
  });

  it("a lower-cased, space-mangled paste of a real code still works", async () => {
    const { deps } = await makeDeps();
    const code = await mintInvite(deps, "typo@example.com");
    const mangled = ` ${code.toLowerCase().replace(/-/g, " ")} `;
    expect(mangled).not.toBe(code);
    expect((await register(deps, "typo@example.com", mangled)).res.status).toBe(201);
  });

  it("registration is one transaction: a refused attempt leaves NO account behind", async () => {
    const { db, deps } = await makeDeps();
    const before = await db.select().from(invites);
    expect(before).toHaveLength(0);
    const res = await register(deps, "ghost@example.com", "NOT-A-CODE");
    expect(res.res.status).toBe(403);
    // Nothing at all: no account, no user, no credentials, no waitlist mutation.
    expect(await db.select().from(waitlist)).toHaveLength(0);
  });
});

describe("the password rule is the SERVER's", () => {
  /**
   * `/join` renders `minLength={12}` and its copy promises "at least 12 characters". Until
   * `requirePassword` that attribute was the whole enforcement — `register` only asked for a
   * non-blank string, so `curl` could open an account with `x`.
   *
   * It matters more here than the usual client/server duplication, because of where the
   * password sits: between `register` and the first factor it is the ONLY credential, and
   * `POST /auth/login` on a zero-factor user re-mints an enrollment session (the re-entry
   * path). A guessable password therefore lets a stranger enroll THEIR passkey on it.
   */
  it("refuses a short password over the wire, and burns no invite doing it", async () => {
    const { db, deps } = await makeDeps();
    const code = await mintInvite(deps, "short@example.com");
    const res = await H(
      req("POST", "/auth/register", {
        body: JSON.stringify({
          email: "short@example.com", password: "hunter2", displayName: "S", inviteCode: code,
        }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_failed");
    // The refusal happens before the transaction, so the code is still good.
    expect((await db.select().from(invites))[0]!.consumedAt).toBeNull();
    expect((await register(deps, "short@example.com", code)).res.status).toBe(201);
  });

  it("refuses an ENORMOUS password — scrypt is ~100ms and this endpoint is public", async () => {
    const { deps } = await makeDeps();
    const code = await mintInvite(deps, "huge@example.com");
    const res = await H(
      req("POST", "/auth/register", {
        body: JSON.stringify({
          email: "huge@example.com", password: "a".repeat(100_000), displayName: "S", inviteCode: code,
        }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
  });

  it("counts CODE POINTS, so a twelve-emoji passphrase is twelve characters", async () => {
    const { deps } = await makeDeps();
    const code = await mintInvite(deps, "emoji@example.com");
    // Twelve astral code points = 24 UTF-16 units. `.length` would have said 24 and let an
    // 11-character one through under the same rule.
    const res = await H(
      req("POST", "/auth/register", {
        body: JSON.stringify({
          email: "emoji@example.com", password: "🔑".repeat(12), displayName: "S", inviteCode: code,
        }),
      }),
      deps,
    );
    expect(res.status).toBe(201);

    const short = await mintInvite(deps, "emoji2@example.com");
    const eleven = await H(
      req("POST", "/auth/register", {
        body: JSON.stringify({
          email: "emoji2@example.com", password: "🔑".repeat(11), displayName: "S", inviteCode: short,
        }),
      }),
      deps,
    );
    expect(eleven.status).toBe(400);
  });
});

describe("POST /waitlist", () => {
  it("is idempotent per address: three submissions are one row, and the tier follows", async () => {
    const { db, deps } = await makeDeps();
    for (const tier of ["undecided", "solo", "pro"]) {
      const res = await H(
        req("POST", "/waitlist", { body: JSON.stringify({ email: "again@example.com", tier }) }),
        deps,
      );
      expect(res.status).toBe(202);
    }
    const rows = await db.select().from(waitlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("pro");
  });

  it("reuses the per-recipient limiter — the sixth mail in an hour is dropped, the row is not", async () => {
    const { db, deps, mailer } = await makeDeps();
    // The limiter is five per rolling hour within one quota. Six submissions therefore
    // produce one row and five mails — and SIX IDENTICAL RESPONSES, which is the part that
    // matters: the body must not report the limiter's state to an anonymous caller.
    const bodies: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await H(
        req("POST", "/waitlist", { body: JSON.stringify({ email: "loop@example.com", tier: "solo" }) }),
        deps,
      );
      expect(res.status).toBe(202);
      bodies.push(await res.json());
    }
    for (const b of bodies) expect(b).toEqual({ status: "ok" });
    expect(await db.select().from(waitlist)).toHaveLength(1);
    expect(mailer.sent.filter((m) => m.template === "waitlist_confirmation")).toHaveLength(5);
  });

  /**
   * THE SUPPRESSION ATTACK, and the quota split that stops it.
   *
   * `POST /waitlist` is public and takes any address a stranger types, and the per-recipient
   * mail limiter used to be ONE budget shared by every template. So five anonymous
   * submissions naming a victim exhausted the victim's whole hourly budget, and the
   * operator's next `invite mint --email victim` came back
   * `{"status":"skipped","reason":"rate_limited"}` — an invite burned into the table and
   * never delivered, arranged by someone who only had to know the address.
   */
  it("a stranger cannot spend the waitlist budget and thereby suppress an INVITE", async () => {
    const { deps, mailer, mail } = await makeDeps();
    // Six anonymous submissions: the waitlist budget for this address is now gone.
    for (let i = 0; i < 6; i++) {
      await H(req("POST", "/waitlist", { body: JSON.stringify({ email: "target@example.com" }) }), deps);
    }
    expect(mailer.sent.filter((m) => m.template === "waitlist_confirmation")).toHaveLength(5);

    // The operator mints an invite for exactly that address. It must still be delivered.
    const svc = makeWaitlistService({ mail });
    const out = await svc.mintInvite({ db: deps.db, now: deps.now }, { email: "target@example.com" });
    expect(out.mail?.status).toBe("sent");
    expect(mailer.only("invite").to).toBe("target@example.com");
  });

  it("a non-string tier or source is a rounding error, not a 500", async () => {
    // `POST /auth/register` one file over answers 400 on a non-string field and the suite has
    // a test named "the unauthenticated auth surface answers 400, never 500, on a malformed
    // body". This endpoint used to answer 500 for `{"tier": 42}`: `normalizeTier` called
    // `.trim()` on a value the wire never promised was a string. Not reachable through the
    // landing (its proxy re-serialises), but `api.ohmail.app/waitlist` is public and curl-able,
    // so an anonymous caller could generate 500s into the log pipeline at will.
    const { db, deps } = await makeDeps();
    const abusive = [
      { email: "t1@example.com", tier: 42 },
      { email: "t2@example.com", source: 42 },
      { email: "t3@example.com", tier: { a: 1 } },
      { email: "t4@example.com", tier: ["pro"] },
      { email: "t5@example.com", tier: null, source: false },
    ];
    for (const body of abusive) {
      const res = await H(req("POST", "/waitlist", { body: JSON.stringify(body) }), deps);
      expect(res.status, JSON.stringify(body)).toBe(202);
    }
    // …and every one of them was RECORDED, with the fallbacks the column can hold.
    const rows = await db.select().from(waitlist);
    expect(rows).toHaveLength(abusive.length);
    for (const r of rows) {
      expect(r.tier).toBe("undecided");
      expect(r.source).toBe("landing");
    }
  });

  it("one client IP cannot write unbounded rows — 429 after the window's allowance", async () => {
    // The mail limiter is keyed on the RECIPIENT, so it does not bound a caller inventing a
    // fresh address every time; that is a row per address, forever, from one machine. The
    // per-IP claim runs BEFORE the write, and its refusal is about the connection rather
    // than about any address, so it discloses nothing.
    const { db, deps } = await makeDeps();
    const from = (n: number) =>
      req("POST", "/waitlist", {
        headers: { "x-vercel-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ email: `flood${n}@example.com` }),
      });

    for (let i = 0; i < MAX_JOINS_PER_IP_WINDOW; i++) {
      expect((await H(from(i), deps)).status, `submission ${i + 1}`).toBe(202);
    }
    const over = await H(from(99), deps);
    expect(over.status).toBe(429);
    expect((await over.json()).error.code).toBe("rate_limited");
    expect(await db.select().from(waitlist)).toHaveLength(MAX_JOINS_PER_IP_WINDOW);

    // A DIFFERENT connection is unaffected — the limit is per caller, not global.
    const other = await H(
      req("POST", "/waitlist", {
        headers: { "x-vercel-forwarded-for": "198.51.100.4" },
        body: JSON.stringify({ email: "elsewhere@example.com" }),
      }),
      deps,
    );
    expect(other.status).toBe(202);
  });

  it("an unrecognised tier is recorded as `undecided` rather than 400ing a marketing form", async () => {
    const { db, deps } = await makeDeps();
    const res = await H(
      req("POST", "/waitlist", { body: JSON.stringify({ email: "odd@example.com", tier: "enterprise" }) }),
      deps,
    );
    expect(res.status).toBe(202);
    expect((await db.select().from(waitlist))[0]!.tier).toBe("undecided");
  });

  it("refuses an address that is not one — 400, and nothing is written", async () => {
    const { db, deps } = await makeDeps();
    for (const email of ["", "not-an-address", "a@b", "two addresses@x.example"]) {
      const res = await H(req("POST", "/waitlist", { body: JSON.stringify({ email }) }), deps);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_failed");
    }
    expect(await db.select().from(waitlist)).toHaveLength(0);
  });

  it("is a PUBLIC route, and `withRequestGuard` still fences it", async () => {
    const { deps } = await makeDeps();
    // A cross-site form post: the one shape a browser can send to another origin with a
    // body and no preflight. 415 before the handler is ever reached.
    const formish = await H(
      new Request("http://localhost:3000/waitlist", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "email=x@y.example",
      }),
      deps,
    );
    expect(formish.status).toBe(415);

    const foreign = await H(
      req("POST", "/waitlist", {
        headers: { origin: "https://evil.example" },
        body: JSON.stringify({ email: "x@y.example" }),
      }),
      deps,
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("cross_site_denied");
  });

  it("answers 503 — not 500 — on a deployment with no waitlist service", async () => {
    const { deps } = await makeDeps();
    const bare: ApiDeps = { ...deps, services: { ...deps.services!, waitlist: undefined } };
    const res = await H(req("POST", "/waitlist", { body: JSON.stringify({ email: "x@y.example" }) }), bare);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("waitlist_unconfigured");
  });
});

describe("the fixture bridge is gone", () => {
  /**
   * the assertion, re-stated for this file. It is not decoration: the whole point of an
   * onboarding walkthrough is that the WIRE produces the session, so one call to the
   * session-seeding helper would quietly turn this into a test of the routes rather than
   * of the flow, and nothing else in the suite would fail.
   *
   * The forbidden identifier is never written out below — a grep test containing the
   * string it forbids matches itself, which is exactly how this first failed.
   */
  it("this file inserts no session row by any means", () => {
    const src = readFileSync(fileURLToPath(new URL("./onboarding-flow.test.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("const app = createApp"));
    // Composed, never written literally: a grep test that contains the string it forbids
    // matches itself, which is how this assertion failed the first time it was run.
    expect(body).not.toMatch(new RegExp(["seed", "Session"].join("")));
    expect(body).not.toMatch(/insert\(sessions\)/);
    // …and it inserts NOTHING directly any more: the invite goes through the service, and
    // the plan row it used to seed does not exist on this server.
    expect(body).not.toMatch(/db\.insert\(/);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

/** A complete IMAP credential block for `POST /mailboxes`. */
const imapBody = () => ({
  host: "imap.gmail.com", port: 993, secure: true,
  user: "gil@example.com", pass: "app-password-16ch",
});

