import { attachmentFileRoute, type Route } from "@trafficflow/api/local";
import { openAttachmentFile } from "./attachment-file.js";

/**
 * The save's route for the local engine's stdio door, or none when the shell named no staging
 * directory. A module of its own because `@trafficflow/api/local` is the local route table, which
 * reaches the IMAP adapter: `attachment-file.ts` is the Cloud-mode engine's too, and that engine
 * must never carry it (`cloud-engine-census.test.ts`). The phone substitutes this module.
 */
export function attachmentFileRoutes(stagingDir: string | undefined): Route[] {
  return stagingDir ? [attachmentFileRoute((req) => openAttachmentFile(req, stagingDir))] : [];
}
