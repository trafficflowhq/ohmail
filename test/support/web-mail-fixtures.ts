/** The real Web mail mount and its scripted transport for tests spanning multiple hosts. */
export {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, scriptSync, syncPage, teardownConfirmEnv, tick,
} from "../../apps/webapp/test/fixtures/cloud-confirm-shell";
export { message, ROSTER, storeWith } from "../../apps/webapp/test/_draft-shell";
export { typeInto } from "../../apps/webapp/test/fixtures/rich-editor-driver";
export { EngineProvider } from "../../apps/webapp/app/shell/engine";
export { enableDesktopAttachments } from "../../apps/webapp/app/shell/open-attachment.js";
