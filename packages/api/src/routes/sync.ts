import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { devices, sessions } from "@trafficflow/db";
import type { EntityType } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import type { ApiDeps } from "../deps.js";
import { mailbox, sync } from "./shared.js";

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
const VALID_TYPES = new Set<EntityType>([
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
  // The account's settings row — the consent doorbell (`change-log.ts`). `?types=` is a REQUEST
  // as well as a description, and this filter drops unknown tokens SILENTLY — so a member
  // missing here starves every mirror that asks for it while the rest of its list keeps
  // arriving, which is exactly how the desktop's tag drought happened (`cloud-mirror.ts` tells
  // that story). The settings entity is where this list was found lagging the union.
  "settings",
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
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
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
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;

      const result = await sync(deps).getSnapshot(serviceContext(deps, req), {
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
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
    handler: async (req, deps) => {
      const result = await mailbox(deps).requestPull(serviceContext(deps, req));
      return jsonResponse(result, { status: 202 });
    },
  },
];
