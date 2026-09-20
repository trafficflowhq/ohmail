import { and, asc, eq, ne } from "drizzle-orm";
import type { Tx } from "@trafficflow/db";
import { accountSettings, mailboxes } from "@trafficflow/db";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { serviceContext } from "../context.js";
import { json } from "./shared.js";
import type { Route } from "../router.js";

/**
 * `GET /account/export` — the way out with your configuration (the wall, cloud 0040's slice).
 * ONE document: the organizer profile per mailbox — THE SAME serializer the worker publishes
 * into `ohmail/_meta` (`serializeOrganizerProfile`, v2 canonical), so a self-hosted install that
 * joins the mailbox reads the identical configuration this export hands out — plus the
 * `account_settings` knobs the profile does not carry. NO MAIL (the mailbox is the master and
 * already holds it), NO CREDENTIALS (a test pins that no key of the document matches a
 * credential shape). `cost: "read"`, and it sits on `ACCESS_REFUSED_MAY_REACH_ROUTES`:
 * leave-anytime is not suspended by a lapsed subscription, so the door is open UNDER the wall.
 */
export const exportRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/account/export",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const db = deps.db as unknown as Tx;

      // Every non-deleted mailbox, oldest first — a disconnected (soft-disabled) row is a
      // tombstone whose configuration already travelled or was given up, so it stays out.
      const rows = await db.select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .where(and(eq(mailboxes.accountId, ctx.accountId), ne(mailboxes.status, "disabled")))
        .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));

      const perMailbox = [];
      for (const mb of rows) {
        perMailbox.push({
          address: mb.address,
          profile: await serializeOrganizerProfile(db, ctx.accountId, mb.id),
        });
      }

      // The person's own knobs, as CHOICES rather than raw columns: the `*At` opt-ins are
      // consents whose fact is "on", not the instant somebody pressed — an export is
      // configuration to carry, never an audit trail. No `.limit(1)`: `account_id` is the PK, so
      // at most one row comes back — and the input-bounds census reads a `limit(` in a
      // path-params-only handler as a query-reading helper's name.
      const [s] = await db.select().from(accountSettings)
        .where(eq(accountSettings.accountId, ctx.accountId));
      const settings = {
        dormancyDays: s?.dormancyDays ?? null,
        locale: s?.locale ?? null,
        themeFace: s?.themeFace ?? null,
        resurfaceTime: s?.resurfaceTime ?? null,
        screeningScope: s?.screeningScope ?? "window",
        ohboxPolicy: s?.ohboxPolicy ?? null,
        ohboxBar: s?.ohboxBar ?? null,
        autoSuggest: (s?.autoSuggestAt ?? null) !== null,
        screenerAutoApply: (s?.screenerAutoApplyAt ?? null) !== null,
        foldersEnabled: (s?.foldersEnabledAt ?? null) !== null,
        blockRemoteImages: (s?.blockRemoteImagesAt ?? null) !== null,
        loadTrackingPixels: (s?.loadTrackingPixelsAt ?? null) !== null,
        blockAutoUnsubscribe: (s?.blockAutoUnsubscribeAt ?? null) !== null,
      };

      return json({
        v: 1,
        generatedAt: deps.now().toISOString(),
        settings,
        mailboxes: perMailbox,
      }, 200);
    },
  },
];
