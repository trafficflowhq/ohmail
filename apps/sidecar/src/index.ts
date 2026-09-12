/**
 * `@ohmail/sidecar` — the LOCAL engine of the desktop's dual-mode design: the mailbox itself is the
 * master copy, and exactly one active organizer works it at a time. A Node process the desktop shell
 * spawns and owns; it runs `createApp(apiRoutes)` over PGlite on disk, an `ImapAdapter` against the
 * user's own server, and the worker's sync loop, while the UI keeps `HttpAdapter` given a `fetch`
 * that marshals over stdin/stdout. There is NO TCP listener unless host mode is armed — three
 * explicit knobs deep, never a default — so the stdio pipe stays the whole transport. Host mode
 * (Phase 3) adds a SECOND door bound to `127.0.0.1:<port>` and published by `tailscale serve`; a
 * disarmed install constructs no listener object at all, pinned by connecting and being refused.
 */
export {
  createSidecar, refusingKeyProvider, DEFAULT_POLL_INTERVAL_MS,
  type CredentialState, type Sidecar, type SidecarConfig, type SidecarImapConfig,
} from "./engine.js";
// The host door's listener and the one reading of its knobs. `resolveHostConfig` degrades—never
// throws—because the stdio door must not die over host config; the loopback literal is pinned by
// census, runtime assertion and suite together.
export {
  HOST_BODY_MAX_BYTES, HOST_HEADERS_TIMEOUT_MS, HOST_LOOPBACK_ADDRESS, HOST_REQUEST_TIMEOUT_MS,
  HOST_SEND_MAX_TOTAL_BYTES, HOST_SHUTDOWN_GRACE_MS,
  maybeStartHostListener, resolveHostConfig, startHostListener,
  type HostDoor, type HostListener, type HostState, type ResolvedHostConfig,
} from "./host-listener.js";
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
  createSidecarLog, createSidecarLogger, diagnosticFor,
  describeMethod, describeRoute, type Diagnostic, type SidecarLogOptions,
} from "./log.js";
export { connectOverStdio, type BridgeFetch, type StdioClient, type StdioClientOptions } from "./client.js";
