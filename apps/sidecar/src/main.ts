import { realpathSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createSidecar, type Sidecar, type SidecarConfig } from "./engine.js";
import { armFirstPageGate } from "./first-page-gate.js";
import { createCloudSidecar, type CloudSidecar, type CloudSidecarConfig } from "./cloud-engine.js";
import {
  createAdmission, maybeHoldStoodDownPort, maybeStartHostListener, type HostListener,
} from "./host-listener.js";
import { maybeStartLanListener, type LanListener } from "./host-lan.js";
import { encodeFrame, PROTOCOL_VERSION } from "./frame.js";
import { serveOverStdio, type StdioHost } from "./host.js";
import { createSidecarLog, createSidecarLogger, diagnosticFor } from "./log.js";
import { resolveVitalsIntervalMs } from "./vitals.js";
import type { PhaseHeader } from "./protocol.js";

/**
 * The runnable sidecar — the process the desktop shell spawns (`node --import tsx src/main.ts` in
 * dev, `node dist/main.js` packaged). stdin/stdout are the transport; stderr is the only place
 * anything may be said out loud. STDOUT PURITY IS A MECHANISM, not a convention: one stray
 * `console.log` injects bytes into the middle of a length-prefixed frame with no resync point — the
 * peer reads the next header as a preamble and the connection is finished, its symptom pointing
 * nowhere near the cause. So {@link claimStdout} takes the real `write` for the frame writer and
 * REPLACES `process.stdout.write` with one forwarding to stderr; it cannot cover a direct write to
 * fd 1 (nothing here does — imapflow is `logger: false`), and the redirect is pinned by tests.
 */

/**
 * Capture the real stdout for the frame stream, then point `process.stdout` at stderr. The sink is a
 * genuine `Writable` that delegates to the captured `write` and PROPAGATES BACKPRESSURE: `_write`'s
 * callback is withheld until the underlying stream drains, so `write()` returns false exactly when
 * the real one does — `FrameWriter` depends on it, or a 32 MB response buffers in userland. Two
 * shapes were wrong and are recorded so they are not retried: a prototype clone overriding only
 * `write` (the `on("drain")` listener registers on the CLONE, so the writer waits for a drain that
 * never arrives and the sidecar hangs), and `fs.createWriteStream("", { fd: 1 })` (`destroy()`
 * closes fd 1 even with `autoClose: false`). Delegating to `process.stdout` reuses Node's pipe handling.
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
 * Narrate the boot down the wire — `phase` frames, so the window can say what the wait is. The
 * engine's constructor runs BEFORE `serveOverStdio` exists, exactly the stretch these describe, so
 * they are written straight to the claimed stdout. The invariant that makes that safe: a phase frame
 * may be written only while this process is SINGLE-VOICED — after `claimStdout` and before
 * `serveOverStdio` attaches. `encodeFrame` produces one buffer and a phase frame carries no body, so
 * each write is atomic; once the host's `FrameWriter` interleaves multi-write frames a second writer
 * would corrupt the stream. The emitter is handed only to the constructors, which return before the
 * host is built. Best-effort both ways — a write failure means the parent is gone, an old shell skips it.
 */
export function bootPhaseEmitter(
  stdout: Writable,
): (phase: string, progress?: { applied: number; pending: number }) => void {
  return (phase: string, progress?: { applied: number; pending: number }): void => {
    // The counts ride the frame only when the phase has them (`migrating`), so an ordinary
    // phase's bytes are what they were and a shell that skips them loses nothing.
    const header: PhaseHeader = progress
      ? { v: PROTOCOL_VERSION, t: "phase", phase, applied: progress.applied, pending: progress.pending }
      : { v: PROTOCOL_VERSION, t: "phase", phase };
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
 * The key ring the host hands over, from the environment it spawned this process with. `OHMAIL_KEK`
 * is one key, version 1 — the spelling a shell that never rotated passes; `OHMAIL_KEK_V1 …
 * OHMAIL_KEK_Vn` lets a SECOND key exist beside it, which is what rotation is. Three rules, each a
 * failure otherwise debugged at length: versions are CONTIGUOUS from 1 (a gap is the version some
 * stored row needs, so accepting it defers a startup failure into an unopenable mailbox); `OHMAIL_KEK`
 * and `OHMAIL_KEK_V1` may not DISAGREE (a host that does not know its own key); and EMPTY is absent
 * (a launcher materializing every variable as `""` must not look like a broken key). A value is
 * validated and converted, never echoed.
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
      // The send server — host, port and TLS from the shell, authenticated with the SAME login. One
      // credential per mailbox: `user`/`pass` are the IMAP login's, not a second SMTP secret, so
      // there is deliberately no `OHMAIL_SMTP_USER`/`_PASS`; the password is sealed once (the KEK
      // ring above, the stored-login block in `engine.ts`). `pass` is present only on the launch the
      // user types it — after that the send adapter reads the sealed credential from the store, the
      // same precedence the IMAP side follows. `secure` is implicit TLS: `true` for 465, `false` for
      // 587 STARTTLS, and the shell spells the false case "0" exactly, so unset means secure.
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
    // The heartbeat window, on `OHMAIL_POLL_MS`'s idiom: absent means the product default, and
    // the ENGINE rules on the value. Unlike the host knobs below, a garbage value here REFUSES
    // the boot (`resolveHeartbeatTimeoutMs`) — `Number("garbage")` is NaN, and a NaN window would
    // declare every mailbox unreachable on every poll, which is a misconfiguration wearing an
    // outage's clothes rather than a degraded feature.
    ...(env.OHMAIL_HEARTBEAT_MS ? { heartbeatTimeoutMs: Number(env.OHMAIL_HEARTBEAT_MS) } : {}),
    /* HOW OFTEN THE ENGINE WRITES ITS OWN MEMORY DOWN. Absent is the shipped five minutes, and
       a measurement run shorter than that reads no figure of the engine's own — which is why
       every recorded reading of this app so far came from an external sampler. The value is
       ruled on by `resolveVitalsIntervalMs`, which refuses a garbage or out-of-range one by
       name at boot: a knob that quietly fell back to the default would have a short run report
       the default's silence as the app's own reading. */
    ...(env.OHMAIL_ENGINE_VITALS_MS?.trim()
      ? {
          vitalsIntervalMs: resolveVitalsIntervalMs(
            "OHMAIL_ENGINE_VITALS_MS",
            env.OHMAIL_ENGINE_VITALS_MS,
          ),
        }
      : {}),
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
    // The packaged host-client build this door serves to a phone — the fourth knob, resolved by
    // the shell from its own bundle resources (`OHMAIL_DATA_DIR`'s idiom: a path the shell
    // knows, handed at spawn). Same no-validation rule as the three above: `host-static.ts`
    // probes it once and a missing build degrades to API-only with a logged reason.
    ...(env.OHMAIL_HOST_ASSETS?.trim() ? { hostAssetsDir: env.OHMAIL_HOST_ASSETS.trim() } : {}),
    // The LAN fallback's one knob — the operator-chosen interface address. Same
    // no-validation rule again: `resolveLanBind` (engine-side) is the one place that rules on
    // the value, and a refusal degrades the LAN half alone with `host_lan_config_invalid`.
    ...(env.OHMAIL_LAN_BIND?.trim() ? { lanBind: env.OHMAIL_LAN_BIND.trim() } : {}),
  };
}

/**
 * The stand-down knob, read APART from `configFromEnv` because it composes nothing: no route, no
 * handler and no state of the engine changes. `OHMAIL_HOST_STAND_DOWN=<port>` says host mode is
 * off and this port must stay held; `resolveStandDownPort` is the one place that rules on the
 * value, and it refuses the knob outright while host mode is armed.
 */
export function standDownFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { hostMode?: boolean; standDownPort?: number } {
  return {
    ...(env.OHMAIL_HOST_MODE === "1" ? { hostMode: true } : {}),
    ...(env.OHMAIL_HOST_STAND_DOWN?.trim()
      ? { standDownPort: Number(env.OHMAIL_HOST_STAND_DOWN) }
      : {}),
  };
}

/**
 * The Cloud configuration — and the refusal that makes the safe branch STRUCTURAL. Cloud mode
 * mirrors a hosted account and never opens IMAP, not enforced by the ABSENCE of IMAP settings: the
 * presence of ANY non-empty `OHMAIL_IMAP_*` is a hard refusal, so a launcher materializing every
 * variable, or a stale IMAP block, cannot quietly hand this process a mailbox to organize. With the
 * import census over `cloud-engine.ts`, an install in this mode cannot become a second organizer.
 * `OHMAIL_CLOUD_ACCESS_TOKEN`/`_REFRESH_TOKEN` are optional (tests, headless); in steady state the
 * pair lives sealed on disk and only `OHMAIL_KEK` is in the environment, and a launch with neither
 * is not a refusal — the engine serves the sign-in surface, so this requires a URL and address only.
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
  // Which door this is, and it is the PIN that says so. A paired door is configured with NO mailbox
  // address (a pairing link names a computer, and which mailboxes it reads is the host's answer),
  // while every other cloud door names a mailbox and an absent address there is a mirror belonging
  // to nobody — a hard refusal, since `enforceMirrorOwner` rests on that value. The discriminator is
  // `OHMAIL_HOST_PIN`, NOT the absence of the address: reading "no address" as "the paired door"
  // would turn a hosted launch that lost its address into a silently address-less mirror. The pin is
  // a POSITIVE fact the shell writes only for this door and refuses without the flavor (`config.rs`),
  // so a door carrying one is paired by construction, not by inference.
  const pairedDoor = (env.OHMAIL_HOST_PIN ?? "").trim() !== "";
  const address = env.OHMAIL_MAILBOX_ADDRESS?.trim();
  return {
    dataDir: env.OHMAIL_DATA_DIR ?? required("OHMAIL_DATA_DIR"),
    cloudUrl: env.OHMAIL_CLOUD_URL ?? required("OHMAIL_CLOUD_URL"),
    /* `null` AND NEVER `""`. An empty string is an address that was configured and is blank, which
       `sameOwner` matches against nothing — a mirror recorded that way is discarded on every
       launch, which is the failure this whole change exists to avoid. */
    address: pairedDoor ? address ?? null : address || required("OHMAIL_MAILBOX_ADDRESS"),
    ...(env.OHMAIL_MAILBOX_DISPLAY_NAME ? { displayName: env.OHMAIL_MAILBOX_DISPLAY_NAME } : {}),
    ...(access && refresh ? { tokens: { accessToken: access, refreshToken: refresh } } : {}),
    ...(env.OHMAIL_POLL_MS ? { pollIntervalMs: Number(env.OHMAIL_POLL_MS) } : {}),
    ...(Object.keys(keks).length > 0 ? { keks } : {}),
    // The paired desktop's fingerprint — the door that opens another machine's mailbox. Present only
    // when the shell wrote a desktop-host door, and what makes every connection this engine opens a
    // pinned one (`CloudSidecarConfig.hostPin`). ABSENT means unpinned, right for the hosted and
    // self-hosted doors and never a fallback for this one: a desktop-host door with no pin cannot
    // authenticate what answers, so the shell writes the two together and the door refuses a link
    // with no fingerprint. NO VALIDATION here beyond "present and not blank" — the value's shape is
    // `host-pin-probe.ts`'s to rule on, and a mismatch refuses the connection with an actionable
    // sentence, better than a launch dying here with a parse error.
    ...(env.OHMAIL_HOST_PIN?.trim() ? { hostPin: env.OHMAIL_HOST_PIN.trim() } : {}),
  };
}

export async function runSidecar(): Promise<void> {
  const stdout = claimStdout();
  // The hardened logger from `packages/core`, on stderr. This used to be a hand-rolled
  // `JSON.stringify` whose comment claimed the worker's shape; `log.ts` in this package records
  // what that cost. Every `log(...)` below goes through the allowlist, the value patterns and the
  // `err` reduction.
  //
  // ONE construction, TWO faces, and the second one is the fix: `log` is the two-argument seam
  // this package and `readMailboxLease` write through, `logger` is the same object in the shape
  // `@trafficflow/worker/sync` speaks. The engine used to be handed only the first, so it built
  // its `syncDeps` with no `log` at all and the reconcile passes' diagnostics — every line that
  // reports a write the mail server did not accept — were discarded on the standalone door.
  const logger = createSidecarLogger();
  const log = diagnosticFor(logger);
  let sidecar: Sidecar | null = null;

  // EPIPE means the parent is gone. Nothing left to serve, and continuing would keep an IMAP
  // connection open on behalf of a UI that no longer exists.
  process.stdout.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") void shutdown("stdout_epipe", 0);
  });

  let host: StdioHost | null = null;
  let hostListener: HostListener | null = null;
  let lanListener: LanListener | null = null;
  let shuttingDown: Promise<void> | null = null;
  /**
   * Order matters, and getting it wrong corrupts the local mirror. Stop accepting requests → let the
   * in-flight ones finish → only THEN close IMAP and the database. `sidecar.stop()` closes PGlite;
   * a handler still reading it gets a dead connection at best and a mid-write close at worst. The
   * stdin path already waited (through `host.finished()`); SIGTERM did not, which was the hole. The
   * HOST-DOOR LISTENER goes first for the same reason one door over — a paired phone's request reads
   * the same store — so the socket stops admitting and drains before anything it could be mid-read of
   * closes; its `close()` never throws, and the shell's process grace is the backstop for a hung handler.
   */
  const shutdown = (reason: string, code: number): Promise<void> => {
    shuttingDown ??= (async () => {
      log("shutdown", { reason, inFlight: host?.inFlight ?? 0 });
      try {
        // Both network doors stop admitting and drain before the store can close under them —
        // the LAN socket is a reader of the same store the loopback one is.
        await Promise.all([hostListener?.close(), lanListener?.close()]);
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
    sidecar = await createSidecar({ ...configFromEnv(), log, logger, onPhase: bootPhaseEmitter(stdout) });
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
  // AND THE FIRST DRAIN'S GRACE STARTS HERE, because this is the first moment a window could ask
  // for its bootstrap page — see `first-page-gate.ts` for what the drain is being held off.
  armFirstPageGate();

  // THE HOST DOOR's loopback listener — bound iff host mode is armed AND the shell configured
  // both the port and the served origin, and a refusal to bind degrades to the stdio door with a
  // named line rather than a failed launch. After the bridge is serving, deliberately: the window
  // is the primary consumer and must not wait on a bind; a phone reconnects on its own schedule.
  // ONE admission budget for however many network doors this launch opens — the concurrency
  // bound is the ENGINE PROCESS's heap bound, so a second socket must draw on the same sixteen
  // rather than doubling it. See `createAdmission` in host-listener.ts.
  const admission = createAdmission();
  hostListener = await maybeStartHostListener(sidecar, log, admission);
  // …and when host mode is OFF, the port it used to publish may still need HOLDING. A
  // `tailscale serve` registration outlives a withdrawal that refused, so a released port is a
  // published route to whatever binds it next; `OHMAIL_HOST_STAND_DOWN=<port>` is the shell
  // asking for the door to stay bound and say it has stopped. Never both: the knob is refused
  // by name while host mode is armed, so this can only ever run where the mount above declined.
  hostListener ??= await maybeHoldStoodDownPort(standDownFromEnv(), log);
  // The LAN fallback's second bind — mounted iff the operator chose an interface, on the
  // same port. API-only; `host-lan.ts` carries the audit. A refusal degrades with a
  // named line and every other door keeps serving.
  lanListener = await maybeStartLanListener(sidecar, log, admission);

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
 * Is this process running the bundle, rather than importing it? `@trafficflow/worker/entry`'s
 * `isCliEntry` compares `import.meta.url` to `process.argv[1]` as literal strings — right for the
 * worker, WRONG for the desktop engine, and the failure is silent: the shell spawns this bundle by
 * path, the kernel's shebang hands node an `argv[1]` with `/private` STRIPPED (a `/var` temp
 * install, a mounted image) while node resolves the symlink INSIDE `import.meta.url`, so the two
 * differ by exactly `/private`, `runSidecar` never runs, and the engine serves nothing — reported as
 * a start failure. Resolving BOTH sides to their real path is the fix; on an IMPORT the two still
 * differ (argv[1] is the runner) so nothing auto-runs. Measured against a packaged `.app` from `/var`.
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
