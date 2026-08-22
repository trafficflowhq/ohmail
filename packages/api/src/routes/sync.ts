import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { devices, sessions } from "@trafficflow/db";
import type { EntityType } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import type { ApiDeps } from "../deps.js";
import { sync } from "./shared.js";

/**
 * The EntityType values a `?types=` CSV may name; unknown tokens are dropped.
 *
 * `"tag"` HAS TO BE HERE, and its absence was invisible in exactly the way this filter makes
 * things invisible: an unknown token is dropped rather than refused, so a caller asking for
 * `types=message,tag` was silently answered with messages alone and had no way to tell that from
 * an account with no tags. A client draining without `?types=` never noticed, because no filter
 * is applied at all in that case — which is why every browser tab was fine and the one caller
 * that DOES name its types (the desktop's Cloud mirror) drained a feed with no vocabulary for a
 * tag, and rendered an empty rail over an account that had several.
 *
 * Kept as a literal set rather than derived from `EntityType`: a union is erased at runtime, and
 * the point of the set is to reject a token the reader has no materializer for.
 */
const VALID_TYPES = new Set<EntityType>([
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
]);

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
 * Stamp `devices.last_synced_at` (mail 0064) for the session's device — the per-device "last
 * time this mirror was genuinely current" the `device_sync_stale` alert reads.
 *
 * Called ONLY when a `GET /sync` response says `hasMore: false`: a device that is paging a
 * backlog (or stuck re-bootstrapping the same backlog forever — the measured failure this
 * column exists for) makes requests but never reaches the horizon, and must not look current.
 * A deviceless session (a plain browser tab) matches no row and writes nothing.
 *
 * FAILURE POSTURE: swallowed, deliberately, and the direction is fail-LOUD for the alert —
 * a stamp that stops landing lets `last_synced_at` age, which makes the staleness alert FIRE,
 * never sleep. The read this rides on must not become 500s over bookkeeping.
 */
async function stampDeviceSynced(deps: ApiDeps): Promise<void> {
  const sessionId = deps.session?.sessionId;
  if (!sessionId) return;
  try {
    const cutoff = new Date(deps.now().getTime() - DEVICE_SYNC_STAMP_MIN_GAP_MS);
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
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const since = url.searchParams.get("since") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
      const types = parseTypes(url.searchParams.get("types"));

      const result = await sync(deps).getChanges(serviceContext(deps, req), {
        since,
        ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
        ...(types ? { types } : {}),
      });
      // The horizon is the stamp's whole meaning — a page mid-backlog stamps nothing.
      if (!result.hasMore) await stampDeviceSynced(deps);
      return jsonResponse(result);
    },
  },
  /**
   * The bootstrap reader. `SyncService.getSnapshot` documents the shape and the
   * consistency argument; this handler does nothing but parse two query parameters.
   *
   * `cost: "read"` for the same reason `GET /sync` is: it selects rows already stored for the
   * caller's own account, writes nothing, opens no socket and calls no model. It reads MORE of
   * them than most routes do — that is what a bootstrap is — and `cost` classifies what a
   * handler CAUSES, not how much of the caller's own data it returns. `GET /consent/seed` is
   * already the precedent for that reading (see the census in `spend-gate.test.ts`).
   *
   * The account comes from `serviceContext(deps, req)`, i.e. the session, exactly as `/sync`
   * does. There is no account parameter to get wrong.
   *
   * Two segments, so it can never shadow or be shadowed by `/sync` — the router matches on
   * segment count first.
   */
  {
    method: "GET",
    pattern: "/sync/snapshot",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;

      const result = await sync(deps).getSnapshot(serviceContext(deps, req), {
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
      });
      return jsonResponse(result);
    },
  },
];
