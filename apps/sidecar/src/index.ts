/**
 * `@ohmail/sidecar` — the LOCAL engine of the desktop's dual-mode design: the mailbox itself is
 * the master copy, and exactly one active organizer works it at a time.
 *
 * A Node process the desktop shell spawns and owns. It runs `createApp(apiRoutes)` from
 * `packages/api` over PGlite on disk, an `ImapAdapter` against the user's own server, and the
 * worker's sync/reconcile loop; the UI keeps `HttpAdapter` and is given a `fetch` that marshals
 * `Request`/`Response` over this process's stdin and stdout.
 *
 * **There is no TCP listener**, which is the whole security argument for stdio over a localhost
 * HTTP server: no port to authenticate, nothing else on the machine can reach it, and the only
 * party holding the pipe is the parent process.
 */
export {
  createSidecar, refusingKeyProvider, DEFAULT_POLL_INTERVAL_MS,
  type CredentialState, type Sidecar, type SidecarConfig, type SidecarImapConfig,
} from "./engine.js";
export { openLocalDb, DataDirLockedError, LOCK_FILE, PGDATA_SUBDIR, type LocalDb, type OpenLocalDb } from "./db.js";
export { ensureLocalWorld, mintLaunchSession, type LaunchSession, type LocalWorld } from "./identity.js";
// The exit from a stand-down. Exactly one active organizer per mailbox is the invariant, and this
// is the only way a mailbox this install stood down from ever comes back to it — the shell drives
// it when the user asks for this machine.
export {
  authorizeOrganizerTakeover, runOrganizeHere, TAKEOVER_MESSAGES,
  type AuthorizeTakeoverInput, type TakeoverAuthorizationOutcome, type TakeoverAuthorizationResult,
} from "./organize-here.js";
export {
  FrameDecoder, FrameError, FrameWriter, encodeFrame,
  MAX_BODY_BYTES, MAX_HEADER_BYTES, PREAMBLE_BYTES, PROTOCOL_VERSION,
  type Frame, type FrameLimits,
} from "./frame.js";
export {
  decodeRequest, decodeResponse, encodeRequest, encodeResponse, readBodyBounded,
  type AnyHeader, type ErrorHeader, type ReadyHeader, type ReadyInfo, type RequestHeader, type ResponseHeader,
} from "./protocol.js";
export { serveOverStdio, type StdioHost, type StdioHostOptions } from "./host.js";
// An embedder that assembles its own sidecar must be able to reach the redacting logger, or it
// will hand `createSidecar` a bare `console.log` and reopen, from outside this package, the
// unredacted-diagnostics hole the shared logger's allowlist closed.
export {
  createSidecarLog, describeMethod, describeRoute, type Diagnostic, type SidecarLogOptions,
} from "./log.js";
export { connectOverStdio, type BridgeFetch, type StdioClient, type StdioClientOptions } from "./client.js";
