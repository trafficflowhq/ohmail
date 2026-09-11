import type { TagBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { tags, readBody } from "./shared.js";

/**
 * /tags — the account's own labels, keyed by message. A tag is a row in our database and never an
 * IMAP folder, so there is no folder verb here and no handler can reach the mailbox. The routes
 * carry the write's seq in `X-Sync-Seq`: tags ride the `/sync` drain (a `tag` entity for
 * identity, a `message` update per assignment). `POST /messages/:id/tags` is the assignment verb
 * and a delta — one tag and a boolean, never the full label array: the array shape is a
 * read-modify-write, and two concurrent toggles of different tags would drop one. It lives here
 * because the subsystem it belongs to is this one.
 */
export const tagsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/tags",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const items = await tags(deps).list(serviceContext(deps, req));
      return jsonResponse({ items });
    },
  },
  {
    method: "POST",
    pattern: "/tags",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<TagBody>(req);
      const { dto, seq } = await tags(deps).create(serviceContext(deps, req), body);
      return jsonResponse(dto, { status: 201, seq });
    },
  },
  {
    method: "PATCH",
    pattern: "/tags/:id",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<TagBody>(req);
      const { dto, seq } = await tags(deps).update(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto, { seq });
    },
  },
  {
    method: "DELETE",
    pattern: "/tags/:id",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const { seq } = await tags(deps).remove(serviceContext(deps, req), params.id!);
      return new Response(null, {
        status: 204,
        headers: seq === null ? {} : { "X-Sync-Seq": String(seq) },
      });
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/tags",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<{ tagId: string; assigned: boolean; name?: string }>(req);
      const { labels, tagId, seq } = await tags(deps).assign(
        serviceContext(deps, req), params.id!, body?.tagId, body?.assigned, body?.name,
      );
      // `tagId` is echoed because it is not always the one that was asked for: in the
      // tag-or-create path an existing name wins, and the caller needs to know which tag its
      // message actually carries.
      return jsonResponse({ labels, tagId }, { seq });
    },
  },
];
