import { generateToken } from "@trafficflow/services";
import { silentLogger } from "@trafficflow/core";
import { serviceContext } from "../context.js";
import { clearSessionCookies, ownerCookieValue, sessionCookies, OWNER_COOKIE } from "../cookies.js";
import { csrfTokenFor } from "../csrf.js";
import type { Route } from "../router.js";
import { cookieSurface, json, noContent, parseCookies, readBody } from "./shared.js";
import { auth, enrollmentSession } from "./shared-cloud.js";

/** §2.2 — register, login, session, logout, refresh. */
export const coreRoutes: Route[] = [
  {
    // TWO shapes, and the split is what closed the account-existence oracle public
    // registration used to be.
    //
    // **Invite path** — 201 + an ENROLLMENT-SCOPED session: the wire path from
    // registration to a first session that was once missing entirely. `tf_session`/`tf_csrf` for the
    // browser, `enrollmentToken` in the body for native. Unchanged, including its 409
    // `email_taken`, which is a fact about a caller who proved they hold an email-bound invite
    // rather than an oracle.
    //
    // **Public path** — a CONSTANT `202 {"status":"ok"}` with NO COOKIES, byte-identical for a
    // fresh address and one that already has an account. Three things about it are load-bearing:
    //
    //  · The body is a fixed literal, not the service's result. `RegistrationPending` carries
    //    `mailed` for the operator smoke path and the suite, and putting it on the wire would
    //    hand an anonymous caller a readout of the per-recipient mail limiter — the exact
    //    mistake `POST /waitlist` shipped and had to undo (see `routes/waitlist.ts`).
    //  · NO `Set-Cookie`, on either branch. A constant body with a cookie on one branch only is
    //    the same oracle relocated into a header, and `enrollmentSession()` would emit two.
    //  · 202, not 201. The durable effect may or may not have happened — that is the whole
    //    point — and the visible one (the mail) is best-effort. 201 would claim a creation this
    //    response deliberately declines to confirm.
    method: "POST",
    pattern: "/auth/register",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ email: string; password: string; displayName: string; inviteCode: string }>(req);
      const result = await auth(deps).register(serviceContext(deps, req), body);
      if (result.status === "verification_pending") {
        // OBSERVABILITY, and it has to live here because no service in this codebase takes a
        // logger — services return facts and `packages/api` writes the line (`withErrorEnvelope`
        // and `routes/admin.ts` follow the same split).
        //
        // A mail that fails to send is the ONE way this endpoint can leave somebody with an
        // account and no way to finish: the response is constant, so the caller is told to check
        // an inbox that will stay empty. It does not fail the request — the login re-entry path plus
        // the wizard's resend recovers it, and turning a mail-provider blip into a lost signup would be
        // worse — but it must not be silent either, which is precisely what `mailed` is for.
        //
        // NO ADDRESS in the line. It is the one field an operator does not need (a rate is what
        // you act on, and the alert pass reads aggregates) and the one that would turn the
        // platform log into a list of who tried to sign up. Same rule the rest of the pipeline
        // follows: route and code, never the payload.
        if (!result.mailed) {
          (deps.logger ?? silentLogger).error("verification_mail_failed", {
            route: "/auth/register",
            reason: "the signup was recorded but its verification mail did not send; " +
              "the account is reachable via the login re-entry path and the wizard's resend",
          });
        }
        return json({ status: "ok" }, 202);
      }
      return enrollmentSession(deps, result, 201);
    },
  },
  {
    // `POST /auth/verify-email {token, password}`. The continuation of a public signup.
    //
    // `public`: the caller has no session by definition — the mail is what they have. It is
    // still a two-credential call, and the second credential is the account password, which is
    // what stops a mailed link alone from being a takeover primitive (the pre-hijack chain is
    // written out in `AuthService.verifyEmail`).
    //
    // The response mirrors `/auth/login`'s two shapes exactly, because the decision is the same
    // one: `enrollment` (and the session cookies) for a user with zero enrolled factors, and a
    // bare `{status:"verified"}` for a user who already has one — a mailed link plus a password
    // must not skip a second factor somebody deliberately added.
    method: "POST",
    pattern: "/auth/verify-email",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ token?: unknown; password?: unknown }>(req);
      const result = await auth(deps).verifyEmail(serviceContext(deps, req), body);
      return result.status === "enrollment" ? enrollmentSession(deps, result) : json(result, 200);
    },
  },
  {
    // `POST /auth/verify-email/resend`. Protected, and the recipient is the SESSION's
    // address with no parameter for it: an endpoint that takes a recipient from an anonymous
    // caller is a mail bomb with an enumeration oracle attached.
    //
    // NOT `enrollmentOk`. The enrollment surface is deliberately narrow — seven things, none of
    // which send mail — and the wizard does not need it there: the verify step sits after the
    // factor and recovery-code steps, so the session holding it is always full. Somebody whose
    // mail never arrived reaches it the same way, via the login re-entry path.
    //
    // The body is `{ok:true}` whatever happened — sent, rate-limited, or skipped because the
    // address is already verified. A `MailSendResult` on the wire is a limiter readout, and that
    // is an oracle even for an authenticated caller.
    method: "POST",
    pattern: "/auth/verify-email/resend",
    // `ceremony`, and it is the clearest case for why that class exists: this route
    // SENDS MAIL through the transactional mail provider, so it spends, and it must nevertheless
    // be reachable by an
    // unverified account or verification is unreachable. It is not exempt from cost control,
    // it is controlled by a mechanism that CAN apply to an unproven address — the per-IP
    // `verify:ip` slot claim and the per-recipient `unsolicited` mail quota — plus
    // the fact that it can only ever mail the SESSION's own address.
    cost: "ceremony",
    handler: async (req, deps) => {
      const result = await auth(deps).resendVerification(serviceContext(deps, req));
      return json(result, 200);
    },
  },
  {
    // Two outcomes (§LoginResult): `twofa_required` normally, or — for a user with
    // ZERO enrolled methods — the same enrollment session register hands out, so a
    // registered-but-unenrolled user can resume onboarding (the re-entry path).
    method: "POST",
    pattern: "/auth/login",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ email: string; password: string }>(req);
      const result = await auth(deps).login(serviceContext(deps, req), body);
      return result.status === "enrollment" ? enrollmentSession(deps, result) : json(result, 200);
    },
  },
  {
    // enrollmentOk: introspection is how a resuming client discovers it is still
    // mid-enrollment (`scope: "enrollment"`).
    method: "GET",
    pattern: "/auth/session",
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const result = await auth(deps).getSession(serviceContext(deps, req));
      return json(result, 200);
    },
  },
  {
    // enrollmentOk: abandoning a half-finished enrollment must always be possible.
    method: "POST",
    pattern: "/auth/logout",
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const body = await readBody<{ allDevices?: boolean }>(req);
      await auth(deps).logout(serviceContext(deps, req), body);
      return noContent(cookieSurface(deps) ? clearSessionCookies() : []);
    },
  },
  {
    // Web reads the refresh token from the `tf_refresh` cookie → rotate → set new
    // cookies (204). Native sends `{ refreshToken }` in the body → 200 { tokens }.
    //
    // The cookie branch is reachable ONLY on a cookie surface. This route is
    // `public`, so `withSession` never runs on it and `deps.allowCookieAuth` had no effect
    // here at all: on `api.ohmail.app` a `tf_session` cookie was correctly ignored while a
    // `tf_refresh` cookie still rotated the family and answered with a full set of session
    // cookies. "Bearer-only" has to mean the host REFUSES cookies, not that browsers happen
    // not to point at it — so on such a host the body token is the only accepted input.
    method: "POST",
    pattern: "/auth/refresh",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const jar = parseCookies(req.headers.get("cookie"));
      const cookieRefresh = cookieSurface(deps) ? jar["tf_refresh"] : undefined;
      if (cookieRefresh) {
        // A FAILED COOKIE REFRESH MUST CLEAR THE JAR, not just refuse.
        //
        // The browser is told to resume by `tf_resume` (see `cookies.ts`), and that marker
        // outlives a refresh token that has been revoked, rotated past, or reused. Without
        // this, such a browser loops: the gate sees the marker, sends it to the resume splash,
        // the splash's refresh is refused, and the next visit does it all again — for the whole
        // ninety-day marker lifetime, on every page load. Answering the refusal with
        // `clearSessionCookies()` makes the failure self-healing: the marker goes with the rest
        // and the visitor lands on the marketing page, signed out, which is the truth.
        //
        // Rethrown as 401 rather than swallowed: the caller must still be told it failed.
        try {
          // `concurrentGrace`: this is the COOKIE surface, where a shared browser jar lets several
          // tabs present one `tf_refresh` at once and the client single-flights refresh only per
          // tab — so a duplicate presentation within the grace window is a benign concurrent
          // rotation, not theft, and must not revoke the family. The native body branch below does
          // NOT pass it: a bearer client holds its token privately and rotates it serially, so it
          // keeps strict reuse detection. See `AuthService.refresh`.
          //
          // `surface` rides the same branch and chooses the ROLLING WINDOW this rotation issues:
          // the browser's, which is the shorter one. It is stated rather than left to the default
          // — the default is this same value, and saying it here is what makes the pair below
          // (`"native"`) read as a decision instead of an omission.
          const { tokens } = await auth(deps).refresh(
            serviceContext(deps, req), { refreshToken: cookieRefresh },
            { concurrentGrace: true, surface: "cookie" },
          );
          // THE OWNER MARKER IS RE-STAMPED HERE, NOT MINTED. `refresh` rotates a token family and
          // answers tokens; it resolves no user, so this handler has no account id of its own to
          // write. What it does have is the marker the browser already holds, and extending its
          // life is the whole job: without this, a session that keeps renewing for its full
          // ninety days outlives the cookie that makes its next cold start fast, and warm open
          // degrades to the old blocking path with nothing failing anywhere.
          //
          // Echoing a client value into a `Set-Cookie` is safe here for two reasons together, and
          // it would not be for one alone: `ownerCookieValue` refuses anything outside an
          // id-shaped character set, so nothing the browser sends can become an ATTRIBUTE; and the
          // value has no authority to re-stamp — it names a local database, is read by no handler,
          // and the client still confirms it against `GET /auth/session` before trusting a row of
          // what it opens. An absent or malformed marker answers `null`, which sets no cookie and
          // clears none.
          return noContent(sessionCookies(
            tokens!, csrfTokenFor(tokens!.accessToken), deps.authConfig, ownerCookieValue(jar[OWNER_COOKIE]),
          ));
        } catch {
          return json(
            { error: { code: "unauthorized", message: "this session cannot be resumed" } },
            401,
            clearSessionCookies(),
          );
        }
      }
      // THE NATIVE BRANCH: a bearer client (the desktop app's sidecar, or the OAuth grant's
      // sibling in `/oauth/token`) presenting its own token in the body. No grace — it rotates
      // serially and a re-presentation is theft — and the LONG rolling window, because this is an
      // installed app that renews on launch rather than a browser sharing a jar. Both arguments
      // are explicit; neither is the default.
      const body = await readBody<{ refreshToken?: string }>(req);
      const { tokens } = await auth(deps).refresh(
        serviceContext(deps, req), { refreshToken: body.refreshToken }, { surface: "native" },
      );
      return json({ tokens }, 200);
    },
  },
  {
    // ── HANDING A SESSION TO THE DESKTOP APP, HALF ONE: THE MINT ───────────────────────────
    //
    // The desktop app's hosted door takes an address, a password and a six-digit code, because
    // it has no browser to run a ceremony in. That is a password typed into a native window,
    // where nobody can check an address bar. This pair is the alternative: the browser — where
    // the session already exists, the password manager works and the URL is visible — mints a
    // one-use code, and the app exchanges it.
    //
    // `ceremony`, exactly like `DELETE /devices/:id` below it in the census: this is the
    // identity lifecycle, it costs a row, and it reaches no mailbox, no model and no socket.
    //
    // `stepUp: true`, and it is the mirror image of the revoke's gate. This ADDS a device, and
    // a device holds a refresh token for `nativeRefreshTtlMs` on a machine the browser knows
    // nothing about — so a session that has merely been left open must not be able to grow itself
    // a rolling four-hundred-day native credential. The gate got MORE load-bearing when that
    // window went from thirty days to four hundred, which is the reason to state the number here
    // rather than call it "a native credential". It is also what makes the claimed session's
    // `lastTwofaAt` honest: a factor really was asserted, here, within the code's two-minute life.
    //
    // THE BODY IS READ NOW, and it carries at most one field: `challenge`, the public half of a
    // PKCE pair the desktop install is holding the other half of. Present ⇒ the minted code is
    // spendable only by a caller that can produce the verifier, which is what makes it safe to
    // hand the code to the app over a URL scheme instead of through a person's fingers. Absent ⇒
    // the code is retypable exactly as it always has been. A MALFORMED `challenge` is refused
    // rather than ignored: minting an unbound code for a caller that believes it is bound is the
    // one failure this parameter exists to prevent.
    method: "POST",
    pattern: "/auth/desktop-link",
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<{ challenge?: unknown }>(req);
      return json(await auth(deps).issueDesktopLink(serviceContext(deps, req), body), 200);
    },
  },
  {
    // ── HALF TWO: THE CLAIM. UNAUTHENTICATED, because the code IS the credential ────────────
    //
    // `public`, so `withSession` never 401s here — the desktop install calling this holds
    // nothing yet, which is the whole reason it is calling. Its authority is a 128-bit
    // single-use value that expired two minutes after a step-up-cleared browser printed it.
    //
    // **It answers `{tokens}` and sets NO COOKIES.** That is the same shape the native branch
    // of `POST /auth/refresh` above answers with, and the omission is deliberate rather than
    // incidental: a `Set-Cookie` here would turn a code displayed on a screen into a browser
    // session on whatever origin fetched it, which is a strictly larger thing than the mail
    // client on one Mac. `AuthService.claimDesktopLink` returns the pair and no `user` for the
    // same reason — the claimant reads neither.
    //
    // Attempt-bound per IP inside the service (`reserveIpSlot`, 429), not by the lockout
    // counter: there is no account to lock before the code is read.
    //
    // `verifier` is the second field, and it is the reason a code may now travel over a URL
    // scheme rather than through a person's fingers: a code minted against a challenge is spent
    // only by a caller that can produce the value the challenge is the digest of. It stays
    // OPTIONAL — a code minted without a challenge is claimed exactly as before — and the two
    // refusals are one sentence, so a wrong verifier and an unknown code are indistinguishable
    // to whoever is asking.
    method: "POST",
    pattern: "/auth/desktop-claim",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ code?: unknown; verifier?: unknown }>(req);
      return json(await auth(deps).claimDesktopLink(serviceContext(deps, req), body), 200);
    },
  },
];
