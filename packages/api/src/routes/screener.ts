import { ServiceError, type ScreenBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import { listJunk, junkBody, rescueJunk } from "../junk-window.js";
import type { Route } from "../router.js";
import { screener, readBody } from "./shared.js";

/**
 * §5.3 — the flagship Screener. `GET /screener` is the DERIVED first-contact queue
 * (one entry per held sender). `POST /screener/:id` decides yes/no: it promotes a
 * rule, re-routes the sender's held mail to Imbox/Screened by writing DESIRED
 * folder_state (`pending`) + emitting changes, and feeds the learning loop. It is
 * idempotent (Idempotency-Key): the service writes the idempotency row IN its
 * decide tx, so `deps.idempotency` is threaded through — a replay never
 * re-creates the promoted rule. NO IMAP here: the API constructs the service
 * WITHOUT an adapter, so the physical move DEFERS to the worker.
 *
 * ── THE GET SPENDS NOTHING, AND THAT IS NEW ──────────────────────────────────────────────
 *
 * `GET /screener` used to call the model once per held sender it returned — up to 200 model
 * calls and 200 credits on one `cost: "read"` request, on the endpoint a client re-fetches on
 * every poll and scroll. Generation now lives at `POST /screener/suggest` over an explicit
 * sender set, and the read returns what is stored.
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
    method: "GET",
    pattern: "/screener",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      const page = await screener(deps).list(serviceContext(deps, req), { cursor, limit });
      // `suggestable` is the PRICE of this page — `{ senders, credits }` — so a control can
      // state both before it offers the button, from the response it already has.
      return jsonResponse({
        items: page.items, nextCursor: page.nextCursor, suggestable: page.suggestable,
      });
    },
  },
  {
    /**
     * **Buy AI suggestions for an EXPLICIT set of senders.**
     *
     * `cost: "work"`, which is the whole point of the row: this is the only screener path that
     * reaches a model, so it is the one an unverified account cannot reach and the one the
     * spend census counts. `POST /screener/:id` is `work` for a different reason (it writes),
     * and `GET /screener` stays `read` because it once again only reads.
     *
     * It sits BEFORE `/screener/:id` in this table for readability only — `matchRoute` scores
     * a static segment above a param at the same length, so `/screener/suggest` wins
     * whatever the order. Without that, "suggest" would arrive at `decide` as a message id.
     *
     * `idempotent: true` because this is a purchase: a retry after a lost response must replay
     * the answer rather than buy again. The service claims the key itself (the same shape, though
     * not in the same transaction as the writes — see `ScreenerService.suggest`).
     */
    method: "POST",
    pattern: "/screener/suggest",
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
   * ═══ THE JUNK WINDOW (FOLDERS-SPEC.md §16.2) — three routes, all `connection` class ═══════
   *
   * `connection`, NOT `read`, on the organizer peek's argument verbatim: each opens an IMAP
   * socket to the user's own provider (through the admission-capped `openMailboxImap`, budget
   * shared with attachments), and an unverified account must not be able to make this service
   * dial a mail server. All three are gated on the folders foundation flag inside the module
   * (409 `folders_disabled` with the flag off — no shipped flag-off client calls them, §16.7).
   *
   * The window NEVER writes `messages`/mirror rows — `GET` twice over, and the rescue writes
   * exactly one thing on OUR side: the `sync_requested_at` doorbell. `junk-window.ts` carries
   * the argument; `junk-window.test.ts` counts the tables.
   *
   * Static-beats-param (the `/messages/bodies` proof): `/screener/junk` outranks
   * `/screener/:id` at two segments; the three-segment routes contend with nothing.
   */
  {
    method: "GET",
    pattern: "/screener/junk",
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
    // "Not junk" — ONE user-commanded move out of \Junk back to INBOX (the imap-types
    // carve-out's second write), then the doorbell; re-entry is the worker's NORMAL ingest.
    // A message the provider expunged first answers 410 — the rescue fails honestly.
    method: "POST",
    pattern: "/screener/junk/rescue",
    cost: "connection",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ mailboxId?: unknown; uid?: unknown; uidValidity?: unknown }>(req);
      const mailboxId = typeof body.mailboxId === "string" ? body.mailboxId : "";
      const uid = typeof body.uid === "number" ? body.uid : NaN;
      const uidValidity = typeof body.uidValidity === "string" ? body.uidValidity : "";
      if (!mailboxId || !Number.isInteger(uid) || uid <= 0 || !uidValidity) {
        throw new ServiceError("validation_failed", 400, "mailboxId, uid and uidValidity are required");
      }
      return jsonResponse(await rescueJunk(deps, ctx, { mailboxId, uid, uidValidity }));
    },
  },
  {
    method: "POST",
    pattern: "/screener/:id",
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<ScreenBody>(req);
      const result = await screener(deps).decide(serviceContext(deps, req), params.id!, body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(result);
    },
  },
];
