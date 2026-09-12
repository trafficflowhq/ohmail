import { eq } from "drizzle-orm";
import { jsonResponse, type Route } from "@trafficflow/api/local";
import { accountSettings } from "@trafficflow/db";
import { ServiceError, setAutoSuggest, type ServiceContext } from "@trafficflow/services/mail";
import type { LocalAi } from "./ai-provider.js";
import type { LocalDb } from "./db.js";

/**
 * The two routes a standalone install serves for "suggest for new senders as they arrive". Not
 * `PATCH /consent/settings`, which writes this exact column: the column IS the same
 * (`account_settings.auto_suggest_at`, also the pass's watermark) and the write is the same
 * `setAutoSuggest` the hosted route calls — what is NOT shared is the route, since the hosted consent
 * routes are absent from `localRoutes` and an axis on a shared one would hand the hosted API a second
 * door onto a metered spender. So they live here beside `localAiRoutes` (a bypass the Cloud host
 * cannot import is one it cannot take by accident). `modelReady` travels on the read because the
 * ENGINE makes the call; turning the switch on with no model is ACCEPTED, but the surface must not imply work.
 */

/** What `GET /local/auto-suggest` answers, and what `PUT` echoes back. */
export interface LocalAutoSuggestState {
  /** `auto_suggest_at IS NOT NULL`. The stored value, never the hoped-for one. */
  on: boolean;
  /**
   * WHEN it was turned on, or null.
   *
   * Display in the window, and the WATERMARK in the pass: only a held sender whose representative
   * message was ingested after this instant is ever asked about. That is why turning the switch on
   * does not reach back over a mailbox that was already synced.
   */
  since: string | null;
  /**
   * Whether this install has a verified model right now — `ai.status().available`.
   *
   * False covers every reason at once (nothing configured, a key this install cannot open, an
   * endpoint that did not answer its last verification) because the surface's answer is the same
   * for all of them and `/local/ai` is where the difference is named and fixed.
   */
  modelReady: boolean;
}

async function readState(db: LocalDb, accountId: string, ai: LocalAi): Promise<LocalAutoSuggestState> {
  const [row] = await db.select({ autoSuggestAt: accountSettings.autoSuggestAt })
    .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const at = row?.autoSuggestAt ?? null;
  return { on: at !== null, since: at ? at.toISOString() : null, modelReady: ai.status().available };
}

/**
 * The routes, closed over the store, the account and the live AI object.
 *
 * A factory for the reason `localAiRoutes` is one: what it needs is this process's own state, and
 * handing it in explicitly means nothing can reach it except by being given it.
 */
export function localAutoSuggestRoutes(deps: {
  db: LocalDb;
  accountId: string;
  ai: LocalAi;
  now: () => Date;
}): Route[] {
  const { db, accountId, ai, now } = deps;
  return [
    {
      method: "GET",
      pattern: "/local/auto-suggest",
      relay: false,  /* served by this engine; never forwarded */
      cost: "read",
      handler: async () => jsonResponse(await readState(db, accountId, ai), { status: 200 }),
    },
    {
      /**
       * PUT and not PATCH: the body describes the state that should be in force afterwards, and
       * there is exactly one axis, so there is nothing for a partial update to leave alone.
       *
       * `on` must be a boolean and nothing is coerced. This is a consent surface and guessing what
       * the caller meant is the bug — the same rule `/account/screening` and `/consent/settings`
       * follow, and the sign that matters is the one where a truthy string arms a standing
       * authorisation to use somebody's API key.
       */
      method: "PUT",
      pattern: "/local/auto-suggest",
      relay: false,  /* served by this engine; never forwarded */
      cost: "work",
      handler: async (req) => {
        let body: { on?: unknown };
        const text = await req.text();
        try {
          body = text.trim() === "" ? {} : (JSON.parse(text) as { on?: unknown });
        } catch {
          throw new ServiceError("invalid_request", 400, "the request body is not valid JSON");
        }
        if (typeof body.on !== "boolean") {
          throw new ServiceError("validation_failed", 400, "on must be true or false");
        }
        // The SHARED writer, so the timestamp this stamps is the one the hosted route stamps and
        // the pass reads one meaning of the column. A `ServiceContext` is built inline because this
        // engine has no session behind the request that a `serviceContext(deps, req)` could read:
        // the local API mints one bearer per launch for the shell that spawned it, and the account
        // is this install's own. `userId` is null for the same reason every local pass leaves it so.
        const ctx: ServiceContext = {
          db, accountId, userId: null, now, requestId: "local-auto-suggest",
        };
        await setAutoSuggest(ctx, body.on);
        // Re-READ rather than compose the answer from what was asked for, so the window renders
        // what is stored. Same discipline the screening pane's controls follow.
        return jsonResponse(await readState(db, accountId, ai), { status: 200 });
      },
    },
  ];
}
