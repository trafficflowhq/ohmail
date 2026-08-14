import { eq } from "drizzle-orm";
import { jsonResponse, type Route } from "@trafficflow/api/local";
import { accountSettings } from "@trafficflow/db";
import { ServiceError, setAutoSuggest, type ServiceContext } from "@trafficflow/services/mail";
import type { LocalAi } from "./ai-provider.js";
import type { LocalDb } from "./db.js";

/**
 * THE TWO ROUTES A STANDALONE INSTALL SERVES FOR "SUGGEST FOR NEW SENDERS AS THEY ARRIVE".
 *
 *   GET /local/auto-suggest   is it on, since when, and is there a model to run it with
 *   PUT /local/auto-suggest   turn it on or off
 *
 * ── WHY THIS IS NOT `PATCH /consent/settings`, WHICH ALREADY WRITES THIS EXACT COLUMN ───────
 *
 * The column IS the same one — `account_settings.auto_suggest_at`, a timestamp rather than a
 * boolean because it is also the watermark the pass measures from. The write below is the same
 * function the hosted route calls (`setAutoSuggest`), so there is one implementation of what arming
 * this means and one place the timestamp is composed.
 *
 * What is NOT shared is the route, and that is the whole point. The hosted consent routes are an
 * onboarding surface — the seed review, the dormancy dial, the reset — and they are deliberately
 * absent from `localRoutes` because a standalone install has no account behind any of it. Mounting
 * them here to reach one column would drag the rest; adding an `autoSuggest` axis to
 * `PATCH /account/screening`, which IS mounted on both doors, would instead hand the HOSTED API a
 * second way to arm a metered spender. That route's cost class was chosen for what the flag CAUSES
 * rather than for what the handler costs, and a second door onto it is not a thing to open in
 * passing.
 *
 * So the routes live HERE, in the local engine, beside `localAiRoutes` and for the same stated
 * reason: a hosted host cannot mount them because it has no name for them. It is the argument
 * `UNMETERED_MAILBOX_ALLOWANCE` in `engine.ts` makes about the mailbox limit — a bypass the Cloud
 * host cannot import is a bypass it cannot take by accident.
 *
 * ── AND WHY THE MODEL'S STATE TRAVELS ON THE READ ───────────────────────────────────────────
 *
 * `modelReady` is not something the window may derive. The pass is a no-op without a verified
 * provider, so a switch offered with nothing behind it would store a flag that nothing acts on —
 * which is the failure the desktop's own settings work already refuses ("a control that does
 * nothing, which is worse than an absent one"). The ENGINE is the thing that would make the call,
 * so the engine is what answers whether it can, exactly as `/local/ai` does. A window that
 * inferred it from a provider name would go on saying yes after the key was revoked.
 *
 * Turning the switch on with no model is still ACCEPTED rather than refused, and the copy says so.
 * The flag is a standing consent and the model is a configuration; refusing to record the first
 * because the second is missing would mean somebody who sets their key afterwards silently gets
 * nothing. What the surface must not do is imply work is happening. See `DesktopAutoSuggest.tsx`.
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
