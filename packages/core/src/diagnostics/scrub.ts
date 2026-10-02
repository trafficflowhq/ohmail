/**
 * THE SECOND GATE OVER `engine.log`. The engine's logger already allowlists by key, but its list
 * admits `host`, `reason` (a sentence), the folder labels and a thrown string's text, and the file
 * also holds the shell's prose and a crashed run's stack trace. A diagnostic file carries none of
 * those, so every line is read again here: numbers and booleans under a reviewed key, strings only
 * from a closed key set and a grammar with no dot, space, `@` or slash, ids only as hashes.
 */

import { ALLOWED_FIELDS } from "../log.js";

/** Numeric fields written by lines that do not pass through `createLogger` (the shell, the phone app). */
export const DIAGNOSTIC_EXTRA_VALUE_FIELDS: readonly string[] = [
  "measured", "totalRssKb", "budgetKb", "uptimeMin", "backup_excluded",
  "shellPaintedMs", "listUsableMs", "engineReadyMs", "openP50Ms", "openP95Ms", "openCount",
  "openTimeouts", "switchP50Ms", "switchP95Ms", "switchCount", "switchTimeouts", "searchP50Ms",
  "searchP95Ms", "searchCount", "longFrames", "longTasks", "deriveMs", "deriveP50Ms", "deriveP95Ms",
  "deriveCount", "notifiesPer5min", "mirrorMessages",
];

/** The only keys whose STRING value may be copied, and only through {@link LABEL_RE}. */
export const DIAGNOSTIC_LABEL_FIELDS: readonly string[] = [
  "phase", "state", "verdict", "kind", "outcome", "op", "severity", "circuit", "decidedBy",
  "detectedBy", "refusal", "syncBlockedReason", "disabledReason", "memoryReading", "method",
  "signal", "surface", "platform", "frame", "storeFault",
];

/** Keys that hold ids. Written as keyed hashes under a fixed name, never as the id. */
const HASHED_ID_FIELDS: Readonly<Record<string, "mailbox" | "account">> = { mailboxId: "mailbox", accountId: "account" };

/**
 * Keys never copied whatever their value, ahead of every other rule: an id is never a number
 * here, and these either name a place, quote somebody or carry prose.
 */
const NEVER_FIELDS: ReadonlySet<string> = new Set([
  "host", "reason", "detail", "why", "fromFolder", "toFolder", "folderLabel", "route", "table",
  "constraint", "configVar", "sample", "model", "environment", "heldBy", "stoppedBy", "errorText",
  "requestId", "instanceId", "messageId", "threadId", "candidateThreadId", "draftId", "sendId", "ref",
]);

const VALUE_FIELDS: ReadonlySet<string> = new Set([...ALLOWED_FIELDS, ...DIAGNOSTIC_EXTRA_VALUE_FIELDS]);
const LABEL_FIELDS: ReadonlySet<string> = new Set(DIAGNOSTIC_LABEL_FIELDS);

const LABEL_RE = /^[A-Za-z][A-Za-z0-9_:]{0,47}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SERVICE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CLASS_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
/** An error code WITHOUT the logger's dot: `imap.example.com` is a well-formed code there. */
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const LEVELS = ["debug", "info", "warn", "error"] as const;

export type DiagnosticLevel = (typeof LEVELS)[number];

/** One `engine.log` line as the file may carry it. */
export type DiagnosticLogEntry =
  | {
      shape: "event";
      ts: string | null;
      level: DiagnosticLevel | null;
      service: string | null;
      event: string | null;
      errorClass: string | null;
      errorCode: string | null;
      causeClass: string | null;
      causeCode: string | null;
      mailbox: string | null;
      account: string | null;
      values: Record<string, number | boolean | null>;
      labels: Record<string, string>;
    }
  /** A line whose words stay on this machine: the shell's prose, a trace, anything unparsed. */
  | { shape: "withheld"; kind: "shell" | "trace" | "text" };

/** What a crashed run left: its class and its frames, never its message. */
export type DiagnosticCrashRecord =
  | { from: "trace"; errorClass: string; frames: string[] }
  | { from: "event"; event: string; errorClass: string | null; surface: string | null; frame: string | null };

/** Lines with these event names are crash records as well as log lines. */
export const DIAGNOSTIC_CRASH_EVENTS: readonly string[] = ["render_error_caught"];

const pick = (re: RegExp, v: unknown): string | null => (typeof v === "string" && re.test(v) ? v : null);

/** Whether `key` may carry a number or a boolean into the file. */
export function valueFieldAdmitted(key: string): boolean {
  return VALUE_FIELDS.has(key) && !NEVER_FIELDS.has(key) && HASHED_ID_FIELDS[key] === undefined;
}

/** Whether `key` may carry the string `value` into the file. */
export function labelAdmitted(key: string, value: unknown): value is string {
  return LABEL_FIELDS.has(key) && typeof value === "string" && LABEL_RE.test(value);
}

const TRACE_HEAD_RE = /^(?:Uncaught\s+)?([A-Z][A-Za-z0-9_$]{0,63}(?:Error|Exception)|Error)(?::\s|:?$)/;
const TRACE_FRAME_RE = /^\s+at\s+\S/;

/** Classify one raw line. `hash` turns an id into the file's keyed hash. */
export function scrubLogLine(raw: string, hash: (domain: "mailbox" | "account", id: string) => string): DiagnosticLogEntry {
  const line = raw.trim();
  if (line.startsWith("ohmail engine:")) return { shape: "withheld", kind: "shell" };
  if (TRACE_HEAD_RE.test(line) || TRACE_FRAME_RE.test(raw)) return { shape: "withheld", kind: "trace" };
  if (!line.startsWith("{")) return { shape: "withheld", kind: "text" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { shape: "withheld", kind: "text" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { shape: "withheld", kind: "text" };
  const o = parsed as Record<string, unknown>;
  const values: Record<string, number | boolean | null> = {};
  const labels: Record<string, string> = {};
  const ids: { mailbox: string | null; account: string | null } = { mailbox: null, account: null };
  for (const [key, v] of Object.entries(o)) {
    if (NEVER_FIELDS.has(key)) continue;
    const idDomain = HASHED_ID_FIELDS[key];
    if (idDomain !== undefined) {
      const id = pick(ID_RE, v);
      if (id !== null) ids[idDomain] = hash(idDomain, id);
      continue;
    }
    if (LABEL_FIELDS.has(key) && typeof v === "string") {
      if (labelAdmitted(key, v)) labels[key] = v;
      continue;
    }
    if (!valueFieldAdmitted(key)) continue;
    if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || v === null) values[key] = v;
  }
  const level = typeof o.level === "string" && (LEVELS as readonly string[]).includes(o.level) ? (o.level as DiagnosticLevel) : null;
  return {
    shape: "event",
    ts: pick(TS_RE, o.ts),
    level,
    service: pick(SERVICE_RE, o.service),
    event: pick(EVENT_RE, o.event),
    errorClass: pick(CLASS_RE, o.errorClass),
    errorCode: pick(CODE_RE, o.errorCode),
    causeClass: pick(CLASS_RE, o.causeClass),
    causeCode: pick(CODE_RE, o.causeCode),
    mailbox: ids.mailbox,
    account: ids.account,
    values,
    labels,
  };
}

/**
 * A home directory, with the account name in it, as each platform spells one. Replaced by `~`.
 * The Windows forms take either slash; `/var/home` is an image-based Linux's.
 */
const HOME_PREFIXES: readonly RegExp[] = [
  /(?:\/var)?\/home\/[^/\\\s)'"]+/g,
  /\/Users\/[^/\\\s)'"]+/g,
  /\/root(?=[/\s)'"]|$)/g,
  /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s)'"]+/gi,
];
/** `\\server\share` — a host name at the head of a Windows network path. */
const UNC_HOST_RE = /\\\\[^\\\s)'"]+\\/g;
/** An address, joined or split around its `@` ("local @domain"), as one token to mask. */
const ADDRESS_RE = /[^\s<>()[\]:;,"'/\\]+\s*@\s*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const MAX_FRAME = 240;

/** A stack frame with the home directory, a network host and any address taken out. */
export function stripFrame(frame: string): string {
  let out = frame.trim();
  for (const re of HOME_PREFIXES) out = out.replace(re, "~");
  out = out.replace(UNC_HOST_RE, "\\\\[host]\\").replace(ADDRESS_RE, "[address]");
  return out.length > MAX_FRAME ? `${out.slice(0, MAX_FRAME)}…` : out;
}

export const DIAGNOSTIC_CRASH_MAX = 10;
export const DIAGNOSTIC_CRASH_FRAMES_MAX = 12;

/** Every crash record in `lines`, newest last, at most {@link DIAGNOSTIC_CRASH_MAX}. */
export function crashRecords(lines: readonly string[], events: readonly DiagnosticLogEntry[]): DiagnosticCrashRecord[] {
  const out: DiagnosticCrashRecord[] = [];
  let open: { errorClass: string; frames: string[] } | null = null;
  lines.forEach((raw, i) => {
    const head = TRACE_HEAD_RE.exec(raw.trim());
    if (head !== null && !TRACE_FRAME_RE.test(raw)) {
      open = { errorClass: head[1]!, frames: [] };
      out.push({ from: "trace", errorClass: open.errorClass, frames: open.frames });
      return;
    }
    if (open !== null && TRACE_FRAME_RE.test(raw)) {
      if (open.frames.length < DIAGNOSTIC_CRASH_FRAMES_MAX) open.frames.push(stripFrame(raw));
      return;
    }
    open = null;
    const e = events[i];
    if (e?.shape === "event" && e.event !== null && DIAGNOSTIC_CRASH_EVENTS.includes(e.event)) {
      out.push({
        from: "event",
        event: e.event,
        errorClass: e.errorClass,
        surface: e.labels.surface ?? null,
        frame: e.labels.frame ?? null,
      });
    }
  });
  return out.slice(-DIAGNOSTIC_CRASH_MAX);
}
