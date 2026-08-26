import type { FolderCreateBody, FolderRenameBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { folderOps, readBody } from "./shared.js";

/**
 * /folders — the folder VERBS (FOLDERS-SPEC.md stage 2): create, rename, delete, dismiss, and
 * the delete confirm's scope read.
 *
 * Every write here RECORDS A USER COMMAND (`folder_ops`) and rings the `sync_requested_at`
 * doorbell — the API never opens IMAP to organize. The worker executes the command inside the
 * mailbox's serial cycle (exactly one organizer per mailbox — the lease principle), applies the
 * database consequences transactionally, and the wake channel carries the settled `folder`
 * entity back within seconds. The response body is the subject's fresh DTO wearing its pending
 * marker (`FolderDTO.op`), with the write's `change_log` seq in `X-Sync-Seq` so a client can
 * tell whether the drain it holds already includes its own change.
 *
 * All five refuse while "Use folders" is off (`folders_disabled`, 409) — the flag-off wire
 * stays byte-identical to the pre-feature wire, verbs included.
 */
export const foldersRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/folders",
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<FolderCreateBody>(req);
      const { dto, seq } = await folderOps(deps).create(serviceContext(deps, req), body);
      return jsonResponse(dto, { status: 201, seq });
    },
  },
  {
    method: "PATCH",
    pattern: "/folders/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<FolderRenameBody>(req);
      const { dto, seq } = await folderOps(deps).rename(serviceContext(deps, req), params.id!, body);
      return jsonResponse(dto, { seq });
    },
  },
  {
    method: "DELETE",
    pattern: "/folders/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const { dto, seq } = await folderOps(deps).remove(serviceContext(deps, req), params.id!);
      return jsonResponse(dto, { seq });
    },
  },
  {
    // Dismiss a FAILED command — the refusal was read; clear it (a failed create takes its
    // never-created row with it, so the answer may be `{ dismissed: true }` with no folder).
    method: "DELETE",
    pattern: "/folders/:id/op",
    cost: "work",
    handler: async (req, deps, params) => {
      const { dto, seq } = await folderOps(deps).dismiss(serviceContext(deps, req), params.id!);
      return jsonResponse(dto ?? { dismissed: true }, { seq });
    },
  },
  {
    // The delete confirm's server-truth numbers: "N messages across M folders move to Trash."
    // A read, because the client mirror is windowed and a count derived there would understate
    // what the delete moves.
    method: "GET",
    pattern: "/folders/:id/summary",
    cost: "read",
    handler: async (req, deps, params) => {
      const summary = await folderOps(deps).summary(serviceContext(deps, req), params.id!);
      return jsonResponse(summary);
    },
  },
];
