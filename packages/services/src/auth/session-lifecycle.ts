import { randomUUID } from "node:crypto";
import { carryDialect } from "@trafficflow/db/dialect";
import { dialect } from "@trafficflow/db/dialect";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { devices, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import { runInTransaction, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { generateToken, hashToken } from "./crypto.js";
import { surfaceTtls, type SurfaceTtls } from "./config.js";
import type { SessionSurface } from "./config-types.js";
import type { AuthConfig } from "./types.js";
import type {
  SessionEstablished, OAuthTokens, Device, DeviceKind, SessionUser, TwofaEnrolled, AuthAuditEvent,
} from "./types.js";
import type { SessionScope } from "./resolve-session.js";

/**
 * A live session for one account may not present a credential for another. The sign-in and token
 * routes are `public`: the route resolves a SECOND credential out of the body, and nothing
 * compared it to the session's — a caller holding a session for A could post B's refresh token
 * and get B's tokens minted on a request the stack labelled as A's. Not an escalation (it needs
 * B's credential) but a CONFUSION the response's account header cannot describe honestly, so it
 * is refused: a 409 about the REQUEST, not a 401 — both credentials are valid, and that is the
 * problem. A sessionless caller is unaffected: `ctx.accountId` is `""` when no session resolved.
 */
export function refuseCrossAccountCredential(ctx: ServiceContext, credentialAccountId: string): void {
  if (ctx.accountId && ctx.accountId !== credentialAccountId) {
    throw new ServiceError(
      "session_conflict", 409,
      "this browser holds a session for a different account — sign out before using this credential",
    );
  }
}

/**
 * SessionLifecycle — the session MACHINERY, carved out of `AuthService` so the desktop-as-host
 * tier can run it: `establish`, rotation with reuse detection, family revocation, logout,
 * devices, step-up introspection, the paired-device mint. NOT the identity ceremony — that stays
 * on `AuthService`, which extends this and overrides the three hosted hooks (`audit`,
 * `throttleReset`, `twofaEnrolled`) naming cloud-half tables. The desktop engine bundles this
 * module, so everything reached is the SHARED half (mail 0060); `auth-entry-census.test.ts` pins
 * the closure. One rotation protocol on both tiers: two implementations of reuse detection is how
 * one tier's stolen token stays alive on the other.
 */

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The closed set a paired device may declare itself as — `devices.kind`'s own vocabulary,
 * now the shared {@link DeviceKind} (see its doc for the legacy `"macos"` reading and why
 * new kinds are server-side enablement until clients declare them).
 */
export type PairedDeviceKind = DeviceKind;
export const PAIRED_DEVICE_KINDS: ReadonlySet<string> = new Set<PairedDeviceKind>([
  "web", "macos", "desktop-linux", "desktop-macos", "desktop-windows",
  "mobile-android", "mobile-ios",
]);

/**
 * The kinds {@link SessionLifecycle.establish} auto-mints a device row for, with the label the
 * row gets — the desktop family and nothing else. `web` is absent because a browser ceremony
 * mints no row (see the comment at the mint), and the mobile kinds are absent because a phone
 * only ever arrives through the pairing redeem, which pre-creates its row with the mint-time
 * label and passes `deviceId` in. The map is therefore the whole answer to "which kinds are
 * named devices by construction", and adding a kind here is a decision, not a default.
 */
const AUTO_MINT_DEVICE_LABELS: Partial<Record<DeviceKind, string>> = {
  "macos": "ohmail for Mac",
  "desktop-linux": "ohmail for Linux",
  "desktop-macos": "ohmail for Mac",
  "desktop-windows": "ohmail for Windows",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The age cutoff `revokeWebSessions` accepts, in whole days. `1` is the smallest window that
 * still means "not today's sessions" — the thing the cutoff exists for; `3650` is ten years,
 * past which the value stops narrowing anything a `last_seen_at` can hold.
 */
export const REVOKE_WEB_SESSIONS_MIN_AGE_DAYS = 1;
export const REVOKE_WEB_SESSIONS_MAX_AGE_DAYS = 3650;

/**
 * Refused HERE and not only at the route, so a second caller cannot be added past the bound —
 * the reason `organizeHere` checks its own `dormancyDays` inside the transaction. Only an
 * OMITTED value means "no cutoff": `null` is a client bug, and silently reading it as "revoke
 * every other session" is the exact failure this parameter was added to remove.
 */
export function assertWebSessionAge(days: number | undefined): void {
  if (days === undefined) return;
  if (typeof days !== "number" || !Number.isInteger(days)
    || days < REVOKE_WEB_SESSIONS_MIN_AGE_DAYS || days > REVOKE_WEB_SESSIONS_MAX_AGE_DAYS) {
    throw new ServiceError(
      "validation_failed", 400,
      `olderThanDays must be a whole number between ${REVOKE_WEB_SESSIONS_MIN_AGE_DAYS} and ${REVOKE_WEB_SESSIONS_MAX_AGE_DAYS}`,
    );
  }
}

export interface SessionLifecycleDeps {
  config: AuthConfig;
}

export class SessionLifecycle {
  constructor(private readonly lifecycleDeps: SessionLifecycleDeps) {}

  protected get cfg(): AuthConfig {
    return this.lifecycleDeps.config;
  }

  /**
   * Run `fn` inside ONE database transaction, handing it a {@link ServiceContext}
   * bound to that transaction so ctx-taking helpers (`establish`,
   * `exchangeEnrollmentSession`, `audit`) join it instead of autocommitting
   * alongside it. The cast mirrors {@link asTx}: `Tx` and `Db` are the same runtime
   * object with different static shapes.
   */
  /**
   * Where `noteCredentialAccount` becomes commit-side. The reporting seam labels the response
   * with the account a credential resolved to, and its callers run inside transactions here:
   * reporting straight through mutated request state before the transaction justifying it
   * committed — a rolled-back mint left the response labelled as though the rolled-back session
   * existed. So a `txCtx` reports into a BUFFER, forwarded only after `transaction()` resolves: a
   * rollback, a throw or a swallowed commit failure discards it. Nesting composes — an inner
   * transaction forwards into the outer's buffer on its own commit. Reporting outside any
   * transaction goes straight through.
   */
  protected async inTransaction<T>(
    ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>,
  ): Promise<T> {
    // Delegates, and does not re-implement: `runInTransaction` is the ONE buffered wrapper, and
    // the reason it is shared is that the second copy of this rule — private to `pairing.ts` —
    // never learned to buffer at all.
    return runInTransaction(ctx, fn);
  }

  async logout(ctx: ServiceContext, b: { allDevices?: boolean } = {}): Promise<void> {
    if (!ctx.userId) throw new ServiceError("unauthorized", 401, "no active session");
    const db = asTx(ctx);
    const now = ctx.now();
    if (b.allDevices) {
      // MASS LOGOUT IS DEVICE REVOCATION IN EFFECT, so it takes device revocation's gate.
      // Without this, any full session could sign out EVERY session and refresh family of the
      // user — and on the desktop-host door that meant a paired bearer, whose NULL factor stamp
      // exists precisely so it cannot revoke devices, could kill the launch session and every
      // other paired device in one request. The caller's OWN sign-out (the arm below) stays
      // ungated: taking back your own credential must never be hard, and it can only reduce
      // risk. `allDevices` reduces EVERYBODY's — which is the same act `revokeDevice` gates.
      await this.requireStepUp(ctx);
      await db.update(sessions).set({ revokedAt: now })
        .where(and(eq(sessions.userId, ctx.userId), isNull(sessions.revokedAt)));
      await db.update(refreshTokens).set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, ctx.userId), isNull(refreshTokens.revokedAt)));
    } else if (ctx.sessionId) {
      const s = (await db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)).limit(1))[0];
      if (s) await this.revokeFamily(db, s.familyId, now);
    }
    const u = (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0];
    if (u) await this.audit(db, u, "logout", undefined, ctx);
  }

  /**
   * Rotate a refresh token. `concurrentGrace` is opt-in, OFF by default, and only the COOKIE
   * surface passes it: several tabs read one `tf_refresh` and present it at once, so a benign
   * duplicate is structural there — native/bearer and the OAuth grant rotate serially and keep
   * the strict RFC 9700 §4.14.2 response. `surface` rides the same branch and chooses the
   * LIFETIME — independent, because the two axes have opposite strict ends; omitting it means the
   * shorter cookie window: a forgetful caller is short-changed, never over-served. The lifetime
   * follows the BRANCH this presentation arrived on: moving a cookie to the body branch means
   * already holding it, and a holder can rotate for ever on its own branch anyway.
   */
  async refresh(
    ctx: ServiceContext,
    b: { refreshToken?: string },
    opts: { concurrentGrace?: boolean; surface?: SessionSurface } = {},
  ): Promise<{ tokens?: OAuthTokens }> {
    const token = b.refreshToken;
    if (!token) throw new ServiceError("unauthorized", 401, "missing refresh token");
    // `opts.surface` is passed STRAIGHT THROUGH, undefined included: the one default lives in
    // `surfaceTtls`, so there is no second place for the two to drift apart.
    const tokens = await this.rotateRefresh(ctx, token, opts.concurrentGrace === true, opts.surface);
    return { tokens };
  }

  /**
   * Mint the session a pairing-token redeem establishes — the `claimDesktopLink` tail as a seam,
   * so pairing reuses this machinery. The BURN is not here: single-use, TTL and revocation were
   * decided by the pairing table's one atomic UPDATE. Three differences from the desktop-link
   * tail: the device row carries the TOKEN's mint-time label, which makes revocation aimable;
   * `kind` is the REDEEMER's declaration and names the DEVICE ROW only (closed set) — never the
   * TTL surface: the mint pins `surface: "native"`, the bearer reality; and `twofaAt: null` — a
   * pairing token lives up to fifteen minutes, past what a step-up argument proves. NULL fails
   * step-up closed, so pairing cannot beget pairing.
   */
  async establishPairedDevice(
    ctx: ServiceContext, b: { userId: string; label: string; kind: PairedDeviceKind },
  ): Promise<{ tokens: OAuthTokens }> {
    // The runtime whitelist behind the type, for JavaScript callers and wire input — the same
    // division `mintPairingToken` establishes for its grant.
    if (typeof b.kind !== "string" || !PAIRED_DEVICE_KINDS.has(b.kind)) {
      throw new ServiceError("validation_failed", 400,
        `device kind must be one of ${[...PAIRED_DEVICE_KINDS].map((k) => `"${k}"`).join(", ")}`);
    }
    const db = asTx(ctx);
    const user = await this.loadUser(db, b.userId);
    const [dev] = await db.insert(devices).values({
      accountId: user.accountId, userId: user.id, kind: b.kind,
      label: b.label, ip: ctx.ip ?? "",
    }).returning();
    const established = await this.establish(ctx, user, {
      // The declared kind rides on the DEVICE ROW above; the lifetime surface is pinned to the
      // bearer transport this redeem answers with — see the kind bullet in the header.
      kind: b.kind, deviceId: dev!.id, twofaAt: null, surface: "native",
    });
    // The bearer pair and nothing else — `claimDesktopLink`'s shape, for its reasons.
    return { tokens: established.tokens! };
  }

  // ── Sessions, devices & step-up ─────────────────────────────────────────────

  async listDevices(ctx: ServiceContext): Promise<{ items: Device[] }> {
    const userId = this.requireUser(ctx);
    const db = asTx(ctx);
    const rows = await db.select().from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.createdAt));
    const items: Device[] = [];
    for (const s of rows) {
      const dev = s.deviceId
        ? (await db.select().from(devices).where(eq(devices.id, s.deviceId)).limit(1))[0]
        : undefined;
      items.push({
        id: s.deviceId ?? s.id,
        kind: (dev?.kind as Device["kind"]) ?? "web",
        label: dev?.label ?? "",
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        ip: dev?.ip ?? "",
        current: ctx.sessionId === s.id,
        // A device row means a NAMED device (a pairing redeem's mint, the desktop's macos
        // claim) — the sidecar's launch-session discriminator, promoted to the projection so
        // a client can pin the current session, list named devices individually, and collapse
        // the plain-browser remainder without guessing from labels.
        named: dev != null,
        pushToken: null,
      });
    }
    return { items };
  }

  /**
   * The auth-event trail, READ — the query half of the {@link audit} hook below, and it answers
   * the same truth: the lifecycle half records no auth events (no `auth_events` table exists on
   * a mail-only store), so the trail it can honestly report is empty. `AuthService` overrides
   * this with the real read, exactly as it overrides the write. A refusal here would be wrong in
   * both spellings: a 500 says the host is broken, a 404 says the route is absent — and the
   * desktop-host door mounts `GET /auth/audit` whole, where "nothing has been recorded" is a
   * fact about the tier, not a fault.
   */
  async listAudit(
    ctx: ServiceContext, _opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: AuthAuditEvent[]; nextCursor: string | null }> {
    this.requireUser(ctx);
    return { items: [], nextCursor: null };
  }

  /**
   * `opts.requireStepUp` — only the exact boolean `false` skips the gate (an absent value must
   * never relax it), and exactly one caller passes it: the desktop's own stdio door, where the
   * machine's login IS the step-up (the per-launch bearer never leaves the shell) and where the
   * launch session's boot-time factor stamp would otherwise refuse every revocation from five
   * minutes after launch — leaving a paired credential with NO take-back path, which is the one
   * thing that makes offering a pairing unsafe. The hosted route (`DELETE /devices/:id`) passes
   * nothing and keeps the real gate.
   */
  async revokeDevice(
    ctx: ServiceContext, deviceId: string, opts: { requireStepUp?: boolean } = {},
  ): Promise<void> {
    const userId = this.requireUser(ctx);
    if (opts.requireStepUp !== false) await this.requireStepUp(ctx);
    const db = asTx(ctx);
    // The id the list exposed: the device id for a NAMED device, the session's OWN id for a
    // device-less one (`listDevices` has always published `s.deviceId ?? s.id`). The second
    // arm used to be missing, and its absence was a FALSE SUCCESS: revoking a device-less row
    // matched zero sessions, audited `device_revoked`, answered 204 — and the "revoked"
    // session's next request still worked. The session-id arm is narrowed to
    // `isNull(deviceId)` so a session id can never be a side door around the device
    // predicate, and both arms stay user-scoped: nothing of anybody else's is reachable.
    const rows = await db.select().from(sessions)
      .where(and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        or(
          eq(sessions.deviceId, deviceId),
          and(eq(sessions.id, deviceId), isNull(sessions.deviceId)),
        ),
      ));
    for (const s of rows) await this.revokeFamily(db, s.familyId, ctx.now());
    const u = await this.loadUser(db, userId);
    await this.audit(db, u, "device_revoked", undefined, ctx);
  }

  /**
   * Revoke every DEVICE-LESS full session of the caller except its own — "sign out all other web
   * sessions". The scope is structural, never a label: `device_id IS NULL` is what a plain
   * browser sign-in is, so a paired device can never be swept however labeled. The caller
   * survives twice — its session id AND its family are excluded — and the `scope = 'full'` pin
   * keeps the predicate exact. Step-up gated: mass sign-out is device revocation in effect. NOT
   * mounted on the desktop-host door — there the device-less non-current session IS the host's
   * launch session, which a remote viewer must never kill; `desktop-host.test.ts` censuses the
   * absence.
   */
  async revokeWebSessions(
    ctx: ServiceContext, opts: { olderThanDays?: number } = {},
  ): Promise<{ revoked: number }> {
    const userId = this.requireUser(ctx);
    assertWebSessionAge(opts.olderThanDays);
    await this.requireStepUp(ctx);
    const db = asTx(ctx);
    const now = ctx.now();
    const current = ctx.sessionId
      ? (await db.select({ familyId: sessions.familyId }).from(sessions)
        .where(eq(sessions.id, ctx.sessionId)).limit(1))[0]
      : undefined;
    const preds = [
      eq(sessions.userId, userId),
      isNull(sessions.deviceId),
      eq(sessions.scope, "full"),
      isNull(sessions.revokedAt),
    ];
    if (ctx.sessionId) preds.push(ne(sessions.id, ctx.sessionId));
    if (current) preds.push(ne(sessions.familyId, current.familyId));
    // THE AGE CUTOFF IS ADDITIVE, NEVER A REPLACEMENT: absent means the whole device-less
    // remainder, which is what the person's "sign out everywhere else" press means and must keep
    // meaning. Present, it narrows by `last_seen_at` — `notNull` with a `defaultNow()`, so every
    // row has one and there is no NULL arm to decide. A typed column comparison rather than a raw
    // `sql` fragment: the two drivers disagree on serializing a bound timestamp into one.
    if (opts.olderThanDays !== undefined) {
      preds.push(lt(sessions.lastSeenAt, new Date(now.getTime() - opts.olderThanDays * DAY_MS)));
    }
    // Set-based AND atomic, one measured defect each. Set-based: the per-family loop (two awaited
    // UPDATEs each, serially) was 400+ round trips on exactly the accounts this verb exists for,
    // inside a request with a 60-second ceiling — a "Sign out all" that times out having revoked
    // only a PREFIX. One guarded claim takes the whole scope; the refresh families die in bounded
    // IN-chunks off the claim's own RETURNING. Atomic: with the claim committing separately, a
    // failed chunk left every session revoked, some refresh rows live, and the RETRY claimed zero
    // rows (`revoked_at IS NULL`) — it could never revisit those families. One transaction holds
    // claim, sweeps and audit: a mid-sweep death rolls the claim back and the retry does the
    // whole job. Families are 1:1 with sessions by construction, so sweeping tokens by the
    // claimed familyIds is `revokeFamily`'s exact reach.
    return this.inTransaction(ctx, async (txCtx) => {
      const tx = asTx(txCtx);
      const claimed = await tx.update(sessions)
        .set({ revokedAt: now })
        .where(and(...preds))
        .returning({ familyId: sessions.familyId });
      const families = [...new Set(claimed.map((r) => r.familyId))];
      for (let i = 0; i < families.length; i += 500) {
        await tx.update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(
            inArray(refreshTokens.familyId, families.slice(i, i + 500)),
            isNull(refreshTokens.revokedAt),
          ));
      }
      if (claimed.length > 0) {
        const u = await this.loadUser(tx, userId);
        await this.audit(tx, u, "device_revoked", undefined, txCtx);
      }
      return { revoked: claimed.length };
    });
  }

  /** Throws `step_up_required` unless the current session had a 2FA assertion
   *  within the step-up window. An ENROLLMENT-scoped session can
   *  never satisfy it — asserted on the scope, not merely implied by its NULL
   *  `last_twofa_at`, so the guard does not depend on that column staying NULL. */
  async requireStepUp(ctx: ServiceContext): Promise<void> {
    if (!ctx.sessionId) throw new ServiceError("step_up_required", 403, "recent 2FA re-assertion required");
    const db = asTx(ctx);
    const s = (await db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)).limit(1))[0];
    if (!s || s.revokedAt) throw new ServiceError("unauthorized", 401, "no active session");
    if (s.scope !== "full") throw new ServiceError("step_up_required", 403, "recent 2FA re-assertion required");
    const last = s.lastTwofaAt?.getTime() ?? 0;
    if (ctx.now().getTime() - last > this.cfg.stepUpWindowMs) {
      throw new ServiceError("step_up_required", 403, "recent 2FA re-assertion required");
    }
  }

  // ── Internal: session issuance & refresh rotation ───────────────────────────

  /**
   * `twofaAt` is REQUIRED, and that is the point. This wrote `lastTwofaAt: now` unconditionally,
   * arguing a full session only comes from completed 2FA "(or the PKCE code that one produced)" —
   * and the parenthesis broke it: the PKCE exchange asserts no factor. No safe default, so no
   * default; every call site says which ceremony it is: a factor asserted HERE — `ctx.now()`; an
   * INHERITED authorization (PKCE) — the authorizing session's real `last_twofa_at`, carried on
   * the code row; `claimDesktopLink` passes `ctx.now()` because its mint is step-up gated and the
   * code lives two minutes. NULL fails step-up closed. Nothing rotates the stamp forward — a
   * session ages out of step-up on its factor's schedule.
   */
  protected async establish(
    ctx: ServiceContext, user: typeof users.$inferSelect,
    o: {
      method?: AuthAuditEvent["method"]; kind: DeviceKind; ip?: string;
      familyId?: string; deviceId?: string;
      twofaAt: Date | null;
      /**
       * The lifetime surface, when the CALLER's transport decides it rather than the kind.
       * Every ceremony call site omits it and keeps the kind-derived reading below; the one
       * caller that sets it is {@link establishPairedDevice}, whose `kind` is the REDEEMER's
       * anonymous declaration and therefore must not be allowed to choose a window — see its
       * header for the whole argument.
       */
      surface?: SessionSurface;
    },
  ): Promise<SessionEstablished> {
    // BEFORE ANY WRITE. This is the single seam every full session is minted through — the
    // first-factor exchange, both 2FA verifies, the recovery code, the native PKCE exchange, the
    // desktop-link claim and the paired device — so the cross-account refusal is asked once here
    // rather than at seven call sites, one of which would eventually be added without it.
    // `revokeEnrollmentSessions` below is a write, so the check precedes it.
    refuseCrossAccountCredential(ctx, user.accountId);
    const db = asTx(ctx);
    const now = ctx.now();
    // A FULL session exists ⇒ no password-only session for this user may still be
    // live. This is the choke point that makes that true: every path to a full
    // session (2FA verify, recovery code, the native PKCE exchange, and the
    // first-factor exchange) closes the enrollment window, not just the one that
    // happened to present an enrollment credential. Consequence used elsewhere: a
    // live enrollment session and a live full session can never coexist for one
    // user, which is why an enrollment session needs no `GET /devices` entry to be
    // revocable.
    await this.revokeEnrollmentSessions(db, user.id, now);
    // The mint picks the SAME surface the device row records, from the one signal that already
    // exists: `kind`. A browser ceremony is `web` and takes the cookie window; the two native
    // doors are `macos` and take the native one. Deriving it rather than adding a second
    // parameter stops a session whose device says "Web" from holding a 400-day credential — one
    // value, both the row and the lifetime read it. Anything that is not `macos` is a browser as
    // far as this decision goes, the strict side per `surfaceTtls`; the platform-qualified
    // desktop kinds deliberately take the strict side too, because on the one seam where they are
    // wire input the declaration must not buy the native window — a caller whose transport really
    // is native pins `o.surface` itself (the desktop-link claim does, as the paired mint always
    // has).
    const ttls = surfaceTtls(this.cfg, o.surface ?? (o.kind === "macos" ? "native" : "cookie"));
    // A device row means a NAMED device, so only a DESKTOP kind auto-mints one — the desktop app
    // really is a device managed by name. The label map is the closed set that may auto-mint:
    // legacy "macos" plus the platform-qualified desktop kinds. A plain web ceremony mints NO
    // row: it used to mint one labeled "Web" per sign-in, flooding the list that exists to make
    // PAIRED devices visible (hundreds of rows on a well-used account) and growing `devices`
    // without bound. The mobile kinds are NOT in the map: a phone arrives only through the
    // pairing redeem, which pre-creates the row and passes `deviceId`. Device-less is also the
    // sidecar's launch session, so `device_id IS NULL` means the same thing on every tier;
    // migration 0061 backfills the historical "Web" rows.
    let deviceId = o.deviceId ?? null;
    const autoLabel = AUTO_MINT_DEVICE_LABELS[o.kind];
    if (!deviceId && autoLabel !== undefined) {
      const [dev] = await db.insert(devices).values({
        accountId: user.accountId, userId: user.id, kind: o.kind,
        label: autoLabel, ip: o.ip ?? ctx.ip ?? "",
      }).returning();
      deviceId = dev!.id;
    }
    const familyId = o.familyId ?? randomUUID();
    const accessToken = generateToken();
    const refreshToken = generateToken();

    const [session] = await db.insert(sessions).values({
      accountId: user.accountId, userId: user.id, deviceId, familyId,
      // Explicit even though 'full' is the column default: a full session is only
      // ever reached through a completed 2FA (or the PKCE code that one produced,
      // which is now itself gated on one), and that must not depend on a default
      // that could later change.
      scope: "full",
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: new Date(now.getTime() + this.cfg.accessTtlMs),
      refreshExpiresAt: new Date(now.getTime() + ttls.refreshTtlMs),
      // The CALLER's answer, never `now` by default — see the header.
      lastTwofaAt: o.twofaAt, lastSeenAt: now,
    }).returning();

    await db.insert(refreshTokens).values({
      accountId: user.accountId, userId: user.id, sessionId: session!.id, familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + ttls.refreshTtlMs),
      // The SERVICE clock, never the column's `defaultNow()`: every stamp the rotation
      // machinery reasons over (`consumed_at`, `expires_at`, the recovery classification's
      // created-vs-consumed comparisons) comes from `ctx.now()`, and mixing the database's
      // clock into one of them makes grace-window arithmetic depend on app↔db skew.
      createdAt: now,
    });

    if (o.method) await this.audit(db, user, "2fa_verified", o.method, ctx);
    await this.audit(db, user, "login", o.method, ctx);
    await this.throttleReset(db, `user:${user.id}`);
    await this.throttleReset(db, `email:${user.email}`);

    // Reported here and not at the top, so a ceremony that THROWS after the guard never leaves
    // the response labelled with an account whose session was not in the end established. The
    // ROLLBACK half is not this line's doing and was once wrongly claimed here: it belongs to
    // `inTransaction`, which buffers a report made inside a transaction and forwards it only on
    // commit. See ACCOUNT_HEADER in `packages/api/src/app.ts`.
    ctx.noteCredentialAccount?.(user.accountId);
    return {
      status: "authenticated",
      user: await this.sessionUser(db, user.id),
      tokens: {
        accessToken, refreshToken, tokenType: "Bearer",
        expiresIn: Math.floor(this.cfg.accessTtlMs / 1000),
      },
    };
  }

  /**
   * Revoke EVERY live enrollment-scoped session of a user (the sibling-session fix). Keyed on
   * `user_id + scope`, so siblings minted by separate registrations / re-entry logins
   * die together; the `refresh_tokens` sweep is defensive (an enrollment session never
   * gets a refresh row, and that invariant should not be load-bearing here).
   */
  protected async revokeEnrollmentSessions(db: Tx, userId: string, now: Date): Promise<void> {
    const live = await db.select({ familyId: sessions.familyId }).from(sessions)
      .where(and(
        eq(sessions.userId, userId),
        eq(sessions.scope, "enrollment"),
        isNull(sessions.revokedAt),
      ));
    if (live.length === 0) return;
    await db.update(sessions).set({ revokedAt: now })
      .where(and(
        eq(sessions.userId, userId),
        eq(sessions.scope, "enrollment"),
        isNull(sessions.revokedAt),
      ));
    await db.update(refreshTokens).set({ revokedAt: now })
      .where(and(
        inArray(refreshTokens.familyId, live.map((r) => r.familyId)),
        isNull(refreshTokens.revokedAt),
      ));
  }

  /** The caller's own session scope, read from the row (informational — see getSession). */
  protected async sessionScope(db: Tx, sessionId?: string | null): Promise<SessionScope> {
    if (!sessionId) return "full";
    const s = (await db.select({ scope: sessions.scope }).from(sessions).where(eq(sessions.id, sessionId)).limit(1))[0];
    return s?.scope === "enrollment" ? "enrollment" : "full";
  }

  /**
   * Rotate a refresh token — CLAIM FIRST, then decide. SELECT → check → UPDATE defeats the reuse
   * detection it implements: two concurrent presentations both read `consumed_at === null`, both
   * skip the revoke branch, both mint valid descendants — an attacker who races the legitimate
   * client gets a working session AND leaves the family alive. Same defect class `consumeInvite`
   * avoids, same fix: the claim IS the check — `UPDATE … WHERE consumed_at IS NULL AND revoked_at
   * IS NULL AND expires_at > now RETURNING`. The classification read is deliberately AFTER the
   * failed claim: on the hot path it never runs.
   */
  protected async rotateRefresh(
    ctx: ServiceContext, presented: string, grace: boolean, surface?: SessionSurface,
  ): Promise<OAuthTokens> {
    const db = asTx(ctx);
    const now = ctx.now();
    const tokenHash = hashToken(presented);
    // Resolved ONCE, and used by both the hot path and the grace path below, so a rotation cannot
    // issue one window while the cap it was checked against belongs to another. An absent
    // `surface` lands on the cookie window — see `surfaceTtls`, which owns that decision.
    const ttls = surfaceTtls(this.cfg, surface);

    // A ROTATION IS NOT A MINT, so it does not pass through `establish` and needs the refusal of
    // its own. Asked BEFORE the consuming UPDATE below, so a refused request rotates nothing:
    // the token stays live for the client that legitimately holds it.
    //
    // The read costs a lookup on the unique `token_hash` index, and only when a session actually
    // resolved. The ordinary web refresh presents an EXPIRED access token, so `ctx.accountId` is
    // empty and this branch never runs — the sessionless cookie path is untouched, which is the
    // condition this whole change was ruled under.
    if (ctx.accountId) {
      // The SAME predicates as the consuming update — this refuses only what would otherwise have
      // been ROTATED. A CONSUMED token is not a conflict, it is EVIDENCE: presenting a spent
      // refresh token is how theft announces itself, and the classification answers by revoking
      // the family. A hash-only lookup answered 409 first and returned — so anyone holding a
      // stolen, already-spent token of B's could SUPPRESS B's theft detection indefinitely by
      // also holding any session of their own. Falling through grants nothing new: presenting B's
      // spent token with NO session reaches the same sweep.
      const [presentedRow] = await db.select({ accountId: refreshTokens.accountId })
        .from(refreshTokens)
        .where(and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.consumedAt),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        ))
        .limit(1);
      // An UNKNOWN token is not a conflict either — it falls through to the 401 below, which is the
      // answer it deserves and the one that says nothing about whether it ever existed.
      if (presentedRow) refuseCrossAccountCredential(ctx, presentedRow.accountId);
    }

    const [row] = await db.update(refreshTokens)
      .set({ consumedAt: now })
      .where(and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.consumedAt),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now),
      ))
      .returning();

    if (!row) {
      // We did not get the row. Why not — and the answer decides whether a family dies.
      const [existing] = await db.select().from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
      if (!existing || existing.revokedAt) {
        throw new ServiceError("unauthorized", 401, "invalid refresh token");
      }
      // Reuse detection: a consumed token presented again means it leaked — revoke the WHOLE
      // family. EXCEPT the concurrent rotation, which is not theft: indistinguishable at an
      // INSTANT, distinguishable over TIME. A browser shares one jar across tabs and
      // single-flights refresh only per tab, so two tabs crossing the access expiry present the
      // same `tf_refresh` at once; the loser used to get the family revoked — the "no longer
      // authorized" a user hit by opening a new tab. The distinction keys on TIME-SINCE-CONSUMED,
      // only on the surface with the race (`grace`): within `refreshReuseGraceMs`, on a live
      // family within its cap, a re-presentation is re-rotated off the same family. Older — or
      // ANY re-presentation on a strict surface — is a kept, replayed token: theft, and it
      // revokes. `config.ts` states the bounded residual.
      if (existing.consumedAt) {
        const consumedMsAgo = now.getTime() - existing.consumedAt.getTime();
        if (grace && consumedMsAgo <= this.cfg.refreshReuseGraceMs) {
          const [session] = await db.select().from(sessions)
            .where(eq(sessions.id, existing.sessionId)).limit(1);
          const renewable = session != null && session.revokedAt == null
            && (ttls.absoluteTtlMs == null
              || now.getTime() - session.createdAt.getTime() <= ttls.absoluteTtlMs);
          if (renewable) return this.mintRotation(ctx, db, existing, now, ttls);
        }
        // The lost-response recovery, past the grace window, cookie surface only. A rotation is
        // two halves: consume + mint, and the response carrying the new token into the jar. When
        // the second half is LOST (lid closed mid-refresh) the jar keeps the OLD token, and its
        // next presentation looked exactly like replayed theft and burned the family. Measured
        // twice, a morning apart: 29.5 minutes after consumption with the successor never used;
        // and 10.1 seconds, 114 ms past the old grace window. No grace width fixes the first
        // shape. The discriminator is USE plus IDLE TIME: a stale jar always holds the family's
        // newest-consumed token, and a tail still unconsumed after a FULL access window means no
        // awake client drives the session. Both conditions live in `recoverLostRotation`;
        // otherwise the presentation falls to the sweep.
        if (grace) {
          const recovered = await this.recoverLostRotation(ctx, existing, now, ttls);
          if (recovered) return recovered;
        }
        // A CLAIM-KILLED row is refused PLAINLY, never with the sweep. A recovery's claim
        // stamps the dormant tail it consumes with `expires_at = consumed_at` (see the claim),
        // because that consumption is not a PRESENTATION: nobody outside this server ever held
        // the row's token in a spendable state after the kill. A late re-presentation of such
        // a row is therefore either the double-lost jar (its recovery response was lost TOO —
        // sign in again is the right answer) or a thief holding a token that was already dead;
        // neither names a second live holder of the family's real chain, and sweeping would
        // revoke the healthy line the recovery just re-established. Within the grace window
        // the arm above has already converged it, exactly like any fresh consumption.
        if (existing.expiresAt.getTime() <= existing.consumedAt.getTime()) {
          throw new ServiceError("unauthorized", 401, "refresh token expired");
        }
        // The sweep leaves a ROW, and sweep + row are ONE TRANSACTION — with the sweep REDONE
        // ALONE if it cannot commit. It used to leave nothing: the client got 401s and the only
        // record was raw session rows correlated by `revoked_at` after the fact. Both naive forms
        // fail: sequential autocommit can die between the two — a family revoked with NO record,
        // permanently; one transaction ALONE fails the other way — the cookie handler answers any
        // error by CLEARING the session cookies, so the consumed token is never re-presented,
        // while the thief's descendant keeps the compromised family ALIVE. A bookkeeping fault
        // must never veto a security sweep: on commit failure the catch redoes the sweep alone on
        // the autocommitting handle — fail-closed. The base records nothing; the hosted tier
        // writes `auth_events`. The user read is DEFENSIVE.
        try {
          await this.inTransaction(ctx, async (txCtx) => {
            const tx = asTx(txCtx);
            await this.revokeFamily(tx, existing.familyId, now);
            const [reuseUser] = await tx.select().from(users)
              .where(eq(users.id, existing.userId)).limit(1);
            await this.audit(tx, reuseUser ?? null, "refresh_reuse_revoked", undefined, txCtx,
              `family=${existing.familyId} session=${existing.sessionId}`);
          });
        } catch {
          await this.revokeFamily(db, existing.familyId, now);
        }
        throw new ServiceError("unauthorized", 401, "refresh token reuse detected");
      }
      throw new ServiceError("unauthorized", 401, "refresh token expired");
    }

    // The absolute cap, when a surface has one. Rotation rolls the refresh window forward every
    // time, so a used session renews indefinitely — the decision `config.ts` takes for both
    // shipped surfaces, which set `absoluteTtlMs: null` and never reach this check. The check
    // stays, live and enforced, for any surface or deployment that DOES set a ceiling: `null`
    // means "no ceiling", a number means the number. Measured from the SESSION's creation, not
    // the token's — a per-token measure would be exactly the rolling window this bounds. Checked
    // before anything is written, so a capped session is refused rather than half-rotated.
    const [session] = await db.select().from(sessions).where(eq(sessions.id, row.sessionId)).limit(1);
    // A rotation on a REVOKED or vanished session must fail closed. On the hot path a claimed
    // (un-revoked) token implies a live session, because `revokeFamily` kills tokens and session
    // together — so this only bites the race where a revocation (logout, all-devices, a reuse
    // sweep) commits AFTER this call claimed its token: the sweep cannot see a row inserted after
    // it, so without this check that orphan could keep rotating on a dead session for ever (its
    // access tokens are inert — `resolveSession` refuses a revoked session — but the mint LOOP is
    // the defect). Refusing here holds the invariant "a rotation implies a live session" and caps
    // the artifact at a single inert row.
    if (!session || session.revokedAt != null) {
      await this.revokeFamily(db, row.familyId, now);
      throw new ServiceError("unauthorized", 401, "session is no longer active");
    }
    if (ttls.absoluteTtlMs != null
      && now.getTime() - session.createdAt.getTime() > ttls.absoluteTtlMs) {
      await this.revokeFamily(db, row.familyId, now);
      throw new ServiceError("unauthorized", 401, "session has reached its maximum lifetime");
    }

    return this.mintRotation(ctx, db, row, now, ttls);
  }

  /**
   * Insert the next refresh token of a family and slide its session's windows forward. The ONE
   * writer of a rotation, shared by the hot path and the grace path so the two can never drift.
   * `base` is whichever row named the family; the new token inherits the SAME account, user,
   * session and family — a rotation never starts a new family, which keeps an absolute ceiling
   * (measured from `sessions.created_at`) real. `ttls` is RESOLVED BY THE CALLER: this one writer
   * re-issues `expires_at` from `now` on every rotation, from the same resolution `rotateRefresh`
   * checked its cap against — so the cookie surface cannot be handed the native window by a path
   * that resolved once and re-read the config later.
   */
  private async mintRotation(
    ctx: ServiceContext,
    db: Tx,
    base: { accountId: string; userId: string; sessionId: string; familyId: string },
    now: Date,
    ttls: SurfaceTtls,
  ): Promise<OAuthTokens> {
    const newRefresh = generateToken();
    const newAccess = generateToken();
    await db.insert(refreshTokens).values({
      accountId: base.accountId, userId: base.userId, sessionId: base.sessionId, familyId: base.familyId,
      tokenHash: hashToken(newRefresh),
      expiresAt: new Date(now.getTime() + ttls.refreshTtlMs),
      // The service clock, for `establish`'s exact reason: the recovery classification
      // compares this stamp against consumption stamps that all come from `ctx.now()`.
      createdAt: now,
    });
    await db.update(sessions).set({
      accessTokenHash: hashToken(newAccess),
      accessExpiresAt: new Date(now.getTime() + this.cfg.accessTtlMs),
      // ROLLED, not left to rot. `sessions.refresh_expires_at` was written once at login and
      // never touched again, so after the first rotation it described a token that no longer
      // existed — a column that reads like a fact and is not one. Nothing enforces it today;
      // it is kept truthful so that anything which starts to (a reaper, the admin console)
      // is reading the real window rather than a stale one. It re-issues from `now` on EVERY
      // rotation, which is the observable half of "rolling".
      refreshExpiresAt: new Date(now.getTime() + ttls.refreshTtlMs),
      lastSeenAt: now,
    }).where(eq(sessions.id, base.sessionId));

    // THE ROTATION'S SUCCESS TAIL — every one of `rotateRefresh`'s return paths (the hot path,
    // the concurrent-rotation grace, and the recovery arm) funnels through here, so the account
    // the presented credential belongs to is reported once rather than at five returns.
    //
    // Reporting here is not the same as reporting it to the REQUEST: the recovery arm runs inside
    // `inTransaction`, which buffers this and forwards it only once the transaction commits. A
    // rolled-back mint therefore names nobody. That indirection is the whole reason the buffer
    // exists — see `inTransaction`.
    ctx.noteCredentialAccount?.(base.accountId);
    return {
      accessToken: newAccess, refreshToken: newRefresh, tokenType: "Bearer",
      expiresIn: Math.floor(this.cfg.accessTtlMs / 1000),
    };
  }

  /**
   * Re-admit a stale cookie presentation whose family's tail was NEVER USED and whose client has
   * been GONE for a full access window — the lost-response client — or answer `null`, into the
   * reuse sweep. An unconsumed successor alone is not proof (the NORMAL state between rotations),
   * so recovery also requires consumption MORE than one access window ago: an awake client's
   * traffic forces rotation at expiry. The residual is the ambiguity itself: a thief replaying
   * during that exact sleep is re-admitted — audited (`refresh_recovered`), consuming the dormant
   * tail. Bounded six ways: family-, time-, idle-, use-bound (in the session lock), single-winner
   * (`FOR UPDATE`), cookie-only. A fault answers `null`: fail closed.
   */
  private async recoverLostRotation(
    ctx: ServiceContext,
    existing: typeof refreshTokens.$inferSelect,
    now: Date,
    ttls: SurfaceTtls,
  ): Promise<OAuthTokens | null> {
    const consumedAt = existing.consumedAt!;
    // The presented token's own window still stands — a rotation re-issues `expires_at` from
    // its mint, so this bounds recovery at one rolling refresh window after the loss.
    if (existing.expiresAt.getTime() <= now.getTime()) return null;
    try {
      return await this.inTransaction(ctx, async (txCtx) => {
        const tx = asTx(txCtx);
        // THE SERIALIZATION POINT: the session row, locked for the whole sequence. Without
        // it, the descendant check raced the claim — a legitimate rotation could consume the
        // tail between the read and the write, and both interleavings handed the stale
        // presenter a mint despite a spent descendant. Every recovery of this
        // family queues here; the classification below runs on a serialized view.
        const [session] = await dialect(ctx.db).forUpdate(tx.select().from(sessions)
          .where(eq(sessions.id, existing.sessionId)).limit(1));
        // The grace path's exact `renewable` reading: live session, inside any absolute cap.
        const renewable = session != null && session.revokedAt == null
          && (ttls.absoluteTtlMs == null
            || now.getTime() - session.createdAt.getTime() <= ttls.absoluteTtlMs);
        if (!renewable) return null;
        // Use-bound, in-lock: what happened after the presented token was consumed? `>=` and
        // not-self: two rotations can land in one millisecond. Three facts, each closing a
        // measured hole: SPENDS are real presentations only (`expires_at > consumed_at` — the
        // claim stamps killed rows with `expires_at = consumed_at`, and without that kill-stamps
        // read as live use; a pg test watched a healthy family get swept); the verdict keys on
        // the OLDEST spend (one stale spend proves the chain continued, whatever the latest
        // rotation's freshness); LATE MINTS — rows created more than a grace window after the
        // presented token's cohort — can only be recovery mints, making recovery SINGLE-USE per
        // token. Both evidence sets are always read and ANY old evidence dominates: a fresh spend
        // winning would re-admit a once-recovered token timed near a healthy rotation.
        const classify = async (): Promise<"quiet" | "racer" | "used"> => {
          const [oldestSpend] = await tx.select().from(refreshTokens)
            .where(and(
              eq(refreshTokens.familyId, existing.familyId),
              ne(refreshTokens.id, existing.id),
              isNotNull(refreshTokens.consumedAt),
              gte(refreshTokens.consumedAt, consumedAt),
              gt(refreshTokens.expiresAt, refreshTokens.consumedAt),
            ))
            .orderBy(refreshTokens.consumedAt).limit(1);
          const [oldestLateMint] = await tx.select().from(refreshTokens)
            .where(and(
              eq(refreshTokens.familyId, existing.familyId),
              // NOT-SELF, like the spends query: a presented row whose own `created_at` sits
              // ahead of its consumption stamp (clock skew between the minting request and
              // the rotating one) must never classify as its own late mint.
              ne(refreshTokens.id, existing.id),
              gt(refreshTokens.createdAt,
                new Date(consumedAt.getTime() + this.cfg.refreshReuseGraceMs)),
            ))
            .orderBy(refreshTokens.createdAt).limit(1);
          const fresh = (at: Date): boolean =>
            now.getTime() - at.getTime() <= this.cfg.refreshReuseGraceMs;
          const verdicts: Array<"racer" | "used"> = [];
          if (oldestSpend?.consumedAt) verdicts.push(fresh(oldestSpend.consumedAt) ? "racer" : "used");
          if (oldestLateMint) verdicts.push(fresh(oldestLateMint.createdAt) ? "racer" : "used");
          if (verdicts.includes("used")) return "used";
          return verdicts.length > 0 ? "racer" : "quiet";
        };
        const verdict = await classify();
        if (verdict === "racer") {
          // Every spend after the presented token happened instants ago: the concurrent-
          // recovery loser, or a stale presenter colliding with the one live rotation. It
          // converges exactly like a grace-loser — the shared jar takes whichever cookie
          // lands last.
          return this.mintRotation(txCtx, tx, existing, now, ttls);
        }
        if (verdict === "used") return null;   // a second holder in real use: the sweep's case
        // IDLE-BOUND: nothing was spent since — but that is only evidence of a lost response
        // once a full access window has passed (see the header). Inside it, refuse.
        if (now.getTime() - consumedAt.getTime() <= this.cfg.accessTtlMs) return null;
        // THE CLAIM: kill the dormant tail, leaving exactly one live line (the mint below).
        // `expires_at = consumed_at` is the kill's SIGNATURE, chosen because it is
        // self-describing rather than a flag: an expired token IS dead on every path. It is
        // what lets `classify` above tell kills from spends, it keeps a killed row's
        // within-grace presentation converging through the ordinary grace arm (that arm never
        // reads expiry — the crossrace pg test's delivered-tail case), and it routes a LATE
        // presentation of a killed row to the plain-401 arm in `rotateRefresh` instead of the
        // sweep — a kill names no second holder of the family's real chain.
        const claimed = await tx.update(refreshTokens)
          .set({ consumedAt: now, expiresAt: now })
          .where(and(
            eq(refreshTokens.familyId, existing.familyId),
            isNull(refreshTokens.consumedAt),
            isNull(refreshTokens.revokedAt),
          ))
          .returning({ id: refreshTokens.id });
        if (claimed.length === 0) {
          // The tail vanished between the classification and the claim: the HOT PATH's token
          // claim is a single autocommitting UPDATE that does not take the session lock, so a
          // live rotation can spend the tail in that gap. Reclassify
          // rather than fall through — `null` here would flow into the reuse sweep and revoke
          // the very family whose rotation just succeeded, and the cookie handler would clear
          // the jar that rotation had just refilled. A fresh spend converges; anything else
          // is genuinely the sweep's case (no live tip at all).
          return (await classify()) === "racer"
            ? this.mintRotation(txCtx, tx, existing, now, ttls)
            : null;
        }
        // Audited IN the claim's transaction: no recovery without its row while the
        // bookkeeping works, and a bookkeeping fault rolls the claim back (the catch below
        // answers null — the sweep, never a silent re-admission).
        const [user] = await tx.select().from(users)
          .where(eq(users.id, existing.userId)).limit(1);
        await this.audit(tx, user ?? null, "refresh_recovered", undefined, txCtx,
          `family=${existing.familyId} session=${existing.sessionId}`);
        return this.mintRotation(txCtx, tx, existing, now, ttls);
      });
    } catch {
      return null;
    }
  }

  protected async revokeFamily(db: Tx, familyId: string, now: Date): Promise<void> {
    await db.update(refreshTokens).set({ revokedAt: now })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    await db.update(sessions).set({ revokedAt: now })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
  }

  // ── Internal: user helpers ──────────────────────────────────────────────────

  protected requireUser(ctx: ServiceContext): string {
    if (!ctx.userId) throw new ServiceError("unauthorized", 401, "no active session");
    return ctx.userId;
  }

  protected async loadUser(db: Tx, userId: string): Promise<typeof users.$inferSelect> {
    const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!u) throw new ServiceError("unauthorized", 401, "no such user");
    return u;
  }

  protected async sessionUser(db: Tx, userId: string): Promise<SessionUser> {
    const u = await this.loadUser(db, userId);
    return {
      userId: u.id, accountId: u.accountId, email: u.email, displayName: u.displayName,
      twofaEnrolled: await this.twofaEnrolled(db, userId),
      // A boolean, so `JoinScreen`'s `bootstrap()` derives the verify step from server
      // state like every other step. The timestamp itself stays server-side.
      emailVerified: u.emailVerifiedAt !== null,
    };
  }

  // ── The hosted hooks — see the class header ─────────────────────────────────

  /**
   * Which second factors this user has enrolled. The lifecycle half holds NONE of the factor
   * tables (they are the identity ceremony, cloud-half), so the base answer is all-false — the
   * literal truth on a local install, where the machine's own login is the boundary and
   * `mintLaunchSession` stamps step-up at boot without any factor existing. `AuthService`
   * overrides this with the real reads.
   */
  protected async twofaEnrolled(_db: Tx, _userId: string): Promise<TwofaEnrolled> {
    return { webauthn: false, totp: false, recoveryCodes: false };
  }

  /**
   * The auth event trail. `auth_events` is cloud-half — an operator's investigation surface — and
   * a mail-only store has no such table, so the base records nothing: the same posture as the
   * launch-session mint. `AuthService` overrides this with the real INSERT, so every hosted path
   * writes exactly the rows it always wrote. `detail` is the optional MACHINE half of a row — a
   * short `key=value` string composed from ids the writer already holds; the hosted override
   * stores it in the row's `device` column IN PLACE of the user agent, for events with something
   * more useful to say there. Callers that pass nothing keep the user-agent behaviour byte for
   * byte.
   */
  protected async audit(
    _db: Tx, _user: typeof users.$inferSelect | null,
    _event: AuthAuditEvent["event"], _method: AuthAuditEvent["method"] | undefined, _ctx: ServiceContext,
    _detail?: string,
  ): Promise<void> {
    /* no event table on the lifecycle half — see the doc comment */
  }

  /**
   * The login-throttle reset a completed mint performs. `auth_throttle` is cloud-half and only
   * the ceremony (login, verify) ever INCREMENTS it, so on the lifecycle half there is nothing
   * to reset and the base is a no-op. `AuthService` overrides this with the real UPDATE.
   */
  protected async throttleReset(_db: Tx, _key: string): Promise<void> {
    /* no throttle table on the lifecycle half — see the doc comment */
  }
}

export function makeSessionLifecycle(deps: SessionLifecycleDeps): SessionLifecycle {
  return new SessionLifecycle(deps);
}
