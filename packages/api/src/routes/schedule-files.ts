import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { decodeSendAttachments, type SendAttachmentWire } from "./drafts.js";
import { readBody, schedules } from "./shared.js";

/**
 * SEND LATER WITH FILES (mail 0179) — `POST /drafts/:id/schedule-with-files`, `{ sendAt,
 * attachments: [{ filename, contentType, contentBase64 }] }`. The appointment keeps its files in
 * this engine's own store until it is sent, cancelled or closed, so the files never reach a server
 * of ours. Mounted by `localRoutes` alone, never relayed: a Cloud door, and any server predating it,
 * answers 404 instead of scheduling the letter without its files (the `send-attempt` precedent).
 * `/hello`'s `scheduleFiles` says where it is kept.
 */
export const scheduleFilesRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/drafts/:id/schedule-with-files",
    relay: false,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const body = await readBody<{ sendAt?: unknown; attachments?: SendAttachmentWire[] }>(req);
      const files = decodeSendAttachments(body.attachments);
      if (!files) {
        throw new ServiceError("validation_failed", 400, "attachments are required here; a letter without files is scheduled at /drafts/:id/schedule");
      }
      const { draft, seq } = await schedules(deps).schedule(
        serviceContext(deps, req), params.id!, body.sendAt,
        { files, surfaceMaxTotalBytes: deps.services?.sendSurfaceMaxTotalBytes },
      );
      return jsonResponse(draft, { status: 200, seq });
    },
  },
];
