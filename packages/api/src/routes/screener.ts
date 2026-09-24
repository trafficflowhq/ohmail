import {
  ServiceError, dismissHeldRelease, heldReleaseSummary, releaseHeld, HELD_RELEASE_GROUPS_MAX,
  screenUnscreened, unscreenedSummary, OHBOX_UNSCREENED_GROUPS_MAX,
  type ScreenBody,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import {
  listJunk, junkBody, rescueJunk, searchJunk, junkSweepPreview, requestJunkSweep,
} from "../junk-window.js";
import type { Route } from "../router.js";
import { screener, readBody } from "./shared.js";
import { pagingNumber } from "../query-bounds.js";

/**
 * The flagship Screener. `GET /screener` is the derived first-contact queue (one entry per held
 * sender). `POST /screener/:id` decides yes/no: promotes a rule, re-routes the held mail by
 * writing desired `folder_state` + changes, feeds the learning loop; idempotent — the service
 * writes the row in its decide tx, so a replay never re-creates the rule. No IMAP: the service is
 * built without an adapter, so the physical move defers to the worker. The GET spends nothing,
 * and that is load-bearing: it used to call the model once per held sender — up to 200 calls on
 * one `read` request, re-fetched per poll and scroll. Generation lives at `POST
 * /screener/suggest`; the read returns what is stored.
 */
/**
 * The wire shape of `POST /screener/suggest`, declared HERE rather than imported.
 *
 * The service package's public barrel does not re-export `ScreenerSuggestBody` — that one line
 * is still owed — and this is the shape the route accepts either way: both fields are `unknown`
 * because the service validates them, and a route that pre-narrowed them would be a second,
 * weaker copy of the rule that refuses an absent sender set.
 */
interface SuggestBody { senders?: unknown; dryRun?: unknown }

export const screenerRoutes: Route[] = [
  {
    /**
     * MAIL HELD AT THE GATE BEHIND A RULE ITS OWNER ALREADY WROTE — the groups, and the count
     * beside each one. A read: it spends nothing, opens no mailbox and changes no row.
     *
     * NO STEP-UP, on either door. Nothing here names a credential or a destination the caller
     * did not already choose — the answer is a summary of their own rules over their own held
     * mail — and the local twin comes for free, because `localRoutes` spreads this table whole.
     */
    method: "GET",
    pattern: "/screener/held-releases",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const { groups, total, fingerprint, dismissed } = await heldReleaseSummary(ctx.db, ctx.accountId);
      // `total` is DISTINCT messages and never the sum of the group counts — a domain rule and a
      // sender rule inside it both claim the same mail, honestly, and adding them up would tell a
      // person they hold more than they do. `max` travels so the client learns the ceiling by
      // READING it rather than carrying a constant of its own that drifts — `GET /screener`'s
      // `maxPerRequest` argument. `fingerprint` is this set's identity (what a dismissal names)
      // and `dismissed` whether the account already said "not now" to exactly this set.
      return jsonResponse({ groups, total, max: HELD_RELEASE_GROUPS_MAX, fingerprint, dismissed });
    },
  },
  {
    /**
     * "NOT NOW" — the offer's dismissal, persisted per account so it holds on every device and
     * every session until the SET changes (new held mail from a decided sender is a new offer).
     * The body's `fingerprint` is the one the read above answered, so a set that moved between
     * the read and the press stays offered. Same door rule as the read: nothing here names a
     * credential or moves mail.
     */
    method: "POST",
    pattern: "/screener/held-releases/dismiss",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ fingerprint?: unknown }>(req);
      return jsonResponse(await dismissHeldRelease(ctx, { fingerprint: body.fingerprint }));
    },
  },
  {
    /**
     * THE PRESS. Releases the named groups — or every group when `ruleIds` is absent — by
     * recording your consent on each rule and re-opening its backlog. It files nothing
     * itself: `rule-retro` decides with the rule engine and the reconciler moves the mail.
     *
     * Idempotent by the predicate rather than by a key: a released rule is in flight and is no
     * longer a group, so a replay releases nothing and says so. Same door rule as the read above.
     */
    method: "POST",
    pattern: "/screener/held-releases",
    relay: true,
    cost: "work",
    replay: "guarded",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ ruleIds?: unknown }>(req);
      // Left `unknown` to the service on purpose: the service refuses a non-array, a non-string
      // member and more than `HELD_RELEASE_GROUPS_MAX` ids, and a route that pre-narrowed them
      // would be a second, weaker copy of that rule.
      const result = await releaseHeld(ctx, {
        ruleIds: body.ruleIds as readonly string[] | undefined,
      });
      return jsonResponse(result);
    },
  },
  {
    /**
     * OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — the sender groups and the count beside
     * each one. A read: it spends nothing, opens no mailbox and moves no row.
     *
     * NO STEP-UP, on either door, for the held-release pair's reason: the answer is a summary of
     * the caller's own Ohbox against their own rules, and the local twin comes for free because
     * `localRoutes` spreads this table whole.
     */
    method: "GET",
    pattern: "/screener/unscreened",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const { groups, total } = await unscreenedSummary(ctx.db, ctx.accountId);
      // `total` is the SHOWN groups' messages: every message has one sender, so a list cut at the
      // bound must not report the mail behind the cut as offered. `max` travels so a client learns
      // the ceiling by READING it rather than carrying a constant of its own that drifts.
      return jsonResponse({ groups, total, max: OHBOX_UNSCREENED_GROUPS_MAX });
    },
  },
  {
    /**
     * THE PRESS. Sends the named sender groups — or every group shown, when `addresses` is absent
     * — to the Screener, through the door a fresh arrival takes. It writes the intent and the
     * delta and opens no mailbox: the organizer's reconciler performs the physical move.
     *
     * Idempotent by the predicate rather than by a key: a moved row is desired into the Screener
     * and is no longer a candidate, so a replay moves nothing and says so.
     */
    method: "POST",
    pattern: "/screener/unscreened",
    relay: true,
    cost: "work",
    replay: "guarded",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ addresses?: unknown }>(req);
      // Left `unknown` to the service on purpose: it refuses a non-array, a non-string member, an
      // over-long address and more than `OHBOX_UNSCREENED_GROUPS_MAX` of them, and a route that
      // pre-narrowed them would be a second, weaker copy of that rule.
      return jsonResponse(await screenUnscreened(ctx, {
        addresses: body.addresses as readonly string[] | undefined,
      }));
    },
  },
  {
    method: "GET",
    pattern: "/screener",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = pagingNumber(url.searchParams.get("limit"));
      const page = await screener(deps).list(serviceContext(deps, req), { cursor, limit });
      // `suggestable` is the set a control may offer — `{ senders, maxPerRequest, … }`, and no
      // price: the figure a person consents to is the dry run's `quotedCredits` over that set.
      //
      // `pendingDecisions` is the OTHER half of the same idea (0.14.1): a sender this install has
      // decided on but whose organizer has not applied it yet is already GONE from `items` — the
      // service excludes them, so a queue that simply rendered `items` would show the press
      // working and say nothing about what happened next. The client needs the excluded set BY
      // NAME to say "waiting for <holder>" rather than leaving a row it just removed unexplained.
      // Dropping it here is how the exclusion becomes a disappearance, which is why this field is
      // on the wire before any client reads it.
      return jsonResponse({
        items: page.items, nextCursor: page.nextCursor, suggestable: page.suggestable,
        pendingDecisions: page.pendingDecisions,
      });
    },
  },
  {
    /**
     * Buy AI suggestions for an explicit set of senders. `cost: "work"`, which is the point of
     * the row: this is the only screener path that reaches a model, so it is the one an
     * unverified account cannot reach and the one the spend census counts (`POST /screener/:id`
     * is `work` because it writes; `GET /screener` stays `read`). It sits before `/screener/:id`
     * for readability only — a static segment outranks a param, so `/screener/suggest` wins
     * whatever the order. `idempotent: true` because this is a purchase: a retry after a lost
     * response must replay the answer rather than buy again; the service claims the key itself
     * (see `ScreenerService.suggest`).
     */
    method: "POST",
    pattern: "/screener/suggest",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<SuggestBody>(req);
      const result = await screener(deps).suggest(serviceContext(deps, req), body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(result);
    },
  },
  /**
   * The junk window (§16.2). The two READS are `connection`: each opens an IMAP socket to the
   * user's own provider (through the admission-capped `openMailboxImap`), and an unverified
   * account must not make this service dial. The two COMMANDS — the rescue and the sweep — are
   * `work`: they record what the person asked for and the organizer executes it, because the API
   * never opens IMAP to apply organization. All gated on the folders flag (409 off). The window
   * never writes mirror rows (`junk-window.test.ts` counts the tables).
   * Static-beats-param: `/screener/junk` outranks `/screener/:id`.
   */
  {
    method: "GET",
    pattern: "/screener/junk",
    relay: true,
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
      return jsonResponse(await listJunk(deps, ctx.accountId, { cursor }));
    },
  },
  {
    // Body-on-open: live fetch, parsed to TEXT (junk renders no HTML — no remote content, no
    // markup, no tracker), bounded by `JUNK_BODY_MAX_BYTES`, never persisted. The client keeps
    // its own session cache; this route re-reads the folder every time it is asked.
    method: "GET",
    pattern: "/screener/junk/body",
    relay: true,
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const url = new URL(req.url);
      const mailboxId = url.searchParams.get("mailboxId") ?? "";
      const uid = Number(url.searchParams.get("uid"));
      // The row's epoch, REQUIRED: a UID names a message only within one UIDVALIDITY, and a
      // renumbered folder must answer 410 — never the body of whatever now wears the number.
      const uidValidity = url.searchParams.get("uidValidity") ?? "";
      if (!mailboxId || !Number.isInteger(uid) || uid <= 0 || !uidValidity) {
        throw new ServiceError("validation_failed", 400, "mailboxId, a positive integer uid and uidValidity are required");
      }
      return jsonResponse(await junkBody(deps, ctx.accountId, { mailboxId, uid, uidValidity }));
    },
  },
  {
    // The search-append (§16.2's table): one server-side SEARCH per junk folder, behind the
    // same read budget as the list, the newest hits merged. The client asks only after its own
    // filter over the loaded window came up empty, so the first paint never waits on this.
    method: "GET",
    pattern: "/screener/junk/search",
    relay: true,
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const q = new URL(req.url).searchParams.get("q") ?? "";
      return jsonResponse(await searchJunk(deps, ctx.accountId, q));
    },
  },
  {
    // The one-time sweep offer's DRY RUN (§16.1): how much still sits in ohmail/Quarantine
    // per mailbox, whether it can move, whether a press is queued. Database only — `read`, not
    // `connection`, because nothing here dials.
    method: "GET",
    pattern: "/screener/junk/sweep",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      return jsonResponse(await junkSweepPreview(deps, ctx.accountId));
    },
  },
  {
    // The PRESS: records the command (`junk_sweep_requested_at`, mail 0076) for the worker to
    // execute under the lease. `work` — it writes on the user's account — and NO IMAP here: the
    // sweep is a bulk act over mirrored rows, which is the organization the API never applies
    // itself (junk-window.ts' header draws the line).
    method: "POST",
    pattern: "/screener/junk/sweep",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      return jsonResponse(await requestJunkSweep(deps, ctx));
    },
  },
  {
    // "Not junk" — the user's command to move ONE message out of \Junk back to INBOX, RECORDED
    // here (`junk_rescues`) with the doorbell and executed by the organizer under its lease; the
    // message then re-enters through the worker's NORMAL ingest. 202, because nothing has moved
    // yet. `work` and not `connection`: this opens no socket.
    // `allow: { sender }` is the SECOND VERB — "Not junk, always allow": the sender's spam rule is
    // disabled and their allow minted in the SAME transaction as the command, so an interrupted
    // request leaves neither. Same route, never a parallel one.
    method: "POST",
    pattern: "/screener/junk/rescue",
    relay: true,
    cost: "work",
    replay: "guarded",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ mailboxId?: unknown; uid?: unknown; uidValidity?: unknown; allow?: unknown }>(req);
      const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
      const uid = typeof body.uid === "number" ? body.uid : NaN;
      const uidValidity = typeof body.uidValidity === "string" ? body.uidValidity : "";
      if (!mailboxId || !Number.isInteger(uid) || uid <= 0 || !uidValidity) {
        throw new ServiceError("validation_failed", 400, "mailboxId, uid and uidValidity are required");
      }
      let allow: { sender: string } | undefined;
      if (body.allow !== undefined) {
        const sender = (body.allow as { sender?: unknown } | null)?.sender;
        if (typeof sender !== "string" || sender.trim().length === 0) {
          throw new ServiceError("validation_failed", 400, "allow.sender must be the row's sender address");
        }
        allow = { sender };
      }
      // 202 AND NOT 200: the press is recorded, the move has not happened, and the surface's
      // sentence is "will be moved" rather than "moved" — the screener decision's own rule one
      // route down, for the same reason.
      return jsonResponse(await rescueJunk(deps, ctx, {
        mailboxId, uid, uidValidity, ...(allow !== undefined ? { allow } : {}),
      }), { status: 202 });
    },
  },
  {
    method: "POST",
    pattern: "/screener/:id",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<ScreenBody>(req);
      const result = await screener(deps).decide(serviceContext(deps, req), params.id!, body, {
        idempotency: deps.idempotency ?? null,
      });
      // ── 200 IS A DECISION APPLIED; 202 IS A DECISION QUEUED, AND THEY ARE NOT THE SAME NEWS ──
      //
      // On a mailbox this install ORGANIZES, `decide` writes: the rule exists, the mail has moved,
      // 200. On a mailbox it merely READS, the decision becomes a request for whoever holds the
      // mailbox and NOTHING has been applied yet — the honest code for that is 202, and it is
      // what the service already stores for the idempotent replay (`requestAsReader`'s
      // `claimIdempotencyKey` call, `responseStatus: 202`). Returning 200 on the live call would
      // make the FIRST press and its REPLAY answer differently for one unchanged decision, which
      // is the one thing an idempotent route may not do. `messages.ts`'s own 202 is the precedent.
      const status = "pending" in result && result.pending === true ? 202 : 200;
      return jsonResponse(result, { status });
    },
  },
];
