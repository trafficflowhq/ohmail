import { realpathSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createSidecar, type Sidecar, type SidecarConfig } from "./engine.js";
import { createCloudSidecar, type CloudSidecar, type CloudSidecarConfig } from "./cloud-engine.js";
import { maybeStartHostListener, type HostListener } from "./host-listener.js";
import { encodeFrame, PROTOCOL_VERSION } from "./frame.js";
import { serveOverStdio, type StdioHost } from "./host.js";
import { createSidecarLog } from "./log.js";
import type { PhaseHeader } from "./protocol.js";

/**
 * THE RUNNABLE SIDECAR — the process the desktop shell spawns.
 *
 *   node --import tsx src/main.ts        (development)
 *   node dist/main.js                    (packaged)
 *
 * stdin and stdout are the transport. stderr is the only place anything may be said out loud.
 *
 * ── STDOUT PURITY IS A MECHANISM, NOT A CONVENTION ────────────────────────────────────────
 *
 * One stray `console.log` anywhere in the module graph — ours, a dependency's, a debug line
 * somebody forgot — injects bytes into the middle of a frame. Because the framing is
 * length-prefixed there is no resync point: the peer reads the next 8 bytes of a JSON header as a
 * preamble and the connection is finished, with a symptom ("the app stopped talking to the
 * engine") that points nowhere near the cause.
 *
 * So {@link claimStdout} takes the real `write` for the frame writer and then REPLACES
 * `process.stdout.write` with one that forwards to stderr. `console.log`, a library's progress
 * line, and anything else that goes through the stream lands in the log instead of in the wire.
 * It cannot cover a direct write to fd 1 — nothing in this stack does that (imapflow is
 * constructed with `logger: false`), and the redirect itself is pinned by tests that write through
 * `console.log` and assert the bytes land on stderr rather than in the frame stream.
 */

/**
 * Capture the real stdout for the frame stream, then point `process.stdout` at stderr.
 *
 * The sink is a genuine `Writable` that delegates to the captured `write` and, crucially,
 * PROPAGATES BACKPRESSURE: `_write`'s callback is withheld until the underlying stream drains, so
 * this stream's own buffer fills and `write()` starts returning false exactly when the real one
 * does. `FrameWriter` depends on that — a sink that always claimed to have accepted the bytes
 * would buffer a 32 MB response in userland instead of waiting for the UI to read it.
 *
 * Two shapes were tried first and are wrong, recorded so they are not tried again:
 *
 *  · **A prototype clone that only overrides `write`.** `on("drain")` then registers the listener
 *    on the CLONE while the real stream emits on itself, so the writer waits for a drain that can
 *    never arrive and the sidecar hangs on the first response bigger than a pipe buffer.
 *  · **`fs.createWriteStream("", { fd: 1 })`.** `destroy()` closes fd 1 even with
 *    `autoClose: false`, and `fs.write` is the wrong primitive for a non-blocking pipe. Delegating
 *    to `process.stdout` reuses Node's own handling of pipes, TTYs and files.
 */
export function claimStdout(): Writable {
  const real = process.stdout;
  const realWrite = real.write.bind(real);

  const sink = new Writable({
    // Small, so backpressure is felt promptly rather than after a megabyte of slack.
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _enc, cb) {
      const flushed = realWrite(chunk, (err) => {
        if (err) cb(err);
        else if (flushed) cb();
      });
      if (!flushed) real.once("drain", () => cb());
    },
  });
  real.on("error", (err) => sink.destroy(err));

  const toStderr = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : cb;
    process.stderr.write(
      chunk as string | Uint8Array,
      typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
    );
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof real.write;
  real.write = toStderr;

  return sink;
}

/**
 * NARRATE THE BOOT DOWN THE WIRE — `phase` frames, so the window can say what the wait is.
 *
 * The engine's constructor runs BEFORE `serveOverStdio` exists, and that is exactly the stretch
 * these frames describe: "opening the store", "replaying the log", the phases a launch can spend
 * a minute in. So they are written straight to the claimed stdout rather than through the host's
 * writer — and that is safe for one reason worth stating as the invariant it is:
 *
 * **A phase frame may be written only while this process is single-voiced** — after `claimStdout`
 * and before `serveOverStdio` attaches. `encodeFrame` produces the whole frame as one buffer and
 * a phase frame carries no body, so each write is a single atomic `write()` on the stream; once
 * the host's own `FrameWriter` starts interleaving multi-write response frames, a second writer
 * would corrupt the stream with no resync point. The emitter is handed only to the constructors,
 * which return before the host is built, so the window is closed by construction.
 *
 * Best-effort in both directions: a write failure here means the parent is gone, which the
 * transport discovers on its own terms, and a shell built before this frame existed skips it
 * unread (an unknown `t` has always been "skip and carry on").
 */
export function bootPhaseEmitter(stdout: Writable): (phase: string) => void {
  return (phase: string): void => {
    const header: PhaseHeader = { v: PROTOCOL_VERSION, t: "phase", phase };
    try {
      stdout.write(encodeFrame(header));
    } catch {
      /* the pipe is gone; the transport reports that, not the narration */
    }
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is required. The shell passes the mailbox it owns; the sidecar invents nothing.`);
  }
  return v;
}

/** `OHMAIL_KEK_V<n>`, n >= 1, no leading zeros. `OHMAIL_KEK` is the unversioned spelling of v1. */
const KEK_VAR_RE = /^OHMAIL_KEK_V([1-9][0-9]*)$/;
const KEK_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * THE KEY RING THE HOST HANDS OVER, read from the environment it spawned this process with.
 *
 * `OHMAIL_KEK` is one key and means version 1 — the spelling a shell that has never rotated
 * passes, and the only one it ever needs. `OHMAIL_KEK_V1 … OHMAIL_KEK_Vn` is the same thing said
 * so that a SECOND key can exist beside the first, which is what rotation is: install the new
 * version, keep the old one until no stored credential still references it, then drop it.
 *
 * Three rules, each of them a failure somebody would otherwise debug at length:
 *
 *  · **Versions are contiguous from 1.** A gap means the missing version is exactly the one some
 *    stored row needs, so accepting it converts a startup failure into an unopenable mailbox
 *    later.
 *  · **`OHMAIL_KEK` and `OHMAIL_KEK_V1` may not disagree.** Two spellings of one version with
 *    different bytes is a host that does not know its own key; guessing which one is meant is how
 *    a credential gets sealed under a key nobody has.
 *  · **Empty is absent.** A launcher that materializes every declared variable as `""` must not
 *    look like a broken key.
 *
 * A value is validated and converted; it is never echoed, in an error message or anywhere else.
 */
function keksFromEnv(env: NodeJS.ProcessEnv): Record<number, Buffer> {
  const hex = new Map<number, string>();
  const set = (version: number, value: string, name: string): void => {
    if (!KEK_HEX_RE.test(value)) {
      throw new Error(`${name} must be 64 hex characters (a 32-byte AES-256 key)`);
    }
    const seen = hex.get(version);
    if (seen !== undefined && seen.toLowerCase() !== value.toLowerCase()) {
      throw new Error(
        `OHMAIL_KEK and OHMAIL_KEK_V${version} are both set and differ. Pass one spelling of ` +
          "each key version; two different values for one version is a host that cannot know " +
          "which key its stored credentials were sealed under",
      );
    }
    hex.set(version, value);
  };

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.trim() === "") continue;    // "" counts as absent
    if (name === "OHMAIL_KEK") set(1, value.trim(), name);
    else {
      const m = KEK_VAR_RE.exec(name);
      if (m) set(Number(m[1]), value.trim(), name);
    }
  }
  if (hex.size === 0) return {};

  const versions = [...hex.keys()].sort((a, b) => a - b);
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new Error(
        `key versions must be contiguous from 1: OHMAIL_KEK_V${i + 1} is missing ` +
          `(found ${versions.map((v) => `V${v}`).join(", ")}). The missing version is the one ` +
          "some stored credential needs, so this is refused at startup rather than at the mailbox",
      );
    }
  }
  return Object.fromEntries(versions.map((v) => [v, Buffer.from(hex.get(v)!, "hex")]));
}

/** Build the configuration from the environment the shell sets. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const user = env.OHMAIL_IMAP_USER ?? required("OHMAIL_IMAP_USER");
  const keks = keksFromEnv(env);
  // NOT `required`, and this is the change that makes a restart survivable: after the launch on
  // which the user types it, the password lives encrypted in the local store and the environment
  // carries only the key. A launch with neither is not an error either — the engine serves the
  // mirror and the shell asks for a password.
  const pass = env.OHMAIL_IMAP_PASS;
  return {
    dataDir: env.OHMAIL_DATA_DIR ?? required("OHMAIL_DATA_DIR"),
    imap: {
      host: env.OHMAIL_IMAP_HOST ?? required("OHMAIL_IMAP_HOST"),
      port: Number(env.OHMAIL_IMAP_PORT ?? 993),
      secure: env.OHMAIL_IMAP_SECURE !== "0",
      auth: { user, ...(pass ? { pass } : {}) },
      // THE SEND SERVER — host, port and TLS from the shell, authenticated with the SAME login.
      //
      // One credential per mailbox: `user` and `pass` here are the IMAP login's, not a second SMTP
      // secret. There is deliberately no `OHMAIL_SMTP_USER`/`OHMAIL_SMTP_PASS`, because a mailbox has
      // one password and it is sealed once (see the KEK ring above and the stored-login block in
      // `engine.ts`). `pass` is only present on the launch the user types it; after that the sealed
      // credential is the source, and the send adapter reads it back from the store rather than from
      // the environment — the same precedence the IMAP side follows.
      //
      // `secure` is implicit TLS: `true` for 465 (Gmail, Fastmail), `false` for 587 STARTTLS
      // (iCloud). The shell spells the false case as "0" exactly, so an unset value means secure.
      ...(env.OHMAIL_SMTP_HOST
        ? {
            smtp: {
              host: env.OHMAIL_SMTP_HOST,
              port: Number(env.OHMAIL_SMTP_PORT ?? 587),
              secure: env.OHMAIL_SMTP_SECURE !== "0",
              ...(pass ? { auth: { user, pass } } : {}),
            },
          }
        : {}),
    },
    ...(env.OHMAIL_MAILBOX_ADDRESS ? { address: env.OHMAIL_MAILBOX_ADDRESS } : {}),
    ...(env.OHMAIL_POLL_MS ? { pollIntervalMs: Number(env.OHMAIL_POLL_MS) } : {}),
    ...(Object.keys(keks).length > 0 ? { keks } : {}),
    // ── HOST MODE (Phase 3) — three knobs, all of them the shell's, none of them required ────
    //
    // `OHMAIL_HOST_MODE` arms on the EXACT string "1" and nothing else: the same
    // absent-must-not-select-the-dangerous-branch rule as `SidecarConfig.hostMode`, spelled for
    // an environment where every value is a string. `OHMAIL_HOST_ORIGIN` is the served MagicDNS
    // origin and `OHMAIL_HOST_PORT` the loopback port `tailscale serve` targets. Deliberately NO
    // validation here beyond "present": a garbage value must degrade host mode with a surfaced
    // reason, never kill the stdio door, and `resolveHostConfig` (engine-side) is the one place
    // that rules on the values — `Number("garbage")` is NaN, which it refuses by name.
    ...(env.OHMAIL_HOST_MODE === "1" ? { hostMode: true } : {}),
    ...(env.OHMAIL_HOST_ORIGIN?.trim() ? { hostOrigin: env.OHMAIL_HOST_ORIGIN.trim() } : {}),
    ...(env.OHMAIL_HOST_PORT?.trim() ? { hostPort: Number(env.OHMAIL_HOST_PORT) } : {}),
  };
}

/**
 * THE CLOUD CONFIGURATION — and the refusal that makes the safe branch STRUCTURAL.
 *
 * Cloud mode mirrors a hosted account and never opens IMAP. That is not enforced by the ABSENCE of
 * IMAP settings — a launcher that materializes every declared variable, or a stale IMAP block left
 * in a script, must not be able to quietly hand this process a mailbox to organize. So the presence
 * of ANY non-empty `OHMAIL_IMAP_*` is a hard refusal: the safe branch is selected by construction,
 * and there is no configuration under which Cloud mode reaches the IMAP path. Together with the
 * import census over `cloud-engine.ts`, an install running this mode cannot become a second
 * organizer of a mailbox the hosted worker already holds.
 *
 * `OHMAIL_CLOUD_ACCESS_TOKEN` / `OHMAIL_CLOUD_REFRESH_TOKEN` are optional and exist for tests and
 * headless runs; a desktop install has neither. In steady state the pair lives sealed on disk and
 * the environment carries only `OHMAIL_KEK` (see `cloud-auth.ts`), and a launch with NEITHER a
 * sealed pair nor an environment token is not a refusal at all: the engine comes up serving the
 * sign-in surface, and `POST /cloud/signin` is how a person establishes the first session. That is
 * the whole reason this function requires a URL and an address and requires no credential — the two
 * it requires are settings the shell knows, and the one it does not require is the secret.
 */
export function cloudConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CloudSidecarConfig {
  const imapPresent = Object.entries(env)
    .filter(([name, value]) => name.startsWith("OHMAIL_IMAP_") && (value ?? "").trim() !== "")
    .map(([name]) => name);
  if (imapPresent.length > 0) {
    throw new Error(
      `OHMAIL_MODE=cloud refuses to start because ${imapPresent.sort().join(", ")} is set. Cloud ` +
        "mode mirrors a hosted account and never opens IMAP; the safe branch is chosen by " +
        "construction, not by the absence of a value, so an IMAP setting present here is a " +
        "misconfiguration rather than an instruction.",
    );
  }
  const access = env.OHMAIL_CLOUD_ACCESS_TOKEN;
  const refresh = env.OHMAIL_CLOUD_REFRESH_TOKEN;
  const keks = keksFromEnv(env);
  return {
    dataDir: env.OHMAIL_DATA_DIR ?? required("OHMAIL_DATA_DIR"),
    cloudUrl: env.OHMAIL_CLOUD_URL ?? required("OHMAIL_CLOUD_URL"),
    address: env.OHMAIL_MAILBOX_ADDRESS ?? required("OHMAIL_MAILBOX_ADDRESS"),
    ...(env.OHMAIL_MAILBOX_DISPLAY_NAME ? { displayName: env.OHMAIL_MAILBOX_DISPLAY_NAME } : {}),
    ...(access && refresh ? { tokens: { accessToken: access, refreshToken: refresh } } : {}),
    ...(env.OHMAIL_POLL_MS ? { pollIntervalMs: Number(env.OHMAIL_POLL_MS) } : {}),
    ...(Object.keys(keks).length > 0 ? { keks } : {}),
  };
}

export async function runSidecar(): Promise<void> {
  const stdout = claimStdout();
  // The hardened logger from `packages/core`, on stderr. This used to be a hand-rolled
  // `JSON.stringify` whose comment claimed the worker's shape; `log.ts` in this package records
  // what that cost. Every `log(...)` below goes through the allowlist, the value patterns and the
  // `err` reduction.
  const log = createSidecarLog();
  let sidecar: Sidecar | null = null;

  // EPIPE means the parent is gone. Nothing left to serve, and continuing would keep an IMAP
  // connection open on behalf of a UI that no longer exists.
  process.stdout.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") void shutdown("stdout_epipe", 0);
  });

  let host: StdioHost | null = null;
  let hostListener: HostListener | null = null;
  let shuttingDown: Promise<void> | null = null;
  /**
   * ORDER MATTERS, and getting it wrong corrupts the local mirror.
   *
   * Stop accepting requests → let the in-flight ones finish → only THEN close IMAP and the
   * database. `sidecar.stop()` closes PGlite; a handler still reading it at that moment gets a
   * dead connection at best, and at worst the mirror is closed mid-write. The stdin path already
   * waited (it goes through `host.finished()`); SIGTERM did not, which was the hole.
   *
   * The HOST-DOOR LISTENER goes first, for the same sentence one door over: a paired phone's
   * request is a reader of the same store, so the socket stops admitting and drains before
   * anything it could be mid-read of closes. Its `close()` never throws and is bounded by its
   * own grace, so it cannot hang the quit.
   */
  const shutdown = (reason: string, code: number): Promise<void> => {
    shuttingDown ??= (async () => {
      log("shutdown", { reason, inFlight: host?.inFlight ?? 0 });
      try {
        await hostListener?.close();
        if (host) {
          host.stop();
          await host.finished();
        }
        await sidecar?.stop();
      } catch (err) {
        log("shutdown_failed", { err });
        code = 1;
      }
      process.exit(code);
    })();
    return shuttingDown;
  };

  try {
    // The narration is only valid while nothing else writes frames — see `bootPhaseEmitter`.
    // The constructor returns before `serveOverStdio` below is built, which is that window.
    sidecar = await createSidecar({ ...configFromEnv(), log, onPhase: bootPhaseEmitter(stdout) });
  } catch (err) {
    log("start_failed", { err });
    process.exit(1);
  }

  host = serveOverStdio({
    handle: (req) => sidecar!.handle(req),
    input: process.stdin,
    output: stdout,
    log,
    onFatal: (err) => {
      log("transport_fatal", { err });
      void shutdown("transport_fatal", 1);
    },
  });

  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: sidecar.sessionToken,
    accountId: sidecar.world.accountId,
    userId: sidecar.world.userId,
    mailboxId: sidecar.world.mailboxId,
    // READ BEFORE `start()`, DELIBERATELY. `start()` is what would connect, and it is fired below
    // without being awaited; asking afterwards would race a first sync that takes minutes. What
    // the shell needs to know is what THIS launch was given, which is settled by the time the
    // sidecar was assembled.
    credentialState: await sidecar.credentialState(),
  });
  // `dataDir` used to be on this line and is deliberately gone. A data directory is a filesystem
  // path under the user's home, so it carries the OS account name and, on a portable install, the
  // volume — and the shell that set `OHMAIL_DATA_DIR` already knows it. `mailboxId` is what
  // correlates this line with everything after it.
  log("serving", { mailboxId: sidecar.world.mailboxId });

  // THE HOST DOOR's loopback listener — bound iff host mode is armed AND the shell configured
  // both the port and the served origin, and a refusal to bind degrades to the stdio door with a
  // named line rather than a failed launch. After the bridge is serving, deliberately: the window
  // is the primary consumer and must not wait on a bind; a phone reconnects on its own schedule.
  hostListener = await maybeStartHostListener(sidecar, log);

  // The mailbox comes up AFTER the bridge is serving. A first sync of a real mailbox takes
  // minutes, and a UI that cannot ask anything until it finishes is a UI that looks broken.
  //
  // LOGGING IS THE WHOLE HANDLER, AND THAT IS ONLY DEFENSIBLE BECAUSE `start()` CLEANS UP.
  // A rejection here used to leave an authenticated IMAP login open for the life of the process:
  // `connect()` logs in before any of the work that can fail, and this catch has no handle on the
  // adapter. `start()` now closes it on the way out (see the `catch` in `engine.ts`), so what is
  // left to decide here is genuinely a product question — and the answer is to keep serving the
  // mirror, because offline is a property of this mode rather than a failure of it.
  void sidecar.start().catch((err: unknown) => {
    log("mailbox_start_failed", {
      err,
      reason: "the mailbox did not come up; the IMAP login was released and the bridge keeps " +
        "serving the local mirror",
    });
  });

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

  // The parent closing our stdin is the ordinary way this process is asked to leave.
  await host.finished();
  await shutdown("stdin_closed", 0);
}

/**
 * THE RUNNABLE CLOUD SIDECAR — `OHMAIL_MODE=cloud`.
 *
 * Structurally the same process as {@link runSidecar}: `claimStdout`, the hardened logger on
 * stderr, the stdio bridge, and the same shutdown ordering. What differs is the engine — a
 * read-only mirror of a hosted account ({@link createCloudSidecar}) rather than the local
 * organizer — and it is the difference the whole mode exists for: this branch reaches no IMAP
 * adapter, no organizer lease and no sync loop, so an install here cannot become a second organizer
 * of a mailbox the hosted worker already holds.
 */
export async function runCloudSidecar(): Promise<void> {
  const stdout = claimStdout();
  const log = createSidecarLog();
  let cloud: CloudSidecar | null = null;

  process.stdout.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") void shutdown("stdout_epipe", 0);
  });

  let host: StdioHost | null = null;
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (reason: string, code: number): Promise<void> => {
    shuttingDown ??= (async () => {
      // TWO NUMBERS, BECAUSE ONE OF THEM WAS ANSWERING A DIFFERENT QUESTION. `inFlight` counts
      // stdio requests, and it is zero exactly when the mirror's own pull is what a quit is waiting
      // for — so a line carrying only that reported an idle process while a drain held the database
      // open past the grace period. `mirrorDraining` names the state that was actually blocking.
      log("shutdown", {
        reason,
        inFlight: host?.inFlight ?? 0,
        mirrorDraining: cloud?.mirrorDraining() ?? false,
      });
      try {
        if (host) {
          host.stop();
          await host.finished();
        }
        await cloud?.stop();
      } catch (err) {
        log("shutdown_failed", { err });
        code = 1;
      }
      process.exit(code);
    })();
    return shuttingDown;
  };

  try {
    // Same single-voiced window as the local door's — see `bootPhaseEmitter`.
    cloud = await createCloudSidecar({ ...cloudConfigFromEnv(), log, onPhase: bootPhaseEmitter(stdout) });
  } catch (err) {
    // A refused IMAP setting, a missing URL or address, or a locked data directory — all report the
    // same way the local engine's start failure does: a structured line and a non-zero exit, so the
    // shell sees a refusal rather than a process that served nothing in silence. A missing SESSION
    // is deliberately not on that list any more; it is a state this engine serves.
    log("cloud_start_failed", { err });
    process.exit(1);
  }

  host = serveOverStdio({
    handle: (req) => cloud!.handle(req),
    input: process.stdin,
    output: stdout,
    log,
    onFatal: (err) => {
      log("transport_fatal", { err });
      void shutdown("transport_fatal", 1);
    },
  });

  await host.ready({
    baseUrl: "http://sidecar",
    sessionToken: cloud.sessionToken,
    accountId: cloud.world.accountId,
    userId: cloud.world.userId,
    mailboxId: cloud.world.mailboxId,
    // There is no mailbox password on this transport — the credential is a hosted session — so the
    // field says whether this launch HAS one. `ready` with a sealed pair; `absent` on a pre-auth
    // launch, which is the same word the local engine uses for "ask for it", and the shell renders
    // a sign-in surface off exactly that.
    credentialState: cloud.signedIn() ? "ready" : "absent",
    // The launch snapshot of reachability; `/health.online` is the live value thereafter.
    online: cloud.online(),
  });
  log("cloud_serving", {
    mailboxId: cloud.world.mailboxId,
    state: cloud.signedIn() ? "signed_in" : "signed_out",
  });

  // The mirror comes up AFTER the bridge is serving: a first pull of a real account takes a while,
  // and a UI that can ask nothing until it finishes looks broken. A failed first pull is logged and
  // the poll keeps trying; the bridge serves the mirror throughout. A pre-auth launch has nothing
  // to pull and `start()` is a no-op — the sign-in starts its own first pull.
  void cloud.start().catch((err: unknown) => {
    log("cloud_pull_failed", {
      err,
      reason: "the mirror did not start pulling; the bridge keeps serving what it holds and the poll retries",
    });
  });

  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));

  await host.finished();
  await shutdown("stdin_closed", 0);
}

/**
 * IS THIS PROCESS RUNNING THE BUNDLE, rather than importing it?
 *
 * `@trafficflow/worker/entry`'s `isCliEntry` compares `import.meta.url` to `process.argv[1]` as
 * literal strings, which is right for the worker but WRONG for the desktop engine, and the failure
 * is silent. The shell spawns this bundle by a path, and when the kernel runs the file's shebang it
 * hands node an `argv[1]` with the `/private` prefix STRIPPED (a temp install under `/var`, an app
 * on a mounted image), while node resolves that same symlink INSIDE `import.meta.url`. The two then
 * differ by exactly `/private`, the check is false, `runSidecar` never runs, and the engine exits
 * having served nothing — which the shell reports as a start failure over and over. Resolving BOTH
 * sides to their real path is what lets the bundle recognise itself wherever the app was installed.
 *
 * On an IMPORT — a test loading this module — `argv[1]` is the test runner, so the two real paths
 * still differ and nothing auto-runs. Measured against a packaged `.app` spawned from a `/var` path,
 * where the literal comparison left the engine dead on arrival.
 */
function isRunAsProgram(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * THE BRANCH THAT SELECTS THE ENGINE. `OHMAIL_MODE=cloud` runs the read-only hosted mirror;
 * anything else runs the local organizer. The choice is made here, once, from one variable — and
 * `cloudConfigFromEnv` refuses to proceed in Cloud mode if any `OHMAIL_IMAP_*` is present, so the
 * two branches cannot be conflated by configuration.
 */
async function main(): Promise<void> {
  if ((process.env.OHMAIL_MODE ?? "").trim().toLowerCase() === "cloud") {
    await runCloudSidecar();
  } else {
    await runSidecar();
  }
}

if (isRunAsProgram()) {
  void main();
}
