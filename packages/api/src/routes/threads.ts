import type { ThreadPatchBody, ThreadRenameBody, ThreadMergeBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { thread, readBody } from "./shared.js";

/**
 * §5.3 — threads. `GET` reads; `PATCH` (muted), `POST …/rename`, and `POST
 * /threads/merge` mutate. `matchRoute` resolves the STATIC `/threads/merge` before
 * the param `/threads/:id` (static-before-param). All account-scoped in the
 * service (404 cross-account); mutations emit `thread`/`message` changes.
 */
export const threadRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/threads/merge",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<ThreadMergeBody>(req);
      const dto = await thread(deps).merge(serviceContext(deps, req), body);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/threads/:id",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await thread(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PATCH",
    pattern: "/threads/:id",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<ThreadPatchBody>(req);
      const dto = await thread(deps).patch(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto);
    },
  },
  {
    method: "POST",
    pattern: "/threads/:id/rename",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<ThreadRenameBody>(req);
      const dto = await thread(deps).rename(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto);
    },
  },
];
