import type { CreateNotifyRuleBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { notify, readBody, noContent } from "./shared.js";

/**
 * §5.11 — notify rules (3 endpoints): the opt-INTO-notifications list (push off by
 * default, spec §5.1). Create + list + delete, account-scoped, REST-only.
 * Empty `target` → 400; cross-account id → 404.
 */
export const notifyRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/notify-rules",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const page = await notify(deps).list(serviceContext(deps, req), {
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/notify-rules",
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<CreateNotifyRuleBody>(req);
      const dto = await notify(deps).create(serviceContext(deps, req), body);
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "DELETE",
    pattern: "/notify-rules/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      await notify(deps).remove(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
