import type { SnippetBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { snippets, readBody, noContent } from "./shared.js";

/**
 * §5.13 — snippets CRUD (5 endpoints). REST-only (no /sync entity). PUT is a
 * FULL replace. Empty `title`/`body` → 400; cross-account id → 404.
 */
export const snippetsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/snippets",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const page = await snippets(deps).list(serviceContext(deps, req), {
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/snippets",
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<SnippetBody>(req);
      const dto = await snippets(deps).create(serviceContext(deps, req), body);
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "GET",
    pattern: "/snippets/:id",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await snippets(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PUT",
    pattern: "/snippets/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<SnippetBody>(req);
      const dto = await snippets(deps).update(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto);
    },
  },
  {
    method: "DELETE",
    pattern: "/snippets/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      await snippets(deps).remove(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
