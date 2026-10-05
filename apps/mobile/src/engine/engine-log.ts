/**
 * Where the engine's diagnostic lines go on a phone — ONE SINK, and it is this one. The engine
 * writes one JSON object per event; a phone has no stderr and no file this app may hand out, so
 * the line goes to the platform's own log through `modules/engine-log-sink` (iOS `os_log` under
 * the subsystem `app.ohmail.engine`, Android `android.util.Log` under the tag `ohmail.engine`),
 * and to `console` as well in a dev build so metro keeps its lines. A sink, deliberately not a
 * logger: the field allowlist, the redaction, the bounds and `err` becoming class + code all
 * live in the engine's own `createLogger` and have run before a line arrives here — an app
 * assembling `detail` objects would be a second logger outside every control.
 */

/**
 * WHY THE NATIVE HALF EXISTS. `console.log` alone left a shipped iPhone silent: React Native pins
 * its iOS threshold to `RCTLogLevelError` whenever `RCT_DEBUG` is off, so a Release build drops
 * every engine line and the unified log carried none of them (measured four ways, 2026-09-22).
 * `os_log` is not RN's console and does not travel through it. The module is INSTALLED rather
 * than imported — importing `expo` pulls a runtime vitest has no `__DEV__` for — so
 * `engine-log-native.ts` asks for it and hands it here; nothing installed falls back to `console`
 * rather than throwing, which is why the writer is a nullable slot and not an import.
 */

import type { BackupExclusion } from "./backup-exclusion";

/** What the engine is handed: one finished line, already redacted by its own logger. */
export type EngineLogSink = (line: string) => void;

/**
 * The four levels the engine's logger renders, least → most severe. A local literal rather than
 * an import: this file is the SINK, and the only thing it may know about a line is what is
 * already written in it.
 */
export const ENGINE_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type EngineLogLevel = (typeof ENGINE_LOG_LEVELS)[number];

/** The native half's surface — one function, the same on both platforms, composing nothing. */
export interface EngineLogWriter {
  /** Write one finished line to the platform's log at the given level. */
  write(level: EngineLogLevel, line: string): void;
}

/**
 * THE LEVEL, READ OFF THE RENDERED LINE AND NOWHERE ELSE — anchored, so no content can move it.
 * The native call needs a level and the rendered line is the only place one exists. Anchored at
 * the start, so a `"level":"error"` inside a field's value decides nothing; anything that is not
 * one of the four — the app's own closed-set lines, which carry no `ts` — falls to `info`, the
 * level a reader sees without passing a flag.
 */
const LEVEL_RE = /^\{"ts":"[^"]{0,40}","level":"(debug|info|warn|error)"/;

export function engineLogLevel(line: string): EngineLogLevel {
  const m = LEVEL_RE.exec(line);
  return m === null ? "info" : (m[1] as EngineLogLevel);
}

/** The installed native writer, or null where there is none: one app, one platform log. */
let writer: EngineLogWriter | null = null;

/**
 * THE NEWEST LINES, KEPT FOR THE DIAGNOSTIC FILE. A phone has no `engine.log` to read back, so
 * the sink keeps the last lines it was handed — already redacted by the engine's logger — and
 * Settings → About builds the file from them. Bounded; nothing here is written anywhere else.
 */
export const ENGINE_LOG_RING_LINES = 400;
const ring: string[] = [];

/** What the sink was handed most recently, oldest first. A copy. */
export function recentEngineLines(): readonly string[] {
  return [...ring];
}

function remember(line: string): void {
  ring.push(line);
  if (ring.length > ENGINE_LOG_RING_LINES) ring.splice(0, ring.length - ENGINE_LOG_RING_LINES);
}

/**
 * Hand the sink its native half. Called once, at module scope in the app's root layout beside the
 * engine registration — before the first render and before anything opens a mirror, because a
 * line written ahead of it goes to `console` and a Release build drops it.
 */
export function installEngineLogWriter(next: EngineLogWriter | null): void {
  writer = next;
}

/** What is installed. For the guard that asks whether the app wired its native half. */
export function installedEngineLogWriter(): EngineLogWriter | null {
  return writer;
}

/**
 * `__DEV__` is React Native's global: ABSENT under vitest, where a bare read throws, and unknown to
 * the webapp's compiler, which has this file in its program and none of RN's ambient types. So the
 * name is declared here and read through `typeof`, which is the one read that survives both.
 */
declare const __DEV__: boolean | undefined;

function devBuild(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__ === true;
}

/**
 * THE SINK. One line in, one write out: to the platform's log where a native half is installed, to
 * `console` where none is, and to both in a dev build so metro's terminal keeps what the unified
 * log is also getting. `console` is read at call time — a module-scope read binds whatever
 * `console` was at import — and `console.log` rather than `.debug` for the Android half's reason:
 * a release build strips `Log.d`/`.v`. A native write that THROWS falls back to `console` for that
 * line rather than losing it, and neither carrier may take the caller down with it.
 */
export function engineLogSink(): EngineLogSink {
  return (line) => {
    remember(line);
    let wrote = false;
    const native = writer;
    if (native !== null) {
      try {
        native.write(engineLogLevel(line), line);
        wrote = true;
      } catch {
        /* The platform log refused this line; `console` below is the fallback, not a second sink. */
      }
    }
    if (!wrote || devBuild()) {
      try {
        console.log(line);
      } catch {
        /* A log line is never worth a mailbox. See the banner. */
      }
    }
  };
}

/**
 * WHY AN ATTACHMENT PRESS ANSWERED NOTHING — the closed set, and the whole of what its line says.
 */
export type AttachmentRefusal =
  /** No such part on this message — the list never carried it. */
  | "bytes_unavailable"
  /** The engine asked for the bytes and the read refused. */
  | "bytes_failed"
  /** The bytes are in hand and this device could not read them. */
  | "bytes_unreadable"
  /** Embedded pictures were asked for and none were minted. */
  | "inline_images_none";

/**
 * ONE LINE FOR A PRESS THAT ANSWERED NOTHING. A refused attachment wrote nowhere at all: a person
 * read "Couldn't open this file." and a device run read an empty log, which is how a phone byte
 * path stayed broken through a fix proven on the other door. This is not the second logger the
 * banner refuses — the line has NO variable field, only a member of the union above, so there is
 * nothing about a message, a sender or a file in it to redact.
 */
export function logAttachmentRefusal(reason: AttachmentRefusal): void {
  engineLogSink()(JSON.stringify({ service: "app", event: "attachment_refused", reason }));
}

/**
 * ONE LINE PER LAUNCH THAT FINISHED WHAT THE LAST SESSION LEFT IN ITS ROUTING WINDOW — how many
 * presses it made, how many the server refused, how many had aged out, and how many sentences it
 * said. Counts only, so there is nothing to redact; a device run reads the launch's sentence here.
 */
export function logLaunchReplay(made: number, refused: number, expired: number, said: number): void {
  engineLogSink()(JSON.stringify({ service: "app", event: "launch_replay", made, refused, expired, said }));
}

/**
 * ONE LINE WHEN A NOTICE IS ON SCREEN — its deck key and whether it offers Undo, never its words or
 * what they interpolate. A notice stands 3.2 s, and a device run reading the screen by dumps of two
 * seconds and more read one as absent while the app had raised it; this line is what such a run
 * reads instead. A sentence built from raw text is logged as `text`, with nothing of the text in it.
 */
export function logNotice(key: string, undo: boolean): void {
  engineLogSink()(JSON.stringify({ service: "app", event: "notice_shown", say: key, undo }));
}

/**
 * ONE LINE PER READING OF THE PHONE'S NETWORK, as the platform gave it to the door
 * (`net/network-door.ts`) — what a device run reads to tell a reader that never spoke from a
 * surface that ignored it. Three closed words, nothing to redact.
 */
export function logNetwork(state: "online" | "offline" | "unknown"): void {
  engineLogSink()(JSON.stringify({ service: "app", event: "network", state }));
}

/**
 * ONE LINE PER MIRROR OPEN, SAYING WHETHER THE COPIED MAIL IS OUTSIDE THIS DEVICE'S BACKUP.
 *
 * Both fields, because one of them cannot answer alone: `backup_excluded` is the measurement and
 * `state` tells a false reading apart from no reading at all. Not the second logger the banner
 * refuses — every value is a member of a closed set, so there is nothing here to redact.
 */
export function logBackupExclusion(state: BackupExclusion, platform: string): void {
  engineLogSink()(JSON.stringify({
    service: "app",
    event: "backup_exclusion",
    backup_excluded: state === "excluded",
    state,
    platform,
  }));
}

/**
 * ONE LINE PER POSTURE THE PROVIDER DERIVES: the window's size in dp, how many fold features the
 * platform reported and the fold state the app took from them. A device run reads the app's own
 * claim here beside `dumpsys device_state`, never infers it from the layout. Numbers and a closed word.
 */
export function logPostureDerived(p: { width: number; height: number; folds: number; state: string }): void {
  engineLogSink()(JSON.stringify({
    service: "app", event: "posture_derived",
    width: Math.round(p.width), height: Math.round(p.height), folds: p.folds, state: p.state,
  }));
}

/**
 * THE WORLD'S COST, ONCE A MINUTE — how many list derivations the phone ran, the worst one and the
 * p95 of the last hundred, and how many engine notifications there were. Numbers only, nothing to
 * redact; a device run reads its own cost here instead of inferring it.
 */
export function logUiVitals(v: { derives: number; deriveMsMax: number; deriveMsP95: number | null; notifies: number }): void {
  engineLogSink()(JSON.stringify({
    service: "app", event: "ui_vitals",
    derives: v.derives, deriveMsMax: v.deriveMsMax, deriveMsP95: v.deriveMsP95, notifies: v.notifies,
  }));
}

/** The `ui_vitals` cadence: once a minute, from the moment a session's world exists. Answers its stop. */
export function startUiVitals(take: () => { derives: number; deriveMsMax: number; deriveMsP95: number | null; notifies: number }): () => void {
  const every = setInterval(() => logUiVitals(take()), 60_000);
  return () => clearInterval(every);
}
