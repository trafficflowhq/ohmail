import {
  getScreeningPreference, setScreeningPreference,
  DEFAULT_OHBOX_BAR, type ScreeningPreferenceUpdate,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

/**
 * `GET/PATCH /account/screening` — the editable Ohbox preference.
 *
 * Two facts about how the account wants its Ohbox kept: the POSTURE (`ohboxPolicy`) that turns the
 * bulk-mail demotion on, and the BAR (`ohboxBar`) — the account owner's own words, threaded into the
 * classifier's user turn. Both live on `account_settings`, both are nullable, and NULL reads as the
 * lenient default, so an account that has never touched this is on today's behaviour.
 *
 * Its own file, on the same reasoning as `ai-settings.ts`: a new module reduces the shared surface
 * with concurrent edits under `routes/` to a single import line in `routes/index.ts`.
 *
 * No step-up: this is reversible by the same request with the opposite value, destroys nothing and
 * moves no money. The write mirrors `ai-settings.ts`/`consent.ts` — the service does the strict
 * validation (enum + byte-length) and throws a `ServiceError` the router renders; there is no
 * coercion here, because this is a consent surface and guessing what the caller meant is the bug.
 */
export const screeningRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/account/screening",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const pref = await getScreeningPreference(serviceContext(deps, req));
      // `defaultBar` travels with the read so the client shows the product default as the textarea
      // PLACEHOLDER when `ohboxBar` is null, rather than hardcoding the copy and drifting from it.
      return jsonResponse({ ...pref, defaultBar: DEFAULT_OHBOX_BAR });
    },
  },
  {
    /**
     * `cost: "work"`, and every route's cost is pinned by a frozen census so that none of them can
     * change class without somebody saying so. A settings write is not a metered AI action, but
     * `work` is the class for "an authenticated mutation that is not a read", and this changes
     * account state.
     */
    method: "PATCH",
    pattern: "/account/screening",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<{ ohboxPolicy?: unknown; ohboxBar?: unknown; screenerAutoApply?: unknown }>(req);
      // Only the axes the caller ACTUALLY sent are forwarded: a body that names just `ohboxBar` must
      // not reset `ohboxPolicy` to its default. Presence is `in`, never a truthiness or `!==
      // undefined` test — the whole point is that an explicit `null` (revert to default) is a real,
      // distinct instruction from "leave this axis alone".
      const update: ScreeningPreferenceUpdate = {};
      if ("ohboxPolicy" in body) update.ohboxPolicy = body.ohboxPolicy as ScreeningPreferenceUpdate["ohboxPolicy"];
      if ("ohboxBar" in body) update.ohboxBar = body.ohboxBar as ScreeningPreferenceUpdate["ohboxBar"];
      // Auto-apply is a boolean opt-in, and the SERVICE does the type check (a non-boolean is a 400
      // there), so this forwards the raw value rather than coercing — the same no-guessing rule the
      // other two axes follow on this consent surface.
      if ("screenerAutoApply" in body) update.screenerAutoApply = body.screenerAutoApply as ScreeningPreferenceUpdate["screenerAutoApply"];
      const pref = await setScreeningPreference(serviceContext(deps, req), update);
      return jsonResponse({ ...pref, defaultBar: DEFAULT_OHBOX_BAR });
    },
  },
];
