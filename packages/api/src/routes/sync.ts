import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { devices, sessions } from "@trafficflow/db";
import type { EntityType } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import type { ApiDeps } from "../deps.js";
import { mailbox, sync } from "./shared.js";
import { pagingNumber } from "../query-bounds.js";

/**
 * The EntityType values a `?types=` CSV may name; unknown tokens are dropped. `"tag"` has to be
 * here, and its absence was invisible in exactly the way this filter makes things invisible: an
 * unknown token is dropped rather than refused, so a caller asking for `types=message,tag` was
 * silently answered with messages alone — every browser tab was fine (no filter without
 * `?types=`), and the one caller that names its types (the desktop's Cloud mirror) drained a feed
 * with no vocabulary for a tag and rendered an empty rail over an account that had several. A
 * literal set rather than derived from `EntityType`: a union is erased at runtime, and the point
 * is to reject a token the reader has no materializer for.
 */
const VALID_TYPE_LIST = ([
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
  // The account's settings row — the consent doorbell (`change-log.ts`). `?types=` is a REQUEST
  // as well as a description, and this filter drops unknown tokens SILENTLY — so a member
  // missing here starves every mirror that asks for it while the rest of its list keeps
  // arriving, which is exactly how the desktop's tag drought happened (`cloud-mirror.ts` tells
  // that story). The settings entity is where this list was found lagging the union.
  "settings",
  /**
   * A mailbox the account erased — the receipt the desktop's Cloud mirror names in its own
   * `?types=` list (`cloud-mirror.ts#CLOUD_SYNC_TYPES`). Missing here it would be dropped by the
   * filter above and the mirror would ask for a receipt it never receives: the mail of an erased
   * mailbox stays in the mirror and on the screen, the tag drought's shape exactly.
   */
  "mailbox",
  // A bought Screener suggestion — the narrow verdict entity (`change-log.ts`). The desktop's
  // Cloud mirror and the phone both name their types, so a member missing here would starve
  // exactly the two surfaces the entity exists to reach.
  "screener_suggestion",
] as const) satisfies readonly EntityType[];
const VALID_TYPES = new Set<EntityType>(VALID_TYPE_LIST);

/**
 * AND EVERY `EntityType` IS IN IT — the compile-time half, because this set has now lagged the
 * union twice and both times the symptom was silence: the filter drops an unknown token rather
 * than refusing it, so a mirror that asks for the missing type is answered with the rest of its
 * list and converges missing a whole kind of state. `tag` was the first (a desktop rail empty over
 * an account with several tags), `settings` the second. `Exclude<…>` stops being `never` the
 * moment a member is added to the union without being listed here, and the line below then fails
 * to compile naming the type that was forgotten.
 */
type SyncTypeMissing = Exclude<EntityType, typeof VALID_TYPE_LIST[number]>;
type SyncTypesAreComplete = [SyncTypeMissing] extends [never] ? true
  : { "EntityType missing from VALID_TYPES — `?types=` would silently drop it": SyncTypeMissing };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const syncTypesAreComplete: SyncTypesAreComplete = true;
void syncTypesAreComplete;

/** Parse `?types=a,b,c` → EntityType[], silently ignoring unknown tokens. */
function parseTypes(raw: string | null): EntityType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter((t): t is EntityType => VALID_TYPES.has(t as EntityType));
  return types.length > 0 ? types : undefined;
}

/**
 * How long a device-sync stamp is considered fresh enough not to rewrite. The throttle lives
 * in the UPDATE's own predicate, so however many horizon-reaching polls a device makes, the
 * row is written at most once per window — one guarded UPDATE per five minutes per device,
 * not one per 20-second poll.
 */
export const DEVICE_SYNC_STAMP_MIN_GAP_MS = 5 * 60_000;

/**
 * Stamp `devices.last_synced_at` (mail 0064) and `sessions.last_synced_at` (mail 0070) — what the
 * staleness alerts read. Only on the empty tail (no changes, `hasMore: false`, cursor unchanged):
 * both mirrors write their cursor only after the page commits, so a client presenting the horizon
 * cursor has durably applied everything below it — stamping any `hasMore: false` stamped the
 * final page before the client applied it. Two stamps, two watched populations: most installs are
 * deviceless on purpose (mail 0061), and the incident this exists for was such a desktop, wedged
 * for days while the device alert watched a population it was never in. Swallowed on failure,
 * fail-loud for the alert: a stamp that stops landing makes the alert fire, never sleep.
 */
async function stampDeviceSynced(deps: ApiDeps): Promise<void> {
  const sessionId = deps.session?.sessionId;
  if (!sessionId) return;
  try {
    const cutoff = new Date(deps.now().getTime() - DEVICE_SYNC_STAMP_MIN_GAP_MS);
    await deps.db.update(sessions)
      .set({ lastSyncedAt: deps.now() })
      .where(and(
        eq(sessions.id, sessionId),
        or(isNull(sessions.lastSyncedAt), lt(sessions.lastSyncedAt, cutoff)),
      ));
    // scoped-by: devices.id comes from the caller's own resolved session row (sessions.id = sessionId)
    await deps.db.update(devices)
      .set({ lastSyncedAt: deps.now() })
      .where(and(
        eq(devices.id, sql`(select ${sessions.deviceId} from ${sessions} where ${sessions.id} = ${sessionId})`),
        or(isNull(devices.lastSyncedAt), lt(devices.lastSyncedAt, cutoff)),
      ));
  } catch {
    /* bookkeeping only — see the failure posture above */
  }
}

/** §3 — the delta reader. A 410 (expired/malformed cursor) flows through withErrorEnvelope. */
export const syncRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/sync",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const since = url.searchParams.get("since") ?? undefined;
      const limit = pagingNumber(url.searchParams.get("limit"));
      const types = parseTypes(url.searchParams.get("types"));

      const result = await sync(deps).getChanges(serviceContext(deps, req), {
        since,
        ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
        ...(types ? { types } : {}),
      });
      // The COMMITTED horizon is the stamp's whole meaning: only the empty tail — the client
      // presenting a cursor that is already the horizon — proves a committed drain. A page
      // mid-backlog, and the final page itself (handed over but not yet applied), stamp nothing.
      const emptyTail = !result.hasMore && since !== undefined && result.cursor === since
        && result.changes.creates.length === 0 && result.changes.updates.length === 0
        && result.changes.moves.length === 0 && result.changes.deletes.length === 0;
      if (emptyTail) await stampDeviceSynced(deps);
      return jsonResponse(result);
    },
  },
  /**
   * The bootstrap reader. `SyncService.getSnapshot` documents the shape and the consistency
   * argument; this handler parses two query parameters. `cost: "read"` for `GET /sync`'s reason:
   * rows already stored for the caller's own account, no socket, no model — it reads more of them
   * than most routes, and `cost` classifies what a handler causes, not how much of the caller's
   * own data returns (`GET /consent/seed` is the precedent, per the spend census). The account
   * comes from the session; there is no account parameter to get wrong. Two segments, so it can
   * never shadow `/sync` — the router matches on segment count first.
   */
  {
    method: "GET",
    pattern: "/sync/snapshot",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = pagingNumber(url.searchParams.get("limit"));
      // `?phase=tail` — the labeled tail alone, for a client re-hydrating mail its own retention
      // policy once evicted. A CLOSED SET AT THE READ, which is where `input-bounds-census` asks
      // for a caller-chosen value's bound: anything else is the ordinary walk, the safe direction
      // for a parameter a future client might spell differently.
      const phase = url.searchParams.get("phase") === "tail" ? "tail" as const : undefined;

      const result = await sync(deps).getSnapshot(serviceContext(deps, req), {
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
        ...(phase ? { phase } : {}),
      });
      return jsonResponse(result);
    },
  },
  /**
   * "Pull new mail" — ring the worker's doorbell now. The client pull gestures drain the mirror,
   * which cannot make the worker look at IMAP sooner; this stamps `sync_requested_at` for every
   * connected mailbox (the rate limit lives in that UPDATE's predicate), the worker's ~3 s kick
   * scan wakes those runtimes, and the cycle serves one bounded batch out of turn. `cost:
   * "work"`: worker-side IMAP work — lighter than a resync, but the boundary is not a tariff. The
   * answer carries each mailbox's own effective request instant at the database's clock — the
   * honest-settle baseline. Per mailbox and single-clock: one scalar overshoots a mailbox with a
   * young standing request, and host-clock comparison inherits skew.
   */
  {
    method: "POST",
    pattern: "/sync/pull",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps) => {
      const result = await mailbox(deps).requestPull(serviceContext(deps, req));
      return jsonResponse(result, { status: 202 });
    },
  },
];
