import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { answer } from "../responses.js";
import type { Route } from "../router.js";
import { decodeSendAttachments, readStagedIds } from "./drafts.js";
import { readBody, schedules } from "./shared.js";
import type { RequestOf } from "@ohmail/wire";

/**
 * SEND LATER WITH FILES (mail 0179, 0180) — `POST /drafts/:id/schedule-with-files`, `{ sendAt,
 * attachments?: [{ filename, contentType, contentBase64 }], stagedAttachmentIds?: [...] }`, the same
 * two transports the send takes (inline first). The appointment keeps its files until it is sent,
 * cancelled or closed, as the host declares (`ApiServices.scheduledFiles`): plain in the desktop's
 * own store, sealed on a server, which copies staged files at the press. A host that declares
 * nothing answers 404, so nothing is ever scheduled without its files. Relayed, so a desktop paired
 * to a server reaches that server's. `/hello` says where files are kept (`scheduleFiles`,
 * `scheduleFilesDays`).
 */
export const scheduleFilesRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/drafts/:id/schedule-with-files",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const keeping = deps.services?.scheduledFiles;
      if (!keeping) throw new ServiceError("not_found", 404, "this server keeps no files for a later send");
      const body = await readBody<RequestOf<"POST /drafts/:id/schedule-with-files">>(req);
      const files = decodeSendAttachments(body.attachments);
      const stagedIds = readStagedIds(body.stagedAttachmentIds);
      if (!files && !stagedIds) {
        throw new ServiceError("validation_failed", 400, "attachments are required here; a letter without files is scheduled at /drafts/:id/schedule");
      }
      const staging = deps.services?.attachmentStaging;
      if (stagedIds && !staging) {
        // References on a host with no staging are refused, never scheduled without the files.
        throw new ServiceError("validation_failed", 400, "this server does not accept staged attachments");
      }
      const { draft, seq } = await schedules(deps).schedule(
        serviceContext(deps, req), params.id!, body.sendAt,
        {
          ...(files ? { files } : {}),
          ...(stagedIds && staging ? { staged: { ids: stagedIds, source: staging(deps.db).source } } : {}),
          surfaceMaxTotalBytes: deps.services?.sendSurfaceMaxTotalBytes,
          keeping,
        },
      );
      return answer<"POST /drafts/:id/schedule-with-files">()(draft, { status: 200, seq });
    },
  },
];
