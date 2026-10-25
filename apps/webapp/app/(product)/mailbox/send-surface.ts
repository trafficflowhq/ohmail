import { COMPOSE_ATTACH_STAGED_SURFACE_BYTES } from "../../components/ComposeAttach";
import { stagingUploadSource } from "../../../staging-origin.mjs";

/**
 * THE SEND SURFACE THE MAILBOX PAGE DECLARES: the staged ceiling only where the page can PUT the
 * files — a self-host build (its uploads ride its own origin) or a build that names its storage
 * project. Anywhere else nothing, and the inline 3 MB binds: promising more put a 5 MB send that
 * the browser could not upload on the queue for ever.
 */
export function sendSurfaceFor(selfhost: boolean, stagingOrigin: string | undefined): number | undefined {
  return selfhost || stagingUploadSource(stagingOrigin) !== null ? COMPOSE_ATTACH_STAGED_SURFACE_BYTES : undefined;
}
