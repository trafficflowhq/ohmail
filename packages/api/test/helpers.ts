import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts,
  users,
  sessions,
  devices,
  mailboxes,
  mailboxFolders,
  rules,
  messages,
  folderState,
  threads,
  messageBodies,
  routingDecisions,
  approvals,
  contacts,
  UNMETERED_ACCESS, type AccessVerdict, type AccessRefusal,
} from "@trafficflow/db";
import {
  staffSessions, staffUsers, staffRoleGrants, acquireImapSlot, releaseImapSlot,
} from "@trafficflow/db/cloud";
import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService, redeemInviteGrant,
  syncService, pushService, makeMailboxService, rulesService, messageService, threadService,
  makeScreenerService, makeApprovalService, triageService, searchService, makePrivacyService,
  contactsService, snippetsService, notifyRulesService, awayResponderService, attachmentsService,
  kbService, tagsService, draftsService, draftingService, scheduleService, sendService, workflowsService, proposalsService,
  makeWaitlistService, makeMailService, SpyMailer, makeUnsubscribeService,
  type AdminDb, type AuthConfig, type Db, type HostResolver, type RemoteFetch, type MailService,
  type OneClickPost, type StaffRole,
} from "@trafficflow/services";
import { vi } from "vitest";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { DraftPort, OpenSendAdapter } from "@trafficflow/core";
import type { ApiDeps } from "@trafficflow/api";

export const FIXED_NOW = new Date("2026-07-28T12:00:00.000Z");

/** A mutable test clock threaded through `deps.now`. */
export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

/**
 * A fresh PGlite-backed `ApiDeps` with an injected, ADVANCEABLE clock (no session
 * by default) and a fully-wired `services.auth`. `authOver` tweaks the AuthConfig
 * (e.g. `{ maxFailures: 3 }`) so lockout is exercisable at the HTTP layer.
 */
/** A 1×1 transparent GIF (43 bytes) — the default proxy-fetch payload in tests. */
export const ONE_BY_ONE_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

/** A default mock DraftPort: echoes a deterministic result (no network). */
export const DEFAULT_MOCK_DRAFTER: DraftPort = {
  async draft() {
    return { subject: "Re: (draft)", body: "Mock reply body.", rationale: "mock rationale" };
  },
};

/**
 * HOW A TEST SAYS WHAT THE ENTITLEMENTS PROGRAM WOULD ANSWER.
 *
 * It replaced `seedSubscription`, which inserted a row into a table this server no longer has.
 * The distinction the old helper could not make is the one that matters now: a test whose
 * subject is a mailbox mutation needs NO verdict at all (unmetered admits), and a test whose
 * subject is the REFUSAL says which of the port's two words it is refusing with.
 */
export interface AccessHandle {
  /** The verdict verbatim, for a case that needs a shape neither helper below makes. */
  set(v: AccessVerdict): void;
  /** A metered host that permits: limits default to 10 mailboxes and 5 GB. */
  metered(o?: {
    mailboxes?: number | null; storageBytes?: number | null;
    canAddMailbox?: boolean; aiEnabled?: boolean;
  }): void;
  /** A refusal, in the port's own two words. */
  refuse(reason: AccessRefusal): void;
}

/**
 * THE IMAP DIALLER, FAKED SUITE-WIDE — the same rule as `RemoteFetch`, `HostResolver`, `DraftPort`
 * and `SpyMailer` above, applied to the one seam that had no fake because nothing in the API
 * dialled on a route a test drives.
 *
 * The add-time probe changed that: `POST /mailboxes` now tries the credentials before storing them, so every
 * route test that connects a mailbox — and there are a dozen, most of them about something else
 * entirely — would otherwise open a real socket to `imap.example`. The "Testing bar" invariant ("the suite performs
 * zero external requests") is enforced by `test/setup/no-external-network.ts`, so the honest fix
 * is a fake at the seam rather than hosts that happen not to resolve.
 *
 * IT DEFAULTS TO SUCCESS, and that is a deliberate choice about what a fixture asserts: a test
 * whose subject is billing, or step-up, or the DTO shape, is entitled to a mailbox that connects.
 * A test whose subject IS the probe re-spies these two methods with the shape it means to drive
 * (`mailbox-add-probe.wprobe.test.ts`), which wins because it is installed second.
 */
export function stubImapDial(): void {
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
}

export async function makeDeps(
  start: Date = FIXED_NOW,
  authOver: Partial<AuthConfig> = {},
  over: {
    remote?: RemoteFetch; resolver?: HostResolver; drafter?: DraftPort; sendAdapter?: OpenSendAdapter;
    oneClickPost?: OneClickPost; trustedAuthservIds?: ReadonlySet<string>;
    smtpVerify?: (smtp: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => Promise<void>;
  } = {},
): Promise<{
  db: Db; deps: ApiDeps; clock: TestClock; mailer: SpyMailer; mail: MailService;
  access: AccessHandle;
}> {
  const db = await makeTestDb();
  stubImapDial();
  // THE ACCESS VERDICT EVERY ROUTE READ ANSWERS FROM, and the one place a test steers it.
  // UNMETERED is the default because it is the only verdict a host with no entitlements program
  // can give, and because a limit that is never the subject must not be a precondition to seed.
  let verdict: AccessVerdict = UNMETERED_ACCESS;
  const access: AccessHandle = {
    set(v) { verdict = v; },
    metered(o = {}) {
      verdict = {
        ok: true,
        limits: {
          mailboxes: o.mailboxes === undefined ? 10 : o.mailboxes,
          storageBytes: o.storageBytes === undefined ? 5_000_000_000 : o.storageBytes,
          canAddMailbox: o.canAddMailbox ?? true,
          aiEnabled: o.aiEnabled ?? true,
        },
      };
    },
    refuse(reason) { verdict = { ok: false, reason }; },
  };
  const authDeps = makeTestAuthDeps(authOver);
  let t = new Date(start);
  // Default injected RemoteFetch: returns a 1×1 GIF. Privacy tests pass their own
  // mock via `over.remote` to control bytes and assert the url-only call signature.
  const remote: RemoteFetch = over.remote ?? {
    async fetch(_url: string) {
      return { status: 200, contentType: "image/gif", body: ONE_BY_ONE_GIF };
    },
  };
  // the SSRF gate's DNS port, required at construction and therefore visible
  // here. A fixed PUBLIC address, so route tests exercise the PERMIT branch; the
  // refuse branch is proven in `packages/services/test/privacy-service.test.ts`
  // against a resolver that answers `169.254.169.254`.
  const resolver: HostResolver = over.resolver ?? {
    async resolve(_hostname: string) {
      return ["93.184.216.34"];
    },
  };
  // the mail seam, injected exactly as production injects `ResendMailer`.
  // Loopback origins so `assertLinkBase` accepts them (DEFAULT_LINK_ORIGINS includes them
  // for precisely this harness).
  const mailer = new SpyMailer();
  const mail = makeMailService({
    mailer,
    config: {
      appUrl: "http://localhost:3001",
      siteUrl: "http://localhost:3000",
      supportEmail: "support@ohmail.app",
    },
  });
  const deps: ApiDeps = {
    db,
    // THE STAFF HANDLE, AND AN HONEST STATEMENT OF WHAT IT PROVES HERE.
    //
    // PGlite has no roles: `CREATE ROLE` is not a thing it does, so the column-granted
    // `ohmail_admin` that makes `SELECT subject FROM messages` raise a permission error in production is
    // STRUCTURALLY INVISIBLE to this harness. Branding the same handle by cast is therefore
    // not a fake of the guarantee — it is the deliberate statement that these tests prove the
    // PROJECTION half (nothing content-shaped reaches a response, over a database that would
    // happily hand it over) and prove nothing at all about the role.
    //
    // The role half has its own guard, on real Postgres, executing the shipped script:
    // `packages/db/test/staff-role.pg.test.ts`. Neither substitutes for the other, and that
    // file's second mutation — point the admin connection at the runtime role and watch every
    // denial fail — exists precisely so the pg guard cannot degrade into this cast.
    adminDb: () => Promise.resolve(db as unknown as AdminDb),
    now: () => t,
    requestId: "test-request",
    session: null,
    authConfig: authDeps.config,
    keyProvider: authDeps.keyProvider,
    services: {
      // the SAME `MailService` the waitlist gets, handed to `AuthService` as production
      // does it (`apps/api-vercel/src/deps.ts`). Without it `register`'s open path answers
      // `503 signup_unavailable`, which is correct behaviour and would make every public-signup
      // HTTP case fail on configuration rather than on its subject. `mailer` is returned above so
      // a test can assert which template went where.
      auth: makeAuthService({ ...authDeps, mail }),
      // The invite arm's bridge, exactly as the self-host composition wires it — the test
      // database migrates both journals, so the `invites` table is really there.
      inviteRedeem: redeemInviteGrant,
      sync: syncService,
      push: pushService,
      // The real counter — `makeTestDb()` replays BOTH journals, so `auth_throttle` exists here
      // and the tests assert against the thing production runs rather than against a stub.
      imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot },
      // The SMTP probe's dial, faked so no route test opens a submission socket — the same
      // reason `ImapAdapter.prototype.connect` is spied on the IMAP side. Tests that assert
      // SMTP probe behaviour override this through `over`.
      smtpVerify: over.smtpVerify ?? (async () => { /* the submission host accepts the login */ }),
      // Write-capable: the mailbox mutations envelope-encrypt creds via the same
      // StaticKeyProvider the AuthService uses in tests.
      /* The MANAGED shape: the paid allowance gate (the barrel's default) reading its LIMIT from
         an entitlements verdict this harness holds. UNMETERED by default — which is what a host
         that configures no entitlements program answers — and steered per test through the
         returned {@link AccessHandle}. Without a reader at all the gate refuses outright, which
         is the point of its refusal: a host that runs the paid gate must say where the limit
         comes from. */
      mailbox: makeMailboxService({
        keyProvider: authDeps.keyProvider,
        accessOf: async () => verdict,
        // No signature check: `providerConfirms` reads the provider table alone here, as these
        // route tests always have. `mailbox-provider-confirms.test.ts` drives both answers.
        signatureChecks: false,
      }),
      rules: rulesService,
      message: messageService,
      thread: threadService,
      // NO adapter injected → screener/approval moves DEFER to the worker
      // (folder_state left `pending`); classifier omitted → screener aiSuggestion null.
      screener: makeScreenerService({}),
      approval: makeApprovalService({}),
      triage: triageService,
      search: searchService,
      privacy: makePrivacyService({ remote, resolver }),
      // RFC 8058 one-click. The outbound port is a RECORDING fake by default, so no route
      // test can open a socket to a sender, and the trusted set defaults to EMPTY, which is what
      // a mailbox at an unlisted provider resolves to: it believes nobody, so it demotes nothing.
      unsubscribe: makeUnsubscribeService({
        post: over.oneClickPost ?? { async post() { return { status: 200 }; } },
        resolver,
        trustedAuthservIdsFor: async () => over.trustedAuthservIds ?? new Set<string>(),
      }),
      contacts: contactsService,
      snippets: snippetsService,
      notify: notifyRulesService,
      away: awayResponderService,
      attachments: attachmentsService,
      kb: kbService,
      tags: tagsService,
      drafts: draftsService,
      // Send later's two verbs (mail 0077) — the scheduled-send pass is exercised in
      // `packages/services`; here the routes just need their service.
      schedules: scheduleService,
      // slice 3b: the drafting flow + an INJECTED mock DraftPort (no live model).
      drafting: draftingService,
      drafter: over.drafter ?? DEFAULT_MOCK_DRAFTER,
      // slice 3c: gated idempotent send. The route injects `openSendAdapter =
      // makeSendAdapter` per-call unless a test provides a fake send spy here.
      sends: sendService,
      // workflow storage + CRUD + run enqueue (REST-only; the step runner is separate).
      workflows: workflowsService,
      // slice 4b: AI workflow proposals — list/dismiss over REST (generation is the worker cron).
      proposals: proposalsService,
      // the funnel. Wired with the SPY mailer, so `POST /waitlist` exercises the
      // real MailService — the real per-recipient limiter, the real template render, the
      // real idempotency key — with no transport in the picture (the "Testing bar" invariant). A test reads
      // what was mailed off `mailer.sent`.
      waitlist: makeWaitlistService({ mail }),
      ...(over.sendAdapter ? { sendAdapter: over.sendAdapter } : {}),
    },
  };
  const clock: TestClock = { now: () => t, advance: (ms) => { t = new Date(t.getTime() + ms); } };
  return { db, deps, clock, mailer, mail, access };
}

export interface SeededSession {
  token: string;
  accountId: string;
  userId: string;
  sessionId: string;
}

/**
 * Insert account → user → session with `accessTokenHash = hashToken(token)`.
 * `lastTwofaAt`/`accessExpiresAt`/`revokedAt` are tunable so tests can exercise
 * step-up staleness and expiry/revocation. `scope` lets a middleware test
 * fabricate an enrollment-scoped session without running the whole onboarding flow;
 * it defaults to the column default `'full'`, so every pre-S2 caller is unaffected.
 *
 * ── THE SEEDED USER IS EMAIL-VERIFIED BY DEFAULT, AND `emailVerified: false` IS OPT-IN ──
 *
 * `withVerifiedEmail` 403s `POST /billing/checkout` and `POST /mailboxes` for an unproven
 * address, so a helper that seeded `email_verified_at = NULL` would have made dozens of suites
 * whose subject is something else (mailbox mutations, billing routes, sync, sends) fail on a
 * gate they are not testing. Defaulting to verified keeps each of those tests about its own
 * subject.
 *
 * That default is safe HERE and would not be in the service: this fixture fabricates a session
 * row directly, so it is already asserting nothing about how the session was obtained. The gate
 * itself is proven by tests that pass `emailVerified: false` EXPLICITLY (see
 * `email-verification-gate.test.ts`), which is the shape that cannot rot — a future route that
 * forgets `verifiedEmail: true` fails there, and no amount of default-verified fixtures hides it.
 */
export async function seedSession(
  db: Db,
  opts: {
    now: Date; token?: string; lastTwofaAt?: Date | null; accessExpiresAt?: Date;
    revokedAt?: Date | null; scope?: "full" | "enrollment";
    /** default `true`. Pass `false` to exercise `withVerifiedEmail`. */
    emailVerified?: boolean;
  },
): Promise<SeededSession> {
  const token = opts.token ?? generateToken();
  const [acct] = await db.insert(accounts).values({ name: "Test" }).returning();
  // A DISTINCT address per seeded account. It used to be one hard-coded
  // address for every call, which was invisible until migration 0021 made
  // the login email globally unique — a second `seedSession` in one test then failed on the
  // constraint. That is the constraint working: two accounts sharing a login address is
  // exactly what it exists to make unrepresentable, and a fixture is not an exception.
  const [user] = await db.insert(users)
    .values({
      accountId: acct!.id, email: `mila+${acct!.id}@lichtgrat.example`, displayName: "Mila",
      emailVerifiedAt: opts.emailVerified === false ? null : opts.now,
    })
    .returning();
  const [sess] = await db.insert(sessions).values({
    accountId: acct!.id,
    userId: user!.id,
    familyId: crypto.randomUUID(),
    accessTokenHash: hashToken(token),
    accessExpiresAt: opts.accessExpiresAt ?? new Date(opts.now.getTime() + 60 * 60 * 1000),
    refreshExpiresAt: new Date(opts.now.getTime() + 2 * 60 * 60 * 1000),
    lastTwofaAt: opts.lastTwofaAt ?? null,
    revokedAt: opts.revokedAt ?? null,
    ...(opts.scope ? { scope: opts.scope } : {}),
  }).returning();
  return { token, accountId: acct!.id, userId: user!.id, sessionId: sess!.id };
}

/**
 * Seed a FULL session row for an EXISTING user (no new account/user) — the HTTP-layer
 * analogue of auth-service.test.ts's fabricated session ctx, for tests whose subject
 * is something else and that just need an authenticated caller.
 *
 * It is NOT how onboarding works any more: since that change `POST /auth/register` mints its own
 * enrollment-scoped session and the whole register → 2FA → login ceremony runs over
 * HTTP with no seeded row at all (`enrollment-flow.test.ts`, whose absence of any
 * `seedSession*` call is one of its assertions). Pass `lastTwofaAt: now` when the route
 * under test is step-up-gated — which now includes the factor-enrollment routes for a
 * full-scoped caller.
 */
export async function seedSessionFor(
  db: Db,
  o: { accountId: string; userId: string; now: Date; token?: string; lastTwofaAt?: Date | null; deviceId?: string },
): Promise<{ token: string; sessionId: string }> {
  const token = o.token ?? generateToken();
  const [sess] = await db.insert(sessions).values({
    accountId: o.accountId,
    userId: o.userId,
    deviceId: o.deviceId ?? null,
    familyId: crypto.randomUUID(),
    accessTokenHash: hashToken(token),
    accessExpiresAt: new Date(o.now.getTime() + 60 * 60 * 1000),
    refreshExpiresAt: new Date(o.now.getTime() + 2 * 60 * 60 * 1000),
    lastTwofaAt: o.lastTwofaAt ?? null,
  }).returning();
  return { token, sessionId: sess!.id };
}

/**
 * Seed a live STAFF session — the second credential every `/admin/*` read and write requires
 * (NEW-ADMIN-READ-NO-SESSION).
 *
 * A fabricated row, deliberately: these tests' subject is the routes' authorization ORDER and
 * the projections behind them, not the TOTP ceremony that mints the row in production — that
 * ceremony has its own suite (`admin-staff.test.ts`), which seeds nothing. The password hash is
 * an inert literal because nothing here signs in with it; `resolveStaffSession` reads only
 * `staff_sessions.token_hash` / `expires_at` / `revoked_at` and the join to `staff_users`.
 *
 * The expiry is a year out rather than the production lifetime so a test that advances its clock
 * days (billing cycles do) is not signed out mid-assertion by a fixture.
 */
export async function seedStaffSession(
  db: Db,
  o: { now: Date; token?: string; email?: string; lastTwofaAt?: Date; roles?: readonly StaffRole[] },
): Promise<{ token: string; staffId: string; email: string }> {
  const token = o.token ?? generateToken();
  const email = o.email ?? `staff+${randomUUID()}@lichtgrat.example`;
  // `totp_activated` stays false: the check constraint requires an enrolled secret with it,
  // and `resolveStaffSession` judges only the SESSION row — activation gates sign-in, which
  // is not what this fixture fabricates.
  const [staff] = await db.insert(staffUsers)
    .values({ email, passwordHash: "unused-fixture-hash-password-hash-password-hash" })
    .returning();
  await db.insert(staffSessions).values({
    staffUserId: staff!.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(o.now.getTime() + 365 * 24 * 60 * 60 * 1000),
    createdAt: o.now,
    // Cloud 0036 — a staff WRITE asks for a second factor proved inside the step-up window, and
    // this column is where that is read. It defaults to `now` because the fixture's subject is
    // almost never the window; a test whose subject IS the window passes a stale date.
    lastTwofaAt: o.lastTwofaAt ?? o.now,
  });
  // Cloud 0047 — roles are read live per request; a fixture with none is refused everywhere, so
  // the default is the one every existing staff member was backfilled with.
  for (const role of o.roles ?? ["owner"]) {
    await db.insert(staffRoleGrants).values({ staffUserId: staff!.id, role, grantedAt: o.now });
  }
  return { token, staffId: staff!.id, email };
}

/** Insert a device row for a user (target of a `DELETE /devices/:id` revoke). */
export async function seedDevice(
  db: Db,
  o: { accountId: string; userId: string; kind?: "web" | "macos"; label?: string; ip?: string },
): Promise<string> {
  const [d] = await db.insert(devices).values({
    accountId: o.accountId,
    userId: o.userId,
    kind: o.kind ?? "macos",
    label: o.label ?? "Other device",
    ip: o.ip ?? "",
  }).returning();
  return d!.id;
}

/** Seed a mailbox (+ optional folders) for an account; returns the mailbox id. */
export async function seedMailbox(
  db: Db,
  o: { accountId: string; provider?: string; address?: string; folders?: Array<{ folder: string; highestmodseq?: bigint | null }> },
): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: o.accountId,
    provider: o.provider ?? "imap",
    // UNIQUE PER CALL, because mail 0021 added a partial unique index on
    // `(account_id, lower(address))`. This defaulted to one fixed address, so any test that
    // seeded two mailboxes for one account — `screener.test.ts` seeds three, one per held
    // message — was creating rows the product now (correctly) refuses. The fixture was relying
    // on the duplicate bug; a caller that cares about the address still passes one.
    address: o.address ?? `mb-${randomUUID().slice(0, 8)}@lichtgrat.example`,
  }).returning();
  for (const f of o.folders ?? []) {
    await db.insert(mailboxFolders).values({
      mailboxId: mb!.id, folder: f.folder, highestmodseq: f.highestmodseq ?? null,
    });
  }
  return mb!.id;
}

/** Seed a rule row directly (bypassing the change_log); returns the rule id. */
export async function seedRule(
  db: Db,
  o: { accountId: string; kind?: string; match?: string; destination?: string; priority?: number },
): Promise<string> {
  const [r] = await db.insert(rules).values({
    accountId: o.accountId,
    kind: o.kind ?? "sender",
    match: o.match ?? "seed@example.com",
    destination: o.destination ?? "INBOX",
    priority: o.priority ?? 0,
  }).returning();
  return r!.id;
}

/** Seed a contact row directly; returns the contact id. */
export async function seedContact(
  db: Db,
  o: { accountId: string; address?: string; name?: string | null },
): Promise<string> {
  const [c] = await db.insert(contacts).values({
    accountId: o.accountId,
    address: o.address ?? `contact-${crypto.randomUUID()}@example.com`,
    name: o.name ?? null,
  }).returning();
  return c!.id;
}

/** Seed a thread row directly (bypassing the change_log); returns the thread id. */
export async function seedThread(
  db: Db,
  o: { accountId: string; subject?: string; muted?: boolean; lastMessageAt?: Date; participants?: unknown[] },
): Promise<string> {
  const [t] = await db.insert(threads).values({
    accountId: o.accountId,
    subject: o.subject ?? "",
    muted: o.muted ?? false,
    lastMessageAt: o.lastMessageAt ?? null,
    ...(o.participants ? { participants: o.participants } : {}),
  }).returning();
  return t!.id;
}

/**
 * Seed a message row directly (+ a folder_state row when `folder` is given, so the
 * view partitions and MessageDTO.folder resolve). Creates a mailbox on demand.
 * Returns the message id and the mailbox id used.
 */
export async function seedMessage(
  db: Db,
  o: {
    accountId: string; mailboxId?: string; threadId?: string;
    subject?: string; fromAddress?: string; date?: Date; unread?: boolean; snippet?: string;
    folder?: string; observedFolder?: string; reconcileStatus?: string; lastSetBy?: string;
    dedupKey?: string; nativeLocator?: { folder: string; ref: string };
    // Sensitivity flags: seed a no_ai/no_kb/sensitive message.
    noAi?: boolean; noKb?: boolean; sensitivityCategory?: string | null;
  },
): Promise<{ id: string; mailboxId: string }> {
  const mailboxId = o.mailboxId ?? (await seedMailbox(db, { accountId: o.accountId }));
  const [m] = await db.insert(messages).values({
    accountId: o.accountId,
    mailboxId,
    bodyHash: "seed-hash",
    dedupKey: o.dedupKey ?? `seed:${crypto.randomUUID()}`,
    subject: o.subject ?? "Seed subject",
    fromAddress: o.fromAddress ?? "sender@example.com",
    date: o.date ?? null,
    unread: o.unread ?? true,
    snippet: o.snippet ?? "seed snippet",
    threadId: o.threadId ?? null,
    noAi: o.noAi ?? false,
    noKb: o.noKb ?? false,
    sensitivityCategory: o.sensitivityCategory ?? null,
    nativeLocator: o.nativeLocator ?? { folder: o.observedFolder ?? o.folder ?? "INBOX", ref: "1:1" },
  }).returning();
  if (o.folder) {
    await db.insert(folderState).values({
      messageId: m!.id,
      desiredFolder: o.folder,
      observedFolder: o.observedFolder ?? o.folder,
      lastSetBy: o.lastSetBy ?? "us",
      reconcileStatus: o.reconcileStatus ?? "reconciled",
    });
  }
  return { id: m!.id, mailboxId };
}

/** Seed a message body row (1:1 with a message). */
export async function seedBody(
  db: Db,
  o: { messageId: string; text?: string; html?: string | null; headers?: Record<string, unknown>; loadedRemoteContent?: boolean },
): Promise<void> {
  await db.insert(messageBodies).values({
    messageId: o.messageId,
    text: o.text ?? "seed body text",
    html: o.html ?? null,
    ...(o.headers ? { headers: o.headers } : {}),
    loadedRemoteContent: o.loadedRemoteContent ?? false,
  });
}

/**
 * Seed a message HELD in the Screener (desired = ohmail/Screener) — the derived
 * first-contact queue picks it up. Returns the message id.
 */
export async function seedScreenerHeld(
  db: Db,
  o: { accountId: string; mailboxId?: string; fromAddress?: string; subject?: string; date?: Date },
): Promise<{ id: string; mailboxId: string }> {
  return seedMessage(db, {
    accountId: o.accountId,
    mailboxId: o.mailboxId,
    fromAddress: o.fromAddress ?? "stranger@example.com",
    subject: o.subject ?? "First contact",
    date: o.date ?? FIXED_NOW,
    folder: "ohmail/Screener",
    observedFolder: "ohmail/Screener",
    reconcileStatus: "reconciled",
  });
}

/**
 * Seed a PENDING routing approval (+ its routing_decision) for a message, mirroring
 * approval-service.test.ts. Returns the approval id. `folder` is the proposed move
 * target stored in the payload.
 */
export async function seedPendingApproval(
  db: Db,
  o: { accountId: string; messageId: string; folder?: string },
): Promise<string> {
  const folder = o.folder ?? "ohmail/News";
  const [rd] = await db.insert(routingDecisions).values({
    accountId: o.accountId, messageId: o.messageId, inputProvenance: "ai",
    destination: folder, confidence: 0.6, status: "pending_approval",
  }).returning();
  const [a] = await db.insert(approvals).values({
    accountId: o.accountId, kind: "routing", messageId: o.messageId, routingDecisionId: rd!.id,
    action: "move", summary: `Route to ${folder}`, payload: { folder }, confidence: 0.6, status: "pending",
  }).returning();
  return a!.id;
}

/**
 * Build a `Request` at `http://localhost<path>`. A body implies
 * `Content-Type: application/json` unless the caller declares one explicitly — that is
 * what every real client does (`HttpAdapter` sets it, the native app sets it) and
 * `withRequestGuard` now REQUIRES it on unsafe methods, because a cross-site
 * `<form enctype="text/plain">` is the one way a browser can post a body to another
 * origin without a preflight. Tests that want the hostile shape pass the header.
 */
export function req(
  method: string,
  path: string,
  init: { cookie?: string; bearer?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, { method, headers, body: init.body });
}

/** Parse a response's `Set-Cookie` list into a `{ name: value }` map (first token only). */
export function setCookieMap(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const first = raw.split(";")[0]!;
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

/** Parse the `Max-Age` attribute of a named Set-Cookie, or null. */
export function cookieMaxAge(res: Response, name: string): number | null {
  for (const raw of res.headers.getSetCookie()) {
    if (!raw.startsWith(`${name}=`)) continue;
    const m = /max-age=(\d+)/i.exec(raw);
    return m ? Number(m[1]) : null;
  }
  return null;
}
