import { and, eq, sql } from "drizzle-orm";
import { ImapDeadline, IMAP_META_DEADLINE_MS } from "@trafficflow/core/adapters/imap";
import { mailboxCredentials, mailboxes, organizerDisplayName } from "@trafficflow/db";
import {
  resolveSession, ServiceError, signedOutMidWrite, signedOutMetaOf, signedOutTransportMeta, dbFor,
} from "@trafficflow/services/mail";
import { makeImapProbe, makeSmtpProbe } from "@trafficflow/api/local";
import { SIGN_OUT_FENCE_WAIT_MS } from "./signout-fence.js";
// The exit from a stand-down, as a ceremony rather than a flag — the SAME function the
// `organize-here` CLI runs. See its header for why status, reason and the one-shot stamp move
// together, and this file's `handle` for why the desktop door needs a route onto it.
import { liveForeignHolder, requestOrganizerTakeover } from "./organize-here.js";
// What the seal door does after it keeps a change, per composition (a phone has no engine swap).
import { COMPOSITION_SEAL, hostChangeRefusal, sameLoginRefusal } from "./composition-passes.js";
/* The pairing check both engines serve; the phone's artifact takes `phone/cloud-probe.ts`. */
import { answerCloudProbe, CLOUD_PROBE_ROUTE } from "./cloud-probe.js";
import type { LeasePeekAnswer } from "@trafficflow/core/adapters/organizer-lease";
import { awaitFirstPage, firstPageDoorArmed, yieldsToFirstPage } from "./first-page-gate.js";
import { loadLocalRoster, resolveExpiredLaunchSession } from "./identity.js";
import { isEndedBearerExit, launchSessionExpiredResponse } from "./launch-bearer.js";
import type { CandidateClaim, DialAnswer, LocalMailboxRuntime } from "./roster.js";
// Removing a mailbox takes this install's copy of its mail with it. See `local-mirror.ts` for why
// this is the sidecar's job and not `MailboxService.delete`'s.
import { wipeLocalMirror } from "./local-mirror.js";
import { forgetStoreCopies } from "./store-copies.js";
import {
  handleWindowConsentReadFailure, handleWindowSearchPhases, handleWindowSyncFailure,
  WINDOW_CONSENT_READ_FAILED_ROUTE, WINDOW_SEARCH_PHASES_ROUTE, WINDOW_SYNC_FAILED_ROUTE,
} from "./window-report.js";
import { WINDOW_OUTBOX_ROUTE } from "./window-outbox.js";
import { SEARCH_INDEX_ROUTE } from "./search-index-door.js";
import { unboundOf } from "./store-binding.js";
import type { SidecarConfig } from "./engine-types.js";
import { releaseOwnClaim } from "./engine-local-services.js";
import { LOCAL_CONNECTIONS_LOG_EVERY_MS } from "./engine-reconnect.js";
import { BAKED_ENGINE_VERSION, discloseLocalSyncFailures, discloseProviderConfirms } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";

/**
 * The desktop's engine, one section: the request door: every local route the window's requests are matched against.
 */
export function requestDoorSection(scope: EngineScope, config: SidecarConfig): void {
      scope.handle = scope.laned(async (req, supersede) => {
        /* THE WINDOW'S BEARER IS RENEWED BEFORE ANY DOOR READS THE STORE (`launch-bearer.ts`), so
           a window left open does not expire under the person. Ended — its row revoked, or past
           its expiry with the store refusing the renewal — it is refused BY NAME on every route,
           as on the Cloud door, but the ways out (`ENDED_BEARER_EXITS`): sign-out's door asks its
           own question of an expired bearer below. A fault here (the clock) falls through to the
           pipeline, whose envelope answers and logs it. */
        const auth = req.headers.get("authorization") ?? "";
        const presented = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
        let refused = false;
        try {
          refused = presented !== "" && (await scope.session.decide(presented, scope.now())) === "refused";
        } catch { /* the pipeline below meets the same fault inside its envelope */ }
        if (refused && !isEndedBearerExit(req.method, new URL(req.url).pathname)) {
          return launchSessionExpiredResponse();
        }
        /* THE LIST BEFORE THE SCREENER'S COUNTS: those reads hold the store for seconds on a large
           mirror and the window asks them beside its first page (`yieldsToFirstPage`). Bounded by
           the drain's grace; the window's door only, never a paired device's. */
        if (firstPageDoorArmed() && yieldsToFirstPage(req.method, new URL(req.url).pathname)) {
          await awaitFirstPage();
        }
        /* THE WINDOW'S OWN PULL FAILURE, into this log. Its own door, ahead of the local-action
           chain: it carries no mailbox, writes nothing, and is authorised by the same launch
           bearer every local door reads. See `window-report.ts`. */
        if (req.method === "POST" && new URL(req.url).pathname === WINDOW_SYNC_FAILED_ROUTE) {
          return handleWindowSyncFailure(req, { authorized: scope.launchBearerAuthorized, log: scope.log });
        }
        if (req.method === "POST" && new URL(req.url).pathname === WINDOW_SEARCH_PHASES_ROUTE) {
          return handleWindowSearchPhases(req, { authorized: scope.launchBearerAuthorized, log: scope.log });
        }
        if (req.method === "POST" && new URL(req.url).pathname === WINDOW_CONSENT_READ_FAILED_ROUTE) {
          return handleWindowConsentReadFailure(req, { authorized: scope.launchBearerAuthorized, log: scope.log });
        }
        if (scope.windowOutbox && new URL(req.url).pathname === WINDOW_OUTBOX_ROUTE) return scope.windowOutbox.handle(req);
        // How far the local search index has got — the Mailboxes pane's progress arm.
        if (req.method === "GET" && new URL(req.url).pathname === SEARCH_INDEX_ROUTE) {
          return scope.searchIndexDoor(req);
        }
        // Two routes ahead of the shared table, and why they are not in it. `DELETE
        // /local/stored-login` (forget the password sealed on THIS machine) and `POST
        // /local/organizer/takeover` (make THIS install the organizer of its own mailbox row) are
        // facts about a local store `packages/api`'s hosted-shared table has no meaning for — the
        // hosted takeover is `POST /mailboxes/:id/takeover`, a different authority. Both carry the
        // per-launch bearer (`resolveSession`), added shell-side and never reaching the window, so
        // a page cannot compose them; the Cloud door (`cloud-engine.ts`) serves neither. On
        // `handle` ALONE, never `handleHost`/`handleLan`: those serve a PAIRED DEVICE, and both are
        // statements about THIS COMPUTER. The separation is structural — `desktopHostRoutes` has
        // never heard of these paths, so both network doors fall through to the static handler.
        const url = new URL(req.url);
        const localRemoveMatch = req.method === "DELETE"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})$/.exec(url.pathname)
          : null;
        /* `POST /local/mailboxes/:id/organize` — the first-run consent, on this door. The shared
         * `POST /mailboxes/:id/organize` is `stepUp: true`, which HERE is a permanent refusal: the
         * launch session's second-factor stamp is written once at boot (`identity.ts`), so
         * `withStepUp` refuses from five minutes after launch for the life of the process — and
         * this is the standalone install's only onboarding path. The authority is the per-launch
         * bearer (minted at boot, added shell-side, never reaching the window). `stepUpWindowMs` is
         * NOT widened: the fault is applying a second factor to a tier that has none. */
        const localOrganizeMatch = req.method === "POST"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})\/organize$/.exec(url.pathname)
          : null;
        /* `PATCH /local/mailboxes/:id` — sealing the mailbox password, on this door. The shared
         * `PATCH /mailboxes/:id` is `stepUp: true` (correctly — its body carries a password), but
         * the launch session's second-factor stamp is written ONCE at boot, so on this door it
         * refuses from five minutes after launch: a measured "recent two-factor authentication
         * required" on re-connect. It LOOKED like it worked because the first connect seals inside
         * that fresh-stamp window; only the re-connect met the refusal, so routing both here makes
         * the first's success structural. The SERVICE is `MailboxService.update` with the shared
         * route's probes — transport and authority, never a second credential write. */
        const localSealMatch = req.method === "PATCH"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})$/.exec(url.pathname)
          : null;
        /* `PATCH /local/mailboxes/:id/name` — the name this mailbox's letters carry, on this door.
         * The shared `PATCH /mailboxes/:id` is `stepUp: true`, which here refuses from five minutes
         * after launch, and its re-point detaches every runtime; a name is neither a credential nor
         * a server. `MailboxService.update` with `{ displayName }` alone: no probe, no re-point, no
         * claim. The authority is the per-launch bearer, on `handle` ALONE. */
        const localNameMatch = req.method === "PATCH"
          ? /^\/local\/mailboxes\/([0-9a-fA-F-]{36})\/name$/.exec(url.pathname)
          : null;
        /* `POST /local/mailboxes` — adding a mailbox, on this door. The shared `POST /mailboxes` is
         * not `stepUp: true`, but every other verb this flow needs is, and a door that could add a
         * mailbox but not seal, remove or organize it would be worse than one that could not add.
         * The authority is the per-launch bearer (minted at boot, added shell-side, never reaching
         * the window), as for all five. On `handle` ALONE: adding a mailbox to someone's computer is
         * a statement about THIS COMPUTER, and the separation is structural — `desktopHostRoutes`,
         * which the network doors route through, has never heard of this path. */
        const localAddMatch = req.method === "POST" && url.pathname === "/local/mailboxes";
        /* `POST /local/mailboxes/probe` — testing a connection, on this door. The shared
         * `POST /mailboxes/probe` is `stepUp: true` (its body carries a password), so on this door
         * it refuses from five minutes after boot (measured: the mail server's own refusal at 170 s,
         * `403 step_up_required` at 330 s). It used to be satisfiable only by accident — the connect
         * form was withheld once a mailbox existed — but Settings → Add mailbox makes the form
         * reachable any time with its primary disabled until a verdict, so without this route "Add
         * mailbox" is a dead end. The SERVICE is `MailboxService.probeConnection` with
         * `countFolders: true`; it writes NOTHING. The authority is the per-launch bearer, on
         * `handle` ALONE — a probe opens a socket to a host in its body. */
        const localProbeMatch = req.method === "POST" && url.pathname === "/local/mailboxes/probe";
        /* `POST /cloud/probe` — the pairing check, asked of the RUNNING engine by a desktop that has
         * a door, never of a second engine started beside it. The cloud engine's handler, mounted
         * here too (`cloud-probe.ts`): it dials the origin in the body and configures nothing. This
         * engine has no cloud base, so the no-origin arm refuses. On `handle` ALONE. */
        const localCloudProbeMatch = req.method === "POST" && url.pathname === CLOUD_PROBE_ROUTE;
        /* `GET /local/mailboxes/connections` — can this machine reach them right now. A third route
         * ahead of the shared table: it reports the liveness of sockets THIS PROCESS holds, which
         * the hosted service (mailboxes attached by a worker on a shard) has nothing to report, so
         * adding it there would be hosted surface invented for a desktop lifecycle. NOT a column: a
         * dead connection does not survive a restart, and recording it durably would make every
         * first boot after an outage report a connected mailbox as unreachable. On `handle` ALONE,
         * like its neighbours — whether THIS COMPUTER's socket is up is a question for the person at
         * it, and a phone's view of its host is the pairing layer's answer. */
        const localConnectionsMatch = req.method === "GET"
          && url.pathname === "/local/mailboxes/connections";
        /* `POST /local/mailboxes/connections/retry` — the shell heard the operating system say the
         * network is back. Every dead connection drops its automatic wait and re-dials now; a
         * live one, a refused sign-in and a refused certificate are left alone. Answers 202 with
         * how many dials it asked for. On `handle` ALONE, like the GET beside it. */
        const localRetryMatch = req.method === "POST"
          && url.pathname === "/local/mailboxes/connections/retry";
        /* `DELETE /local/stored-login` — signing out of this install, NAMED because one line
           below treats it apart from its neighbours: it is the only door here that opens on an
           expired launch bearer, since it is the way OUT of the state that expiry creates. */
        const localSignOutMatch = req.method === "DELETE" && url.pathname === "/local/stored-login";
        const localAction = localConnectionsMatch
          || localRetryMatch
          || localSignOutMatch
          || (req.method === "POST" && url.pathname === "/local/organizer/takeover")
          || localRemoveMatch !== null
          || localOrganizeMatch !== null
          || localSealMatch !== null
          || localNameMatch !== null
          || localProbeMatch
          || localCloudProbeMatch
          || localAddMatch;
        /* WHICH DOOR, as a pattern rather than a path — the shape `packages/api`'s own
           middleware logs (`route: route.pattern`). Two of these share a pattern and differ by
           method, which is why both fields ride every line. */
        const localActionRoute = localOrganizeMatch !== null
          ? "/local/mailboxes/:id/organize"
          : localNameMatch !== null
          ? "/local/mailboxes/:id/name"
          : localRemoveMatch !== null || localSealMatch !== null
            ? "/local/mailboxes/:id"
            : localProbeMatch
              ? "/local/mailboxes/probe"
              : localCloudProbeMatch
                ? CLOUD_PROBE_ROUTE
                : localAddMatch
                ? "/local/mailboxes"
                : localConnectionsMatch
                  ? "/local/mailboxes/connections"
                  : localRetryMatch
                  ? "/local/mailboxes/connections/retry"
                  : url.pathname === "/local/stored-login"
                    ? "/local/stored-login"
                    : "/local/organizer/takeover";
        /** The row id where the PATH carries one; "" where it does not. */
        const localActionMailboxId =
          (localRemoveMatch ?? localOrganizeMatch ?? localSealMatch ?? localNameMatch)?.[1] ?? "";
        if (localAction) {
          /* The receipt, before any branch. With only a verdict logged, "the press never reached
           * the door" and "the door took it and dropped it" leave identical evidence, so this sits
           * ABOVE the credential read — that read is the first branch, and its refusal answered in
           * silence. The route PATTERN, never the request's path; `mailboxId` is empty where the
           * path carries none, and for the takeover whose id is in an unread body. The connections
           * GET is excluded — Settings reads it four times a minute, and it needs a rate floor
           * rather than a receipt. */
          if (!localConnectionsMatch) {
            scope.log("local_action_received", {
              method: req.method,
              route: localActionRoute,
              mailboxId: localActionMailboxId,
              reason: "a local action door was asked to do something; the verdict for it is a " +
                "separate line, and its absence after this one means the door dropped the request",
            });
          }
          const header = req.headers.get("authorization");
          const token = header && /^Bearer\s+/i.test(header)
            ? header.replace(/^Bearer\s+/i, "").trim()
            : "";
          const live = token ? await resolveSession(scope.unbound, token, scope.now()) : null;
          /* ── THE WAY OUT OF A BROKEN SESSION MAY NOT DEPEND ON IT ─────────────────────────
           *
           * The launch bearer renews while it is used (`launch-bearer.ts`); a session that ended
           * anyway answers 401 on every route — SIGN OUT with them, which made the one action that
           * ends a broken session need the broken thing. So this asks the expiry question only for
           * the sign-out door, and only once the ordinary resolution has said no. Every other route
           * still refuses, and the credential is cleared on this path alone — never on a 401 from
           * anywhere else. See {@link resolveExpiredLaunchSession} for what stays required. */
          const staleLaunch = live === null && token !== ""
            ? await resolveExpiredLaunchSession(scope.db, token)
            : null;
          /* ADMITTED ON THE SIGN-OUT DOOR ALONE. Every other route reads `staleLaunch` only to
             SAY which refusal this is — see the 401 below, and the reason it is not one code. */
          const core = live ?? (localSignOutMatch ? staleLaunch : null);
          if (!core) {
            /* THE VERDICT FOR THE ONE REFUSAL EVERY DOOR HERE SHARES. Without it the receipt
               above is followed by nothing, which is the state it was added to end. */
            scope.log("local_action_refused", {
              method: req.method,
              route: localActionRoute,
              status: 401,
              reason: staleLaunch
                ? "this install's launch session has expired, so nothing was read or written. " +
                  "The bearer is this install's own and the clock is what refused it; the shell " +
                  "is told which refusal this is so a person is not left reading silence"
                : "the request carried no launch bearer this install recognises, so nothing " +
                  "was read or written",
            });
            /* TWO CODES, BECAUSE THEY ARE TWO STATES AND ONLY ONE OF THEM HAS A REMEDY. An
               unrecognised bearer is a request nobody here can place; an EXPIRED one is this
               install's own, and the surface that polls this route rendered its refusal as "Can't
               check the mail server right now" — a silence that reads as no new mail while the
               day-old session quietly refused every poll. Named, so the row can say what
               happened and what to press. */
            return staleLaunch
              ? launchSessionExpiredResponse()
              : new Response(
                JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }),
                { status: 401, headers: { "content-type": "application/json" } },
              );
          }
          if (staleLaunch && live === null) {
            scope.log("local_sign_out_on_expired_launch", {
              route: localActionRoute,
              reason: "this install's launch session had expired, so every route was answering " +
                "401 — signing out among them. The sign-out is performed on the expired bearer " +
                "rather than refused: the way out of a broken session never depends on it",
            });
          }
          if (localOrganizeMatch) {
              /* Agree and start organizing, with the window in the SAME write. The ceremony is
               * `requestOrganizerTakeover`'s and is not re-implemented here — transport and outcome.
               * What is new is that the screening answer travels with the consent:
               * `screening_baseline_at`, `dormancy_days` and `screening_scope` are written in the
               * same transaction as `organize_consented_at`, because the baseline is what the window
               * is measured from — written separately, there is a gap in which the cutoff is the
               * default. The account is the LAUNCH SESSION's, never a value from the body. */
            const mailboxId = localOrganizeMatch[1]!;
            let body: {
              intent?: unknown; screening?: { dormancyDays?: unknown; scope?: unknown }; screenBacklog?: unknown;
            } = {};
            try {
              body = (await req.json()) as typeof body;
            } catch {
              /* an absent or unparseable body is "no screening answer" — the claim-back shape */
            }
            // The dial arrives over JSON, so a string that looks like a number is a real shape.
            // It is NOT coerced: `requestOrganizerTakeover` refuses a non-integer, and coercing
            // here would turn a client bug into a silently different window.
            const raw = body.screening;
            const screening = raw
              ? {
                  ...(raw.dormancyDays === undefined
                    ? {}
                    : { dormancyDays: raw.dormancyDays as number }),
                  ...(raw.scope === undefined ? {} : { scope: raw.scope as "window" | "all_time" }),
                }
              : undefined;
            /* A TAKEOVER IS ASKED FOR BY NAME. Only "Organize here instead" sends `"takeover"`;
               anything else is a join, which yields to a live claim at the fence. The window
               ships with this engine and the phone's door forwards `"join"`, so nothing here
               relied on an absent verb meaning more. */
            const intent = body.intent === "takeover" ? "takeover" : "join";
            if (intent !== "takeover") {
              /* AND OVER A HOLDER THE ROW ALREADY SHOWS RENEWING, THE PRESS IS REFUSED, with the
                 holder named: setup has not asked the claim question yet. The phone door's 409. */
              const seen = await liveForeignHolder(scope.db, mailboxId, scope.installId).catch(() => null);
              let holder = seen?.answer === "held" ? seen.holder : null;
              /* THE ROW CANNOT SAY (not looked yet, or unreadable), SO THIS DOOR LOOKS, as the phone's
                 does and under the same ceiling. The phone's door has looked before this one. */
              if (holder === null && seen?.answer !== "free" && scope.organizerKind !== "mobile") {
                const rt = scope.runtimes.get(mailboxId);
                let looked: LeasePeekAnswer;
                try {
                  looked = rt === undefined
                    ? { answer: "unreadable", op: "no_lease_peek_io", cause: undefined }
                    : await ImapDeadline.in(IMAP_META_DEADLINE_MS, "read_deadline").race(rt.peekOrganizer());
                } catch (err) {
                  /* Captured: a look that threw or ran out of time is the unreadable answer below. */
                  looked = { answer: "unreadable", op: "list_claims", cause: err };
                }
                if (looked.answer === "unreadable") {
                  scope.log("local_mailbox_organize_refused", {
                    verdict: "unreadable",
                    op: looked.op,
                    reason: "the row does not say who organizes this mailbox and the claim folder could "
                      + "not be read in time, so nothing was written; the next press looks again",
                  });
                  return new Response(
                    JSON.stringify({
                      error: { code: "organizer_unreadable", message: "whether another install organizes this mailbox could not be read" },
                    }),
                    { status: 503, headers: { "content-type": "application/json" } },
                  );
                }
                if (looked.answer === "held" && looked.holder.installId !== scope.installId) {
                  holder = { name: organizerDisplayName(looked.holder.displayName) ?? "", kind: looked.holder.kind };
                  /* The engine's own look records the holder; it stays the only writer of those columns. */
                  void rt?.syncUntilQuiet(undefined, { force: true })
                    .catch(() => { /* the drain reports its own failures */ });
                }
              }
              if (holder !== null) {
                scope.log("local_mailbox_organize_refused", {
                  verdict: "held",
                  reason: "another install is renewing its claim and this press did not ask to take "
                    + "the mailbox over, so nothing was written; setup asks the claim question",
                });
                return new Response(
                  JSON.stringify({
                    error: { code: "organized_elsewhere", message: "another install is organizing this mailbox" },
                    holder,
                  }),
                  { status: 409, headers: { "content-type": "application/json" } },
                );
              }
            }
            try {
              const result = await requestOrganizerTakeover(scope.db, {
                mailboxId, now: scope.now(), accountId: core.accountId,
                intent,
                ...(screening ? { screening } : {}),
                // Only `true`: the press was made on a screen that stated the agree's rule.
                ...(body.screenBacklog === true ? { screenBacklog: true as const } : {}),
                // A settings doorbell that fails after the commit is named on this channel.
                log: scope.log,
              });
              scope.log("local_mailbox_organize_consented", {
                verdict: result.outcome,
                // The ANSWER, never the mailbox: this line is instrumentation about a ceremony,
                // and `ALLOWED_FIELDS` drops anything else anyway.
                reason: "a person agreed to let this machine organize this mailbox; the consent, "
                  + "the screening baseline and the window were written together, and the lease "
                  + "is still the authority",
              });
              /* THE CONSENT WAKES THE GATE. The stamp is spent by the next gated pass, which was the
                 next poll plus the first-page grace (~17 s measured); this asks now. The pass queues
                 behind a drain in flight, so the first sync still ends before any claim, and the
                 gate keeps refusing a handed-back mailbox. Fire-and-forget: the answer stays
                 immediate and the drain reports its own failures. */
              if (result.outcome === "authorized") {
                void scope.runtimes.get(mailboxId)?.syncUntilQuiet(undefined, { force: true })
                  .catch(() => { /* the drain reports its own failures; a press must not crash the host */ });
              }
              return new Response(
                JSON.stringify({ outcome: result.outcome, previousReason: result.previousReason }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            } catch (err) {
              // A refused screening answer is a 400 with the refusal's own sentence; a fenced
              // refusal answers its own status (410 `account_erased` — the consent write takes
              // the erasure fence like every server door); anything else is internal. Mapped by
              // hand because this handler sits AHEAD of the route table and therefore ahead of
              // `withErrorEnvelope`.
              const refused = (err as { name?: string }).name === "LocalConsentRefusal";
              scope.log("local_mailbox_organize_failed", { err });
              if (err instanceof ServiceError && !refused) {
                return new Response(
                  JSON.stringify({ error: { code: err.code, message: err.message } }),
                  { status: err.httpStatus, headers: { "content-type": "application/json" } },
                );
              }
              return new Response(
                JSON.stringify({
                  error: refused
                    ? { code: "validation_failed", message: (err as Error).message }
                    : { code: "internal", message: "internal error" },
                }),
                { status: refused ? 400 : 500, headers: { "content-type": "application/json" } },
              );
            }
          }
          if (localRetryMatch) {
            const all = scope.runtimes.all();
            const redialled = all.filter((r) => r.networkReturned()).length;
            scope.log("local_network_returned", {
              mailboxes: all.length, count: redialled,
              reason: "the shell reported that the network is back; `count` dead connections "
                + "dropped their re-dial wait and dialled now, and every other mailbox was left as it was",
            });
            return new Response(JSON.stringify({ redialled }), {
              status: 202, headers: { "content-type": "application/json" },
            });
          }
          if (localConnectionsMatch) {
            /* Instants as ISO strings, `null` while reachable — the shape every other lifecycle
               instant on this transport takes, so the shell parses it the same way. No mailbox
               address and no server name: which provider a person is on is the identifying
               signal this package keeps off the wire's diagnostics, and the row id is what
               correlates this with the list the pane already holds. */
            const items = scope.runtimes.all().map((r) => ({
              mailboxId: r.mailboxId,
              reachable: r.connection.reachable,
              unreachableSince: r.connection.unreachableSince?.toISOString() ?? null,
              signInRefused: r.connection.signInRefused,
              /* A SERVER ON THIS COMPUTER: whose refusal or silence the row is saying. */
              localServer: r.connection.localServer === true,
              signInWentQuiet: r.connection.signInWentQuiet === true,
              /* A PLAINTEXT SERVER OFF THE PERSON'S OWN NETWORK — nothing was dialled. */
              plaintextRefused: r.connection.plaintextRefused === true,
              /* NO PASSWORD FOR THIS MAILBOX ON THIS COMPUTER — a flat boolean, because there is
                 nothing else to say: no clock, no code, no server involved. A surface older than
                 the field reads an absent one as `false`, which is the state this install was in
                 before the field existed. */
              needsCredential: r.connection.needsCredential,
              /* NOTHING HAS DIALLED THIS RUNTIME YET — see the getter; absent reads as dialled. */
              dialled: r.connection.dialled,
              /* THE STORED-PASSWORD BLOCK, as the object it is — a state and whether a second
                 read confirmed it. Two flat fields would admit "confirmed" with nothing to be
                 confirmed about. No server name and no address, like every other field here. */
              credentialBlocked: r.connection.credentialBlocked,
              /* THE SETTINGS-DOCUMENT BLOCK, on the same reasoning and in the same shape: the
                 refusal's own code and whether it has been seen enough times to say. The code is
                 an identifier this build produces, never a server's text — nothing here carries
                 a message, a server name or an address. */
              profileBlocked: r.connection.profileBlocked,
              /* MESSAGES THIS DEVICE SET ASIDE, a count and nothing else; 0 when there are none. */
              setAside: r.connection.setAside ?? 0,
              /* WHAT THE LAST STOP LEFT IN THE SETTINGS DOCUMENT, and only the two a surface owes a
                 sentence (this computer's decisions are on this computer only). Absent otherwise,
                 and gone once this install claims the mailbox again. */
              ...(r.organizer.settingsLeft === "kept_other" || r.organizer.settingsLeft === "not_saved"
                ? { settingsLeft: r.organizer.settingsLeft } : {}),
            }));
            /* One line where this route answers, so a question that never arrived can be told
               from an answer that was refused — from the log's side those are the same absence.
               Counts only: no address, no server name. Change-or-once-a-minute, see
               {@link LOCAL_CONNECTIONS_LOG_EVERY_MS}. */
            const serving = items.filter((i) => i.reachable).length;
            const refused = items.filter((i) => i.signInRefused).length;
            const answeredLine = JSON.stringify({ mailboxes: items.length, serving, refused });
            const answeredAt = scope.now().getTime();
            if (answeredLine !== scope.connectionsAnsweredLine
              || answeredAt - scope.connectionsAnsweredAt >= LOCAL_CONNECTIONS_LOG_EVERY_MS) {
              scope.connectionsAnsweredLine = answeredLine;
              scope.connectionsAnsweredAt = answeredAt;
              scope.log("local_mailbox_connections_answered", {
                mailboxes: items.length, serving, refused,
                reason: "the Settings pane asked this install which of its mailboxes it can " +
                  "reach right now, and this is what it was told. A GAP in these lines while the " +
                  "pane is open means the question stopped arriving — the answer would have been " +
                  "logged either way",
              });
            }
            return new Response(JSON.stringify({ items }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          }
          if (localCloudProbeMatch) {
            return answerCloudProbe(req, {
              dataDir: config.dataDir,
              ...(config.operatorCaFile ? { operatorCaFile: config.operatorCaFile } : {}),
              ...(BAKED_ENGINE_VERSION ? { clientRelease: BAKED_ENGINE_VERSION } : {}),
              log: scope.log,
              configured: null,
            });
          }
          if (localProbeMatch) {
            /* THE PROBE, AND ONLY THE PROBE. `probeConnection` dials and answers; it takes no
               transaction and touches no table, so there is nothing to undo on a refusal and
               nothing to attach on success. The refusal shape is the shared route's verbatim —
               `mailbox_probe_failed` with its `details.reason` — because the window's own
               classifier (`localProbeReason`) reads exactly that taxonomy and the connect form
               already renders every member of it. */
            /* BOTH LEGS, because this door's connect dials both: the seal writes an `smtp`
               credential beside the `imap` one and refuses the whole mailbox when the submission
               server says no, so a test that asked only the incoming server reported a green
               over a connect that was about to fail, naming no field to correct. The prober is
               the pair the seal and the add already compose; a blank outgoing host is an answer
               the service gives back rather than a dial. */
            try {
              const body = (await req.json()) as Record<string, unknown>;
              const imap = (body.imap && typeof body.imap === "object" ? body.imap : {}) as
                Record<string, unknown>;
              const smtp = (body.smtp && typeof body.smtp === "object" ? body.smtp : {}) as
                Record<string, unknown>;
              const deps = scope.depsFor();
              const dto = await deps.services!.mailbox.probeConnection(
                {
                  db: dbFor(scope.db, core.accountId), accountId: core.accountId, userId: core.userId,
                  now: scope.now, requestId: "", sessionId: core.sessionId ?? null,
                },
                {
                  address: typeof body.address === "string" ? body.address : "",
                  /* FIELD BY FIELD, NEVER A SPREAD — the shared route's own rule, and it is
                     sharper here: this object reaches a function that opens a socket to a host
                     named in it, so spreading a caller-supplied object into it would let the
                     caller name fields this route never meant to expose. */
                  imap: {
                    host: typeof imap.host === "string" ? imap.host : "",
                    ...(typeof imap.port === "number" ? { port: imap.port } : {}),
                    ...(typeof imap.secure === "boolean" ? { secure: imap.secure } : {}),
                    ...(typeof imap.user === "string" ? { user: imap.user } : {}),
                    pass: typeof imap.pass === "string" ? imap.pass : "",
                    ...(imap.allowInsecure === true ? { allowInsecure: true } : {}),
                    // A certificate the person trusted for a server on this computer: a claim the probe re-reads.
                    ...(typeof imap.trustCertificate === "string" ? { trustCertificate: imap.trustCertificate } : {}),
                  },
                  /* The outgoing block by the same rule, and the password is deliberately not
                     read from it: one form, one identity, and the service falls back to the
                     incoming password exactly as `create` does. An absent block is a form with
                     nothing typed on the outgoing side. */
                  smtp: {
                    host: typeof smtp.host === "string" ? smtp.host : "",
                    ...(typeof smtp.port === "number" ? { port: smtp.port } : {}),
                    ...(typeof smtp.secure === "boolean" ? { secure: smtp.secure } : {}),
                    ...(typeof smtp.user === "string" ? { user: smtp.user } : {}),
                    ...(smtp.allowInsecure === true ? { allowInsecure: true } : {}),
                    ...(typeof smtp.trustCertificate === "string" ? { trustCertificate: smtp.trustCertificate } : {}),
                  },
                },
                {
                  probe: makeImapProbe(deps, { ...scope.probeOpts, countFolders: true }),
                  smtpProbe: makeSmtpProbe(deps, scope.smtpProbeOpts),
                },
              );
              return new Response(JSON.stringify(dto), {
                status: 200, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              const e = err as { code?: string; httpStatus?: number; message?: string; details?: unknown };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              scope.log("local_mailbox_probe_failed", { err });
              return new Response(
                JSON.stringify({
                  error: {
                    code: e.code ?? "internal",
                    message: status === 500 ? "internal error" : (e.message ?? ""),
                    /* THE DETAILS TRAVEL. `localProbeReason` reads `details.reason` to pick the
                       form's sentence, and `probeTlsSentence` reads `details.tls` to name the
                       host a certificate actually covers — dropping them would put the service's
                       generic line on screen while the answer sat unread in the same response,
                       which is the defect the door's own TLS branch was written to end. */
                    ...(status === 500 || e.details === undefined ? {} : { details: e.details }),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            }
          }
          if (localAddMatch) {
              /* The service is the shared one, with both probes. `MailboxService.create` writes the
               * row and credential in ONE transaction and refuses a password it could not log in
               * with, because the probes are injected — the same pair the shared `PATCH` and the
               * seal route inject. Anything less makes this a second door into `mailbox_credentials`,
               * storing a secret nothing has tried. The mailbox count is not gated here: the tier is
               * `UNMETERED` (the limit is the user's own disk), declared in `localServices`. The
               * account is the LAUNCH SESSION's, never a value from the body. */
            /* THE SIGN-OUT FENCE, read before anything is awaited — see the seal route above. The
               create dials too, so it holds the same window open. */
            const addWrite = scope.fence.begin();
            try {
              const body = (await req.json()) as Record<string, unknown>;
              const deps = scope.depsFor();
              const ctx = {
                db: dbFor(scope.db, core.accountId), accountId: core.accountId, userId: core.userId,
                now: scope.now, requestId: "", sessionId: core.sessionId ?? null,
              };

                /* The same-login refusal, ahead of the write. TWO ROWS ON ONE PHYSICAL MAILBOX is
                 * the one state this door must not reach. The address index forbids two live rows
                 * with the same ADDRESS, but a person reaches one mailbox under several (alias,
                 * plus-tag, bare login); what decides the same MAILBOX is the host/user pair the
                 * server answered to. It matters here because this install writes ONE claim per
                 * mailbox under its id, so two rows would write two claims with one id and the
                 * lease's clone defence would stand them down alternately for ever. Compared on what
                 * the probe PROVED (the create is the dial), and the row is removed on refusal so a
                 * 409 leaves the store as it found it. */
              const before = await scope.db
                .select({ id: mailboxes.id, meta: mailboxCredentials.meta })
                .from(mailboxCredentials)
                .innerJoin(mailboxes, eq(mailboxes.id, mailboxCredentials.mailboxId))
                .where(and(
                  eq(mailboxes.accountId, core.accountId),
                  sql`${mailboxes.status} <> 'disabled'`,
                  eq(mailboxCredentials.transport, "imap"),
                ));

              const dto = await scope.keepingIncoming(body, (b) => deps.services!.mailbox.create(
                ctx,
                b as never,
                { probe: makeImapProbe(deps, scope.probeOpts), smtpProbe: makeSmtpProbe(deps, scope.smtpProbeOpts) },
              ));

              if (addWrite.stale()) {
                /* THE SIGN-OUT FENCE, and here the undo is the whole mailbox rather than the
                   credential: this row did not exist when the person signed out, so leaving it
                   would add a mailbox to an install that had just been emptied. Through the same
                   shared service as the duplicate refusal below, for its reason — tombstone,
                   credential and appointments are one path. */
                try {
                  await deps.services!.mailbox.delete(ctx, dto.id);
                } catch (undoErr) {
                  scope.log("local_mailbox_add_undo_failed", {
                    err: undoErr,
                    reason: "a mailbox added while this install was signing out could not be "
                      + "removed again; removing it from the pane clears it",
                  });
                }
                scope.log("local_mailbox_seal_discarded", {
                  mailboxId: dto.id,
                  reason: "this install signed out while the password was being checked, so the "
                    + "mailbox the check added was removed again and nothing dials on it",
                });
                throw signedOutMidWrite();
              }

              const [proven] = await scope.db
                .select({ meta: mailboxCredentials.meta })
                .from(mailboxCredentials)
                .where(and(
                  eq(mailboxCredentials.mailboxId, dto.id),
                  eq(mailboxCredentials.transport, "imap"),
                ))
                .limit(1);
              const same = (a: unknown, b: unknown): boolean => {
                const host = (m: unknown): string =>
                  ((m as { host?: unknown })?.host as string ?? "").trim().toLowerCase();
                const user = (m: unknown): string =>
                  ((m as { user?: unknown })?.user as string ?? "").trim().toLowerCase();
                /* BOTH SIDES MUST SAY SOMETHING. A row that records neither host nor user cannot
                   be proved the same as anything, and treating "we do not know" as a match would
                   refuse a legitimate second mailbox on the strength of an absence. */
                return host(a) !== "" && user(a) !== "" && host(a) === host(b) && user(a) === user(b);
              };
              const clash = before.find((r) => same(proven?.meta, r.meta));
              if (clash) {
                /* Undo the write. The service committed a row and a credential; answering 409 and
                   leaving them would be a refusal that added a mailbox. Removed through the same
                   shared service, so the tombstone, credential and appointments are one path. The
                   proof comes AFTER the write because only a dial can say which mailbox a login
                   opens, and the create IS that dial — probing first then creating would dial the
                   server twice, and the per-address probe admission is two. It leaves a tombstone
                   for an address never connected: inert, meaning "removed, may be re-added", with no
                   mirror rows because nothing ever synced. */
                try {
                  await deps.services!.mailbox.delete(ctx, dto.id);
                } catch (undoErr) {
                  scope.log("local_mailbox_add_undo_failed", {
                    err: undoErr,
                    reason: "a mailbox this door refused as a duplicate of one already connected "
                      + "could not be removed again; it is left disconnected and removing it from "
                      + "the pane clears it",
                  });
                }
                scope.log("local_mailbox_add_refused", {
                  verdict: "same_login",
                  reason: "this login opens a mailbox this machine already holds; two rows over "
                    + "one mailbox would write two claims into it under one install identity and "
                    + "stand each other down in turn",
                });
                const sameLogin = sameLoginRefusal();
                return new Response(
                  JSON.stringify({ error: { code: sameLogin.code, message: sameLogin.message } }),
                  { status: sameLogin.httpStatus, headers: { "content-type": "application/json" } },
                );
              }

                /* And the engine beside the row. The shared service knows about ROWS; it has no idea
                 * that on THIS door a process must open a connection, hold a lease and run a poll
                 * timer for what it wrote. Attaching here makes the answer true — by the 201 the
                 * mailbox is running, so the pane's first poll finds a live row. NOT the seed (the
                 * seed is the configured address; this is another): no environment password, no
                 * process submission server, only the credential the probe proved. `start()` is not
                 * awaited — connect, folders and a first drain are minutes and the person waits on a
                 * form — and a failure leaves a connected row whose next poll retries. */
              /* THE ROW AS THE STORE HOLDS IT, not a hand-built one. A freshly created mailbox has
                 no stand-down and no stamp, so asserting nulls happens to be right today — and it
                 is the kind of right that stops being right the moment `create` grows a column.
                 Reading the roster is one indexed query and it cannot drift. */
              const freshRow = (await loadLocalRoster(scope.db, core.accountId)).find((r) => r.id === dto.id);
              /* THE ATTACH MAY NOT TURN A COMMITTED MAILBOX INTO A 500. `mailbox.create` has
                 already written the row and the credential; an attach that throws inside the same
                 `try` would answer "internal error" over a mailbox that exists, which is the store
                 changed by a request that reported failure — the opposite of what the 409 path is
                 careful about. A mailbox that could not be attached is a mailbox that starts at the
                 next launch, which is a state this door already has words for. */
              let attached: LocalMailboxRuntime | null = null;
              try {
                attached = await scope.attachLocal(
                  freshRow ?? {
                    id: dto.id, address: dto.address, displayName: dto.displayName ?? null,
                    standDownReason: null, takeoverAuthorizedAt: null, takeoverIntent: "join",
                  },
                   /* Never the seed — this was `isSeedRow(dto.address)` for one round, on the
                    * reasoning that an added mailbox cannot be the configured address because the
                    * same-login refusal would catch it. It is WRONG (`identity.ts` case 5): the
                    * refusal scans `status <> 'disabled'`, so a TOMBSTONED seed is invisible, and
                    * re-adding it made `isSeedRow` answer true for a just-proved row, after which the
                    * runtime dialled the stale `config.imap` and `credentialIsForeign` withheld the
                    * password. At boot the question is "which row does the settings file describe"
                    * (`isSeedRow`); here the row deliberately does not touch the settings file, so
                    * its proven credential is the only honest dial source. */
                  false,
                );
              } catch (attachErr) {
                scope.log("local_mailbox_attach_failed", {
                  err: attachErr,
                  reason: "this mailbox was added and its password stored, but it could not be "
                    + "started in this launch; it starts with the others the next time the app is "
                    + "opened, and nothing about it was left half-written",
                });
              }
              void attached?.start().catch((err: unknown) => {
                scope.log("mailbox_start_failed", { err });
              });
              scope.log("local_mailbox_added", {
                verdict: "added",
                reason: "a person connected another mailbox to this machine; its password was "
                  + "proved against its own server before anything was stored, and it is running "
                  + "with its own connection, poll timer and organizer claim",
              });
              return new Response(JSON.stringify(dto), {
                status: 201, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              const e = err as { code?: string; httpStatus?: number; message?: string; details?: unknown };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              scope.log("local_mailbox_add_failed", { err });
              return new Response(
                JSON.stringify({
                  error: {
                    code: e.code ?? "internal",
                    message: status === 500 ? "internal error" : (e.message ?? ""),
                    // As on the probe and seal routes: the form words the refusal and opens its consent from these.
                    ...(status === 500 || e.details === undefined ? {} : { details: e.details }),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            } finally {
              addWrite.settle();
            }
          }
          if (localNameMatch) {
            const mailboxId = localNameMatch[1]!;
            const refused = (status: number, code: string, message: string, reason: string): Response => {
              scope.log("local_action_refused", { method: req.method, route: localActionRoute, status, reason });
              return new Response(JSON.stringify({ error: { code, message } }), {
                status, headers: { "content-type": "application/json" },
              });
            };
            let raw: unknown;
            try {
              raw = ((await req.json()) as { displayName?: unknown } | null)?.displayName;
            } catch {
              /* An unreadable body names no name: refused as one below. */
              raw = undefined;
            }
            /* A control character (a CR or LF would end a header) or a name past the drafts' own
               100 is refused, never cut; blank stores none. */
            // eslint-disable-next-line no-control-regex
            if ((raw !== null && typeof raw !== "string") || (typeof raw === "string" && /[\u0000-\u001f\u007f-\u009f]/.test(raw))) {
              return refused(400, "validation_failed", "A name is one line of text.",
                "the name was not one line of text, so nothing was written");
            }
            const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
            if (Array.from(name).length > 100) {
              return refused(400, "validation_failed", "A name can hold up to 100 characters.",
                "the name was longer than a letter carries, so nothing was written");
            }
            try {
              const dto = await scope.depsFor().services!.mailbox.update(
                {
                  db: dbFor(scope.db, core.accountId), accountId: core.accountId, userId: core.userId,
                  now: scope.now, requestId: "", sessionId: core.sessionId ?? null,
                },
                mailboxId,
                { displayName: name === "" ? null : name },
              );
              scope.log("local_mailbox_name_written", {
                mailboxId,
                reason: "the name this mailbox's letters carry was changed on this install; the "
                  + "connection and the claim are untouched",
              });
              return new Response(JSON.stringify(dto), { status: 200, headers: { "content-type": "application/json" } });
            } catch (err) {
              if (!(err instanceof ServiceError)) throw err;
              return refused(err.httpStatus, err.code, err.message, "the mailbox service refused the name");
            }
          }
          if (localSealMatch) {
              /* Sealing the mailbox password, on the launch bearer. The SERVICE is
               * `MailboxService.update` and the PROBES are the shared `PATCH /mailboxes/:id`'s —
               * `makeImapProbe`/`makeSmtpProbe` over this request's deps, inheriting the deadline,
               * timeouts and IMAP admission counter. A password that cannot log in is refused HERE;
               * anything less makes this a second door into `mailbox_credentials`, storing a secret
               * nothing has tried. The account comes from the resolved launch session, never the
               * body. */
            const mailboxId = localSealMatch[1]!;
            /* THE SIGN-OUT FENCE. The probe below dials the server and commits afterwards, so a
               sign-out can run to completion inside this call — proving the row gone and
               answering — and this write then seals the password again. The epoch is read here,
               before anything is awaited; the verdict is taken after the write, because by then
               the row may already be committed and discarding it is the only honest undo. */
            const sealWrite = scope.fence.begin();
            try {
              const deps = scope.depsFor();
              const body = (await req.json()) as Record<string, unknown>;
              /* ONE PASSWORD, BOTH TRANSPORTS — and a caller RE-SUPPLYING one does not know this
                 mailbox's submission server. The door states both blocks itself and never reaches
                 this; without it a pass-only body leaves the `smtp` row on the OLD password and
                 sending breaks silently a fix away from the thing that was fixed. Only where a row
                 EXISTS: inventing a block refuses `smtp host is required` for a mailbox that sends
                 through nothing, and `keepingIncoming` is what covers a submission dial that says
                 no. */
              const incoming = (body.imap ?? {}) as Record<string, unknown>;
              /* BARE: no incoming row before this press — a signed-out mailbox, or the seed
                 before its first seal. Its password can still be stored, against the mailbox's
                 own server: the runtime's own configuration where it has one (the seed's), else
                 what the sign-out kept on the row, which the service merges under (mail 0127). */
              const [incomingRow] = await scope.db.select({ mailboxId: mailboxCredentials.mailboxId })
                .from(mailboxCredentials)
                .where(and(
                  eq(mailboxCredentials.mailboxId, mailboxId),
                  eq(mailboxCredentials.transport, "imap"),
                ))
                .limit(1);
              const bare = incomingRow === undefined;
              const passed = typeof incoming.pass === "string" && incoming.pass !== "";
              /* A PRESS THAT LEAVES THE SERVER TO THE ROW — Settings' "Sign in again". The door's
                 seal always names the host, and the engine it starts next is its launch. */
              const onTheRow = passed && incoming.host === undefined;
              const own = scope.runtimes.get(mailboxId)?.imap;
              if (bare && onTheRow && own && own.host !== "") {
                body.imap = {
                  host: own.host, port: own.port, secure: own.secure, user: own.auth.user, ...incoming,
                };
              }
              /* …AND WHERE NEITHER EXISTS: an earlier build's sign-out kept nothing of where this
                 mailbox lives (mail 0127 is newer than it). Refused BY NAME with what this install
                 still knows — the provider it was added as, the outgoing server and its login — so
                 the window can place the server from its provider table or ask for it once. */
              if (bare && onTheRow && (body.imap as Record<string, unknown>).host === undefined) {
                const [placed] = await scope.db.select({
                  provider: mailboxes.provider, status: mailboxes.status, kept: mailboxes.signedOutMeta,
                }).from(mailboxes)
                  .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, core.accountId)))
                  .limit(1);
                if (placed && placed.status !== "disabled"
                  && signedOutTransportMeta(placed.kept, "imap") === null) {
                  const leftover = await scope.db.select({
                    transport: mailboxCredentials.transport, meta: mailboxCredentials.meta,
                  }).from(mailboxCredentials)
                    .where(and(
                      eq(mailboxCredentials.mailboxId, mailboxId),
                      eq(mailboxCredentials.transport, "smtp"),
                    ));
                  const outgoing = signedOutMetaOf(leftover)?.smtp
                    ?? signedOutTransportMeta(placed.kept, "smtp");
                  scope.log("local_mailbox_server_unknown", {
                    mailboxId,
                    reason: "Sign in again was pressed on a mailbox an earlier version signed out, "
                      + "which kept no record of its incoming server; nothing was dialled or stored "
                      + "and the window is told what is still known so it can ask for the server",
                  });
                  return new Response(JSON.stringify({
                    error: {
                      code: "mailbox_server_unknown",
                      message: "This computer no longer knows this mailbox's incoming server. "
                        + "Enter it once to sign in again.",
                      details: {
                        provider: placed.provider,
                        login: outgoing?.user ?? null,
                        outgoingHost: outgoing?.host ?? null,
                      },
                    },
                  }), { status: 400, headers: { "content-type": "application/json" } });
                }
              }
              if (passed && body.smtp === undefined) {
                const [submission] = await scope.db.select({ mailboxId: mailboxCredentials.mailboxId })
                  .from(mailboxCredentials)
                  .where(and(
                    eq(mailboxCredentials.mailboxId, mailboxId),
                    eq(mailboxCredentials.transport, "smtp"),
                  ))
                  .limit(1);
                const [kept] = bare
                  ? await scope.db.select({ meta: mailboxes.signedOutMeta }).from(mailboxes)
                    .where(eq(mailboxes.id, mailboxId)).limit(1)
                  : [];
                if (submission || signedOutTransportMeta(kept?.meta, "smtp")) {
                  body.smtp = { pass: incoming.pass };
                }
              }
              /* WHAT THIS COMPOSITION'S SEAL DOOR DOES — `composition-passes.ts`. On a phone a refused
                 outgoing half refuses the whole change, so the working settings stay as they were. */
              const seal = COMPOSITION_SEAL[scope.organizerKind];
              /* A NEW INCOMING HOST OR LOGIN IS ANOTHER MAILBOX TO THE LEASE. Where no door replaces this
                 engine and this install holds the claim, the running runtime claims the new server
                 under its own nonce once the probe has proved it and before the row is kept
                 (`claimOnCandidate`); a holder there refuses the change and names it. Without a
                 password to dial the new server it is refused as before: stop organizing here, change
                 the server, start again. Not holding it, the change is kept and the mailbox re-points
                 below, with nothing to release. */
              const running = scope.runtimes.get(mailboxId);
              const differs = (said: unknown, held: string): boolean => typeof said === "string"
                && said.trim() !== "" && said.trim().toLowerCase() !== held.trim().toLowerCase();
              const hostMoves = !seal.doorReplacesEngine && running !== undefined
                && (differs(incoming.host, running.imap.host) || differs(incoming.user, running.imap.auth.user));
              const hostChangeRefused = (holder: { name: string; kind: string } | null): ServiceError => {
                scope.log("local_mailbox_host_change_refused", {
                  mailboxId, verdict: holder === null ? "refused" : "held",
                  reason: "the incoming server was changed on a mailbox this install organizes and could "
                    + "not be claimed there, so nothing was stored and the running claim stands",
                });
                return hostChangeRefusal(holder);
              };
              const claimsFirst = hostMoves && running.organizer.claimed;
              if (claimsFirst && passed !== true) throw hostChangeRefused(null);
              /* THE MOVE, once the probe has proved the new server: the claim is taken inside the
                 running runtime's queue, which stays held until the row is kept or not. */
              const move: { claim: Extract<CandidateClaim, { verdict: "organize" }> | null } = { claim: null };
              const imapProbe = makeImapProbe(deps, scope.probeOpts);
              const probe: typeof imapProbe = !claimsFirst ? imapProbe : async (input) => {
                const verdict = await imapProbe(input);
                if (verdict.verdict === "refuse" || move.claim !== null) return verdict;
                /* NO PASSWORD TO DIAL THE NEW SERVER WITH, so no claim: the move is refused, never kept unclaimed. */
                if (typeof input.imap.pass !== "string") throw hostChangeRefused(null);
                const proven = verdict.proven;
                const claim = await running.claimOnCandidate({
                  host: proven?.host ?? input.imap.host,
                  port: proven?.port ?? input.imap.port ?? 993,
                  secure: proven?.secure ?? input.imap.secure ?? true,
                  user: input.imap.user,
                  pass: input.imap.pass,
                  ...(proven?.insecure === true || input.imap.allowInsecure === true ? { allowInsecure: true } : {}),
                });
                if (claim.verdict === "refused") throw hostChangeRefused(claim.holder);
                move.claim = claim;
                return verdict;
              };
              const write = (b: Record<string, unknown>) => deps.services!.mailbox.update(
                {
                  db: dbFor(scope.db, core.accountId), accountId: core.accountId, userId: core.userId,
                  now: scope.now, requestId: "", sessionId: core.sessionId ?? null,
                },
                mailboxId,
                b as never,
                { probe, smtpProbe: makeSmtpProbe(deps, scope.smtpProbeOpts) },
              );
              let dto: Awaited<ReturnType<typeof write>>;
              try {
                dto = seal.outgoingMayStayUnsettled ? await scope.keepingIncoming(body, write) : await write(body);
                if (sealWrite.stale()) {
                  /* BEFORE THE RE-POINT, so a mailbox is never attached on a credential that is
                     about to be removed. Every transport of this mailbox, because the update writes
                     the incoming and submission rows together. */
                  await scope.discardCredentialsFor(mailboxId);
                  scope.log("local_mailbox_seal_discarded", {
                    mailboxId,
                    reason: "this install signed out while the password was being checked, so the "
                      + "credential the check stored was removed again and nothing dials on it",
                  });
                  throw signedOutMidWrite();
                }
              } catch (err) {
                /* NOT KEPT: the new server's claim goes back and the running claim stands. */
                await move.claim?.abandon();
                throw err;
              }
              await move.claim?.keep();
                /* And the running mailbox is re-pointed, not left for the next launch. "Takes effect
                 * on next launch" was tolerable for the SEED only because the shell replaces the
                 * engine (the next launch seconds away); there is no such gesture for mailbox two,
                 * so a person fixing its password would watch it stay broken until they quit. A
                 * detach and a fresh attach — not a live mutation, since the credential decides the
                 * connection, lease identity, cursors and sync bag, and re-pointing those under a
                 * mid-cycle poll is how two connections disagree. The SEED is left alone: its door
                 * already replaces the engine, and doing both tears down a mailbox a new one starts. */
              const live = scope.runtimes.get(mailboxId);
              /* THE LAUNCH THIS PRESS WAITS ON — a bare mailbox's runtime never dialled, and
                 nothing else will dial it on this launch. Answered below, outside the re-point's
                 catch: a refusal is the press's answer, never a logged failure. */
              let launched: { rt: LocalMailboxRuntime; answer: Promise<DialAnswer | null> } | null = null;
              /* A MOVE THE RUNTIME CLAIMED IS FOLLOWED IN PLACE (the arm below): a detach would release
                 the claim just taken, and the runtime that holds its nonce is the one to renew it. */
              if (live && (mailboxId !== scope.world.mailboxId || hostMoves) && move.claim === null) {
                try {
                   /* Detach first, then the attach may THROW. The login is closed and the timer
                      cleared, so the mailbox is not left with no runtime while the log claims it
                      still uses its connection. It matters because `DELETE /local/mailboxes/:id`
                      keys on the roster: a mailbox missing from it is removed WITHOUT releasing its
                      claim or wiping its mail — the phantom organizer and doubled mailbox, reached
                      through a failed password change. The old runtime cannot be revived (its
                      adapter is closed), so the roster entry is restored on failure and the next
                      launch re-attaches; what is lost is the poll until then. */
                  await live.detach("quit");
                  scope.runtimes.delete(mailboxId);
                  /* THE ROW AS IT NOW STANDS — a re-point must not erase this mailbox's own
                     stand-down memory or an outstanding takeover stamp. Asserting nulls here would
                     make re-entering a password an auto-resume for a mailbox somebody had taken
                     away from this machine. */
                  const repointed = (await loadLocalRoster(scope.db, core.accountId)).find((r) => r.id === dto.id);
                  const attached = await scope.attachLocal(
                    repointed ?? {
                      id: dto.id, address: dto.address, displayName: dto.displayName ?? null,
                      standDownReason: null, takeoverAuthorizedAt: null, takeoverIntent: "join",
                    },
                    /* NOT THE SEED, on the add route's reasoning above and one of its own: this
                       reattach follows a PATCH that has just proved a credential against the host
                       in its body, so that credential is what this runtime should dial. Handing it
                       `config.imap` instead would compare the just-proven host against the settings
                       file and withhold the password it was called to store. */
                    false,
                  );
                  if (bare) launched = { rt: attached, answer: attached.launch() };
                  else {
                    void attached.start().catch((startErr: unknown) => {
                      scope.log("mailbox_start_failed", { err: startErr });
                    });
                  }
                } catch (err) {
                  if (!scope.runtimes.has(mailboxId)) scope.runtimes.add(live);
                  scope.log("local_mailbox_reattach_failed", {
                    err,
                    reason: "the new password is stored and this mailbox uses it from the next "
                      + "launch; until then this mailbox is not polling, and it is kept on the "
                      + "roster so that removing it still releases its claim and takes its mail",
                  });
                }
              } else if (live) {
                /* THE RUNTIME THE RE-POINT EXCLUDES — the seed, and a one-mailbox install is one.
                   Its runtime is kept (the arm above says why) so the credential has to reach it
                   some other way: without this the row holds the new password while this runtime
                   dials the old, and `signInRefused` suspends the re-dial for ever. Its failure is
                   logged and not raised — the password IS stored, and answering 500 would tell
                   somebody the opposite of what the store now says. */
                try {
                  const followRow = !seal.doorReplacesEngine;
                  if (bare && onTheRow) {
                    launched = { rt: live, answer: live.credentialReplaced({ launch: true, followRow }) };
                  } else await live.credentialReplaced({ followRow });
                } catch (err) {
                  scope.log("local_mailbox_repoint_failed", {
                    err,
                    reason: "the new password is stored and this mailbox uses it from the next "
                      + "launch or the next re-dial; nothing was undone",
                  });
                }
              }
              if (launched) await scope.answerPressLaunch(mailboxId, launched.rt, launched.answer);
              return new Response(JSON.stringify(dto), {
                status: 200, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              /* The service's own honest sentence, mapped by hand because this handler sits
                 AHEAD of the route table and therefore ahead of `withErrorEnvelope`. The
                 message is the one the door renders beside the password field, so a 4xx must
                 carry it through rather than be flattened. */
              const e = err as { code?: string; httpStatus?: number; message?: string; details?: unknown };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              scope.log("local_mailbox_seal_failed", { err });
              /* A consent the person may give for one server on both legs: "Sign in again" names no
                 host, so the engine says whether the two it keeps for this mailbox are one. */
              const shared = (scope.consentableRefusal(e) || scope.trustableRefusal(e)) && await scope.pairSharesHost(mailboxId).catch(() => false);
              const details = shared ? { ...(e.details as object), sameHost: true } : e.details;
              return new Response(
                JSON.stringify({
                  error: {
                    code: e.code ?? "internal",
                    message: status === 500 ? "internal error" : (e.message ?? ""),
                    /* THE PROBE'S TRANSPORT AND REASON TRAVEL, as on the probe route: a phone
                       words the refusal from them and puts it on the field it is about. */
                    ...(status === 500 || details === undefined ? {} : { details }),
                  },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            } finally {
              /* ON EVERY EXIT — a sign-out waiting on this write is bounded by the wait, and an
                 exit that never settled would spend the whole of it and then be reported as a
                 store that could not be promised clean. */
              sealWrite.settle();
            }
          }
          if (localRemoveMatch) {
              /* Removing a mailbox on a standalone install. The shared `DELETE /mailboxes/:id` is
               * `stepUp: true`, which on this door is permanent: the launch session's stamp is
               * written once at boot, so `withStepUp` refuses from five minutes after launch (a
               * measured Remove button answering 403 for ever). `host-pair-routes.ts` names this
               * shape. What protects it instead is the per-launch bearer — minted at boot, added
               * shell-side, never reaching the window, uncomposable by a page. On `handle` ALONE
               * (structural via `desktopHostRoutes`): a phone must not remove a mailbox from a
               * computer. The SERVICE is `MailboxService.delete`, the hosted door's method. */
            const mailboxId = localRemoveMatch[1]!;
            try {
               /* ── THE PASS IN FLIGHT, WAITED OUT BEFORE ANYTHING IS WRITTEN ──────────────────
                * FIRST, ahead of the tombstone and the wipe, and that order is the fix. It used to
                * run LAST inside `detach()`: a pass parked in a server call resumed after the row
                * was tombstoned and the mail deleted, committed its messages into a mailbox that no
                * longer existed, and announced their arrival after the receipt that said it was
                * gone — mail left on the machine. Bounded by one drain interval, shared with
                * `detach()`; past that the pass's own writes are refused by `assertMailboxStillHere`.
                * The login is NOT closed here — the claim release below needs it. */
              await scope.runtimes.get(mailboxId)?.quiesce();
              /* EVERY EARLIER COPY OF THE STORE GOES BEFORE THE ROW: each still holds this mailbox's
                 mail and its sealed password. One that cannot be removed refuses the removal with
                 nothing removed, under the code a mirror that could not be cleared answers. */
              try {
                forgetStoreCopies(config.dataDir, "mailbox_removed", scope.log);
              } catch {
                throw Object.assign(
                  new Error("an earlier copy of this mailbox's mail could not be cleared from this computer"),
                  { code: "local_mirror_not_cleared", httpStatus: 503 },
                );
              }
              // The SHARED service, through the same `services` factory every other route on this
              // door resolves — never a second implementation of the tombstone, the credential
              // deletion or the appointment close. The context is the request's own: this install
              // serves exactly one account, and `core` is the launch session just resolved above.
              // `services` is optional on `ApiDeps` for hosts that mount a subset; THIS
              // composition always builds it (`localServices`, three lines into `depsFor`), so
              // the assertion is a statement about this door and not a hope.
              const out = await scope.depsFor().services!.mailbox.delete(
                {
                  db: dbFor(scope.db, core.accountId), accountId: core.accountId, userId: core.userId,
                  now: scope.now, requestId: "", sessionId: core.sessionId ?? null,
                },
                mailboxId,
              );
               /* And the engine beside the row, which the shared service cannot reach.
                * `MailboxService.delete` knows about ROWS; not that this door holds an open IMAP
                * login, renews an organizer claim each poll and serves the mirror — all three were
                * measured still running after a removal. ORDER: quiesce (above), wipe, release,
                * then stop — the wipe needs only the pass already finished, the release needs the
                * login the stop closes. The WIPE COMES BEFORE THE RELEASE because it is the store
                * half: it used to wait behind the release's eight or nine IMAP answers, so a close
                * soon after the press shut the store first and the removal answered 503 with the
                * mail left, its claim already given back. `assertMailboxStillHere` refuses any
                * commit that finishes into the removed mailbox. The RELEASE is best effort and
                * reported (`claimReleased`); the WIPE is not — a removal that left the mail here is
                * refused, because "it is gone" would be a false statement about the only copy the
                * person can see. */
               /* "If the roster holds it", not "if it is the one mailbox". This read
                * `if (mailboxId === world.mailboxId)`, the same statement while an install ran one
                * mailbox and a silent hole the moment it runs two: removing the SECOND matched
                * nothing, so its claim kept being renewed, its login stayed open and its mail stayed,
                * and re-adding the address served every message twice (the doubling `local-mirror.ts`
                * describes). The roster is the authority on what this install runs, so it is what the
                * question asks; each act uses THAT runtime's adapter, or a release would expunge from
                * the wrong mailbox. */
              const removed = scope.runtimes.get(mailboxId);
              /* ── A WIPE THAT DID NOT WIPE FAILS THE REMOVAL, AND THE RUNTIME AND ITS CLAIM STAY ──
               * This used to be caught and logged: the person was told the mailbox was gone while
               * its mail was still on this disk, and the log's own remedy — remove it again — could
               * not run, because the removal had already dropped the runtime the wipe needs. Thrown
               * instead, BEFORE the claim release, so nothing is given back for a removal that is
               * refused, `detach()` and the roster delete below are never reached, and a second
               * press comes back through this same wipe. The row is a tombstone by now and
               * `MailboxService.delete` is idempotent over one (`ownedRowOn` reads by id, not by
               * status), so the retry is the ordinary press.
               *
               * WITH OR WITHOUT A RUNTIME. It ran only inside `if (removed)`, and a tombstone has no
               * runtime from the next launch on (`loadLocalRoster` excludes it), so a removal cut
               * short by a close answered a later press 200 and left every message where it was.
               * The wipe needs only the store; it is idempotent, and the start finishes the same
               * leftovers on its own (`local_mirror_wipe_finished`). */
              try {
                await wipeLocalMirror(scope.db, { accountId: core.accountId, mailboxId });
              } catch (err) {
                scope.log("local_mirror_wipe_failed", {
                  err,
                  reason: "this install still holds the removed mailbox's mail, so the removal "
                    + "is refused rather than reported done; the mailbox keeps its runtime, its "
                    + "claim and its place on this install's roster, and removing it again runs "
                    + "this wipe, as the next start does",
                });
                throw Object.assign(
                  new Error("this mailbox's mail could not be cleared from this computer"),
                  { code: "local_mirror_not_cleared", httpStatus: 503 },
                );
              }
               /* Whether the claim is actually off the mailbox, carried out to the person. `false`
                * means one thing: a release was ATTEMPTED and could not complete, so this install's
                * claim may still stand in `ohmail/_meta`. The removal happened either way, but
                * "the mailbox is gone from this computer" and "nothing of ours is left holding it
                * against your other machine" are two statements — untold, the other install refuses
                * the mailbox for the staleness window, blaming a machine that no longer exists. A
                * mailbox with NO runtime in the roster is not this state (no login to expunge over),
                * so it reads `true`. */
              let claimReleased = true;
              if (removed) {
                const released = await releaseOwnClaim(
                  removed.adapter, scope.installId, mailboxId,
                  { current: removed.leaseNonce, minted: removed.leaseMintedNonces }, scope.log,
                  "the claim ages out of ohmail/_meta on its own; until it does, another "
                    + "install connecting this mailbox stands itself down against a claim "
                    + "nothing holds",
                );
                /* A sibling refusal fails the promise too (mail 0121): "nothing of ours is left
                   holding it" is false while a live claim carries this install's id, whichever
                   copy of this computer wrote it — the other machine will stand down against it. */
                if (released === null || released === "sibling") claimReleased = false;
                else if (released > 0) scope.log("organizer_claim_released", { mailboxId, claims: released });
                /* THE TIMER AND THE LOGIN — wipe, release, then stop, and the order is the whole
                   implementation: the release needs the login the stop closes, and the wipe needs
                   the poll not to be mid-cycle writing rows back in. This is one of the two paths
                   that still mean "stop syncing entirely" for a mailbox; a reader keeps its timer
                   because it still HAS a mailbox, and this one does not.

                   The STORE is untouched. `detach` closes what this mailbox holds and nothing
                   else, because the other mailboxes are still serving out of the same database —
                   which is exactly what the install's own `stop()` may not assume any more. */
                await removed.detach("quit");
                scope.runtimes.delete(mailboxId);
              }
              /* THE LINE SAYS WHICH OF THE TWO THINGS HAPPENED, because it used to say the one
                 that is not always true. "its organizer claim is released" was written flat, and
                 a release that could not look had just logged the opposite three lines above —
                 so the record of a removal asserted, in its own words, something the code beside
                 it had already reported failing. A log that contradicts itself in one request is
                 worse than a quiet one: it is the sentence an operator reaches for first. */
              scope.log("local_mailbox_removed", {
                verdict: "removed",
                reason: claimReleased
                  ? "a person removed this mailbox from this machine; its credentials are "
                    + "deleted, its pending appointments are closed, its organizer claim is "
                    + "released, this install's copy of its mail is deleted (its unsent drafts "
                    + "stay in Drafts here) and nothing was deleted from the mail server"
                  : "a person removed this mailbox from this machine; its credentials are "
                    + "deleted, its pending appointments are closed, this install's copy of its "
                    + "mail is deleted (its unsent drafts stay in Drafts here) and nothing was "
                    + "deleted from the mail server — but its "
                    + "organizer claim could not be taken out of ohmail/_meta, so the claim "
                    + "stands until it goes stale and another install connecting this mailbox "
                    + "waits that long before it may organize it",
              });
              /* `claimReleased` ON THE WIRE, because the shell is the only thing that can say it
                 to the person and it had no way to know. The removal is a 200 either way — that
                 is the promise this door makes and the reason the three acts above are best
                 effort — so the outcome cannot be carried by the status code. */
              return new Response(JSON.stringify({
                seq: out.seq === null ? null : String(out.seq),
                claimReleased,
              }), {
                status: 200, headers: { "content-type": "application/json" },
              });
            } catch (err) {
              /* THE HOLD COMES OFF FIRST. This route puts the mailbox on hold before it asks the
                 service to remove it, so a refusal here would otherwise leave a mailbox the person
                 still has with no poll timer and a stopped runtime, reporting itself reachable.
                 `unquiesce` takes back only a hold this request placed. */
              scope.runtimes.get(mailboxId)?.unquiesce();
              // The service's own honest sentence, mapped by hand because this handler sits
              // AHEAD of the route table and therefore ahead of `withErrorEnvelope`.
              const e = err as { code?: string; httpStatus?: number; message?: string };
              const status = typeof e.httpStatus === "number" ? e.httpStatus : 500;
              scope.log("local_mailbox_remove_failed", { err });
              return new Response(
                JSON.stringify({
                  error: { code: e.code ?? "internal", message: status === 500 ? "internal error" : (e.message ?? "") },
                }),
                { status, headers: { "content-type": "application/json" } },
              );
            }
          }
          if (req.method === "DELETE") {
            /* EVERY EARLIER COPY OF THE STORE GOES FIRST, before the fence: each holds the sealed
               passwords this sign-out removes, with the key beside it. One that cannot be removed
               refuses the sign-out whole: nothing was forgotten and no password was fenced. */
            try {
              forgetStoreCopies(config.dataDir, "signed_out", scope.log);
            } catch {
              return new Response(
                JSON.stringify({
                  error: {
                    code: "store_copy_not_removed",
                    message: "an earlier copy of your mail on this computer could not be removed, so "
                      + "you have not been signed out. Try signing out again.",
                  },
                }),
                { status: 503, headers: { "content-type": "application/json" } },
              );
            }
              /* Signing out forgets EVERY mailbox's password, not the first one's. This route is
               * the shell signing out of the local door, whose contract is that the credential is
               * the only thing on this machine a sign-out asks to be gone. Forgetting one would
               * leave the others' sealed passwords on the disk — worse, the seed accessor falls back
               * to the oldest live runtime when the configured address matches no row, so it could
               * delete a DIFFERENT mailbox's credential and report success. So every runtime forgets
               * its own; it answers true if ANY password was there, and a failure on one is not
               * swallowed — a half-happened sign-out must not report success. */
            /**
             * THE FENCE, BEFORE ANY STORE IS TOUCHED. Bumping first is what makes a writer that
             * starts from here on refuse; waiting is what makes the ones already out settle — and
             * discard what they wrote — before the read-backs below run, so the ordinary case
             * leaves nothing at all. `runtimes.all()` is read AFTER the wait for the same reason:
             * a mailbox the add route was in the middle of creating is on it by then.
             */
            /* WHAT THIS INSTALL HELD WHEN THE PRESS ARRIVED. `cleared` used to be read off the
               forgets alone, which the fence makes wrong: a write it overtakes discards its own
               row first, so every runtime then finds nothing and a real sign-out reported having
               removed nothing. The question the field answers is about the moment of the press. */
            const held = await scope.db.select({ mailboxId: mailboxCredentials.mailboxId })
              .from(mailboxCredentials).limit(1);
            /* THE FENCE GOES UP ON THE CALL, not on the await: `signOut` bumps the epoch before
               it yields, so every write that begins from here on reads the new one. The receipt
               is written between the two because the count it names is the set being waited for,
               and after the await that set is by definition the ones that did NOT settle. */
            const fencing = scope.fence.signOut(SIGN_OUT_FENCE_WAIT_MS);
            scope.log("stored_login_fence_raised", {
              route: localActionRoute,
              count: scope.fence.outstanding(),
              reason: "signing out: no password can be stored on this install from this moment, "
                + "and the passwords already being stored are waited for before the stores are "
                + "discarded",
            });
            const fenced = await fencing;
            const forgotten = await Promise.all(scope.runtimes.all().map((r) => r.forgetStoredLogin()));
            const cleared = held.length > 0 || forgotten.some(Boolean);
            if (fenced.unsettled > 0) {
              /* SAID, NOT SWALLOWED. Every store here was discarded, but a credential write that
                 was still out when the wait ran out can still commit, and this door cannot
                 promise what it has not seen settle. A non-2xx is what the shell already treats
                 as "you have NOT been signed out" on the local door, which is the true sentence:
                 pressing it again a moment later finds the writer settled and succeeds. */
              scope.log("local_action_refused", {
                method: req.method,
                route: localActionRoute,
                status: 503,
                reason: "a password was being stored while this install signed out and had not "
                  + "finished; every stored password was removed, and this answers a refusal "
                  + "rather than promise a store it could not watch settle",
              });
              return new Response(
                JSON.stringify({
                  error: {
                    code: "stored_login_not_fenced",
                    message: "a password was still being saved when you signed out, so this "
                      + "install cannot promise it is gone. Try signing out again.",
                  },
                }),
                { status: 503, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(JSON.stringify({ cleared }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          // "Organize from this machine", the route. The ceremony is `requestOrganizerTakeover`'s,
          // not re-implemented here — transport and outcome. It RECORDS a request; it does not
          // seize: the mailbox is still the authority (the next launch reads the lease first), so
          // this can be a button at all — it cannot produce two organizers, only a request to
          // become one. It leaves the row STOOD DOWN and writes only the stamp: marking the mailbox
          // `connected` would advertise one nothing is organizing, and `ScheduleService`/
          // `SendService` refuse only on `status = 'disabled'`, so they would accept sends for it.
          // Since Mail 0083 the stamp is spent on the next TICK, not the next launch: a demoted
          // install is a READER that keeps its login and poll timer, so the gate re-runs, reads the
          // stamp and promotes with no relaunch. The row must not claim organizing before the lease agrees.
          let body: { mailboxId?: unknown } = {};
          try {
            body = (await req.json()) as { mailboxId?: unknown };
          } catch {
            /* an absent or unparseable body is a missing mailboxId, answered below */
          }
          const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId.trim() : "";
          if (!mailboxId) {
            /* THE SECOND SILENT REFUSAL, and the one the takeover cell needed: a press that
               arrives without a mailbox is answered 400 and, before this line, recorded
               nowhere — which is indistinguishable in the log from a press that never arrived. */
            scope.log("local_action_refused", {
              method: req.method,
              route: localActionRoute,
              status: 400,
              reason: "the request named no mailbox, so no takeover was recorded",
            });
            return new Response(
              JSON.stringify({ error: { code: "invalid_request", message: "mailboxId is required" } }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          /* `"takeover"`, as the route's name says: this is the desktop's "take this mailbox back"
             button, the one verb the phone's door refuses to forward at all. */
          let result;
          try {
            result = await requestOrganizerTakeover(scope.db, {
              mailboxId, now: scope.now(), intent: "takeover", log: scope.log,
            });
          } catch (err) {
            /* The fenced refusal, answered here rather than escaping: the consent write inside
               takes the erasure fence, and this handler sits ahead of `withErrorEnvelope`, so an
               uncaught 410 would reach the window as a dead request. */
            if (!(err instanceof ServiceError)) throw err;
            return new Response(
              JSON.stringify({ error: { code: err.code, message: err.message } }),
              { status: err.httpStatus, headers: { "content-type": "application/json" } },
            );
          }
          scope.log("organizer_takeover_authorized", {
            // `verdict` and not `outcome`: `ALLOWED_FIELDS` carries the former, and a field the
            // census drops is an instrumented line that says nothing in production.
            verdict: result.outcome,
            disabledReason: result.previousReason,
            reason: "a person asked for this machine to organize this mailbox; the lease is " +
              "still the authority and is read on the next gated pass",
          });
          /* THE PRESS WAKES THE GATE, as the consent door's does: the next gated pass re-reads the
             stamp and the lease decides. Fire-and-forget; the drain reports its own failures. */
          if (result.outcome === "authorized") {
            void scope.runtimes.get(mailboxId)?.syncUntilQuiet(undefined, { force: true })
              .catch(() => { /* the drain reports its own failures; a press must not crash the host */ });
          }
          return new Response(
            JSON.stringify({ outcome: result.outcome, previousReason: result.previousReason }),
            {
              // 200 for every outcome, including the three that write nothing: they are ANSWERS
              // about the row, not refusals of the request, and the pane says a different
              // sentence for each. A 409 here would make "this machine already organizes that
              // mailbox" look like a failure to the person who pressed a button because they
              // thought it did not.
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        /* THE APP'S DOOR READS COMMITTED ROWS ONLY where a drain page can be open (PERF-026): the
           request's handle is then minted over that door to the store, bound to nothing as `depsFor`'s is. */
        const deps = { ...scope.depsFor(), ...(supersede ? { searchSupersede: supersede } : {}) };
        const answered = await scope.asPerson(req, () => scope.app.handle(req, scope.opened.routeDb ? { ...deps, db: unboundOf(scope.opened.routeDb) } : deps));
        scope.noteDoorWrite(req, answered);
        // The mailbox list carries this install's own settled sync verdicts — on `handle`
        // ALONE, like the local routes above: a paired device renders its own indicator and
        // the pairing layer answers for the host. See {@link discloseLocalSyncFailures}.
        if (req.method === "GET" && url.pathname === "/mailboxes") {
          return await discloseProviderConfirms(
            await discloseLocalSyncFailures(answered, scope.runtimes.all(), scope.now()), scope.runtimes.all(), scope.signatureCheck !== null);
        }
        return answered;
      });
}
