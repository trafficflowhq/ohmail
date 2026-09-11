import { silentLogger } from "@trafficflow/core";
import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth, enrollmentSession } from "./shared-cloud.js";
// The carved lifecycle pair — `/auth/logout` + `/auth/refresh` — spread back in below at their
// old positions, as the same objects. See `session-lifecycle.ts` for the carve.
import { sessionLifecycleRoutes } from "./session-lifecycle.js";

/** §2.2 — register, login, session, logout, refresh. */
export const coreRoutes: Route[] = [
  {
    // Two shapes; the split closed the account-existence oracle public registration used to be.
    // Invite path — 201 + an enrollment-scoped session (`tf_session`/`tf_csrf` for the browser,
    // `enrollmentToken` for native), with its 409 `email_taken` — a fact about a caller holding
    // an email-bound invite. Public path — a constant `202 {"status":"ok"}` with no cookies,
    // byte-identical for a fresh and a taken address. Load-bearing: the body is a fixed literal
    // (`mailed` on the wire is a limiter readout — the mistake `POST /waitlist` had to undo); no
    // `Set-Cookie` on either branch (a one-branch cookie is the oracle in a header); 202, not 201
    // — the durable effect may not have happened, and 201 would claim a creation this response
    // declines to confirm.
    method: "POST",
    pattern: "/auth/register",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      const body = await readBody<{ email: string; password: string; displayName: string; inviteCode: string }>(req);
      const result = await auth(deps).register(serviceContext(deps, req), body);
      if (result.status === "verification_pending") {
        // Observability, and it lives here because no service takes a logger — services return
        // facts and `packages/api` writes the line. A mail that fails to send is the one way this
        // endpoint leaves somebody with an account and no way to finish: the response is
        // constant, so the caller is told to check an inbox that will stay empty. It does not
        // fail the request — the login re-entry path plus the wizard's resend recovers it — but
        // it must not be silent, which is what `mailed` is for. No address in the line: a rate is
        // what an operator acts on, and an address would turn the platform log into a list of who
        // tried to sign up.
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
    // `POST /auth/verify-email {token, password}`. The continuation of a public signup. `public`:
    // the caller has no session by definition — the mail is what they have. Still a
    // two-credential call: the second credential is the account password, which is what stops a
    // mailed link alone from being a takeover primitive (the pre-hijack chain is written out in
    // `AuthService.verifyEmail`). The response mirrors `/auth/login`'s two shapes exactly,
    // because the decision is the same one: `enrollment` (and the session cookies) for a user
    // with zero enrolled factors, a bare `{status:"verified"}` for one who already has a factor —
    // a mailed link plus a password must not skip a second factor somebody deliberately added.
    method: "POST",
    pattern: "/auth/verify-email",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      const body = await readBody<{ token?: unknown; password?: unknown }>(req);
      const result = await auth(deps).verifyEmail(serviceContext(deps, req), body);
      return result.status === "enrollment" ? enrollmentSession(deps, result) : json(result, 200);
    },
  },
  {
    // `POST /auth/verify-email/resend`. Protected, and the recipient is the session's address
    // with no parameter for it: an endpoint that takes a recipient from an anonymous caller is a
    // mail bomb with an enumeration oracle attached. Not `enrollmentOk`: the enrollment surface
    // is deliberately narrow and sends no mail, and the wizard does not need it there — the
    // verify step sits after the factor and recovery-code steps, so the session holding it is
    // always full. The body is `{ok:true}` whatever happened — sent, rate-limited, or already
    // verified: a `MailSendResult` on the wire is a limiter readout, an oracle even for an
    // authenticated caller.
    method: "POST",
    pattern: "/auth/verify-email/resend",
    relay: true,
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
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
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
    relay: true,
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const result = await auth(deps).getSession(serviceContext(deps, req));
      return json(result, 200);
    },
  },
  // `/auth/logout` and `/auth/refresh` — CARVED into `session-lifecycle.ts` (Phase 3), spread
  // back in at their old positions as the SAME route objects. What a session is once it exists
  // is machinery every composition shares, and the desktop-host door mounts exactly these two
  // without the ceremony around them; the handlers, the cookie branches and the surfaces are
  // unchanged line for line — see that module's header for the carve's argument.
  ...sessionLifecycleRoutes,
  {
    // Handing a session to the desktop app, half one: the mint. The desktop's hosted door takes a
    // password typed into a native window, where nobody can check an address bar; this pair is
    // the alternative — the browser, where the session exists and the URL is visible, mints a
    // one-use code the app exchanges. `ceremony`: identity lifecycle, one row, no mailbox, no
    // model, no socket. `stepUp: true`, the mirror of the revoke's gate: this adds a device
    // holding a refresh token for `nativeRefreshTtlMs` — a rolling four-hundred-day native
    // credential — so a merely-left-open session must not grow one; it also makes the claimed
    // session's `lastTwofaAt` honest. The body carries at most `challenge`, the public half of a
    // PKCE pair: present ⇒ the code is spendable only by a caller producing the verifier (safe to
    // hand over a URL scheme); absent ⇒ retypable as always; malformed ⇒ refused, never ignored.
    method: "POST",
    pattern: "/auth/desktop-link",
    relay: false,  /* mints the hosted hand-off code */
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<{ challenge?: unknown }>(req);
      return json(await auth(deps).issueDesktopLink(serviceContext(deps, req), body), 200);
    },
  },
  {
    // Half two: the claim. Unauthenticated, because the code is the credential — the desktop
    // install calling this holds nothing yet; its authority is a 128-bit single-use value that
    // expired two minutes after a step-up-cleared browser printed it. It answers `{tokens}` and
    // sets no cookies: a `Set-Cookie` here would turn a code displayed on a screen into a browser
    // session on whatever origin fetched it (`AuthService.claimDesktopLink` returns no `user` for
    // the same reason). Attempt-bound per IP inside the service (`reserveIpSlot`, 429) — there is
    // no account to lock before the code is read. `verifier` is optional: a code minted against a
    // challenge is spent only by a caller that can produce the value, and a wrong verifier and an
    // unknown code answer the same sentence.
    method: "POST",
    pattern: "/auth/desktop-claim",
    relay: false,  /* carries the hosted hand-off code */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      // `kind` is the claimant's own platform declaration (desktop-linux/-macos/-windows, or
      // the legacy "macos" — also the default when absent, which is what every shipped desktop
      // sends). Whitelist-gated in the service BEFORE the ip slot and the burn.
      const body = await readBody<{ code?: unknown; verifier?: unknown; kind?: unknown }>(req);
      return json(await auth(deps).claimDesktopLink(serviceContext(deps, req), body), 200);
    },
  },
];
