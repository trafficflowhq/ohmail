import type { FolderCreateBody, FolderRenameBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { folderOps, readBody } from "./shared.js";

/**
 * /folders — the folder verbs (FOLDERS-SPEC.md stage 2): create, rename, delete, dismiss, and the
 * delete confirm's scope read. Every write records a user command (`folder_ops`) and rings the
 * `sync_requested_at` doorbell — the API never opens IMAP to organize; the worker executes inside
 * the mailbox's serial cycle (one organizer per mailbox), and the wake channel carries the
 * settled `folder` entity back. The response is the fresh DTO wearing its pending marker
 * (`FolderDTO.op`), the write's seq in `X-Sync-Seq`. All five refuse while "Use folders" is off
 * (`folders_disabled`, 409). The four writes are `idempotent`: a retry replays the stored answer
 * instead of re-recording a command the worker may already be executing.
 */
export const foldersRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/folders",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<FolderCreateBody>(req);
      const { dto, seq } = await folderOps(deps).create(serviceContext(deps, req), body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto, { status: 201, seq });
    },
  },
  {
    method: "PATCH",
    pattern: "/folders/:id",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<FolderRenameBody>(req);
      const { dto, seq } = await folderOps(deps).rename(serviceContext(deps, req), params.id!, body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto, { seq });
    },
  },
  {
    method: "DELETE",
    pattern: "/folders/:id",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const { dto, seq } = await folderOps(deps).remove(serviceContext(deps, req), params.id!, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto, { seq });
    },
  },
  {
    // Dismiss a FAILED command — the refusal was read; clear it (a failed create takes its
    // never-created row with it, so the answer may be `{ dismissed: true }` with no folder).
    method: "DELETE",
    pattern: "/folders/:id/op",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const { dto, seq } = await folderOps(deps).dismiss(serviceContext(deps, req), params.id!, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto ?? { dismissed: true }, { seq });
    },
  },
  {
    // The delete confirm's server-truth numbers: "N messages across M folders move to Trash."
    // A read, because the client mirror is windowed and a count derived there would understate
    // what the delete moves.
    method: "GET",
    pattern: "/folders/:id/summary",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const summary = await folderOps(deps).summary(serviceContext(deps, req), params.id!);
      return jsonResponse(summary);
    },
  },
];
