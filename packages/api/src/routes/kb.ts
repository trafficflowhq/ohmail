import type { KbEntryBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { kb, readBody, noContent } from "./shared.js";
import { pagingNumber } from "../query-bounds.js";

/**
 * §5 /kb — Knowledge Base CRUD (5 endpoints). REST-only (no /sync
 * entity). PUT is a FULL replace of title/content/tags. Empty title/content → 400;
 * cross-account id → 404. Retrieval (`KbService.retrieve`) is consumed by the
 * AI drafter — it has no standalone route here.
 */
export const kbRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/kb",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const page = await kb(deps).list(serviceContext(deps, req), {
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: pagingNumber(url.searchParams.get("limit")),
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/kb",
    relay: true,
    cost: "work",
    /* A CREATE THAT MINTS A ROW PER CALL: nothing about the row is unique, so a retry after a
       lost response leaves two. The service claims the key inside its own insert transaction. */
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<KbEntryBody>(req);
      const dto = await kb(deps).create(
        serviceContext(deps, req), body, { idempotency: deps.idempotency ?? null },
      );
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "GET",
    pattern: "/kb/:id",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await kb(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PUT",
    pattern: "/kb/:id",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const body = await readBody<KbEntryBody>(req);
      const dto = await kb(deps).update(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto);
    },
  },
  {
    method: "DELETE",
    pattern: "/kb/:id",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      await kb(deps).remove(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
