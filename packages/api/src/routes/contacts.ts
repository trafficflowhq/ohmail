import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { contacts, readBody, noContent } from "./shared.js";

interface PatchContactBody { name?: string | null }
interface NoteBody { body?: string }

const qp = (req: Request): { cursor?: string; limit?: number; q?: string } => {
  const url = new URL(req.url);
  return {
    q: url.searchParams.get("q") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
  };
};

/**
 * §5.12 — contacts & notes (9 endpoints). REST-only (no /sync entity).
 * All account-scoped in the service (404 cross-account). Note creation
 * verifies the parent contact/thread belongs to the account (IDOR). `PATCH`/
 * `DELETE /notes/:id` resolve an id in EITHER the contact_notes or thread_notes
 * table. Route ordering: `/threads/:id/notes` (3 segs) coexists with the existing
 * `/threads/:id` (2 segs) and `/threads/merge` (2 segs) — the matcher keys on
 * segment count then static-before-param.
 */
export const contactsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/contacts",
    cost: "read",
    handler: async (req, deps) => {
      const page = await contacts(deps).list(serviceContext(deps, req), qp(req));
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "GET",
    pattern: "/contacts/:id",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await contacts(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PATCH",
    pattern: "/contacts/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<PatchContactBody>(req);
      const dto = await contacts(deps).updateName(serviceContext(deps, req), params.id!, body.name ?? null);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/contacts/:id/notes",
    cost: "read",
    handler: async (req, deps, params) => {
      const page = await contacts(deps).listContactNotes(serviceContext(deps, req), params.id!, qp(req));
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/contacts/:id/notes",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<NoteBody>(req);
      const dto = await contacts(deps).addContactNote(serviceContext(deps, req), params.id!, body.body as string);
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "GET",
    pattern: "/threads/:id/notes",
    cost: "read",
    handler: async (req, deps, params) => {
      const page = await contacts(deps).listThreadNotes(serviceContext(deps, req), params.id!, qp(req));
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/threads/:id/notes",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<NoteBody>(req);
      const dto = await contacts(deps).addThreadNote(serviceContext(deps, req), params.id!, body.body as string);
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "PATCH",
    pattern: "/notes/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<NoteBody>(req);
      const dto = await contacts(deps).updateNote(serviceContext(deps, req), params.id!, body.body as string);
      return jsonResponse(dto);
    },
  },
  {
    method: "DELETE",
    pattern: "/notes/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      await contacts(deps).deleteNote(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
];
