import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { devices, refreshTokens, sessions, users, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "../context.js";
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
 * SessionLifecycle — the session MACHINERY, carved out of `AuthService` so the desktop-as-host
 * tier can run it (Phase 3). This class is what a session IS once it exists: the mint
 * (`establish`), rotation with refresh-reuse detection, family revocation, logout, the device
 * list and its revoke, step-up introspection, and the paired-device mint the QR redeem calls.
 *
 * What it deliberately is NOT is the identity CEREMONY — registration, passwords, invites,
 * factors, WebAuthn, PKCE, throttles, the audit trail (the base records nothing and its
 * {@link listAudit} read answers empty; the hosted service overrides both halves with the real
 * table). That stays on `AuthService`, which
 * `extends` this class, overrides the three hosted hooks at the bottom, and behaves byte-for-
 * byte as it did when all of this was one file: same methods, same order, same statements.
 *
 * ── WHY THE SEAM IS AN `extends` AND WHERE IT MAY BE CUT ──────────────────────────────────
 *
 * The desktop engine bundles this module (via `@trafficflow/services/auth` → the sidecar's
 * service bag) and its import closure is therefore a decision about what a public download
 * conveys — the exact discipline `src/mail.ts` states for the engine barrel. Everything this
 * file reaches is the SHARED half: `users`/`devices`/`sessions`/`refresh_tokens` (mail 0060)
 * from the schema, the crypto/config leaves, and nothing else. `auth-entry-census.test.ts`
 * pins the closure; the engine build's artifact census is the second line.
 *
 * The machinery is REUSED by both tiers rather than reimplemented — one rotation protocol, one
 * reuse detector, one family revocation — because two implementations of refresh-reuse
 * detection is how one tier's stolen token stays alive on the other. The paired-device e2e in
 * `apps/sidecar` runs THESE methods against PGlite; the hosted suites run them through
 * `AuthService` against Postgres.
 *
 * ── THE THREE HOSTED HOOKS ────────────────────────────────────────────────────────────────
 *
 * `audit`, `throttleReset` and `twofaEnrolled` name cloud-half tables (`auth_events`,
 * `auth_throttle`, the factor tables), which a mail-only store does not hold and a public
 * bundle may not name. Here they are the LOCAL tier's truth — no event log (the launch-session
 * mint writes none either), no throttle (the credential is the pipe), no factors (the machine's
 * own login is the boundary) — and `AuthService` overrides all three with the real reads and
 * writes, so the hosted behaviour is unchanged in every path that runs there.
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
  protected async inTransaction<T>(
    ctx: ServiceContext, fn: (txCtx: ServiceContext) => Promise<T>,
  ): Promise<T> {
    return asTx(ctx).transaction(async (tx) => fn({ ...ctx, db: tx as unknown as ServiceContext["db"] }));
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
   * Rotate a refresh token.
   *
   * `concurrentGrace` is opt-in and OFF by default, and only the COOKIE surface passes it. It is a
   * property of the shared browser cookie jar: several tabs read one `tf_refresh` and can present
   * it at once, and the client single-flights refresh only per tab, so a benign duplicate is
   * structural there and revoking the family on it signs a working session out. A native/bearer
   * client and the OAuth `refresh_token` grant hold their token privately and rotate it serially —
   * they have no such race, so they keep the strict RFC 9700 §4.14.2 response (a re-presented
   * consumed token revokes the family). Confining the grace to the surface that needs it is what
   * keeps a public-client replay from silently buying a parallel credential.
   *
   * `surface` rides the SAME branch and chooses the LIFETIME the rotation issues (see
   * `surfaceTtls`). It is a second, independent option rather than a reading of `concurrentGrace`
   * because the two axes have opposite strict ends — strict lifetime is the cookie one, strict
   * reuse is the native one — so one flag could only be strict on one of them. Omitting it means
   * the cookie window, which is the shorter of the two: a caller that forgets is short-changed,
   * never over-served.
   *
   * A NOTE ON WHAT THE SURFACE IS READ FROM, because it is a request property and not a row: the
   * lifetime follows the branch this presentation arrived on, not the device the session was
   * minted for. The two only disagree if a `tf_refresh` cookie is presented in a native body (or
   * the reverse), and the cookie is HttpOnly, `SameSite=Strict` and `Path=/auth/refresh` — so
   * moving one to the other branch means already holding it, and a holder can rotate the chain
   * for ever on its own branch anyway. The window it would gain is not access it lacked.
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
   * Mint the session a PAIRING-TOKEN redeem establishes (`pairing.ts`, `device-pair` grant) —
   * the `claimDesktopLink` tail as a seam, so the pairing module reuses this class's
   * session machinery (`establish`: device row, session row, refresh family, audit trail,
   * surface TTLs) instead of hand-rolling any of it. The BURN is not here: single-use, TTL and
   * revocation are decided by the pairing table's one atomic UPDATE before this is called, and
   * this method must stay free of authority decisions of its own — its caller has already
   * consumed the credential that authorizes it.
   *
   * Three deliberate differences from the desktop-link tail, each argued rather than inherited:
   *
   *  · **The device row carries the TOKEN's label, not a kind-derived default.** The minter
   *    named the device at mint time ("kitchen iPad"), and that name is what makes
   *    `GET /devices` legible and `DELETE /devices/:id` aimable — the revocation path being the
   *    reason pairing is safe to offer at all.
   *
   *  · **`kind` is the REDEEMER's declaration, and it names the DEVICE ROW — never a lifetime.**
   *    The desktop claim's tail could hardcode its kind because its caller IS the desktop app; a
   *    pairing token is redeemed by whatever scanned the QR — a phone browser today (Phase 3),
   *    the native app later (Phase 5) — and stamping "macos" on a browser was the wire wart this
   *    slice removed: the device list lied about what was paired. The set is closed here — an
   *    unlisted kind refuses rather than defaulting, because a clamp ships a device row nobody
   *    chose — and the DEFAULT for a caller that says nothing is decided at the redeem
   *    (`redeemDevicePair`: "web"), never here. What the declaration must NOT reach is the TTL
   *    surface: it is anonymous wire input, so letting it pick `native` would hand any token
   *    holder the choice of their credential's idle window — and letting it pick `cookie` would
   *    only pretend to be stricter, because a bearer pair rotates through the body branch, which
   *    re-issues the NATIVE window on the first rotation whatever the mint chose. So the mint
   *    pins `surface: "native"` — the bearer reality, one policy at mint and at rotation — and
   *    the kind is display truth only.
   *
   *  · **`twofaAt: null` — the paired session starts with NO step-up standing.** The desktop
   *    claim stamps `ctx.now()` and its header earns it: a step-up-gated mint plus a TWO-MINUTE
   *    code means a factor really was asserted within that window. A pairing token lives up to
   *    fifteen minutes (`PAIRING_TTL_BOUNDS`), which stretches that argument past what it
   *    proves — and unlike the desktop link, nothing a freshly paired device does on day one
   *    needs step-up: mail is not step-up-gated, and what IS (revoking devices, removing a
   *    factor, minting MORE pairing tokens) is exactly what a just-paired device should not
   *    inherit from a credential that may have crossed a room on paper. NULL fails step-up
   *    closed ({@link requireStepUp}), which that column's own doc calls the correct reading
   *    and the safe one. It also breaks the chain where pairing begets pairing: this session
   *    cannot reach `POST /pair` until its holder asserts a factor of their own.
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
   * Revoke every DEVICE-LESS full session of the caller except the caller's own — the one
   * bulk verb behind "sign out all other web sessions".
   *
   * The scope is structural, never a label: `device_id IS NULL` is what a plain browser
   * sign-in is (a device row means a NAMED device — a pairing redeem's mint or the desktop's
   * macos claim), so a paired device can never be swept by this however it is labeled. The
   * caller survives twice over — its session id AND its family are excluded — and the scope
   * pin (`scope = 'full'`) keeps the predicate exact rather than relying on "no enrollment
   * session can coexist with a full one" holding forever.
   *
   * Step-up gated for `logout {allDevices}`'s exact reason: mass sign-out is device
   * revocation in effect. NOT mounted on the desktop-host door (`routes/desktop-host.ts`) —
   * there the device-less non-current session IS the host's launch session, which a remote
   * viewer must never be able to kill; the route array that carries this verb is spread into
   * `authRoutes` only, and `desktop-host.test.ts` censuses the absence.
   */
  async revokeWebSessions(ctx: ServiceContext): Promise<{ revoked: number }> {
    const userId = this.requireUser(ctx);
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
    // SET-BASED AND ATOMIC — both properties review-bought, one per pass. Set-based: the loop
    // shape (`revokeFamily` per family — two awaited UPDATEs each, serially) was 400+ round
    // trips on exactly the accounts this verb exists for, inside a hosted request with a
    // 60-second ceiling: a "Sign out all" that times out having revoked only a PREFIX. One
    // guarded claim takes the whole scope; the refresh families die in bounded IN-chunks off
    // the claim's own RETURNING — O(1 + n/500) statements. Atomic: with the claim committing
    // separately, a chunk that failed left every session revoked and some refresh rows live,
    // and the RETRY claimed zero rows (`revoked_at IS NULL`) — it could never revisit those
    // families. (The rotation orphan-guard made such leftovers unusable at presentation, but
    // a security verb whose bookkeeping cannot converge is still the defect.) One
    // transaction holds claim, sweeps and audit: a mid-sweep death rolls the claim back and
    // the retry does the whole job. Families are 1:1 with sessions by construction
    // (`establish` mints a fresh familyId per session), so sweeping tokens by the claimed
    // familyIds is `revokeFamily`'s exact reach.
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
   * ── `twofaAt` IS REQUIRED, AND THAT IS THE POINT ──────────────────────────────────────────
   *
   * This used to write `lastTwofaAt: now` unconditionally, and the comment on the line asserted
   * that a full session is only ever reached through a completed 2FA "(or the PKCE code that one
   * produced)". The parenthesis is where it broke: the PKCE exchange asserts no factor, so `now`
   * was a timestamp for something that had not happened in that ceremony — an authorization
   * laundered into a fresh factor.
   *
   * There is no safe default here, so there is no default. Every call site must say
   * which kind of ceremony it is, exactly as `Route.cost` is required so that adding a route is a
   * compile error rather than a silent hole:
   *
   *  · A factor really was asserted HERE (TOTP, WebAuthn, a recovery code, or the first-factor
   *    enrollment exchange) → `ctx.now()`, and it is honest.
   *  · The ceremony INHERITED an authorization (the native PKCE exchange) → the authorizing
   *    session's real `last_twofa_at`, carried on the code row.
   *  · `claimDesktopLink` passes `ctx.now()` and keeps it: its mint is step-up gated and the
   *    code lives two minutes, so a factor really was asserted, by this person, within that
   *    window — the argument its own header makes. The difference from the PKCE door is not the
   *    shape of the ceremony but whether that precondition held, and until this slice it did not
   *    hold there.
   *
   * NULL is admissible and means "no factor time to inherit". It fails step-up closed in both
   * `withStepUp` and {@link requireStepUp}, which is the correct reading and also the safe one.
   *
   * Nothing rotates this stamp forward afterwards — `rotateRefresh` does not touch
   * `last_twofa_at` — so a session ages out of step-up on the schedule of the factor it actually
   * descends from. Inheriting rather than re-stamping is what makes that true across the hop as
   * well as within a family.
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
    // THE MINT PICKS THE SAME SURFACE THE DEVICE ROW RECORDS, from the one signal that already
    // exists: `kind`. A browser ceremony (login, 2FA verify, recovery code) is `web` and takes the
    // cookie window; the two native doors — the PKCE token exchange and the desktop-link claim —
    // are `macos` and take the native one. Deriving it rather than adding a second parameter is
    // what stops a session whose device says "Web" from holding a 400-day credential: there is one
    // value, and both the row and the lifetime read it. Anything that is not `macos` is a browser
    // as far as this decision goes — the strict side, per `surfaceTtls`. The platform-qualified
    // desktop kinds deliberately take the STRICT side of this derivation too: on the one seam
    // where they are wire input (a 2FA verify's declaration), the declaration must not be able to
    // buy the native window, so any caller whose transport really is native pins `o.surface`
    // itself — the desktop-link claim does, exactly as the paired mint always has.
    //
    // `o.surface` is the ONE exception, for the caller whose `kind` is not its own to derive
    // from: a pairing redeem's kind arrives from the anonymous redeemer, so the paired mint pins
    // the surface its TRANSPORT dictates instead — see the option's doc above.
    const ttls = surfaceTtls(this.cfg, o.surface ?? (o.kind === "macos" ? "native" : "cookie"));
    // A device row means a NAMED device, so only a DESKTOP kind auto-mints one — the desktop app
    // really is a device a user manages by name. The label map below is the closed set of kinds
    // that may auto-mint: the legacy "macos" spelling (the shipped desktop's claim) and the
    // platform-qualified desktop kinds a current install declares. A plain web ceremony
    // mints NO row: it used to mint one labeled "Web" per sign-in, which turned the list that
    // exists to make PAIRED devices visible into a flood of indistinguishable rows (hundreds
    // on a well-used account) and left `devices` growing without bound. The mobile kinds are
    // deliberately NOT in the map: a phone arrives only through the pairing redeem, which
    // pre-creates the row with the mint-time label and passes `deviceId`. Device-less is also
    // what the sidecar's launch session has always been (`identity.ts` narrows on
    // `isNull(sessions.deviceId)`), so `device_id IS NULL` now means the same thing on every
    // tier: a session that is not a named device. Migration 0061 backfills the historical
    // "Web" rows to match.
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
   * Rotate a refresh token — CLAIM FIRST, then decide.
   *
   * This was SELECT → check `consumed_at` → UPDATE, and that shape defeats the very reuse
   * detection it was written to implement. Two concurrent presentations of one token both
   * read `consumed_at === null`, both skip the `revokeFamily` branch, and both mint valid
   * descendants — so an attacker holding a stolen refresh token who simply races the
   * legitimate client gets a working session AND leaves the family alive. The detection
   * fires only when the two presentations are far enough apart to be the case nobody worries
   * about.
   *
   * It is the identical defect class `consumeInvite` (`invites.ts`) is deliberately written
   * as a single conditional UPDATE to avoid, and the fix is the same: the claim IS the
   * check. `UPDATE … WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now
   * RETURNING` — the row lock picks exactly one winner, and everybody else falls through to
   * the classification below, which now runs only on a row that this call did not claim.
   *
   * The classification read is deliberately AFTER the failed claim rather than before the
   * successful one: on the hot path (a valid rotation) it never runs at all.
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
      // Refresh-token reuse detection: a token that was already consumed being
      // presented again means it leaked → revoke the WHOLE family.
      //
      // ── EXCEPT THE CONCURRENT ROTATION, WHICH IS NOT THEFT ────────────────────────────────
      //
      // This used to revoke unconditionally, on the argument that "one token, two presentations"
      // is indistinguishable from theft and the safe reading is theft. That is true at a single
      // INSTANT and false over TIME, and the unconditional form was signing working sessions out:
      // a browser shares one cookie jar across all its tabs, the client single-flights refresh
      // only per tab (`apps/webapp/app/session-refresh.ts`), so a second tab/window — or the sync
      // client and the REST client — crossing the access-token expiry together both read the same
      // `tf_refresh` and present it at once. One wins; the loser presented a token consumed
      // milliseconds ago and got the whole family revoked. That is the "session is no longer
      // authorized" a signed-in user hit merely by opening a new tab.
      //
      // So the distinction is keyed on TIME-SINCE-CONSUMED, not on an unknowable intent, and only
      // on the surface that has the race (`grace`, the cookie jar — see `refresh`). Within
      // `refreshReuseGraceMs` of consumption, on a family that is still ALIVE and within its
      // absolute cap, a re-presentation is a benign concurrent rotation: mint a fresh rotation off
      // the same family and return it, without revoking. The winner and the grace-loser converge
      // on whichever cookie the shared jar wrote last, and no session dies. A presentation OLDER
      // than the window — or ANY re-presentation on a strict (native/OAuth) surface — is a token
      // that was kept and replayed after the real client rotated past it, the theft case, and it
      // still revokes. See `config.ts` for the full security argument, including the bounded
      // residual the cookie window accepts.
      if (existing.consumedAt) {
        const consumedMsAgo = now.getTime() - existing.consumedAt.getTime();
        if (grace && consumedMsAgo <= this.cfg.refreshReuseGraceMs) {
          const [session] = await db.select().from(sessions)
            .where(eq(sessions.id, existing.sessionId)).limit(1);
          const renewable = session != null && session.revokedAt == null
            && (ttls.absoluteTtlMs == null
              || now.getTime() - session.createdAt.getTime() <= ttls.absoluteTtlMs);
          if (renewable) return this.mintRotation(db, existing, now, ttls);
        }
        // ── THE LOST-RESPONSE RECOVERY, past the grace window, cookie surface only ────────────
        //
        // A rotation is two halves: the server consumes the presented token and mints the next
        // one, and the response carries the next one back into the browser's jar. When the
        // second half is LOST — the lid closes mid-refresh, the network drops between commit
        // and delivery — the jar keeps the OLD token, and the browser's next presentation of
        // it, minutes or hours later, looked exactly like replayed theft and burned the family.
        // Measured twice in production, one morning apart (2026-08-27: re-presented 29.5
        // minutes after consumption, successor never used; 2026-08-28: 10.1 seconds, 114 ms
        // past the old grace window). No grace width fixes the first shape; this does.
        //
        // The discriminator is USE plus IDLE TIME: consumption only ever happens on
        // presentation, so a stale jar always holds the family's newest-consumed token — and
        // a tail still unconsumed after a FULL ACCESS WINDOW means no awake client is driving
        // the session (an awake one is forced to rotate at access expiry). Both conditions,
        // and the serialization that makes them honest under concurrency, live in
        // `recoverLostRotation`; when they hold it consumes the dormant tail and mints afresh
        // in one locked sequence. Otherwise it returns null and the presentation falls
        // through to the sweep below: the theft reading stands wherever a second party
        // actually spent the credential, and wherever an awake client still might.
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
        // THE SWEEP LEAVES A ROW, and sweep + row are ONE TRANSACTION — with the sweep
        // REDONE ALONE if that transaction cannot commit. It used to leave nothing: the
        // client just started getting 401s, and the only record of WHY was raw session rows
        // an operator had to correlate by revoked_at after the fact — the Aug-21 incident,
        // reconstructed exactly that way. Who (the user row), when (the event's own stamp),
        // which family and session (the detail), what triggered it (the event name).
        //
        // BOTH failure directions were reviewed, and each ruled out the naive form:
        //
        //  · Sequential autocommit (sweep, then insert) can die between the two — a family
        //    revoked with NO record, permanently: the next presentation hits `revokedAt` and
        //    takes the plain-401 arm, so nothing ever writes the missing row.
        //  · One transaction ALONE fails the other way, and worse: on the cookie surface the
        //    HTTP handler answers any error here by CLEARING the session cookies, so the
        //    consumed token is never re-presented — "the retry re-runs this branch" is false
        //    exactly where most refreshes happen — while a separately held descendant (the
        //    thief's, in the theft reading) keeps the compromised family ALIVE. A bookkeeping
        //    fault must never veto a security sweep.
        //
        // So: the transaction is the ordinary path — revocation and record commit together,
        // and no committed sweep lacks its row while the bookkeeping works. If it cannot
        // commit, the catch REDOES THE SWEEP ALONE on the autocommitting handle: the family
        // dies (fail-closed), and the record is lost only in the asymmetric case where the
        // database accepted two UPDATEs and refused an INSERT — a real fault the alert pass
        // itself will be screaming about on its own channel.
        //
        // The hosted tier writes `auth_events`; the lifecycle base records nothing, which is
        // that tier's truth for every audit hook. The user read is DEFENSIVE, never
        // `loadUser`: a vanished user must not turn this 401 into another error, and `audit`
        // accepts null (the row keeps the family id either way).
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

    // ── THE ABSOLUTE CAP, WHEN A SURFACE HAS ONE ──────────────────────────────────────────
    //
    // Rotation rolls the refresh window forward every time, so a session that keeps being used
    // renews indefinitely. That is the decision `config.ts` takes for both shipped surfaces —
    // nobody should be signed out of their mail for using it — and both therefore set
    // `absoluteTtlMs: null` and never reach the check below.
    //
    // The check stays, live and enforced, for any surface or deployment that DOES set a
    // ceiling: `null` means "no ceiling", not "unset", and a number means the number. Measured
    // from the SESSION's creation, not the token's — rotation mints a new token each time, so a
    // per-token measure would be exactly the rolling window this is meant to bound. Checked
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

    return this.mintRotation(db, row, now, ttls);
  }

  /**
   * Insert the next refresh token of a family and slide its session's access + refresh windows
   * forward, returning the new pair. The ONE writer of a rotation, shared by the hot path (a
   * freshly-claimed token) and the grace path (a benign concurrent re-presentation) so the two
   * can never drift in what a rotation actually writes.
   *
   * `base` is whichever refresh-token row named the family — the just-claimed row on the hot path,
   * the already-consumed row on the grace path. Either way the new token inherits the SAME
   * account, user, session and family; a rotation never starts a new family, which is what would
   * keep an absolute ceiling (measured from `sessions.created_at`) real for a surface that sets
   * one.
   *
   * `ttls` is RESOLVED BY THE CALLER and passed in rather than read from `this.cfg` here. That is
   * the whole of what makes the window ROLLING per surface: this is the one writer, it re-issues
   * `expires_at` from `now` on every rotation, and it takes the window from the same resolution
   * `rotateRefresh` checked its cap against — so the cookie surface cannot be handed the native
   * window by a path that resolved the surface once and read the config again later.
   */
  private async mintRotation(
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

    return {
      accessToken: newAccess, refreshToken: newRefresh, tokenType: "Bearer",
      expiresIn: Math.floor(this.cfg.accessTtlMs / 1000),
    };
  }

  /**
   * Re-admit a stale cookie presentation whose family's tail was NEVER USED and whose client
   * has been GONE for at least a full access window — the lost-response client — or answer
   * `null`, which sends the caller to the reuse sweep.
   *
   * ── WHY "UNCONSUMED SUCCESSOR" ALONE IS NOT PROOF, AND WHAT THE IDLE BOUND ADDS ──────────
   *
   * An unconsumed successor is the NORMAL state between two rotations: an awake client holds
   * its fresh token idle until the access token expires (`accessTtlMs`), so for that whole
   * window a thief replaying the just-rotated-past token would find a "dormant" tail on a
   * perfectly healthy session — recovery without a bound would hand that thief a fresh pair
   * while the legitimate client is still awake beside it. The idle bound closes that:
   * recovery requires the presented token to have been consumed MORE than one full access
   * window ago. An awake client's own sync traffic forces a rotation at access expiry, so a
   * successor still unconsumed after that is a client that genuinely went away — the lid
   * close, measured in production at 29.5 minutes and overnight. Inside the window the
   * presentation takes the sweep, exactly the pre-recovery answer, which is loud.
   *
   * The residual, stated: a thief holding the second-newest token of a family whose client
   * slept immediately after rotating — before ever spending the successor — is re-admitted if
   * they replay during that sleep. That window is the lost-response ambiguity itself: no
   * server-side rule can tell those two apart, the act is AUDITED (`refresh_recovered`), it
   * consumes the dormant tail (single live line, no quiet parallel chain), and the client's
   * wake then presents a consumed token and re-arms detection.
   *
   * Bounded six ways:
   *  · FAMILY-BOUND — the mint reuses the presented row's account/user/session/family;
   *    no scope change, no step-up stamp, no new session.
   *  · TIME-BOUND — the presented token must be inside its own issued `expires_at`, the
   *    session alive, and the surface's absolute cap (when one is set) respected.
   *  · IDLE-BOUND — consumed more than `accessTtlMs` ago, the paragraph above.
   *  · USE-BOUND — any consumption after the presented token's disqualifies (fresh ones
   *    converge under grace; older ones sweep), re-checked INSIDE the session lock.
   *  · SINGLE-WINNER — the session row is locked `FOR UPDATE` for the whole
   *    classify-claim-mint sequence, so concurrent recoveries and the grace/recovery
   *    interleavings serialize; a loser converges through the fresh-consumption grace
   *    instead of 401-ing (a 401 here would clear the jar the winner just refilled).
   *  · COOKIE-ONLY — the `grace` flag gates it; the native/OAuth surfaces rotate serially,
   *    have no lost-response shape a relaunch does not fix, and keep strict reuse.
   *
   * A fault inside the transaction answers `null`: fail CLOSED, into the sweep — a
   * bookkeeping error must never widen admission, and the cost (an honest user signs in
   * again) is exactly the pre-recovery behaviour.
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
        const [session] = await tx.select().from(sessions)
          .where(eq(sessions.id, existing.sessionId)).limit(1).for("update");
        // The grace path's exact `renewable` reading: live session, inside any absolute cap.
        const renewable = session != null && session.revokedAt == null
          && (ttls.absoluteTtlMs == null
            || now.getTime() - session.createdAt.getTime() <= ttls.absoluteTtlMs);
        if (!renewable) return null;
        // USE-BOUND, in-lock: what happened after the presented token was consumed?
        // `>=` AND not-self, not `>`: two rotations can land in one millisecond (the wake
        // herd is a burst), and a strict comparison would read the second rotation's
        // consumption as "not after" the first's.
        //
        // The classification reads THREE facts, each closing a measured hole:
        //
        //  · SPENDS — real presentations only: `expires_at > consumed_at`, because the claim
        //    below stamps the rows it kills with `expires_at = consumed_at`, and a kill is
        //    not a presentation. Without the distinction, one recovery's kill-stamps read as
        //    "the chain continued in real use" to every LATER classification on the family,
        //    and the round-3 pg net watched a healthy family get swept by exactly that.
        //  · The verdict keys on the OLDEST spend: a live client
        //    rotates every access window, so "within the grace of SOME rotation" recurs for
        //    ever — an ancient token could simply wait for one. One stale spend proves the
        //    chain continued, and no freshness of the latest rotation overrides it.
        //  · LATE MINTS — rows created more than a grace window after the presented token's
        //    own rotation cohort can only be recovery/convergence mints, so their existence
        //    means this family was already recovered past this token: fresh ones converge
        //    (the herd straggler arriving just after the winner), older ones refuse — which
        //    is what makes recovery SINGLE-USE per presented token even though the kills no
        //    longer masquerade as spends.
        // BOTH evidence sets are always read, and ANY old evidence dominates: a fresh
        // spend alone must not short-circuit to "racer", because a family that
        // already recovered past this token carries its old recovery mint as late-mint
        // evidence — and letting the fresh spend win would re-admit the once-recovered token
        // whenever its replay is timed near a healthy rotation, the round-2 hole re-opened
        // through the other evidence set.
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
          return this.mintRotation(tx, existing, now, ttls);
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
            ? this.mintRotation(tx, existing, now, ttls)
            : null;
        }
        // Audited IN the claim's transaction: no recovery without its row while the
        // bookkeeping works, and a bookkeeping fault rolls the claim back (the catch below
        // answers null — the sweep, never a silent re-admission).
        const [user] = await tx.select().from(users)
          .where(eq(users.id, existing.userId)).limit(1);
        await this.audit(tx, user ?? null, "refresh_recovered", undefined, txCtx,
          `family=${existing.familyId} session=${existing.sessionId}`);
        return this.mintRotation(tx, existing, now, ttls);
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
   * The auth event trail. `auth_events` is cloud-half — an operator's investigation surface —
   * and a mail-only store has no such table, so the base records nothing: the same posture the
   * launch-session mint has always had (no audit row per launch). `AuthService` overrides this
   * with the real INSERT, so every hosted path writes exactly the rows it always wrote.
   *
   * `detail` is the optional MACHINE half of a row — a short `key=value` string the writer
   * composes from ids it already holds (the reuse row's `family=… session=…`). The hosted
   * override stores it in the row's `device` column IN PLACE of the user agent, for the events
   * that have something more useful to say there than what client string presented. Callers
   * that pass nothing keep the user-agent behaviour byte-for-byte.
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
