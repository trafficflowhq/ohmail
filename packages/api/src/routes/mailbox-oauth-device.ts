import { randomBytes } from "node:crypto";
import {
  requestDeviceCode, pollDeviceCodeOnce, deviceFlowAvailable,
  addressFromIdToken, oauthState, silentLogger,
  MS_AUTHORIZE_SCOPES, MS_DEVICE_ENV, DEVICE_CLIENT_KIND,
  SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_MS,
  OAuthConfigError, OAuthProviderUnavailableError,
  type FetchLike, type MicrosoftDeviceClient,
} from "@trafficflow/core";
import {
  createDeviceCeremony, readDeviceCeremony, leaseDeviceCeremonyPoll,
  noteDeviceCeremonySlowDown, claimDeviceCeremony, pruneDeviceCeremonies,
  MICROSOFT_PROVIDER,
} from "@trafficflow/db/cloud";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import type { ApiDeps } from "../deps.js";
import { makeImapProbe } from "../imap-probe.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { mailbox, readBody } from "./shared.js";

/**
 * The device-code door (RFC 8628) — how a non-hosted install connects a Microsoft 365 mailbox.
 * The redirect ceremony needs a per-deployment redirect URI; the device grant has none — this
 * server asks for a code, shows a short code and a URL, and the tokens come straight back. Two
 * routes (start mints; poll is one poll per request): a held request would hold a connection for
 * minutes and its death takes the only reference to the grant. Safe under ~180 polls: the
 * ceremony is read without being spent; the interval is enforced server-side atomically (the
 * client id is shared by every install); `slow_down` accumulates in the row. `deps.msDevice` is
 * read, `deps.msOAuth` never. Nothing prints the `device_code`, a token, or `error_description`.
 */

/**
 * The mailbox provider preset, server-side — the same values the redirect ceremony fixes, for the
 * same reason: the client does not get to name the IMAP or SMTP host for an oauth mailbox. The
 * provider is determined by the token issuer, so a host from the body would be an argument with
 * exactly one correct value, and a different one is an attempt to point the dialler somewhere on
 * the strength of a token that could not authenticate there. The scope host and the IMAP host
 * differ on purpose (`outlook.office.com` vs `outlook.office365.com`); the second is the legacy
 * alias IMAP answers on.
 */
const MS_MAILBOX_PRESET = {
  provider: "microsoft",
  imap: { host: "outlook.office365.com", port: 993, secure: true },
  smtp: { host: "smtp.office365.com", port: 587, secure: false },
} as const;

/**
 * `state` as it may appear in a request body, and NOTHING ELSE MAY.
 *
 * Ours, not Microsoft's: `oauthState(randomBytes)` emits 43 base64url characters, so this is the
 * exact shape and the bound is generous rather than tight. The value is a database predicate, so the
 * check buys a REFUSAL instead of a query on unbounded input — it is not what stops injection
 * (parameterisation is), the same split the redirect ceremony's own caps record.
 */
const URL_SAFE_STATE = /^[A-Za-z0-9._~-]{1,512}$/;

/** How this host reaches Microsoft. Injected in every test; Node's global otherwise. */
const tokenFetch = (deps: ApiDeps): FetchLike =>
  deps.oauthFetch ?? (globalThis.fetch as unknown as FetchLike);

/**
 * Is the device door armed — the one predicate, shared with the capability read. `GET
 * /mailboxes/oauth/microsoft/availability` publishes this as `device`, and both routes gate on
 * the identical expression, so a button can never be shown for a press that then 503s. It
 * collapses the registration to a boolean before anything leaves the process: the client id and
 * tenant never reach a browser. It lives in `packages/core` (`deviceFlowAvailable`) so the
 * availability handler can call it without importing this module — which would put the device
 * handlers into every composition that mounts the redirect ceremony.
 */
export function microsoftDeviceAvailable(client: MicrosoftDeviceClient | undefined): boolean {
  return deviceFlowAvailable(client);
}

/**
 * The refusal when this install has no public client.
 *
 * 503 and not 404: the surface EXISTS — this composition mounted it — and the operator has not
 * armed it, which is a different sentence from "there is no such route". The sentence names the
 * variable, because the person reading it is the one who can set it, and `gap` carries a closed-set
 * code so a client never re-derives the prose.
 */
const deviceUnconfigured = (): ServiceError => new ServiceError(
  "oauth_device_unconfigured", 503,
  `Connecting a Microsoft mailbox without an app registration is not set up on this server. `
  + `An operator has to set ${MS_DEVICE_ENV.clientId}.`,
  { gap: "device_client_missing" },
);

/**
 * The other way the door can be dark, and it needs its own sentence: `deviceFlowAvailable` is
 * false for no client id at all AND for a client id beside a tenant that could not be a tenant.
 * Reporting both as `device_client_missing` tells an operator who HAS set the client id to set
 * the client id — actively misleading. So the two are distinguished, and this one names the
 * variable that is wrong (`MS_DEVICE_TENANT`; the URL builders throw quoting `MS_OAUTH_TENANT`,
 * the confidential door's name, which is why this gate runs before anything reaches them).
 */
const deviceTenantInvalid = (): ServiceError => new ServiceError(
  "oauth_device_unconfigured", 503,
  `This server's Microsoft sign-in is configured with an unusable authority. `
  + `An operator has to correct ${MS_DEVICE_ENV.tenant} (or unset it, which means "common").`,
  { gap: "device_tenant_invalid" },
);

/**
 * Both refusals in one place, so the two routes cannot disagree about which is which.
 *
 * Returns the `ServiceError` to throw, or `null` when the door is armed. A function rather than two
 * inline checks per route because "which of these two gaps is it" is exactly the kind of question
 * that gets answered one way in `start` and another way in `poll`.
 */
function deviceGate(client: MicrosoftDeviceClient | undefined): ServiceError | null {
  if (!client || client.clientId.trim().length === 0) return deviceUnconfigured();
  if (!deviceFlowAvailable(client)) return deviceTenantInvalid();
  return null;
}

/** The three refusals a poll can make about the ceremony value itself. One sentence each. */
const ceremonyUnknown = (): ServiceError => new ServiceError(
  "oauth_device_state_invalid", 400,
  "That Microsoft sign-in is no longer in progress. Start again from Settings.",
  { reason: "state_invalid" },
);

export const mailboxDeviceOAuthRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/mailboxes/oauth/microsoft/device/start",
    relay: true,
    /**
     * `work`, the same class as `POST /mailboxes` and the redirect ceremony's start: what this
     * begins ends in a stored credential and a full sync of somebody's mailbox, so it refuses an
     * unverified account. No `stepUp`, on the redirect ceremony's argument verbatim: step-up
     * proves somebody is at the keyboard, and this ceremony proves it more strongly one step
     * later — the approval is an interactive Microsoft sign-in with that account's own MFA, and
     * the address comes from the token Microsoft issues. A stolen session gets a short code and
     * nothing else; if it finishes, what it attaches is the attacker's own mailbox.
     */
    cost: "work",
    handler: async (req, deps) => {
      const client = deps.msDevice;
      const gate = deviceGate(client);
      if (gate) throw gate;
      const cfg = client!;

      const ctx = serviceContext(deps, req);

      let grant;
      try {
        grant = await requestDeviceCode({
          tenant: cfg.tenant,
          clientId: cfg.clientId,
          /*
           * IDENTITY IS ASKED FOR EXPLICITLY, and this is the one place this flow's default is
           * deliberately overridden. `requestDeviceCode` defaults to the mail scopes alone, because
           * a headless caller should not have identity silently added to what a person is being
           * asked to approve. Here it is not silent and it is not optional: the mailbox address is
           * read from the `id_token` and the user never types it, so without `openid`/`email` the
           * ceremony completes, the tokens are valid, and there is no address to store — a failure
           * that reads as a Microsoft problem and is a scope list one line long.
           */
          scopes: MS_AUTHORIZE_SCOPES,
          fetch: tokenFetch(deps),
        }, () => deps.now().getTime());
      } catch (err) {
        throw deviceStartFailure(err, deps);
      }

      /*
       * OUR OWN HANDLE, not the `device_code`. The state travels in every poll body and sits in the
       * client's memory; the `device_code` is a bearer credential for the whole ceremony and stays
       * sealed in the row. Using the credential as the handle would put it in every poll request and
       * in whatever access log the operator's reverse proxy keeps.
       */
      const state = oauthState(randomBytes);
      const sealed = await deps.keyProvider.encrypt(grant.deviceCode);

      await createDeviceCeremony(deps.db, {
        state,
        accountId: ctx.accountId,
        provider: MICROSOFT_PROVIDER,
        deviceCodeEnc: sealed.ciphertext,
        deviceCodeKeyVersion: sealed.keyVersion,
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        pollIntervalMs: grant.intervalMs,
        grantExpiresAt: new Date(grant.expiresAtMs),
        now: deps.now(),
      });

      /* OPPORTUNISTIC PRUNE, failure swallowed: a ceremonies table that grew by one row is not a
       * reason to refuse somebody's connect. See `pruneDeviceCeremonies` for why this is not a cron. */
      await pruneDeviceCeremonies(deps.db, { now: deps.now() })
        .catch((err: unknown) => {
          (deps.logger ?? silentLogger).warn?.("oauth_device_prune_failed", { err: String(err) });
        });

      /*
       * WHAT GOES BACK: the two display values, the deadline, and the interval. NOT the device code
       * and not the client id. `expiresAt` is an ISO instant rather than a duration so a client that
       * was backgrounded for a minute renders a countdown that is still true.
       */
      return jsonResponse({
        state,
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        expiresAt: new Date(grant.expiresAtMs).toISOString(),
        intervalMs: grant.intervalMs,
      }, { status: 201 });
    },
  },
  {
    method: "POST",
    pattern: "/mailboxes/oauth/microsoft/device/poll",
    relay: true,
    /**
     * `work`, like `start`, and it is not merely inherited: this is the route that stores a
     * credential and starts a full sync, so an exempt class here would be the way around the gate
     * on `start`. The frozen route census over the hosted table does not see these two — they are
     * mounted only by the self-host composition — so the check that they are in the gated class is
     * an explicit assertion in this route's own suite rather than an arithmetic consequence
     * somewhere else.
     */
    cost: "work",
    handler: async (req, deps) => {
      const client = deps.msDevice;
      const gate = deviceGate(client);
      if (gate) throw gate;
      const cfg = client!;

      const ctx = serviceContext(deps, req);
      const body = await readBody<{ state?: unknown }>(req);
      const state = typeof body.state === "string" ? body.state : "";
      if (!URL_SAFE_STATE.test(state)) {
        throw new ServiceError("validation_failed", 400, "state is required", { reason: "state_invalid" });
      }

      // ── (1) THE NON-CONSUMING READ. Writes nothing. This is what makes polling possible. ────
      const found = await readDeviceCeremony(deps.db, { state, now: deps.now() });
      if (found.outcome === "unknown") throw ceremonyUnknown();

      // (2) The account match, before any decision and before any spend. The ceremony row is the
      // only thing that knows which account began the flow; the session is the only thing that
      // knows who is polling. A mailbox may only be attached to the account that asked. Note what
      // is NOT done: a cross-account poll does not claim the ceremony. The redirect flow burns a
      // stolen `state` because there the consume already happened and the value rides a URL
      // through a third party; this value never leaves this origin, and a claim on mismatch would
      // hand any authenticated account a way to kill another account's live ceremony by guessing
      // — one poll, no Microsoft round trip. The answer is a refusal, and the account's own ceremony
      // survives it.
      if (found.row.accountId !== ctx.accountId) {
        throw new ServiceError(
          "forbidden", 403,
          "That Microsoft sign-in was started by a different account.",
          { reason: "account_mismatch" },
        );
      }

      // ── (3) EXPIRY IS TERMINAL, SO IT CLAIMS. ───────────────────────────────────────────────
      //
      // Judged on the row's own `grant_expires_at` — Microsoft's `expires_in`, clamped and stored
      // absolute at mint time — so this answer costs no request. Claiming makes the aged-out state
      // dead for good rather than dead until a clock is nudged.
      if (found.outcome === "expired") {
        await claimDeviceCeremony(deps.db, { state, now: deps.now() });
        return jsonResponse({ status: "expired" }, { status: 200 });
      }
      const row = found.row;

      // ── (4) THE POLL SLOT. Atomic, and it is the shared client id's protection. ─────────────
      //
      // Denied means either too soon or a concurrent poll took the slot; both are "wait". The
      // client is told how long, and no request reaches Microsoft. A `retryAfterMs` derived from
      // the ROW's interval rather than from anything the caller sent is what makes a client that
      // ignores the cadence unable to do anything about it.
      const lease = await leaseDeviceCeremonyPoll(deps.db, { state, now: deps.now() });
      if (lease.outcome === "denied") {
        return jsonResponse({
          status: "pending",
          retryAfterMs: retryAfterFor(row, deps.now()),
          expiresAt: row.grantExpiresAt.toISOString(),
          userCode: row.userCode,
          verificationUri: row.verificationUri,
        }, { status: 200 });
      }

      // ── (5) ONE POLL. The device code is opened for this call only and never leaves it. ─────
      const deviceCode = await deps.keyProvider.decrypt(row.deviceCodeEnc, row.deviceCodeKeyVersion);

      let verdict;
      try {
        verdict = await pollDeviceCodeOnce({
          tenant: cfg.tenant,
          clientId: cfg.clientId,
          deviceCode,
          intervalMs: row.pollIntervalMs,
          fetch: tokenFetch(deps),
        }, () => deps.now().getTime());
      } catch (err) {
        /*
         * A THROW HERE IS NEVER A VERDICT ABOUT THE CEREMONY, so the ceremony is NOT claimed. The
         * token client returns the five normal states and throws only for "we could not ask" — a
         * 5xx, a network failure, an unparseable body, a malformed device code. Claiming on those
         * would turn one bad minute at Microsoft, or one flaky proxy hop, into a ceremony the
         * person has to restart; leaving it live means the next poll simply tries again, and the
         * grant's own expiry is still the bound.
         */
        throw devicePollFailure(err, deps);
      }

      switch (verdict.status) {
        case "pending":
          return jsonResponse({
            status: "pending",
            retryAfterMs: row.pollIntervalMs,
            expiresAt: row.grantExpiresAt.toISOString(),
            userCode: row.userCode,
            verificationUri: row.verificationUri,
          }, { status: 200 });

        case "slow_down": {
          /**
           * Not a terminal verdict — it claims nothing. The increment is applied in the database
           * (`LEAST(poll_interval_ms + step, ceiling)`) rather than computed here, because
           * computing here loses increments in the ordinary case: two polls one interval apart
           * both read the same interval, both are told `slow_down`, both write the same widened
           * value — two instructions producing one increase. RFC 8628 §3.5 requires the increase
           * to be cumulative, and the client id it protects is shared with every install using
           * the public registration. The step and ceiling are the token client's constants; what
           * comes back is what the row now holds.
           */
          const widened = await noteDeviceCeremonySlowDown(deps.db, {
            state, stepMs: SLOW_DOWN_STEP_MS, ceilingMs: MAX_POLL_INTERVAL_MS,
          });
          return jsonResponse({
            status: "pending",
            retryAfterMs: widened?.pollIntervalMs ?? verdict.nextIntervalMs,
            expiresAt: row.grantExpiresAt.toISOString(),
            userCode: row.userCode,
            verificationUri: row.verificationUri,
          }, { status: 200 });
        }

        case "declined":
        case "expired": {
          // Both terminal, both "start again", and neither is a fault. Claimed so the state cannot
          // be polled further, and answered as 200 rather than as an error: the person declined or
          // ran out of time, and nothing about this request failed.
          await claimDeviceCeremony(deps.db, { state, now: deps.now() });
          return jsonResponse({ status: verdict.status }, { status: 200 });
        }

        case "granted": {
          const tokens = verdict.tokens;

          /**
           * The claim, before the mailbox is written and after the tokens are in hand.
           * `claimDeviceCeremony` is the single-use UPDATE, so exactly one caller proceeds past
           * this line: two polls that both obtained tokens produce one winner, and the loser
           * discards what it holds — the same user's own tokens, never stored, never logged — and
           * is answered as an unknown ceremony. The other ordering (claim, then exchange) trades
           * that narrow race for a worse failure: a claim followed by a failed exchange leaves
           * somebody with a burnt ceremony and a Microsoft screen that said yes.
           */
          const claimed = await claimDeviceCeremony(deps.db, { state, now: deps.now() });
          if (claimed.outcome === "unknown") throw ceremonyUnknown();

          if (!tokens.refreshToken) {
            // No `offline_access` in the GRANTED scopes. The tokens are valid and useless: an
            // access token lasts an hour and there would be nothing to renew it with. Named as the
            // configuration fault it is, rather than stored to fail at teatime.
            throw new ServiceError(
              "oauth_no_refresh_token", 502,
              "Microsoft did not grant long-term access, so this mailbox cannot be kept in sync. "
              + "An operator has to add the offline_access permission to the app registration.",
              { reason: "no_refresh_token" },
            );
          }

          const address = addressFromIdToken(tokens.idToken);
          if (!address) {
            throw new ServiceError(
              "oauth_no_address", 502,
              "Microsoft did not say which mailbox was connected, so nothing was saved.",
              { reason: "no_address" },
            );
          }

          // PROBE, THEN STORE — the service owns that ordering, exactly as it does for a password.
          // A refused probe leaves an existing mailbox syncing on the credential it already has.
          const result = await mailbox(deps).connectOAuth(ctx, {
            provider: MS_MAILBOX_PRESET.provider,
            address,
            oauth: {
              provider: MICROSOFT_PROVIDER,
              tenant: cfg.tenant,
              /*
               * THE PROVENANCE, STORED WITH THE CREDENTIAL. This is the line that keeps the mailbox
               * alive past its first hour: a refresh token is bound to the client that obtained it,
               * and this one came from the PUBLIC registration. Without it the worker would renew
               * against the confidential client — which Microsoft refuses, and which
               * `refreshAccessToken` maps to "provider unavailable" precisely so a rejected client
               * is not blamed on the mailbox. The mailbox would stop receiving mail an hour after
               * being connected, with nothing quarantined and nothing paged.
               */
              clientKind: DEVICE_CLIENT_KIND,
              refreshToken: tokens.refreshToken,
              accessToken: tokens.accessToken,
              imap: MS_MAILBOX_PRESET.imap,
              smtp: MS_MAILBOX_PRESET.smtp,
            },
          }, { probe: makeImapProbe(deps) });

          return jsonResponse(
            { status: "granted", mailbox: result.mailbox, created: result.created },
            { status: result.created ? 201 : 200 },
          );
        }
      }
    },
  },
];

/**
 * When the NEXT poll is allowed, from the row's own facts.
 *
 * Derived rather than echoed: the client is told what the server will actually accept, so a client
 * that guesses is corrected instead of being silently denied. Floored at zero because a clock that
 * has moved past the due moment means "now", not a negative wait.
 */
function retryAfterFor(
  row: { lastPolledAt: Date | null; pollIntervalMs: number }, now: Date,
): number {
  if (!row.lastPolledAt) return 0;
  const due = row.lastPolledAt.getTime() + row.pollIntervalMs;
  return Math.max(0, due - now.getTime());
}

/**
 * `requestDeviceCode`'s failures, as sentences — and the split is the point.
 *
 * A 4xx from the device endpoint is almost always OUR registration: a client id that is not enabled
 * for public client flows is the classic one, and it is an operator fault rather than the user's. The
 * token client maps every one of them to `OAuthProviderUnavailableError` on purpose (there is no
 * credential yet, so nothing an auth verdict could be about), which means this host cannot tell an
 * outage from a bad registration and must not pretend to. The sentence therefore names both
 * possibilities honestly and the log carries the closed-set diagnostic.
 */
function deviceStartFailure(err: unknown, deps: ApiDeps): ServiceError {
  if (err instanceof OAuthConfigError) return deviceUnconfigured();
  if (err instanceof OAuthProviderUnavailableError) {
    (deps.logger ?? silentLogger).warn?.("oauth_device_start_failed", {
      // The class only. Never the message — it can carry Microsoft's own error codes and request
      // ids, and this line exists to be greppable, not to be a transcript.
      err: "provider_unavailable",
    });
    return new ServiceError(
      "upstream_unavailable", 503,
      "Microsoft could not be asked for a sign-in code. Either it is unreachable, or this server's "
      + "app registration does not allow public client flows.",
      { reason: "provider_unavailable" }, true,
    );
  }
  return new ServiceError(
    "upstream_unavailable", 503,
    "Microsoft could not be reached. Try again in a moment.",
    { reason: "provider_unavailable" }, true,
  );
}

/** The same split for a poll: retryable, and never a statement about the person's credential. */
function devicePollFailure(err: unknown, deps: ApiDeps): ServiceError {
  if (err instanceof OAuthConfigError) return deviceUnconfigured();
  (deps.logger ?? silentLogger).warn?.("oauth_device_poll_failed", {
    err: err instanceof OAuthProviderUnavailableError ? "provider_unavailable" : "unexpected",
  });
  return new ServiceError(
    "upstream_unavailable", 503,
    "Microsoft could not be reached to check that code. The sign-in is still valid — try again in a moment.",
    { reason: "provider_unavailable" }, true,
  );
}
